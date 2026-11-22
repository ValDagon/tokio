/**
 * Smart Ingest & Media Handlers:
 *  - Голосовые сообщения (STT via Gemini)
 *  - Фото и чеки (Vision & OCR via Gemini)
 *  - Свободный текст (агентный шаг первым, далее офлайн-фоллбэк финансового парсера и классификация в задачи/инбокс)
 */

import { api } from 'sdk';
import { CUSTOM_INSTRUCTIONS_SLUG, formatAgentQueryWithReply } from '../lib/agent/constants.js';
import { LLM_ERROR_TEXT, runAgent, type AgentRunResult } from '../lib/agent/engine.js';
// [public-only] Лимит $2: гейты перед LLM-вызовами есть только в публичной редакции (4 места ниже).
import { checkSpendLimit, spendLimitExceededMessage } from '../lib/billing.js';
import { normalizeInboxMessage } from '../lib/classifier.js';
import { getChapter } from '../lib/dal/docs.js';
import {
  createLiability,
  deleteLiability,
  findAccountCandidates,
  getAccount,
  getLiability,
  isInsufficientFundsError,
  listAccounts,
  payLiability,
  withTransaction,
  type InsufficientFundsError,
} from '../lib/dal/finances.js';
import { createNote, deleteNote, getNote, updateNote } from '../lib/dal/notes.js';
import { createTask } from '../lib/dal/tasks.js';
import {
  kvDelete,
  kvGet,
  kvSet,
  kvSetIfAbsent,
  liabilityReviewKey,
  type LiabilityReviewDecision,
  type LiabilityReviewRecord,
} from '../lib/dal/misc.js';
import { getUser } from '../lib/dal/users.js';
import {
  liabilityReviewDueDate,
  parseLiabilityReviewCallback,
  type LiabilityReviewAction,
} from '../lib/digest.js';
import {
  BalanceAccountUnresolvedError,
  buildBalanceIntentFromSegments,
  executeFinancialIntent,
  matchExplicitAccount,
  parseFinancialIntent,
  resolveCurr,
  resolveCurrencyStrict,
  UnsupportedCurrencyError,
  type AppliedBalance,
  type ParsedFinancialIntent,
} from '../lib/financial-parser.js';
import { markdownToTelegramHtml } from '../lib/markdown.js';
import { tryTranscribe } from '../lib/stt.js';
import { modelOutageReply } from '../lib/summary.js';
import {
  markFailureRecovered,
  recordFailure,
  type FailureReason,
} from '../lib/evolution.js';
import { deferReplyNotice } from '../lib/reply_turn.js';
import { sha256Hex } from '../lib/vendor/crypto.js';
import type { AccountRow, NoteColumn, NoteRow, NoteSourceType } from '../lib/types.js';
import {
  formatCents,
  formatCentsWithSuffix,
  formatMoney,
  monthKey,
  nowIso,
  toCents,
  toIso,
  truncate,
} from '../lib/utils.js';
import {
  analyzeImageContent,
  buildVisionMeta,
  formatVisionInboxText,
  type VisionBalance,
  type VisionInvoice,
  type VisionResult,
} from '../lib/vision.js';
import { escapeAmpLtGt, safeAnswer, safeEdit } from './formatting.js';
import { startTurnProgress } from './progress.js';
import {
  buildAgentDeepLinkKeyboard,
  buildUndoWithAppKeyboard,
  getMainKeyboard,
  type AgentStepLike,
  type InlineKeyboardMarkup,
  type ReplyMarkup,
} from './keyboards.js';
import type { IngestContext } from './router.js';

/**
 * Хвост диагностики для журнала: текст ошибки, а не объект. Скраб и усечение —
 * на стороне журнала (`sanitizeFailureDetail`), здесь только извлечение.
 */
function errorDetail(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

/** Отказ списания по-человечески: что просили, сколько есть, почему не провели. */
function formatDebitRefusal(error: InsufficientFundsError, label = 'Расход'): string {
  const lines = [
    `⚠️ <b>${label} не проведён</b>`,
    `• «${escapeAmpLtGt(error.accountName)}» (${error.currency}): ` +
      `нужно ${formatMoney(error.requiredCents, error.currency)}, ` +
      `на счёте ${formatMoney(error.availableCents, error.currency)}.`,
  ];

  if (error.reason === 'settlement_short' && error.settlementAccountName && error.settlementCurrency) {
    lines.push(
      `• Добрать с «${escapeAmpLtGt(error.settlementAccountName)}» (${error.settlementCurrency}) не вышло: ` +
        `нужно ${formatMoney(error.settlementRequiredCents, error.settlementCurrency)}, ` +
        `на счёте ${formatMoney(error.settlementAvailableCents, error.settlementCurrency)}.`,
    );
  } else {
    lines.push('• Добрать неоткуда: у счёта нет расчётного субсчёта с деньгами.');
  }

  lines.push('<i>Минуса на счетах не бывает, поэтому запись не создана.</i>');
  lines.push(
    `<i>Если деньги на счёте действительно есть — сначала обнови баланс: «баланс ${escapeAmpLtGt(error.accountName)} 120 ${error.currency}».</i>`,
  );
  return lines.join('\n');
}

/** Заголовок отказа в роде операции: перевод отказывает не так, как расход. */
function refusalLabel(action: ParsedFinancialIntent['action']): string {
  if (action === 'transfer') return 'Перевод';
  if (action === 'exchange') return 'Обмен';
  if (action === 'liability_pay') return 'Платёж';
  return 'Расход';
}

export function hasTriggerVerbs(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /(?:оплатил|оплатила|погасил|погасила|заплатил|заплатила|потратил|потратила|списали|сняли|перев[её]л|перевела|купил|купила|расход|трат[аы]|плат[её]ж|взнос|закрыл|закрыла|долг|кредит)\b/i.test(
      lower,
    )
  );
}

export function isAgentTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.startsWith('/ask') ||
    lower.startsWith('/agent') ||
    lower.startsWith('/агент') ||
    lower.endsWith('?')
  );
}

/** Строит inline-клавиатуру отмены и перехода в Mini App для финансовой записи. */
function buildFinanceUndoMarkup(params: {
  isLiability?: boolean;
  liabilityId?: number;
  month?: string;
  transactionId?: number;
}): InlineKeyboardMarkup | undefined {
  if (params.isLiability && params.liabilityId && params.month) {
    return buildUndoWithAppKeyboard(
      `undo_liability:${params.liabilityId}:${params.month}:${params.transactionId ?? 0}`,
      'debts',
    );
  }
  if (params.transactionId) {
    return buildUndoWithAppKeyboard(`undo_tx:${params.transactionId}`, 'finances');
  }
  return undefined;
}

/** Подбирает клавиатуру ответа после успешного выполнения инструментов агентом. */
function buildAgentActionReplyMarkup(steps: ReadonlyArray<AgentStepLike>): ReplyMarkup {
  let undoMarkup: InlineKeyboardMarkup | undefined;

  const liabStep = steps.find((s) => s.action?.name === 'mark_liability_paid' && s.ok);
  if (liabStep) {
    const data = liabStep.data as
      | { liability_id?: number; month?: string; transaction_id?: number }
      | undefined;
    undoMarkup = buildFinanceUndoMarkup({
      isLiability: true,
      liabilityId: data?.liability_id,
      month: data?.month,
      transactionId: data?.transaction_id,
    });
  } else {
    // Любой успешный шаг, у которого в data есть transaction_id, получает
    // отмену: add_expense, add_income, add_transfer, add_exchange (id out-ноги —
    // deleteTransaction откатывает группу целиком).
    const txStep = steps.find((s) => {
      if (!s.ok) return false;
      const name = s.action?.name;
      if (name === 'undo_last_transaction' || name === 'delete_transaction') return false;
      const stepData = s.data as { transaction_id?: unknown; deleted?: unknown } | undefined;
      if (stepData?.deleted === true) return false;
      return typeof stepData?.transaction_id === 'number';
    });
    const txData = txStep?.data as { transaction_id?: number } | undefined;
    undoMarkup = buildFinanceUndoMarkup({ transactionId: txData?.transaction_id });
  }

  const deepLinkMarkup = buildAgentDeepLinkKeyboard(steps);
  return undoMarkup ?? deepLinkMarkup ?? getMainKeyboard();
}

async function tryAgentAutonomousStep(
  userId: number,
  chatId: number,
  userText: string,
  prefixQuote?: string,
  replyContext?: string,
): Promise<boolean> {
  const spend = await checkSpendLimit(userId);
  if (!spend.allowed) {
    return false;
  }

  const isQuestion =
    isAgentTrigger(userText) || (Boolean(replyContext) && !parseFinancialIntent(userText));
  const agentQuery = userText.replace(/^\/(?:ask|agent|агент)\s*/i, '').trim();
  const fullQuery = formatAgentQueryWithReply(agentQuery, replyContext);

  // Живая индикация: «печатает…» сразу, строка прогресса — только на медленном
  // ходе. Вся индикация внутри себя глушит сбои Bot API (handlers/progress.ts).
  const progress = startTurnProgress({ chatId, userId });
  await progress.begin();

  let agentRes: AgentRunResult;
  try {
    agentRes = await runAgent({ userId, text: fullQuery, onProgress: progress.onProgress });
  } catch (error) {
    // Ход упал, но сообщение ещё не потеряно: smartIngest после броска идёт в
    // детерминированные фолбэки и может ответить по существу. Заменять строку
    // ошибкой здесь нельзя — иначе честный ответ встанет рядом с «сбой модели».
    // Строку просто гасим: ход продолжается.
    await progress.finish();
    throw error;
  }

  try {
    // Сбой модели — не ответ по существу. Вопрос не должен умирать вместе с
    // провайдером: деньги, задачи и аптечка считаются из SQLite, модель для них
    // не нужна. Заглушка остаётся только прочим сообщениям — и то лишь если в
    // этом же ходе не ушёл детерминированный ответ (сводка, задача, заметка,
    // напоминание), чтобы извинение не вставало рядом с настоящим ответом.
    if (agentRes.stopReason === 'llm_error') {
      // Текст сбоя считается один раз: он же закрывает индикатор, когда ход
      // открыт не был (`deferReplyNotice` = false, см. lib/reply_turn.ts).
      const outageText = isQuestion
        ? await modelOutageReply(
            userId,
            [agentQuery || userText, replyContext].filter(Boolean).join(' '),
          )
        : LLM_ERROR_TEXT;

      if (isQuestion) {
        // Заглушка не встаёт рядом с настоящим ответом: пока ход открыт, она
        // откладывается до его конца, а индикатор просто исчезает.
        if (deferReplyNotice(chatId, outageText)) return true;
        if (await progress.fail(outageText)) return true;
        await safeAnswer(chatId, outageText, { replyMarkup: getMainKeyboard() });
        return true;
      }

      // Не вопрос: текст не теряем — он уходит в инбокс-фоллбэк ниже.
      deferReplyNotice(chatId, LLM_ERROR_TEXT);
      return false;
    }

    // Проверяем, выполнил ли агент инструмент успешно
    const executedSuccessTool = agentRes.steps.some((s) => s.action !== null && s.ok);

    // Отдаём ответ модели во всех случаях, когда она дала осмысленный ответ
    // (включая диалог, уточнение, подтверждение или объяснение отказа).
    // В инбокс проваливается только явное молчание (`empty_reply`) или `llm_error`.
    if (agentRes.reply.trim() && agentRes.stopReason !== 'empty_reply') {
      const body = markdownToTelegramHtml(agentRes.reply);
      const reply = prefixQuote ? `${prefixQuote}${body}` : body;
      const replyMarkup = executedSuccessTool
        ? buildAgentActionReplyMarkup(agentRes.steps)
        : getMainKeyboard();

      await safeAnswer(chatId, reply, { replyMarkup, isHtml: true });
      return true;
    }

    // Агент промолчал (`empty_reply`) — отдаём сообщение в инбокс-фоллбэк.
    return false;
  } finally {
    // Любой выход из хода гасит строку: успех, тишина или сбой внутри веток
    // (`modelOutageReply`, разметка ответа). `finish()` идемпотентен, а после
    // `fail()` уже закрыт.
    await progress.finish();
  }
}

