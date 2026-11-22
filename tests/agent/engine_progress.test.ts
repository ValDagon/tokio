/**
 * Хук живой индикации в движке (`RunAgentOptions.onProgress`).
 *
 * Движок не знает про Telegram: он сообщает только факт стадии и имя тулзы, а
 * рисует строку `handlers/progress.ts`. Здесь проверяем контракт:
 *  1. стадия `model` приходит перед каждым обращением к модели;
 *  2. стадия `tool` — перед выполнением инструмента, с его именем;
 *  3. падение хука не рвёт прогон (индикатор — украшение).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, sqliteDDL } from '../mocks/sdk';
import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import type { Tool } from '../../src/lib/agent/registry';
import type { AgentProfile } from '../../src/lib/agent/prompts';
import { SYNTHESIZED_OBSERVATION, toolResultOf } from '../../src/lib/agent/sanitize';
import {
  runAgent,
  type AgentChatFn,
  type AgentChatResult,
  type AgentProgressEvent,
} from '../../src/lib/agent/engine';

const USER = 515151;
const NOW = new Date('2026-11-22T09:30:00Z');

const PROFILE: Partial<AgentProfile> = {
  userName: 'Иван',
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
};

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

/** Модель по сценарию: сначала инструмент, потом финальный ответ. */
function nativeChat(replies: readonly AgentChatResult[]): AgentChatFn {
  const queue = [...replies];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('native chat: ответы закончились');
    return next;
  };
}

function echoTool(order: string[]): Tool {
  return {
    name: 'echo',
    description: 'Возвращает переданный текст как есть',
    schema: { type: 'object', properties: { text: { type: 'string' } } },
    run: (args) => {
      order.push(`tool:${String(args.text ?? '')}`);
      return `эхо: ${String(args.text ?? '')}`;
    },
  };
}

