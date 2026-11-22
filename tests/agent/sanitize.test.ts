/**
 * Санитизация треда (`src/lib/agent/sanitize.ts`).
 *
 * Что проверяем (SPEC §3 T11):
 *  1) мусор выкидывается: неизвестная роль, нестроковый `content`, битые
 *     метаданные вызова;
 *  2) наблюдение без объявленного вызова не уходит модели (upstream-грабли
 *     `INVALID_CHAT_HISTORY`), а объявленный вызов без наблюдения получает
 *     синтезированный результат;
 *  3) чистка идемпотентна — повторный прогон не меняет историю;
 *  4) окно истории начинается с реплики пользователя, а не с наблюдения;
 *     длинные наблюдения обрезаются до лимита;
 *  5) `toChatMessages` выбрасывает системные сообщения и размечает наблюдения
 *     префиксом `Observation: `.
 */

import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../src/types';
import {
  OBSERVATION_PREFIX,
  SYNTHESIZED_OBSERVATION,
  approximateTokens,
  isObservation,
  sanitizeThread,
  toChatMessages,
  toolCallsOf,
  toolCallsMeta,
  observationMeta,
  toolResultOf,
  trimThread,
  toProviderMessages,
  type ThreadToolCall,
} from '../../src/lib/agent/sanitize';

const call = (id: string, name = 'add_task'): ThreadToolCall => ({ id, name, args: { title: 'x' } });

/** Шаг ассистента с объявленным вызовом. */
function assistantWithCall(id: string, content = 'Thought: запишу задачу\nAction: add_task'): AgentMessage {
  return { role: 'assistant', content, meta: toolCallsMeta([call(id)]) };
}

/** Наблюдение инструмента. */
function observation(id: string, content = 'Задача создана.', ok = true): AgentMessage {
  return { role: 'user', content, meta: observationMeta({ id, name: 'add_task', ok }) };
}

describe('разбор метаданных', () => {
  it('понимает вызовы и наблюдения, мусор отбрасывает', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: 'Thought: …',
      meta: { toolCalls: [call('c1'), { id: '', name: 'bad' }, 'junk'] },
    };

    expect(toolCallsOf(message)).toEqual([call('c1')]);
    expect(toolCallsOf({ role: 'user', content: 'привет' })).toEqual([]);
    expect(toolResultOf(observation('c1'))).toEqual({ id: 'c1', name: 'add_task', ok: true });
    expect(toolResultOf({ role: 'user', content: 'привет' })).toBeNull();
    expect(isObservation(observation('c1'))).toBe(true);
    expect(isObservation({ role: 'user', content: 'привет' })).toBe(false);
  });

  it('переносит непрозрачный extraContent вызова туда и обратно', () => {
    const signature = { google: { thought_signature: 'sig-1' } };
    const signed: ThreadToolCall = { ...call('c1'), extraContent: signature };

    const meta = toolCallsMeta([signed]);
    expect(meta).toEqual({ toolCalls: [signed] });
    expect(toolCallsOf({ role: 'assistant', content: 'Thought: …', meta })).toEqual([signed]);
    // Без подписи поле не появляется вовсе — старые треды читаются как раньше.
    expect(toolCallsMeta([call('c1')])).toEqual({ toolCalls: [call('c1')] });
  });
});