export async function smartIngest(ctx: IngestContext): Promise<void> {
  const { userId, chatId, text, forwarded, prefixQuote, replyContext } = ctx;
  const userText = text.trim();
  if (!userText) return;

  // 1. Агентный шаг (Agent-First): 100% прямых сообщений идут сразу в модель с полным набором инструментов.
  if (!forwarded) {
    try {
      const handled = await tryAgentAutonomousStep(
        userId,
        chatId,
        userText,
        prefixQuote,
        replyContext,
      );
      if (handled) return;
    } catch (err) {
      console.warn('smartIngest agent step error:', err);
      await recordFailure(userId, {
        stage: 'agent',
        media: 'text',
        reason: 'unhandled',
        detail: errorDetail(err),
      });
    }
  }

  // 2. Офлайн-фоллбэк финансового парсера (только для прямых сообщений, если агент промолчал или недоступен)
  if (!forwarded) {
    const finIntent = parseFinancialIntent(userText);
    if (finIntent) {
      try {
        const finRes = await executeFinancialIntent(userId, finIntent, userText);
        if (finRes) {
          const replyMarkup = buildFinanceUndoMarkup({
            isLiability: finRes.action === 'liability_pay',
            liabilityId: finRes.liabilityId,
            month: finRes.month,
            transactionId: finRes.transactionId ?? undefined,
          });

          const reply = prefixQuote ? `${prefixQuote}${finRes.replyText}` : finRes.replyText;
          await safeAnswer(chatId, reply, {
            replyMarkup,
            isHtml: true,
          });
          return;
        }
      } catch (err) {
        // Отказ по правилу — ответ пользователю, а не повод уйти в инбокс.
        if (isInsufficientFundsError(err)) {
          const refusal = formatDebitRefusal(err, refusalLabel(finIntent.action));
          await safeAnswer(chatId, prefixQuote ? `${prefixQuote}${refusal}` : refusal, {
            replyMarkup: getMainKeyboard(),
            isHtml: true,
          });
          return;
        }
        console.warn('smartIngest financial error:', err);
        // Ожидаемый отказ по средствам сюда не доходит: это не дефект.
        await recordFailure(userId, {
          stage: 'ingest',
          media: 'text',
          reason: 'storage_failed',
          detail: errorDetail(err),
        });
      }
    }
  }

  // 2.5. Проверка лимита расходов перед вызовом нормализатора LLM
  const spend = await checkSpendLimit(userId);
  if (!spend.allowed) {
    const user = await getUser(userId);
    const note = await createNote(userId, userText, {
      column: 'raw',
      sourceType: ctx.source ?? 'text',
      metadata: { title: userText.slice(0, 60), tags: [], category: 'raw' },
    });
    const reply =
      `📝 <b>Заметка сохранена в инбокс (без AI):</b>\n` +
      `<i>${escapeAmpLtGt(truncate(userText, 300))}</i>\n\n` +
      `${spendLimitExceededMessage(user?.language)}`;
    await safeAnswer(chatId, reply, {
      replyMarkup: {
        inline_keyboard: [
          [{ text: '🗑️ Отменить', callback_data: `undo_note:${note.id}` }],
        ],
      },
      isHtml: true,
    });
    return;
  }

  // 3. Классификация входящего сообщения через нормализатор / эвристики
  const norm = await normalizeInboxMessage(userText, { userId });

  const lower = userText.toLowerCase();
  const isEvent =
    lower.includes('встреча') ||
    lower.includes('созвон') ||
    lower.includes('событие') ||
    lower.includes('мероприятие');
  const isTask =
    norm.category === 'task' ||
    norm.actionable ||
    lower.startsWith('напомни') ||
    lower.startsWith('задача:') ||
    lower.startsWith('дело:') ||
    lower.startsWith('сделать:');

  // 4. Сохранение как задачи или события
  if (isTask) {
    const itemType = isEvent ? 'event' : 'task';
    let dueAt: string | null = null;
    if (norm.extractedMeta?.due_date) {
      try {
        dueAt = new Date(norm.extractedMeta.due_date).toISOString();
      } catch {
        dueAt = null;
      }
    }

    const task = await createTask(userId, {
      title: norm.cleanTitle || userText.slice(0, 80),
      notes: norm.cleanText !== norm.cleanTitle ? norm.cleanText : null,
      status: 'todo',
      itemType,
      dueAt,
      sourceText: userText,
    });

    const icon = isEvent ? '📅' : '🎯';
    const dueInfo = dueAt ? `\n• Срок: ${dueAt.slice(0, 10)}` : '';
    const taskReply =
      `${icon} <b>${isEvent ? 'Событие' : 'Задача'} сохранена:</b>\n` +
      `• <b>${escapeAmpLtGt(task.title)}</b>${dueInfo}`;

    const reply = prefixQuote ? `${prefixQuote}${taskReply}` : taskReply;

    await safeAnswer(chatId, reply, {
      replyMarkup: buildUndoWithAppKeyboard(`undo_task:${task.id}`, `task_${task.id}`),
      isHtml: true,
    });
    return;
  }

  // 5. Заметка / мысль в инбокс
  const column: NoteColumn = norm.category === 'idea' ? 'idea' : 'raw';
  const note = await createNote(userId, norm.cleanText || userText, {
    column,
    sourceType: ctx.source ?? 'text',
    metadata: {
      title: norm.cleanTitle,
      tags: norm.tags,
      category: norm.category,
      extracted_meta: norm.extractedMeta,
    },
  });

  const catLabel = norm.category === 'idea' ? '💡 Идея' : '📝 Заметка';
  const cleanTitle = (norm.cleanTitle || '').trim();
  const cleanBody = (norm.cleanText || userText || '').trim();

  const isDuplicate =
    !cleanTitle ||
    cleanTitle.toLowerCase() === cleanBody.toLowerCase() ||
    cleanBody.toLowerCase().startsWith(cleanTitle.toLowerCase()) ||
    cleanTitle.toLowerCase().startsWith(cleanBody.toLowerCase());

  const noteReply =
    `${catLabel} <b>сохранена в инбокс:</b>\n\n` +
    (isDuplicate
      ? `<i>${escapeAmpLtGt(truncate(cleanBody, 300))}</i>`
      : `<b>${escapeAmpLtGt(cleanTitle)}</b>\n<i>${escapeAmpLtGt(truncate(cleanBody, 300))}</i>`);

  const reply = prefixQuote ? `${prefixQuote}${noteReply}` : noteReply;

  await safeAnswer(chatId, reply, {
    replyMarkup: buildUndoWithAppKeyboard(`undo_note:${note.id}`, `note_${note.id}`),
    isHtml: true,
  });
}

/**
 * Обработка голосового сообщения:
 *  - скачивание файла из Telegram
 *  - транскрипция через Gemini STT
 *  - единая маршрутизация через smartIngest (financial fast-path / agent / task / note)
 *
 * Любой из трёх отказов (скачивание, пустые байты, пустая расшифровка) не
 * теряет входящее: см. `runVoicePipeline` (MU-1).
 */
export async function handleVoiceMessage(
  userId: number,
  chatId: number,
  voice: { file_id: string; duration?: number },
  messageId?: number,
  replyContext?: string,
): Promise<void> {
  await runVoicePipeline({
    userId,
    chatId,
    fileId: voice.file_id,
    durationSec: voice.duration,
    messageId,
    ...(replyContext ? { replyContext } : {}),
  });
}

// ---------------------------------------------------------------------------
// Восстановление голоса (MU-1)
// ---------------------------------------------------------------------------

/** Нормализованные причины отказа: конечный набор кодов, а не текст ошибки. */
export type VoiceFailureReason = 'download' | 'empty_bytes' | 'empty_transcript';

/** Ключ метаданных аварийной заметки — контракт для повтора и журнала (MU-3). */
export const VOICE_RECOVERY_KIND = 'voice_recovery';

/**
 * Что сохранено в аварийной заметке. `file_id` и `source_message_id` — исходное
 * входящее: без них повтор невозможен, поэтому они лежат и в колонках `notes`,
 * и в метаданных (журналу нужен один объект, а не склейка двух источников).
 */
export interface VoiceRecoveryMeta {
  kind: typeof VOICE_RECOVERY_KIND;
  reason: VoiceFailureReason;
  file_id: string;
  duration_sec?: number;
  source_message_id?: number | null;
  /**
   * Терминальная причина для журнала (`transcription_failed` при упавшем STT
   * против `empty_transcription` при пустом ответе). Хранится, чтобы успешный
   * повтор снял recovery ровно с того кластера, который был записан.
   */
  journal_reason?: FailureReason;
  /** Сколько раз пытались распознать: 1 — первый отказ, дальше растёт. */
  attempts: number;
  updated_at: string;
  /**
   * Метка «повтор уже идёт». Второе нажатие той же кнопки не должно провести
   * распознавание (и возможную денежную операцию) дважды.
   */
  claimed_at?: string;
}

const VOICE_REASONS: readonly VoiceFailureReason[] = [
  'download',
  'empty_bytes',
  'empty_transcript',
];

/** Причина отказа по-человечески — для текста заметки. */
const VOICE_REASON_TEXT: Record<VoiceFailureReason, string> = {
  download: 'файл не скачался',
  empty_bytes: 'файл пришёл пустым',
  empty_transcript: 'речь не распозналась',
};

/** Первая строка ответа — прежний честный текст сбоя, без изменений. */
const VOICE_FAILURE_REPLY: Record<VoiceFailureReason, string> = {
  download: '⚠️ Не удалось скачать голосовое сообщение.',
  empty_bytes:
    'Не удалось разобрать речь. Попробуй наговорить ещё раз чуть ближе к микрофону.',
  empty_transcript:
    'Не удалось разобрать речь. Попробуй наговорить ещё раз чуть ближе к микрофону.',
};

/** Что осталось в инбоксе и что делать дальше — одной строкой. */
const VOICE_RECOVERY_HINT =
  '\n\n💾 Входящее сохранено в инбокс. Повторить распознавание можно кнопкой ниже.';

/**
 * Пользовательская причина → код журнала. Два разных отказа (STT-API упал и
 * STT вернул пустоту) дают один текст пользователю, но разные кластеры: иначе
 * повторяемость одного из них была бы не видна.
 */
const VOICE_JOURNAL_REASON: Record<VoiceFailureReason, FailureReason> = {
  download: 'download_failed',
  empty_bytes: 'empty_bytes',
  empty_transcript: 'empty_transcription',
};

function isVoiceReason(value: unknown): value is VoiceFailureReason {
  return typeof value === 'string' && (VOICE_REASONS as readonly string[]).includes(value);
}

/**
 * Метаданные повтора из заметки. `null` — это не аварийная заметка голоса
 * (обычная заметка, уже обработанная заглушка или чужая запись).
 */
export function readVoiceRecovery(note: NoteRow): VoiceRecoveryMeta | null {
  const meta = note.metadata as Record<string, unknown> | null | undefined;
  const raw = meta?.[VOICE_RECOVERY_KIND];
  if (typeof raw !== 'object' || raw === null) return null;

  const rec = raw as Record<string, unknown>;
  if (!isVoiceReason(rec.reason)) return null;

  const fileId =
    typeof rec.file_id === 'string' && rec.file_id.trim() ? rec.file_id : note.fileId;
  if (typeof fileId !== 'string' || !fileId.trim()) return null;

  const attempts = typeof rec.attempts === 'number' && rec.attempts > 0 ? rec.attempts : 1;
  const meta2: VoiceRecoveryMeta = {
    kind: VOICE_RECOVERY_KIND,
    reason: rec.reason,
    file_id: fileId,
    attempts,
    updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : nowIso(),
  };
  if (typeof rec.duration_sec === 'number') meta2.duration_sec = rec.duration_sec;
  if (typeof rec.claimed_at === 'string') meta2.claimed_at = rec.claimed_at;
  if (typeof rec.journal_reason === 'string' && rec.journal_reason) {
    meta2.journal_reason = rec.journal_reason as FailureReason;
  }
  if (typeof rec.source_message_id === 'number' || rec.source_message_id === null) {
    meta2.source_message_id = rec.source_message_id as number | null;
  } else if (typeof note.sourceMessageId === 'number') {
    meta2.source_message_id = note.sourceMessageId;
  }
  return meta2;
}

/** Сколько держим метку «в работе», если изолят умер посреди повтора. */
const RECOVERY_CLAIM_TTL_MS = 5 * 60_000;