describe('runAgent: хук прогресса', () => {
  it('сообщает стадии «модель → инструмент → модель» в правильном порядке', async () => {
    const order: string[] = [];
    const events: AgentProgressEvent[] = [];
    const chat = nativeChat([
      { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] },
      { content: 'Готово.', toolCalls: [] },
    ]);
    const wrapped: AgentChatFn = async (request) => {
      order.push(`model:${request.purpose}`);
      return chat(request);
    };

    const result = await runAgent({
      userId: USER,
      text: 'скажи привет',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: wrapped,
      profile: PROFILE,
      now: NOW,
      onProgress: (event) => {
        events.push(event);
        order.push(`progress:${event.stage}:${event.tool ?? ''}`);
      },
    });

    expect(result.stopReason).toBe('final');
    expect(order).toEqual([
      'progress:model:',
      'model:agent',
      'progress:tool:echo',
      'tool:привет',
      'progress:model:',
      'model:agent',
    ]);
    expect(events.map((event) => [event.stage, event.step, event.tool ?? null])).toEqual([
      ['model', 0, null],
      ['tool', 0, 'echo'],
      ['model', 1, null],
    ]);
  });

  it('медленный финальный вызов шлёт стадию ещё раз — после возврата модели', async () => {
    // Живой замер 22.11.2026: ход 14,5 с, единственный вызов модели оказался
    // финальным, и строку «⏳ …» не открыла ни одна стадия. Повторная стадия
    // после возврата модели даёт индикатору точку, на которой он открывается.
    let clock = 0;
    const events: AgentProgressEvent[] = [];
    const chat: AgentChatFn = async () => {
      clock += 14_500;
      return { content: 'Готово.', toolCalls: [] };
    };

    const result = await runAgent({
      userId: USER,
      text: 'посчитай бюджет',
      mode: 'action',
      tools: [],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
      onProgress: (event) => {
        events.push(event);
      },
    });

    expect(result.stopReason).toBe('final');
    expect(events.map((event) => [event.stage, event.step])).toEqual([
      ['model', 0],
      ['model', 0],
    ]);
  });

  it('падение хука не рвёт прогон', async () => {
    const order: string[] = [];
    const chat = nativeChat([
      { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] },
      { content: 'Готово.', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER,
      text: 'скажи привет',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      onProgress: () => {
        throw new Error('Telegram недоступен');
      },
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Готово.');
    expect(order).toEqual(['tool:привет']);
  });
});

describe('runAgent: мягкий дедлайн хода', () => {
  it('шаг вышел за бюджет — ответ есть, второго вызова модели нет', async () => {
    // Живой сбой 22.11.2026: «Разбери инбокс» шёл дольше лимита платформы
    // (~30 с), изолят убивали, и пользователь не получал ничего.
    let clock = 0;
    const requests: unknown[] = [];
    const chat: AgentChatFn = async (request) => {
      requests.push(request);
      // Модель ответила уже за дедлайном (24 с бюджета 26 с): инструменты звать нельзя.
      clock += 24_000;
      return { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] };
    };
    const order: string[] = [];

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс и разложи всё по задачам',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
    });

    expect(requests).toHaveLength(1);
    expect(order).toEqual([]);
    expect(result.stopReason).toBe('step_limit');
    expect(result.reply.trim().length).toBeGreaterThan(0);

    // Парность в треде сохранена честно: объявленный вызов получил наблюдение
    // «не выполнено», а не синтезированное «Действие успешно зафиксировано».
    const observations = result.thread
      .map((message) => toolResultOf(message))
      .filter((observation) => observation !== null);
    expect(observations).toEqual([{ id: 'c1', name: 'echo', ok: false }]);
    expect(result.thread.some((message) => message.content === SYNTHESIZED_OBSERVATION)).toBe(false);
  });

  it('на дедлайне отдаёт собранное, без синтеза и новых инструментов', async () => {
    let clock = 0;
    const requests: unknown[] = [];
    let replyIndex = 0;
    const chat: AgentChatFn = async (request) => {
      requests.push(request);
      replyIndex += 1;
      if (replyIndex === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] };
      clock += 24_000;
      return { content: '', toolCalls: [{ id: 'c2', name: 'echo', args: { text: 'ещё' } }] };
    };
    const order: string[] = [];

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
    });

    // Первый ход успел выполнить инструмент, второй — уже нет.
    expect(order).toEqual(['tool:привет']);
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe('step_limit');
    expect(result.reply).toContain('эхо: привет');
    expect(result.reply).toContain('следующим сообщением');
    expect(result.thread.at(-1)?.content).toBe(result.reply);
  });

  it('не начинает вызов модели, который не оставит времени на ответ', async () => {
    let clock = 0;
    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      // Первый вызов — 17 с (замеренное окно 14:19): следующий (17 + 12 + 4)
      // уже не влезает в бюджет, поэтому инструмент выполняется, а ответ
      // отдаётся детерминированно.
      clock += 17_000;
      return { content: '', toolCalls: [{ id: `c${calls}`, name: 'echo', args: { text: String(calls) } }] };
    };
    const order: string[] = [];

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
    });

    // Живой сбой 22.11.2026 14:19: медленный вызов съел бюджет, ответа не было.
    // После медленного вызова второго больше нет — отвечаем собранным.
    expect(calls).toBe(1);
    expect(order).toEqual(['tool:1']);
    expect(result.stopReason).toBe('step_limit');
    expect(result.reply).toContain('эхо: 1');
    expect(result.reply).toContain('следующим сообщением');
  });

  it('быстрый первый вызов оставляет второй — обычный ход не срезан', async () => {
    let clock = 0;
    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      // По 3 с на вызов: второй (3 + 12 + 4 = 19 с) ещё влезает в бюджет.
      clock += 3_000;
      return { content: '', toolCalls: [{ id: `c${calls}`, name: 'echo', args: { text: String(calls) } }] };
    };
    const order: string[] = [];

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
      maxSteps: 2,
    });

    expect(calls).toBe(3);
    expect(order).toEqual(['tool:1', 'tool:2']);
    expect(result.stopReason).toBe('step_limit');
  });

  it('время инструментов входит в бюджет, но не отменяет второй вызов', async () => {
    // Регрессия из ревью: раньше раунд «3 с модель + инструменты» упирался в
    // порог и обычный ход схлопывался в шаблон.
    let clock = 0;
    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      if (calls === 1) {
        clock += 3_000;
        return { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] };
      }
      clock += 15_000;
      return { content: 'Готово: привет.', toolCalls: [] };
    };
    const order: string[] = [];
    const slowEcho: Tool = {
      name: 'echo',
      description: 'Возвращает переданный текст как есть',
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      run: (args) => {
        clock += 1_500;
        order.push(`tool:${String(args.text ?? '')}`);
        return `эхо: ${String(args.text ?? '')}`;
      },
    };

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      mode: 'action',
      tools: [slowEcho],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
    });

    expect(calls).toBe(2);
    expect(order).toEqual(['tool:привет']);
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Готово: привет.');
  });

  it('первый вызов модели не блокируется даже маленьким бюджетом', async () => {
    // `turnBudgetMs` — публичная опция: значение меньше floor+reserve не должно
    // молча обнулять модель. Один вызов есть всегда, дальше — дедлайн.
    let clock = 0;
    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      clock += 1_000;
      return { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] };
    };
    const order: string[] = [];

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
      turnBudgetMs: 5_000,
    });

    expect(calls).toBe(1);
    expect(result.stopReason).toBe('step_limit');
  });

  it('резерв бюджета не даёт инструментам съесть время отправки', async () => {
    let clock = 0;
    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      // Вызов вернулся на 24-й секунде: до бюджета осталось 2 с — меньше
      // резерва, поэтому инструмент не выполняется, ответ уходит сразу.
      clock += 24_000;
      return { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] };
    };
    const order: string[] = [];

    const result = await runAgent({
      userId: USER,
      text: 'разбери инбокс',
      mode: 'action',
      tools: [echoTool(order)],
      store: null,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
      clock: () => clock,
    });

    expect(calls).toBe(1);
    expect(order).toEqual([]);
    expect(result.stopReason).toBe('step_limit');
    const observations = result.thread
      .map((message) => toolResultOf(message))
      .filter((observation) => observation !== null);
    expect(observations).toEqual([{ id: 'c1', name: 'echo', ok: false }]);
  });
});
