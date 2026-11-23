/**
 * Отказ модели — на пользователя, не на инстанс.
 *
 * До 23.11.2026 причина последнего `llm_error` лежала в одном глобальном ключе
 * `llm_last_failure`. В публичном ядре это значит, что `/diagnostics` и ответ
 * «модель сейчас недоступна» показывали отказ **чужого** аккаунта. Теперь
 * движок пишет `llm_last_failure:<uid>`, а старый глобальный ключ читается
 * только как фолбэк — иначе уже записанные отказы исчезли бы из ответа сразу
 * после выката.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  kvGetJson,
  kvSetJson,
  LEGACY_LLM_FAILURE_KEY,
  readLastModelFailure,
  writeLastModelFailure,
} from '../../src/lib/dal/misc';
import { diagnosticsReply, modelOutageReply } from '../../src/lib/summary';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER_A = 601;
const USER_B = 602;
const NOW = new Date('2026-11-23T10:00:00Z');

interface FailureRecord {
  status: number;
  at: string;
  detail: string;
  providerBody?: string | null;
}

const failureKey = (userId: number): string => `llm_last_failure:${userId}`;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('журнал отказа модели: ключ на пользователя', () => {
  it('движок пишет свой ключ и не трогает старый глобальный', async () => {
    const chatFn: AgentChatFn = async () => {
      throw Object.assign(new Error('gemini: model-a answered 429: quota exceeded'), { status: 429 });
    };

    const result = await runAgent({
      userId: USER_A,
      text: 'куда я потратил деньги?',
      tools: [],
      chatFn,
      now: NOW,
    });

    expect(result.stopReason).toBe('llm_error');
    const own = await kvGetJson<FailureRecord | null>(failureKey(USER_A), null);
    expect(own?.status).toBe(429);
    expect(own?.detail).toContain('quota exceeded');
    // Двойной записи нет: старый ключ должен умереть сам, а не жить рядом.
    expect(await kvGetJson<FailureRecord | null>(LEGACY_LLM_FAILURE_KEY, null)).toBeNull();
  });

  it('отказ одного пользователя не виден другому', async () => {
    await writeLastModelFailure(USER_A, {
      status: 429,
      at: NOW.toISOString(),
      detail: 'quota exceeded',
    });

    expect((await readLastModelFailure(USER_A))?.status).toBe(429);
    // Фолбэк — только на старый глобальный ключ, а не на чужой персональный.
    expect(await readLastModelFailure(USER_B)).toBeNull();
  });

  it('у каждого свой последний отказ', async () => {
    await writeLastModelFailure(USER_A, { status: 429, at: NOW.toISOString(), detail: 'limit' });
    await writeLastModelFailure(USER_B, { status: 503, at: NOW.toISOString(), detail: 'down' });

    expect((await readLastModelFailure(USER_A))?.status).toBe(429);
    expect((await readLastModelFailure(USER_B))?.status).toBe(503);
  });

  it('без персональной записи читается свежий старый глобальный ключ', async () => {
    await kvSetJson(LEGACY_LLM_FAILURE_KEY, {
      status: 500,
      at: new Date().toISOString(),
      detail: 'upstream down',
    });

    const failure = await readLastModelFailure(USER_B);

    expect(failure?.status).toBe(500);
    expect(failure?.detail).toBe('upstream down');
  });

  it('просроченный старый глобальный ключ не читается', async () => {
    await kvSetJson(LEGACY_LLM_FAILURE_KEY, {
      status: 500,
      at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      detail: 'upstream down yesterday',
    });

    expect(await readLastModelFailure(USER_A)).toBeNull();
  });

  it('мусор в персональном ключе — «записи нет», а не падение', async () => {
    await kvSetJson(failureKey(USER_A), 42);
    expect(await readLastModelFailure(USER_A)).toBeNull();

    await kvSetJson(failureKey(USER_A), ['не', 'объект']);
    expect(await readLastModelFailure(USER_A)).toBeNull();
  });

  it('мусор в персональном ключе не открывает старый глобальный', async () => {
    await kvSetJson(LEGACY_LLM_FAILURE_KEY, {
      status: 500,
      at: new Date().toISOString(),
      detail: 'чужой отказ',
    });
    await kvSetJson(failureKey(USER_A), 'не объект');

    // Порча своего ключа значит, что пользователь уже живёт по новой схеме:
    // старый глобальный отказ ему не ответ.
    expect(await readLastModelFailure(USER_A)).toBeNull();
  });

  it('персональный ключ приоритетнее старого глобального', async () => {
    await kvSetJson(LEGACY_LLM_FAILURE_KEY, { status: 500, at: NOW.toISOString(), detail: 'old' });
    await writeLastModelFailure(USER_A, { status: 429, at: NOW.toISOString(), detail: 'fresh' });

    expect((await readLastModelFailure(USER_A))?.status).toBe(429);
  });
});

describe('ответы по отказу модели: только свой отказ', () => {
  it('ответ при недоступной модели называет свой отказ, а не чужой', async () => {
    await writeLastModelFailure(USER_A, {
      status: 429,
      at: NOW.toISOString(),
      detail: 'provider answered 429: quota exceeded',
    });

    const ownReply = await modelOutageReply(USER_A, 'привет');
    const otherReply = await modelOutageReply(USER_B, 'привет');

    expect(ownReply).toContain('лимит запросов');
    expect(otherReply).toContain('нет ответа от провайдера');
    expect(otherReply).not.toContain('лимит запросов');
  });

  it('/diagnostics показывает отказ своего пользователя', async () => {
    await writeLastModelFailure(USER_B, {
      status: 503,
      at: NOW.toISOString(),
      detail: 'upstream down',
    });

    const ownText = await diagnosticsReply(USER_B);
    const otherText = await diagnosticsReply(USER_A);

    expect(ownText).toContain('Последний отказ модели');
    expect(otherText).not.toContain('Последний отказ модели');
  });
});