/** Метка ещё свежая — значит повтор действительно идёт прямо сейчас. */
function isClaimFresh(claimedAt: string): boolean {
  const ts = Date.parse(claimedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < RECOVERY_CLAIM_TTL_MS;
}

/**
 * Захват заглушки под повтор.
 *
 * Двойное нажатие кнопки — два callback'а: без метки оба дошли бы до
 * `smartIngest`, и голосовое «перевёл N» провело бы операцию дважды. Метка
 * ставится до скачивания/распознавания и снимается сама: при неудаче её
 * перезаписывает `saveVoiceRecoveryNote`, при успехе заметка уходит в корзину.
 *
 * Это не транзакционный CAS (в DAL нет «занять, если свободно»): защита
 * рассчитана на последовательную доставку апдейтов и протухает через
 * `RECOVERY_CLAIM_TTL_MS`, чтобы упавший посреди повтора изолят не запер заметку
 * навсегда.
 */
export async function claimVoiceRecovery(
  userId: number,
  noteId: number,
): Promise<VoiceRecoveryMeta | null> {
  const note = await getNote(userId, noteId);
  const meta = note ? readVoiceRecovery(note) : null;
  if (!note || !meta) return null;
  if (meta.claimed_at && isClaimFresh(meta.claimed_at)) return null;

  const claimed: VoiceRecoveryMeta = { ...meta, claimed_at: nowIso() };
  const updated = await updateNote(userId, noteId, {
    metadata: { ...note.metadata, [VOICE_RECOVERY_KIND]: claimed },
  });
  return updated ? claimed : null;
}

/** Текст заметки: что произошло и что с этим делать (без обещаний). */
function voiceRecoveryText(
  reason: VoiceFailureReason,
  durationSec: number | undefined,
  attempts: number,
): string {
  const duration =
    typeof durationSec === 'number' && durationSec > 0
      ? ` (${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')})`
      : '';
  const attempt = attempts > 1 ? `, попытка ${attempts}` : '';
  return `🎙 Голосовое${duration}: не расшифровано — ${VOICE_REASON_TEXT[reason]}${attempt}`;
}

interface VoiceRecoveryNoteRef {
  id: number;
  meta: VoiceRecoveryMeta;
}

/**
 * Заметка об отказе: создаётся один раз, дальше обновляется та же.
 *
 * Возврат `id` нужен, чтобы кнопка повтора указывала на конкретную запись.
 * Новая заметка вместо обновления — только если прежнюю уже убрали: лучше
 * лишняя строка, чем потерянное входящее.
 */
async function saveVoiceRecoveryNote(params: {
  userId: number;
  fileId: string;
  durationSec?: number;
  messageId?: number;
  reason: VoiceFailureReason;
  /** Терминальная причина этого отказа для журнала. */
  journalReason?: FailureReason;
  previous?: VoiceRecoveryNoteRef | null;
}): Promise<VoiceRecoveryNoteRef> {
  const attempts = (params.previous?.meta.attempts ?? 0) + 1;
  const meta: VoiceRecoveryMeta = {
    kind: VOICE_RECOVERY_KIND,
    reason: params.reason,
    file_id: params.fileId,
    journal_reason: params.journalReason ?? VOICE_JOURNAL_REASON[params.reason],
    attempts,
    source_message_id: params.messageId ?? params.previous?.meta.source_message_id ?? null,
    updated_at: nowIso(),
  };
  if (typeof params.durationSec === 'number') meta.duration_sec = params.durationSec;

  const text = voiceRecoveryText(params.reason, params.durationSec, attempts);

  const previous = params.previous;
  if (previous) {
    const current = await getNote(params.userId, previous.id);
    if (current) {
      const updated = await updateNote(params.userId, previous.id, {
        rawText: text,
        metadata: { ...current.metadata, [VOICE_RECOVERY_KIND]: meta },
      });
      if (updated) return { id: updated.id, meta };
    }
  }

  const metadata: Record<string, unknown> = { [VOICE_RECOVERY_KIND]: meta };
  if (typeof params.durationSec === 'number') metadata.durationSec = params.durationSec;

  const created = await createNote(params.userId, text, {
    column: 'raw',
    sourceType: 'voice',
    fileId: params.fileId,
    sourceMessageId: params.messageId ?? null,
    metadata,
  });
  return { id: created.id, meta };
}

interface VoicePipelineParams {
  userId: number;
  chatId: number;
  fileId: string;
  durationSec?: number;
  messageId?: number;
  /** Контекст сообщения, на которое отвечает пользователь (`quote` / `reply_to_message`). */
  replyContext?: string;
  /** Повтор: заглушка, которую надо обновить, а после успеха — убрать в корзину. */
  recoveryNote?: VoiceRecoveryNoteRef | null;
}

/**
 * Единый путь голоса: скачать → распознать → `smartIngest`.
 *
 * Отказ не выходит из функции молча: заметка с `file_id` остаётся в инбоксе,
 * а в чат уходит причина и кнопка `retry_voice:<noteId>`. Таймера нет — повтор
 * это следующее касание (кнопка).
 */
async function runVoicePipeline(params: VoicePipelineParams): Promise<void> {
  const { userId, chatId, fileId, durationSec, messageId, replyContext, recoveryNote } = params;

  const fail = async (
    reason: VoiceFailureReason,
    detail?: unknown,
    journalReason: FailureReason = VOICE_JOURNAL_REASON[reason],
  ): Promise<void> => {
    if (detail !== undefined) console.warn(`voice: ${reason}`, detail);
    // Одна сигнатура за событие: запись идёт до сохранения заметки, чтобы отказ
    // хранилища не унёс с собой единственное свидетельство сбоя.
    await recordFailure(userId, {
      stage: 'ingest',
      media: 'voice',
      reason: journalReason,
      detail: errorDetail(detail),
    });
    const note = await saveVoiceRecoveryNote({
      userId,
      fileId,
      durationSec,
      messageId,
      reason,
      journalReason,
      previous: recoveryNote ?? null,
    });
    await safeAnswer(chatId, `${VOICE_FAILURE_REPLY[reason]}${VOICE_RECOVERY_HINT}`, {
      replyMarkup: {
        inline_keyboard: [
          [{ text: '🔁 Повторить', callback_data: `retry_voice:${note.id}` }],
        ],
      },
      isHtml: true,
    });
  };

  await api.sendChatAction({ chat_id: chatId, action: 'typing' });

  const spend = await checkSpendLimit(userId);
  if (!spend.allowed) {
    const user = await getUser(userId);
    const locale = user?.language ?? 'ru';
    await safeAnswer(chatId, spendLimitExceededMessage(locale), { replyMarkup: getMainKeyboard(locale) });
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await api.getFileContent(fileId);
  } catch (err) {
    await fail('download', err);
    return;
  }

  if (!bytes || bytes.length === 0) {
    await fail('empty_bytes');
    return;
  }

  const transcribed = await tryTranscribe(bytes, {
    userId,
    filename: 'voice.ogg',
  });

  // Два разных отказа дают один текст пользователю, но разные кластеры:
  // упавший STT-запрос и пустой ответ модели — не одно и то же.
  if (transcribed === null) {
    await fail('empty_transcript', undefined, 'transcription_failed');
    return;
  }

  const text = (transcribed.text ?? '').trim();
  if (!text) {
    await fail('empty_transcript');
    return;
  }

  const escapedPreview = escapeAmpLtGt(text);
  const prefixQuote = `<blockquote expandable>🗣 <i>${escapedPreview}</i></blockquote>\n\n`;

  // Единая маршрутизация голосового сообщения
  await smartIngest({
    userId,
    chatId,
    text,
    forwarded: false,
    messageId,
    prefixQuote,
    ...(replyContext ? { replyContext } : {}),
    source: 'voice',
  });

  // Результат уже сохранён: только теперь аварийная заглушка уходит в корзину.
  if (recoveryNote) {
    // Восстановление относится ровно к тому кластеру, который был записан при
    // отказе: повтор снимает recovery один раз, а не на каждую попытку.
    await markFailureRecovered(userId, {
      stage: 'ingest',
      media: 'voice',
      reason: recoveryNote.meta.journal_reason ?? VOICE_JOURNAL_REASON[recoveryNote.meta.reason],
    });
    await deleteNote(userId, recoveryNote.id);
  }
}

/**
 * Повтор распознавания по сохранённому `file_id` (`retry_voice:<noteId>`).
 *
 * Владелец заметки проверяется вызывающей стороной (`getNote` в роутере):
 * сюда попадает только своя аварийная запись.
 */
export async function retryVoiceRecovery(params: {
  userId: number;
  chatId: number;
  noteId: number;
  meta: VoiceRecoveryMeta;
}): Promise<void> {
  await runVoicePipeline({
    userId: params.userId,
    chatId: params.chatId,
    fileId: params.meta.file_id,
    durationSec: params.meta.duration_sec,
    messageId: params.meta.source_message_id ?? undefined,
    recoveryNote: { id: params.noteId, meta: params.meta },
  });
}

/**
 * Дополнительные данные апдейта, которые нужны фото-пайплайну, но не видны в
 * самом файле: момент наблюдения остатка и MIME документа.
 */
export interface PhotoMessageOptions {
  /** `message.date` — запасной момент наблюдения остатка. */
  messageDate?: number;
  /** `message.forward_date` — исходный момент пересланного снимка. */
  forwardDate?: number;
  /** MIME документа: `image/png` у скриншота, присланного файлом. */
  mimeType?: string;
  /** Тип источника заметки: фото или документ. */
  sourceType?: NoteSourceType;
  /** Контекст сообщения, на которое отвечает пользователь (`quote` / `reply_to_message`). */
  replyContext?: string;
}

/**
 * Обработка фотографий и чеков:
 *  - скачивание фото из Telegram
 *  - если есть подпись — единая маршрутизация через financial fast-path / agent
 *  - распознавание остатка / счёта на оплату / чека / списка через Gemini Vision
 *  - остаток на счетах: обновление баланса (состояние, а не операция)
 *  - счёт на оплату: обязательство, а не расход
 *  - если чек с суммой: проведение транзакции + [🗑️ Отменить]
 *  - иначе: сохранение в инбокс заметок + [🗑️ Отменить]
 *
 * Ни скачивание, ни распознавание, ни проведение чека не заканчиваются молча:
 * см. `runPhotoPipeline` (MU-2).
 */
export async function handlePhotoMessage(
  userId: number,
  chatId: number,
  photos: Array<{ file_id: string; width: number; height: number }>,
  caption?: string,
  messageId?: number,
  forwarded = false,
  options: PhotoMessageOptions = {},
): Promise<void> {
  const bestPhoto = photos[photos.length - 1];
  await runPhotoPipeline({
    userId,
    chatId,
    fileId: bestPhoto?.file_id ?? null,
    caption,
    messageId,
    forwarded,
    messageDate: options.messageDate,
    forwardDate: options.forwardDate,
    mimeType: options.mimeType,
    sourceType: options.sourceType,
    replyContext: options.replyContext,
  });
}

/** Документ, который Telegram прислал файлом, а не фото. */
export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * Документ из чата.
 *
 * Картинка проходит тот же путь, что фото: скриншот банка, присланный файлом,
 * обязан обновить остаток, а не лечь заметкой. Всё остальное (PDF, архивы,
 * книги) декодировать нечем — такой файл сохраняется в инбокс как есть, и об
 * этом говорится прямо. Молча терять вложение нельзя.
 */
export async function handleDocumentMessage(
  userId: number,
  chatId: number,
  document: TelegramDocument,
  caption?: string,
  messageId?: number,
  forwarded = false,
  options: PhotoMessageOptions = {},
): Promise<void> {
  const mime = String(document.mime_type ?? '').trim().toLowerCase();

  if (mime.startsWith('image/')) {
    await runPhotoPipeline({
      userId,
      chatId,
      fileId: document.file_id,
      caption,
      messageId,
      forwarded,
      messageDate: options.messageDate,
      forwardDate: options.forwardDate,
      mimeType: mime,
      sourceType: 'document',
      replyContext: options.replyContext,
    });
    return;
  }

  // Декодера нет: PDF в vision не отправляем — модель увидит мусор, а файл
  // будет выглядеть обработанным. Сохраняем как вложение с причиной.
  const fileName = String(document.file_name ?? '').trim() || 'файл';
  const typeLabel = mime || 'неизвестный тип';
  const noteText = caption?.trim()
    ? `📎 Документ: ${fileName} (${typeLabel})\nПодпись: ${caption.trim()}`
    : `📎 Документ: ${fileName} (${typeLabel})`;

  await createNote(userId, noteText, {
    column: 'raw',
    sourceType: 'document',
    fileId: document.file_id,
    sourceMessageId: messageId ?? null,
    metadata: {
      kind: 'document_unsupported',
      mime_type: mime || null,
      file_name: fileName,
      file_size: document.file_size ?? null,
      caption: caption?.trim() || null,
      at: nowIso(),
    },
  });

  await safeAnswer(
    chatId,
    `📎 <b>Документ сохранён в инбокс:</b>\n` +
      `• ${escapeAmpLtGt(fileName)} (${escapeAmpLtGt(typeLabel)})\n\n` +
      `<i>PDF, архивы и книги я не читаю: разбирать их нечем. ` +
      `Если внутри счёт или остаток на карте — пришлите скриншотом.</i>`,
    { replyMarkup: getMainKeyboard(), isHtml: true },
  );
}

// ---------------------------------------------------------------------------
// Восстановление фото и чека (MU-2)
// ---------------------------------------------------------------------------

/**
 * Нормализованные причины отказа фото: конечный набор кодов, а не текст ошибки.
 *
 * Отказа проведения чека здесь намеренно нет: это стадия **после** возможной
 * финансовой записи, а её повтор мог бы списать деньги второй раз. Такой отказ
 * остаётся в metadata (`receipt_failure`) и проговаривается пользователю, но
 * кнопки повтора не получает.
 */
export type PhotoFailureReason = 'download' | 'vision';

/** Ключ метаданных аварийной заметки — контракт для повтора и журнала (MU-3). */
export const PHOTO_RECOVERY_KIND = 'photo_recovery';

/** Ключ метаданных отказа проведения распознанного чека. */
export const RECEIPT_FAILURE_KIND = 'receipt_failure';

/**
 * Ключ метаданных «подпись пыталась провести операцию, результат неизвестен».
 *
 * Отдельно от `receipt_failure`: там виноват чек, здесь — финансовая попытка из
 * подписи. Общее одно: повтор такой заметки не предлагается.
 */
export const FINANCE_UNCONFIRMED_KIND = 'finance_unconfirmed';

/**
 * Что сохранено в аварийной заметке. `file_id` и `source_message_id` — исходное
 * входящее, `caption` — то, что пользователь написал к фото. Без них повтор и
 * журнал потеряли бы половину сырья.
 */
export interface PhotoRecoveryMeta {
  kind: typeof PHOTO_RECOVERY_KIND;
  reason: PhotoFailureReason;
  file_id: string;
  caption?: string;
  source_message_id?: number | null;
  /** Причины Vision: та же диагностика, что ушла пользователю. */
  errors?: string[];
  /** Сколько раз пытались распознать: 1 — первый отказ, дальше растёт. */
  attempts: number;
  updated_at: string;
  /**
   * Метка «повтор уже идёт». Второе нажатие той же кнопки не должно провести
   * распознавание (и возможную операцию) дважды.
   */
  claimed_at?: string;
}

const PHOTO_REASONS: readonly PhotoFailureReason[] = ['download', 'vision'];

/** Причина отказа по-человечески — для текста заметки. */
const PHOTO_REASON_TEXT: Record<PhotoFailureReason, string> = {
  download: 'файл не скачался',
  vision: 'изображение не распозналось',
};

/** Первая строка ответа — честный текст сбоя. */
const PHOTO_FAILURE_REPLY: Record<PhotoFailureReason, string> = {
  download: '⚠️ Не удалось загрузить фото.',
  vision: '⚠️ Не удалось распознать изображение.',
};

/** Что осталось в инбоксе и что делать дальше — одной строкой. */
const PHOTO_RECOVERY_HINT =
  '\n\n💾 Фото и подпись сохранены в инбокс. Повторить распознавание можно кнопкой ниже.';

/**
 * Ответ на повтор, который распознал чек: проведение не повторяется, поэтому
 * об этом надо сказать прямо, а не показывать «сохранено» без оговорки.
 */
const RECEIPT_REPLAY_NOT_BOOKED =
  '🧾 Чек распознан, но автоматически не проведён: повтор ничего не списывает.\n' +
  'Записать расход можно сообщением «потратил 42,75 eur».\n\n';

/**
 * Подпись уже пыталась провести операцию, и результат неизвестен.
 *
 * Здесь нельзя обещать ни успех, ни отказ: повторять денежный шаг вслепую хуже,
 * чем оставить одну несохранённую трату, поэтому второй проход закрыт, а
 * пользователь видит сумму и честную формулировку.
 */
function captionWriteUnconfirmedText(amount: number, currency: string, reason: string): string {
  const sum =
    Number.isFinite(amount) && amount > 0
      ? `<b>${formatCents(toCents(amount))} ${escapeAmpLtGt(currency)}</b>`
      : 'операция из подписи';
  return (
    `⚠️ <b>Не удалось подтвердить запись</b>\n` +
    `• ${sum}: результат неизвестен (${escapeAmpLtGt(truncate(reason, 120))}).\n` +
    `<i>Распознанный чек автоматически не проведён, чтобы не списать дважды. ` +
    `Проверь баланс и, если расхода в книге нет, запиши его сам.</i>\n\n`
  );
}

/** Отказ проведения чека: сумма известна, а результат записи — нет. */
function receiptFailureText(total: number, currency: string, reason: string): string {
  return (
    `⚠️ <b>Чек распознан, но провести его не удалось</b>\n` +
    `• Сумма: <b>${formatCents(toCents(total))} ${escapeAmpLtGt(currency)}</b>\n` +
    `• Причина: ${escapeAmpLtGt(truncate(reason, 120))}\n` +
    `<i>Автоматически повторять нельзя: запись могла сохраниться. ` +
    `Проверь баланс и, если расхода в книге нет, запиши его сам.</i>\n\n`
  );
}

function isPhotoReason(value: unknown): value is PhotoFailureReason {
  return typeof value === 'string' && (PHOTO_REASONS as readonly string[]).includes(value);
}

/**
 * Метаданные повтора из заметки. `null` — это не аварийная заметка фото
 * (обычная заметка, уже обработанная заглушка, заметка с отказом проведения
 * чека или чужая запись).
 */
export function readPhotoRecovery(note: NoteRow): PhotoRecoveryMeta | null {
  const meta = note.metadata as Record<string, unknown> | null | undefined;
  const raw = meta?.[PHOTO_RECOVERY_KIND];
  if (typeof raw !== 'object' || raw === null) return null;

  const rec = raw as Record<string, unknown>;
  if (!isPhotoReason(rec.reason)) return null;

  const fileId =
    typeof rec.file_id === 'string' && rec.file_id.trim() ? rec.file_id : note.fileId;
  if (typeof fileId !== 'string' || !fileId.trim()) return null;

  const attempts = typeof rec.attempts === 'number' && rec.attempts > 0 ? rec.attempts : 1;
  const out: PhotoRecoveryMeta = {
    kind: PHOTO_RECOVERY_KIND,
    reason: rec.reason,
    file_id: fileId,
    attempts,
    updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : nowIso(),
  };

  if (typeof rec.caption === 'string' && rec.caption.trim()) {
    out.caption = rec.caption.trim();
  } else if (typeof meta?.caption === 'string' && meta.caption.trim()) {
    out.caption = meta.caption.trim();
  }

  if (Array.isArray(rec.errors)) {
    const errors = rec.errors.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    );
    if (errors.length > 0) out.errors = errors.slice(0, 5);
  }

  if (typeof rec.claimed_at === 'string') out.claimed_at = rec.claimed_at;
  if (typeof rec.source_message_id === 'number' || rec.source_message_id === null) {
    out.source_message_id = rec.source_message_id as number | null;
  } else if (typeof note.sourceMessageId === 'number') {
    out.source_message_id = note.sourceMessageId;
  }
  return out;
}

/**
 * Захват заглушки под повтор (та же дисциплина, что у голоса).
 *
 * Владелец проверяется здесь: `getNote(userId, …)` вернёт `null` для чужой
 * заметки, поэтому обработка не запускается и содержимое не раскрывается.
 * Метка протухает сама, чтобы упавший посреди повтора изолят не запер заметку.
 */
export async function claimPhotoRecovery(
  userId: number,
  noteId: number,
): Promise<PhotoRecoveryMeta | null> {
  const note = await getNote(userId, noteId);
  const meta = note ? readPhotoRecovery(note) : null;
  if (!note || !meta) return null;
  if (meta.claimed_at && isClaimFresh(meta.claimed_at)) return null;

  const claimed: PhotoRecoveryMeta = { ...meta, claimed_at: nowIso() };
  const updated = await updateNote(userId, noteId, {
    metadata: { ...note.metadata, [PHOTO_RECOVERY_KIND]: claimed },
  });
  return updated ? claimed : null;
}

