/**
 * MU-13 — машинный маршрут `/api/system/clock`.
 *
 * Что здесь закреплено:
 *  - маршрут закрыт для Mini App (`initData`) и не открывает публичный API;
 *  - без `ctx.user` не появляется пользователь-заглушка `999999999`;
 *  - несуществующий пользователь не создаётся, чужой `input.userId` не проходит;
 *  - только POST, остальные методы — 405;
 *  - ответ содержит счётчики и метки времени, но не названия и не тексты;
 *  - частичный сбой не отменяет идемпотентность уже отправленного.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EndpointError, api, callsOf, db, resetApi, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import rpcEndpoint from '../src/endpoints/rpc';
import { createTask } from '../src/lib/dal/tasks';
import { ensureUser, updateUser } from '../src/lib/dal/users';
import { setConfigOverrides } from '../src/lib/config';
import { zonedParts } from '../src/lib/utils';

const USER = 777000111;
const OTHER = 777000222;

const machineCtx = { user: { id: USER } };
const sent = () => callsOf('sendMessage');

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  setConfigOverrides({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
  const user = await ensureUser(USER, 'Owner');
  // Сдвигаем summary_time на +6 ч от текущего часа (середина 12-часовой мёртвой зоны вне
  // 720-минутного окна deliverMorningDigest), чтобы дайджест не срабатывал ни на каком :00.
  const timeZone = user.timezone ?? 'UTC';
  const offWindowHour = (zonedParts(new Date(), timeZone).hour + 6) % 24;
  await updateUser(USER, { summaryTime: `${String(offWindowHour).padStart(2, '0')}:00` });
});

async function catchEndpointError(run: Promise<unknown>): Promise<EndpointError> {
  try {
    await run;
  } catch (err) {
    return err as EndpointError;
  }
  throw new Error('ожидалась EndpointError, но эндпоинт ответил успехом');
}

async function userRow(id: number): Promise<unknown> {
  return db.get(sql`SELECT id FROM users WHERE id = ${id}`);
}

describe('clock endpoint: машинный маршрут', () => {
  it('Mini App initData отклонён: маршрут недоступен из Mini App', async () => {
    const error = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/system/clock', method: 'POST' },
        { initData: { user: { id: USER } } },
      ),
    );

    expect(error).toBeInstanceOf(EndpointError);
    expect(error.parameters).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(sent()).toHaveLength(0);
  });

  it('без ctx.user маршрут не создаёт пользователя 999999999', async () => {
    const error = await catchEndpointError(
      rpcEndpoint({ path: '/api/system/clock', method: 'POST' }),
    );

    expect(error.parameters).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(await userRow(999999999)).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  it('несуществующий пользователь отклонён и не появляется в users', async () => {
    const error = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/system/clock', method: 'POST' },
        { user: { id: 987654321 } },
      ),
    );

    expect(error.parameters).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await userRow(987654321)).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  it('подмена input.userId не даёт доставить чужие данные', async () => {
    const error = await catchEndpointError(
      rpcEndpoint(
        { path: '/api/system/clock', method: 'POST', userId: OTHER },
        { user: { id: USER } },
      ),
    );

    expect(error.parameters).toMatchObject({ code: 'FORBIDDEN' });
    expect(sent()).toHaveLength(0);
  });

  it('GET получает 405, маршрут отвечает только на POST', async () => {
    const error = await catchEndpointError(
      rpcEndpoint({ path: '/api/system/clock', method: 'GET' }, machineCtx),
    );

    expect(error.parameters).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });
  });

  it('пустой набор созревших событий: ok, нули, ревизия не меняется', async () => {
    const before = await db.get<{ updated_at: string | null }>(
      sql`SELECT updated_at FROM users WHERE id = ${USER}`,
    );

    const response = await rpcEndpoint(
      { path: '/api/system/clock', method: 'POST' },
      machineCtx,
    );

    expect(response.ok).toBe(true);
    expect(response.source).toBe('external');
    expect(response.delivered).toBe(0);
    expect(response.failed).toBe(0);
    expect(response.skipped).toBe(0);
    expect(response.expired).toBe(0);
    expect(typeof response.attemptAt).toBe('string');
    expect(Number.isNaN(Date.parse(response.attemptAt))).toBe(false);
    expect(sent()).toHaveLength(0);

    const after = await db.get<{ updated_at: string | null }>(
      sql`SELECT updated_at FROM users WHERE id = ${USER}`,
    );
    expect(after?.updated_at).toBe(before?.updated_at ?? null);
  });

  it('ответ содержит только счётчики: без идентификаторов, текстов и сообщений', async () => {
    await createTask(USER, {
      title: 'Позвонить в банк',
      remindAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    const response = await rpcEndpoint(
      { path: '/api/system/clock', method: 'POST' },
      machineCtx,
    );

    expect(Object.keys(response).sort()).toEqual([
      'attemptAt',
      'delivered',
      'expired',
      'failed',
      'kinds',
      'ok',
      'skipped',
      'source',
    ]);
    const serialised = JSON.stringify(response);
    for (const forbidden of ['title', 'text', 'taskIds', 'medicationIds', 'liabilityIds']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(response.delivered).toBe(1);
  });

  it('сбой доставки помечает ответ неуспешным, но уже отправленное не дублируется', async () => {
    await createTask(USER, {
      title: 'Позвонить в банк',
      remindAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValueOnce(new Error('telegram is down')),
      configurable: true,
    });

    const failedResponse = await rpcEndpoint(
      { path: '/api/system/clock', method: 'POST' },
      machineCtx,
    );
    expect(failedResponse.ok).toBe(false);
    expect(failedResponse.failed).toBeGreaterThanOrEqual(1);

    delete (api as Record<string, unknown>).sendMessage;

    const retried = await rpcEndpoint(
      { path: '/api/system/clock', method: 'POST' },
      machineCtx,
    );
    expect(retried.ok).toBe(true);
    expect(sent()).toHaveLength(1);
  });
});
