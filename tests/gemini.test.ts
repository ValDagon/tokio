/**
 * `src/lib/gemini.ts` — чат, JSON-режим, fallback-цепочка и эмбеддинги.
 *
 * Проверяем поведение, которое легко «сломать незаметно»:
 *  - ключ выбирается верно (BYOK → продуктовый) и BYOK не пишется в бухгалтерию;
 *  - 404/429/5xx уводят на следующую модель, 400 — нет (плохой запрос не лечится
 *    сменой модели, в отличие от протухшей модели);
 *  - пустой ответ модели — тоже повод идти дальше по цепочке;
 *  - эмбеддинги сначала пробуют «родной» endpoint, потом OpenAI-совместимый.
 *
 * Сеть всегда мок: `fetch` из `sdk/fetch` подменён `tests/mocks/sdk.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fetch, makeResponse, resetDb, resetFetch, setFetchMock, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { ensureUser, getUser, updateUser } from '../src/lib/dal/users';
import { sealByok } from '../src/lib/crypto';
import {
  CHAT_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  EMBEDDINGS_URL,
  GEMINI_NATIVE_BASE,
  GeminiError,
  JSON_MAX_TOKENS,
  JSON_TEMPERATURE,
  MAX_EMBEDDING_INPUT_CHARS,
  buildChatBody,
  chat,
  chatJson,
  embed,
  getGeminiApiKey,
  isGeminiConfigured,
  normalizeApiKey,
  normalizeEmbeddingText,
  parseJsonContent,
  resolveApiKey,
  resolveModelChain,
  shouldTryNextModel,
  tryEmbed,
} from '../src/lib/gemini';
import { EMBEDDING_DIMENSIONS } from '../src/types';

const USER = 1;
const PRODUCT_KEY = 'product-key';
const BYOK_KEY = 'AIzaSyTestByokKey1234567890abcdef';
const MODELS = ['model-a', 'model-b'] as const;

/** Тело ответа чата в форме OpenAI-совместимого API. */
function chatResponse(content = 'ok', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gemini-2.5-flash',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    ...extra,
  };
}

/** Тело запроса N-го вызова fetch. */
function sentBody(index: number): Record<string, unknown> {
  const call = fetch.calls[index];
  expect(call).toBeDefined();
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;
}

