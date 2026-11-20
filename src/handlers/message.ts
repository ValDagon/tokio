// Message edge handler — the single entry point of the isolate.
//
// The platform hands us the Telegram `message` payload plus the update context:
//   `handlers/message` → the `Message` (i.e. `update.message`)
//   `handlers/callback_query` → the `CallbackQuery`
// Both are routed here so the real work lives in `router.ts`: access gate,
// onboarding, slash/bare-word commands, inbox seams (Т15) and callbacks.
//
// Platform notes: the isolate has no setTimeout and no Node APIs, so a handler must
// do only awaited work (SDK calls) and must not keep anything between invocations.

import { api } from 'sdk';
import { createNote } from '../lib/dal/notes.js';
import { runDueJobs } from '../lib/dal/due_jobs.js';
import { kvSetIfAbsent } from '../lib/dal/misc.js';
import { recordFailure, reviewSkillDrafts, type FailureMediaKind } from '../lib/evolution.js';
import { ensureJobHandlers, runReminderClock } from '../lib/jobs.js';
import { nowIso } from '../lib/utils.js';
import { safeAnswer } from './formatting.js';
import { getMainKeyboard, webAppUrl } from './keyboards.js';
import { smartIngest } from './ingest.js';
import {
  flushReplyNotices,
  getIngestHandler,
  routeCallback,
  routeMessage,
  setTextIngestHandler,
} from './router.js';
import { beginReplyTurn, noteReply } from '../lib/reply_turn.js';

/**
 * Динамический адрес Mini App (из env или overlay).
 */
export function resolveWebAppUrl(): string {
  return webAppUrl() ?? '';
}

export interface Chat {
  id: number;
  type?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface Message {
  message_id?: number;
  chat: Chat;
  from?: TelegramUser;
  date?: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  voice?: { file_id: string; duration: number };
  /** Файл, присланный документом: PDF, архив или картинка без сжатия Telegram. */
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  /** Любое из полей `forward_*` означает «сообщение переслано». */
  forward_origin?: unknown;
  forward_date?: number;
  forward_from?: TelegramUser;
  forward_from_chat?: unknown;
  /** Выделенная цитата при ответе на фрагмент сообщения (Telegram Bot API 7.0+). */
  quote?: { text?: string };
  /** Сообщение, на которое отвечает пользователь (reply). */
  reply_to_message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    from?: TelegramUser;
  };
  /** Inline-клавиатура сообщения: нужна, чтобы убрать из неё уже решённые строки. */
  reply_markup?: {
    inline_keyboard?: Array<
      Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>
    >;
  };
}

/** Нажатие inline-кнопки: платформа отдаёт его в `handlers/callback_query`. */
export interface CallbackQuery {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: Message;
  chat_instance?: string;
}

/** Update context provided by the platform (`initData` is present in the Mini App). */
export interface HandlerContext {
  update?: unknown;
  initData?: string | null;
}

function callbackOf(ctx: HandlerContext | undefined): CallbackQuery | null {
  const update = ctx?.update;
  if (typeof update !== 'object' || update === null) return null;
  const candidate = (update as { callback_query?: unknown }).callback_query;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const id = (candidate as { id?: unknown }).id;
  return typeof id === 'string' ? (candidate as CallbackQuery) : null;
}

/**
 * Ленивый крон напоминаний: в изоляте нет таймера, поэтому доставляем на
 * каждом касании бота. Ошибка одного вида напоминаний не должна гасить другой
 * и не должна влиять на обработку апдейта.
 * Утренняя сводка идёт тем же циклом: она тоже «что созрело», а не таймер.
 */
async function deliverRemindersQuietly(userId: number | undefined): Promise<void> {
  if (typeof userId !== 'number' || !Number.isFinite(userId)) return;
  const outcome = await runReminderClock(userId, { source: 'touch' });
  if (outcome.delivered > 0) noteReply(outcome.delivered);
}

/**
 * Обзор скиллов — после основного ответа касания (MU-6): пользователь уже
 * получил своё, и обзор не может ни задержать, ни испортить ответ. Не более
 * одного кандидата и одного вызова модели за касание. Ничего не бросает.
 */
