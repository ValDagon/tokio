/**
 * DAL: ленивый планировщик на `due_jobs` (замена APScheduler, SPEC §2.6).
 *
 * В isolate нет ни `setTimeout`, ни фоновых процессов, поэтому «крон» выглядит
 * так: при каждом обращении бота (update/endpoint) вызывается `runDueJobs()`,
 * который атомарно забирает созревшие задачи и раздаёт их зарегистрированным
 * обработчикам. Сами обработчики (дайджест, напоминания, бэкап, чистка корзины)
 * подключаются в T18 через `registerJobHandler`.
 *
 * Инварианты:
 *  - `schedule()` идемпотентен по `(user_id, kind)`: если ожидающая задача уже
 *    есть, у неё обновляются `run_at`/`payload`, а не появляется дубль
 *    (UNIQUE-констрейнта на пару нет — поэтому checked-update + insert);
 *  - `dueJobs()` забирает задачу одним `UPDATE … RETURNING`: два параллельных
 *    вызова не получат одну и ту же строку (claim, а не просто SELECT);
 *  - `run_at` и `updated_at` — ISO-8601 UTC, сравнение лексикографическое,
 *    поэтому строки корректно фильтруются по времени;
 *  - неудача не теряет задачу бесследно: `status='failed'` + `last_error`.
 */

import { db, sql } from 'sdk/db';
import type { DueJobKind, DueJobRow, DueJobStatus, IsoTimestamp } from '../../types.js';

/** Сколько задач забирать за один проход, если не сказано иное. */
export const DEFAULT_DUE_LIMIT = 10;

/** Максимальная длина `last_error` — чтобы мусорный стектрейс не раздувал БД. */
const MAX_ERROR_LENGTH = 500;

const JOB_COLUMNS = `id, user_id, kind, run_at, payload, status, attempts, last_error,
  created_at, updated_at`;

// ---------------------------------------------------------------------------
// Строки БД ↔ доменные объекты
// ---------------------------------------------------------------------------

interface DueJobDbRow {
  id: number;
  user_id: number;
  kind: string;
  run_at: string;
  payload: string | null;
  status: string;
  attempts: number | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return {};
  } catch {
    return {};
  }
}

function mapJob(row: DueJobDbRow): DueJobRow {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    runAt: row.run_at,
    payload: parsePayload(row.payload),
    status: row.status as DueJobStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Момент времени: `Date` → ISO, строка — как есть (обрезаем до ISO). */
function toIsoMoment(value: IsoTimestamp | Date): IsoTimestamp {
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (!text) throw new Error('due_jobs: run_at is required');
  return text;
}

// ---------------------------------------------------------------------------
// Реестр обработчиков
// ---------------------------------------------------------------------------

/** Обработчик джобы: получает уже захваченную (status='running') задачу. */
export type JobHandler = (job: DueJobRow) => Promise<void> | void;

const handlers = new Map<string, JobHandler>();

/** Регистрирует обработчик для вида задачи (перезапись — можно на горячую). */
export function registerJobHandler(kind: DueJobKind | string, handler: JobHandler): void {
  const key = String(kind);
  if (!key) throw new Error('due_jobs: job kind is required');
  handlers.set(key, handler);
}

/** Снимает обработчик (нужно тестам и пересборке реестра). */
export function unregisterJobHandler(kind: DueJobKind | string): boolean {
  return handlers.delete(String(kind));
}

/** Есть ли обработчик для вида задачи. */
export function hasJobHandler(kind: DueJobKind | string): boolean {
  return handlers.has(String(kind));
}

/** Текущий набор зарегистрированных видов (диагностика). */
export function registeredJobKinds(): string[] {
  return [...handlers.keys()].sort();
}

// ---------------------------------------------------------------------------
// Постановка в очередь
// ---------------------------------------------------------------------------

/**
 * Ставит задачу в очередь. Если у пользователя уже есть ОЖИДАЮЩАЯ задача того
 * же вида — обновляет её время и payload (одна задача на вид, без дублей).
 */
export async function schedule(
  userId: number,
  kind: DueJobKind | string,
  runAt: IsoTimestamp | Date,
  payload: Record<string, unknown> = {},
): Promise<DueJobRow> {
  const key = String(kind ?? '').trim();
  if (!key) throw new Error('due_jobs.schedule: job kind is required');

  const now = new Date().toISOString();
  const when = toIsoMoment(runAt);
  const encoded = JSON.stringify(payload ?? {});

  const updated = await db.run(sql`
    UPDATE due_jobs
       SET run_at = ${when}, payload = ${encoded}, updated_at = ${now}
     WHERE user_id = ${userId} AND kind = ${key} AND status = 'pending'
  `);

  if (updated.rowsAffected > 0) {
    const existing = await db.get<DueJobDbRow>(sql`
      SELECT ${sql.raw(JOB_COLUMNS)}
        FROM due_jobs
       WHERE user_id = ${userId} AND kind = ${key} AND status = 'pending'
       LIMIT 1
    `);
    if (existing) return mapJob(existing);
  }

  const inserted = await db.run(sql`
    INSERT INTO due_jobs (user_id, kind, run_at, payload, status, attempts, created_at, updated_at)
    VALUES (${userId}, ${key}, ${when}, ${encoded}, 'pending', 0, ${now}, ${now})
    RETURNING ${sql.raw(JOB_COLUMNS)}
  `);
  const row = inserted.rows[0] as unknown as DueJobDbRow | undefined;
  if (!row) throw new Error('due_jobs.schedule: insert returned no row');
  return mapJob(row);
}

/**
 * Снимает ожидающие задачи вида у пользователя. Возвращает число отменённых.
 * Захваченные (`running`) и завершённые не трогаем — это чужая работа.
 */
export async function cancel(userId: number, kind: DueJobKind | string): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.run(sql`
    UPDATE due_jobs
       SET status = 'cancelled', updated_at = ${now}
     WHERE user_id = ${userId} AND kind = ${String(kind)} AND status = 'pending'
  `);
  return result.rowsAffected;
}