/** Заголовки N-го вызова fetch. */
function sentHeaders(index: number): Record<string, string> {
  const call = fetch.calls[index];
  expect(call).toBeDefined();
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

/** Сколько строк учёта в `llm_usage`. */
async function usageRowCount(): Promise<number> {
  const row = await db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM llm_usage`);
  return Number(row?.c ?? 0);
}

/** Ловит ожидаемое исключение и отдаёт его типизированным. */
async function rejection(promise: Promise<unknown>): Promise<GeminiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GeminiError);
  return error as GeminiError;
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetFetch();
  resetConfigCache();
  setConfigOverrides({
    geminiApiKey: PRODUCT_KEY,
    masterKey: 'master-key-for-tests',
    geminiModels: [...MODELS],
  });
  // Fallback-тесты сознательно гоняют отказы — их предупреждения не нужны в выводе.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// Статусы и ключи
// ---------------------------------------------------------------------------

describe('shouldTryNextModel', () => {
  it('уводит на следующую модель только при «протухшей»/перегруженной модели', () => {
    expect(shouldTryNextModel(404)).toBe(true);
    expect(shouldTryNextModel(408)).toBe(true);
    expect(shouldTryNextModel(429)).toBe(true);
    expect(shouldTryNextModel(500)).toBe(true);
    expect(shouldTryNextModel(503)).toBe(true);

    expect(shouldTryNextModel(400)).toBe(false);
    expect(shouldTryNextModel(401)).toBe(false);
    expect(shouldTryNextModel(403)).toBe(false);
    expect(shouldTryNextModel(200)).toBe(false);
    expect(shouldTryNextModel(0)).toBe(false);
  });
});

describe('normalizeApiKey', () => {
  it('не трогает нормальные ключи и добавляет AQ. только обрезанным', () => {
    expect(normalizeApiKey('AQ.abc123')).toBe('AQ.abc123');
    expect(normalizeApiKey('  AIzaSyRealKey  ')).toBe('AIzaSyRealKey');
    expect(normalizeApiKey('Ab8Rxyz')).toBe('AQ.Ab8Rxyz');
    expect(normalizeApiKey('a'.repeat(50))).toBe(`AQ.${'a'.repeat(50)}`);
    expect(normalizeApiKey('')).toBe('');
    expect(normalizeApiKey('   ')).toBe('');
  });

  it('продуктовый ключ из конфига проходит ту же нормализацию', async () => {
    expect(await getGeminiApiKey()).toBe(PRODUCT_KEY);
    expect(await isGeminiConfigured()).toBe(true);

    setConfigOverrides({ geminiApiKey: 'b'.repeat(50) });
    expect(await getGeminiApiKey()).toBe(`AQ.${'b'.repeat(50)}`);

    setConfigOverrides({ geminiApiKey: '' });
    expect(await getGeminiApiKey()).toBe('');
    expect(await isGeminiConfigured()).toBe(false);
  });
});

describe('resolveApiKey', () => {
  it('без пользователя отдаёт продуктовый ключ', async () => {
    expect(await resolveApiKey()).toEqual({ apiKey: PRODUCT_KEY, byok: false });
    expect(await resolveApiKey(USER)).toEqual({ apiKey: PRODUCT_KEY, byok: false });
  });

  it('берёт расшифрованный BYOK-ключ пользователя', async () => {
    await ensureUser(USER);
    await updateUser(USER, { byok: await sealByok(USER, BYOK_KEY) });

    expect(await resolveApiKey(USER)).toEqual({ apiKey: BYOK_KEY, byok: true });
  });

  it('падает, если ключей нет вовсе', async () => {
    setConfigOverrides({ geminiApiKey: '' });
    const error = await rejection(resolveApiKey());
    expect(error.message).toMatch(/API key is not configured/);
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(false);
  });

  it('нечитаемый BYOK (сменился MASTER_KEY) не ломает ответ — берётся продуктовый ключ', async () => {
    await ensureUser(USER);
    // Ключ запечатан старым MASTER_KEY: расшифровка даёт мусор, а не ключ.
    await updateUser(USER, {
      byok: await sealByok(USER, BYOK_KEY, { masterKey: 'old-master-key-32-chars-long-aaaa' }),
    });

    expect(await resolveApiKey(USER)).toEqual({ apiKey: PRODUCT_KEY, byok: false });
  });
});

// ---------------------------------------------------------------------------
// Цепочка моделей и тело запроса
// ---------------------------------------------------------------------------

describe('resolveModelChain', () => {
  it('явная цепочка перебивает всё и дедуплицируется', async () => {
    expect(await resolveModelChain({ models: ['x', 'x', ' y ', ''] })).toEqual(['x', 'y']);
    expect(await resolveModelChain({ model: 'ignored', models: ['x'] })).toEqual(['x']);
  });

  it('модель из опций идёт первой, остальные — из конфига', async () => {
    expect(await resolveModelChain({ model: 'model-x' })).toEqual(['model-x', 'model-a', 'model-b']);
    expect(await resolveModelChain({ model: 'model-a' })).toEqual(['model-a', 'model-b']);
  });

  it('без опций — цепочка из конфига', async () => {
    expect(await resolveModelChain()).toEqual(['model-a', 'model-b']);
  });

  it('пустая цепочка — ошибка', async () => {
    setConfigOverrides({ geminiModels: [] });
    const error = await rejection(resolveModelChain());
    expect(error.message).toMatch(/model chain is empty/);
    expect(error.retryable).toBe(false);
  });
});

describe('buildChatBody', () => {
  const messages = [
    { role: 'system' as const, content: 'ты ассистент' },
    { role: 'user' as const, content: 'привет' },
  ];

  it('обычный режим: температура 0.7 и 8192 токена', () => {
    const body = buildChatBody('m', messages);
    expect(body.model).toBe('m');
    expect(body.messages).toEqual(messages);
    expect(body.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.response_format).toBeUndefined();
  });

  it('JSON-режим: response_format, температура 0.1 и 4096 токенов', () => {
    const body = buildChatBody('m', messages, { json: true });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(JSON_TEMPERATURE);
    expect(body.max_tokens).toBe(JSON_MAX_TOKENS);
  });

  it('явные температура и лимит перебивают дефолты', () => {
    const body = buildChatBody('m', messages, { temperature: 0, maxTokens: 10, json: true });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(10);
  });
});

describe('parseJsonContent', () => {
  it('принимает чистый JSON, фенсы и текст вокруг объекта', () => {
    expect(parseJsonContent('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('Вот ответ: {"a":1}, надеюсь, верный')).toEqual({ a: 1 });
    expect(parseJsonContent('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('пустой и не-JSON ответ — ошибка', () => {
    expect(() => parseJsonContent('')).toThrow(/empty answer/);
    expect(() => parseJsonContent('  \n ')).toThrow(/empty answer/);
    expect(() => parseJsonContent('просто текст без структуры')).toThrow(/non-JSON/);
    expect(() => parseJsonContent('{сломано')).toThrow(/non-JSON/);
  });
});

// ---------------------------------------------------------------------------
// chat — успешный вызов и учёт
// ---------------------------------------------------------------------------

describe('chat', () => {
  it('делает один запрос продуктовым ключом и пишет расход в llm_usage', async () => {
    await ensureUser(USER);
    setFetchMock((url) => makeResponse(200, chatResponse('{"title":"ok"}'), url));

    const result = await chat([{ role: 'user', content: 'привет' }], { userId: USER });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(CHAT_URL);
    expect(sentHeaders(0)).toMatchObject({
      Authorization: `Bearer ${PRODUCT_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(sentBody(0)).toMatchObject({
      model: 'model-a',
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: 'привет' }],
    });

    expect(result.content).toBe('{"title":"ok"}');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    expect(result.costMicros).toBe(23); // 100*75/1e6 + 50*300/1e6 = 22.5 µUSD
    expect(result.byok).toBe(false);
    expect(result.modelsTried).toEqual([]);
    expect(result.finishReason).toBe('stop');

    expect(result.record?.row).not.toBeNull();
    expect(result.record?.charged).toBe(true);
    expect(await usageRowCount()).toBe(1);
    expect((await getUser(USER))?.quotaTokens).toBe(150);
  });

  it('JSON-режим включает response_format и разбирает ответ', async () => {
    setFetchMock((url) => makeResponse(200, chatResponse('{"title":"ok"}'), url));

    const result = await chatJson<{ title: string }>([{ role: 'user', content: 'сделай json' }], {
      json: true,
    });

    expect(sentBody(0).response_format).toEqual({ type: 'json_object' });
    expect(sentBody(0).temperature).toBe(JSON_TEMPERATURE);
    expect(sentBody(0).max_tokens).toBe(JSON_MAX_TOKENS);
    expect(result.data).toEqual({ title: 'ok' });
  });

  it('chatJson бросает, если модель ответила не-JSON', async () => {
    setFetchMock((url) => makeResponse(200, chatResponse('не json вовсе'), url));
    const error = await rejection(chatJson([{ role: 'user', content: 'json' }]));
    expect(error.message).toMatch(/non-JSON/);
    expect(error.model).toBe('gemini-2.5-flash');
  });

  it('404 уводит на следующую модель', async () => {
    let call = 0;
    setFetchMock((url) => {
      call += 1;
      return call === 1
        ? makeResponse(404, { error: { message: 'model not found' } }, url)
        : makeResponse(200, chatResponse('готово'), url);
    });

    const result = await chat([{ role: 'user', content: 'привет' }]);

    expect(fetch.calls).toHaveLength(2);
    expect(sentBody(0).model).toBe('model-a');
    expect(sentBody(1).model).toBe('model-b');
    expect(result.content).toBe('готово');
    expect(result.modelsTried).toEqual(['model-a']);
  });

  it('400 не ретраится: это плохой запрос, а не протухшая модель', async () => {
    setFetchMock((url) => makeResponse(400, { error: { message: 'bad request' } }, url));

    const error = await rejection(chat([{ role: 'user', content: 'привет' }]));

    expect(fetch.calls).toHaveLength(1);
    expect(error.status).toBe(400);
    expect(error.model).toBe('model-a');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/bad request/);
  });

  it('если упали все модели — ошибка со списком попыток', async () => {
    setFetchMock((url) => makeResponse(503, { error: { message: 'overloaded' } }, url));

    const error = await rejection(chat([{ role: 'user', content: 'привет' }]));

    expect(fetch.calls).toHaveLength(2);
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.modelsTried).toEqual(['model-a', 'model-b']);
    expect(error.model).toBe('model-b');
  });

  it('сетевая ошибка считается отказом модели', async () => {
    setFetchMock(() => {
      throw new Error('connection reset');
    });

    const error = await rejection(chat([{ role: 'user', content: 'привет' }]));

    expect(fetch.calls).toHaveLength(2);
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.modelsTried).toEqual(['model-a', 'model-b']);
  });

  it('пустой content — повод идти к следующей модели', async () => {
    let call = 0;
    setFetchMock((url) => {
      call += 1;
      return call === 1 ? makeResponse(200, chatResponse('   '), url) : makeResponse(200, chatResponse('ответ'), url);
    });

    const result = await chat([{ role: 'user', content: 'привет' }]);

    expect(fetch.calls).toHaveLength(2);
    expect(result.content).toBe('ответ');
    expect(result.modelsTried).toEqual(['model-a']);
  });

  it('без userId расход не пишется', async () => {
    setFetchMock((url) => makeResponse(200, chatResponse(), url));

    const result = await chat([{ role: 'user', content: 'привет' }]);

    expect(result.record).toBeNull();
    expect(result.costMicros).toBe(23);
    expect(await usageRowCount()).toBe(0);
  });

  it('track:false отключает учёт, но стоимость считает', async () => {
    await ensureUser(USER);
    setFetchMock((url) => makeResponse(200, chatResponse(), url));

    const result = await chat([{ role: 'user', content: 'привет' }], { userId: USER, track: false });

    expect(result.record).toBeNull();
    expect(result.costMicros).toBe(23);
    expect(await usageRowCount()).toBe(0);
    expect((await getUser(USER))?.quotaTokens).toBe(0);
  });

  it('BYOK: запрос уходит с ключом пользователя и не тратит квоту', async () => {
    await ensureUser(USER);
    await updateUser(USER, { byok: await sealByok(USER, BYOK_KEY) });
    setFetchMock((url) => makeResponse(200, chatResponse(), url));

    const result = await chat([{ role: 'user', content: 'привет' }], { userId: USER });

    expect(sentHeaders(0).Authorization).toBe(`Bearer ${BYOK_KEY}`);
    expect(result.byok).toBe(true);
    expect(result.record?.row).toBeNull();
    expect(result.record?.charged).toBe(false);
    expect(await usageRowCount()).toBe(0);
    expect((await getUser(USER))?.quotaTokens).toBe(0);
  });

  it('пустая цепочка сообщений — ошибка до всякого запроса', async () => {
    const error = await rejection(chat([]));
    expect(error.message).toMatch(/messages are empty/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('без ключа конфигурации падает до запроса', async () => {
    setConfigOverrides({ geminiApiKey: '' });
    const error = await rejection(chat([{ role: 'user', content: 'привет' }]));
    expect(error.message).toMatch(/API key is not configured/);
    expect(fetch.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Эмбеддинги
// ---------------------------------------------------------------------------

describe('normalizeEmbeddingText', () => {
  it('тримит и обрезает по лимиту', () => {
    expect(normalizeEmbeddingText('  привет  ')).toBe('привет');
    expect(normalizeEmbeddingText('')).toBe('');
    expect(normalizeEmbeddingText('а'.repeat(MAX_EMBEDDING_INPUT_CHARS + 100))).toHaveLength(
      MAX_EMBEDDING_INPUT_CHARS,
    );
  });
});

describe('embed', () => {
  it('пустой текст — пустой вектор без сети', async () => {
    expect(await embed('')).toEqual([]);
    expect(await embed('   \n ')).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('сначала пробует «родной» :embedContent', async () => {
    setFetchMock((url) => makeResponse(200, { embedding: { values: [0.1, 0.2, 0.3] } }, url));

    expect(await embed('привет')).toEqual([0.1, 0.2, 0.3]);
    expect(fetch.calls).toHaveLength(1);

    const url = fetch.calls[0]?.url ?? '';
    expect(url.startsWith(`${GEMINI_NATIVE_BASE}/models/`)).toBe(true);
    expect(url).toContain(`${DEFAULT_EMBEDDING_MODEL}:embedContent`);
    expect(sentHeaders(0)['x-goog-api-key']).toBe(PRODUCT_KEY);
    expect(sentBody(0)).toMatchObject({
      model: `models/${DEFAULT_EMBEDDING_MODEL}`,
      content: { parts: [{ text: 'привет' }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    });
  });

  it('при отказе родного endpoint уходит в OpenAI-совместимый', async () => {
    let call = 0;
    setFetchMock((url) => {
      call += 1;
      return call === 1
        ? makeResponse(500, { error: { message: 'nope' } }, url)
        : makeResponse(200, { data: [{ embedding: [1, 2, 3] }] }, url);
    });

    expect(await embed('привет')).toEqual([1, 2, 3]);
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[1]?.url).toBe(EMBEDDINGS_URL);
    expect(sentHeaders(1).Authorization).toBe(`Bearer ${PRODUCT_KEY}`);
    expect(sentBody(1)).toMatchObject({
      model: DEFAULT_EMBEDDING_MODEL,
      input: 'привет',
      dimensions: EMBEDDING_DIMENSIONS,
    });
  });

  it('если оба endpoint отказали — GeminiError', async () => {
    setFetchMock((url) => makeResponse(502, { error: { message: 'bad gateway' } }, url));

    const error = await rejection(embed('привет'));
    expect(error.message).toMatch(/embedding failed/);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
    expect(fetch.calls).toHaveLength(2);
  });

  it('tryEmbed прячет ошибки в null, но отдаёт успешный вектор', async () => {
    setFetchMock((url) => makeResponse(500, { error: { message: 'nope' } }, url));
    expect(await tryEmbed('привет')).toBeNull();

    resetFetch();
    setFetchMock((url) => makeResponse(200, { embedding: { values: [0.5] } }, url));
    expect(await tryEmbed('привет')).toEqual([0.5]);
  });
});
