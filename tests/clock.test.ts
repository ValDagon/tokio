/**
 * Единый проход напоминаний (`runReminderClock`).
 *
 * Что здесь закреплено:
 *  - один `now` на все четыре вида: доза и сводка не пересекают полночь между
 *    вызовами;
 *  - сбой одного вида не гасит остальные и уходит одним сигналом в журнал;
 *  - сбой самого журнала не меняет исход вида и не роняет проход;
 *  - мусорный `now` не отменяет доставку, но `at` в отчёте — `null`.
 *
 * Доставщики и журнал подменены: проверяется координация, а не отправка.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliverDueReminders: vi.fn(),
  deliverLiabilityWarnings: vi.fn(),
  deliverMedicationReminders: vi.fn(),
  deliverMorningDigest: vi.fn(),
  pruneStaleKvLabels: vi.fn(),
  recordFailure: vi.fn(),
}));

vi.mock('../src/lib/reminders.js', () => ({
  deliverDueReminders: mocks.deliverDueReminders,
  deliverLiabilityWarnings: mocks.deliverLiabilityWarnings,
  deliverMedicationReminders: mocks.deliverMedicationReminders,
  deliverMorningDigest: mocks.deliverMorningDigest,
  pruneStaleKvLabels: mocks.pruneStaleKvLabels,
}));

vi.mock('../src/lib/evolution.js', () => ({
  recordFailure: mocks.recordFailure,
}));

import { runReminderClock, clockHeartbeatKey } from '../src/lib/jobs';
import { kvGetJson } from '../src/lib/dal/misc';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';

const USER = 100001;
const NOW = new Date('2026-11-15T07:00:00.000Z');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deliverDueReminders.mockResolvedValue({
    delivered: 1,
    expired: 0,
    failed: 0,
    taskIds: [1],
  });
  mocks.deliverLiabilityWarnings.mockResolvedValue({
    delivered: 0,
    skipped: 1,
    failed: 0,
    liabilityIds: [],
  });
  mocks.deliverMedicationReminders.mockResolvedValue({
    delivered: 2,
    skipped: 0,
    failed: 0,
    medicationIds: [3, 4],
  });
  mocks.deliverMorningDigest.mockResolvedValue({ delivered: 0, skipped: 1, failed: 0 });
});

describe('clock: единый проход напоминаний', () => {
  it('передаёт один и тот же now всем четырём доставщикам и складывает итоги по видам', async () => {
    const outcome = await runReminderClock(USER, { now: NOW, source: 'external' });

    expect(mocks.deliverDueReminders).toHaveBeenCalledWith(USER, { now: NOW });
    expect(mocks.deliverLiabilityWarnings).toHaveBeenCalledWith(USER, { now: NOW });
    expect(mocks.deliverMedicationReminders).toHaveBeenCalledWith(USER, { now: NOW });
    expect(mocks.deliverMorningDigest).toHaveBeenCalledWith(USER, { now: NOW });

    expect(outcome.at).toBe(NOW.toISOString());
    expect(outcome.source).toBe('external');
    expect(outcome.delivered).toBe(3);
    expect(outcome.failed).toBe(0);
    expect(outcome.skipped).toBe(2);
    expect(outcome.expired).toBe(0);
    expect(outcome.kinds.task_reminder.status).toBe('delivered');
    expect(outcome.kinds.liability_warning.status).toBe('skipped');
    expect(outcome.kinds.medication_reminder.delivered).toBe(2);
  });

  it('сбой одного вида не гасит остальные и пишет один сигнал в журнал', async () => {
    mocks.deliverLiabilityWarnings.mockRejectedValue(new Error('db is down'));

    const outcome = await runReminderClock(USER, { now: NOW });

    expect(mocks.deliverDueReminders).toHaveBeenCalledTimes(1);
    expect(mocks.deliverMedicationReminders).toHaveBeenCalledTimes(1);
    expect(mocks.deliverMorningDigest).toHaveBeenCalledTimes(1);
    expect(outcome.kinds.liability_warning).toEqual({
      status: 'failed',
      delivered: 0,
      failed: 1,
      skipped: 0,
      expired: 0,
      error: 'db is down',
    });
    expect(outcome.failed).toBe(1);
    expect(mocks.recordFailure).toHaveBeenCalledTimes(1);
    expect(mocks.recordFailure).toHaveBeenCalledWith(USER, {
      stage: 'delivery',
      reason: 'delivery_failed',
      tool: 'deliverLiabilityWarnings',
      detail: 'deliverLiabilityWarnings: db is down',
    });
  });

  it('без now берёт один момент на весь проход', async () => {
    const outcome = await runReminderClock(USER);

    const instantOf = (mock: typeof mocks.deliverDueReminders): Date => {
      const args = mock.mock.calls[0] as [number, { now: Date }];
      return args[1].now;
    };
    const moment = instantOf(mocks.deliverDueReminders);
    expect(moment).toBeInstanceOf(Date);
    expect(instantOf(mocks.deliverLiabilityWarnings)).toBe(moment);
    expect(instantOf(mocks.deliverMedicationReminders)).toBe(moment);
    expect(instantOf(mocks.deliverMorningDigest)).toBe(moment);
    expect(outcome.at).toBe(moment.toISOString());
  });

  it('мусорный now не отменяет проход: доставщики получают то же значение, at — null', async () => {
    const outcome = await runReminderClock(USER, { now: 'не дата', source: 'touch' });

    for (const mock of [
      mocks.deliverDueReminders,
      mocks.deliverLiabilityWarnings,
      mocks.deliverMedicationReminders,
      mocks.deliverMorningDigest,
    ]) {
      expect(mock).toHaveBeenCalledWith(USER, { now: 'не дата' });
    }
    expect(outcome.at).toBeNull();
    expect(outcome.source).toBe('touch');
  });

  it('сбой журнала не меняет исход вида', async () => {
    mocks.recordFailure.mockRejectedValue(new Error('kv down'));
    mocks.deliverMorningDigest.mockRejectedValue(new Error('telegram is down'));

    const outcome = await runReminderClock(USER, { now: NOW });

    expect(outcome.kinds.morning_digest.status).toBe('failed');
    expect(outcome.failed).toBe(1);
  });
});

describe('clock: heartbeat', () => {
  const OTHER_USER = 2002;

  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('внешний тик пишет attempt и success в namespace пользователя', async () => {
    const outcome = await runReminderClock(USER, { now: NOW, source: 'external' });

    const heartbeat = await kvGetJson<Record<string, unknown> | null>(clockHeartbeatKey(USER), null);
    expect(heartbeat).not.toBeNull();
    expect(heartbeat?.lastExternalAttemptAt).toBe(outcome.at);
    expect(heartbeat?.lastExternalSuccessAt).toBe(outcome.at);
    expect(heartbeat?.lastTouchAt).toBeNull();

    expect(await kvGetJson(clockHeartbeatKey(OTHER_USER), null)).toBeNull();
  });

  it('touch не подменяет внешний heartbeat', async () => {
    await runReminderClock(USER, { now: NOW, source: 'external' });

    const touchAt = new Date(NOW.getTime() + 5 * 60_000);
    await runReminderClock(USER, { now: touchAt, source: 'touch' });

    const heartbeat = await kvGetJson<Record<string, unknown> | null>(clockHeartbeatKey(USER), null);
    expect(heartbeat?.lastExternalAttemptAt).toBe(NOW.toISOString());
    expect(heartbeat?.lastExternalSuccessAt).toBe(NOW.toISOString());
    expect(heartbeat?.lastTouchAt).toBe(touchAt.toISOString());
  });

  it('касание не стирает снимок внешнего прохода: оборванная сводка остаётся видимой', async () => {
    mocks.deliverMorningDigest.mockRejectedValue(new Error('telegram is down'));
    const external = await runReminderClock(USER, { now: NOW, source: 'external' });

    const afterExternal = await kvGetJson<Record<string, unknown> | null>(clockHeartbeatKey(USER), null);
    expect((afterExternal?.kinds as Record<string, unknown>).morning_digest).toBe('failed');
    expect(afterExternal?.lastExternalSuccessAt).toBeNull();

    // Здоровое касание: ничего не созрело, все четыре доставщика успешны.
    mocks.deliverMorningDigest.mockResolvedValue({ delivered: 0, skipped: 1, failed: 0 });
    const touchAt = new Date(NOW.getTime() + 5 * 60_000);
    await runReminderClock(USER, { now: touchAt, source: 'touch' });

    const heartbeat = await kvGetJson<Record<string, unknown> | null>(clockHeartbeatKey(USER), null);
    expect((heartbeat?.kinds as Record<string, unknown>).morning_digest).toBe('failed');
    expect(heartbeat?.failed).toBe(external.failed);
    expect(heartbeat?.source).toBe('external');
    expect(heartbeat?.lastTouchAt).toBe(touchAt.toISOString());
    expect(heartbeat?.lastExternalSuccessAt).toBeNull();
  });

  it('частичный сбой обновляет attempt, но не success', async () => {
    await runReminderClock(USER, { now: NOW, source: 'external' });

    mocks.deliverDueReminders.mockRejectedValue(new Error('telegram is down'));
    const later = new Date(NOW.getTime() + 15 * 60_000);
    await runReminderClock(USER, { now: later, source: 'external' });

    const heartbeat = await kvGetJson<Record<string, unknown> | null>(clockHeartbeatKey(USER), null);
    expect(heartbeat?.lastExternalAttemptAt).toBe(later.toISOString());
    expect(heartbeat?.lastExternalSuccessAt).toBe(NOW.toISOString());
  });

  it('в heartbeat нет текстов и идентификаторов сущностей', async () => {
    await runReminderClock(USER, { now: NOW, source: 'external' });

    const heartbeat = await kvGetJson<Record<string, unknown> | null>(clockHeartbeatKey(USER), null);
    expect(Object.keys(heartbeat ?? {}).sort()).toEqual([
      'delivered',
      'failed',
      'kinds',
      'lastExternalAttemptAt',
      'lastExternalSuccessAt',
      'lastTouchAt',
      'source',
    ]);
    expect(Object.keys((heartbeat?.kinds ?? {}) as Record<string, unknown>).sort()).toEqual([
      'custom_routines',
      'liability_warning',
      'medication_reminder',
      'morning_digest',
      'task_reminder',
    ]);
    expect(JSON.stringify(heartbeat)).not.toContain('text');
  });
});
