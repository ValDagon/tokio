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

import {
  hasJobHandler,
  registerJobHandler,
  runDueJobs,
  unregisterJobHandler,
  type RunDueJobsResult,
} from './dal/due_jobs.js';
import { kvGet, kvGetJson, kvSet, kvSetJson } from './dal/misc.js';
import {
  runNightlyConsolidation,
  scheduleNightlyConsolidation,
  type ConsolidationResult,
} from './consolidation.js';
import {
  deliverDueReminders,
  deliverLiabilityWarnings,
  deliverMedicationReminders,
  deliverMorningDigest,
  pruneStaleKvLabels,
  type KvLabelPruneResult,
} from './reminders.js';
import { recordFailure } from './evolution.js';
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

export type ReminderClockSource = 'touch' | 'rpc' | 'external';

export interface ReminderClockOptions {
  /** Момент, общий для всех четырёх доставщиков: доза или сводка не пересекает полночь между вызовами. */
  now?: Date | string;
  source?: ReminderClockSource;
}

export type ReminderClockStatus = 'delivered' | 'skipped' | 'failed';

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
  };
}

export const CLOCK_STALL_AFTER_MINUTES = 45;

export function clockHeartbeatKey(userId: number): string {
  return `clock:v1:${userId}`;
}

export interface ClockHeartbeat {
  lastTouchAt: string | null;
  lastExternalAttemptAt: string | null;
  lastExternalSuccessAt: string | null;
  source: ReminderClockSource;
  delivered: number;
  failed: number;
  kinds: {
    task_reminder: ReminderClockStatus;
    liability_warning: ReminderClockStatus;
    medication_reminder: ReminderClockStatus;
    morning_digest: ReminderClockStatus;
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

/**
 * Один проход напоминаний: задачи, обязательства, дозы, утренняя сводка.
 *
 * Все четыре вида получают один и тот же `now`, каждый идёт в своём `try`:
 * сбой одного не гасит остальные. Заглушек и новых уведомлений не появляется —
 * это координация существующих доставщиков, а не второй планировщик.
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
  };

  try {
    kinds.task_reminder = countOutcome(await deliverDueReminders(userId, { now }));
  } catch (err) {
    kinds.task_reminder = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverDueReminders', err);
  }

  try {
    kinds.liability_warning = countOutcome(await deliverLiabilityWarnings(userId, { now }));
  } catch (err) {
    kinds.liability_warning = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverLiabilityWarnings', err);
  }

  try {
    kinds.medication_reminder = countOutcome(await deliverMedicationReminders(userId, { now }));
  } catch (err) {
    kinds.medication_reminder = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverMedicationReminders', err);
  }

  try {
    kinds.morning_digest = countOutcome(await deliverMorningDigest(userId, { now }));
  } catch (err) {
    kinds.morning_digest = failedOutcome(err);
    await journalDeliveryFailure(userId, 'deliverMorningDigest', err);
  }

  const totals = { delivered: 0, failed: 0, skipped: 0, expired: 0 };
  for (const key of [
    'task_reminder',
    'liability_warning',
    'medication_reminder',
    'morning_digest',
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
