/**
 * Deep module: координация и регистрация обработчиков созревших задач (due_jobs).
 *
 * Связывает доменные обработчики (ночная консолидация заметок, обслуживание
 * хранилища) с ленивым планировщиком DAL. Идемпотентно гарантирует регистрацию
 * обработчиков при старте или первом обращении перед вызовом `runDueJobs()`.
 *
 * `runReminderClock` — единственный проход напоминаний, общий для касаний, RPC
 * и будущего внешнего тика.
 */

import { api, BotApiError } from 'sdk';

import { runAgent, type AgentChatFn } from './agent/engine.js';
import { listTools } from './agent/registry.js';
import { checkSpendLimit } from './billing.js';
import {
  hasJobHandler,
  registerJobHandler,
  runDueJobs,
  unregisterJobHandler,
  type RunDueJobsResult,
} from './dal/due_jobs.js';
import {
  CLOCK_STALL_AFTER_MINUTES,
  clockHeartbeatKey,
  kvDelete,
  kvGet,
  kvGetJson,
  kvSet,
  kvSetIfAbsent,
  kvSetJson,
  type ClockHeartbeat,
  type ReminderClockSource,
  type ReminderClockStatus,
} from './dal/misc.js';
import { getUser } from './dal/users.js';

export {
  CLOCK_STALL_AFTER_MINUTES,
  clockHeartbeatKey,
  type ClockHeartbeat,
  type ReminderClockSource,
  type ReminderClockStatus,
};
import {
  runNightlyConsolidation,
  scheduleNightlyConsolidation,
  type ConsolidationResult,
} from './consolidation.js';
import { buildMorningDigest } from './digest.js';
import { markdownToTelegramHtml, splitMessageChunks } from './markdown.js';
import {
  evaluateRoutineSchedule,
  isInQuietHours,
  loadUserPrefs,
  routineRunKey,
  type CustomRoutine,
  type UserPrefs,
} from './prefs.js';
import {
  deliverDueReminders,
  deliverLiabilityWarnings,
  deliverMedicationReminders,
  deliverMorningDigest,
  pruneStaleKvLabels,
  type KvLabelPruneResult,
} from './reminders.js';
import {
  balanceSummary,
  debtsSummary,
  medsSummary,
  quickSummary,
  tasksSummary,
} from './summary.js';
import { recordFailure } from './evolution.js';
import { toIso } from './utils.js';
import type { DueJobRow } from '../types.js';

export interface EnsureJobHandlersOptions {
  /** Принудительно перерегистрировать обработчики даже если они уже в реестре. */
  force?: boolean;
  consolidation?: { hour?: number; timeZone?: string };
}

/**
 * Метка «чистка меток напоминаний уже была сегодня». Один ключ, а не ключ на
 * сутки: перезаписывается каждые сутки и сам не копится.
 */
export const KV_PRUNE_MARKER_KEY = 'kv_prune:last_run';

/**
 * Прогоняет чистку протухших меток идемпотентности не чаще одного раза в сутки
 * (по UTC-дате). Возвращает результат прогона либо `null`, если сегодня уже
 * чистили.
 *
 * Маркер пишется только после успешной чистки: упавший проход повторится на
 * следующем касании бота, а не пропустит сутки.
 */
export async function runDailyKvPrune(
  options: { now?: Date } = {},
): Promise<KvLabelPruneResult | null> {
  const now = options.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  if ((await kvGet(KV_PRUNE_MARKER_KEY)) === day) return null;
  const result = await pruneStaleKvLabels({ now });
  await kvSet(KV_PRUNE_MARKER_KEY, day);
  return result;
}

export interface ReminderClockOptions {
  /** Момент, общий для всех доставщиков: доза или сводка не пересекает полночь между вызовами. */
  now?: Date | string;
  source?: ReminderClockSource;
  /** Чат для доставки (по умолчанию — личный `userId`). */
  chatId?: number;
  /** Тестовая подмена LLM-функции для AI-рутин. */
  chatFn?: AgentChatFn;
}