/** Текст заметки: что произошло и что с этим делать (без обещаний). */
function photoRecoveryText(
  reason: PhotoFailureReason,
  caption: string,
  attempts: number,
): string {
  const attempt = attempts > 1 ? `, попытка ${attempts}` : '';
  const head = `📸 Фото: не распознано — ${PHOTO_REASON_TEXT[reason]}${attempt}`;
  return caption ? `${head}\nПодпись: ${caption}` : head;
}

interface PhotoRecoveryNoteRef {
  id: number;
  meta: PhotoRecoveryMeta;
}

/**
 * Заметка об отказе: создаётся один раз, дальше обновляется та же.
 *
 * Возврат `id` нужен, чтобы кнопка повтора указывала на конкретную запись.
 * Новая заметка вместо обновления — только если прежнюю уже убрали: лучше
 * лишняя строка, чем потерянное входящее.
 */
async function savePhotoRecoveryNote(params: {
  userId: number;
  fileId: string;
  caption?: string;
  messageId?: number;
  reason: PhotoFailureReason;
  errors?: string[];
  /** Разметка Vision (`isFallback`, `errors`, `kind`) — если распознавание было. */
  metaExtra?: Record<string, unknown>;
  /** Текст заметки вместо стандартного «не распознано» (например, «счёт не сопоставлен»). */
  textOverride?: string;
  /** Тип источника: фото-сообщение или документ с картинкой. */
  sourceType?: NoteSourceType;
  previous?: PhotoRecoveryNoteRef | null;
}): Promise<PhotoRecoveryNoteRef> {
  const attempts = (params.previous?.meta.attempts ?? 0) + 1;
  const caption = (params.caption || '').trim();
  const meta: PhotoRecoveryMeta = {
    kind: PHOTO_RECOVERY_KIND,
    reason: params.reason,
    file_id: params.fileId,
    attempts,
    source_message_id: params.messageId ?? params.previous?.meta.source_message_id ?? null,
    updated_at: nowIso(),
  };
  if (caption) meta.caption = caption;
  if (params.errors && params.errors.length > 0) meta.errors = params.errors.slice(0, 5);

  const text = params.textOverride ?? photoRecoveryText(params.reason, caption, attempts);

  const previous = params.previous;
  if (previous) {
    const current = await getNote(params.userId, previous.id);
    if (current) {
      const keptCaption =
        caption ||
        (typeof current.metadata?.caption === 'string' ? current.metadata.caption : '');
      const nextMeta: Record<string, unknown> = {
        ...current.metadata,
        ...params.metaExtra,
        [PHOTO_RECOVERY_KIND]: meta,
      };
      if (keptCaption) nextMeta.caption = keptCaption;
      const updated = await updateNote(params.userId, previous.id, {
        rawText: text,
        metadata: nextMeta,
      });
      if (updated) return { id: updated.id, meta };
    }
  }

  const metadata: Record<string, unknown> = {
    ...params.metaExtra,
    [PHOTO_RECOVERY_KIND]: meta,
  };
  if (caption) metadata.caption = caption;

  const created = await createNote(params.userId, text, {
    column: 'raw',
    sourceType: params.sourceType ?? 'photo',
    fileId: params.fileId,
    sourceMessageId: params.messageId ?? null,
    metadata,
  });
  return { id: created.id, meta };
}

// ---------------------------------------------------------------------------
// Остатки со скриншотов банковских приложений
// ---------------------------------------------------------------------------

/**
 * Остаток на экране — это **состояние счёта**, а не операция и не заметка
 * (MEMORY: «остаток — состояние, а не операция»). Текст и голос уже шли через
 * `parseBalanceDeclaration` → `executeFinancialIntent`; фото ходит тем же путём
 * через `buildBalanceIntentFromSegments`, чтобы суммы считались одним кодом.
 *
 * Две независимые защиты от повторного применения одного и того же экрана:
 *  - хэш байтов картинки в `kv` — тот же скриншот не меняет балансы дважды;
 *  - водяной знак «когда снят остаток» на каждый счёт — старый снимок не
 *    затирает более новый, даже если это другой файл.
 */
const BALANCE_CLAIM_PREFIX = 'vision:balance';
const BALANCE_OBSERVED_PREFIX = 'vision:balance-observed';
/** Выученная связка «напечатанное на экране название → счёт владельца». */
const BALANCE_ALIAS_PREFIX = 'vision:balance-alias';
/** Неприменённый снимок, ждущий явного выбора счёта кнопкой. */
const BALANCE_PENDING_PREFIX = 'vision:balance-pending';
const INVOICE_CLAIM_PREFIX = 'vision:invoice';

/** Сколько счетов максимум влезает в один ряд кнопок подтверждения. */
const BALANCE_CHOICE_LIMIT = 5;

export const BALANCE_DUPLICATE_TEXT =
  'ℹ️ Этот скриншот уже обработан; балансы повторно не менялись.';

export const BALANCE_STALE_TEXT =
  'ℹ️ Снимок не новее последнего применённого баланса; обновление отменено.';

/**
 * В снимке был остаток, но применить нечего: модель не отдала сумму или валюту.
 *
 * Такой экран не должен выглядеть как обычная картинка: «сохранено в инбокс»
 * читается как «остаток учтён», хотя не записалось ничего.
 */
export const BALANCE_REJECTED_TEXT =
  '⚠️ В снимке был остаток, но не удалось прочитать сумму или валюту. ' +
  'Баланс не изменён — пришлите скриншот ещё раз.';

export const INVOICE_DUPLICATE_TEXT =
  'ℹ️ Этот счёт уже добавлен в обязательства; повторно не записываю.';

/** Снимок старше уже применённого: не ошибка хранилища, а отказ по правилу. */
class StaleBalanceSnapshotError extends Error {
  constructor() {
    super('balance snapshot is not newer than the applied one');
    this.name = 'StaleBalanceSnapshotError';
  }
}

/** Один снимок, уже сопоставленный с существующим счётом. */
interface ResolvedBalanceSnapshot {
  snapshot: VisionBalance;
  account: AccountRow;
  observedAt: string;
}

/** Итог применения остатков: ровно один из четырёх исходов. */
type BalanceOutcome =
  | {
      status: 'applied';
      rows: Array<{ account: AppliedBalance; mask: string | null }>;
      /** Полки чужих валют, которые не применились; их пропуск виден владельцу. */
      skipped: SkippedForeignShelf[];
      /** Если часть строк применилась, а одна осталась несопоставленной — её запрос на выбор. */
      pendingUnmapped?: {
        snapshot: VisionBalance;
        detail: string;
        choices: AccountRow[];
        remainingCount?: number;
      };
    }
  | { status: 'duplicate' }
  | { status: 'stale' }
  | {
      status: 'unmapped';
      detail: string;
      /** Счета, среди которых владелец может выбрать вручную (может быть пусто). */
      choices: AccountRow[];
      /** Индекс снимка, который не удалось сопоставить. */
      failedIndex: number;
      /** Сколько ещё несопоставленных строк осталось на том же экране. */
      remainingCount?: number;
    };

/** Как счёт напечатан на экране — для текста отказа и заметки. */
function balancePrintLabel(snapshot: VisionBalance): string {
  const name = snapshot.accountName?.trim() || 'счёт без названия';
  const mask = snapshot.cardMask ? ` ${snapshot.cardMask}` : '';
  return `${name}${mask} (${snapshot.currency})`;
}

/**
 * Сопоставление снимка с существующим счётом — строгое.
 *
 * Принимается только единственный кандидат с той же валютой: угадывать между
 * «Bank One» и «Bank One Reserve» нельзя, а создать новый счёт по названию
 * банка с картинки — значит завести пустой счёт-призрак.
 *
 * Порядок разрешения (MEMORY: «экран банка называет продукт, а не счёт»):
 *  1. бренд из маркетингового названия сужает набор счетов — но не решает за
 *     владельца: применяется только единственный счёт в этой валюте;
 *  2. выученный псевдоним (`vision:balance-alias:…`) — второй такой же экран
 *     проходит без вопросов;
 *  3. прежний точный/нечёткий поиск;
 *  4. ничего не подошло — владельцу предлагается выбрать счёт кнопкой.
 */
function normalizeBalanceAccountName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function balanceAliasSlug(normalized: string): string {
  const slug = normalized.replace(/\s+/g, '-').slice(0, 48);
  return slug || 'snapshot';
}

function balanceAliasKey(userId: number, normalized: string, currency: string): string {
  return `${BALANCE_ALIAS_PREFIX}:${userId}:${balanceAliasSlug(normalized)}:${currency.toUpperCase()}`;
}

/**
 * Счета, которые можно предложить владельцу: **только в валюте снимка**.
 *
 * Чужую валюту предлагать нельзя: `sameCurrency` отклонит выбор, и кнопка
 * окажется тупиком. `total` нужен, чтобы отличить «такого счёта нет вовсе» от
 * «счёта в этой валюте нет» — второму нужен другой текст и никаких кнопок.
 */
interface BalanceChoicePool {
  sameCurrency: AccountRow[];
  total: number;
}

async function balanceChoiceAccounts(
  userId: number,
  currency: string,
  brandName: string | null,
): Promise<BalanceChoicePool> {
  const all = await listAccounts(userId);
  const wanted = currency.toUpperCase();
  const pool = all.filter((account) => account.currency.toUpperCase() === wanted);
  const brand = brandName?.toLowerCase().trim();
  if (!brand) return { sameCurrency: pool, total: all.length };
  const head = pool.filter((account) => account.name.toLowerCase().trim() === brand);
  const tail = pool.filter((account) => account.name.toLowerCase().trim() !== brand);
  return { sameCurrency: [...head, ...tail], total: all.length };
}

interface BalanceResolution {
  account: AccountRow;
}

interface BalanceRejection {
  detail: string;
  choices: AccountRow[];
}

/**
 * Выводит единый банковский контекст всего скриншота по соседним строкам
 * (имя с явным брендом или уже привязанный `accountId`). Если на одном экране
 * встречаются два разных банка или ни одного — возвращает `null`.
 */
function inferScreenBankHint(
  snapshots: readonly VisionBalance[],
  allAccounts: readonly AccountRow[],
): string | null {
  const hints = new Set<string>();
  const byId = new Map(allAccounts.map((acc) => [acc.id, acc]));
  for (const snap of snapshots) {
    const rawName = snap.accountName?.trim();
    if (rawName) {
      const strict = matchExplicitAccount(
        normalizeBalanceAccountName(rawName),
        snap.currency,
        { strictBrandOnly: true },
      );
      if (strict) hints.add(strict);
    }
    if (snap.accountId !== undefined) {
      const acc = byId.get(snap.accountId);
      if (acc && acc.currency.toUpperCase() === snap.currency.toUpperCase()) {
        const strict = matchExplicitAccount(
          normalizeBalanceAccountName(acc.name),
          acc.currency,
          { strictBrandOnly: true },
        );
        if (strict) hints.add(strict);
      }
    }
  }
  return hints.size === 1 ? ([...hints][0] ?? null) : null;
}

async function resolveBalanceSnapshot(
  userId: number,
  snapshot: VisionBalance,
  overrideAccountId?: number,
  context?: { allAccounts?: readonly AccountRow[]; screenBankHint?: string | null },
): Promise<BalanceResolution | BalanceRejection> {
  if (snapshot.ambiguous) {
    return {
      detail: `на экране две разные суммы для «${balancePrintLabel(snapshot)}»`,
      choices: [],
    };
  }

  // Незнакомый ISO-код отказывается до любых кнопок: подставлять счёт, в котором
  // такой валюты не бывает, — значит обещать то, чего бот не умеет.
  try {
    resolveCurrencyStrict(snapshot.currency);
  } catch (error) {
    if (error instanceof UnsupportedCurrencyError) return { detail: error.message, choices: [] };
    throw error;
  }

  const currency = snapshot.currency.toUpperCase();
  const sameCurrency = (account: AccountRow): boolean =>
    account.currency.toUpperCase() === currency;

  // Явный выбор владельца (нажатие кнопки) главнее любой догадки.
  if (overrideAccountId !== undefined) {
    const account = await getAccount(userId, overrideAccountId);
    if (!account || !account.isActive || !sameCurrency(account)) {
      return { detail: 'выбранный счёт больше не подходит для этого остатка', choices: [] };
    }
    return { account };
  }

  // Прямой accountId от Vision (если активен и валюта совпала строго).
  if (snapshot.accountId !== undefined) {
    const direct = await getAccount(userId, snapshot.accountId);
    if (direct && direct.isActive && sameCurrency(direct)) {
      return { account: direct };
    }
  }

  const name = snapshot.accountName?.trim();
  if (!name) return { detail: 'на экране не напечатано название счёта', choices: [] };

  const normalized = normalizeBalanceAccountName(name);
  const strictBrand = matchExplicitAccount(normalized, currency, { strictBrandOnly: true });

  // 1. Строгий бренд: сужает набор, решает единственность счёта в этой валюте.
  if (strictBrand) {
    const brandCandidates = (
      await findAccountCandidates(userId, strictBrand, snapshot.currency)
    ).filter(sameCurrency);
    if (brandCandidates.length === 1) return { account: brandCandidates[0]! };
  }

  // 2. Выученная связка: экран с тем же названием больше не спрашивает.
  const aliasKey = balanceAliasKey(userId, normalized, currency);
  const remembered = Number(await kvGet(aliasKey));
  if (Number.isInteger(remembered) && remembered > 0) {
    const account = await getAccount(userId, remembered);
    if (account && account.isActive && sameCurrency(account)) return { account };
  }

  // 3. Прежний поиск по имени счёта.
  const candidates = await findAccountCandidates(userId, name, snapshot.currency, { loose: true });
  const matched = candidates.filter(sameCurrency);
  if (matched.length === 1) return { account: matched[0]! };

  // 4. Банковский контекст экрана от соседних полок (VIS-RUB1).
  const screenBankHint = context?.screenBankHint ?? null;
  if (screenBankHint && !strictBrand) {
    const hintCandidates = (
      await findAccountCandidates(userId, screenBankHint, snapshot.currency)
    ).filter(sameCurrency);
    if (hintCandidates.length === 1) return { account: hintCandidates[0]! };
  }

  // 5. Общий fallback («карта»/«счёт» без бренда) разрешён только если нет
  //    контекста другого банка и у пользователя не больше 1 счёта в этой валюте.
  const allAccounts = context?.allAccounts ?? (await listAccounts(userId));
  const sameCurrencyAccounts = allAccounts.filter(sameCurrency);
  let genericBrand: string | null = null;
  if (!strictBrand && !screenBankHint && sameCurrencyAccounts.length <= 1) {
    genericBrand = matchExplicitAccount(normalized, currency);
    if (genericBrand) {
      const genericCandidates = (
        await findAccountCandidates(userId, genericBrand, snapshot.currency)
      ).filter(sameCurrency);
      if (genericCandidates.length === 1) return { account: genericCandidates[0]! };
    }
  }

  const pool = await balanceChoiceAccounts(
    userId,
    currency,
    strictBrand ?? screenBankHint ?? genericBrand,
  );
  const choices = pool.sameCurrency;
  // Ни одного счёта в валюте снимка — кнопок нет: любая из них была бы
  // отклонена проверкой валюты. Говорим прямо, какой валюты не хватает.
  if (choices.length === 0) {
    return {
      detail:
        pool.total === 0
          ? `счёта «${name}» нет среди счетов бота`
          : `счетов в ${currency} нет среди счетов бота`,
      choices,
    };
  }
  if (matched.length === 0 && candidates.length === 0) {
    return { detail: `счёта «${name}» нет среди счетов бота`, choices };
  }
  if (matched.length === 0) {
    return { detail: `у счёта «${name}» нет остатка в ${snapshot.currency}`, choices };
  }
  return { detail: `«${name}» подходит к ${matched.length} счетам`, choices };
}

