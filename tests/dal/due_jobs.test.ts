/**
 * DAL `src/lib/dal/due_jobs.ts` — ленивый планировщик.
 *
 * Проверяем три обещания (SPEC §2.6):
 *  - постановка идемпотентна: одна ожидающая задача на вид, без дублей;
 *  - захват атомарный: задача достаётся ровно одному проходу, второй видит пусто;
 *  - неудача не теряется: `failed` + причина в `last_error`, и не ломает
 *    остальные задачи того же прохода.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import type { DueJobRow } from '../../src/types';
import {
  cancel,
  completeJob,
  dueJobs,
  getPendingJob,
  hasJobHandler,
  listPendingJobs,
  markFailed,
  registerJobHandler,
  registeredJobKinds,
  runDueJobs,
  schedule,
  unregisterJobHandler,
} from '../../src/lib/dal/due_jobs';

const USER_A = 1;
const USER_B = 2;

const NOW = '2026-11-06T12:00:00.000Z';
const PAST = '2026-11-06T11:00:00.000Z';
const FUTURE = '2026-11-06T13:00:00.000Z';

const KINDS = ['daily_backup', 'task_reminder', 'trash_autocleanup', 'nightly_consolidation'];

/** Сырые строки из SQLite — приводим к доменному виду (raw не декодирует колонки). */
async function rows(kind: string): Promise<DueJobRow[]> {
  const raw = await db.all<Record<string, unknown>>(
    sql`SELECT * FROM due_jobs WHERE kind = ${kind} ORDER BY id ASC`,
  );
  return raw.map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    kind: String(row.kind),
    runAt: String(row.run_at),
    payload: JSON.parse(String(row.payload ?? '{}')) as Record<string, unknown>,
    status: String(row.status) as DueJobRow['status'],
    attempts: Number(row.attempts ?? 0),
    lastError:
      row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt:
      row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    updatedAt:
      row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
  }));
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

afterEach(() => {
  for (const kind of [...KINDS, ...registeredJobKinds()]) unregisterJobHandler(kind);
});

describe('реестр обработчиков', () => {
  it('регистрирует, находит и снимает обработчик', () => {
    expect(hasJobHandler('daily_backup')).toBe(false);

    registerJobHandler('daily_backup', () => {});
    expect(hasJobHandler('daily_backup')).toBe(true);
    expect(registeredJobKinds()).toContain('daily_backup');

    expect(unregisterJobHandler('daily_backup')).toBe(true);
    expect(unregisterJobHandler('daily_backup')).toBe(false);
    expect(hasJobHandler('daily_backup')).toBe(false);
  });

  it('перезапись обработчика разрешена (горячая пересборка)', async () => {
    await schedule(USER_A, 'daily_backup', PAST);
    const calls: string[] = [];

    registerJobHandler('daily_backup', () => {
      calls.push('first');
    });
    registerJobHandler('daily_backup', () => {
      calls.push('second');
    });

    await runDueJobs(NOW);
    expect(calls).toEqual(['second']);
  });
});

describe('schedule', () => {
  it('создаёт ожидающую задачу с payload', async () => {
    const job = await schedule(USER_A, 'daily_backup', PAST, { chatId: 42 });

    expect(job.id).toBeGreaterThan(0);
    expect(job.userId).toBe(USER_A);
    expect(job.kind).toBe('daily_backup');
    expect(job.runAt).toBe(PAST);
    expect(job.payload).toEqual({ chatId: 42 });
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.lastError).toBeNull();
  });

  it('идемпотентен: повторная постановка обновляет ожидающую задачу, а не дублирует', async () => {
    const first = await schedule(USER_A, 'daily_backup', PAST, { v: 1 });
    const second = await schedule(USER_A, 'daily_backup', FUTURE, { v: 2 });

    expect(second.id).toBe(first.id);
    expect(second.runAt).toBe(FUTURE);
    expect(second.payload).toEqual({ v: 2 });
    expect(await rows('daily_backup')).toHaveLength(1);
  });

  it('задача не склеивается между пользователями', async () => {
    const a = await schedule(USER_A, 'daily_backup', PAST);
    const b = await schedule(USER_B, 'daily_backup', PAST);

    expect(b.id).not.toBe(a.id);
    expect(await rows('daily_backup')).toHaveLength(2);
  });

  it('после захвата создаёт новую ожидающую задачу', async () => {
    const first = await schedule(USER_A, 'daily_backup', PAST);
    await dueJobs(NOW);

    const second = await schedule(USER_A, 'daily_backup', FUTURE);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
    expect(await rows('daily_backup')).toHaveLength(2);
  });

  it('принимает Date и отвергает пустой вид', async () => {
    const job = await schedule(USER_A, 'daily_backup', new Date(PAST));
    expect(job.runAt).toBe(PAST);

    await expect(schedule(USER_A, '  ', PAST)).rejects.toThrow(/job kind is required/);
  });
});

describe('dueJobs', () => {
  it('забирает только созревшие задачи и ровно один раз', async () => {
    const due = await schedule(USER_A, 'daily_backup', PAST);
    await schedule(USER_A, 'task_reminder', FUTURE);

    const claimed = await dueJobs(NOW);

    expect(claimed.map((job) => job.id)).toEqual([due.id]);
    expect(claimed[0]?.status).toBe('running');
    expect(claimed[0]?.attempts).toBe(1);

    expect(await dueJobs(NOW)).toEqual([]);
  });

  it('уважает лимит и порядок по времени', async () => {
    await schedule(USER_A, 'daily_backup', '2026-11-06T11:30:00.000Z');
    await schedule(USER_A, 'task_reminder', '2026-11-06T11:00:00.000Z');
    await schedule(USER_A, 'trash_autocleanup', '2026-11-06T11:15:00.000Z');

    const claimed = await dueJobs(NOW, 2);

    expect(claimed.map((job) => job.kind)).toEqual(['task_reminder', 'trash_autocleanup']);
  });

  it('не забирает отменённые и завершённые задачи', async () => {
    await schedule(USER_A, 'daily_backup', PAST);
    await cancel(USER_A, 'daily_backup');

    expect(await dueJobs(NOW)).toEqual([]);
  });
});