describe('sanitizeThread: пары вызов ↔ наблюдение', () => {
  it('выбрасывает наблюдение без объявленного вызова', () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Поставь задачу' },
      observation('c1', 'Задача создана.'),
    ];

    const result = sanitizeThread(thread);

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('Поставь задачу');
  });

  it('выбрасывает наблюдение, чей вызов был в другом (уже отрезанном) шаге', () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Задача' },
      assistantWithCall('c1'),
      observation('c1', 'Первая задача создана.'),
      { role: 'assistant', content: 'Final Answer: Готово.' },
      observation('c1', 'Чужое наблюдение.'),
    ];

    const result = sanitizeThread(thread, { trim: false });

    expect(result.map((message) => message.content)).toEqual([
      'Задача',
      'Thought: запишу задачу\nAction: add_task',
      'Первая задача создана.',
      'Final Answer: Готово.',
    ]);
  });

  it('синтезирует отсутствующее наблюдение (как upstream)', () => {
    const result = sanitizeThread([{ role: 'user', content: 'Задача' }, assistantWithCall('c1')], {
      trim: false,
    });

    expect(result).toHaveLength(3);
    expect(result[2]!.content).toBe(SYNTHESIZED_OBSERVATION);
    expect(toolResultOf(result[2]!)).toEqual({ id: 'c1', name: 'add_task', ok: true });
  });

  it('схлопывает дубли наблюдений по одному вызову', () => {
    const result = sanitizeThread(
      [{ role: 'user', content: 'Задача' }, assistantWithCall('c1'), observation('c1'), observation('c1')],
      { trim: false },
    );

    expect(result.filter((message) => isObservation(message))).toHaveLength(1);
  });

  it('выкидывает мусор: неизвестные роли и нестроковый content', () => {
    const thread = [
      { role: 'user', content: 'привет' },
      { role: 'wizard', content: 'магия' },
      { role: 'assistant', content: 42 },
      null,
      'строка',
    ] as unknown as AgentMessage[];

    expect(sanitizeThread(thread, { trim: false })).toEqual([{ role: 'user', content: 'привет' }]);
  });

  it('идемпотентна', () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Задача' },
      assistantWithCall('c1'),
      observation('c2', 'Сирота'),
      observation('c1', 'Задача создана.'),
    ];

    const once = sanitizeThread(thread);
    const twice = sanitizeThread(once);

    expect(twice).toEqual(once);
  });
});

describe('trimThread: бюджет истории', () => {
  it('оставляет хвост и начинает окно с реплики пользователя', () => {
    const long = 'а'.repeat(4000);
    const thread: AgentMessage[] = [
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: long },
    ];

    const result = trimThread(thread, { maxTokens: 2500 });

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe(long);
  });

  it('обрезает слишком длинное наблюдение до лимита', () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Дай выгрузку' },
      assistantWithCall('c1'),
      observation('c1', 'о'.repeat(5000)),
    ];

    const result = trimThread(thread, { maxObservationChars: 100 });
    const observationMessage = result.find((message) => isObservation(message))!;

    expect(observationMessage.content.length).toBeLessThanOrEqual(100);
    expect(observationMessage.content.endsWith('…')).toBe(true);
    // Метаданные наблюдения не теряются: без них история снова станет «битой».
    expect(toolResultOf(observationMessage)).toEqual({ id: 'c1', name: 'add_task', ok: true });
  });

  it('уважает жёсткий предел числа сообщений', () => {
    const thread: AgentMessage[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `сообщение ${index}`,
    }));

    expect(trimThread(thread, { maxMessages: 4 })).toHaveLength(4);
  });

  it('не теряет вопрос, даже если бюджет вытеснил его наблюдениями', () => {
    // Живой сбой 22.11.2026: длинный ход «Разбери инбокс» набрал наблюдений
    // больше бюджета, окно осталось без реплики пользователя и начиналось с
    // tool-результата — провайдер ответил 400 «function_response.name».
    const long = 'о'.repeat(4000);
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Разбери инбокс и разложи всё по задачам' },
      assistantWithCall('c1'),
      observation('c1', long),
      assistantWithCall('c2'),
      observation('c2', long),
      assistantWithCall('c3'),
      observation('c3', long),
    ];

    const result = trimThread(thread, { maxTokens: 2500 });

    expect(result[0]!.content).toBe('Разбери инбокс и разложи всё по задачам');
    expect(isObservation(result[0]!)).toBe(false);
  });

  it('не раздувает окно до бесконечности ради вопроса', () => {
    const long = 'о'.repeat(4000);
    const thread: AgentMessage[] = [{ role: 'user', content: 'Разбери инбокс' }];
    for (let index = 0; index < 12; index += 1) {
      thread.push(assistantWithCall(`c${index}`), observation(`c${index}`, long));
    }

    const result = trimThread(thread, { maxTokens: 2500 });
    const tokens = result.reduce((sum, message) => sum + approximateTokens(message.content), 0);

    // Вопрос важнее бюджета, но не любой ценой: окно ограничено множителем
    // ANCHOR_BUDGET_FACTOR, иначе латентность съест весь ход.
    expect(tokens).toBeLessThanOrEqual(2500 * 4);
  });
});