/** Снимок, отложенный до явного выбора счёта владельцем. */
interface PendingBalanceSnapshot {
  snapshots: VisionBalance[];
  imageHash: string;
  observedAt: string;
  /** Когда снимок отложен: срока в `kv` нет, протухание считается по нему. */
  createdAt: string;
  /** Заметка с повтором распознавания — её же показывает клавиатура. */
  noteId: number;
  /** Снимок, который не сопоставился. */
  index: number;
  /** Ключ выученного псевдонима, который запишется после выбора. */
  aliasKey: string;
  /** Счета, которые были предложены кнопками: чужой id не примется. */
  accountIds: number[];
  /** Счёт, на который остаток уже записан: по нему можно исправить выбор. */
  appliedAccountId?: number;
  /** Отложенная допривязка оставшейся полки частичного снимка (claimKey уже занят). */
  isPartialPending?: boolean;
}

/**
 * Сколько живёт отложенный снимок. Через сутки кнопка почти наверняка ведёт к
 * устаревшему остатку, поэтому запись считается протухшей и удаляется.
 */
const BALANCE_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Короткий токен кнопки: `bal:<token>:<accountId>` обязан влезать в 64 байта. */
function balancePendingToken(imageHash: string, index: number): string {
  return `${imageHash.slice(0, 10)}${index.toString(36)}`;
}

function balancePendingKey(userId: number, token: string): string {
  return `${BALANCE_PENDING_PREFIX}:${userId}:${token}`;
}

/**
 * Читает отложенный снимок. Протухший или битый удаляется: молча применить
 * старый остаток нельзя, а держать мёртвую запись в `kv` незачем.
 */
async function loadPendingBalance(
  userId: number,
  token: string,
): Promise<PendingBalanceSnapshot | null> {
  const key = balancePendingKey(userId, token);
  const raw = await kvGet(key);
  if (!raw) return null;

  let pending: PendingBalanceSnapshot;
  try {
    pending = JSON.parse(raw) as PendingBalanceSnapshot;
  } catch {
    await kvDelete(key);
    return null;
  }
  if (!Array.isArray(pending.snapshots) || !Array.isArray(pending.accountIds)) {
    await kvDelete(key);
    return null;
  }

  const created = Date.parse(pending.createdAt);
  if (!Number.isFinite(created) || Date.now() - created > BALANCE_PENDING_TTL_MS) {
    await kvDelete(key);
    return null;
  }
  return pending;
}

async function storePendingBalance(params: {
  userId: number;
  snapshots: readonly VisionBalance[];
  imageHash: string;
  messageObservedAt: string;
  failedIndex: number;
  choices: readonly AccountRow[];
  snapshotName: string;
  noteId: number;
  isPartialPending?: boolean;
}): Promise<string> {
  const token = balancePendingToken(params.imageHash, params.failedIndex);
  const pending: PendingBalanceSnapshot = {
    snapshots: params.snapshots.map((snapshot) => ({ ...snapshot })),
    imageHash: params.imageHash,
    observedAt: params.messageObservedAt,
    createdAt: nowIso(),
    noteId: params.noteId,
    index: params.failedIndex,
    aliasKey: balanceAliasKey(
      params.userId,
      normalizeBalanceAccountName(params.snapshotName),
      params.snapshots[params.failedIndex]?.currency ?? '',
    ),
    accountIds: params.choices.map((account) => account.id),
    ...(params.isPartialPending ? { isPartialPending: true } : {}),
  };
  await kvSet(balancePendingKey(params.userId, token), JSON.stringify(pending));
  return token;
}

/**
 * Что делать со строкой снимка ещё до сопоставления счетов.
 *
 * `apply` — обычная строка. `skip-empty-shelf` — пустая полка мультивалютной
 * карты в чужой валюте: держать такую валюту бот не умеет, но и блокировать
 * из-за неё весь снимок нельзя. `skip-foreign-shelf` — та же полка, но с
 * ненулевой суммой: записать её некуда (нет ни счёта, ни курса), поэтому она
 * тоже не применяется, зато попадает в ответ и в след записи — пропуск денег
 * обязан быть видимым.
 *
 * Порядок здесь и есть решение: неизвестная валюта отсекается по сумме ДО
 * `resolveCurrencyStrict`, иначе «0,00 CNY» превращалось в отказ «валюта не
 * поддерживается» и стирало весь снимок вместе с тенговой полкой.
 */
type BalanceRowDecision = 'apply' | 'skip-empty-shelf' | 'skip-foreign-shelf';

function classifyBalanceRow(snapshot: VisionBalance): BalanceRowDecision {
  if (snapshot.shelfKind === 'inactive_zero_shelf' && snapshot.balanceCents === 0) {
    return 'skip-empty-shelf';
  }
  try {
    resolveCurrencyStrict(snapshot.currency);
    return 'apply';
  } catch (error) {
    if (!(error instanceof UnsupportedCurrencyError)) throw error;
  }
  // Нечитаемая сумма (NaN) сюда уже не доходит, но проверка дешёвая: «нечего
  // записать» — тот же пустой слот, что и ноль.
  if (!Number.isFinite(snapshot.balanceCents) || snapshot.balanceCents === 0) {
    return 'skip-empty-shelf';
  }
  return 'skip-foreign-shelf';
}

/** Пропущенная полка чужой валюты: показывается в ответе и в заметке-следе. */
export interface SkippedForeignShelf {
  /** Как счёт напечатан на экране: «Депозитная карта *1234 (CNY)». */
  label: string;
  amountCents: number;
  currency: string;
}

interface UnmappedBalanceEntry {
  index: number;
  snapshot: VisionBalance;
  detail: string;
  choices: AccountRow[];
}

/**
 * Применяет все снимки экрана одной атомарной операцией.
 *
 * «Атомарно» здесь означает: либо обновились все валюты мультивалютной карты,
 * либо ни одна. Резолв счетов идёт до записи, метка и водяные знаки — внутри
 * одной транзакции. Платформа блокирует явный `BEGIN`, поэтому при откате
 * метка снимается руками: иначе повтор никогда бы не прошёл.
 */
async function applyBalanceSnapshot(params: {
  userId: number;
  snapshots: readonly VisionBalance[];
  imageHash: string;
  /** Запасной момент наблюдения — `message.date` (или `forward_date`). */
  messageObservedAt: string;
  /** Явный выбор владельца: индекс снимка → id счёта. */
  overrides?: ReadonlyMap<number, number>;
  /**
   * Применить снимок, который уже был обработан. Так исправляется неверный
   * выбор счёта: владелец сам просит записать тот же остаток в другой счёт.
   * Метка идемпотентности для автопроходов при этом не отключается — только
   * для явного нажатия кнопки.
   */
  allowReapply?: boolean;
}): Promise<BalanceOutcome> {
  const allAccounts = await listAccounts(params.userId);
  const screenBankHint = inferScreenBankHint(params.snapshots, allAccounts);
  const isMultiRowScreen = params.snapshots.length > 1;

  const candidateResolved: Array<ResolvedBalanceSnapshot & { index: number }> = [];
  const unmappedEntries: UnmappedBalanceEntry[] = [];
  const skipped: SkippedForeignShelf[] = [];

  for (const [index, snapshot] of params.snapshots.entries()) {
    const decision = classifyBalanceRow(snapshot);
    // Пустая полка мультивалютной карты или неактивная полка 0,00 — не счёт.
    if (decision === 'skip-empty-shelf') continue;
    // Полка чужой валюты с суммой: записать некуда, но молчать нельзя.
    if (decision === 'skip-foreign-shelf') {
      skipped.push({
        label: balancePrintLabel(snapshot),
        amountCents: snapshot.balanceCents,
        currency: snapshot.currency.toUpperCase(),
      });
      continue;
    }
    const found = await resolveBalanceSnapshot(
      params.userId,
      snapshot,
      params.overrides?.get(index),
      { allAccounts, screenBankHint },
    );
    if ('detail' in found) {
      unmappedEntries.push({
        index,
        snapshot,
        detail: found.detail,
        choices: found.choices,
      });
      continue;
    }

    // VIS-ZERO1: защищаем положительный остаток от случайного затирания нулём.
    if (
      snapshot.balanceCents === 0 &&
      found.account.currentBalanceCents > 0 &&
      !params.overrides?.has(index)
    ) {
      if (isMultiRowScreen) continue;
      unmappedEntries.push({
        index,
        snapshot,
        detail:
          `обнуление счёта «${found.account.name}» (сейчас ` +
          `${formatCentsWithSuffix(found.account.currentBalanceCents, found.account.currency)}) требует подтверждения`,
        choices: [found.account],
      });
      continue;
    }

    candidateResolved.push({
      index,
      snapshot,
      account: found.account,
      observedAt: snapshot.observedAt ?? params.messageObservedAt,
    });
  }

  // Дедупликация строк, попавших в один и тот же account.id:
  // положительная сумма (> 0) побеждает 0; две разные > 0 суммы → ambiguous.
  const byAccountId = new Map<number, Array<ResolvedBalanceSnapshot & { index: number }>>();
  for (const entry of candidateResolved) {
    const group = byAccountId.get(entry.account.id);
    if (group) group.push(entry);
    else byAccountId.set(entry.account.id, [entry]);
  }

  const resolved: ResolvedBalanceSnapshot[] = [];
  for (const group of byAccountId.values()) {
    if (group.length === 1) {
      resolved.push(group[0]!);
      continue;
    }
    const positives = group.filter((item) => item.snapshot.balanceCents > 0);
    if (positives.length === 0) {
      resolved.push(group[0]!);
      continue;
    }
    const distinctPositive = new Set(positives.map((item) => item.snapshot.balanceCents));
    if (distinctPositive.size === 1) {
      resolved.push(positives[0]!);
      continue;
    }
    for (const item of positives) {
      unmappedEntries.push({
        index: item.index,
        snapshot: { ...item.snapshot, ambiguous: true },
        detail: `на экране две разные суммы для «${item.account.name}» (${item.account.currency})`,
        choices: [],
      });
    }
  }
  unmappedEntries.sort((a, b) => a.index - b.index);

  const claimKey = `${BALANCE_CLAIM_PREFIX}:${params.userId}:${params.imageHash}`;

  // Ни одной применимой строки: либо есть несопоставленные, либо только пропуски.
  if (resolved.length === 0) {
    if (unmappedEntries.length > 0) {
      const firstUnmapped = unmappedEntries[0]!;
      return {
        status: 'unmapped',
        detail: firstUnmapped.detail,
        choices: firstUnmapped.choices,
        failedIndex: firstUnmapped.index,
        ...(unmappedEntries.length > 1 ? { remainingCount: unmappedEntries.length - 1 } : {}),
      };
    }
    const currencies = [...new Set(skipped.map((shelf) => shelf.currency))];
    return {
      status: 'unmapped',
      detail:
        currencies.length > 0
          ? `на экране только полки ${currencies.join('/')} — эти валюты бот не ведёт`
          : 'на снимке нет остатков, которые можно записать',
      choices: [],
      // Ни одна строка не сопоставлялась, поэтому «виноватого» снимка нет:
      // `-1` не даёт назвать пропущенную полку несопоставленным счётом.
      failedIndex: -1,
    };
  }

  // Строгая валюта проверяется до первой записи: незнакомый ISO-код не должен
  // ни превратиться в EUR, ни оставить после себя половинчатую запись.
  let intent: ParsedFinancialIntent | null = null;
  try {
    intent = buildBalanceIntentFromSegments(
      resolved.map((row) => ({
        account: row.account.name,
        amountCents: row.snapshot.balanceCents,
        currency: row.snapshot.currency,
      })),
    );
  } catch (error) {
    if (error instanceof UnsupportedCurrencyError) {
      return { status: 'unmapped', detail: error.message, choices: [], failedIndex: 0 };
    }
    throw error;
  }
  if (!intent) throw new BalanceAccountUnresolvedError('', '');

  /** Ряды, которые уже легли в счета: по ним пишется водяной знак при отказе. */
  const appliedRows: Array<{ accountId: number; observedAt: string }> = [];

  const run = async (): Promise<BalanceOutcome> => {
    if (!params.allowReapply) {
      const claimed = await kvSetIfAbsent(claimKey, nowIso());
      if (!claimed) return { status: 'duplicate' };
    }

    for (const row of resolved) {
      const watermark = await kvGet(`${BALANCE_OBSERVED_PREFIX}:${params.userId}:${row.account.id}`);
      if (!watermark) continue;
      const seen = Date.parse(watermark);
      const next = Date.parse(row.observedAt);
      // Строго старше — отказ. Тот же момент (повтор после отказа на середине
      // списка) применяется заново: запись остатка абсолютная, повтор безвреден.
      if (Number.isFinite(seen) && Number.isFinite(next) && next < seen) {
        throw new StaleBalanceSnapshotError();
      }
    }

    const result = await executeFinancialIntent(
      params.userId,
      intent,
      buildBalanceTraceText(resolved, skipped),
      {
        requireExistingAccount: true,
        // След записи остатка обязателен: без него «27 373,87 ₸ записалось»
        // нечем подтвердить задним числом — ни суммы, ни счёта, ни момента
        // наблюдения. Текстовый путь остатка такую заметку создаёт всегда;
        // фото-путь её отключал и терял единственный след.
        createAuditNote: true,
        onBalanceApplied: (applied) => {
          const row = resolved.find((item) => item.account.id === applied.accountId);
          if (row) appliedRows.push({ accountId: applied.accountId, observedAt: row.observedAt });
        },
      },
    );

    // Применились обязаны быть ровно те счета, что мы выбрали заранее: иначе
    // исполнитель ушёл в другой счёт, и ответ пользователю был бы ложью.
    const applied = result.accounts ?? [];
    const ids = new Set(applied.map((item) => item.accountId));
    if (applied.length !== resolved.length || resolved.some((row) => !ids.has(row.account.id))) {
      throw new BalanceAccountUnresolvedError('', '');
    }

    for (const row of resolved) {
      await kvSet(
        `${BALANCE_OBSERVED_PREFIX}:${params.userId}:${row.account.id}`,
        row.observedAt,
      );
    }

    const rows = applied.map((account) => ({
      account,
      mask:
        resolved.find((row) => row.account.id === account.accountId)?.snapshot.cardMask ?? null,
    }));
    const firstUnmapped = unmappedEntries[0];
    return {
      status: 'applied',
      rows,
      skipped,
      ...(firstUnmapped
        ? {
            pendingUnmapped: {
              snapshot: firstUnmapped.snapshot,
              detail: firstUnmapped.detail,
              choices: firstUnmapped.choices,
              ...(unmappedEntries.length > 1 ? { remainingCount: unmappedEntries.length - 1 } : {}),
            },
          }
        : {}),
    };
  };

  try {
    return await withTransaction(run);
  } catch (error) {
    // Платформа блокирует явный `BEGIN` (SQLite error 23), поэтому отката нет:
    // что успело записаться, то записалось. Водяные знаки применённых рядов
    // пишем ДО снятия метки — иначе повтор переприменил бы их, а старый снимок
    // позже прошёл бы проверку и затёр новый остаток.
    for (const row of appliedRows) {
      await kvSet(`${BALANCE_OBSERVED_PREFIX}:${params.userId}:${row.accountId}`, row.observedAt);
    }
    if (!params.allowReapply) await kvDelete(claimKey);
    if (error instanceof StaleBalanceSnapshotError) return { status: 'stale' };
    if (error instanceof BalanceAccountUnresolvedError) {
      return {
        status: 'unmapped',
        detail: 'счёт не сопоставлен однозначно',
        choices: [],
        failedIndex: 0,
      };
    }
    throw error;
  }
}