export interface ReminderClockKindOutcome {
  status: ReminderClockStatus;
  delivered: number;
  failed: number;
  skipped: number;
  expired: number;
  error?: string;
}

export interface ReminderClockOutcome {
  source: ReminderClockSource;
  at: string | null;
  delivered: number;
  failed: number;
  skipped: number;
  expired: number;
  kinds: {
    task_reminder: ReminderClockKindOutcome;
    liability_warning: ReminderClockKindOutcome;
    medication_reminder: ReminderClockKindOutcome;
    morning_digest: ReminderClockKindOutcome;
    custom_routines: ReminderClockKindOutcome;
  };
}

/**
 * Один JSON на пользователя: только счётчики и метки времени, без текстов
 * сообщений, сумм и идентификаторов сущностей. Touch не подменяет внешний
 * heartbeat: иначе молчащий будильник выглядел бы работающим.
 */
async function writeClockHeartbeat(userId: number, outcome: ReminderClockOutcome): Promise<void> {
  const key = clockHeartbeatKey(userId);
  const previous = await kvGetJson<ClockHeartbeat | null>(key, null);
  const at = outcome.at ?? new Date().toISOString();
  const isExternal = outcome.source === 'external';
  const kindsFor = (o: ReminderClockOutcome): ClockHeartbeat['kinds'] => ({
    task_reminder: o.kinds.task_reminder.status,
    liability_warning: o.kinds.liability_warning.status,
    medication_reminder: o.kinds.medication_reminder.status,
    morning_digest: o.kinds.morning_digest.status,
    custom_routines: o.kinds.custom_routines.status,
  });
  const next: ClockHeartbeat = {
    lastTouchAt: previous?.lastTouchAt ?? null,
    lastExternalAttemptAt: previous?.lastExternalAttemptAt ?? null,
    lastExternalSuccessAt: previous?.lastExternalSuccessAt ?? null,
    // Касание и RPC не затирают снимок последнего ВНЕШНЕГО прохода, иначе
    // маркер «сводка оборвана» исчезает раньше, чем его прочитает /diagnostics.
    source: isExternal ? outcome.source : (previous?.source ?? outcome.source),
    delivered: isExternal ? outcome.delivered : (previous?.delivered ?? outcome.delivered),
    failed: isExternal ? outcome.failed : (previous?.failed ?? outcome.failed),
    kinds: isExternal ? kindsFor(outcome) : (previous?.kinds ?? kindsFor(outcome)),
  };
  if (outcome.source === 'external') {
    next.lastExternalAttemptAt = at;
    if (outcome.failed === 0) next.lastExternalSuccessAt = at;
  } else {
    next.lastTouchAt = at;
  }
  await kvSetJson(key, next);
}

function countOutcome(result: unknown): ReminderClockKindOutcome {
  const source = (result ?? {}) as {
    delivered?: unknown;
    failed?: unknown;
    skipped?: unknown;
    expired?: unknown;
  };
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const delivered = num(source.delivered);
  const failed = num(source.failed);
  const skipped = num(source.skipped);
  const expired = num(source.expired);
  const status: ReminderClockStatus = failed > 0 ? 'failed' : delivered > 0 ? 'delivered' : 'skipped';
  return { status, delivered, failed, skipped, expired };
}

function failedOutcome(error: unknown): ReminderClockKindOutcome {
  return {
    status: 'failed',
    delivered: 0,
    failed: 1,
    skipped: 0,
    expired: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Сбой доставки в журнал: запись не роняет проход и не меняет исход вида. */
async function journalDeliveryFailure(
  userId: number,
  deliverer: string,
  error: unknown,
): Promise<void> {
  try {
    // Имя доставщика идёт в сигнатуру: сбой одного вида — свой кластер,
    // а не общее ведро на все четыре.
    await recordFailure(userId, {
      stage: 'delivery',
      reason: 'delivery_failed',
      tool: deliverer,
      detail: `${deliverer}: ${error instanceof Error ? error.message : String(error)}`,
    });
  } catch (journalError) {
    console.warn('jobs: delivery failure journal write failed', journalError);
  }
}

const BACKGROUND_ROUTINE_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'manage_routines',
  'reset_or_rollback_settings',
]);