describe('toProviderMessages: пары вызов ↔ результат', () => {
  it('не отправляет tool-результат без парного assistant-вызова', () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Разбери инбокс' },
      observation('ghost', 'Найдено 12 заметок'),
      { role: 'assistant', content: 'Final Answer: Готово.' },
    ];

    const messages = toProviderMessages(thread);

    // Ни одного tool-результата: имя функции провайдеру взять не из чего, и он
    // отвечает 400 «function_response.name: Name cannot be empty».
    expect(messages.flatMap((message) => message.toolResults ?? [])).toEqual([]);
    // Наблюдение не теряется — оно уходит текстом, как старый текстовый ReAct.
    expect(messages.map((message) => message.content)).toEqual([
      'Разбери инбокс',
      `${OBSERVATION_PREFIX}Найдено 12 заметок`,
      'Final Answer: Готово.',
    ]);
  });

  it('парный результат уходит нативным tool-результатом', () => {
    const thread: AgentMessage[] = [
      { role: 'user', content: 'Поставь задачу' },
      assistantWithCall('c1'),
      observation('c1', 'Задача создана.'),
    ];

    const messages = toProviderMessages(thread);

    expect(messages.flatMap((message) => message.toolResults ?? [])).toEqual([
      { toolCallId: 'c1', content: 'Задача создана.' },
    ]);
    expect(messages.some((message) => typeof message.content === 'string' && message.content.startsWith(OBSERVATION_PREFIX))).toBe(false);
  });

  it('результат из прошлого шага не становится сиротой-обёрткой', () => {
    // Вызов c1 объявлен до настоящей реплики пользователя: пара разорвана
    // санитайзом или обрезкой, поэтому результат уходит текстом.
    const thread: AgentMessage[] = [
      assistantWithCall('c1'),
      { role: 'user', content: 'Спасибо' },
      observation('c1', 'Задача создана.'),
    ];

    const messages = toProviderMessages(thread);

    expect(messages.flatMap((message) => message.toolResults ?? [])).toEqual([]);
    expect(messages.at(-1)?.content).toBe(`${OBSERVATION_PREFIX}Задача создана.`);
  });
});

describe('approximateTokens', () => {
  it('оценивает объём как ~4 символа на токен', () => {
    expect(approximateTokens('')).toBe(0);
    expect(approximateTokens('abcd')).toBe(1);
    expect(approximateTokens('а'.repeat(400))).toBe(100);
  });
});

describe('toChatMessages', () => {
  it('выбрасывает систему и размечает наблюдения', () => {
    const thread: AgentMessage[] = [
      { role: 'system', content: 'старый системный промпт' },
      { role: 'user', content: 'Поставь задачу' },
      assistantWithCall('c1'),
      observation('c1', 'Задача создана.'),
      { role: 'assistant', content: 'Final Answer: Готово.' },
    ];

    const messages = toChatMessages(thread);

    expect(messages).toEqual([
      { role: 'user', content: 'Поставь задачу' },
      { role: 'assistant', content: 'Thought: запишу задачу\nAction: add_task' },
      { role: 'user', content: `${OBSERVATION_PREFIX}Задача создана.` },
      { role: 'assistant', content: 'Final Answer: Готово.' },
    ]);
  });
});