/** Ответ по фактическим строкам счетов: сумма и валюта ровно те, что записаны. */
function formatBalanceAppliedReply(
  rows: ReadonlyArray<{ account: AppliedBalance; mask: string | null }>,
): string {
  const label = (row: { account: AppliedBalance; mask: string | null }): string => {
    const mask = row.mask ? ` ${row.mask}` : '';
    return `${escapeAmpLtGt(row.account.name)}${mask}`;
  };
  const amount = (row: { account: AppliedBalance }): string =>
    `<b>${formatCentsWithSuffix(row.account.balanceCents, row.account.currency)}</b>`;

  const first = rows[0];
  if (!first) return '✅ Балансы обновлены.';
  if (rows.length === 1) return `✅ Баланс ${label(first)} обновлён: ${amount(first)}`;
  return [
    '✅ <b>Балансы обновлены:</b>',
    ...rows.map((row) => `• ${label(row)}: ${amount(row)}`),
  ].join('\n');
}

/**
 * Строка о пропущенных полках: сумма, валюта и причина.
 *
 * Пропуск обязан быть видимым: остаток на экране, который не записался, — это
 * деньги, о которых владелец уверен, что они учтены. Пустые полки сюда не
 * попадают, о них молчим намеренно (`classifyBalanceRow`).
 */
function formatBalanceSkippedNotice(skipped: readonly SkippedForeignShelf[]): string {
  if (skipped.length === 0) return '';
  const lines = skipped.map(
    (shelf) =>
      `• ${escapeAmpLtGt(shelf.label)}: ` +
      `${formatCentsWithSuffix(shelf.amountCents, shelf.currency)} — валюту ${escapeAmpLtGt(shelf.currency)} бот не ведёт`,
  );
  return `⏭ <b>Пропущено:</b>\n${lines.join('\n')}`;
}

/**
 * Текст заметки-следа: что именно записалось и когда это наблюдалось.
 *
 * Остаток — абсолютное значение, поэтому след нужен не для отката, а для
 * ответа на вопрос «откуда взялись эти 27 373,87 ₸»: счёт, сумма и момент
 * наблюдения с экрана важнее момента записи в базу.
 */
function buildBalanceTraceText(
  rows: ReadonlyArray<ResolvedBalanceSnapshot>,
  skipped: readonly SkippedForeignShelf[],
): string {
  const lines = ['Остаток со скриншота:'];
  for (const row of rows) {
    const mask = row.snapshot.cardMask ? ` ${row.snapshot.cardMask}` : '';
    const currency = row.snapshot.currency.toUpperCase();
    lines.push(
      `• ${row.account.name}${mask} (${currency}): ` +
        `${formatCents(row.snapshot.balanceCents)} ${currency}`,
    );
    lines.push(`  наблюдение: ${row.observedAt}`);
  }
  if (skipped.length > 0) {
    lines.push('Пропущено (валюта не поддерживается):');
    for (const shelf of skipped) {
      lines.push(`• ${shelf.label}: ${formatCents(shelf.amountCents)} ${shelf.currency}`);
    }
  }
  return lines.join('\n');
}

/** Текст отказа: одно объяснение на экран, без «сохранено в инбокс». */
function formatBalanceUnmappedText(detail: string, snapshot: VisionBalance | null): string {
  const who = snapshot ? balancePrintLabel(snapshot) : 'снимок';
  return `Не смог сопоставить счёт: ${who}. Баланс не изменён.\nПричина: ${detail}.`;
}

export const BALANCE_EXPIRED_TEXT =
  '⌛ Снимок устарел или уже применён. Пришлите скриншот заново.';

interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Клавиатура выбора счёта: до пяти счетов плюс прежний повтор распознавания.
 * `callback_data` — `bal:<token>:<accountId>`, где токен короткий: у Telegram
 * на строку 64 байта, а id счёта и префикс съедают половину.
 */
function formatBalanceChoiceKeyboard(
  token: string,
  choices: readonly AccountRow[],
  noteId: number,
  options?: { includeRetry?: boolean },
): { inline_keyboard: InlineButton[][] } {
  const shown = choices.slice(0, BALANCE_CHOICE_LIMIT);
  const rows: InlineButton[][] = shown.map((account) => [
    { text: `${account.name} · ${account.currency}`, callback_data: `bal:${token}:${account.id}` },
  ]);
  if (options?.includeRetry ?? true) {
    rows.push([{ text: '🔁 Повторить', callback_data: `retry_photo:${noteId}` }]);
  }
  return { inline_keyboard: rows };
}

/** Отправляет запрос на выбор счёта и сохраняет заметку-след при необходимости. */
async function sendPendingBalancePrompt(params: {
  userId: number;
  chatId: number;
  photoFileId: string;
  cleanCaption: string;
  messageId?: number;
  sourceType: NoteSourceType;
  result: VisionResult;
  imageHash: string;
  messageObservedAt: string;
  headline: string;
  detail: string;
  choices: readonly AccountRow[];
  snapshots: readonly VisionBalance[];
  failedIndex: number;
  snapshotName: string;
  previousRecoveryNote: PhotoRecoveryNoteRef | null;
  captionPrefix?: string;
  isPartialPending?: boolean;
  remainingCount?: number;
}): Promise<void> {
  const choicePrompt =
    params.choices.length > 0
      ? [
          'К какому счёту отнести остаток? Выберите кнопкой ниже.',
          ...(params.choices.length > BALANCE_CHOICE_LIMIT
            ? [`Не показано ещё: ${params.choices.length - BALANCE_CHOICE_LIMIT}.`]
            : []),
        ].join('\n')
      : '';
  const remainingNotice =
    params.remainingCount && params.remainingCount > 0
      ? `Ещё несопоставленных строк на снимке: ${params.remainingCount}.`
      : '';
  const recognized = `Распознано: ${truncate(params.result.summary, 300)}`;
  const noteText = [params.headline, choicePrompt, remainingNotice, recognized]
    .filter((part) => part !== '')
    .join('\n\n');
  const note = await savePhotoRecoveryNote({
    userId: params.userId,
    fileId: params.photoFileId,
    caption: params.cleanCaption,
    messageId: params.messageId,
    reason: 'vision',
    metaExtra: {
      ...buildVisionMeta(params.result, params.cleanCaption),
      balance_unmapped: params.detail,
    },
    textOverride: noteText,
    sourceType: params.sourceType,
    previous: params.previousRecoveryNote,
  });
  const token =
    params.choices.length > 0
      ? await storePendingBalance({
          userId: params.userId,
          snapshots: params.snapshots,
          imageHash: params.imageHash,
          messageObservedAt: params.messageObservedAt,
          failedIndex: params.failedIndex,
          choices: params.choices,
          snapshotName: params.snapshotName,
          noteId: note.id,
          isPartialPending: params.isPartialPending,
        })
      : null;

  // При частичном применении claimKey уже занят применёнными строками, поэтому
  // retry_photo сразу вернёт BALANCE_DUPLICATE_TEXT — сломанную кнопку не рисуем.
  const includeRetry = !params.isPartialPending;
  const replyMarkup: ReplyMarkup = token
    ? formatBalanceChoiceKeyboard(token, params.choices, note.id, { includeRetry })
    : includeRetry
      ? { inline_keyboard: [[{ text: '🔁 Повторить', callback_data: `retry_photo:${note.id}` }]] }
      : getMainKeyboard();

  await safeAnswer(params.chatId, `${params.captionPrefix ?? ''}${escapeAmpLtGt(noteText)}`, {
    replyMarkup,
    isHtml: true,
  });
}

export interface BalanceChoiceResult {
  /** Текст всплывающего ответа на нажатие; пусто — только погасить спиннер. */
  toast?: string;
}

/**
 * Терминальный итог карточки выбора счёта: кнопки выбора убираются, а под
 * разделитель пишется причина. Оставшиеся кнопки вели бы в тот же отказ.
 * Правка best-effort: сбой Bot API не отменяет ответ-тост.
 */
