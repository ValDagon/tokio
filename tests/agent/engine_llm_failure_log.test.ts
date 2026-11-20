/**
 * Журнал отказов модели.
 *
 * Причина последнего `llm_error` пишется в `kv` (`llm_last_failure`), чтобы
 * ответ при недоступной модели говорил, что именно случилось («лимит
 * запросов» vs «провайдер не ответил»), а не «попробуйте позже». Запись —
 * вспомогательная: её сбой не имеет права уронить ход.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { kvGetJson } from '../../src/lib/dal/misc';
import { listFailureAggregates } from '../../src/lib/evolution';
import type { Tool } from '../../src/lib/agent/registry';
import { runAgent, type AgentChatFn } from '../../src/lib/agent/engine';

const USER = 505;
const NOW = new Date('2026-11-14T12:41:00Z');

interface FailureRecord {
  status: number;
  at: string;
  detail: string;
  providerBody?: string | null;
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('журнал отказов модели', () => {
  it('пишет статус и текст ошибки провайдера', async () => {
    const chatFn: AgentChatFn = async () => {
      throw Object.assign(new Error('gemini: model-a answered 429: quota exceeded'), { status: 429 });
    };

    const result = await runAgent({
      userId: USER,
      text: 'куда я потратил деньги?',
      tools: [],
      chatFn,
      now: NOW,
    });

    expect(result.stopReason).toBe('llm_error');
    const failure = await kvGetJson<FailureRecord | null>('llm_last_failure', null);
    expect(failure?.status).toBe(429);
    expect(failure?.detail).toContain('quota exceeded');
  });

  it('сохраняет тело отказа провайдера, а не только число', async () => {
    const body = JSON.stringify({
      error: { code: 400, message: 'Function call is missing a name', status: 'INVALID_ARGUMENT' },
    });
    const chatFn: AgentChatFn = async () => {
      throw Object.assign(new Error('gemini: model-a answered 400: Function call is missing a name'), {
        status: 400,
        body,
      });
    };

    const result = await runAgent({ userId: USER, text: 'привет', tools: [], chatFn, now: NOW });

    expect(result.stopReason).toBe('llm_error');
    const failure = await kvGetJson<FailureRecord | null>('llm_last_failure', null);
    expect(failure?.status).toBe(400);
    expect(failure?.providerBody).toBe(body);
  });

  it('без тела отказа пишет providerBody: null, а не выдумку', async () => {
    const chatFn: AgentChatFn = async () => {
      throw Object.assign(new Error('gemini: model-a answered 400: bad request'), { status: 400 });
    };

    await runAgent({ userId: USER, text: 'привет', tools: [], chatFn, now: NOW });

    const failure = await kvGetJson<FailureRecord | null>('llm_last_failure', null);
    expect(failure?.status).toBe(400);
    expect(failure?.providerBody).toBeNull();
  });

  it('старый ключ остаётся, а рядом появляется нормализованная сигнатура', async () => {
    const chatFn: AgentChatFn = async () => {
      throw Object.assign(new Error('gemini: model-a answered 503: upstream down'), { status: 503 });
    };

    await runAgent({ userId: USER, text: 'привет', tools: [], chatFn, now: NOW });

    // Совместимость: по этому ключу работает ответ при недоступной модели.
    expect(await kvGetJson<FailureRecord | null>('llm_last_failure', null)).not.toBeNull();

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate).toMatchObject({
      signature: 'agent|none|llm_error|-',
      stage: 'agent',
      reason: 'llm_error',
      count: 1,
    });
    expect(aggregate?.detail).toContain('upstream down');
  });
});

// ---------------------------------------------------------------------------
// MU-3B — терминальные причины прогона в нормализованном журнале
// ---------------------------------------------------------------------------

/** Модель по сценарию: отдаёт заранее заданные ответы по порядку. */
function scriptedChat(replies: readonly string[]): AgentChatFn {
  const queue = [...replies];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('scripted chat: ответы закончились');
    return next;
  };
}

const ACTION = (name: string, args: Record<string, unknown> = {}): string =>
  `Thought: нужен инструмент.\nAction: ${name}\nAction Input: ${JSON.stringify(args)}`;

const brokenTool: Tool = {
  name: 'broken',
  description: 'Всегда падает с исключением',
  run: () => {
    throw new Error('boom');
  },
};

const destructiveTool: Tool = {
  name: 'wipe',
  description: 'Удаляет всё, требует подтверждения',
  destructive: true,
  run: () => 'удалено',
};

const refusalTool: Tool = {
  name: 'add_expense',
  description: 'Отказывает по средствам',
  run: () => {
    const error = new Error('на счёте не хватает денег');
    error.name = 'InsufficientFundsError';
    throw error;
  },
};

describe('журнал: терминальные причины и отказы инструментов', () => {
  it('пустой ответ модели пишется как empty_reply', async () => {
    await runAgent({
      userId: USER,
      text: 'ответь пусто',
      tools: [],
      store: null,
      chatFn: scriptedChat(['   ']),
      now: NOW,
    });

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate).toMatchObject({
      signature: 'agent|none|empty_reply|-',
      reason: 'empty_reply',
      count: 1,
    });
  });

  it('лимит шагов пишется как step_limit, а не как сбой инструмента', async () => {
    await runAgent({
      userId: USER,
      text: 'зациклись',
      maxSteps: 1,
      tools: [
        {
          name: 'echo',
          description: 'эхо',
          run: (args) => `эхо: ${String(args.text ?? '')}`,
        },
      ],
      store: null,
      chatFn: scriptedChat([ACTION('echo', { text: 'a' })]),
      now: NOW,
    });

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates.map((item) => item.signature)).toEqual(['agent|none|step_limit|-']);
  });

  it('неожиданный отказ инструмента несёт его имя', async () => {
    const result = await runAgent({
      userId: USER,
      text: 'сломайся',
      tools: [brokenTool],
      store: null,
      chatFn: scriptedChat([ACTION('broken'), 'Готово.']),
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate).toMatchObject({
      signature: 'agent|none|tool_error|broken',
      reason: 'tool_error',
      tool: 'broken',
      count: 1,
    });
  });

  it('ожидаемый отказ по средствам сигнатуру не создаёт', async () => {
    const result = await runAgent({
      userId: USER,
      text: 'потрать 100',
      tools: [refusalTool],
      store: null,
      chatFn: scriptedChat([ACTION('add_expense'), 'Денег нет, записывать не стал.']),
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(await listFailureAggregates(USER)).toEqual([]);
  });

  it('запрос подтверждения — не сбой: журнал пуст', async () => {
    const result = await runAgent({
      userId: USER,
      text: 'удали всё',
      tools: [destructiveTool],
      store: null,
      chatFn: scriptedChat([ACTION('wipe')]),
      now: NOW,
    });

    expect(result.stopReason).toBe('confirm');
    expect(await listFailureAggregates(USER)).toEqual([]);
  });

  it('повторный прогон с тем же исходом увеличивает тот же счётчик', async () => {
    const run = (): Promise<unknown> =>
      runAgent({
        userId: USER,
        text: 'сломайся',
        tools: [brokenTool],
        store: null,
        chatFn: scriptedChat([ACTION('broken'), 'Готово.']),
        now: NOW,
      });

    await run();
    await run();

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.count).toBe(2);
  });
});