/** Ближайшая ожидающая задача вида (или `null`). */
export async function getPendingJob(
  userId: number,
  kind: DueJobKind | string,
): Promise<DueJobRow | null> {
  const row = await db.get<DueJobDbRow>(sql`
    SELECT ${sql.raw(JOB_COLUMNS)}
      FROM due_jobs
     WHERE user_id = ${userId} AND kind = ${String(kind)} AND status = 'pending'
     ORDER BY run_at ASC, id ASC
     LIMIT 1
  `);
  return row ? mapJob(row) : null;
}

/** Все ожидающие задачи пользователя (по времени). */
export async function listPendingJobs(
  userId: number,
  limit = DEFAULT_DUE_LIMIT,
): Promise<DueJobRow[]> {
  const rows = await db.all<DueJobDbRow>(sql`
    SELECT ${sql.raw(JOB_COLUMNS)}
      FROM due_jobs
     WHERE user_id = ${userId} AND status = 'pending'
     ORDER BY run_at ASC, id ASC
     LIMIT ${Math.max(1, Math.trunc(limit))}
  `);
  return rows.map(mapJob);
}

// ---------------------------------------------------------------------------
// Захват и завершение
// ---------------------------------------------------------------------------

/**
 * Атомарно забирает до `limit` созревших задач (`status='pending'` и
 * `run_at <= now`) и переводит их в `running`. Возвращенные задачи уже
 * «наши»: параллельный вызов увидит их как running и пропустит.
 */
export async function dueJobs(
  now: IsoTimestamp | Date = new Date(),
  limit = DEFAULT_DUE_LIMIT,
): Promise<DueJobRow[]> {
  const at = toIsoMoment(now);
  const cap = Math.max(1, Math.trunc(limit));
  const toClaim = await db.all<{ id: number }>(sql`
    SELECT id FROM due_jobs
     WHERE status = 'pending' AND run_at <= ${at}
     ORDER BY run_at ASC, id ASC
     LIMIT ${cap}
  `);

  if (!toClaim.length) return [];

  const ids = toClaim.map((r) => r.id);
  const idList = ids.join(',');

  await db.run(sql`
    UPDATE due_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = ${at}
     WHERE id IN (${sql.raw(idList)})
  `);

  const rows = await db.all<DueJobDbRow>(sql`
    SELECT ${sql.raw(JOB_COLUMNS)}
      FROM due_jobs
     WHERE id IN (${sql.raw(idList)})
     ORDER BY run_at ASC, id ASC
  `);

  return rows.map(mapJob);
}

/** Задача выполнена. */
export async function completeJob(jobId: number): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.run(sql`
    UPDATE due_jobs
       SET status = 'done', last_error = NULL, updated_at = ${now}
     WHERE id = ${jobId}
  `);
  return result.rowsAffected > 0;
}

/** Задача упала: фиксируем причину, статус `failed` (повтор — отдельное решение). */
export async function markFailed(jobId: number, error: unknown): Promise<boolean> {
  const now = new Date().toISOString();
  const message = (error instanceof Error ? error.message : String(error ?? 'unknown error')).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const result = await db.run(sql`
    UPDATE due_jobs
       SET status = 'failed', last_error = ${message}, updated_at = ${now}
     WHERE id = ${jobId}
  `);
  return result.rowsAffected > 0;
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

export interface RunDueJobsResult {
  /** Сколько задач захвачено. */
  claimed: number;
  /** Успешно выполнено. */
  done: number;
  /** Упало (обработчик бросил). */
  failed: number;
  /** Осталось без обработчика — помечены `failed` с причиной. */
  unhandled: number;
  /** Идентификаторы выполненных задач (для логов). */
  jobIds: number[];
}

/**
 * Один проход ленивого планировщика: захват → диспетчеризация по реестру.
 * Ошибка одного обработчика не мешает остальным (каждая задача отдельно).
 */
export async function runDueJobs(
  now: IsoTimestamp | Date = new Date(),
  limit = DEFAULT_DUE_LIMIT,
): Promise<RunDueJobsResult> {
  const claimedJobs = await dueJobs(now, limit);
  const result: RunDueJobsResult = {
    claimed: claimedJobs.length,
    done: 0,
    failed: 0,
    unhandled: 0,
    jobIds: [],
  };

  for (const job of claimedJobs) {
    const handler = handlers.get(String(job.kind));
    if (!handler) {
      await markFailed(job.id, `no handler registered for job kind "${job.kind}"`);
      result.unhandled += 1;
      continue;
    }
    try {
      await handler(job);
      await completeJob(job.id);
      result.done += 1;
      result.jobIds.push(job.id);
    } catch (error) {
      await markFailed(job.id, error);
      result.failed += 1;
    }
  }

  return result;
}