async function closeBalanceChoiceCard(params: {
  chatId: number;
  messageId: number;
  originalText?: string;
  statusLine: string;
}): Promise<void> {
  const base = (params.originalText ?? '')
    .replace(/\n\n(?:━{4,}\n)?(?:⏳|✅|💊|⏭️?|🗑️?|🎯|📥|🔁|❌|⌛|ℹ️).+$/s, '')
    .trimEnd();
  const text = base
    ? `${base}\n\n━━━━━━━━━━━━━━\n${params.statusLine}`
    : params.statusLine;
  try {
    await safeEdit(params.chatId, params.messageId, text, {
      replyMarkup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.warn('balance: card cleanup failed', error);
  }
}

/** Кнопка исправления: снимает выученную связку для этого снимка. */
const BALANCE_UNALIAS_LABEL = 'Не тот счёт?';
const BALANCE_UNALIAS_PREFIX = 'unalias:';

/**
 * Явное подтверждение счёта владельцем (`bal:<token>:<accountId>`).
 *
 * Снимок применяется только здесь: пока счёт не выбран кнопкой, деньги не
 * двигаются. Выбор запоминается как псевдоним, чтобы следующий такой же экран
 * прошёл без вопроса, и остаётся исправимым кнопкой «Не тот счёт?».
 */
export async function applyBalanceChoice(params: {
  userId: number;
  chatId: number;
  messageId: number;
  data: string;
  /** Текст карточки: нужен, чтобы дописать итог при терминальном отказе. */
  originalText?: string;
}): Promise<BalanceChoiceResult> {
  const rest = params.data.slice('bal:'.length);
  if (rest.startsWith(BALANCE_UNALIAS_PREFIX)) {
    return applyBalanceUnalias({
      userId: params.userId,
      chatId: params.chatId,
      messageId: params.messageId,
      token: rest.slice(BALANCE_UNALIAS_PREFIX.length),
      originalText: params.originalText,
    });
  }
  const closeCard = (statusLine: string): Promise<void> =>
    closeBalanceChoiceCard({
      chatId: params.chatId,
      messageId: params.messageId,
      originalText: params.originalText,
      statusLine,
    });

  const separator = rest.lastIndexOf(':');
  const token = separator > 0 ? rest.slice(0, separator) : '';
  const chosenId = Number(separator > 0 ? rest.slice(separator + 1) : '');
  if (!token) {
    await closeCard(BALANCE_EXPIRED_TEXT);
    return { toast: BALANCE_EXPIRED_TEXT };
  }

  const pending = await loadPendingBalance(params.userId, token);
  if (!pending) {
    await closeCard(BALANCE_EXPIRED_TEXT);
    return { toast: BALANCE_EXPIRED_TEXT };
  }

  if (!Number.isInteger(chosenId) || !pending.accountIds.includes(chosenId)) {
    return { toast: '⚠️ Этот счёт не относится к снимку — баланс не изменён' };
  }

  const pendingKey = balancePendingKey(params.userId, token);
  const outcome = await applyBalanceSnapshot({
    userId: params.userId,
    snapshots: pending.snapshots,
    imageHash: pending.imageHash,
    messageObservedAt: pending.observedAt,
    overrides: new Map([[pending.index, chosenId]]),
    // Повторное нажатие после исправления или допривязка частичного снимка.
    allowReapply: pending.appliedAccountId !== undefined || pending.isPartialPending === true,
  });

  if (outcome.status === 'applied') {
    await kvSet(pending.aliasKey, String(chosenId));
    // Снимок не удаляем: пока он не протух, владелец может исправить выбор.
    await kvSet(
      pendingKey,
      JSON.stringify({ ...pending, appliedAccountId: chosenId } satisfies PendingBalanceSnapshot),
    );
    await safeEdit(
      params.chatId,
      params.messageId,
      [
        formatBalanceAppliedReply(outcome.rows),
        formatBalanceSkippedNotice(outcome.skipped),
      ]
        .filter((part) => part !== '')
        .join('\n\n'),
      {
        isHtml: true,
        replyMarkup: {
          inline_keyboard: [
            [
              {
                text: BALANCE_UNALIAS_LABEL,
                callback_data: `bal:${BALANCE_UNALIAS_PREFIX}${token}`,
              },
            ],
          ],
        },
      },
    );
    return {};
  }

  if (outcome.status === 'duplicate') {
    await kvDelete(pendingKey);
    await closeCard(BALANCE_DUPLICATE_TEXT);
    return { toast: BALANCE_DUPLICATE_TEXT };
  }
  if (outcome.status === 'stale') {
    await kvDelete(pendingKey);
    await closeCard(BALANCE_STALE_TEXT);
    return { toast: BALANCE_STALE_TEXT };
  }
  return { toast: `⚠️ ${outcome.detail}` };
}

/**
 * «Не тот счёт?» — связка «название с экрана → счёт» снимается, выбор снова
 * открывается для того же снимка, в той же валюте.
 *
 * Записанные деньги не откатываются: остаток на прежнем счёте — это факт, а не
 * черновик. Правильный выбор запишет остаток туда и запомнится вместо старой
 * связки.
 */
async function applyBalanceUnalias(params: {
  userId: number;
  chatId: number;
  messageId: number;
  token: string;
  originalText?: string;
}): Promise<BalanceChoiceResult> {
  const closeCard = (statusLine: string): Promise<void> =>
    closeBalanceChoiceCard({
      chatId: params.chatId,
      messageId: params.messageId,
      originalText: params.originalText,
      statusLine,
    });
  if (!params.token) {
    await closeCard(BALANCE_EXPIRED_TEXT);
    return { toast: BALANCE_EXPIRED_TEXT };
  }
  const pending = await loadPendingBalance(params.userId, params.token);
  if (!pending) {
    await closeCard(BALANCE_EXPIRED_TEXT);
    return { toast: BALANCE_EXPIRED_TEXT };
  }

  const previousId = pending.appliedAccountId;
  if (previousId === undefined) {
    return { toast: '⚠️ Счёт ещё не выбран — выберите его кнопкой' };
  }

  await kvDelete(pending.aliasKey);

  const loaded = await Promise.all(
    pending.accountIds.map((id) => getAccount(params.userId, id)),
  );
  const byId = new Map(
    loaded.filter((account): account is AccountRow => account !== null).map((account) => [
      account.id,
      account,
    ]),
  );
  const currency = (pending.snapshots[pending.index]?.currency ?? '').toUpperCase();
  const choices = pending.accountIds
    .map((id) => byId.get(id))
    .filter(
      (account): account is AccountRow =>
        account !== undefined && account.isActive && account.currency.toUpperCase() === currency,
    );
  if (choices.length === 0) {
    const gone = '⚠️ Счета этого снимка больше не подходят — пришлите скриншот заново';
    await closeCard(gone);
    return { toast: gone };
  }

  const printed = pending.snapshots[pending.index]?.accountName?.trim() || 'снимок';
  const previous = byId.get(previousId);
  const previousLabel = previous
    ? `${escapeAmpLtGt(previous.name)} · ${previous.currency}`
    : 'прежний счёт';
  const text = [
    `↩️ Связка «${escapeAmpLtGt(printed)}» с ${previousLabel} отменена.`,
    '',
    `Баланс, уже записанный на ${previousLabel}, автоматически не откатывается — это записанные данные, а не черновик.`,
    'Выберите правильный счёт: остаток запишется туда, и выбор запомнится.',
  ].join('\n');

  await safeEdit(params.chatId, params.messageId, text, {
    isHtml: true,
    replyMarkup: formatBalanceChoiceKeyboard(params.token, choices, pending.noteId, {
      includeRetry: pending.isPartialPending !== true,
    }),
  });
  return {};
}

/** Итог проведения счёта на оплату. */
type InvoiceOutcome =
  | { status: 'created'; name: string; amountCents: number; currency: string; dueDate: string }
  | { status: 'duplicate' };

/**
 * Счёт на оплату — обязательство, а не расход и не остаток.
 *
 * Деньги ещё не ушли, поэтому в книге расходов им не место: строка появляется
 * в обязательствах, и оплата пойдёт обычным путём `payLiability`.
 */
async function applyInvoice(params: {
  userId: number;
  invoice: VisionInvoice & { payee: string; amountCents: number; currency: string; dueDate: string };
  imageHash: string;
}): Promise<InvoiceOutcome> {
  const claimKey = `${INVOICE_CLAIM_PREFIX}:${params.userId}:${params.imageHash}`;
  try {
    return await withTransaction(async () => {
      const claimed = await kvSetIfAbsent(claimKey, nowIso());
      if (!claimed) return { status: 'duplicate' } as InvoiceOutcome;

      await createLiability(params.userId, {
        name: params.invoice.payee,
        queue: 'queue_1',
        amountCents: params.invoice.amountCents,
        currency: params.invoice.currency,
        monthlyPaymentCents: params.invoice.amountCents,
        endDate: params.invoice.dueDate,
        notes: 'Распознано со скриншота счёта',
      });

      return {
        status: 'created',
        name: params.invoice.payee,
        amountCents: params.invoice.amountCents,
        currency: params.invoice.currency,
        dueDate: params.invoice.dueDate,
      };
    });
  } catch (error) {
    await kvDelete(claimKey);
    throw error;
  }
}

interface PhotoPipelineParams {
  userId: number;
  chatId: number;
  /** `null` — у апдейта нет фото: остаётся только путь подписи. */
  fileId: string | null;
  caption?: string;
  messageId?: number;
  forwarded?: boolean;
  /** MIME картинки: у документа свой, у фото Telegram — JPEG. */
  mimeType?: string;
  /**
   * `message.date` (unix, сек) — запасной момент наблюдения остатка, когда на
   * экране не напечатано ни даты, ни времени.
   */
  messageDate?: number;
  /** `message.forward_date`: у пересланного снимка момент — исходный. */
  forwardDate?: number;
  /** Тип источника заметки: фото-сообщение или документ с картинкой. */
  sourceType?: NoteSourceType;
  /** Контекст сообщения, на которое отвечает пользователь (`quote` / `reply_to_message`). */
  replyContext?: string;
  /** Повтор: заглушка, которую надо обновить, а после успеха — убрать в корзину. */
  recoveryNote?: PhotoRecoveryNoteRef | null;
}

/**
 * Единый путь фото: подпись → скачать → распознать → провести или сохранить.
 *
 * Отказ не выходит из функции молча: заметка с `file_id` и подписью остаётся
 * в инбоксе, а в чат уходит причина и кнопка `retry_photo:<noteId>`. Таймера
 * нет — повтор это следующее касание (кнопка).
 *
 * Повтор (`recoveryNote`) — **только распознавание**. Подпись и деньги уже
 * проходили первый путь, а результат той финансовой попытки неизвестен: второй
 * `executeFinancialIntent` рискнул бы двойным списанием (SPEC: «Деньги не
 * повторяются автоматически»).
 */
async function runPhotoPipeline(params: PhotoPipelineParams): Promise<void> {
  const { userId, chatId, fileId, messageId, forwarded = false, replyContext, recoveryNote } = params;
  const cleanCaption = (params.caption || '').trim();
  const replay = recoveryNote != null;
  const sourceType: NoteSourceType = params.sourceType ?? 'photo';
  /**
   * Момент, к которому относится снимок, когда на экране не напечатано времени:
   * у пересланного сообщения — исходная дата, иначе момент отправки. Без него
   * сравнивать «снимок новее применённого» было бы нечем.
   */
  const messageObservedAt = (() => {
    const seconds = params.forwardDate ?? params.messageDate;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return new Date(seconds * 1000).toISOString();
    }
    return nowIso();
  })();

  /**
   * Подпись пыталась двинуть деньги и упала не по правилу, а по неизвестной
   * причине: результат попытки не доказан. Второй денежный проход (агент или
   * распознанный чек) в этом же ходе закрыт — иначе один и тот же расход мог бы
   * лечь в книгу дважды.
   */
  let captionWriteFailure: Record<string, unknown> | undefined;
  let captionNotice = '';

  // 1. Если есть подпись — единая проверка финансового fast-path и агентного шага.
  //    На повторе этот шаг пропускается целиком: см. комментарий выше.
  if (!replay && cleanCaption) {
    const finIntent = parseFinancialIntent(cleanCaption);
    if (finIntent) {
      try {
        const finRes = await executeFinancialIntent(userId, finIntent, cleanCaption);
        if (finRes) {
          const replyMarkup = buildFinanceUndoMarkup({
            isLiability: finRes.action === 'liability_pay',
            liabilityId: finRes.liabilityId,
            month: finRes.month,
            transactionId: finRes.transactionId ?? undefined,
          });

          await safeAnswer(chatId, finRes.replyText, {
            replyMarkup,
            isHtml: true,
          });
          return;
        }
      } catch (err) {
        if (isInsufficientFundsError(err)) {
          await safeAnswer(chatId, formatDebitRefusal(err, refusalLabel(finIntent.action)), {
            replyMarkup: getMainKeyboard(),
            isHtml: true,
          });
          return;
        }
        console.warn('handlePhotoMessage caption financial error:', err);
        const reason = err instanceof Error ? err.message : String(err);
        await recordFailure(userId, {
          stage: 'ingest',
          media: 'photo',
          reason: 'storage_failed',
          detail: reason,
        });
        captionNotice = captionWriteUnconfirmedText(finIntent.amount, finIntent.currency, reason);
        captionWriteFailure = {
          kind: FINANCE_UNCONFIRMED_KIND,
          stage: 'caption',
          action: finIntent.action,
          amount: finIntent.amount,
          currency: finIntent.currency,
          error: truncate(reason, 200),
          at: nowIso(),
        };
      }
    }

    // T0b: любая подпись (как и любой свободный текст) доходит до агента.
    // Ворота — только пересылка и неизвестный результат финансовой попытки:
    // агент тоже умеет двигать деньги, поэтому после неё он не запускается.
    // Инбокс и vision остаются fallback'ом ниже.
    if (!forwarded && !captionWriteFailure) {
      try {
        const handled = await tryAgentAutonomousStep(
          userId,
          chatId,
          cleanCaption,
          undefined,
          replyContext,
        );
        if (handled) return;
      } catch (err) {
        console.warn('handlePhotoMessage agent step error:', err);
        await recordFailure(userId, {
          stage: 'agent',
          media: 'photo',
          reason: 'unhandled',
          detail: errorDetail(err),
        });
      }
    }
  }

  // 2. Дальше нужен сам файл: без него сохранять нечего.
  if (!fileId) {
    // Фото пришло без `file_id` — сохранять нечего, но и молчать нельзя.
    await recordFailure(userId, {
      stage: 'ingest',
      media: 'photo',
      reason: 'download_failed',
      detail: 'photo update без file_id',
    });
    return;
  }

  const photoFileId: string = fileId;

  /** Отказ до Vision: сырьё и подпись остаются в инбоксе, повтор — кнопкой. */
  const fail = async (
    reason: PhotoFailureReason,
    detail?: unknown,
    errors?: string[],
    metaExtra?: Record<string, unknown>,
  ): Promise<void> => {
    if (detail !== undefined) console.warn(`photo: ${reason}`, detail);
    await recordFailure(userId, {
      stage: 'ingest',
      media: 'photo',
      reason: reason === 'download' ? 'download_failed' : 'vision_failed',
      detail: errorDetail(detail) ?? errors?.[0] ?? null,
    });
    const note = await savePhotoRecoveryNote({
      userId,
      fileId: photoFileId,
      caption: cleanCaption,
      messageId,
      reason,
      errors,
      metaExtra,
      sourceType,
      previous: recoveryNote ?? null,
    });

    const reported = errors?.[0] ? ` — ${escapeAmpLtGt(truncate(errors[0], 120))}` : '';
    const captionLine = cleanCaption
      ? `\n\n<i>${escapeAmpLtGt(truncate(cleanCaption, 200))}</i>`
      : '';

    await safeAnswer(
      chatId,
      `${captionNotice}${PHOTO_FAILURE_REPLY[reason]}${reported}${captionLine}${PHOTO_RECOVERY_HINT}`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: '🔁 Повторить', callback_data: `retry_photo:${note.id}` }],
          ],
        },
        isHtml: true,
      },
    );
  };

  await api.sendChatAction({ chat_id: chatId, action: 'typing' });

  // [public-only] Лимит расходов на общий ключ: без него Vision не вызываем,
  // фото сохраняем в инбокс сырым.
  const photoSpend = await checkSpendLimit(userId);
  if (!photoSpend.allowed) {
    const user = await getUser(userId);
    const note = await createNote(userId, cleanCaption ? `#photo ${cleanCaption}` : '#photo', {
      column: 'raw',
      sourceType,
      fileId: photoFileId,
      metadata: { caption: cleanCaption, type: 'photo_raw', spend_limit_exceeded: true },
    });
    await safeAnswer(
      chatId,
      `📸 <b>Фото сохранено в инбокс без AI-распознавания.</b>\n\n${spendLimitExceededMessage(user?.language)}`,
      {
        replyMarkup: {
          inline_keyboard: [[{ text: '🗑️ Отменить', callback_data: `undo_note:${note.id}` }]],
        },
        isHtml: true,
      },
    );
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await api.getFileContent(photoFileId);
  } catch (err) {
    await fail('download', err);
    return;
  }

  const [accounts, customChapter] = await Promise.all([
    listAccounts(userId),
    getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG),
  ]);

  const result = await analyzeImageContent(bytes, {
    userId,
    caption: cleanCaption,
    mimeType: params.mimeType ?? 'image/jpeg',
    accounts,
    customInstructions: customChapter?.content ?? null,
  });

  // Распознавание не удалось: причина едет в заметку, metadata и ответ, а
  // повтор перезапускает только распознавание.
  if (result.isFallback) {
    await fail(
      'vision',
      undefined,
      result.errors.length > 0 ? result.errors : undefined,
      {
        ...buildVisionMeta(result, cleanCaption),
        ...(captionWriteFailure ? { [FINANCE_UNCONFIRMED_KIND]: captionWriteFailure } : {}),
      },
    );
    return;
  }

  // 3. Остатки на счетах: это состояние счёта, а не операция и не заметка.
  //    Проверяется до чека и до инбокса: скриншот банка не должен становиться
  //    ни расходом, ни «сохранено в инбокс». Признак — валидный непустой
  //    `balance[]`, а не `type`: банковский экран часто приходит как `general`.
  const imageHash = sha256Hex(bytes);

  // Остаток был на экране, но ни одна строка не прошла нормализацию: сумма или
  // валюта не прочитались. Раньше такой снимок молча уходил в общий инбокс и
  // выглядел как «остаток учтён» — теперь причина названа, а снимок сохранён
  // для повтора. Сюда же попадает экран, который модель сама назвала остатком
  // (`type: 'balance'`), но не дала ни одной строки: молчание тут невозможно
  // отличить от «денег на экране нет».
  const rejectedBalances = result.balanceRejected ?? 0;
  // Экран назван остатком, но из него не взято больше ничего: молчание тут
  // невозможно отличить от «денег на экране нет». Если модель вытащила из того
  // же изображения чек, счёт на оплату или текст, обычный разбор важнее.
  const looksLikeBalance =
    result.type === 'balance' &&
    result.receipt === null &&
    result.invoice === null &&
    result.tasks.length === 0 &&
    result.textContent === '';
  if (result.balance.length === 0 && (rejectedBalances > 0 || looksLikeBalance)) {
    await savePhotoRecoveryNote({
      userId,
      fileId: photoFileId,
      caption: cleanCaption,
      messageId,
      reason: 'vision',
      metaExtra: {
        ...buildVisionMeta(result, cleanCaption),
        ...(rejectedBalances > 0 ? { balance_rejected: rejectedBalances } : {}),
      },
      textOverride: `${BALANCE_REJECTED_TEXT}\n\nРаспознано: ${truncate(result.summary, 300)}`,
      sourceType,
      previous: recoveryNote ?? null,
    });
    await safeAnswer(chatId, `${captionNotice}${BALANCE_REJECTED_TEXT}`, {
      replyMarkup: getMainKeyboard(),
    });
    return;
  }

  if (result.balance.length > 0) {
    const outcome = await applyBalanceSnapshot({
      userId,
      snapshots: result.balance,
      imageHash,
      messageObservedAt,
    });

    if (outcome.status === 'applied') {
      // Потерянная при нормализации строка тоже называется: «обновлено» над
      // снимком, где часть полок не прочиталась, иначе вводило бы в заблуждение.
      const unreadNotice =
        rejectedBalances > 0
          ? `⚠️ Не прочитано строк остатка: ${rejectedBalances}.`
          : '';
      const appliedText = [
        `${captionNotice}${formatBalanceAppliedReply(outcome.rows)}`,
        formatBalanceSkippedNotice(outcome.skipped),
        unreadNotice,
      ]
        .filter((part) => part !== '')
        .join('\n\n');
      await safeAnswer(chatId, appliedText, {
        replyMarkup: getMainKeyboard(),
        isHtml: true,
      });
      if (recoveryNote) {
        await markFailureRecovered(userId, {
          stage: 'ingest',
          media: 'photo',
          reason: recoveryNote.meta.reason === 'download' ? 'download_failed' : 'vision_failed',
        });
        await deleteNote(userId, recoveryNote.id);
      }
      if (outcome.pendingUnmapped) {
        const unmapped = outcome.pendingUnmapped;
        await sendPendingBalancePrompt({
          userId,
          chatId,
          photoFileId,
          cleanCaption,
          messageId,
          sourceType,
          result,
          imageHash,
          messageObservedAt,
          headline: formatBalanceUnmappedText(unmapped.detail, unmapped.snapshot),
          detail: unmapped.detail,
          choices: unmapped.choices,
          snapshots: [unmapped.snapshot],
          failedIndex: 0,
          snapshotName: unmapped.snapshot.accountName?.trim() ?? '',
          previousRecoveryNote: null,
          isPartialPending: true,
          remainingCount: unmapped.remainingCount,
        });
      }
      return;
    }

    if (outcome.status === 'duplicate') {
      await safeAnswer(chatId, BALANCE_DUPLICATE_TEXT, { replyMarkup: getMainKeyboard() });
      return;
    }

    if (outcome.status === 'stale') {
      await safeAnswer(chatId, BALANCE_STALE_TEXT, { replyMarkup: getMainKeyboard() });
      return;
    }

    // Не сопоставили: одна заметка с причиной и кнопкой повтора, состояние
    // счетов не тронуто. Дальше в чек и общий инбокс не идём — иначе тот же
    // экран превратился бы в расход.
    //
    // Если среди счетов есть из чего выбирать, вместо тупика предлагаем кнопки
    // (до пяти) и ждём нажатия: догадка в деньгах недопустима.
    const printed = result.balance[0] ?? null;
    const failedSnapshot = result.balance[outcome.failedIndex] ?? printed;
    const headline =
      outcome.failedIndex < 0
        ? `⚠️ Баланс не изменён.\nПричина: ${outcome.detail}.`
        : formatBalanceUnmappedText(outcome.detail, failedSnapshot);
    await sendPendingBalancePrompt({
      userId,
      chatId,
      photoFileId,
      cleanCaption,
      messageId,
      sourceType,
      result,
      imageHash,
      messageObservedAt,
      headline,
      detail: outcome.detail,
      choices: outcome.choices,
      snapshots: result.balance,
      failedIndex: outcome.failedIndex,
      snapshotName: failedSnapshot?.accountName?.trim() ?? '',
      previousRecoveryNote: recoveryNote ?? null,
      captionPrefix: captionNotice,
      remainingCount: outcome.remainingCount,
    });
    return;
  }

  // 4. Счёт на оплату: это обязательство, а не расход (деньги ещё не ушли).
  let invoiceNotice = '';
  if (result.invoice) {
    const invoice = result.invoice;
    const complete =
      invoice.payee !== null &&
      invoice.amountCents !== null &&
      invoice.amountCents > 0 &&
      invoice.currency !== null &&
      invoice.dueDate !== null;

    if (!complete) {
      // Ноль и «суммы нет» — разные вещи: ноль распознан, но в книгу не идёт.
      invoiceNotice =
        invoice.amountCents === 0
          ? '📄 <b>Сумма 0 — счёт не записан.</b> Ноль в книгу не идёт: ' +
            'ни обязательства, ни расхода.\n\n'
          : '📄 <b>Счёт не разобран:</b> нет получателя, суммы или срока оплаты. ' +
            'В обязательства не записан.\n\n';
    } else if (!replay) {
      const outcome = await applyInvoice({
        userId,
        invoice: {
          ...invoice,
          payee: invoice.payee!,
          amountCents: invoice.amountCents!,
          currency: invoice.currency!,
          dueDate: invoice.dueDate!,
        },
        imageHash,
      });

      if (outcome.status === 'duplicate') {
        await safeAnswer(chatId, INVOICE_DUPLICATE_TEXT, { replyMarkup: getMainKeyboard() });
        return;
      }

      await safeAnswer(
        chatId,
        `${captionNotice}✅ <b>Счёт добавлен в обязательства:</b>\n` +
          `• ${escapeAmpLtGt(outcome.name)}\n` +
          `• Сумма: <b>${formatCentsWithSuffix(outcome.amountCents, outcome.currency)}</b>\n` +
          `• Оплатить до: ${outcome.dueDate}`,
        { replyMarkup: getMainKeyboard(), isHtml: true },
      );
      return;
    }
  }

  // 5. Чек с распознанной итоговой суммой -> запись расхода.
  let receiptNotice = '';
  let receiptFailure: Record<string, unknown> | undefined;

  if (result.type === 'receipt' && result.receipt) {
    const receipt = result.receipt;
    const total = receipt.total;

    if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
      const curr = resolveCurr(receipt.currency, 'EUR');
      const merchant = receipt.merchant || 'Чек';
      const itemsPart =
        receipt.items && receipt.items.length > 0 ? `: ${receipt.items.slice(0, 3).join(', ')}` : '';
      const desc = `${merchant}${itemsPart}`;

      const intent: ParsedFinancialIntent = {
        action: 'expense',
        type: 'expense',
        amount: total,
        currency: curr,
        category: receipt.category || 'Супермаркет',
        description: desc,
      };

      if (replay) {
        // Повтор распознал чек, но денежную операцию не повторяет.
        receiptNotice = RECEIPT_REPLAY_NOT_BOOKED;
      } else if (captionWriteFailure) {
        // Подпись уже пыталась провести операцию с неизвестным результатом:
        // второй проход по деньгам закрыт, о чеке говорим честно.
        receiptNotice = '';
      } else {
        try {
          const finRes = await executeFinancialIntent(userId, intent, cleanCaption || result.summary);
          const reply =
            `🧾 <b>Чек распознан и записан:</b>\n` +
            `• ${escapeAmpLtGt(desc)}\n` +
            `• Сумма: <b>${formatCents(toCents(total))} ${curr}</b>\n\n` +
            `${finRes.replyText}`;

          await safeAnswer(chatId, reply, {
            replyMarkup: buildUndoWithAppKeyboard(`undo_tx:${finRes.transactionId}`, 'finances'),
            isHtml: true,
          });
          return;
        } catch (err) {
          // Чек распознан, но провести его нельзя: картинку всё равно сохраняем
          // в инбокс, а отказ проговариваем в том же ответе. Распознанная сумма
          // остаётся в metadata в обоих случаях, чтобы её не пришлось вычитывать
          // из текста заметки.
          const reasonText = err instanceof Error ? err.message : String(err);
          if (isInsufficientFundsError(err)) {
            receiptNotice = `${formatDebitRefusal(err)}\n\n`;
            receiptFailure = {
              kind: RECEIPT_FAILURE_KIND,
              reason: 'insufficient_funds',
              total,
              currency: curr,
              merchant,
              error: truncate(reasonText, 200),
              at: nowIso(),
            };
          } else {
            // Результат попытки неизвестен: повторять проведение нельзя, поэтому
            // кнопки повтора у такой заметки нет — только сумма и причина.
            console.warn('Receipt recording error:', err);
            await recordFailure(userId, {
              stage: 'receipt',
              media: 'photo',
              reason: 'storage_failed',
              detail: reasonText,
            });
            receiptNotice = receiptFailureText(total, curr, reasonText);
            receiptFailure = {
              kind: RECEIPT_FAILURE_KIND,
              reason: 'unknown',
              total,
              currency: curr,
              merchant,
              error: truncate(reasonText, 200),
              at: nowIso(),
            };
          }
        }
      }
    }
  }

  // 6. Общий случай: сохранение распознанного изображения в инбокс заметок.
  const noteContent = formatVisionInboxText(result);
  const meta = buildVisionMeta(result, cleanCaption);
  if (receiptFailure) meta[RECEIPT_FAILURE_KIND] = receiptFailure;
  if (captionWriteFailure) meta[FINANCE_UNCONFIRMED_KIND] = captionWriteFailure;

  const note = await createNote(userId, noteContent, {
    column: 'raw',
    sourceType,
    fileId: photoFileId,
    sourceMessageId: messageId ?? null,
    metadata: meta,
  });

  const summary =
    `${captionNotice}${invoiceNotice}${receiptNotice}` +
    '📸 <b>Изображение сохранено в инбокс:</b>\n\n' +
    `<i>${escapeAmpLtGt(result.summary)}</i>` +
    (result.textContent && result.textContent !== result.summary
      ? `\n\n<blockquote expandable>${escapeAmpLtGt(result.textContent)}</blockquote>`
      : '');

  await safeAnswer(chatId, summary, {
    replyMarkup: buildUndoWithAppKeyboard(`undo_note:${note.id}`, `note_${note.id}`),
    isHtml: true,
  });

  // Результат уже сохранён: только теперь аварийная заглушка уходит в корзину.
  if (recoveryNote) {
    await markFailureRecovered(userId, {
      stage: 'ingest',
      media: 'photo',
      reason: recoveryNote.meta.reason === 'download' ? 'download_failed' : 'vision_failed',
    });
    await deleteNote(userId, recoveryNote.id);
  }
}