async function renderSummaryRoutine(
  userId: number,
  routine: CustomRoutine,
  now: Date,
): Promise<string> {
  switch (routine.summaryKind) {
    case 'balance':
      return balanceSummary(userId, { now });
    case 'debts':
      return debtsSummary(userId, { now });
    case 'tasks':
      return tasksSummary(userId, { now });
    case 'meds':
      return medsSummary(userId, { now });
    case 'digest':
      return buildMorningDigest(userId, { now });
    case 'quick':
    default:
      return quickSummary(userId, { now });
  }
}

async function renderRoutineMessage(
  userId: number,
  routine: CustomRoutine,
  now: Date,
  chatFn?: AgentChatFn,
): Promise<string> {
  if (routine.kind === 'text') {
    return `⏰ **${routine.name}**\n\n${routine.message ?? ''}`.trim();
  }
  if (routine.kind === 'summary') {
    const body = await renderSummaryRoutine(userId, routine, now);
    return `⏰ **${routine.name}**\n\n${body}`;
  }

  const allowWrites = routine.toolAccess === 'allow_writes';
  const allTools = listTools();
  const allowedTools = allowWrites
    ? allTools.filter(
        (tool) => tool.effect.kind !== 'destroy' && !BACKGROUND_ROUTINE_FORBIDDEN_TOOLS.has(tool.name),
      )
    : allTools.filter((tool) => tool.effect.kind === 'read');

  const agentResult = await runAgent({
    userId,
    text: routine.prompt ?? routine.name,
    mode: 'auto',
    maxSteps: 4,
    turnBudgetMs: 12_000,
    store: null,
    tools: allowedTools,
    toolAccess: allowWrites ? 'full' : 'read-only',
    background: true,
    backgroundDirective:
      'Это фоновый запуск регулярной рутины по расписанию (без истории диалога). ' +
      'Не задавай уточняющих вопросов, используй только доступные инструменты и сразу сформируй короткое полезное сообщение для Telegram.',
    now,
    ...(chatFn ? { chatFn } : {}),
  });

  if (agentResult.stopReason === 'llm_error' || !agentResult.reply.trim()) {
    throw new Error(`AI routine ${routine.id} failed (${agentResult.stopReason})`);
  }

  return `🤖 **${routine.name}**\n\n${agentResult.reply.trim()}`;
}

export interface CustomRoutineDeliveryResult {
  delivered: number;
  failed: number;
  skipped: number;
  expired: number;
}

/**
 * Доставка кастомных регулярных рутин из `user_prefs.proactive.routines`.
 * Выполняется в общем цикле `runReminderClock`: уважает `quietHours`, дедуплицирует
 * срабатывания через `kv` (`routine_run:<uid>:<id>:<triggerDayKey>`), не пускает
 * AI-рутины с `rpc`-источника и ограничивает `touch` 1 AI-рутиной за проход.
 */
