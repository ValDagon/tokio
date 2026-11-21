/**
 * Маршрутизация апдейтов Telegram — порт `handlers.py` (handle_start …
 * handle_text_message) и callback-обработчиков.
 *
 * Что здесь есть:
 *  - `routeMessage` — ворота доступа, онбординг, пересланные сообщения,
 *    bare-word команды (подписи reply-клавиатуры и русские алиасы), слэш-команды
 *    со всеми алиасами, `/ask`, сброс контекста, fast-path бэклога эволюции и
 *    последний шаг — приём текста в инбокс;
 *  - `routeCallback` — `onboard:currency:*`, `backup:download`, `triage:inbox`
 *    плюс точки расширения для Т15;
 *  - швы (`setTextIngestHandler`, `setAgentRunner`, `setTriageHandler`,
 *    `setBackupSender`, `setConsolidationRunner`, `registerCallback`) — здесь
 *    только контракты; настоящие сервисы инбокса и триажа подключаются в Т15.
 *
 * Осознанные отличия от upstream (ADR-002, ADR-003):
 *  - никаких хардкод-данных пользователя: ни банков, ни городов, ни валют
 *    конкретного человека; адрес Mini App — только из `WEBAPP_URL`;
 *  - бэкап — JSON-файл (`stringifyBackup`), а не zip-архив: архиватор в изоляте
 *    недоступен, а JSON — самодостаточный формат восстановления;
 *  - классификатора намерений в TS нет: весь свободный текст уходит в инбокс;
 *  - `RetryAfter` обрабатывается без сна (в изоляте нет setTimeout) — см.
 *    `formatting.ts`;
 *  - дефолтный «инбокс» — честное сообщение «приём пока не подключён», а не
 *    фальшивое «сохранено».
 */

import { api, InputFile } from 'sdk';

import { MAX_REPLY_CONTEXT_CHARS, formatAgentQueryWithReply } from '../lib/agent/constants';
import { isLlmErrorReply, runAgent } from '../lib/agent/engine';
import { exportUserData, stringifyBackup } from '../lib/backup';
import { runNightlyConsolidation } from '../lib/consolidation';
import { clearThread } from '../lib/dal/agentState';
import { deleteTransaction, getLiability, rollbackLiabilityPayment } from '../lib/dal/finances';
import { kvGet, liabilityReviewKey, type LiabilityReviewDecision } from '../lib/dal/misc';
import { getMedication, skipMedication, takeMedication } from '../lib/dal/medications';
import { deleteNote, getNote, listNotes } from '../lib/dal/notes';
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  type TaskPatch,
} from '../lib/dal/tasks';
import {
  buildMorningDigest,
  parseLiabilityReviewCallback,
  updateLiabilityReviewCard,
  type LiabilityReviewAction,
  type LiabilityReviewCallback,
} from '../lib/digest';
import { deliverLiabilityReview } from '../lib/reminders';
import {
  activateSkill,
  formatSkillCard,
  formatSkillsList,
  handleEvolutionCommand,
  listItems,
  parseSkillSpec,
  rejectSkill,
} from '../lib/evolution';
import {
  LEARN_USAGE_TEXT,
  formatLearnedRuleReply,
  parseLearnCommand,
  rememberRule,
} from '../lib/learning';
import {
  applyBalanceChoice,
  applyLiabilityReviewChoice,
  claimPhotoRecovery,
  LIABILITY_REVIEW_FAILED_TOAST,
  LIABILITY_REVIEW_STALE_TOAST,
  LIABILITY_REVIEW_TAKEN_TOAST,
  claimVoiceRecovery,
  handleDocumentMessage,
  handlePhotoMessage,
  handleVoiceMessage,
  retryPhotoRecovery,
  retryVoiceRecovery,
} from './ingest';
import {
  balanceSummary,
  debtsSummary,
  diagnosticsReply,
  helpText,
  medsSummary,
  quickSummary,
  tasksSummary,
} from '../lib/summary';
import type { NoteRow } from '../lib/types';
import { truncate, zonedParts } from '../lib/utils';

import { escapeAmpLtGt, safeAnswer, safeEdit } from './formatting';
import {
  buildAgentDeepLinkKeyboard,
  buildUndoWithAppKeyboard,
  getBackupInlineKeyboard,
  getDashboardInlineKeyboard,
  getMainKeyboard,
  getOpenAppInlineKeyboard,
  getTriageInlineKeyboard,
  KEYBOARD_BALANCE,
  KEYBOARD_DEBTS,
  KEYBOARD_DIGEST,
  KEYBOARD_HELP,
  KEYBOARD_INBOX,
  KEYBOARD_MEDS,
  KEYBOARD_NEW,
  KEYBOARD_STATUS,
  KEYBOARD_TASKS,
  OPEN_APP_LABEL,
  type InlineKeyboardMarkup,
} from './keyboards';
// [public-only] Мастер онбординга и BYOK — фичи публичной редакции (HANDOFF §7.1).
import {
  applyMenuButton,
  checkAccess,
  createPresetAccounts,
  createSampleNote,
  createSampleTask,
  ensureUserProfile,
  exitOnboarding,
  loadUserLocale,
  parseBaseCurrencyChoice,
  resolveUserLocale,
  restartOnboarding,
  seedDemoWorkspace,
  sendOnboardingIntro,
  sendOnboardingPrompt,
  sendStartGreeting,
  sendWizardStep,
  setBaseCurrency,
  skipOnboarding,
  type OnboardingStep,
} from './onboarding';
import { getConfig } from '../lib/config';
import { getUser, updateUser } from '../lib/dal/users';
import { getAllKeyboardLabels, normalizeLocale, SUPPORTED_LOCALES, t, type LocaleCode } from '../lib/i18n';
import { getAssistantName, getOverlay } from '../lib/overlay';
import { deferReplyNotice, endReplyTurn } from '../lib/reply_turn';
import { checkSpendLimit, SPEND_LIMIT_EXCEEDED_MESSAGE } from '../lib/billing';
import { encryptByok, hasSecureRandom, looksLikeApiKey } from '../lib/crypto';
import { normalizeApiKey } from '../lib/gemini';

import type { CallbackQuery, Message } from './message';

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

/** `/backup`: сообщение-статус перед сбором файла. */
export const BACKUP_STATUS_TEXT = '📦 Собираю архив бэкапа со всеми данными...';

/** `/backup`: сбор не удался (см. `send_backup_to_telegram` → `False`). */
export const BACKUP_FAILED_TEXT = '⚠️ Не удалось сформировать бэкап. Попробуй позже.';

/** `/consolidate`: сообщение-статус перед прогоном. */
export const CONSOLIDATE_STATUS_TEXT = '🧹 Запускаю разбор и консолидацию мыслей...';

/** `/triage` и `triage:inbox`: сообщение-статус перед разбором. */
export const TRIAGE_STATUS_TEXT = '🧠 Начинаю интеллектуальный разбор инбокса...';

/** `/triage`: разбирать нечего. */
export const TRIAGE_EMPTY_TEXT = '📥 **Инбокс пуст!**\n\nВсе мысли и задачи уже разобраны 🎉';

/** `/triage`, пока сервис инбокса не подключён (Т15). */
export const TRIAGE_UNAVAILABLE_TEXT =
  '🧠 Разбор инбокса будет доступен после подключения сервиса инбокса.';

/** Свободный текст, пока приём заметок не подключён (Т15). */
export const INGEST_UNAVAILABLE_TEXT =
  '📥 Инбокс пока не подключён — приём заметок включится вместе с сервисом инбокса.';

/** `/new` и фразы сброса контекста. */
export const RESET_TEXT =
  '🧹 **Контекст беседы сброшен!** Начинаем диалог с чистого листа.\n\n' +
  'Все твои задачи, финансы и заметки в базе данных сохранены и актуальны. Чем займёмся?';

/** Неизвестная слэш-команда. */
export const UNKNOWN_COMMAND_TEXT =
  '❓ Неизвестная команда. Введи /help чтобы увидеть список доступных команд или просто напиши мне сообщение.';

/** `/ask` без аргумента. */
export const ASK_HINT_TEXT =
  '💬 Напиши вопрос после команды, например:\n`/ask почему вырос расход за прошлую неделю?`';

/** «Открыть дашборд», когда `WEBAPP_URL` не задан. */
export const DASHBOARD_UNAVAILABLE_TEXT =
  '🚀 Дашборд пока не подключён: адрес Mini App не задан в окружении.';

/** `/menu`: короткий перечень разделов под сеткой кнопок. */
export const MENU_TEXT = [
  '🧭 **Разделы под рукой** — сетка на один шаг:',
  '',
  '📊 Сводка — день целиком: бюджет, счета, фокус',
  '💰 Баланс — остатки по счетам и контуры',
  '💳 Долги — кредиты и график платежей',
  '🎯 Задачи — бэклог и микро-фокус',
  '💊 Аптечка — расписание лекарств',
  '☀️ Дайджест — утренняя сводка дня',
  '📥 Инбокс — накопившиеся мысли и заметки',
  'ℹ️ Помощь — все команды и правила',
  '',
  '_Клавиатура уберётся сама после нажатия — вернуть её можно командой_ `/menu`.',
].join('\n');

/** Текст `/backlog`, когда очередь пуста (паритет с upstream). */
export const BACKLOG_EMPTY_TEXT =
  '📋 **Бэклог авто-эволюции пуст.**\n\n' +
  'Чтобы добавить идею или баг-репорт без расхода токенов, напиши:\n' +
  '• `идея: добавить фильтр по счетам`\n' +
  '• `баг: не сработала кнопка отмены`\n' +
  'Либо надиктуй голосом!';

/** Шапка `/backlog` с непустой очередью. */
export const BACKLOG_HEADER = '📋 **Бэклог авто-эволюции:**\n';

/** Подпись под списком `/backlog`. */
export const BACKLOG_FOOTER =
  '\n_Задачи из этого бэклога можно разбирать и реализовывать по приоритету._';

/** Шапка списка `/inbox`. */
export function inboxHeader(count: number): string {
  return `📥 <b>Входящие (ожидают разбора): ${count} шт.</b>\n`;
}

/** `/inbox`, когда разбирать нечего. */
export const INBOX_EMPTY_TEXT =
  '📥 <b>Инбокс пуст.</b>\n\nВсе мысли и заметки разобраны! Наговаривай или пиши новые в любой момент.';

/** Подпись под списком `/inbox`. */
export const INBOX_FOOTER = '\n<i>Нажми кнопку ниже для мгновенного разбора нейросетью:</i>';

