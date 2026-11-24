import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetApi, resetDb, sqliteDDL, callsOf } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { kvGet, kvSetIfAbsent } from '../src/lib/dal/misc';
import { createTask, getTask } from '../src/lib/dal/tasks';
import { hasJobHandler, schedule, unregisterJobHandler } from '../src/lib/dal/due_jobs';
import { createNote } from '../src/lib/dal/notes';
import { ensureUser, updateUser } from '../src/lib/dal/users';
import { scheduleNightlyConsolidation, runNightlyConsolidation } from '../src/lib/consolidation';
import { deliverCustomRoutines, runReminderClock } from '../src/lib/jobs';
import { routineRunKey, saveUserPrefs } from '../src/lib/prefs';
import type { AgentChatFn } from '../src/lib/agent/engine';
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

describe('Волна 2: deliverCustomRoutines и nightly_consolidation prefs', () => {
  const ROUTINE_USER = 777000222;

  beforeEach(async () => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetApi();
    resetConfigCache();
    setConfigOverrides({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
    await ensureUser(ROUTINE_USER, 'Routine Tester');
    await updateUser(ROUTINE_USER, { timezone: 'UTC' });
  });

  it('text и summary рутины уважают quietHours (не захватывая KV) и дедуплицируются', async () => {
    const qhMoment = new Date('2026-11-24T23:15:00.000Z');
    const dayMoment = new Date('2026-11-24T12:15:00.000Z');

    await saveUserPrefs(ROUTINE_USER, {
      proactive: {
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
        jobs: { morning_digest: { enabled: false } },
        routines: {
          ping_day: {
            id: 'ping_day',
            name: 'Вода',
            enabled: true,
            kind: 'text',
            schedule: 'daily',
            time: '12:00',
            message: 'Выпей воды!',
            updatedAt: dayMoment.toISOString(),
          },
          ping_night: {
            id: 'ping_night',
            name: 'Сон',
            enabled: true,
            kind: 'summary',
            schedule: 'daily',
            time: '23:00',
            summaryKind: 'quick',
            updatedAt: qhMoment.toISOString(),
          },
        },
      },
    });

    // Тихий час пропускает ping_night и НЕ пишет KV-метку
    const nightClock = await runReminderClock(ROUTINE_USER, { now: qhMoment, source: 'touch' });
    expect(nightClock.kinds.custom_routines.skipped).toBe(1);
    expect(await kvGet(routineRunKey(ROUTINE_USER, 'ping_night', '2026-11-24'))).toBeNull();

    // Днём ping_day срабатывает один раз, повторный тик дедуплицируется
    const first = await runReminderClock(ROUTINE_USER, { now: dayMoment, source: 'rpc' });
    expect(first.kinds.custom_routines.delivered).toBe(1);
    expect(callsOf('sendMessage')).toHaveLength(1);
    expect(await kvGet(routineRunKey(ROUTINE_USER, 'ping_day', '2026-11-24'))).not.toBeNull();

    const second = await runReminderClock(ROUTINE_USER, { now: dayMoment, source: 'touch' });
    expect(second.kinds.custom_routines.delivered).toBe(0);
    expect(second.kinds.custom_routines.skipped).toBe(1);
    expect(callsOf('sendMessage')).toHaveLength(1);
  });

  it('ai-рутина: игнорируется на rpc, лимит 1 на touch, read-only режет write-тулзы, сбой LLM снимает KV', async () => {
    const dueTime = new Date('2026-11-24T15:10:00.000Z');
    await saveUserPrefs(ROUTINE_USER, {
      proactive: {
        routines: {
          ai_a: {
            id: 'ai_a',
            name: 'Обзор A',
            enabled: true,
            kind: 'ai',
            schedule: 'daily',
            time: '15:00',
            prompt: 'Проверь задачи',
            toolAccess: 'read-only',
            updatedAt: dueTime.toISOString(),
          },
          ai_b: {
            id: 'ai_b',
            name: 'Обзор B',
            enabled: true,
            kind: 'ai',
            schedule: 'daily',
            time: '15:05',
            prompt: 'Проверь заметки',
            toolAccess: 'allow_writes',
            updatedAt: dueTime.toISOString(),
          },
        },
      },
    });

    const sawTools: string[][] = [];
    const okChat: AgentChatFn = async (req) => {
      sawTools.push((req.tools ?? []).map((t) => t.name));
      return { content: 'Краткий отчёт готов.', toolCalls: [] };
    };

    // 1. На rpc AI-рутины пропускаются без захвата KV
    const rpcRes = await deliverCustomRoutines(ROUTINE_USER, {
      now: dueTime,
      source: 'rpc',
      chatFn: okChat,
    });
    expect(rpcRes.delivered).toBe(0);
    expect(rpcRes.skipped).toBe(2);
    expect(sawTools).toHaveLength(0);

    // 2. При сбое LLM KV-метка снимается (повтор возможен)
    const failingChat: AgentChatFn = async () => {
      throw new Error('upstream 503');
    };
    const failRes = await deliverCustomRoutines(ROUTINE_USER, {
      now: dueTime,
      source: 'touch',
      chatFn: failingChat,
    });
    expect(failRes.failed).toBe(1);
    expect(failRes.skipped).toBe(1); // вторая AI пропущена по touch-лимиту 1 на проход
    expect(await kvGet(routineRunKey(ROUTINE_USER, 'ai_a', '2026-11-24'))).toBeNull();

    // 3. Повторный touch запускает ai_a в read-only (без write/destroy), ai_b ждёт следующего прохода
    const touch1 = await deliverCustomRoutines(ROUTINE_USER, {
      now: dueTime,
      source: 'touch',
      chatFn: okChat,
    });
    expect(touch1.delivered).toBe(1);
    expect(touch1.skipped).toBe(1);
    expect(sawTools[0]).not.toContain('add_task');
    expect(sawTools[0]).not.toContain('delete_task');

    // 4. Следующий touch запускает ai_b (allow_writes): write есть, но destroy / manage_routines / reset вырезаны
    const touch2 = await deliverCustomRoutines(ROUTINE_USER, {
      now: dueTime,
      source: 'touch',
      chatFn: okChat,
    });
    expect(touch2.delivered).toBe(1);
    expect(sawTools[1]).toContain('add_task');
    expect(sawTools[1]).not.toContain('delete_task');
    expect(sawTools[1]).not.toContain('manage_routines');
    expect(sawTools[1]).not.toContain('reset_or_rollback_settings');
  });

  it('nightly_consolidation уважает enabled=false, noteLimit и custom hour', async () => {
    await createNote(ROUTINE_USER, 'Заметка для консолидации');
    await saveUserPrefs(ROUTINE_USER, {
      proactive: {
        jobs: {
          nightly_consolidation: { enabled: false, hour: 5, noteLimit: 10 },
        },
      },
    });

    const skipped = await runNightlyConsolidation(ROUTINE_USER, { now: new Date('2026-11-24T05:00:00.000Z') });
    expect(skipped.status).toBe('skipped');

    const job = await scheduleNightlyConsolidation(ROUTINE_USER, {
      now: new Date('2026-11-24T01:00:00.000Z'),
      timeZone: 'UTC',
    });
    expect(job.runAt).toBe('2026-11-24T05:00:00.000Z');
  });
});
