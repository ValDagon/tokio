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
      // Модель ответила уже за дедлайном: инструменты звать нельзя.
      clock += 21_000;
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
  });

  it('на дедлайне отдаёт собранное, без синтеза и новых инструментов', async () => {
    let clock = 0;
    const requests: unknown[] = [];
    let replyIndex = 0;
    const chat: AgentChatFn = async (request) => {
      requests.push(request);
      replyIndex += 1;
      if (replyIndex === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'привет' } }] };
      clock += 21_000;
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

  it('не начинает вызов модели, который сам выведет ход за бюджет', async () => {
    let clock = 0;
    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      // Каждый вызов модели — 8 с: третий (8 + 8 + 8 = 24 с) уже не влезает.
      clock += 8_000;
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

    expect(calls).toBe(2);
    expect(result.stopReason).toBe('step_limit');
    expect(result.reply.trim().length).toBeGreaterThan(0);
  });
});
