import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetApi, resetDb, sqliteDDL, callsOf } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { ensureUser } from '../src/lib/dal/users';
import { kvSetIfAbsent } from '../src/lib/dal/misc';
import { createTask, getTask } from '../src/lib/dal/tasks';
import { hasJobHandler, schedule, unregisterJobHandler } from '../src/lib/dal/due_jobs';
import { dateKey } from '../src/lib/utils';
import handleUpdate from '../src/handlers/message';
import rpcEndpoint from '../src/endpoints/rpc';

const USER = 777000111;
const PAST = '2026-03-10T02:00:00.000Z';

/** Глушит ленивый крон утренней сводки в окне 07:00–11:00 UTC. */
async function markMorningDigestSent(timeZone: string): Promise<void> {
  const day = dateKey(new Date(), timeZone);
  await kvSetIfAbsent(
    `morning_digest:${USER}:${day}`,
    JSON.stringify({ sentAt: new Date().toISOString(), digestDate: day }),
  );
}

describe('due_jobs runtime initialization', () => {
  beforeEach(async () => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetApi();
    resetConfigCache();
    setConfigOverrides({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
    vi.unstubAllEnvs();
    const user = await ensureUser(USER, 'Test User');
    await markMorningDigestSent(user.timezone ?? 'Europe/Berlin');
    unregisterJobHandler('nightly_consolidation');
  });

  afterEach(() => {
    unregisterJobHandler('nightly_consolidation');
    vi.unstubAllEnvs();
  });

  it('handleUpdate registers job handlers and runs due nightly_consolidation job without unhandled error', async () => {
    expect(hasJobHandler('nightly_consolidation')).toBe(false);

    const job = await schedule(USER, 'nightly_consolidation', PAST);

    // Call runtime entry point
    await handleUpdate(null);

    // Handlers must now be registered in due_jobs registry
    expect(hasJobHandler('nightly_consolidation')).toBe(true);

    // The job should NOT have failed with "no handler registered"
    const row = await db.get<{ status: string; last_error: string | null }>(sql`
      SELECT status, last_error FROM due_jobs WHERE id = ${job.id}
    `);
    expect(row?.status).toBe('done');
    expect(row?.last_error).toBeNull();
  });

  it('rpcEndpoint registers job handlers and runs due nightly_consolidation job on state check', async () => {
    expect(hasJobHandler('nightly_consolidation')).toBe(false);

    const job = await schedule(USER, 'nightly_consolidation', PAST);

    // Call RPC runtime entry point that triggers runDueJobs
    await rpcEndpoint(
      { path: '/api/state', method: 'GET' },
      { initData: { user: { id: USER } } },
    );

    expect(hasJobHandler('nightly_consolidation')).toBe(true);

    const row = await db.get<{ status: string; last_error: string | null }>(sql`
      SELECT status, last_error FROM due_jobs WHERE id = ${job.id}
    `);
    expect(row?.status).toBe('done');
    expect(row?.last_error).toBeNull();
  });

  it('RPC не дублирует напоминание: второе обращение не отправляет его снова', async () => {
    const remindAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const task = await createTask(USER, { title: 'Позвонить в банк', remindAt });

    // Тест покрывает только RPC-путь: голый `handleUpdate(null)` возвращается
    // раньше прохода напоминаний, поэтому он здесь лишь базовая линия.
    await handleUpdate(null);
    const baseline = callsOf('sendMessage').length;

    // Первый заход после касания — единственная доставка напоминания.
    await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, { initData: { user: { id: USER } } });
    const afterFirst = callsOf('sendMessage').length;
    expect(afterFirst).toBe(baseline + 1);

    // Повторные заходы RPC видят уже закрытый claim; касание до часов не доходит.
    await handleUpdate(null);
    await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, { initData: { user: { id: USER } } });
    await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, { initData: { user: { id: USER } } });

    expect(callsOf('sendMessage').length).toBe(afterFirst);
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);
  });

  it('машинный маршрут и RPC делят один проход: напоминание не дублируется', async () => {
    const remindAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const task = await createTask(USER, { title: 'Позвонить в банк', remindAt });
    resetApi();

    const clock = await rpcEndpoint(
      { path: '/api/system/clock', method: 'POST' },
      { user: { id: USER } },
    );
    expect(clock.ok).toBe(true);
    expect(clock.delivered).toBe(1);
    const afterClock = callsOf('sendMessage').length;
    expect(afterClock).toBe(1);

    // Обычный RPC видит уже закрытый claim и молчит.
    await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, { initData: { user: { id: USER } } });
    await rpcEndpoint({ path: '/api/tasks', method: 'GET' }, { initData: { user: { id: USER } } });

    expect(callsOf('sendMessage').length).toBe(afterClock);
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);
  });
});