// ---------------------------------------------------------------------------
// Швы (контракты для следующих задач)
// ---------------------------------------------------------------------------

/** Контекст приёма свободного текста в инбокс. */
export interface IngestContext {
  userId: number;
  chatId: number;
  /** Обрезанный текст сообщения. */
  text: string;
  /** Сообщение переслано из другого чата/канала. */
  forwarded: boolean;
  /** `message_id` исходного сообщения (для дедупликации в инбоксе). */
  messageId?: number;
  /** Цитата источника (например, транскрипция голосового). */
  prefixQuote?: string;
  /** Контекст сообщения, на которое отвечает пользователь (`quote` / `reply_to_message`). */
  replyContext?: string;
  /** Тип источника: текст, голос, фото. */
  source?: 'text' | 'voice' | 'photo';
}

export type TextIngestHandler = (ctx: IngestContext) => Promise<void>;

/** Контекст запуска live-агента (`/ask`). */
export interface AgentRunContext {
  userId: number;
  chatId: number;
  text: string;
}

/** Возвращает готовый ответ для чата. */
export type AgentRunner = (ctx: AgentRunContext) => Promise<string>;

/** Результат разбора инбокса: сколько разобрали и готовый HTML-отчёт. */
export interface TriageOutcome {
  count: number;
  /** HTML-текст отчёта (шапка, действия, подпись). */
  text: string;
}

/** `null` — сервис разбора недоступен. */
export type TriageHandler = (userId: number) => Promise<TriageOutcome | null>;

/** `false` — бэкап собрать не удалось; исключение — сбой по дороге. */
export type BackupSender = (userId: number, chatId: number) => Promise<boolean>;

/** Ночная консолидация: нужен только текст для `✨ {message}`. */
export type ConsolidationRunner = (userId: number) => Promise<{ message: string }>;

export interface CallbackContext {
  userId: number;
  chatId: number;
  messageId: number;
  /** Полные `callback_data`. */
  data: string;
  firstName?: string;
}

export type CallbackHandler = (ctx: CallbackContext) => Promise<void>;

interface RouterSeams {
  ingest: TextIngestHandler | null;
  agent: AgentRunner | null;
  triage: TriageHandler | null;
  backup: BackupSender | null;
  consolidation: ConsolidationRunner | null;
  callbacks: Map<string, CallbackHandler>;
  callbacksByPrefix: Map<string, CallbackHandler>;
}

const seams: RouterSeams = {
  ingest: null,
  agent: null,
  triage: null,
  backup: null,
  consolidation: null,
  callbacks: new Map(),
  callbacksByPrefix: new Map(),
};

/** Подменяет приём текста (Т15). `null` — вернуть нейтральную заглушку. */
export function setTextIngestHandler(handler: TextIngestHandler | null): void {
  seams.ingest = handler;
}

/** Возвращает текущий обработчик приёма текста. */
export function getIngestHandler(): TextIngestHandler | null {
  return seams.ingest;
}

/** Подменяет live-агента `/ask`. `null` — вернуть `runAgent`. */
export function setAgentRunner(runner: AgentRunner | null): void {
  seams.agent = runner;
}

/** Подменяет разбор инбокса (Т15). `null` — вернуть «пока недоступно». */
export function setTriageHandler(handler: TriageHandler | null): void {
  seams.triage = handler;
}

/** Подменяет отправителя бэкапа. `null` — вернуть встроенный JSON-бэкап. */
export function setBackupSender(sender: BackupSender | null): void {
  seams.backup = sender;
}

/** Подменяет консолидацию. `null` — вернуть `runNightlyConsolidation`. */
export function setConsolidationRunner(runner: ConsolidationRunner | null): void {
  seams.consolidation = runner;
}

/**
 * Регистрирует обработчик callback-данных.
 *
 * `data`, оканчивающиеся на `:` (`nav:`), регистрируются как префикс: такой
 * обработчик получает всё, что начинается с этой строки, если точного
 * совпадения не нашлось.
 */
export function registerCallback(data: string, handler: CallbackHandler): void {
  if (!data) return;
  if (data.endsWith(':')) {
    seams.callbacksByPrefix.set(data, handler);
    return;
  }
  seams.callbacks.set(data, handler);
}

/** Снимает все подмены и возвращает поведение по умолчанию (тесты). */
export function resetRouterSeams(): void {
  seams.ingest = null;
  seams.agent = null;
  seams.triage = null;
  seams.backup = null;
  seams.consolidation = null;
  seams.callbacks.clear();
  seams.callbacksByPrefix.clear();
}

// ---------------------------------------------------------------------------
// Мелкие помощники
// ---------------------------------------------------------------------------

/**
 * Отправляет заглушки сбоя модели, отложенные за ход.
 *
 * Вызывается в конце `handlers/message.ts` (закрывает ход). Отложенная заглушка
 * уходит только если за ход не было ни одного другого ответа: детерминированный
 * путь (сводка, задача, заметка, напоминание) уже ответил пользователю.
 */
export async function flushReplyNotices(): Promise<void> {
  for (const notice of endReplyTurn()) {
    await safeAnswer(notice.chatId, notice.text, { replyMarkup: getMainKeyboard() });
  }
}

/** Сообщение ошибки так же, как Python печатает `{e}`. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageIdOf(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) return null;
  const id = (result as { message_id?: unknown }).message_id;
  return typeof id === 'number' ? id : null;
}

async function sendTyping(chatId: number): Promise<void> {
  await api.sendChatAction({ chat_id: chatId, action: 'typing' });
}

async function answerCallback(
  callbackId: string,
  text?: string,
  options: { showAlert?: boolean } = {},
): Promise<void> {
  const params: Record<string, unknown> = { callback_query_id: callbackId };
  if (typeof text === 'string' && text.length > 0) params.text = text;
  if (options.showAlert === true) params.show_alert = true;
  try {
    await api.answerCallbackQuery(params);
  } catch {
    // Всплывающее окно — украшение: его сбой не должен ломать обработчик.
  }
}

/**
 * Bot API 10.4: подтверждение нажатия кнопки как эфемерное сообщение
 * (`ephemeral_message_parameters.callback_query_id`) — видно только нажавшему и
 * исчезает само, чат не засоряется. Если сервер/клиент отклонил параметр,
 * откатываемся на обычный ответ (toast `answerCallbackQuery`).
 *
 * Не использовать для подтверждения отката платежа: он остаётся обычным ответом,
 * чтобы след сохранялся в логе.
 */
async function confirmCallback(callbackId: string, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage({
      chat_id: chatId,
      text,
      ephemeral_message_parameters: { callback_query_id: callbackId },
    });
  } catch {
    await answerCallback(callbackId, text);
    return;
  }
  // Гасим спиннер на кнопке (ответ без текста).
  await answerCallback(callbackId);
}

/** Python `str.splitlines()` без завершающего пустого элемента. */
const LINE_BREAK_PATTERN = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split(LINE_BREAK_PATTERN);
}

/** Переслано ли сообщение (любое из полей forward_*). */
export function isForwarded(message: Message): boolean {
  return Boolean(
    message.forward_origin ||
      message.forward_date ||
      message.forward_from ||
      message.forward_from_chat,
  );
}

/**
 * Достаёт текст цитаты (`quote.text`) или исходного сообщения (`reply_to_message`)
 * при ответе пользователя (reply), обрезая до `MAX_REPLY_CONTEXT_CHARS`.
 */
export function extractReplyContext(message: Message): string | undefined {
  const quoteText = typeof message.quote?.text === 'string' ? message.quote.text.trim() : '';
  const replyText =
    typeof message.reply_to_message?.text === 'string'
      ? message.reply_to_message.text.trim()
      : '';
  const replyCaption =
    typeof message.reply_to_message?.caption === 'string'
      ? message.reply_to_message.caption.trim()
      : '';
  const raw = quoteText || replyText || replyCaption;
  if (!raw) return undefined;
  return truncate(raw, MAX_REPLY_CONTEXT_CHARS);
}

// ---------------------------------------------------------------------------
// Встроенный бэкап (JSON вместо zip)
// ---------------------------------------------------------------------------

/**
 * Собирает снимок данных и отправляет его документом.
 *
 * Подпись повторяет `send_backup_to_telegram` (счётчики и размер), но вместо
 * zip-архива уходит один JSON — он и есть полный формат восстановления.
 */