describe('cancel', () => {
  it('снимает только ожидающую задачу', async () => {
    await schedule(USER_A, 'daily_backup', PAST);

    expect(await cancel(USER_A, 'daily_backup')).toBe(1);
    expect(await cancel(USER_A, 'daily_backup')).toBe(0);
    expect(await dueJobs(NOW)).toEqual([]);
    expect(await getPendingJob(USER_A, 'daily_backup')).toBeNull();
  });

  it('не трогает чужую задачу и захваченную работу', async () => {
    await schedule(USER_A, 'daily_backup', PAST);
    expect(await cancel(USER_B, 'daily_backup')).toBe(0);

    await dueJobs(NOW);
    expect(await cancel(USER_A, 'daily_backup')).toBe(0);
  });
});

describe('getPendingJob / listPendingJobs', () => {
  it('отдаёт ближайшую ожидающую задачу пользователя', async () => {
    const later = await schedule(USER_A, 'daily_backup', FUTURE);
    const sooner = await schedule(USER_A, 'task_reminder', PAST);
    await schedule(USER_B, 'trash_autocleanup', PAST);

    expect((await getPendingJob(USER_A, 'daily_backup'))?.id).toBe(later.id);
    expect((await listPendingJobs(USER_A)).map((job) => job.id)).toEqual([sooner.id, later.id]);
    expect(await listPendingJobs(USER_A, 1)).toHaveLength(1);
  });
});

describe('runDueJobs', () => {
  it('зовёт обработчик с захваченной задачей и закрывает её', async () => {
    const job = await schedule(USER_A, 'daily_backup', PAST, { chatId: 42 });
    const seen: DueJobRow[] = [];
    registerJobHandler('daily_backup', async (received) => {
      seen.push(received);
    });

    const result = await runDueJobs(NOW);

    expect(result).toMatchObject({ claimed: 1, done: 1, failed: 0, unhandled: 0 });
    expect(result.jobIds).toEqual([job.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual({ chatId: 42 });
    expect(seen[0]?.status).toBe('running');

    const stored = (await rows('daily_backup'))[0];
    expect(stored?.status).toBe('done');
    expect(stored?.attempts).toBe(1);

    expect((await runDueJobs(NOW)).claimed).toBe(0);
  });

  it('падение обработчика помечает задачу failed и не мешает остальным', async () => {
    await schedule(USER_A, 'daily_backup', '2026-11-06T11:00:00.000Z');
    const ok = await schedule(USER_A, 'task_reminder', '2026-11-06T11:01:00.000Z');

    registerJobHandler('daily_backup', () => {
      throw new Error('disk is full');
    });
    registerJobHandler('task_reminder', () => {});

    const result = await runDueJobs(NOW);

    expect(result).toMatchObject({ claimed: 2, done: 1, failed: 1, unhandled: 0 });
    expect(result.jobIds).toEqual([ok.id]);

    const failed = (await rows('daily_backup'))[0];
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toBe('disk is full');
  });

  it('без обработчика задача помечается failed с понятной причиной', async () => {
    await schedule(USER_A, 'nightly_consolidation', PAST);

    const result = await runDueJobs(NOW);

    expect(result).toMatchObject({ claimed: 1, done: 0, failed: 0, unhandled: 1 });

    const stored = (await rows('nightly_consolidation'))[0];
    expect(stored?.status).toBe('failed');
    expect(String(stored?.lastError)).toContain('no handler registered for job kind');
    expect(String(stored?.lastError)).toContain('nightly_consolidation');
  });

  it('берёт задачи всех пользователей за один проход', async () => {
    await schedule(USER_A, 'daily_backup', PAST);
    await schedule(USER_B, 'daily_backup', PAST);
    const seen: number[] = [];
    registerJobHandler('daily_backup', (job) => {
      seen.push(job.userId);
    });

    const result = await runDueJobs(NOW);

    expect(result.claimed).toBe(2);
    expect(seen.sort()).toEqual([USER_A, USER_B]);
    expect((await rows('daily_backup')).every((job) => job.status === 'done')).toBe(true);
  });
});

describe('completeJob / markFailed', () => {
  it('закрывает задачу и чистит прошлую ошибку', async () => {
    const job = await schedule(USER_A, 'daily_backup', PAST);
    await markFailed(job.id, new Error('boom'));
    expect((await rows('daily_backup'))[0]?.status).toBe('failed');

    expect(await completeJob(job.id)).toBe(true);

    const stored = (await rows('daily_backup'))[0];
    expect(stored?.status).toBe('done');
    expect(stored?.lastError).toBeNull();
  });

  it('обрезает длинный текст ошибки до 500 символов', async () => {
    const job = await schedule(USER_A, 'daily_backup', PAST);

    expect(await markFailed(job.id, 'x'.repeat(900))).toBe(true);

    const stored = (await rows('daily_backup'))[0];
    expect(stored?.status).toBe('failed');
    expect(String(stored?.lastError)).toHaveLength(500);
  });

  it('сообщает false для несуществующей задачи', async () => {
    expect(await completeJob(9999)).toBe(false);
    expect(await markFailed(9999, 'boom')).toBe(false);
  });
});