async function reviewSkillsQuietly(userId: number | undefined): Promise<void> {
  if (typeof userId !== 'number' || !Number.isFinite(userId)) return;
  try {
    await reviewSkillDrafts(userId);
  } catch (err) {
    // reviewSkillDrafts сам пишет свой сбой в журнал; здесь — последний барьер
    await recordFailure(userId, {
      stage: 'evolution',
      reason: 'other',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Точка входа апдейта: callback-нажатие или текстовое сообщение.
 *
 * Callback приходит либо отдельным payload'ом (`handlers/callback_query`), либо
 * внутри `ctx.update` — оба пути ведут в `routeCallback`.
 *
 * Последний защитный `catch`: необработанное исключение больше не превращается
 * в невидимый платформенный 500. Входящее сохраняется best-effort один раз,
 * пользователь получает честный ответ без обещания, что всё обработано, а
 * причина уходит в журнал. `finally` закрывает ход даже тогда, когда упал сам
 * обработчик отказа.
 */
export default async function handleUpdate(
  message: Message | CallbackQuery | null | undefined,
  ctx: HandlerContext = {},
): Promise<void> {
  // Ход открывается на весь апдейт: заглушки сбоя модели внутри него
  // откладываются до конца (lib/reply_turn.ts).
  beginReplyTurn();
  try {
    await handleUpdateBody(message, ctx);
  } catch (error) {
    await recoverUnhandledUpdate(message, ctx, error);
  } finally {
    // Единственное место, где уходит отложенная заглушка: только если за ход
    // не было ни одного другого ответа. Сбой самой заглушки не имеет права
    // вернуть апдейт в платформенный 500.
    try {
      await flushReplyNotices();
    } catch {
      // доставка отложенного уведомления — вспомогательный шаг
    }
  }
}

/** Тело хода. Отделено, чтобы `finally` закрывал ход на любом пути. */
async function handleUpdateBody(
  message: Message | CallbackQuery | null | undefined,
  ctx: HandlerContext,
): Promise<void> {
  // Подключаем Smart Ingest, если не был переопределён в тестовых швах
  if (!getIngestHandler()) {
    setTextIngestHandler(smartIngest);
  }

  const callback = callbackOf(ctx);

  // Ленивый запуск созревших задач (non-blocking / caught errors)
  const updateUserId = callback?.from?.id ?? message?.from?.id;
  try {
    ensureJobHandlers();
    await runDueJobs();
  } catch (err) {
    console.warn('due_jobs trigger error in handleUpdate:', err);
    if (typeof updateUserId === 'number' && Number.isFinite(updateUserId)) {
      await recordFailure(updateUserId, {
        stage: 'delivery',
        reason: 'unhandled',
        detail: `due_jobs: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (callback) {
    await routeCallback(callback);
    await deliverRemindersQuietly(callback.from?.id);
    await reviewSkillsQuietly(callback.from?.id);
    return;
  }

  if (!message) return;

  if (typeof (message as CallbackQuery).id === 'string' && (message as Message).chat === undefined) {
    const bare = message as CallbackQuery;
    await routeCallback(bare);
    await deliverRemindersQuietly(bare.from?.id);
    await reviewSkillsQuietly(bare.from?.id);
    return;
  }

  await routeMessage(message as Message);
  await deliverRemindersQuietly((message as Message).from?.id);
  await reviewSkillsQuietly((message as Message).from?.id);
}

// ---------------------------------------------------------------------------
// Последний защитный catch (MU-4)
// ---------------------------------------------------------------------------

/** Что видит владелец: честный ответ без обещания, что всё обработано. */
export const UNHANDLED_UPDATE_TEXT =
  '⚠️ Сообщение не удалось обработать целиком. Входящее сохранено — пришли его ещё раз, если ответа по сути нет.';

/** Метаданные аварийной заметки: по ним видно, что это не обычный инбокс. */
export const UNHANDLED_UPDATE_KIND = 'unhandled_update';

/** Ключ идемпотентности: один `message_id` сохраняется ровно один раз. */
const UNHANDLED_SAVE_PREFIX = 'unhandled_save:v1';

interface UnhandledIncoming {
  userId: number | null;
  chatId: number | null;
  media: FailureMediaKind;
  text: string | null;
  fileId: string | null;
  messageId: number | null;
  callbackId: string | null;
}

/** Что было во входящем — до того, как обработчик успел это потерять. */
function unhandledIncoming(
  message: Message | CallbackQuery | null | undefined,
  ctx: HandlerContext,
): UnhandledIncoming {
  // Callback приходит двумя путями: отдельным payload'ом (так его зовёт
  // `handlers/callback_query`) и внутри `ctx.update`. Обработчик отказа обязан
  // понимать оба, иначе у callback не будет chat_id для честного ответа.
  const bareCallback =
    message && typeof (message as CallbackQuery).id === 'string' && (message as Message).chat === undefined
      ? (message as CallbackQuery)
      : null;
  const callback = callbackOf(ctx) ?? bareCallback;
  const source = callback?.message ?? (message as Message | undefined) ?? null;
  const fromId = callback?.from?.id ?? message?.from?.id;
  const chatId = source?.chat?.id;
  // `Array.prototype.at` в изоляте может отсутствовать, а этот путь обязан
  // никогда не бросать: индекс считаем вручную.
  const photos = source?.photo;
  const lastPhotoFileId =
    photos && photos.length > 0 ? (photos[photos.length - 1]?.file_id ?? null) : null;
  const documentFileId = source?.document?.file_id ?? null;
  const fileId = source?.voice?.file_id ?? lastPhotoFileId ?? documentFileId;
  const media: FailureMediaKind = source?.voice
    ? 'voice'
    : source?.photo
      ? 'photo'
      : source?.document
        ? 'document'
        : 'text';
  return {
    userId: typeof fromId === 'number' && Number.isFinite(fromId) ? fromId : null,
    chatId: typeof chatId === 'number' && Number.isFinite(chatId) ? chatId : null,
    media,
    text: source?.text ?? source?.caption ?? null,
    fileId,
    messageId: source?.message_id ?? null,
    callbackId: callback?.id ?? null,
  };
}

/**
 * Аварийное сохранение входящего: ровно один раз на `message_id`.
 *
 * Идемпотентность по ключу в `kv`: апдейт мог быть обработан частично, и второе
 * сохранение создало бы дубль заметки. Ничего не бросает — это best-effort шаг
 * поверх уже случившегося сбоя.
 */
async function emergencySaveIncoming(incoming: UnhandledIncoming, reason: string): Promise<void> {
  const { userId, messageId } = incoming;
  if (userId === null) return;
  if (!incoming.text && !incoming.fileId) return;

  try {
    if (messageId !== null) {
      const claimed = await kvSetIfAbsent(
        `${UNHANDLED_SAVE_PREFIX}:${userId}:${messageId}`,
        nowIso(),
      );
      if (!claimed) return;
    }

    const text =
      incoming.text?.trim() ||
      (incoming.media === 'voice'
        ? '🎙 Голосовое сообщение не обработано — сохранено как есть.'
        : '📎 Вложение не обработано — сохранено как есть.');
    const sourceType =
      incoming.media === 'voice' || incoming.media === 'photo' || incoming.media === 'document'
        ? incoming.media
        : 'text';

    await createNote(userId, text, {
      column: 'raw',
      sourceType,
      fileId: incoming.fileId,
      sourceMessageId: messageId,
      metadata: {
        kind: UNHANDLED_UPDATE_KIND,
        media: incoming.media,
        reason: reason.slice(0, 200),
        file_id: incoming.fileId,
        source_message_id: messageId,
        at: nowIso(),
      },
    });
  } catch {
    // сохранение входящего — вспомогательный шаг при уже случившемся сбое
  }
}

/** Ответ владельцу: алерт на callback, сообщение в чат на тексте. */
async function answerUnhandled(incoming: UnhandledIncoming): Promise<void> {
  try {
    if (incoming.callbackId) {
      await api.answerCallbackQuery({
        callback_query_id: incoming.callbackId,
        text: UNHANDLED_UPDATE_TEXT,
        show_alert: true,
      });
      return;
    }
    if (incoming.chatId !== null) {
      await safeAnswer(incoming.chatId, UNHANDLED_UPDATE_TEXT, { replyMarkup: getMainKeyboard() });
    }
  } catch {
    // если и ответ не дошёл, апдейт всё равно не уходит в платформенный 500
  }
}

/**
 * Обработчик необработанного исключения: причина в журнал, входящее сохранено,
 * ответ честный. Шаги независимы — отказ любого не отменяет остальные.
 */
async function recoverUnhandledUpdate(
  message: Message | CallbackQuery | null | undefined,
  ctx: HandlerContext,
  error: unknown,
): Promise<void> {
  const incoming = unhandledIncoming(message, ctx);
  const detail = error instanceof Error ? error.message : String(error);

  if (incoming.userId !== null) {
    await recordFailure(incoming.userId, {
      stage: 'router',
      media: incoming.media,
      reason: 'unhandled',
      detail,
    });
  }

  await emergencySaveIncoming(incoming, detail);
  await answerUnhandled(incoming);
}