export async function sendJsonBackup(userId: number, chatId: number): Promise<boolean> {
  try {
    const backup = await exportUserData(userId);
    const bytes = new TextEncoder().encode(stringifyBackup(backup));
    const date = new Date().toISOString().slice(0, 10);
    const sizeKb = Number((bytes.byteLength / 1024).toFixed(1));
    const counts = backup.counts;

    const caption = [
      '📦 **Внеочередной бэкап данных**',
      '',
      `• 🎯 Задач: **${counts.tasks ?? 0}**`,
      `• 📝 Заметок: **${counts.notes ?? 0}**`,
      `• 💳 Транзакций: **${counts.transactions ?? 0}**`,
      `• 💰 Счетов: **${counts.accounts ?? 0}**`,
      `• 📑 Обязательств: **${counts.liabilities ?? 0}**`,
      `• 💊 Препаратов: **${counts.medications ?? 0}**`,
      '',
      `📁 Размер файла: \`${sizeKb} KB\``,
      '_Внутри: полный JSON для восстановления._',
    ].join('\n');

    await api.sendDocument({
      chat_id: chatId,
      document: new InputFile(bytes, `${getOverlay().manifest.brand.backupPrefix}-${date}.json`, { type: 'application/json' }),
      caption,
      parse_mode: 'Markdown',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

type CommandHandler = (userId: number, chatId: number) => Promise<void>;

async function handleStart(userId: number, chatId: number): Promise<void> {
  await sendStartGreeting(chatId, { withIntro: false, locale: await loadUserLocale(userId) });
}

async function handleBackup(userId: number, chatId: number): Promise<void> {
  await api.sendChatAction({ chat_id: chatId, action: 'upload_document' });
  const statusId = messageIdOf(await safeAnswer(chatId, BACKUP_STATUS_TEXT));

  try {
    const sender = seams.backup ?? sendJsonBackup;
    const success = await sender(userId, chatId);
    if (success) {
      if (statusId !== null) {
        try {
          await api.deleteMessage({ chat_id: chatId, message_id: statusId });
        } catch {
          // Статус не удалился — не беда, файл уже ушёл.
        }
      }
      return;
    }
    if (statusId !== null) await safeEdit(chatId, statusId, BACKUP_FAILED_TEXT);
  } catch (error) {
    if (statusId !== null) {
      await safeEdit(chatId, statusId, `⚠️ Ошибка при создании бэкапа: ${errorText(error)}`);
    }
  }
}

async function handleStatus(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await quickSummary(userId), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось сформировать сводку: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleBalance(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await balanceSummary(userId), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось получить балансы: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleDebts(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await debtsSummary(userId), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось получить обязательства: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleTasks(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await tasksSummary(userId), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось получить задачи: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleMeds(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await medsSummary(userId), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось получить расписание лекарств: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

/**
 * Сводка по запросу: к тексту добавляется строка с местным временем запроса.
 *
 * Плановая сводка (`lib/reminders.ts`) этой строки не несёт, поэтому две
 * одинаковые суммы больше не выглядят как одно и то же сообщение, отправленное
 * дважды: видно, какая из них собрана по запросу.
 */
async function buildOnDemandDigest(userId: number): Promise<string> {
  const user = await getUser(userId);
  const timeZone = user?.timezone ?? 'UTC';
  const parts = zonedParts(new Date(), timeZone);
  const hh = String(parts.hour).padStart(2, '0');
  const mm = String(parts.minute).padStart(2, '0');
  const digest = await buildMorningDigest(userId);
  return `${digest}\n\n🕐 Запрошено вручную в ${hh}:${mm} (${timeZone}).`;
}

async function handleDigest(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await buildOnDemandDigest(userId), {
      replyMarkup: getBackupInlineKeyboard(),
    });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось составить утреннюю сводку: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
    return;
  }

  // Ручная сводка ведёт себя как плановая: отдельным сообщением после неё идёт
  // «Проверка списаний». Её сбой не отменяет уже показанную сводку.
  try {
    await deliverLiabilityReview(userId, { chatId });
  } catch (err) {
    console.warn('digest: liability review failed', userId, err);
  }
}

async function handleHelp(userId: number, chatId: number): Promise<void> {
  const user = await getUser(userId);
  const overlay = getOverlay();
  const locale = normalizeLocale(user?.language, overlay.manifest.defaultLocale);
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
  if (overlay.manifest.features.onboardingWizard) {
    rows.push([{ text: t(locale, 'help.btnRestartOnboarding'), callback_data: 'onboard:restart' }]);
  }
  const supportContact = overlay.manifest.brand.supportContact.trim();
  if (supportContact) {
    const handle = supportContact.replace(/^@/, '');
    rows.push([
      {
        text: t(locale, 'help.btnSupport', { supportContact }),
        url: `https://t.me/${handle}`,
      },
    ]);
  }
  await safeAnswer(chatId, helpText(locale), {
    replyMarkup: rows.length > 0 ? { inline_keyboard: rows } : undefined,
  });
}

async function handleLang(userId: number, chatId: number): Promise<void> {
  const user = await getUser(userId);
  const locale = normalizeLocale(user?.language, getOverlay().manifest.defaultLocale);
  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: t(locale, 'lang.buttonRu'), callback_data: 'lang:ru' },
        { text: t(locale, 'lang.buttonEn'), callback_data: 'lang:en' },
      ],
      [
        { text: t(locale, 'lang.buttonSr'), callback_data: 'lang:sr' },
        { text: t(locale, 'lang.buttonJa'), callback_data: 'lang:ja' },
      ],
    ],
  };
  await safeAnswer(chatId, t(locale, 'lang.prompt'), { replyMarkup: keyboard });
}

// [public-only] `/byok` снимает лимит $2 — есть только в публичной редакции.
async function handleByok(userId: number, chatId: number, keyArg?: string): Promise<void> {
  if (!getOverlay().manifest.features.byokCommand) {
    await safeAnswer(chatId, 'Команда /byok отключена в этой конфигурации.');
    return;
  }
  const cleanKey = (keyArg || '').trim();
  if (!cleanKey) {
    const user = await getUser(userId);
    const hasKey = user !== null && user.byok !== null && Boolean(user.byok.ciphertext);
    const statusText = hasKey
      ? '✅ **У вас уже подключен персональный ключ Gemini API (BYOK).**\nВсе лимиты расходов сняты.'
      : 'ℹ️ **Персональный ключ пока не подключен.** Используется общий ключ ($2.00 лимит).';
    const text =
      `${statusText}\n\n` +
      '🔑 **Как подключить свой ключ Google Gemini API:**\n' +
      '1. Получите бесплатный ключ в Google AI Studio:\nhttps://aistudio.google.com/app/apikey\n' +
      '2. Отправьте его боту командой:\n`/byok ВАШ_КЛЮЧ`\n\n' +
      'Ключ хранится зашифрованным (ChaCha20-Poly1305) и никогда не будет показан в чате. Он снимет все ограничения!';
    await safeAnswer(chatId, text, { replyMarkup: getMainKeyboard() });
    return;
  }

  const normKey = normalizeApiKey(cleanKey);
  if (!looksLikeApiKey(normKey)) {
    await safeAnswer(
      chatId,
      '⚠️ Некорректный формат ключа Gemini API. Ключ должен начинаться с `AIza...` или `AQ....` и содержать около 39–50 символов.',
      { replyMarkup: getMainKeyboard() },
    );
    return;
  }

  if (!hasSecureRandom()) {
    await safeAnswer(
      chatId,
      '⚠️ Не удалось безопасно сохранить ключ Gemini API: платформа не предоставляет криптографический генератор случайных чисел. Текущий ключ не изменён.',
      { replyMarkup: getMainKeyboard() },
    );
    return;
  }

  const config = await getConfig();
  const masterKey = config.masterKey || 'public-bot-master-key-32-chars-long';
  const sealed = await encryptByok(userId, normKey, { masterKey });
  await updateUser(userId, { byok: sealed });

  await safeAnswer(
    chatId,
    '🎉 **Ключ Google Gemini API успешно сохранён и зашифрован!**\n\n' +
      'Все лимиты расходов сняты. Запросы теперь выполняются напрямую через ваш персональный ключ.',
    { replyMarkup: getMainKeyboard() },
  );
}

/**
 * `/menu` — единственная (вместе с `/start`) команда, которая показывает сетку
 * разделов. Обычные ответы её сворачивают, поэтому вернуть клавиатуру можно
 * только отсюда.
 */
async function handleMenu(userId: number, chatId: number): Promise<void> {
  void userId;
  await safeAnswer(chatId, MENU_TEXT, {
    replyMarkup: getMainKeyboard(),
    keepReplyKeyboard: true,
  });
}

/**
 * `/diagnostics` — что сломалось и сколько раз. Читает нормализованный журнал
 * (MU-3) и старый ключ последнего отказа модели; ничего не пишет.
 */
async function handleDiagnostics(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  try {
    await safeAnswer(chatId, await diagnosticsReply(userId), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось прочитать журнал сбоев: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleConsolidate(userId: number, chatId: number): Promise<void> {
  await sendTyping(chatId);
  const statusId = messageIdOf(await safeAnswer(chatId, CONSOLIDATE_STATUS_TEXT));

  try {
    const runner = seams.consolidation ?? ((id: number) => runNightlyConsolidation(id));
    const result = await runner(userId);
    if (statusId !== null) await safeEdit(chatId, statusId, `✨ ${result.message}`);
  } catch (error) {
    if (statusId !== null) {
      await safeEdit(chatId, statusId, `⚠️ Ошибка при консолидации: ${errorText(error)}`);
    }
  }
}

async function handleReset(userId: number, chatId: number): Promise<void> {
  await clearThread(userId);
  await safeAnswer(chatId, RESET_TEXT, { replyMarkup: getMainKeyboard() });
}

async function handleBacklog(userId: number, chatId: number): Promise<void> {
  const items = await listItems(userId, { status: 'pending' });
  if (items.length === 0) {
    await safeAnswer(chatId, BACKLOG_EMPTY_TEXT, { replyMarkup: getMainKeyboard() });
    return;
  }

  const lines = [BACKLOG_HEADER];
  for (let index = 0; index < Math.min(items.length, 10); index += 1) {
    const item = items[index] as { category?: string; title?: string };
    const icon = item.category === 'bug' ? '🐛' : '💡';
    lines.push(`${index + 1}. ${icon} **${item.title ?? ''}**`);
  }
  lines.push(BACKLOG_FOOTER);

  await safeAnswer(chatId, lines.join('\n'), { replyMarkup: getMainKeyboard() });
}

/** Неразобранные заметки: DAL не умеет фильтровать по `processed_at` — фильтруем здесь. */
async function unprocessedNotes(userId: number, limit: number): Promise<NoteRow[]> {
  const notes = await listNotes(userId, { column: 'raw', limit: 50 });
  return notes.filter((note) => note.processedAt === null).slice(0, limit);
}

async function handleInbox(userId: number, chatId: number): Promise<void> {
  try {
    const items = await unprocessedNotes(userId, 10);
    if (items.length === 0) {
      await safeAnswer(chatId, INBOX_EMPTY_TEXT, {
        replyMarkup: getMainKeyboard(),
        isHtml: true,
      });
      return;
    }

    const lines = [inboxHeader(items.length)];
    for (let index = 0; index < items.length; index += 1) {
      const note = items[index] as NoteRow;
      const clean = (note.cleanText || note.rawText || '').trim();
      const escapedClean = escapeAmpLtGt(clean);
      const cleanLines = splitLines(clean);
      const firstLine = cleanLines.length > 0 ? (cleanLines[0] as string).trim() : 'Заметка';
      const escapedFirst = escapeAmpLtGt(firstLine);

      if (cleanLines.length > 1) {
        lines.push(`${index + 1}. 📝 <b>${escapedFirst}</b> (всего ${cleanLines.length} строк):`);
        lines.push(`<blockquote expandable>${escapedClean}</blockquote>`);
      } else {
        lines.push(`${index + 1}. 📝 ${escapedClean}`);
      }
    }
    lines.push(INBOX_FOOTER);

    await safeAnswer(chatId, lines.join('\n'), {
      replyMarkup: getTriageInlineKeyboard(),
      isHtml: true,
    });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось получить инбокс: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleTriage(userId: number, chatId: number): Promise<void> {
  const handler = seams.triage;
  if (!handler) {
    await safeAnswer(chatId, TRIAGE_UNAVAILABLE_TEXT, { replyMarkup: getMainKeyboard() });
    return;
  }

  await sendTyping(chatId);
  const statusId = messageIdOf(await safeAnswer(chatId, TRIAGE_STATUS_TEXT));

  try {
    const outcome = await handler(userId);
    if (!outcome) {
      if (statusId !== null) await safeEdit(chatId, statusId, TRIAGE_UNAVAILABLE_TEXT);
      return;
    }
    if (statusId === null) return;
    if (outcome.count === 0) {
      await safeEdit(chatId, statusId, TRIAGE_EMPTY_TEXT);
      return;
    }
    await safeEdit(chatId, statusId, outcome.text, {
      isHtml: true,
      replyMarkup: getOpenAppInlineKeyboard(),
    });
  } catch (error) {
    if (statusId !== null) {
      await safeEdit(chatId, statusId, `⚠️ Ошибка при разборе инбокса: ${errorText(error)}`);
    }
  }
}

/** `/learn <правило>`: правило уходит в SQLite-директивы (рантайм-зеркало MEMORY.md). */
async function handleLearn(userId: number, chatId: number, text: string): Promise<void> {
  const rule = parseLearnCommand(text);
  if (!rule) {
    await safeAnswer(chatId, LEARN_USAGE_TEXT, { replyMarkup: getMainKeyboard() });
    return;
  }

  try {
    const result = await rememberRule(userId, rule);
    await safeAnswer(chatId, formatLearnedRuleReply(result), { replyMarkup: getMainKeyboard() });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Не удалось запомнить правило: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleAsk(
  userId: number,
  chatId: number,
  query: string,
  replyContext?: string,
): Promise<void> {
  const effectiveQuery = query
    ? formatAgentQueryWithReply(query, replyContext)
    : replyContext
      ? formatAgentQueryWithReply('Разбери это сообщение и помоги по сути.', replyContext)
      : '';
  if (!effectiveQuery) {
    await safeAnswer(chatId, ASK_HINT_TEXT, { replyMarkup: getMainKeyboard() });
    return;
  }

  const spend = await checkSpendLimit(userId);
  if (!spend.allowed) {
    await safeAnswer(chatId, SPEND_LIMIT_EXCEEDED_MESSAGE, { replyMarkup: getMainKeyboard() });
    return;
  }

  await sendTyping(chatId);
  try {
    if (seams.agent) {
      const reply = await seams.agent({ userId, chatId, text: effectiveQuery });
      // Сбой модели откладываем до конца хода: если в том же ходе ушёл настоящий
      // ответ (сводка, напоминание), извинение уже не нужно (lib/reply_turn.ts).
      if (isLlmErrorReply(reply) && deferReplyNotice(chatId, reply)) return;
      await safeAnswer(chatId, reply, { replyMarkup: getMainKeyboard() });
      return;
    }

    const result = await runAgent({ userId, text: effectiveQuery });
    if (isLlmErrorReply(result.reply) && deferReplyNotice(chatId, result.reply)) return;
    await safeAnswer(chatId, result.reply, {
      replyMarkup: buildAgentDeepLinkKeyboard(result.steps) ?? getMainKeyboard(),
    });
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Ошибка агента: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

/**
 * `/skills` — петля скиллов для владельца: посмотреть полный текст, включить,
 * отклонить. Сокращений нет: только явные подкоманды, чтобы включение
 * сгенерированного текста никогда не было случайным.
 */
export const SKILLS_USAGE_TEXT = [
  'Как пользоваться скиллами:',
  '/skills — список с числами',
  '/skills show <id> — полный текст',
  '/skills activate <id> — включить (только владелец)',
  '/skills reject <id> — отклонить черновик',
].join('\n');

export type SkillsAction = 'list' | 'show' | 'activate' | 'reject';

export interface SkillsCommand {
  action: SkillsAction;
  id: number | null;
}

const SKILLS_SUBCOMMANDS: Record<string, Exclude<SkillsAction, 'list'>> = {
  show: 'show',
  показать: 'show',
  activate: 'activate',
  включить: 'activate',
  reject: 'reject',
  отклонить: 'reject',
};

/** Разбор `/skills …`. `null` — подкоманда неизвестна (нужна подсказка). */
export function parseSkillsCommand(text: string): SkillsCommand | null {
  const tokens = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length <= 1) return { action: 'list', id: null };

  const sub = rstripChars((tokens[1] ?? '').toLowerCase(), '?!.,;:');
  const action = SKILLS_SUBCOMMANDS[sub];
  if (!action) return null;

  const rawId = rstripChars((tokens[2] ?? '').toLowerCase(), '?!.,;:');
  const id = Number.parseInt(rawId, 10);
  return { action, id: Number.isFinite(id) && id > 0 ? id : null };
}

async function handleSkills(userId: number, chatId: number, text: string): Promise<void> {
  await sendTyping(chatId);
  try {
    const command = parseSkillsCommand(text);
    if (!command) {
      await safeAnswer(chatId, SKILLS_USAGE_TEXT, { replyMarkup: getMainKeyboard() });
      return;
    }

    if (command.action === 'list') {
      await safeAnswer(chatId, await formatSkillsList(userId), { replyMarkup: getMainKeyboard() });
      return;
    }

    if (command.id === null) {
      await safeAnswer(chatId, SKILLS_USAGE_TEXT, { replyMarkup: getMainKeyboard() });
      return;
    }

    if (command.action === 'show') {
      const card = await formatSkillCard(userId, command.id);
      await safeAnswer(chatId, card ?? 'Скилл с таким номером не найден.', {
        replyMarkup: getMainKeyboard(),
      });
      return;
    }

    if (command.action === 'activate') {
      const result = await activateSkill(userId, command.id);
      if (!result.ok) {
        await safeAnswer(chatId, `⚠️ ${result.error}`, { replyMarkup: getMainKeyboard() });
        return;
      }
      const key = parseSkillSpec(result.item.spec)?.key ?? 'скилл';
      await safeAnswer(
        chatId,
        `✅ Включено: ${key}. Процедура попадёт в промпт со следующего прогона.`,
        { replyMarkup: getMainKeyboard() },
      );
      return;
    }

    const rejected = await rejectSkill(userId, command.id);
    await safeAnswer(
      chatId,
      rejected.ok
        ? `🚫 Скилл #${command.id} отклонён и в промпт не попадает.`
        : `⚠️ ${rejected.error}`,
      { replyMarkup: getMainKeyboard() },
    );
  } catch (error) {
    await safeAnswer(chatId, `⚠️ Ошибка при работе со скиллами: ${errorText(error)}`, {
      replyMarkup: getMainKeyboard(),
    });
  }
}

async function handleOpenDashboard(chatId: number): Promise<void> {
  const keyboard = getOpenAppInlineKeyboard();
  if (!keyboard) {
    await safeAnswer(chatId, DASHBOARD_UNAVAILABLE_TEXT, { replyMarkup: getMainKeyboard() });
    return;
  }
  await safeAnswer(chatId, 'Открываю дашборд 👇', { replyMarkup: keyboard });
}

interface NamedCommand {
  handler: CommandHandler;
}

/** Слэш-команды и их алиасы: токен без `/` и без `@botname`. */
const SLASH_COMMANDS: Record<string, NamedCommand> = {
  start: { handler: handleStart },
  menu: { handler: handleMenu },
  меню: { handler: handleMenu },
  backup: { handler: handleBackup },
  export: { handler: handleBackup },
  status: { handler: handleStatus },
  summary: { handler: handleStatus },
  статус: { handler: handleStatus },
  сводка: { handler: handleStatus },
  balance: { handler: handleBalance },
  fin: { handler: handleBalance },
  баланс: { handler: handleBalance },
  счета: { handler: handleBalance },
  debts: { handler: handleDebts },
  liabilities: { handler: handleDebts },
  долги: { handler: handleDebts },
  кредиты: { handler: handleDebts },
  обязательства: { handler: handleDebts },
  tasks: { handler: handleTasks },
  todo: { handler: handleTasks },
  задачи: { handler: handleTasks },
  дела: { handler: handleTasks },
  meds: { handler: handleMeds },
  medications: { handler: handleMeds },
  лекарства: { handler: handleMeds },
  аптечка: { handler: handleMeds },
  digest: { handler: handleDigest },
  дайджест: { handler: handleDigest },
  help: { handler: handleHelp },
  commands: { handler: handleHelp },
  помощь: { handler: handleHelp },
  справка: { handler: handleHelp },
  consolidate: { handler: handleConsolidate },
  diagnostics: { handler: handleDiagnostics },
  диагностика: { handler: handleDiagnostics },
  new: { handler: handleReset },
  reset: { handler: handleReset },
  clear: { handler: handleReset },
  сброс: { handler: handleReset },
  backlog: { handler: handleBacklog },
  evolution: { handler: handleBacklog },
  бэклог: { handler: handleBacklog },
  эволюция: { handler: handleBacklog },
  inbox: { handler: handleInbox },
  буфер: { handler: handleInbox },
  инбокс: { handler: handleInbox },
  входящие: { handler: handleInbox },
  triage: { handler: handleTriage },
  разобрать: { handler: handleTriage },
  разбор: { handler: handleTriage },
  триаж: { handler: handleTriage },
  byok: { handler: (u, c) => handleByok(u, c, '') },
  ключ: { handler: (u, c) => handleByok(u, c, '') },
  lang: { handler: handleLang },
  language: { handler: handleLang },
  язык: { handler: handleLang },
  jezik: { handler: handleLang },
  言語: { handler: handleLang },
  skills: { handler: (userId: number, chatId: number) => handleSkills(userId, chatId, '/skills') },
  скиллы: { handler: (userId: number, chatId: number) => handleSkills(userId, chatId, '/skills') },
};

/** Подписи reply-клавиатуры и русские слова-команды. */
function bareWordCommands(): Record<string, CommandHandler> {
  const map: Record<string, CommandHandler> = {};
  const register = (label: string, handler: CommandHandler): void => {
    map[label.toLowerCase()] = handler;
  };

  for (const label of getAllKeyboardLabels('status')) register(label, handleStatus);
  for (const label of getAllKeyboardLabels('balance')) register(label, handleBalance);
  for (const label of getAllKeyboardLabels('debts')) register(label, handleDebts);
  for (const label of getAllKeyboardLabels('tasks')) register(label, handleTasks);
  for (const label of getAllKeyboardLabels('meds')) register(label, handleMeds);
  for (const label of getAllKeyboardLabels('digest')) register(label, handleDigest);
  for (const label of getAllKeyboardLabels('inbox')) register(label, handleInbox);
  for (const label of getAllKeyboardLabels('newSession')) register(label, handleReset);
  for (const label of getAllKeyboardLabels('help')) register(label, handleHelp);
  for (const loc of SUPPORTED_LOCALES) {
    register(t(loc, 'keyboards.openApp'), (_userId: number, chatId: number) => handleOpenDashboard(chatId));
  }

  const words: Record<string, CommandHandler> = {
    статус: handleStatus,
    сводка: handleStatus,
    баланс: handleBalance,
    долги: handleDebts,
    задачи: handleTasks,
    аптечка: handleMeds,
    лекарства: handleMeds,
    дайджест: handleDigest,
    инбокс: handleInbox,
    буфер: handleInbox,
    входящие: handleInbox,
    raw: handleInbox,
    'что в raw': handleInbox,
    'что в инбоксе': handleInbox,
    'что в буфере': handleInbox,
    'что во входящих': handleInbox,
    'покажи raw': handleInbox,
    'покажи инбокс': handleInbox,
    'покажи буфер': handleInbox,
    'покажи входящие': handleInbox,
    'разобрать инбокс': handleTriage,
    разобрать: handleTriage,
    разбор: handleTriage,
    триаж: handleTriage,
    помощь: handleHelp,
    справка: handleHelp,
    меню: handleMenu,
    сброс: handleReset,
    byok: (u, c) => handleByok(u, c, ''),
    ключ: (u, c) => handleByok(u, c, ''),
  };
  for (const [word, handler] of Object.entries(words)) map[word] = handler;

  return map;
}

const BARE_WORDS = bareWordCommands();

/** Фразы сброса беседы (без слэша). */
const RESET_PHRASES = new Set([
  'начни новую сессию',
  'новая сессия',
  'сбрось контекст',
  'начни с чистого листа',
  'сброс контекста',
]);

/** Python `str.rstrip(chars)` — срезает ЛЮБЫЕ из символов в хвосте. */
function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1] as string)) end -= 1;
  return text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Маршрутизация сообщений
// ---------------------------------------------------------------------------

/** Полный путь текстового сообщения: доступ → онбординг → команды → инбокс. */
export async function routeMessage(message: Message): Promise<void> {
  const from = message.from;
  if (!from) return;

  const userId = from.id;
  const chatId = message.chat.id;

  const access = await checkAccess(userId, { kind: 'message' });
  if (!access.allowed) {
    if (access.reply) await safeAnswer(chatId, access.reply, { replyMarkup: getMainKeyboard() });
    return;
  }

  const { isNew, user } = await ensureUserProfile(
    userId,
    from.first_name ?? null,
    from.language_code ?? null,
  );
  const replyContext = extractReplyContext(message);

  if (message.voice) {
    await handleVoiceMessage(userId, chatId, message.voice, message.message_id, replyContext);
    return;
  }

  if (message.photo && message.photo.length > 0) {
    await handlePhotoMessage(
      userId,
      chatId,
      message.photo,
      message.caption,
      message.message_id,
      isForwarded(message),
      {
        messageDate: message.date,
        forwardDate: message.forward_date,
        ...(replyContext ? { replyContext } : {}),
      },
    );
    return;
  }

  // Документ проверяется ПОСЛЕ гейта доступа: неавторизованный файл не должен
  // даже скачиваться. Картинка идёт фото-путём, остальное — в инбокс как есть.
  if (message.document) {
    await handleDocumentMessage(
      userId,
      chatId,
      message.document,
      message.caption,
      message.message_id,
      isForwarded(message),
      {
        messageDate: message.date,
        forwardDate: message.forward_date,
        ...(replyContext ? { replyContext } : {}),
      },
    );
    return;
  }

  const rawText = typeof message.text === 'string' ? message.text : '';
  const userText = rawText.trim();
  const lowerText = userText.toLowerCase();

  if (isNew || user.onboardingStep === 'new') {
    const locale = resolveUserLocale(user);
    await applyMenuButton(chatId, locale);
    if (lowerText === '/start' || lowerText.startsWith('/start@') || lowerText.startsWith('/start ') || !userText) {
      await sendStartGreeting(chatId, { withIntro: false, locale });
      await sendOnboardingPrompt(chatId, locale);
      return;
    }
    await sendOnboardingPrompt(chatId, locale);
    return;
  }

  const forwarded = isForwarded(message);

  if (!forwarded) {
    // 1. Подписи клавиатуры и слова-команды.
    const cleanText = rstripChars(lowerText.trim(), '?!.,;: ');
    const bareHandler = BARE_WORDS[cleanText];
    if (bareHandler) {
      await bareHandler(userId, chatId);
      return;
    }

    // 2. Слэш-команды и алиасы.
    if (userText.startsWith('/')) {
      const firstToken = userText.split(/\s+/)[0] ?? '';
      const token = rstripChars(
        firstToken.slice(1).split('@')[0]?.toLowerCase() ?? '',
        '?!.,;: ',
      );

      if (lowerText.startsWith('/byok') || lowerText.startsWith('/ключ')) {
        const firstSpace = userText.search(/\s/);
        const query = firstSpace === -1 ? '' : userText.slice(firstSpace).trim();
        await handleByok(userId, chatId, query);
        return;
      }

      if (lowerText.startsWith('/ask') || lowerText.startsWith('/agent') || lowerText.startsWith('/агент')) {
        const firstSpace = userText.search(/\s/);
        const query = firstSpace === -1 ? '' : userText.slice(firstSpace).trim();
        await handleAsk(userId, chatId, query, replyContext);
        return;
      }

      if (token === 'learn' || token === 'запомни' || token === 'правило' || token === 'rule') {
        await handleLearn(userId, chatId, userText);
        return;
      }

      // Скиллы: подкоманды (`show|activate|reject`) разбирает сам обработчик,
      // поэтому перехват идёт до общей таблицы слэш-команд.
      if (token === 'skills' || token === 'скиллы') {
        await handleSkills(userId, chatId, userText);
        return;
      }

      const command = SLASH_COMMANDS[token];
      if (command) {
        await command.handler(userId, chatId);
        return;
      }

      await safeAnswer(chatId, UNKNOWN_COMMAND_TEXT, { replyMarkup: getMainKeyboard() });
      return;
    }

    // 3. Фразы сброса контекста.
    if (RESET_PHRASES.has(rstripChars(lowerText, '!.,'))) {
      await handleReset(userId, chatId);
      return;
    }

    // 4. Fast-path бэклога эволюции (без токенов модели).
    const evolution = await handleEvolutionCommand(userId, userText);
    if (evolution) {
      await safeAnswer(chatId, evolution.reply, { replyMarkup: getMainKeyboard() });
      return;
    }
  }

  // 5. Всё остальное (и любой пересланный текст) — в инбокс.
  const ingest = seams.ingest ?? defaultIngest;
  await ingest({
    userId,
    chatId,
    text: userText,
    forwarded,
    messageId: message.message_id,
    ...(replyContext ? { replyContext } : {}),
  });
}

/** Заглушка приёма: честно говорит, что сервис ещё не подключён. */
async function defaultIngest(ctx: IngestContext): Promise<void> {
  await safeAnswer(ctx.chatId, INGEST_UNAVAILABLE_TEXT, { replyMarkup: getMainKeyboard() });
}

// ---------------------------------------------------------------------------
// Маршрутизация callback-запросов
// ---------------------------------------------------------------------------

/**
 * Правка сообщения из callback-а: сбой Bot API не должен ронять обработчик
 * после того, как действие уже выполнено (деньги, задача, заметка).
 */
async function trySafeEdit(
  chatId: number,
  messageId: number,
  text: string,
  options?: Parameters<typeof safeEdit>[3],
): Promise<void> {
  try {
    await safeEdit(chatId, messageId, text, options);
  } catch (error) {
    console.warn('callback: message edit failed', error);
  }
}

async function handleCurrencyCallback(
  callbackId: string,
  ctx: CallbackContext,
): Promise<void> {
  const code = parseBaseCurrencyChoice(ctx.data);
  if (!code) {
    await answerCallback(callbackId);
    return;
  }

  await setBaseCurrency(ctx.userId, code);
  const locale = await loadUserLocale(ctx.userId);
  await answerCallback(callbackId, t(locale, 'onboarding.toastCurrency', { currency: code }));

  const user = await getUser(ctx.userId);
  if (user && (user.onboardingStep === 'currency' || user.onboardingStep === 'timezone' || user.onboardingStep === 'overview')) {
    await updateUser(ctx.userId, { onboardingStep: 'accounts' });
    await sendWizardStep(ctx.chatId, 'accounts', ctx.userId, ctx.messageId);
    return;
  }

  await trySafeEdit(
    ctx.chatId,
    ctx.messageId,
    t(locale, 'onboarding.currencySaved', { currency: code }),
    { replyMarkup: { inline_keyboard: [] } },
  );
}

async function handleBackupCallback(callbackId: string, ctx: CallbackContext): Promise<void> {
  await answerCallback(callbackId, '📦 Отправляю файл бэкапа...');
  try {
    const sender = seams.backup ?? sendJsonBackup;
    const success = await sender(ctx.userId, ctx.chatId);
    if (!success) {
      await answerCallback(callbackId, BACKUP_FAILED_TEXT, { showAlert: true });
    }
  } catch (error) {
    await answerCallback(callbackId, `Ошибка бэкапа: ${errorText(error)}`, { showAlert: true });
  }
}

async function handleTriageCallback(callbackId: string, ctx: CallbackContext): Promise<void> {
  const handler = seams.triage;
  if (!handler) {
    await answerCallback(callbackId, TRIAGE_UNAVAILABLE_TEXT, { showAlert: true });
    return;
  }

  await answerCallback(callbackId, '🧠 Запускаю разбор...');
  try {
    const outcome = await handler(ctx.userId);
    if (!outcome) {
      await answerCallback(callbackId, TRIAGE_UNAVAILABLE_TEXT, { showAlert: true });
      return;
    }
    if (outcome.count === 0) {
      // Без `WEBAPP_URL` кнопки приложения нет: пустая клавиатура всё равно
      // снимает «Разобрать», иначе она осталась бы висеть над пустым инбоксом.
      await trySafeEdit(ctx.chatId, ctx.messageId, TRIAGE_EMPTY_TEXT, {
        replyMarkup: getOpenAppInlineKeyboard() ?? { inline_keyboard: [] },
      });
      return;
    }
    await trySafeEdit(ctx.chatId, ctx.messageId, outcome.text, {
      isHtml: true,
      replyMarkup: getOpenAppInlineKeyboard() ?? { inline_keyboard: [] },
    });
  } catch (error) {
    await answerCallback(callbackId, `Ошибка: ${errorText(error)}`, { showAlert: true });
  }
}

// ---------------------------------------------------------------------------
// Хелперы форматирования статусов и рендера дашборда
// ---------------------------------------------------------------------------

export function formatTargetTime(date: Date, timeZone: string = 'Europe/Berlin'): string {
  const p = zonedParts(date, timeZone);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatTargetDateTime(date: Date, timeZone: string = 'Europe/Berlin'): string {
  const p = zonedParts(date, timeZone);
  const dd = String(p.day).padStart(2, '0');
  const mo = String(p.month).padStart(2, '0');
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${dd}.${mo} ${hh}:${mm}`;
}

export function stripStatusSuffix(text: string): string {
  if (!text) return '';
  return text
    .replace(/\n\n(?:━{4,}\n)?(?:⏳|✅|💊|⏭️?|🗑️?|🎯|📥|🔁|❌|⌛|ℹ️).+$/s, '')
    .trimEnd();
}

export function appendStatusLine(originalText: string, statusLine: string): string {
  const base = stripStatusSuffix(originalText);
  if (!base) return statusLine;
  return `${base}\n\n━━━━━━━━━━━━━━\n${statusLine}`;
}

export async function renderDashboardContent(
  userId: number,
  tab: string,
): Promise<{ text: string; isHtml?: boolean; keyboard?: InlineKeyboardMarkup }> {
  if (tab === 'status') {
    return {
      text: await quickSummary(userId),
      keyboard: getDashboardInlineKeyboard({ activeTab: 'status' }),
    };
  }
  if (tab === 'balance') {
    return {
      text: await balanceSummary(userId),
      keyboard: getDashboardInlineKeyboard({ activeTab: 'balance' }),
    };
  }
  if (tab === 'debts') {
    return {
      text: await debtsSummary(userId),
      keyboard: getDashboardInlineKeyboard({ activeTab: 'debts' }),
    };
  }
  if (tab === 'tasks') {
    return {
      text: await tasksSummary(userId),
      keyboard: getDashboardInlineKeyboard({ activeTab: 'tasks' }),
    };
  }
  if (tab === 'meds') {
    return {
      text: await medsSummary(userId),
      keyboard: getDashboardInlineKeyboard({ activeTab: 'status' }),
    };
  }
  if (tab === 'digest') {
    return {
      text: await buildMorningDigest(userId),
      keyboard: getDashboardInlineKeyboard({ activeTab: 'digest', includeBackup: true }),
    };
  }
  if (tab === 'inbox') {
    const items = await unprocessedNotes(userId, 10);
    if (items.length === 0) {
      return {
        text: INBOX_EMPTY_TEXT,
        isHtml: true,
        keyboard: getDashboardInlineKeyboard({ activeTab: 'inbox' }),
      };
    }
    const lines = [inboxHeader(items.length)];
    for (let index = 0; index < items.length; index += 1) {
      const note = items[index] as NoteRow;
      const clean = (note.cleanText || note.rawText || '').trim();
      const escapedClean = escapeAmpLtGt(clean);
      const cleanLines = splitLines(clean);
      const firstLine = cleanLines.length > 0 ? (cleanLines[0] as string).trim() : 'Заметка';
      const escapedFirst = escapeAmpLtGt(firstLine);
      if (cleanLines.length > 1) {
        lines.push(`${index + 1}. 📝 <b>${escapedFirst}</b> (всего ${cleanLines.length} строк):`);
        lines.push(`<blockquote expandable>${escapedClean}</blockquote>`);
      } else {
        lines.push(`${index + 1}. 📝 ${escapedClean}`);
      }
    }
    lines.push(INBOX_FOOTER);
    return {
      text: lines.join('\n'),
      isHtml: true,
      keyboard: getDashboardInlineKeyboard({ activeTab: 'inbox', includeTriage: true }),
    };
  }
  return {
    text: await quickSummary(userId),
    keyboard: getDashboardInlineKeyboard({ activeTab: 'status' }),
  };
}

/**
 * Извлекает заголовок задачи из текста напоминания.
 * Примеры:
 *  - "⏰ *Напоминание!*\n\n📌 *Воскресное собрание 🧂🍞*\n📁 Категория: #Хобби"
 *  - "⏰ Напоминание!\n📌 Купить хлеб"
 *  - "📌 *Купить билеты на самолёт*"
 */
export function extractTaskTitleFromText(text: string): string | null {
  if (!text) return null;
  const match = text.match(/📌\s*([^\n\r]+)/);
  if (!match || !match[1]) return null;
  let title = match[1].trim();
  title = title.replace(/^[*_~`]+|[*_~`]+$/g, '').trim();
  return title.length > 0 ? title : null;
}

/**
 * Разрешает числовой ID задачи в SQLite:
 *  1. Если taskIdStr уже числовое > 0 — возвращает его;
 *  2. Если taskIdStr — UUID (или не число), пытается найти задачу по заголовку из originalText
 *     среди активных задач пользователя (`status = 'todo'`).
 */
export async function resolveTaskId(
  userId: number,
  taskIdStr: string,
  originalText?: string,
): Promise<number | null> {
  const numId = Number(taskIdStr);
  if (Number.isFinite(numId) && numId > 0) {
    return numId;
  }
  if (!originalText) return null;
  const title = extractTaskTitleFromText(originalText);
  if (!title) return null;
  try {
    const tasks = await listTasks(userId, { status: 'todo' });
    const clean = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (clean) {
      const found = tasks.find((t) => {
        const tClean = t.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        return tClean === clean || tClean.includes(clean) || clean.includes(tClean);
      });
      if (found) return found.id;
    }
  } catch (err) {
    console.warn('Error resolving task by title:', err);
  }
  return null;
}

const ACTION_TO_DECISION: Record<LiabilityReviewAction, LiabilityReviewDecision> = {
  p: 'paid',
  n: 'unpaid',
  d: 'deleted',
};

/** Решение, записанное в `kv`, если оно уже не `pending`; иначе `null`. */
async function readSettledLiabilityDecision(
  userId: number,
  parsed: LiabilityReviewCallback,
): Promise<LiabilityReviewDecision | null> {
  try {
    const raw = await kvGet(liabilityReviewKey(userId, parsed.liabilityId, parsed.month));
    if (raw === null) return null;
    const record = JSON.parse(raw) as { status?: unknown; decision?: unknown } | null;
    if (!record || record.status === 'pending') return null;
    const decision = record.decision;
    return decision === 'paid' || decision === 'unpaid' || decision === 'deleted' ? decision : null;
  } catch (error) {
    console.warn('lrev: settled decision read failed', error);
    return null;
  }
}

/**
 * Какое решение по пункту уже окончательно, чтобы показать его в карточке.
 * `null` — менять карточку нельзя: отказ, чужой месяц, сбой или решение ещё в полёте.
 */
async function settledLiabilityReviewDecision(
  userId: number,
  parsed: LiabilityReviewCallback,
  result: { toast?: string; alert?: boolean },
  preLiability: { isActive: boolean } | null,
): Promise<LiabilityReviewDecision | null> {
  if (result.toast === LIABILITY_REVIEW_STALE_TOAST || result.toast === LIABILITY_REVIEW_FAILED_TOAST) {
    return null;
  }
  if (result.alert !== true) {
    if (result.toast !== LIABILITY_REVIEW_TAKEN_TOAST) return ACTION_TO_DECISION[parsed.action];
    return readSettledLiabilityDecision(userId, parsed);
  }
  if (!preLiability || !preLiability.isActive) {
    return (await readSettledLiabilityDecision(userId, parsed)) ?? 'deleted';
  }
  return null;
}

/** Путь callback-запроса: доступ → зарегистрированные → встроенные → префиксы. */
export async function routeCallback(callback: CallbackQuery): Promise<void> {
  const from = callback.from;
  if (!from) return;

  const callbackId = callback.id;
  const userId = from.id;
  const data = typeof callback.data === 'string' ? callback.data : '';

  const access = await checkAccess(userId, { kind: 'callback' });
  if (!access.allowed) {
    await answerCallback(callbackId, access.reply, { showAlert: access.alert === true });
    return;
  }

  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (typeof chatId !== 'number' || typeof messageId !== 'number') {
    await answerCallback(callbackId);
    return;
  }

  const originalText = callback.message?.text || callback.message?.caption || '';

  const ctx: CallbackContext = {
    userId,
    chatId,
    messageId,
    data,
    firstName: from.first_name,
  };

  const exact = seams.callbacks.get(data);
  if (exact) {
    await exact(ctx);
    return;
  }

  const prefix = `${data.split(':')[0] ?? ''}:`;
  const byPrefix = seams.callbacksByPrefix.get(prefix);
  if (byPrefix) {
    await byPrefix(ctx);
    return;
  }

  if (data === 'onboard:skip') {
    await skipOnboarding(userId);
    const locale = await loadUserLocale(userId);
    const assistantName = getAssistantName(locale);
    await answerCallback(callbackId, t(locale, 'onboarding.toastSkipped'));
    await safeEdit(
      chatId,
      messageId,
      t(locale, 'onboarding.skippedText', { assistantName }),
    );
    return;
  }

  if (data === 'onboard:exit') {
    await exitOnboarding(userId);
    const locale = await loadUserLocale(userId);
    const assistantName = getAssistantName(locale);
    await answerCallback(callbackId, t(locale, 'onboarding.toastExited'));
    await safeEdit(chatId, messageId, t(locale, 'onboarding.exitedText', { assistantName }));
    return;
  }

  if (data === 'onboard:restart' || data === 'onboard:start') {
    await restartOnboarding(userId);
    const locale = await loadUserLocale(userId);
    await answerCallback(callbackId, t(locale, 'onboarding.toastRestart'));
    await sendWizardStep(chatId, 'overview', userId, messageId);
    return;
  }

  if (data.startsWith('onboard:step:')) {
    const targetStep = data.slice('onboard:step:'.length) as OnboardingStep;
    if (targetStep === 'final') {
      await exitOnboarding(userId);
    } else {
      await updateUser(userId, { onboardingStep: targetStep });
    }
    await answerCallback(callbackId);
    await sendWizardStep(chatId, targetStep, userId, messageId);
    return;
  }

  if (data.startsWith('onboard:tz:')) {
    const tz = data.slice('onboard:tz:'.length);
    await updateUser(userId, { timezone: tz, onboardingStep: 'currency' });
    const locale = await loadUserLocale(userId);
    await answerCallback(callbackId, t(locale, 'onboarding.toastTimezone', { timezone: tz }));
    await sendWizardStep(chatId, 'currency', userId, messageId);
    return;
  }

  if (data.startsWith('onboard:currency:')) {
    await handleCurrencyCallback(callbackId, ctx);
    return;
  }

  if (data.startsWith('onboard:preset:')) {
    const preset = data.slice('onboard:preset:'.length) as 'cash_card' | 'full';
    const created = await createPresetAccounts(userId, preset);
    const locale = await loadUserLocale(userId);
    const accounts = created.join(', ');
    await answerCallback(callbackId, t(locale, 'onboarding.toastAccountsCreated', { accounts }));
    await updateUser(userId, { onboardingStep: 'practice' });
    await sendWizardStep(chatId, 'practice', userId, messageId, accounts);
    return;
  }

  if (data === 'onboard:action:sample_task') {
    const locale = await loadUserLocale(userId);
    const res = await createSampleTask(userId, locale);
    await answerCallback(callbackId, t(locale, 'onboarding.toastSampleTask'));
    await updateUser(userId, { onboardingStep: 'notifications' });
    await sendWizardStep(chatId, 'notifications', userId, messageId, res);
    return;
  }

  if (data === 'onboard:action:sample_note') {
    const locale = await loadUserLocale(userId);
    const res = await createSampleNote(userId, locale);
    await answerCallback(callbackId, t(locale, 'onboarding.toastSampleNote'));
    await updateUser(userId, { onboardingStep: 'notifications' });
    await sendWizardStep(chatId, 'notifications', userId, messageId, res);
    return;
  }

  if (data === 'onboard:action:seed_demo') {
    const user = await getUser(userId);
    const locale = normalizeLocale(user?.language, getOverlay().manifest.defaultLocale);
    const res = await seedDemoWorkspace(userId, locale);
    await answerCallback(callbackId, t(locale, 'onboarding.toastDemoSeed'));
    await updateUser(userId, { onboardingStep: 'notifications' });
    await sendWizardStep(chatId, 'notifications', userId, messageId, res);
    return;
  }

  if (data.startsWith('lang:')) {
    const requested = data.slice('lang:'.length) as LocaleCode;
    if ((SUPPORTED_LOCALES as readonly string[]).includes(requested)) {
      await updateUser(userId, { language: requested });
      const langName = t(requested, `lang.name_${requested}`);
      const msg = t(requested, 'lang.updated', { language: langName });
      await answerCallback(callbackId, msg);
      await safeAnswer(chatId, msg, { replyMarkup: getMainKeyboard(requested) });
    } else {
      await answerCallback(callbackId, 'Unsupported language');
    }
    return;
  }

  if (data.startsWith('onboard:time:')) {
    const time = data.slice('onboard:time:'.length);
    await updateUser(userId, { summaryTime: time, onboardingStep: 'gemini' });
    const locale = await loadUserLocale(userId);
    await answerCallback(callbackId, t(locale, 'onboarding.toastDigestTime', { time }));
    await sendWizardStep(chatId, 'gemini', userId, messageId);
    return;
  }

  if (data === 'onboard:finish_status') {
    await answerCallback(callbackId);
    await handleStatus(userId, chatId);
    return;
  }

  if (data === 'onboard:finish_help') {
    await answerCallback(callbackId);
    await handleHelp(userId, chatId);
    return;
  }
  if (data === 'backup:download') {
    await handleBackupCallback(callbackId, ctx);
    return;
  }
  if (data === 'triage:inbox') {
    await handleTriageCallback(callbackId, ctx);
    return;
  }

  // «Проверка списаний»: lrev:<liabilityId>:<YYYY-MM>:<p|n|d>.
  //
  // Решение применяет `applyLiabilityReviewChoice`: сначала claim в `kv`, затем
  // финансовое действие. Повтор и другое действие дают тост без записей, а
  // callback из прошлого месяца не меняет ничего. Карточка правится по пункту:
  // решённая строка кнопок исчезает, итог пункта дописывается под разделитель,
  // остальные пункты остаются нажимаемыми. Повтор по уже решённому пункту тоже
  // убирает зависшую строку кнопок.
  if (data.startsWith('lrev:')) {
    const parsed = parseLiabilityReviewCallback(data);
    let preLiability: Awaited<ReturnType<typeof getLiability>> = null;
    if (parsed) {
      try {
        preLiability = await getLiability(userId, parsed.liabilityId);
      } catch (error) {
        console.warn('lrev: liability preload failed', error);
      }
    }
    const result = await applyLiabilityReviewChoice({ userId, data });
    await answerCallback(callbackId, result.toast, { showAlert: result.alert === true });

    const decision = parsed ? await settledLiabilityReviewDecision(userId, parsed, result, preLiability) : null;
    if (parsed && decision) {
      const updated = updateLiabilityReviewCard({
        originalText,
        replyMarkup: callback.message?.reply_markup,
        liabilityId: parsed.liabilityId,
        decision,
        liabilityName: preLiability?.name,
      });
      await trySafeEdit(chatId, messageId, updated.text, { replyMarkup: updated.replyMarkup });
    }
    return;
  }

  // Повтор распознавания голосового: retry_voice:{noteId} (MU-1).
  //
  // Владелец проверяется здесь, а не в заметке: `claimVoiceRecovery` читает
  // запись через `getNote(userId, …)`, поэтому чужой идентификатор даёт `null` —
  // обработка не запускается и содержимое чужой заметки не раскрывается.
  // Захват нужен против двойного нажатия: второй callback не должен провести
  // распознавание (и возможную денежную операцию) повторно.
  if (data.startsWith('retry_voice:')) {
    const noteId = Number(data.slice('retry_voice:'.length));
    const recovery =
      Number.isInteger(noteId) && noteId > 0 ? await claimVoiceRecovery(userId, noteId) : null;
    if (!recovery) {
      await answerCallback(callbackId, '⚠️ Уже обрабатываю это голосовое или оно недоступно', {
        showAlert: true,
      });
      // Записи больше нет (распознано и убрано): кнопка повтора не должна висеть.
      if (Number.isInteger(noteId) && noteId > 0 && !(await getNote(userId, noteId))) {
        await trySafeEdit(
          chatId,
          messageId,
          appendStatusLine(originalText, '✅ Распознавание уже выполнено.'),
          { replyMarkup: { inline_keyboard: [] } },
        );
      }
      return;
    }
    await answerCallback(callbackId, '🎙 Повторяю распознавание…');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, '🔁 Повторное распознавание запущено…'),
      { replyMarkup: { inline_keyboard: [] } },
    );
    await retryVoiceRecovery({ userId, chatId, noteId, meta: recovery });
    return;
  }

  // Повтор распознавания фото: retry_photo:{noteId} (MU-2).
  //
  // Владелец проверяется той же дисциплиной, что у голоса: `claimPhotoRecovery`
  // читает запись через `getNote(userId, …)`, поэтому чужой идентификатор даёт
  // `null`. Кнопка существует только для стадий до возможной финансовой записи:
  // заметка с отказом проведения чека не читается как recovery, и повтор не
  // может списать деньги второй раз.
  if (data.startsWith('retry_photo:')) {
    const noteId = Number(data.slice('retry_photo:'.length));
    const recovery =
      Number.isInteger(noteId) && noteId > 0 ? await claimPhotoRecovery(userId, noteId) : null;
    if (!recovery) {
      await answerCallback(callbackId, '⚠️ Уже обрабатываю это фото или оно недоступно', {
        showAlert: true,
      });
      // Записи нет или чек уже проведён с отказом: повтор невозможен, кнопку убираем.
      // Свежий claim (повтор идёт прямо сейчас) кнопку не трогает.
      const existingNote =
        Number.isInteger(noteId) && noteId > 0 ? await getNote(userId, noteId) : null;
      if (
        !existingNote ||
        (existingNote.metadata as Record<string, unknown> | null)?.receipt_failure
      ) {
        await trySafeEdit(chatId, messageId, appendStatusLine(originalText, 'ℹ️ Повтор недоступен.'), {
          replyMarkup: { inline_keyboard: [] },
        });
      }
      return;
    }
    await answerCallback(callbackId, '📸 Повторяю распознавание…');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, '🔁 Повторное распознавание запущено…'),
      { replyMarkup: { inline_keyboard: [] } },
    );
    await retryPhotoRecovery({ userId, chatId, noteId, meta: recovery });
    return;
  }

  // Явное подтверждение счёта для остатка со скриншота: bal:{token}:{accountId}.
  //
  // Деньги двигаются только здесь: пока владелец не нажал кнопку, снимок
  // лежит в `kv` и счета не тронуты. Ответ на нажатие — всплывающая строка,
  // а тело сообщения правится на подтверждённый баланс.
  if (data.startsWith('bal:')) {
    const result = await applyBalanceChoice({ userId, chatId, messageId, data, originalText });
    if (result.toast) await answerCallback(callbackId, result.toast);
    else await answerCallback(callbackId);
    return;
  }

  // 1. Перенос задачи (task_snooze:{id}:{minutes} и task:snooze:{id}:{minutes})
  if (data.startsWith('task_snooze:') || data.startsWith('task:snooze:')) {
    const prefixLen = data.startsWith('task_snooze:') ? 'task_snooze:'.length : 'task:snooze:'.length;
    const rest = data.slice(prefixLen);
    const parts = rest.split(':');
    const taskIdStr = parts[0] || '';
    const minsRaw = Number(parts[1]);
    const minutes = Number.isFinite(minsRaw) && minsRaw > 0 ? minsRaw : 60;

    const targetDate = new Date(Date.now() + minutes * 60_000);
    const targetIso = targetDate.toISOString();
    let label: string;
    if (minutes >= 1440) {
      label = `+1 день (до ${formatTargetDateTime(targetDate, 'Europe/Berlin')})`;
    } else if (minutes === 60) {
      label = `+1 час (до ${formatTargetTime(targetDate, 'Europe/Berlin')})`;
    } else {
      label = `+${minutes} мин (до ${formatTargetTime(targetDate, 'Europe/Berlin')})`;
    }

    const resolvedId = await resolveTaskId(userId, taskIdStr, originalText);
    if (resolvedId !== null) {
      try {
        const task = await getTask(userId, resolvedId);
        if (task) {
          const patch: TaskPatch = { remindAt: targetIso };
          if (minutes >= 1440) {
            if (task.dueAt) {
              const currentDue = new Date(task.dueAt);
              if (!isNaN(currentDue.getTime())) {
                patch.dueAt = new Date(currentDue.getTime() + minutes * 60_000).toISOString();
              } else {
                patch.dueAt = targetIso;
              }
            } else {
              patch.dueAt = targetIso;
            }
          }
          await updateTask(userId, resolvedId, patch);
        }
      } catch (err) {
        console.warn('Error updating snoozed task:', err);
      }
    }

    await confirmCallback(callbackId, chatId, `⏳ Перенесено: ${label}`);
    const nextTaskId = resolvedId !== null ? String(resolvedId) : taskIdStr;
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '✅ Выполнено', callback_data: `task_done:${nextTaskId}` }],
        [
          { text: '⏳ +1 час', callback_data: `task_snooze:${nextTaskId}:60` },
          { text: '⏳ +1 день', callback_data: `task_snooze:${nextTaskId}:1440` },
        ],
      ],
    };
    await trySafeEdit(chatId, messageId, appendStatusLine(originalText, `⏳ Перенесено: ${label}`), {
      replyMarkup: keyboard,
    });
    return;
  }

  // 2. Выполнение задачи (task_done:{id} и task:done:{id})
  if (data.startsWith('task_done:') || data.startsWith('task:done:')) {
    const taskIdStr = data.startsWith('task_done:')
      ? data.slice('task_done:'.length)
      : data.slice('task:done:'.length);
    const resolvedId = await resolveTaskId(userId, taskIdStr, originalText);
    if (resolvedId !== null) {
      try {
        await completeTask(userId, resolvedId);
      } catch (err) {
        console.warn('Error completing task:', err);
      }
    }
    await confirmCallback(callbackId, chatId, '✅ Задача выполнена!');
    await trySafeEdit(chatId, messageId, appendStatusLine(originalText, '✅ Выполнено!'), {
      replyMarkup: { inline_keyboard: [] },
    });
    return;
  }

  // 3. Приём лекарства (med_take:{id}:{time} и med:take:{id}:{time})
  if (data.startsWith('med_take:') || data.startsWith('med:take:')) {
    const rest = data.startsWith('med_take:') ? data.slice('med_take:'.length) : data.slice('med:take:'.length);
    const colonIdx = rest.indexOf(':');
    const medId = Number(colonIdx === -1 ? rest : rest.slice(0, colonIdx));
    let scheduledTime = colonIdx === -1 ? undefined : rest.slice(colonIdx + 1);
    if (!scheduledTime && Number.isFinite(medId)) {
      const med = await getMedication(userId, medId);
      scheduledTime = med?.times[0] ?? '09:00';
    }
    const finalTime = scheduledTime || '09:00';
    let stockNotice = '';
    if (Number.isFinite(medId)) {
      const res = await takeMedication(userId, medId, finalTime);
      if (res?.notice) {
        stockNotice = ` (${res.notice})`;
      }
    }
    await confirmCallback(callbackId, chatId, '💊 Приём отмечен');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, `✅ Приём отмечен (${finalTime})${stockNotice}`),
      { replyMarkup: { inline_keyboard: [] } },
    );
    return;
  }

  // 4. Пропуск лекарства (med_skip:{id}:{time} и med:skip:{id}:{time})
  if (data.startsWith('med_skip:') || data.startsWith('med:skip:')) {
    const rest = data.startsWith('med_skip:') ? data.slice('med_skip:'.length) : data.slice('med:skip:'.length);
    const colonIdx = rest.indexOf(':');
    const medId = Number(colonIdx === -1 ? rest : rest.slice(0, colonIdx));
    let scheduledTime = colonIdx === -1 ? undefined : rest.slice(colonIdx + 1);
    if (!scheduledTime && Number.isFinite(medId)) {
      const med = await getMedication(userId, medId);
      scheduledTime = med?.times[0] ?? '09:00';
    }
    const finalTime = scheduledTime || '09:00';
    if (Number.isFinite(medId)) {
      await skipMedication(userId, medId, finalTime);
    }
    await confirmCallback(callbackId, chatId, '⏭️ Приём пропущен');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, `⏭️ Приём пропущен (${finalTime})`),
      { replyMarkup: { inline_keyboard: [] } },
    );
    return;
  }

  // 5. Отложить лекарство (med:postpone:{id}:{time} и med_postpone:{id}:{time})
  if (data.startsWith('med:postpone:') || data.startsWith('med_postpone:')) {
    const rest = data.startsWith('med:postpone:')
      ? data.slice('med:postpone:'.length)
      : data.slice('med_postpone:'.length);
    const colonIdx = rest.indexOf(':');
    const medIdStr = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
    const scheduledTime = colonIdx === -1 ? '09:00' : rest.slice(colonIdx + 1) || '09:00';

    const target = new Date(Date.now() + 15 * 60_000);
    const targetTime = formatTargetTime(target, 'Europe/Berlin');

    const postponeKb: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Принял', callback_data: `med:take:${medIdStr}:${scheduledTime}` },
          { text: '⏭ Пропустить', callback_data: `med:skip:${medIdStr}:${scheduledTime}` },
        ],
      ],
    };
    await confirmCallback(callbackId, chatId, '⏳ Отложено на 15 мин');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, `⏳ Отложено на 15 мин (до ${targetTime})`),
      { replyMarkup: postponeKb },
    );
    return;
  }

  // 6. Отмена транзакции / обязательства
  if (
    data.startsWith('undo_liability:') ||
    data.startsWith('undo_tx:') ||
    data.startsWith('undo:transaction:') ||
    data.startsWith('undo:expense:')
  ) {
    if (data.startsWith('undo_liability:')) {
      const parts = data.split(':');
      const liabilityId = Number(parts[1]);
      const month = parts[2] || '';
      const txId = Number(parts[3] || 0);
      if (Number.isFinite(liabilityId) && month) {
        await rollbackLiabilityPayment(userId, {
          liabilityId,
          month,
          transactionId: Number.isFinite(txId) && txId > 0 ? txId : undefined,
        });
      }
    } else {
      const rawId = data.startsWith('undo_tx:')
        ? data.slice('undo_tx:'.length)
        : data.split(':')[2] || data.split(':')[1];
      const txId = Number(rawId);
      if (Number.isFinite(txId)) {
        await deleteTransaction(userId, txId);
      }
    }
    await answerCallback(callbackId, '🗑️ Запись отменена');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, '🗑️ Запись отменена и удалена.'),
      { replyMarkup: { inline_keyboard: [] } },
    );
    return;
  }

  // 7. Отмена заметки / инбокса
  if (
    data.startsWith('undo_note:') ||
    data.startsWith('undo:note:') ||
    data.startsWith('inbox_undo:')
  ) {
    const rawId = data.startsWith('undo_note:')
      ? data.slice('undo_note:'.length)
      : data.startsWith('inbox_undo:')
        ? data.slice('inbox_undo:'.length)
        : data.split(':')[2] || data.split(':')[1];
    const noteId = Number(rawId);
    if (Number.isFinite(noteId)) {
      await deleteNote(userId, noteId);
    }
    await confirmCallback(callbackId, chatId, '🗑️ Заметка удалена');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, '🗑️ Заметка отменена и удалена.'),
      { replyMarkup: { inline_keyboard: [] } },
    );
    return;
  }

  // 8. Отмена задачи
  if (
    data.startsWith('undo_task:') ||
    data.startsWith('undo:task:') ||
    data.startsWith('task_undo:')
  ) {
    const rawId = data.startsWith('undo_task:')
      ? data.slice('undo_task:'.length)
      : data.split(':')[2] || data.split(':')[1];
    const taskId = Number(rawId);
    if (Number.isFinite(taskId)) {
      await deleteTask(userId, taskId);
    }
    await confirmCallback(callbackId, chatId, '🗑️ Задача удалена');
    await trySafeEdit(
      chatId,
      messageId,
      appendStatusLine(originalText, '🗑️ Задача отменена и удалена.'),
      { replyMarkup: { inline_keyboard: [] } },
    );
    return;
  }

  // 9. Превращение инбокса в задачу: inbox_to_task:{noteId}
  if (data.startsWith('inbox_to_task:')) {
    const noteIdStr = data.slice('inbox_to_task:'.length);
    const noteId = Number(noteIdStr);
    let createdTaskId: number | null = null;
    if (Number.isFinite(noteId)) {
      try {
        const note = await getNote(userId, noteId);
        if (note) {
          const content = (note.cleanText || note.rawText || '').trim();
          const title = content.split('\n')[0]?.slice(0, 120) || 'Задача из инбокса';
          const task = await createTask(userId, {
            title,
            notes: content,
            status: 'todo',
          });
          await deleteNote(userId, noteId);
          createdTaskId = task.id;
        }
      } catch (err) {
        console.warn('Error converting inbox note to task:', err);
      }
    }
    await confirmCallback(callbackId, chatId, '🎯 Создана задача');
    const statusLine = createdTaskId !== null ? `🎯 Превращено в задачу #${createdTaskId}` : '🎯 Превращено в задачу';
    const keyboard: InlineKeyboardMarkup = createdTaskId !== null
      ? buildUndoWithAppKeyboard(`undo_task:${createdTaskId}`, `task_${createdTaskId}`)
      : { inline_keyboard: [] };
    await trySafeEdit(chatId, messageId, appendStatusLine(originalText, statusLine), {
      replyMarkup: keyboard,
    });
    return;
  }

  // 10. Оставить в инбоксе: inbox_to_inbox:{noteId}
  if (data.startsWith('inbox_to_inbox:')) {
    await confirmCallback(callbackId, chatId, '📥 Сохранено во входящих');
    await trySafeEdit(chatId, messageId, appendStatusLine(originalText, '📥 Оставлено во входящих'), {
      replyMarkup: { inline_keyboard: [] },
    });
    return;
  }

  // 11. Выполнение задачи из дашборда: dash_done:{tab}:{taskId}
  if (data.startsWith('dash_done:')) {
    const parts = data.split(':');
    const tab = parts[1] || 'status';
    const taskIdStr = parts[2] || '';
    const numId = Number(taskIdStr);
    if (Number.isFinite(numId)) {
      try {
        await completeTask(userId, numId);
      } catch (err) {
        console.warn('dash_done completeTask error:', err);
      }
    }
    await confirmCallback(callbackId, chatId, '✅ Задача выполнена!');
    try {
      const { text, isHtml, keyboard } = await renderDashboardContent(userId, tab);
      await trySafeEdit(chatId, messageId, text, { replyMarkup: keyboard, isHtml });
    } catch {
      await trySafeEdit(
        chatId,
        messageId,
        appendStatusLine(originalText, `✅ Задача #${taskIdStr} выполнена!`),
        { replyMarkup: { inline_keyboard: [] } },
      );
    }
    return;
  }

  // 12. Переключение табов дашборда: nav:{tab}
  if (data.startsWith('nav:')) {
    const tab = data.slice('nav:'.length);
    await answerCallback(callbackId);
    try {
      const { text, isHtml, keyboard } = await renderDashboardContent(userId, tab);
      await trySafeEdit(chatId, messageId, text, { replyMarkup: keyboard, isHtml });
    } catch (err) {
      console.warn('nav callback error:', err);
    }
    return;
  }

  await answerCallback(callbackId);
}
