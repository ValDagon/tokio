/**
 * Тулза `read_turn_log` (тикет LOGREAD1): агент читает собственный журнал хода.
 *
 * Владелец 23.11.2026 спросил «а почему ты не можешь сам читать логи сессий моих
 * в боте?» — до этой тулзы ни один инструмент не читал `turn_trace:v1`, поэтому
 * на «почему ты молчал» агент отвечал догадками. Держим инварианты:
 *
 *  - владелец берётся **только** из `ctx`: аргумент `user_id` игнорируется,
 *    иначе один пользователь прочитал бы чужой журнал;
 *  - пустой журнал — честный `null`-ответ, а не исключение и не выдуманные поля;
 *  - битая форма крошки (число/объект/строка вместо массива) не роняет тулзу:
 *    `kv` отдаёт JSON строкой, и разбор обязан это пережить;
 *  - `detail` отказа модели отдаётся без секретов, `providerBody` — не отдаётся;
 *  - тулза read-only: `kv` после вызова байт в байт тот же.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import type { Tool, ToolContext, ToolOutcome } from '../../src/lib/agent/registry';
import { reasoningTools } from '../../src/lib/agent/tools/reasoning';
import { kvGet, kvSetJson, patchTurnTrace, readTurnTrace, startTurnTrace } from '../../src/lib/dal/misc';

const USER_A = 1;
const USER_B = 2;

const NOW = new Date('2026-11-23T10:00:00.000Z');

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

/** Ход с метками, по которым считается длительность: 17,1 с. */
const TRACE_A = {
  startedAt: '2026-11-23T04:46:19.413Z',
  updatedAt: '2026-11-23T04:46:36.532Z',
  stage: 'send',
  modelCalls: 2,
  models: ['gemini-4-hydrogen'],
  tools: ['list_tasks', 'get_balance'],
  deadlineAt: null,
  deadlineCause: null,
  indicator: 'shown',
  stopReason: 'final',
};

interface TurnLogData {
  userId: number;
  trace: {
    startedAt: string;
    updatedAt: string;
    stage: string;
    modelCalls: number;
    models: string[];
    tools: string[];
    deadlineAt: string | null;
    deadlineCause: 'budget' | 'tools-skipped' | null;
    indicator: 'none' | 'shown' | 'unavailable';
    stopReason: string | null;
  } | null;
  stats: { turns: number; deadlineTurns: number; updatedAt: string | null } | null;
  lastFailure: { status: number; at: string | null; detail: string | null } | null;
}

function tool(): Tool {
  const found = reasoningTools.find((candidate) => candidate.name === 'read_turn_log');
  if (!found) throw new Error('тулза read_turn_log не зарегистрирована в reasoningTools');
  return found;
}

