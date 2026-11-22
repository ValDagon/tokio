/**
 * Движок ReAct (`src/lib/agent/engine.ts`).
 *
 * Что проверяем (SPEC §3 T11, §2.3):
 *  1) полный цикл Thought → Action → Action Input → Observation → Final Answer
 *     с записью шагов и треда в хранилище;
 *  2) устойчивость: неизвестный/нераспознанный инструмент и падение тулзы не
 *     рвут прогон, а уходят модели как наблюдение с ошибкой;
 *  3) лимит шагов даёт пользователю ответ по собранному, а не ошибку;
 *  4) пустой ответ модели и сбой LLM превращаются в `stopReason`, а испорченная
 *     история лечится автоматическим сбросом и повтором;
 *  5) персонализация приходит только через профиль (`options.profile`), промпт
 *     и контекст инструментов собираются из него, а не из констант (ADR-002);
 *  6) прогоны изолированы по пользователям и сериализуются внутри одного
 *     пользователя (per-user lock вместо Postgres-чекпоинта).
 *
 * Ни БД, ни сети: `chatFn` и `store` инъектируются. Модуль `lib/gemini.ts`
 * импортируется движком, но вызовов к нему в тестах нет — `chatFn` подменён.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSqlite, resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { createLiability } from '../../src/lib/dal/finances';
import { createMedication, takeMedication } from '../../src/lib/dal/medications';
import { createTask } from '../../src/lib/dal/tasks';
import { ensureUser, updateUser } from '../../src/lib/dal/users';
import type { AgentMessage } from '../../src/types';
import {
  DEFAULT_MAX_STEPS,
  EMPTY_REPLY_TEXT,
  LLM_ERROR_TEXT,
  MAX_CONSECUTIVE_DUPLICATE_TURNS,
  MAX_STEPS_CAP,
  MAX_TOOL_CALLS_PER_RUN,
  READ_ONLY_TOOL_NAMES,
  isRecoverableHistoryError,
  joinContinuation,
  loadAgentProfile,
  parseActionArgs,
  parseAgentReply,
  pendingAgentRuns,
  runAgent,
  type AgentChatFn,
  type AgentChatRequest,
  type AgentChatResult,
  type AgentThreadStore,
} from '../../src/lib/agent/engine';
import type { AgentProfile } from '../../src/lib/agent/prompts';
import type { ProviderChatMessage } from '../../src/lib/provider/types';
import type { Tool, ToolContext } from '../../src/lib/agent/registry';

const USER_A = 101;
const USER_B = 202;

/** Пятница, 6 ноября 2026 — фиксированный момент прогона. */
const NOW = new Date('2026-11-06T09:30:00Z');

/** Профиль, который в проде читается из БД (`loadAgentProfile`). */
const PROFILE: Partial<AgentProfile> = {
  userName: 'Иван',
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  personaStyle: 'mentor',
  customInstructions: 'Отвечай коротко и по делу.',
};

/** Тред в памяти — аналог `agent_state` для тестов движка. */
class MemoryStore implements AgentThreadStore {
  readonly threads = new Map<number, AgentMessage[]>();
  loadCalls = 0;
  saveCalls = 0;
  clearCalls = 0;

  async load(userId: number): Promise<AgentMessage[]> {
    this.loadCalls += 1;
    return (this.threads.get(userId) ?? []).map((message) => ({ ...message }));
  }

  async save(userId: number, thread: readonly AgentMessage[]): Promise<void> {
    this.saveCalls += 1;
    this.threads.set(
      userId,
      thread.map((message) => ({ ...message })),
    );
  }

  async clear(userId: number): Promise<void> {
    this.clearCalls += 1;
    this.threads.delete(userId);
  }
}

/** Модель по сценарию: отдаёт заранее заданные ответы по порядку. */
function scriptedChat(replies: readonly string[]): {
  fn: AgentChatFn;
  requests: AgentChatRequest[];
  calls: () => number;
} {
  const queue = [...replies];
  const requests: AgentChatRequest[] = [];
  const fn: AgentChatFn = async (request) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error('scripted chat: ответы закончились');
    return next;
  };
  return { fn, requests, calls: () => requests.length };
}

/** Модель по сценарию: отдаёт ответы (строка или `{ content, toolCalls }`). */
function nativeChat(replies: readonly AgentChatResult[]): {
  fn: AgentChatFn;
  requests: AgentChatRequest[];
} {
  const queue = [...replies];
  const requests: AgentChatRequest[] = [];
  const fn: AgentChatFn = async (request) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error('native chat: ответы закончились');
    return next;
  };
  return { fn, requests };
}

/** Инструменты прогона: эхо (успех), сломанный (исключение), тихий (пусто). */
function makeTools(): {
  tools: Tool[];
  calls: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }> = [];

  const echo: Tool = {
    name: 'echo',
    effect: { kind: 'read' },
    description: 'Возвращает переданный текст как есть',
    schema: { type: 'object', properties: { text: { type: 'string' } } },
    run: (args, ctx) => {
      calls.push({ name: 'echo', args, ctx });
      return `эхо: ${String(args.text ?? '')}`;
    },
  };

  const broken: Tool = {
    name: 'broken',
    effect: { kind: 'read' },
    description: 'Всегда падает с исключением',
    run: () => {
      throw new Error('boom');
    },
  };

  const silent: Tool = {
    name: 'silent',
    effect: { kind: 'read' },
    description: 'Возвращает пустой исход',
    run: () => ({ ok: true, content: '   ' }),
  };

  return { tools: [echo, broken, silent], calls };
}

const REPLAY_ACTION = (text: string): string =>
  `Thought: нужен инструмент.\nAction: echo\nAction Input: {"text": "${text}"}`;

beforeEach(() => {
  // Реестр-синглтон между тестами не трогаем: движку передаём `tools` явно.
  expect(pendingAgentRuns()).toBe(0);
});

// ---------------------------------------------------------------------------
// Цикл
// ---------------------------------------------------------------------------