/**
 * Повтор распознавания по сохранённому `file_id` (`retry_photo:<noteId>`).
 *
 * Владелец заметки проверяется вызывающей стороной (`claimPhotoRecovery`):
 * сюда попадает только своя аварийная запись, и только для стадий **до**
 * возможной финансовой записи.
 */
export async function retryPhotoRecovery(params: {
  userId: number;
  chatId: number;
  noteId: number;
  meta: PhotoRecoveryMeta;
}): Promise<void> {
  await runPhotoPipeline({
    userId: params.userId,
    chatId: params.chatId,
    fileId: params.meta.file_id,
    caption: params.meta.caption,
    messageId: params.meta.source_message_id ?? undefined,
    recoveryNote: { id: params.noteId, meta: params.meta },
  });
}

// ---------------------------------------------------------------------------
// «Проверка списаний»: решение владельца по обязательству за месяц
// ---------------------------------------------------------------------------

export interface LiabilityReviewChoiceResult {
  /** Текст всплывающего ответа; пусто — только погасить спиннер. */
  toast?: string;
  /** Показать ответ модальным окном (ошибка или отказ, а не подтверждение). */
  alert?: boolean;
}

const REVIEW_DECISION_BY_ACTION: Record<LiabilityReviewAction, LiabilityReviewDecision> = {
  p: 'paid',
  n: 'unpaid',
  d: 'deleted',
};

const REVIEW_TOAST: Record<LiabilityReviewDecision, string> = {
  paid: '✅ Отмечено: оплачено',
  unpaid: '📝 Отмечено: не оплачено',
  deleted: '🗑️ Обязательство удалено',
};

/** Не текущий месяц: решение не пишется вообще, даже в `kv`. */
export const LIABILITY_REVIEW_STALE_TOAST =
  '⌛ Это не текущий месяц — решение не записано.';

/** Повтор или другое действие: первое решение уже победило. */
export const LIABILITY_REVIEW_TAKEN_TOAST =
  'ℹ️ Решение за этот месяц уже принято — ничего не меняю.';

/** Финансовое действие не прошло: метку сняли, можно повторить. */
export const LIABILITY_REVIEW_FAILED_TOAST =
  '⚠️ Не удалось применить решение — попробуй ещё раз.';

const inFlightLiabilityClaims = new Set<string>();

function parseLiabilityReviewStatus(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return (JSON.parse(raw) as { status?: unknown } | null)?.status;
  } catch {
    return undefined;
  }
}

/**
 * Решение по пункту «Проверки списаний» (`lrev:<id>:<YYYY-MM>:<p|n|d>`).
 *
 * Порядок важен: сначала `kvSetIfAbsent` со статусом `pending`, потом деньги,
 * затем финализация в `done`. Метка — это claim: двойное нажатие и второе,
 * другое действие получают тост без записей, а повторный `p` не уменьшает долг
 * ещё раз. Если финансовое действие и снятие claim оба упали, `pending`-метка
 * позволяет повтору перехватить зависший claim и довести операцию. «Оплатил»
 * проводит `payLiability` с `deductFromAccount: false`: месяц уходит в
 * `paid_months`, остаток долга уменьшается, счета и `transactions` не трогаются.
 * «Не оплатил» пишет только решение. «Удалить» стирает обязательство; прошлые
 * транзакции не откатываются.
 *
 * Callback из прошлого (или будущего) месяца ничего не меняет: месяц сверяется
 * с локальным месяцем пользователя, а не с датой устройства.
 */
export async function applyLiabilityReviewChoice(params: {
  userId: number;
  data: string;
  now?: Date;
}): Promise<LiabilityReviewChoiceResult> {
  const parsed = parseLiabilityReviewCallback(params.data);
  if (!parsed) return { toast: '⚠️ Не понимаю эту кнопку', alert: true };

  const now = params.now ?? new Date();
  const timeZone = (await getUser(params.userId))?.timezone ?? 'Europe/Berlin';
  if (parsed.month !== monthKey(now, timeZone)) {
    return { toast: LIABILITY_REVIEW_STALE_TOAST };
  }

  const liability = await getLiability(params.userId, parsed.liabilityId);
  if (!liability || !liability.isActive) {
    return { toast: '⚠️ Обязательство не найдено или закрыто — ничего не меняю', alert: true };
  }

  const dueKey = liabilityReviewDueDate(liability, now, timeZone);
  if (!dueKey || dueKey.slice(0, 7) !== parsed.month) {
    return { toast: '⚠️ У этого обязательства нет платежа в текущем месяце', alert: true };
  }

  const decision = REVIEW_DECISION_BY_ACTION[parsed.action];
  const key = liabilityReviewKey(params.userId, liability.id, parsed.month);
  if (inFlightLiabilityClaims.has(key)) {
    return { toast: LIABILITY_REVIEW_TAKEN_TOAST };
  }

  const record: LiabilityReviewRecord = { decision, decidedAt: toIso(now), dueAt: dueKey };

  inFlightLiabilityClaims.add(key);
  try {
    const pendingPayload = JSON.stringify({ ...record, status: 'pending' });
    const claimed = await kvSetIfAbsent(key, pendingPayload);
    if (!claimed) {
      const existing = await kvGet(key);
      if (parseLiabilityReviewStatus(existing) === 'pending') {
        await kvSet(key, pendingPayload);
      } else {
        return { toast: LIABILITY_REVIEW_TAKEN_TOAST };
      }
    }

    try {
      let result: LiabilityReviewChoiceResult = { toast: REVIEW_TOAST[decision] };

      if (decision === 'paid') {
        const paid = await payLiability(params.userId, {
          liabilityId: liability.id,
          paymentDate: dueKey,
          deductFromAccount: false,
        });
        result = {
          toast: paid.alreadyPaid
            ? '✅ Платёж этого месяца уже был отмечен — долг не меняю'
            : REVIEW_TOAST.paid,
        };
      } else if (decision === 'deleted') {
        if (!(await deleteLiability(params.userId, liability.id))) {
          await kvDelete(key);
          return { toast: '⚠️ Обязательство уже удалено', alert: true };
        }
      }

      try {
        await kvSet(key, JSON.stringify({ ...record, status: 'done' }));
      } catch (finalizeErr) {
        console.warn('liability review: decision finalize failed', liability.id, finalizeErr);
      }

      return result;
    } catch (err) {
      // Решение не применилось: снимаем claim, иначе повтор кнопки молча говорил
      // бы «уже принято», хотя финансовой записи нет.
      try {
        await kvDelete(key);
      } catch (deleteErr) {
        console.warn('liability review: decision release failed', liability.id, deleteErr);
      }
      console.warn('liability review: decision failed', liability.id, err);
      return { toast: LIABILITY_REVIEW_FAILED_TOAST, alert: true };
    }
  } finally {
    inFlightLiabilityClaims.delete(key);
  }
}