async function run(
  args: Record<string, unknown> = {},
  ctx: ToolContext = CTX_A,
): Promise<{ outcome: ToolOutcome; data: TurnLogData }> {
  const outcome = await tool().run(args, ctx);
  const normalized = typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
  return { outcome: normalized, data: normalized.data as TurnLogData };
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('read_turn_log: пустой и битый журнал', () => {
  it('пустой kv — честный null-ответ, а не исключение', async () => {
    const { outcome, data } = await run();

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Журнала ходов нет');
    expect(data.trace).toBeNull();
    expect(data.stats).toBeNull();
    expect(data.lastFailure).toBeNull();
  });

  it('битая крошка не бросает и приводится к безопасной форме', async () => {
    // Всё, что может оказаться в `kv` вместо нормальной записи: числа, объекты,
    // строка вместо массива, неизвестные токены стадии и индикатора.
    await kvSetJson(`turn_trace:v1:${USER_A}`, {
      startedAt: 42,
      updatedAt: null,
      stage: { code: 'send' },
      modelCalls: 'два',
      models: [1, 'gemini-4-hydrogen', null],
      tools: 'list_tasks',
      deadlineAt: 7,
      deadlineCause: 'unknown',
      indicator: 'weird',
      stopReason: { code: 'x' },
    });

    const { outcome, data } = await run();

    expect(outcome.ok).toBe(true);
    expect(data.trace).not.toBeNull();
    expect(data.trace?.stage).toBe('[object Object]');
    expect(data.trace?.models).toEqual(['gemini-4-hydrogen']);
    expect(data.trace?.tools).toEqual([]);
    expect(data.trace?.modelCalls).toBe(0);
    expect(data.trace?.startedAt).toBe('42');
    expect(data.trace?.updatedAt).toBe('');
    expect(data.trace?.deadlineAt).toBe('7');
    expect(data.trace?.deadlineCause).toBeNull();
    expect(data.trace?.indicator).toBe('none');
    expect(data.trace?.stopReason).toBe('[object Object]');
    // Дедлайна нет — строка говорит «нет», а не печатает неизвестный токен.
    expect(outcome.content).toContain('Дедлайн: нет');
  });

  it('скаляр вместо крошки читается как «читать нечего», а не как прочерки', async () => {
    // `kv` отдаёт строкой JSON, и там может лежать что угодно: `normalizeTrace`
    // разворачивает число в пустой объект, но хода за этим нет.
    await kvSetJson(`turn_trace:v1:${USER_A}`, 42);

    const { outcome, data } = await run();

    expect(outcome.ok).toBe(true);
    expect(data.trace).toBeNull();
    expect(outcome.content).toContain('Журнала ходов нет');
    expect(outcome.content).not.toContain('Стадия:');
  });

  it('счётчики без крошки — ответ по счётчикам, без выдуманных полей хода', async () => {
    await kvSetJson(`turn_stats:v1:${USER_A}`, {
      turns: 12,
      deadlineTurns: 3,
      updatedAt: '2026-11-23T04:46:36.532Z',
    });

    const { outcome, data } = await run();

    expect(data.trace).toBeNull();
    expect(data.stats).toEqual({
      turns: 12,
      deadlineTurns: 3,
      updatedAt: '2026-11-23T04:46:36.532Z',
    });
    expect(outcome.content).toContain('Крошки последнего хода нет');
    expect(outcome.content).toContain('Ходов всего: 12');
    expect(outcome.content).toContain('по дедлайну: 3');
  });
});

describe('read_turn_log: что видит модель', () => {
  it('пересказывает все поля крошки и считает длительность хода', async () => {
    await startTurnTrace(USER_A);
    await kvSetJson(`turn_trace:v1:${USER_A}`, TRACE_A);
    await kvSetJson(`turn_stats:v1:${USER_A}`, {
      turns: 4,
      deadlineTurns: 1,
      updatedAt: '2026-11-23T04:46:36.532Z',
    });

    const { outcome, data } = await run();

    expect(data.trace).toEqual({ ...TRACE_A });
    expect(outcome.content).toContain('2026-11-23T04:46:19.413Z');
    expect(outcome.content).toContain('2026-11-23T04:46:36.532Z');
    expect(outcome.content).toContain('длительность 17.1 с');
    expect(outcome.content).toContain('Стадия: send');
    expect(outcome.content).toContain('вызовов модели: 2');
    expect(outcome.content).toContain('Модели: gemini-4-hydrogen');
    expect(outcome.content).toContain('Инструменты: list_tasks, get_balance');
    expect(outcome.content).toContain('Индикатор «⏳ …»: shown');
    expect(outcome.content).toContain('Причина остановки: final');
    expect(outcome.content).toContain('Ходов всего: 4');
    expect(outcome.content).toContain('из них по дедлайну: 1');
  });

  it('показывает причину дедлайна и его время', async () => {
    await startTurnTrace(USER_A);
    await patchTurnTrace(USER_A, { stage: 'tool', deadline: 'tools-skipped' });

    const { data } = await run();

    expect(data.trace?.deadlineCause).toBe('tools-skipped');
    expect(data.trace?.deadlineAt).not.toBeNull();
    expect(data.stats?.deadlineTurns).toBe(1);
  });

  it('последний отказ модели — со статусом и временем, но без секретов', async () => {
    await kvSetJson(`llm_last_failure:${USER_A}`, {
      status: 429,
      at: '2026-11-22T10:00:00.000Z',
      // Секрет в том виде, в каком он попадает в `error.message` провайдера.
      detail: 'provider answered 429: quota for key AIzaSyTESTdummy00000000000000000000000 exceeded',
      // Сырое тело провайдера в наблюдение модели не едет.
      providerBody: '{"error":{"message":"provider-body-marker"}}',
    });

    const { outcome, data } = await run();

    expect(data.lastFailure?.status).toBe(429);
    expect(data.lastFailure?.at).toBe('2026-11-22T10:00:00.000Z');
    expect(outcome.content).toContain('статус 429');
    expect(outcome.content).toContain('2026-11-22T10:00:00.000Z');
    expect(outcome.content).toContain('quota for key');
    expect(outcome.content).not.toContain('AIzaSyTESTdummy00000000000000000000000');
    expect(outcome.content).not.toContain('provider-body-marker');
  });

  it('битый llm_last_failure читается как «отказов нет»', async () => {
    await kvSetJson(`turn_trace:v1:${USER_A}`, TRACE_A);
    await kvSetJson('llm_last_failure', 'не объект');

    const { outcome, data } = await run();

    expect(data.lastFailure).toBeNull();
    expect(outcome.content).toContain('Отказов модели в журнале нет');
  });

  it('отказ другого пользователя в свой журнал не попадает', async () => {
    await kvSetJson(`turn_trace:v1:${USER_A}`, TRACE_A);
    await kvSetJson(`llm_last_failure:${USER_B}`, {
      status: 429,
      at: '2026-11-22T10:00:00.000Z',
      detail: 'quota for another account',
    });

    const { outcome, data } = await run();

    expect(data.lastFailure).toBeNull();
    expect(outcome.content).not.toContain('quota for another account');
    expect(outcome.content).toContain('Отказов модели в журнале нет');
  });

  it('старый глобальный ключ читается, пока персонального нет', async () => {
    await kvSetJson(`turn_trace:v1:${USER_A}`, TRACE_A);
    await kvSetJson('llm_last_failure', {
      status: 500,
      at: new Date().toISOString(),
      detail: 'upstream down',
    });

    const { outcome, data } = await run();

    expect(data.lastFailure?.status).toBe(500);
    expect(outcome.content).toContain('статус 500');
  });
});

describe('read_turn_log: только свои данные', () => {
  it('берёт владельца из ctx и игнорирует user_id в аргументах', async () => {
    await kvSetJson(`turn_trace:v1:${USER_A}`, { ...TRACE_A, stage: 'send' });
    await kvSetJson(`turn_trace:v1:${USER_B}`, {
      ...TRACE_A,
      stage: 'start',
      models: ['чужая-модель'],
      tools: ['чужой-инструмент'],
    });

    const { outcome, data } = await run({ user_id: USER_B, userId: USER_B });

    expect(data.userId).toBe(USER_A);
    expect(data.trace?.stage).toBe('send');
    expect(data.trace?.models).toEqual(['gemini-4-hydrogen']);
    expect(outcome.content).not.toContain('чужая-модель');
    expect(outcome.content).not.toContain('чужой-инструмент');
  });

  it('read-only: ничего не пишет в kv', async () => {
    await kvSetJson(`turn_trace:v1:${USER_A}`, TRACE_A);
    await kvSetJson('llm_last_failure', { status: 500, at: '2026-11-22T10:00:00.000Z' });

    const before = {
      trace: await kvGet(`turn_trace:v1:${USER_A}`),
      stats: await kvGet(`turn_stats:v1:${USER_A}`),
      failure: await kvGet('llm_last_failure'),
    };
    await run();
    const after = {
      trace: await kvGet(`turn_trace:v1:${USER_A}`),
      stats: await kvGet(`turn_stats:v1:${USER_A}`),
      failure: await kvGet('llm_last_failure'),
    };

    expect(after).toEqual(before);
    // Счётчик ходов тулза не инкрементит: `turn_stats` остался пустым.
    const { stats } = await readTurnTrace(USER_A);
    expect(stats).toBeNull();
  });
});
