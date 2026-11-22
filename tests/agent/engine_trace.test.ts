/**
 * Крошка хода агента (`kv`).
 *
 * Зачем: 22.11.2026 ход «разбери инбокс» ответил дедлайном после отказа
 * `gemini-4-hydrogen`, и ни `/diagnostics`, ни `kv` не говорили, где ушло
 * время и почему не появилась строка «⏳ …». Крошка — три факта на ход:
 * до какой стадии он дошёл, почему сработал дедлайн (бюджет модели или
 * пропущенные инструменты) и что стало с индикатором.
 *
 * Правила, которые проверяются здесь:
 *  1. дедлайн пишет причину и увеличивает счётчик `deadlineTurns`;
 *  2. имя модели, которая ответила, попадает в крошку (запасная видна сразу);
 *  3. дедлайн по-прежнему не попадает в журнал сбоев.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, sqliteDDL } from '../mocks/sdk';
import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { readTurnTrace } from '../../src/lib/dal/misc';
import { listFailureAggregates } from '../../src/lib/evolution';
import type { Tool } from '../../src/lib/agent/registry';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER = 615161;
const NOW = new Date('2026-11-22T14:45:00Z');

const PROFILE = { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR' };

/** Минимальный инструмент: крошке важно, что вызов был, а не что он делает. */
const echoTool: Tool = {
  name: 'echo_tool',
  description: 'Возвращает значение',
  schema: { type: 'object', properties: { value: { type: 'string' } } },
  run: (args) => `эхо: ${String(args.value ?? '')}`,
};

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('крошка хода', () => {
  it('пишет причину дедлайна и увеличивает счётчик, не трогая журнал сбоев', async () => {
    let calls = 0;
    const chatFn: AgentChatFn = async () => {
      calls += 1;
      return {
        content: '',
        toolCalls: [{ id: `call_${calls}`, name: 'echo_tool', args: { value: 'a' } }],
        model: 'gemini-4-hydrogen',
      };
    };
    // Модель вернулась на 12-й секунде: инструмент ещё успевает, а следующий
    // вызов (12 + floor 12 + резерв 4 > 26) — уже нет.
    const started = NOW.getTime();

    const result = await runAgent({
      userId: USER,
      text: 'собери инбокс',
      tools: [echoTool],
      profile: PROFILE,
      chatFn,
      now: NOW,
      clock: () => started + (calls === 0 ? 0 : 12_000),
      store: null,
    });

    expect(calls).toBe(1);
    expect(result.stopReason).toBe('step_limit');

    const { trace, stats } = await readTurnTrace(USER);
    expect(trace?.stage).toBe('send');
    expect(trace?.deadlineCause).toBe('budget');
    expect(trace?.deadlineAt).not.toBeNull();
    expect(trace?.modelCalls).toBe(1);
    expect(stats?.turns).toBe(1);
    expect(stats?.deadlineTurns).toBe(1);

    const clusters = await listFailureAggregates(USER);
    expect(clusters).toHaveLength(0);
  });

  it('запоминает модель, которая ответила: запасная видна сразу', async () => {
    const chatFn: AgentChatFn = async () => ({
      content: 'Готово.',
      toolCalls: [],
      model: 'gemini-3.8-flash',
    });

    const result = await runAgent({
      userId: USER,
      text: 'привет',
      tools: [],
      profile: PROFILE,
      chatFn,
      now: NOW,
      store: null,
    });

    expect(result.stopReason).toBe('final');

    const { trace, stats } = await readTurnTrace(USER);
    expect(trace?.stage).toBe('send');
    expect(trace?.stopReason).toBe('final');
    expect(trace?.models).toEqual(['gemini-3.8-flash']);
    expect(trace?.deadlineAt).toBeNull();
    expect(stats?.turns).toBe(1);
    expect(stats?.deadlineTurns).toBe(0);
  });

  it('при пропущенных инструментах говорит «инструменты не успели»', async () => {
    let calls = 0;
    const chatFn: AgentChatFn = async () => {
      calls += 1;
      return {
        content: '',
        toolCalls: [{ id: `call_${calls}`, name: 'echo_tool', args: { value: 'a' } }],
        model: 'gemini-4-hydrogen',
      };
    };
    // Модель вернулась на 23-й секунде: резерв (26 − 4) уже съеден, инструмент
    // не выполняется — это отдельная причина дедлайна.
    const started = NOW.getTime();

    const result = await runAgent({
      userId: USER,
      text: 'сделай что-нибудь',
      tools: [echoTool],
      profile: PROFILE,
      chatFn,
      now: NOW,
      clock: () => started + (calls === 0 ? 0 : 23_000),
      store: null,
    });

    expect(result.stopReason).toBe('step_limit');

    const { trace, stats } = await readTurnTrace(USER);
    expect(trace?.deadlineCause).toBe('tools-skipped');
    expect(stats?.deadlineTurns).toBe(1);
  });
});