export async function deliverCustomRoutines(
  userId: number,
  options: {
    now?: Date | string;
    source?: ReminderClockSource;
    chatId?: number;
    chatFn?: AgentChatFn;
  } = {},
): Promise<CustomRoutineDeliveryResult> {
  const result: CustomRoutineDeliveryResult = {
    delivered: 0,
    failed: 0,
    skipped: 0,
    expired: 0,
  };
  const rawNow = options.now ?? new Date();
  const now = rawNow instanceof Date ? rawNow : new Date(rawNow);
  if (Number.isNaN(now.getTime())) return result;

  const [user, prefs] = await Promise.all([
    getUser(userId).catch(() => null),
    loadUserPrefs(userId).catch((): UserPrefs => ({})),
  ]);
  const routinesMap = prefs.proactive?.routines;
  if (!user || !routinesMap) return result;

  const routines = Object.values(routinesMap).sort(
    (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
  );
  if (routines.length === 0) return result;

  const timeZone = user.timezone ?? 'Europe/Berlin';
  const source: ReminderClockSource = options.source ?? 'touch';
  const chatId = options.chatId ?? userId;
  let aiExecutedInPass = 0;

  for (const routine of routines) {
    const evalResult = evaluateRoutineSchedule(routine, now, timeZone);
    if (!evalResult.due || !evalResult.triggerDayKey) continue;

    if (
      routine.respectQuietHours !== false &&
      isInQuietHours(now, timeZone, prefs.proactive?.quietHours)
    ) {
      result.skipped += 1;
      continue;
    }

    const key = routineRunKey(userId, routine.id, evalResult.triggerDayKey);
    if ((await kvGet(key)) !== null) {
      result.skipped += 1;
      continue;
    }

    if (routine.kind === 'ai') {
      if (source === 'rpc') {
        result.skipped += 1;
        continue;
      }
      if (source === 'touch' && aiExecutedInPass >= 1) {
        result.skipped += 1;
        continue;
      }
      const spend = await checkSpendLimit(userId, user.modelProvider ?? 'gemini');
      if (!spend.allowed) {
        result.skipped += 1;
        continue;
      }
    }

    const claimed = await kvSetIfAbsent(
      key,
      JSON.stringify({
        triggerDate: evalResult.triggerDayKey,
        ranAt: toIso(now),
        kind: routine.kind,
      }),
    );
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    if (routine.kind === 'ai') {
      aiExecutedInPass += 1;
    }

    let sentChunks = 0;
    try {
      const markdown = await renderRoutineMessage(userId, routine, now, options.chatFn);
      const html = markdownToTelegramHtml(markdown);
      const chunks = splitMessageChunks(html);
      for (const chunk of chunks) {
        await api.sendMessage({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'HTML',
        });
        sentChunks += 1;
      }
      result.delivered += 1;
    } catch (err) {
      const permanent = err instanceof BotApiError && (err.code === 400 || err.code === 403);
      if (!permanent && sentChunks === 0) {
        try {
          await kvDelete(key);
        } catch (deleteErr) {
          console.warn('jobs: custom routine claim release failed', userId, routine.id, deleteErr);
        }
      }
      result.failed += 1;
      await journalDeliveryFailure(userId, `deliverCustomRoutines:${routine.id}`, err);
    }
  }

  return result;
}

/**
 * Один проход напоминаний: задачи, обязательства, дозы, утренняя сводка и кастомные рутины.
 *
 * Все пять видов получают один и тот же `now`, каждый идёт в своём `try`:
 * сбой одного не гасит остальные. Заглушек и новых уведомлений не появляется —
 * это координация существующих доставщиков и кастомных рутин пользователя.
 */
export async function runReminderClock(
  userId: number,
  options: ReminderClockOptions = {},
): Promise<ReminderClockOutcome> {
  const now = options.now ?? new Date();
  const source: ReminderClockSource = options.source ?? 'touch';
  const atDate = now instanceof Date ? now : new Date(now);
  const at = Number.isNaN(atDate.getTime()) ? null : atDate.toISOString();
  const empty = (): ReminderClockKindOutcome => ({
    status: 'skipped',
    delivered: 0,
    failed: 0,
    skipped: 0,
    expired: 0,
  });
  const kinds: ReminderClockOutcome['kinds'] = {
    task_reminder: empty(),
    liability_warning: empty(),
    medication_reminder: empty(),
    morning_digest: empty(),
    custom_routines: empty(),
  };

  try {
    kinds.task_reminder = countOutcome(
      await deliverDueReminders(userId, { now, ...(options.chatId !== undefined ? { chatId: options.chatId } : {}) }),
    );
  } catch (err) {
    kinds.task_reminder = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverDueReminders', err);
  }

  try {
    kinds.liability_warning = countOutcome(
      await deliverLiabilityWarnings(userId, { now, ...(options.chatId !== undefined ? { chatId: options.chatId } : {}) }),
    );
  } catch (err) {
    kinds.liability_warning = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverLiabilityWarnings', err);
  }

  try {
    kinds.medication_reminder = countOutcome(
      await deliverMedicationReminders(userId, { now, ...(options.chatId !== undefined ? { chatId: options.chatId } : {}) }),
    );
  } catch (err) {
    kinds.medication_reminder = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverMedicationReminders', err);
  }

  try {
    kinds.morning_digest = countOutcome(
      await deliverMorningDigest(userId, { now, ...(options.chatId !== undefined ? { chatId: options.chatId } : {}) }),
    );
  } catch (err) {
    kinds.morning_digest = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverMorningDigest', err);
  }

  try {
    kinds.custom_routines = countOutcome(
      await deliverCustomRoutines(userId, {
        now,
        source,
        ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
        ...(options.chatFn ? { chatFn: options.chatFn } : {}),
      }),
    );
  } catch (err) {
    kinds.custom_routines = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverCustomRoutines', err);
  }

  const totals = { delivered: 0, failed: 0, skipped: 0, expired: 0 };
  for (const key of [
    'task_reminder',
    'liability_warning',
    'medication_reminder',
    'morning_digest',
    'custom_routines',
  ] as const) {
    const kind = kinds[key];
    totals.delivered += kind.delivered;
    totals.failed += kind.failed;
    totals.skipped += kind.skipped;
    totals.expired += kind.expired;
  }

  const outcome: ReminderClockOutcome = { source, at, ...totals, kinds };
  try {
    await writeClockHeartbeat(userId, outcome);
  } catch (heartbeatError) {
    console.warn('jobs: clock heartbeat write failed', heartbeatError);
  }
  return outcome;
}

/**
 * Регистрирует обработчик ночной задачи: чистка хранилища, затем консолидация.
 *
 * Делегирование то же, что в `registerConsolidationHandler`, но без него:
 * обработчик на вид задачи в реестре один, поэтому чистка подмешивается здесь,
 * в единственной точке, которую реально дергает `runDueJobs` на каждом
 * касании бота. Сбой чистки не валит ночную задачу — она помечается `failed`
 * только по своей причине.
 */
function registerNightlyHandler(options: { hour?: number; timeZone?: string } = {}): void {
  registerJobHandler('nightly_consolidation', async (job: DueJobRow) => {
    try {
      await runDailyKvPrune();
    } catch (err) {
      console.warn('jobs: daily kv label prune failed', err);
    }
    const result: ConsolidationResult = await runNightlyConsolidation(job.userId, {
      timeZone: options.timeZone,
    });
    if (result.status === 'error') throw new Error(result.message);
    await scheduleNightlyConsolidation(job.userId, {
      hour: options.hour,
      timeZone: options.timeZone,
    });
  });
}

/**
 * Идемпотентно гарантирует регистрацию обработчиков для всех поддержанных
 * типов задач очереди `due_jobs`.
 *
 * В кодовой базе на данный момент реально ставится в очередь и имеет логику
 * обработчика только `nightly_consolidation` (чистка меток напоминаний едет
 * вместе с ним). Другие типы (`task_reminder`, `medication_reminder` и т.д.)
 * ещё не перенесены на `due_jobs` и не регистрируются, чтобы не эмулировать
 * фиктивное поведение.
 */
export function ensureJobHandlers(options: EnsureJobHandlersOptions = {}): void {
  if (options.force || !hasJobHandler('nightly_consolidation')) {
    registerNightlyHandler(options.consolidation);
  }
}

/**
 * Сброс зарегистрированных обработчиков (для изоляции тестовых прогонов).
 */
export function resetJobHandlers(): void {
  unregisterJobHandler('nightly_consolidation');
}

/**
 * Удобная обёртка: гарантирует регистрацию обработчиков и запускает созревшие задачи.
 */
export async function runScheduledJobs(
  now: string | Date = new Date(),
  limit?: number,
): Promise<RunDueJobsResult> {
  ensureJobHandlers();
  return runDueJobs(now, limit);
}