describe('runAgent: полный цикл ReAct', () => {
  it('идёт по маршруту Thought → Action → Observation → Final Answer', async () => {
    const { tools, calls } = makeTools();
    const store = new MemoryStore();
    const chat = scriptedChat([
      'Thought: нужен факт из инструмента.\nAction: echo\nAction Input: {"text": "привет"}',
      'Thought: факт получен.\nFinal Answer: Готово: привет',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'скажи привет',
      mode: 'action',
      tools,
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Готово: привет');
    expect(result.mode).toBe('action');
    expect(result.steps).toHaveLength(2);

    expect(result.steps[0]).toMatchObject({
      index: 0,
      action: { name: 'echo', args: { text: 'привет' } },
      observation: 'эхо: привет',
      ok: true,
    });
    expect(result.steps[0]?.thought).toContain('нужен факт');
    expect(result.steps[1]).toMatchObject({ index: 1, action: null, observation: null, ok: true });

    // Инструмент получил аргументы и контекст прогона.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ text: 'привет' });
    expect(calls[0]?.ctx).toMatchObject({
      userId: USER_A,
      timezone: 'Europe/Belgrade',
      baseCurrency: 'EUR',
    });
    expect(calls[0]?.ctx.now).toBe(NOW);

    // Модель получила системный промпт, историю пользователя и наблюдение.
    expect(chat.calls()).toBe(2);
    expect(chat.requests[0]?.purpose).toBe('agent');
    expect(chat.requests[0]?.userId).toBe(USER_A);
    expect(chat.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'скажи привет' });
    expect(chat.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '',
      toolResults: [{ toolCallId: 'call_1', content: 'эхо: привет' }],
    });

    // Тред сохранён целиком: реплика, шаг модели с вызовом, наблюдение, финал.
    const thread = store.threads.get(USER_A) ?? [];
    expect(thread.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(thread[1]?.meta?.toolCalls).toEqual([
      { id: 'call_1', name: 'echo', args: { text: 'привет' } },
    ]);
    expect(thread[2]?.meta?.toolResult).toEqual({ id: 'call_1', name: 'echo', ok: true });
    expect(thread[3]?.content).toContain('Final Answer: Готово: привет');
    expect(store.saveCalls).toBe(1);
  });

  it('принимает JSON-протокол вместо текстового', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([
      '{"thought": "нужен текст", "action": "echo", "action_input": {"text": "json"}}',
      '{"final_answer": "Готово: json"}',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'проверь json',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Готово: json');
    expect(result.steps[0]?.observation).toBe('эхо: json');
  });
});

// ---------------------------------------------------------------------------
// Устойчивость
// ---------------------------------------------------------------------------

describe('runAgent: ошибки инструментов не рвут прогон', () => {
  it('неизвестный инструмент даёт наблюдение с подсказкой', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([
      'Thought: попробую магию.\nAction: do_magic\nAction Input: {}',
      'Thought: инструмента нет.\nFinal Answer: Такого действия у меня нет.',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'сделай магию',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.steps[0]?.ok).toBe(false);
    expect(result.steps[0]?.observation).toContain('не найден');
    expect(result.steps[0]?.observation).toContain('echo');
    expect(result.reply).toBe('Такого действия у меня нет.');
  });

  it('нераспознанное имя инструмента не превращается в исключение', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([
      'Thought: назову инструмент странно.\nAction: ###\nAction Input: {}',
      'Final Answer: Попробую иначе.',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'странный вызов',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.steps[0]?.ok).toBe(false);
    expect(result.steps[0]?.observation).toContain('не распознано');
    expect(result.steps[0]?.observation).toContain('echo');
    expect(result.steps[0]?.action?.name).toBe('###');
  });

  it('исключение инструмента уходит модели текстом ошибки', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([
      'Thought: вызову сломанный.\nAction: broken\nAction Input: {}',
      'Final Answer: Инструмент недоступен.',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'сломайся',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.steps[0]?.ok).toBe(false);
    expect(result.steps[0]?.observation).toContain('завершился ошибкой');
    expect(result.steps[0]?.observation).toContain('boom');
    expect(result.reply).toBe('Инструмент недоступен.');
  });

  it('пустой ответ инструмента заменяется заглушкой', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([
      'Thought: вызову тихий.\nAction: silent\nAction Input: {}',
      'Final Answer: Готово.',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'тихий вызов',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.steps[0]?.ok).toBe(true);
    expect(result.steps[0]?.observation).toBe('Готово.');
  });
});

// ---------------------------------------------------------------------------
// Остановки
// ---------------------------------------------------------------------------

describe('runAgent: graceful-остановки', () => {
  it('на лимите шагов и отказе синтеза отдаёт последнее наблюдение, а не ошибку', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([
      REPLAY_ACTION('a'),
      REPLAY_ACTION('b'),
      REPLAY_ACTION('c'),
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'зациклись',
      maxSteps: 2,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    // 2 рабочих хода + 1 финальный ход синтеза (который в сценарии вернул Action вместо ответа).
    expect(chat.calls()).toBe(3);
    expect(result.stopReason).toBe('step_limit');
    expect(result.steps).toHaveLength(2);
    expect(result.reply).toContain('лимите шагов');
    expect(result.reply).toContain('эхо: b');
    expect(result.thread.at(-1)?.content).toBe(result.reply);
  });

  it('maxSteps = 0 поднимается до одного шага', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat([REPLAY_ACTION('one')]);

    const result = await runAgent({
      userId: USER_A,
      text: 'один шаг',
      maxSteps: 0,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.steps).toHaveLength(1);
    expect(result.stopReason).toBe('step_limit');
    // 1 рабочий ход + 1 попытка синтеза без ответа в scriptedChat → фолбэк.
    expect(chat.calls()).toBe(2);
  });

  it('пустой ответ модели — empty_reply без падения', async () => {
    const store = new MemoryStore();
    const chat = scriptedChat(['   ']);

    const result = await runAgent({
      userId: USER_A,
      text: 'ответь пусто',
      tools: [],
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('empty_reply');
    expect(result.reply).toBe(EMPTY_REPLY_TEXT);
    expect(result.steps).toHaveLength(0);
    expect(store.threads.get(USER_A)?.map((message) => message.role)).toEqual(['user']);
  });

  it('пустая реплика не вызывает модель и не пишет в хранилище', async () => {
    const store = new MemoryStore();
    const chat = scriptedChat([]);

    const result = await runAgent({
      userId: USER_A,
      text: '   ',
      tools: [],
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(chat.calls()).toBe(0);
    expect(result.reply).toBe('');
    expect(result.steps).toHaveLength(0);
    expect(result.stopReason).toBe('empty_reply');
    expect(store.saveCalls).toBe(0);
    expect(store.loadCalls).toBe(1);
  });

  it('сбой модели не связанный с историей — llm_error', async () => {
    const store = new MemoryStore();
    const chat: AgentChatFn = async () => {
      throw new Error('RESOURCE_EXHAUSTED: quota exceeded');
    };

    const result = await runAgent({
      userId: USER_A,
      text: 'сломай модель',
      tools: [],
      store,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('llm_error');
    expect(result.reply).toBe(LLM_ERROR_TEXT);
    expect(store.clearCalls).toBe(0);
    expect(store.threads.get(USER_A)?.map((message) => message.role)).toEqual(['user']);
  });

  it('сбой записи треда не отнимает готовый ответ', async () => {
    const store: AgentThreadStore = {
      load: async () => [],
      save: async () => {
        throw new Error('db is down');
      },
      clear: async () => undefined,
    };
    const chat = scriptedChat(['Final Answer: Ответ есть.']);

    const result = await runAgent({
      userId: USER_A,
      text: 'ответь',
      tools: [],
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.reply).toBe('Ответ есть.');
    expect(result.stopReason).toBe('final');
  });
});

// ---------------------------------------------------------------------------
// Испорченная история
// ---------------------------------------------------------------------------

describe('runAgent: автолечение истории', () => {
  it('сбрасывает историю и повторяет запрос один раз', async () => {
    const store = new MemoryStore();
    await store.save(USER_A, [
      { role: 'user', content: 'старая реплика' },
      { role: 'assistant', content: 'старый ответ' },
    ]);

    const requests: AgentChatRequest[] = [];
    const chat: AgentChatFn = async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new Error('400 INVALID_CHAT_HISTORY: messages must alternate roles');
      }
      return 'Final Answer: история починена';
    };

    const result = await runAgent({
      userId: USER_A,
      text: 'новая реплика',
      tools: [],
      store,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
    });

    expect(requests).toHaveLength(2);
    expect(store.clearCalls).toBe(1);
    expect(requests[1]?.messages.map((message) => message.content)).not.toContain('старая реплика');
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('история починена');
    expect(store.threads.get(USER_A)?.map((message) => message.content)).toEqual([
      'новая реплика',
      'Final Answer: история починена',
    ]);
  });

  it('лечит историю только один раз за прогон', async () => {
    const store = new MemoryStore();
    await store.save(USER_A, [{ role: 'user', content: 'старое' }]);

    let calls = 0;
    const chat: AgentChatFn = async () => {
      calls += 1;
      throw new Error('INVALID_CHAT_HISTORY');
    };

    const result = await runAgent({
      userId: USER_A,
      text: 'ещё раз',
      tools: [],
      store,
      chatFn: chat,
      profile: PROFILE,
      now: NOW,
    });

    expect(calls).toBe(2);
    expect(store.clearCalls).toBe(1);
    expect(result.stopReason).toBe('llm_error');
  });
});

// ---------------------------------------------------------------------------
// Персонализация
// ---------------------------------------------------------------------------

describe('runAgent: персонализация из профиля', () => {
  it('вкладывает директивы, имя и стиль в системный промпт', async () => {
    const chat = scriptedChat(['Final Answer: ок']);

    await runAgent({
      userId: USER_A,
      text: 'привет',
      mode: 'thought_partner',
      tools: [],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    const prompt = chat.requests[0]?.systemPrompt ?? '';
    expect(prompt).toContain('Иван');
    expect(prompt).toContain('Отвечай коротко и по делу.');
    expect(prompt).toContain('ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ');
    expect(prompt).toContain('Мудрый, поддерживающий наставник');
    expect(prompt).toContain('АКТИВНЫЙ РЕЖИМ');
    expect(prompt).toContain('Europe/Belgrade');
    expect(prompt).toContain(`Максимум шагов в этом диалоге: ${DEFAULT_MAX_STEPS}`);
    expect(prompt).toContain('2026-11-06');
  });

  it('без профиля не выдумывает персональные данные', async () => {
    const chat = scriptedChat(['Final Answer: ок']);

    await runAgent({
      userId: USER_A,
      text: 'привет',
      tools: [],
      store: null,
      chatFn: chat.fn,
      profile: { userName: null, customInstructions: null, personaStyle: null },
      now: NOW,
    });

    const prompt = chat.requests[0]?.systemPrompt ?? '';
    expect(prompt).not.toContain('ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ');
    expect(prompt).not.toContain('Обращайся к пользователю по имени');
  });

  it('каталог инструментов попадает в промпт', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat(['Final Answer: ок']);

    await runAgent({
      userId: USER_A,
      text: 'привет',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    const prompt = chat.requests[0]?.systemPrompt ?? '';
    expect(prompt).toContain('- echo: Возвращает переданный текст как есть');
    expect(prompt).toContain('Аргументы: {"type":"object"');
  });
});

// ---------------------------------------------------------------------------
// Режимы
// ---------------------------------------------------------------------------

describe('runAgent: режимы', () => {
  it("'auto' разворачивается в режим по тексту запроса", async () => {
    const chat = scriptedChat(['Final Answer: ок']);

    const result = await runAgent({
      userId: USER_A,
      text: 'Что мне сделать сегодня, чтобы не утонуть в делах, и как расставить приоритеты между задачами и деньгами?',
      tools: [],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.mode).toBe('thought_partner');
  });

  it('явный режим переопределяет эвристику', async () => {
    const chat = scriptedChat(['Final Answer: ок']);

    const result = await runAgent({
      userId: USER_A,
      text: 'коротко',
      mode: 'system_expert',
      tools: [],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.mode).toBe('system_expert');
    expect(chat.requests[0]?.systemPrompt).toContain('АКТИВНЫЙ РЕЖИМ');
  });
});

// ---------------------------------------------------------------------------
// Хранилище и изоляция
// ---------------------------------------------------------------------------

describe('runAgent: хранилище и изоляция', () => {
  it('thread = null — работа без персистентности', async () => {
    const chat = scriptedChat(['Final Answer: без истории']);

    const result = await runAgent({
      userId: USER_A,
      text: 'привет',
      tools: [],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.reply).toBe('без истории');
    expect(result.thread.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('истории разных пользователей не смешиваются', async () => {
    const store = new MemoryStore();
    const chatA = scriptedChat(['Final Answer: ответ для A']);
    const chatB = scriptedChat(['Final Answer: ответ для B']);

    await runAgent({
      userId: USER_A,
      text: 'реплика A',
      tools: [],
      store,
      chatFn: chatA.fn,
      profile: PROFILE,
      now: NOW,
    });
    await runAgent({
      userId: USER_B,
      text: 'реплика B',
      tools: [],
      store,
      chatFn: chatB.fn,
      profile: PROFILE,
      now: NOW,
    });

    const threadA = store.threads.get(USER_A) ?? [];
    const threadB = store.threads.get(USER_B) ?? [];
    expect(threadA.map((message) => message.content)).toEqual(['реплика A', 'Final Answer: ответ для A']);
    expect(threadB.map((message) => message.content)).toEqual(['реплика B', 'Final Answer: ответ для B']);
    // Второй пользователь не видел первого в своей истории.
    expect(chatB.requests[0]?.messages.map((message) => message.content)).toEqual(['реплика B']);
  });

  it('прогоны одного пользователя сериализуются', async () => {
    let active = 0;
    let maxActive = 0;
    const chat: AgentChatFn = async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return `Final Answer: ${request.messages[request.messages.length - 1]?.content ?? ''}`;
    };
    const store = new MemoryStore();

    const [first, second] = await Promise.all([
      runAgent({
        userId: USER_A,
        text: 'первая',
        tools: [],
        store,
        chatFn: chat,
        profile: PROFILE,
        now: NOW,
      }),
      runAgent({
        userId: USER_A,
        text: 'вторая',
        tools: [],
        store,
        chatFn: chat,
        profile: PROFILE,
        now: NOW,
      }),
    ]);

    expect(maxActive).toBe(1);
    expect(first.reply).toBe('первая');
    expect(second.reply).toBe('вторая');
    // Второй прогон увидел тред первого и дописался в конец.
    expect(store.threads.get(USER_A)?.map((message) => message.content)).toEqual([
      'первая',
      'Final Answer: первая',
      'вторая',
      'Final Answer: вторая',
    ]);
    expect(pendingAgentRuns()).toBe(0);
  });

  it('невалидный userId — ошибка программиста, а не пользователя', async () => {
    const chat = scriptedChat(['Final Answer: ок']);
    await expect(
      runAgent({ userId: 0, text: 'привет', tools: [], store: null, chatFn: chat.fn }),
    ).rejects.toThrow(/invalid user_id/);
    expect(chat.calls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Нативный function calling
// ---------------------------------------------------------------------------

describe('runAgent: нативный function calling', () => {
  it('выполняет tool call модели и отдаёт финал по наблюдению', async () => {
    const { tools, calls } = makeTools();
    const store = new MemoryStore();
    const signature = { google: { thought_signature: 'sig-engine-1' } };
    const chat = nativeChat([
      {
        content: 'сейчас позову инструмент',
        toolCalls: [
          { id: 'n1', name: 'echo', args: { text: 'привет' }, extraContent: signature },
        ],
      },
      { content: 'Готово: привет', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'скажи привет',
      mode: 'action',
      tools,
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Готово: привет');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      index: 0,
      action: { name: 'echo', args: { text: 'привет' } },
      observation: 'эхо: привет',
      ok: true,
    });
    expect(result.steps[0]?.thought).toContain('инструмент');
    expect(calls).toHaveLength(1);

    // Инструменты уходят модели как нативные описания, а не строкой в промпте.
    expect(chat.requests[0]?.tools?.map((spec) => spec.name)).toEqual(['echo', 'broken', 'silent']);

    // Второй запрос несёт нативный обмен: tool_calls ассистента и его результат.
    const messages = chat.requests[1]?.messages as ProviderChatMessage[] | undefined;
    expect(messages?.find((message) => message.toolCalls?.length)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'n1', name: 'echo', args: { text: 'привет' }, extraContent: signature }],
    });
    // Gemini требует вернуть подпись мышления вместе с вызовом, иначе 400
    // «Function call is missing a thoughtsignature in functionCall parts».
    expect(messages?.find((message) => message.toolCalls?.length)?.toolCalls?.[0]?.extraContent).toEqual(
      signature,
    );
    expect(messages?.at(-1)).toEqual({
      role: 'user',
      content: '',
      toolResults: [{ toolCallId: 'n1', content: 'эхо: привет' }],
    });

    // Тред хранит вызов и наблюдение в одних и тех же метаданных.
    const thread = store.threads.get(USER_A) ?? [];
    expect(thread[1]?.meta?.toolCalls).toEqual([
      { id: 'n1', name: 'echo', args: { text: 'привет' }, extraContent: signature },
    ]);
    expect(thread[2]?.meta?.toolResult).toEqual({ id: 'n1', name: 'echo', ok: true });
  });

  it('неизвестный нативный инструмент уходит модели наблюдением с ошибкой', async () => {
    const { tools } = makeTools();
    const chat = nativeChat([
      { content: '', toolCalls: [{ id: 'n1', name: 'do_magic', args: {} }] },
      { content: 'Такого действия нет.', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'сделай магию',
      mode: 'action',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Такого действия нет.');
    expect(result.steps[0]?.ok).toBe(false);
    expect(result.steps[0]?.observation).toContain('do_magic');
  });

  it('нативные вызовы упираются в тот же предел ходов и попытку синтеза без тулз', async () => {
    const { tools, calls } = makeTools();
    const chat = nativeChat([
      { content: '', toolCalls: [{ id: 'n1', name: 'echo', args: { text: 'раз' } }] },
      { content: '', toolCalls: [{ id: 'n2', name: 'echo', args: { text: 'два' } }] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'повторяй',
      mode: 'action',
      maxSteps: 1,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('step_limit');
    expect(result.steps).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(chat.requests).toHaveLength(2);
    expect(chat.requests[1]?.tools).toBeUndefined();
  });

  it('параллельно запускает смежные read-only тулзы и сохраняет порядок декларации в steps и треде', async () => {
    expect(READ_ONLY_TOOL_NAMES.size).toBe(17);

    const events: string[] = [];
    let releaseListTasks!: () => void;
    let releaseBalances!: () => void;
    const listTasksGate = new Promise<void>((resolve) => {
      releaseListTasks = resolve;
    });
    const balancesGate = new Promise<void>((resolve) => {
      releaseBalances = resolve;
    });
    let bothStartedResolve!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      bothStartedResolve = resolve;
    });

    const tools: Tool[] = [
      {
        name: 'list_tasks',
        effect: { kind: 'read' },
        description: 'Список задач',
        run: async () => {
          events.push('start:list_tasks');
          if (events.includes('start:get_fin_balances')) bothStartedResolve();
          await listTasksGate;
          events.push('end:list_tasks');
          return { ok: true, content: 'Задачи: 2', data: { count: 2 } };
        },
      },
      {
        name: 'get_fin_balances',
        effect: { kind: 'read' },
        description: 'Балансы счетов',
        run: async () => {
          events.push('start:get_fin_balances');
          if (events.includes('start:list_tasks')) bothStartedResolve();
          await balancesGate;
          events.push('end:get_fin_balances');
          return { ok: true, content: 'Баланс: 100 EUR', data: { total: 100 } };
        },
      },
    ];

    const store = new MemoryStore();
    const chat = nativeChat([
      {
        content: 'собираю сводку',
        toolCalls: [
          { id: 'c1', name: 'list_tasks', args: { status: 'open' } },
          { id: 'c2', name: 'get_fin_balances', args: {} },
        ],
      },
      { content: 'Сводка готова.', toolCalls: [] },
    ]);

    const runPromise = runAgent({
      userId: USER_A,
      text: 'что по задачам и деньгам?',
      mode: 'action',
      tools,
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    // Ждём, пока обе read-only тулзы стартанут до завершения любой из них.
    await bothStarted;
    expect(events).toEqual(['start:list_tasks', 'start:get_fin_balances']);

    // Завершаем вторую тулзу раньше первой — порядок в steps и working обязан остаться как в вызове.
    releaseBalances();
    await Promise.resolve();
    releaseListTasks();

    const result = await runPromise;

    expect(events).toEqual([
      'start:list_tasks',
      'start:get_fin_balances',
      'end:get_fin_balances',
      'end:list_tasks',
    ]);
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Сводка готова.');
    expect(result.steps.map((s) => ({ index: s.index, name: s.action?.name, obs: s.observation, data: s.data }))).toEqual([
      { index: 0, name: 'list_tasks', obs: 'Задачи: 2', data: { count: 2 } },
      { index: 1, name: 'get_fin_balances', obs: 'Баланс: 100 EUR', data: { total: 100 } },
      { index: 2, name: undefined, obs: null, data: undefined },
    ]);

    const thread = store.threads.get(USER_A) ?? [];
    expect(thread[2]?.meta?.toolResult).toEqual({ id: 'c1', name: 'list_tasks', ok: true });
    expect(thread[2]?.content).toBe('Задачи: 2');
    expect(thread[3]?.meta?.toolResult).toEqual({ id: 'c2', name: 'get_fin_balances', ok: true });
    expect(thread[3]?.content).toBe('Баланс: 100 EUR');
  });

  it('смешанный батч: read-only выполняются до write/confirm, confirm останавливает хвост', async () => {
    const events: string[] = [];
    const tools: Tool[] = [
      {
        name: 'list_tasks',
        effect: { kind: 'read' },
        description: 'Список задач',
        run: async () => {
          events.push('list_tasks');
          return 'Задачи: A';
        },
      },
      {
        name: 'add_task',
        effect: { kind: 'read' },
        description: 'Добавить задачу',
        run: async (args) => {
          events.push(`add_task:${String(args.title ?? '')}`);
          return 'Задача добавлена';
        },
      },
      {
        name: 'search_notes',
        effect: { kind: 'read' },
        description: 'Поиск заметок',
        run: async () => {
          events.push('search_notes');
          return 'Заметок нет';
        },
      },
      {
        name: 'delete_task',
        effect: { kind: 'destroy' },
        description: 'Удалить задачу',
        run: async () => {
          events.push('delete_task');
          return 'Удалено';
        },
      },
      {
        name: 'get_fin_balances',
        effect: { kind: 'read' },
        description: 'Балансы',
        run: async () => {
          events.push('get_fin_balances');
          return '100 EUR';
        },
      },
    ];

    const chat = nativeChat([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'list_tasks', args: {} },
          { id: 'c2', name: 'add_task', args: { title: 'купить кофе' } },
          { id: 'c3', name: 'search_notes', args: {} },
          { id: 'c4', name: 'delete_task', args: { task_id: 1 } },
          { id: 'c5', name: 'get_fin_balances', args: {} },
        ],
      },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'сделай всё сразу',
      mode: 'action',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('confirm');
    expect(result.reply).toContain('Подтвердите действие: delete_task');
    // `get_fin_balances` после `delete_task` не должен выполняться.
    expect(events).toEqual(['list_tasks', 'add_task:купить кофе', 'search_notes']);
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map((s) => ({ index: s.index, name: s.action?.name, ok: s.ok }))).toEqual([
      { index: 0, name: 'list_tasks', ok: true },
      { index: 1, name: 'add_task', ok: true },
      { index: 2, name: 'search_notes', ok: true },
      { index: 3, name: 'delete_task', ok: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Гардрейл деструктивных действий
// ---------------------------------------------------------------------------

describe('runAgent: подтверждение деструктивных действий', () => {
  /** Деструктивный инструмент: движок обязан спросить до выполнения. */
  function destructiveTool(): { tool: Tool; calls: () => number } {
    let count = 0;
    return {
      tool: {
        name: 'delete_task',
        effect: { kind: 'destroy' },
        description: 'Удаляет задачу без возможности восстановления',
        schema: { type: 'object', properties: { task_id: { type: 'integer' } } },
        run: () => {
          count += 1;
          return 'Задача удалена.';
        },
      },
      calls: () => count,
    };
  }

  it('без confirm не выполняет действие, а спрашивает пользователя', async () => {
    const { tool, calls } = destructiveTool();
    const chat = scriptedChat([
      'Thought: удалю.\nAction: delete_task\nAction Input: {"task_id": 7}',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'удали задачу 7',
      mode: 'action',
      tools: [tool],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('confirm');
    expect(result.reply).toContain('Подтвердите действие: delete_task');
    expect(result.reply).toContain('ничего не изменено');
    expect(calls()).toBe(0);
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[0]?.observation).toContain('Требуется подтверждение');
  });

  it('с confirm: true выполняет действие как раньше', async () => {
    const { tool, calls } = destructiveTool();
    const chat = scriptedChat([
      'Action: delete_task\nAction Input: {"task_id": 7, "confirm": true}',
      'Final Answer: Удалено.',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'да, удали задачу 7',
      mode: 'action',
      tools: [tool],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(calls()).toBe(1);
    expect(result.steps[0]?.ok).toBe(true);
  });

  it('confirm: false тоже не выполняет действие', async () => {
    const { tool, calls } = destructiveTool();
    const chat = scriptedChat([
      'Action: delete_task\nAction Input: {"task_id": 7, "confirm": false}',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'удали задачу 7',
      mode: 'action',
      tools: [tool],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('confirm');
    expect(calls()).toBe(0);
  });

  it('нативный tool call тоже упирается в подтверждение', async () => {
    const { tool, calls } = destructiveTool();
    const replies: AgentChatResult[] = [
      { content: '', toolCalls: [{ id: 'n1', name: 'delete_task', args: { task_id: 7 } }] },
    ];
    const chatFn: AgentChatFn = async () => replies.shift() ?? { content: '', toolCalls: [] };

    const result = await runAgent({
      userId: USER_A,
      text: 'удали задачу 7',
      mode: 'action',
      tools: [tool],
      store: null,
      chatFn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('confirm');
    expect(calls()).toBe(0);

    // Схема деструктивного инструмента объявляет поле подтверждения модели.
    const request = await new Promise<AgentChatRequest | null>((resolve) => {
      const collector: AgentChatFn = (req) => {
        resolve(req);
        return Promise.resolve({ content: '', toolCalls: [] });
      };
      void runAgent({
        userId: USER_A,
        text: 'удали задачу 7',
        mode: 'action',
        tools: [tool],
        store: null,
        chatFn: collector,
        profile: PROFILE,
        now: NOW,
      });
    });
    const spec = request?.tools?.find((item) => item.name === 'delete_task');
    expect(spec?.parameters).toMatchObject({
      properties: { confirm: { type: 'boolean' } },
    });
  });

  it('безопасный инструмент не изменился', async () => {
    const { tools, calls } = makeTools();
    const chat = scriptedChat([
      'Action: echo\nAction Input: {"text": "привет"}',
      'Final Answer: Готово.',
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'скажи привет',
      mode: 'action',
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Лимит шагов
// ---------------------------------------------------------------------------

describe('runAgent: предел шагов и баланс бюджета', () => {
  it('maxSteps выше потолка зажимается до MAX_STEPS_CAP', async () => {
    const { tools } = makeTools();
    const chat = scriptedChat(
      Array.from({ length: MAX_STEPS_CAP + 5 }, (_, i) => `Action: echo\nAction Input: {"text": "шаг ${i}"}`),
    );

    const result = await runAgent({
      userId: USER_A,
      text: 'зациклись',
      mode: 'action',
      maxSteps: 1000,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('step_limit');
    expect(result.steps).toHaveLength(MAX_STEPS_CAP);
    // MAX_STEPS_CAP рабочих ходов + 1 попытка синтеза без тулз (которая вернула Action).
    expect(chat.calls()).toBe(MAX_STEPS_CAP + 1);
    expect(result.reply).toContain('лимите шагов');
  });

  it('батч параллельных read-only тулз тратит ровно 1 ход LLM, а не N шагов', async () => {
    const tools: Tool[] = [
      { name: 'list_tasks', effect: { kind: 'read' }, description: 'Задачи', run: () => 'Задачи: 3' },
      { name: 'get_fin_balances', effect: { kind: 'read' }, description: 'Балансы', run: () => 'Баланс: 100 EUR' },
      { name: 'get_liabilities', effect: { kind: 'read' }, description: 'Долги', run: () => 'Не хватает 93 EUR' },
      { name: 'get_runway_forecast', effect: { kind: 'read' }, description: 'Runway', run: () => '12 дней' },
    ];
    const chat = nativeChat([
      {
        content: '',
        toolCalls: [
          { id: 't1', name: 'list_tasks', args: {} },
          { id: 't2', name: 'get_fin_balances', args: {} },
          { id: 't3', name: 'get_liabilities', args: {} },
          { id: 't4', name: 'get_runway_forecast', args: {} },
        ],
      },
      {
        content: '',
        toolCalls: [
          { id: 't5', name: 'list_tasks', args: { status: 'done' } },
          { id: 't6', name: 'get_fin_balances', args: { includeZero: true } },
          { id: 't7', name: 'get_liabilities', args: { activeOnly: false } },
          { id: 't8', name: 'get_runway_forecast', args: { days: 30 } },
        ],
      },
      { content: 'Собрал все 8 проверок за 2 хода и готов обсудить дефицит 93 EUR.', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'Давай обсудим нехватку 93 EUR',
      maxSteps: 3,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Собрал все 8 проверок за 2 хода и готов обсудить дефицит 93 EUR.');
    expect(result.steps).toHaveLength(9);
    expect(chat.requests).toHaveLength(3);
  });

  it('при исчерпании maxSteps выполняет финальный ход синтеза без тулз и отдаёт цельный ответ', async () => {
    const tools: Tool[] = [
      { name: 'get_fin_balances', effect: { kind: 'read' }, description: 'Балансы', run: () => 'Наличные: 0 EUR, CryptoX: 0 USD' },
      { name: 'get_liabilities', effect: { kind: 'read' }, description: 'Долги', run: () => 'GeForce NOW 19.99 USD 20-го числа' },
    ];
    const chat = nativeChat([
      { content: '', toolCalls: [{ id: 'c1', name: 'get_fin_balances', args: {} }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'get_liabilities', args: {} }] },
      { content: 'По текущим балансам не хватает ~93 € — можем отложить GeForce NOW.', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'Давай обсудим',
      maxSteps: 2,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('По текущим балансам не хватает ~93 € — можем отложить GeForce NOW.');
    expect(result.reply).not.toContain('лимите шагов');
    expect(chat.requests).toHaveLength(3);
    const synthRequest = chat.requests[2]!;
    expect(synthRequest.tools).toBeUndefined();
    expect(synthRequest.systemPrompt).toContain('[ФИНАЛЬНЫЙ ХОД — СИНТЕЗ БЕЗ ИНСТРУМЕНТОВ]');
    const messageContents = synthRequest.messages.map((m) => String(m.content));
    expect(messageContents.some((c: string) => c.includes('Observation: Наличные: 0 EUR'))).toBe(true);
    expect(messageContents.some((c: string) => c.includes('Observation: GeForce NOW 19.99 USD'))).toBe(true);
  });

  it('потолок MAX_TOOL_CALLS_PER_RUN ограничивает суммарное число вызовов и переходит к синтезу', async () => {
    let executed = 0;
    const tools: Tool[] = [
      {
        name: 'list_tasks',
        effect: { kind: 'read' },
        description: 'Задачи',
        run: () => {
          executed += 1;
          return `шаг ${executed}`;
        },
      },
    ];
    const hugeBatch = Array.from({ length: MAX_TOOL_CALLS_PER_RUN + 10 }, (_, idx) => ({
      id: `b${idx}`,
      name: 'list_tasks',
      args: { page: idx },
    }));
    const chat = nativeChat([
      { content: '', toolCalls: hugeBatch },
      { content: 'Готовый синтез после лимита вызовов.', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'собери всё',
      maxSteps: 8,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(executed).toBe(MAX_TOOL_CALLS_PER_RUN);
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Готовый синтез после лимита вызовов.');
    expect(result.steps).toHaveLength(MAX_TOOL_CALLS_PER_RUN + 1);
  });

  it('loop guard прерывает 3 одинаковых вызова подряд раньше maxSteps и запускает синтез', async () => {
    const { tools, calls } = makeTools();
    const chat = nativeChat([
      { content: '', toolCalls: [{ id: 'a1', name: 'echo', args: { text: 'одно и то же', n: 1 } }] },
      { content: '', toolCalls: [{ id: 'a2', name: 'echo', args: { n: 1, text: 'одно и то же' } }] },
      { content: '', toolCalls: [{ id: 'a3', name: 'echo', args: { text: 'одно и то же', n: 1 } }] },
      { content: 'Прервал повтор и подвёл итог.', toolCalls: [] },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'проверь повтор',
      maxSteps: 8,
      tools,
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(calls).toHaveLength(MAX_CONSECUTIVE_DUPLICATE_TURNS - 1);
    expect(chat.requests).toHaveLength(MAX_CONSECUTIVE_DUPLICATE_TURNS + 1);
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Прервал повтор и подвёл итог.');
  });
});

// ---------------------------------------------------------------------------
// Добор обрезанного ответа по finishReason === 'length' | 'max_tokens'
// ---------------------------------------------------------------------------

describe('joinContinuation и добор обрыва по finishReason', () => {
  it('joinContinuation склеивает кавычки, середину слова, пунктуацию и границу слов без лишних пробелов', () => {
    expect(joinContinuation('... объединить «Продукты» с «', 'Супермаркетом»)?')).toBe(
      '... объединить «Продукты» с «Супермаркетом»)?',
    );
    expect(joinContinuation('супер', 'маркетом')).toBe('супермаркетом');
    expect(joinContinuation('Всё готово', ', можем начинать.')).toBe('Всё готово, можем начинать.');
    expect(joinContinuation('Первое предложение.', 'Второе предложение.')).toBe(
      'Первое предложение. Второе предложение.',
    );
  });

  it('при finishReason === length делает 1 запрос продолжения без тулз и склеивает ответ', async () => {
    const store = new MemoryStore();
    const chat = nativeChat([
      {
        content: 'Хочешь, чтобы я помог привести это к одному виду (например, объединить «Продукты» с «',
        toolCalls: [],
        finishReason: 'length',
      },
      {
        content: 'Супермаркетом»)?',
        toolCalls: [],
        finishReason: 'stop',
      },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'посчитай категории трат',
      tools: [],
      store,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe(
      'Хочешь, чтобы я помог привести это к одному виду (например, объединить «Продукты» с «Супермаркетом»)?',
    );
    expect(chat.requests).toHaveLength(2);
    expect(chat.requests[1]?.tools).toBeUndefined();
    expect(store.threads.get(USER_A)?.at(-1)?.content).toBe(result.reply);
  });

  it('при сбое запроса продолжения возвращает уже полученную часть без падения', async () => {
    let calls = 0;
    const chatFn: AgentChatFn = async () => {
      calls += 1;
      if (calls === 1) {
        return { content: 'Первая часть ответа...', toolCalls: [], finishReason: 'max_tokens' };
      }
      throw new Error('continuation timeout');
    };

    const result = await runAgent({
      userId: USER_A,
      text: 'расскажи подробно',
      tools: [],
      store: null,
      chatFn,
      profile: PROFILE,
      now: NOW,
    });

    expect(calls).toBe(2);
    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Первая часть ответа...');
  });

  it('при finishReason === stop не делает лишнего запроса продолжения', async () => {
    const chat = nativeChat([
      { content: 'Короткий и законченный ответ.', toolCalls: [], finishReason: 'stop' },
    ]);

    const result = await runAgent({
      userId: USER_A,
      text: 'привет',
      tools: [],
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.reply).toBe('Короткий и законченный ответ.');
    expect(chat.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Разбор ответа модели (юнит-уровень)
// ---------------------------------------------------------------------------

describe('parseAgentReply', () => {
  it('Final Answer важнее Action, если модель показала пример', () => {
    const parsed = parseAgentReply(
      'Thought: вот как надо вызывать\nAction: echo\nAction Input: {"text": "x"}\nFinal Answer: Готово',
    );
    expect(parsed.kind).toBe('final');
    expect(parsed.final).toBe('Готово');
  });

  it('разбирает текстовый Action с вложением и рассуждением', () => {
    const parsed = parseAgentReply('Thought: надо записать\nAction: add_task\nAction Input: {"title": "позвонить"}');
    expect(parsed.kind).toBe('action');
    expect(parsed.action).toEqual({ name: 'add_task', args: { title: 'позвонить' } });
    expect(parsed.thought).toBe('надо записать');
  });

  it('принимает markdown-выделение вокруг имени инструмента', () => {
    const parsed = parseAgentReply('Action: `echo`\nAction Input: {"text": "a"}');
    expect(parsed.action?.name).toBe('echo');
  });

  it('текст без протокола считается финальным ответом', () => {
    const parsed = parseAgentReply('Просто ответ пользователю.');
    expect(parsed).toEqual({ kind: 'final', final: 'Просто ответ пользователю.', thought: null, action: null });
  });

  it('пустой ответ — пустой финал без исключения', () => {
    expect(parseAgentReply('   ')).toEqual({ kind: 'final', final: '', thought: null, action: null });
    expect(parseAgentReply(null)).toEqual({ kind: 'final', final: '', thought: null, action: null });
  });

  it('JSON-объект с final без action', () => {
    const parsed = parseAgentReply('{"final": "Готово", "thought": "всё ясно"}');
    expect(parsed.kind).toBe('final');
    expect(parsed.final).toBe('Готово');
    expect(parsed.thought).toBe('всё ясно');
  });
});

describe('parseActionArgs', () => {
  it('разбирает чистый JSON', () => {
    expect(parseActionArgs('{"a": 1}')).toEqual({ a: 1 });
  });

  it('вытаскивает JSON из текста вокруг', () => {
    expect(parseActionArgs('вот аргументы: {"a": 1} — всё')).toEqual({ a: 1 });
  });

  it('не-JSON уходит в { input }', () => {
    expect(parseActionArgs('позвонить маме')).toEqual({ input: 'позвонить маме' });
  });

  it('пустое значение — пустой объект', () => {
    expect(parseActionArgs('')).toEqual({});
    expect(parseActionArgs(null)).toEqual({});
  });
});

describe('isRecoverableHistoryError', () => {
  it('узнаёт ошибки испорченной истории', () => {
    expect(isRecoverableHistoryError('INVALID_CHAT_HISTORY')).toBe(true);
    expect(isRecoverableHistoryError('invalid chat history: tool calls')).toBe(true);
    expect(isRecoverableHistoryError('400 Bad Request')).toBe(true);
    expect(isRecoverableHistoryError('messages must alternate')).toBe(true);
  });

  it('не считает историей прочие сбои', () => {
    expect(isRecoverableHistoryError('RESOURCE_EXHAUSTED: quota')).toBe(false);
    expect(isRecoverableHistoryError('ETIMEDOUT')).toBe(false);
    expect(isRecoverableHistoryError('')).toBe(false);
  });
});

describe('константы движка', () => {
  it('лимит шагов совпадает с upstream и ограничен сверху', () => {
    expect(DEFAULT_MAX_STEPS).toBe(8);
    expect(MAX_STEPS_CAP).toBe(20);
    expect(MAX_TOOL_CALLS_PER_RUN).toBe(30);
    expect(MAX_CONSECUTIVE_DUPLICATE_TURNS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Интеграция с БД: loadAgentProfile и Executive Overload Shield в runAgent
// ---------------------------------------------------------------------------

describe('loadAgentProfile и runAgent: Executive Overload Shield из SQLite', () => {
  const SHIELD_HEADER = '[РЕЖИМ СБЕРЕЖЕНИЯ ВНИМАНИЯ / EXECUTIVE OVERLOAD SHIELD]';

  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('loadAgentProfile читает low_stimulation_mode, считает top-level задачи, просрочку и пропущенные дозы в user.timezone', async () => {
    await ensureUser(USER_A, 'Алиса');
    await updateUser(USER_A, { timezone: 'Europe/Moscow', lowStimulationMode: true });

    // Top-level todo задачи: 2 просрочены (2026-11-05), 1 на сегодня (2026-11-06).
    const parent = await createTask(USER_A, { title: 'Просрочка 1', dueAt: '2026-11-05' });
    await createTask(USER_A, { title: 'Просрочка 2', dueAt: '2026-11-05' });
    await createTask(USER_A, { title: 'На сегодня', dueAt: '2026-11-06' });
    // Подзадача и выполненная задача не должны попадать в top-level activeTodoCount / overdueTaskCount.
    await createTask(USER_A, { title: 'Подзадача', parentId: parent.id, dueAt: '2026-11-01' });
    await createTask(USER_A, { title: 'Выполненная', status: 'done', dueAt: '2026-11-01' });

    // Два слота на 2026-11-06 по MSK: 09:00 отмечен принятым, 13:00 — pending, 14:15 — ещё в пределах +30 мин в 14:30.
    const med = await createMedication(USER_A, {
      name: 'Витамин D',
      dosage: '1 капс',
      times: ['09:00', '13:00', '14:15'],
    });
    await takeMedication(USER_A, med.id, '09:00', '2026-11-06');

    // 11:30Z = 14:30 MSK: просрочен только слот 13:00 (13:00 + 30 <= 14:30).
    const profile = await loadAgentProfile(USER_A, new Date('2026-11-06T11:30:00Z'));

    expect(profile.userName).toBe('Алиса');
    expect(profile.timezone).toBe('Europe/Moscow');
    expect(profile.lowStimulationMode).toBe(true);
    expect(profile.activeTodoCount).toBe(3);
    expect(profile.overdueTaskCount).toBe(2);
    expect(profile.missedMedsCount).toBe(1);
  });

  it('runAgent с профилем из БД добавляет директиву щита в промпт при срабатывании порога и опускает ниже порога', async () => {
    await ensureUser(USER_A, 'Боб');
    await updateUser(USER_A, { timezone: 'America/New_York', lowStimulationMode: false });

    // Ниже порога: 1 задача на сегодня, 14:30 в America/New_York (19:30Z).
    await createTask(USER_A, { title: 'Спокойная задача', dueAt: '2026-11-06' });
    const med = await createMedication(USER_A, {
      name: 'Магний',
      dosage: '1 шт',
      times: ['21:00'],
    });

    const momentUtc = new Date('2026-11-06T19:30:00Z');
    const chatNormal = scriptedChat(['Final Answer: всё спокойно']);

    await runAgent({
      userId: USER_A,
      text: 'что по плану?',
      tools: [],
      store: null,
      chatFn: chatNormal.fn,
      now: momentUtc,
    });

    const normalPrompt = chatNormal.requests[0]?.systemPrompt ?? '';
    expect(normalPrompt).not.toContain(SHIELD_HEADER);

    // Переключаем таймзону на Europe/Moscow (19:30Z -> 22:30 MSK) и добавляем просрочку (>= 3 задач -> wipOverload + circadianOrTherapyLoad).
    await updateUser(USER_A, { timezone: 'Europe/Moscow', lowStimulationMode: false });
    for (let index = 1; index <= 3; index += 1) {
      await createTask(USER_A, { title: `Просрочено ${index}`, dueAt: '2026-11-05' });
    }

    const chatOverload = scriptedChat(['Final Answer: начнём с 2 минут']);
    await runAgent({
      userId: USER_A,
      text: 'что по плану?',
      tools: [],
      store: null,
      chatFn: chatOverload.fn,
      now: momentUtc,
    });

    const overloadedPrompt = chatOverload.requests[0]?.systemPrompt ?? '';
    expect(overloadedPrompt).toContain(SHIELD_HEADER);
    expect(overloadedPrompt).toContain('высокий объём дел (активных: 4, просроченных: 3)');
    expect(overloadedPrompt).toContain('позднее/ночное время (22:00), неотмеченные приёмы лекарств (1)');

    // При ручном low_stimulation_mode = 1 щит включается даже днём при нулевом пропуске лекарств.
    await takeMedication(USER_A, med.id, '21:00', '2026-11-06');
    await updateUser(USER_A, { timezone: 'America/New_York', lowStimulationMode: true });
    const chatManualCalm = scriptedChat(['Final Answer: тихий режим']);
    await runAgent({
      userId: USER_A,
      text: 'привет',
      tools: [],
      store: null,
      chatFn: chatManualCalm.fn,
      now: new Date('2026-11-06T15:00:00Z'),
    });

    const manualPrompt = chatManualCalm.requests[0]?.systemPrompt ?? '';
    expect(manualPrompt).toContain(SHIELD_HEADER);
    expect(manualPrompt).toContain('ручной спокойный режим (low-stimulation)');
  });
});

// ---------------------------------------------------------------------------
// Подтверждение через реальный реестр (PLAN-AGENT-WRITE-GUARD T3)
// ---------------------------------------------------------------------------

/**
 * Тесты выше подают инструмент в `options.tools`, то есть минуют реестр. Именно
 * поэтому дефект `defineTool` (флаг терялся при регистрации) дожил до прода:
 * гейт подтверждения был мёртв для всех 56 тулз. Здесь прогон идёт без
 * `options.tools` — движок сам берёт `listTools()`, как в бою.
 */
describe('runAgent: подтверждение через реальный реестр', () => {
  function countRows(table: string): number {
    const row = getSqlite().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return row.n;
  }

  async function seedLiability(): Promise<void> {
    await createLiability(USER_A, {
      name: 'ТЕСТ-ГЕЙТ',
      currency: 'EUR',
      amountCents: 100_00,
    });
  }

  beforeEach(async () => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    await ensureUser(USER_A);
  });

  it('delete_liability без confirm не выполняется и просит подтверждение', async () => {
    await seedLiability();
    expect(countRows('liabilities')).toBe(1);

    const chat = scriptedChat([
      'Action: delete_liability\nAction Input: {"liability_name": "ТЕСТ-ГЕЙТ"}',
    ]);
    const result = await runAgent({
      userId: USER_A,
      text: 'удали обязательство ТЕСТ-ГЕЙТ',
      mode: 'action',
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('confirm');
    expect(result.reply).toContain('Подтвердите действие: delete_liability');
    expect(countRows('liabilities')).toBe(1);
  });

  it('с confirm: true действие выполняется', async () => {
    await seedLiability();

    const chat = scriptedChat([
      'Action: delete_liability\nAction Input: {"liability_name": "ТЕСТ-ГЕЙТ", "confirm": true}',
      'Final Answer: Удалил.',
    ]);
    const result = await runAgent({
      userId: USER_A,
      text: 'да, удали обязательство ТЕСТ-ГЕЙТ',
      mode: 'action',
      store: null,
      chatFn: chat.fn,
      profile: PROFILE,
      now: NOW,
    });

    expect(result.stopReason).toBe('final');
    expect(result.steps[0]).toMatchObject({ ok: true });
    expect(countRows('liabilities')).toBe(0);
  });

  it('все пять тулз с подтверждением уходят модели с полем confirm в схеме', async () => {
    const requests: AgentChatRequest[] = [];
    const chatFn: AgentChatFn = async (request) => {
      requests.push(request);
      return 'Final Answer: ок';
    };

    await runAgent({
      userId: USER_A,
      text: 'что у меня есть',
      store: null,
      chatFn,
      profile: PROFILE,
      now: NOW,
    });

    const specs = requests[0]?.tools ?? [];
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    const gated = [
      'clear_trash',
      'delete_account',
      'delete_liability',
      'delete_medication',
      'reset_finance_history',
    ];
    for (const name of gated) {
      const spec = byName.get(name);
      expect({ name, present: spec !== undefined }).toEqual({ name, present: true });
      const properties = (spec?.parameters as { properties?: Record<string, unknown> }).properties;
      expect({ name, confirm: Boolean(properties?.confirm) }).toEqual({ name, confirm: true });
    }

    // Бизнес-правило тулзы не подменяется общим описанием гейта.
    const balance = byName.get('set_account_balance');
    const balanceProps = (balance?.parameters as { properties?: Record<string, unknown> }).properties;
    const confirm = balanceProps?.confirm as { description?: string } | undefined;
    expect(confirm?.description).toContain('баланс');
    expect(Boolean(balanceProps?.confirm)).toBe(true);

    // Удаления в корзину подтверждения не требуют — поля в схеме нет.
    const trashNote = byName.get('delete_note');
    const noteProps = (trashNote?.parameters as { properties?: Record<string, unknown> }).properties;
    expect(noteProps?.confirm).toBeUndefined();
  });
});
