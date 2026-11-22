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
import { kvSetJson, patchTurnTrace, readTurnTrace } from '../../src/lib/dal/misc';
import { listFailureAggregates } from '../../src/lib/evolution';
import type { Tool } from '../../src/lib/agent/registry';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER = 615161;
const NOW = new Date('2026-11-22T14:45:00Z');

const PROFILE = { userName: 'Иван', timezone: 'Europe/Belgrade', baseCurrency: 'EUR' };

/** Минимальный инструмент: крошке важно, что вызов был, а не что он делает. */
const echoTool: Tool = {
  name: 'echo_tool',
  effect: { kind: 'read' },
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

  it('пропущенные инструменты в текстовом протоколе — та же причина «tools-skipped»', async () => {
    // Легаси-ветка: модель ответила текстовым действием, нативных toolCalls нет.
    let calls = 0;
    const chatFn: AgentChatFn = async () => {
      calls += 1;
      return {
        content: '{"thought":"собери","action":"echo_tool","action_input":{"value":"a"}}',
        toolCalls: [],
      };
    };
    // Модель вернулась на 23-й секунде: резерв (26 − 4) съеден, инструмент не зовём.
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

  it('обрыв ответа по бюджету — дедлайн, а не штатный final', async () => {
    let calls = 0;
    const chatFn: AgentChatFn = async () => {
      calls += 1;
      // Ответ оборван по длине, а добор не влезает в бюджет (12 + floor 12 + 4 > 26):
      // частичный ответ отдаём, но ход обязан попасть в счётчик дедлайнов.
      return { content: 'Частичный ответ без конца', toolCalls: [], finishReason: 'length' };
    };
    const started = NOW.getTime();

    const result = await runAgent({
      userId: USER,
      text: 'расскажи подробно',
      tools: [],
      profile: PROFILE,
      chatFn,
      now: NOW,
      clock: () => started + (calls === 0 ? 0 : 12_000),
      store: null,
    });

    expect(calls).toBe(1);
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Частичный ответ без конца');

    const { trace, stats } = await readTurnTrace(USER);
    expect(trace?.stopReason).toBe('final');
    expect(trace?.deadlineCause).toBe('budget');
    expect(trace?.deadlineAt).not.toBeNull();
    expect(stats?.deadlineTurns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Имена тулз в крошке (аддитивное поле `tools`, формат `v1` не переписан)
// ---------------------------------------------------------------------------

describe('крошка хода: имена тулз', () => {
  /** Нативный вызов тулзы: имя попадает в крошку до самого вызова. */
  function nativeChat(): AgentChatFn {
    let calls = 0;
    return async () => {
      calls += 1;
      if (calls <= 2) {
        return {
          content: '',
          toolCalls: [{ id: `call_${calls}`, name: 'echo_tool', args: { value: String(calls) } }],
        };
      }
      return { content: 'Готово.', toolCalls: [] };
    };
  }

  it('нативный путь пишет имя тулзы, дубли не копятся', async () => {
    const result = await runAgent({
      userId: USER,
      text: 'сделай два раза',
      tools: [echoTool],
      profile: PROFILE,
      chatFn: nativeChat(),
      now: NOW,
      clock: () => NOW.getTime(),
      store: null,
    });

    expect(result.stopReason).toBe('final');
    expect(result.steps.filter((step) => step.action !== null)).toHaveLength(2);

    const { trace } = await readTurnTrace(USER);
    // Одна тулза дважды — имя одно: список нужен для форензики, а не для счёта.
    expect(trace?.tools).toEqual(['echo_tool']);
  });

  it('текстовый путь пишет имя тулзы так же', async () => {
    let calls = 0;
    const chatFn: AgentChatFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '{"thought":"эхо","action":"echo_tool","action_input":{"value":"a"}}',
          toolCalls: [],
        };
      }
      return { content: 'Готово.', toolCalls: [] };
    };

    const result = await runAgent({
      userId: USER,
      text: 'повтори за мной',
      tools: [echoTool],
      profile: PROFILE,
      chatFn,
      now: NOW,
      clock: () => NOW.getTime(),
      store: null,
    });

    expect(result.stopReason).toBe('final');

    const { trace } = await readTurnTrace(USER);
    expect(trace?.tools).toEqual(['echo_tool']);
  });

  it('старая запись без `tools` читается как пустой список и дописывается', async () => {
    await kvSetJson(`turn_trace:v1:${USER}`, {
      startedAt: '2026-11-22T14:00:00.000Z',
      updatedAt: '2026-11-22T14:00:01.000Z',
      stage: 'send',
      modelCalls: 1,
      models: ['gemini-3.8-flash'],
      deadlineAt: null,
      deadlineCause: null,
      indicator: 'none',
      stopReason: 'final',
    });

    const before = await readTurnTrace(USER);
    expect(before.trace?.tools).toEqual([]);

    await patchTurnTrace(USER, { stage: 'tool', tool: 'echo_tool' });

    const after = await readTurnTrace(USER);
    expect(after.trace?.tools).toEqual(['echo_tool']);
    expect(after.trace?.stage).toBe('tool');
  });
});
