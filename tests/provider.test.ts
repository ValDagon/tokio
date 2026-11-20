/**
 * Контракт провайдеров чата (`src/lib/provider/`).
 *
 * Проверяем ровно то, что нельзя проверить на живом API:
 *  - каждый адаптер собирает правильный URL, заголовки и тело;
 *  - разбор ответа переживает оба диалекта, включая нативные вызовы
 *    инструментов (задел T2);
 *  - фасад маршрутизирует по провайдеру и **не** отправляет BYOK-ключ одного
 *    сервиса на endpoint другого.
 *
 * Сеть всегда мок: `fetch` из `sdk/fetch` подменён `tests/mocks/sdk.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fetch, makeResponse, resetDb, resetFetch, setFetchMock, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { ensureUser, updateUser } from '../src/lib/dal/users';
import { sealByok } from '../src/lib/crypto';
import {
  ANTHROPIC_VERSION,
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  createAnthropicAdapter,
  createOpenAiCompatAdapter,
  getProvider,
  parseProviderId,
  resolveProviderId,
} from '../src/lib/provider/index';
import { CHAT_URL, chat } from '../src/lib/gemini';
import { estimateCostMicros, priceForModel } from '../src/lib/billing';

const USER = 1;
const BYOK_KEY = 'AIzaSyTestByokKey1234567890abcdef';
const PRODUCT_GEMINI = 'gemini-product-key';
const PRODUCT_ANTHROPIC = 'sk-ant-product-key';

const OPENAI_MODEL_SOURCES = {
  geminiModels: ['gemini-x'],
  openaiModels: ['gpt-x'],
  deepseekModels: ['deepseek-chat'],
  anthropicModels: ['claude-x'],
};

function sentBody(index = 0): Record<string, any> {
  const call = fetch.calls[index];
  expect(call).toBeDefined();
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, any>;
}

function sentHeaders(index = 0): Record<string, string> {
  const call = fetch.calls[index];
  expect(call).toBeDefined();
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetFetch();
  resetConfigCache();
  setConfigOverrides({
    geminiApiKey: PRODUCT_GEMINI,
    masterKey: 'master-key-for-tests',
    geminiModels: ['gemini-x'],
    anthropicApiKey: PRODUCT_ANTHROPIC,
    anthropicModels: ['claude-x'],
    openaiApiKey: 'openai-product-key',
    openaiModels: ['gpt-x'],
    deepseekApiKey: 'deepseek-product-key',
    deepseekModels: ['deepseek-chat'],
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// Реестр
// ---------------------------------------------------------------------------

describe('реестр провайдеров', () => {
  it('знает ровно четыре провайдера, по умолчанию — Gemini', () => {
    expect(PROVIDER_IDS).toEqual(['gemini', 'openai', 'deepseek', 'anthropic']);
    expect(DEFAULT_PROVIDER).toBe('gemini');
    expect(resolveProviderId('')).toBe('gemini');
    expect(resolveProviderId('junk')).toBe('gemini');
  });

  it('разбирает строку из БД/конфига без регистра и пробелов', () => {
    expect(parseProviderId('  Anthropic ')).toBe('anthropic');
    expect(parseProviderId('DEEPSEEK')).toBe('deepseek');
    expect(parseProviderId(null)).toBeNull();
    expect(parseProviderId('junk')).toBeNull();
  });

  it('подставляет базу URL прокси, не трогая официальные адреса', () => {
    expect(getProvider('openai').baseUrl).toBe('https://api.openai.com/v1');
    expect(getProvider('openai', 'https://gw.example/v1').baseUrl).toBe('https://gw.example/v1');
    expect(getProvider('anthropic', 'https://gw.example/v1').baseUrl).toBe('https://gw.example/v1');
  });
});

// ---------------------------------------------------------------------------
// OpenAI-совместимый адаптер
// ---------------------------------------------------------------------------

describe('openai-compat адаптер', () => {
  it.each([
    ['gemini', CHAT_URL],
    ['openai', 'https://api.openai.com/v1/chat/completions'],
    ['deepseek', 'https://api.deepseek.com/v1/chat/completions'],
  ] as const)('%s: URL, Bearer и тело', (preset, url) => {
    const adapter = createOpenAiCompatAdapter(preset);
    const request = adapter.buildChatRequest(
      'm',
      [{ role: 'user', content: 'привет' }],
      'key',
      {},
    );

    expect(adapter.id).toBe(preset);
    expect(request.url).toBe(url);
    expect(request.headers).toEqual({
      Authorization: 'Bearer key',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(request.body).toMatchObject({
      model: 'm',
      messages: [{ role: 'user', content: 'привет' }],
      temperature: 0.7,
      max_tokens: 8192,
    });
  });

  it('JSON-режим включает response_format и низкую температуру', () => {
    const adapter = createOpenAiCompatAdapter('openai');
    const request = adapter.buildChatRequest('m', [{ role: 'user', content: 'json' }], 'k', {
      json: true,
    });
    expect((request.body as any).response_format).toEqual({ type: 'json_object' });
    expect((request.body as any).temperature).toBe(0.1);
    expect((request.body as any).max_tokens).toBe(4096);
  });

  it('цепочка моделей берётся из своего поля конфига', () => {
    expect(createOpenAiCompatAdapter('gemini').modelChain(OPENAI_MODEL_SOURCES)).toEqual(['gemini-x']);
    expect(createOpenAiCompatAdapter('openai').modelChain(OPENAI_MODEL_SOURCES)).toEqual(['gpt-x']);
    expect(createOpenAiCompatAdapter('deepseek').modelChain(OPENAI_MODEL_SOURCES)).toEqual([
      'deepseek-chat',
    ]);
  });

  it('объявления инструментов — в форме OpenAI function', () => {
    const tools = createOpenAiCompatAdapter('openai').buildToolRequests([
      { name: 'add_task', description: 'добавить задачу', parameters: { type: 'object' } },
    ]);
    expect(tools).toEqual([
      {
        type: 'function',
        function: { name: 'add_task', description: 'добавить задачу', parameters: { type: 'object' } },
      },
    ]);
  });

  it('разбирает ответ с нативным tool_call (arguments — строка JSON)', () => {
    const parsed = createOpenAiCompatAdapter('gemini').parseChatResponse(
      {
        model: 'gemini-2.5-flash',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'add_task', arguments: '{"title":"x"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
      'fallback',
    );

    expect(parsed).toEqual({
      content: '',
      toolCalls: [{ id: 'call_1', name: 'add_task', args: { title: 'x' } }],
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      finishReason: 'tool_calls',
      model: 'gemini-2.5-flash',
    });
  });

  it('сохраняет непрозрачный extra_content вызова (Gemini thought_signature)', () => {
    const signature = { google: { thought_signature: 'sig-1' } };
    const parsed = createOpenAiCompatAdapter('gemini').parseChatResponse(
      {
        model: 'gemini-2.5-flash',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'add_task', arguments: '{"title":"x"}' },
                  extra_content: signature,
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'fallback',
    );

    expect(parsed?.toolCalls).toEqual([
      { id: 'call_1', name: 'add_task', args: { title: 'x' }, extraContent: signature },
    ]);
  });

  it('возвращает extra_content вызова в запросе байт-в-байт', () => {
    const signature = { google: { thought_signature: 'sig-1' } };
    const request = createOpenAiCompatAdapter('gemini').buildChatRequest(
      'm',
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'add_task', args: { title: 'x' }, extraContent: signature },
          ],
        },
        {
          role: 'user',
          content: '',
          toolResults: [{ toolCallId: 'call_1', content: 'Задача создана.' }],
        },
      ],
      'key',
      {},
    );

    const messages = (request.body as any).messages as Array<Record<string, any>>;
    expect(messages[0]?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'add_task', arguments: '{"title":"x"}' },
        extra_content: signature,
      },
    ]);
    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Задача создана.',
    });
  });

  it('Gemini: вызов без extraContent (thought_signature) не уходит как нативный tool_calls (защита от HTTP 400)', () => {
    const request = createOpenAiCompatAdapter('gemini').buildChatRequest(
      'gemini-4-hydrogen',
      [
        {
          role: 'assistant',
          content: 'Thought: проверю.\nAction: get_liabilities\nAction Input: {}',
          toolCalls: [{ id: 'call_2', name: 'get_liabilities', args: {} }],
        },
        {
          role: 'user',
          content: '',
          toolResults: [{ toolCallId: 'call_2', content: 'Подписки: Sail Research' }],
        },
      ],
      'key',
      {},
    );

    const messages = (request.body as any).messages as Array<Record<string, any>>;
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: 'Thought: проверю.\nAction: get_liabilities\nAction Input: {}',
    });
    expect(messages[0]?.tool_calls).toBeUndefined();
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'Observation: Подписки: Sail Research',
    });
  });

  it('битый JSON в arguments не роняет разбор и не-ответ даёт null', () => {
    const adapter = createOpenAiCompatAdapter('openai');
    const parsed = adapter.parseChatResponse(
      {
        choices: [
          {
            message: {
              content: 'ок',
              tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{сломано' } }],
            },
          },
        ],
      },
      'fb',
    );
    expect(parsed?.toolCalls).toEqual([{ id: 'c', name: 'x', args: {} }]);
    expect(adapter.parseChatResponse({ error: { message: 'nope' } }, 'fb')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe('anthropic адаптер', () => {
  const adapter = createAnthropicAdapter();

  it('шлёт /messages с x-api-key и версией API', () => {
    const request = adapter.buildChatRequest(
      'claude-x',
      [{ role: 'user', content: 'привет' }],
      'sk-ant-key',
      {},
    );

    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers).toEqual({
      'x-api-key': 'sk-ant-key',
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(request.body).toMatchObject({
      model: 'claude-x',
      max_tokens: 8192,
      temperature: 0.7,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'привет' }] }],
    });
  });

  it('выносит все system-сообщения в поле system, сохраняя порядок остальных', () => {
    const request = adapter.buildChatRequest(
      'claude-x',
      [
        { role: 'system', content: 'первая инструкция' },
        { role: 'system', content: 'вторая инструкция' },
        { role: 'user', content: 'вопрос' },
        { role: 'assistant', content: 'ответ' },
        { role: 'user', content: 'ещё вопрос' },
      ],
      'k',
      {},
    );

    const body = request.body as any;
    expect(body.system).toBe('первая инструкция\n\nвторая инструкция');
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'вопрос' }]);
  });

  it('склеивает сообщения одной роли: Anthropic требует чередования', () => {
    const body = adapter.buildChatRequest(
      'claude-x',
      [
        { role: 'user', content: 'раз' },
        { role: 'user', content: 'два' },
        { role: 'assistant', content: 'ответ' },
        { role: 'user', content: 'три' },
      ],
      'k',
      {},
    ).body as any;

    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'раз' },
      { type: 'text', text: 'два' },
    ]);
  });

  it('JSON-режим: response_format не отправляется, max_tokens обязателен', () => {
    const body = adapter.buildChatRequest(
      'claude-x',
      [{ role: 'user', content: 'json' }],
      'k',
      { json: true },
    ).body as any;
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.1);
  });

  it('переводит data:-URL картинки в base64-блок', () => {
    const body = adapter.buildChatRequest(
      'claude-x',
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'что тут?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      'k',
      {},
    ).body as any;

    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'что тут?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('инструменты объявляются как input_schema', () => {
    expect(adapter.buildToolRequests([{ name: 'x', description: 'd', parameters: { type: 'object' } }])).toEqual([
      { name: 'x', description: 'd', input_schema: { type: 'object' } },
    ]);
  });

  it('разбирает text + tool_use и usage input/output', () => {
    const parsed = adapter.parseChatResponse(
      {
        model: 'claude-x',
        content: [
          { type: 'text', text: 'Сейчас ' },
          { type: 'text', text: 'добавлю.' },
          { type: 'tool_use', id: 'toolu_1', name: 'add_task', input: { title: 'x' } },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
        stop_reason: 'tool_use',
      },
      'fb',
    );

    expect(parsed).toEqual({
      content: 'Сейчас добавлю.',
      toolCalls: [{ id: 'toolu_1', name: 'add_task', args: { title: 'x' } }],
      usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 },
      finishReason: 'tool_use',
      model: 'claude-x',
    });
  });

  it('тело ошибки (без content-массива) даёт null', () => {
    expect(adapter.parseChatResponse({ type: 'error', error: { message: 'bad' } }, 'fb')).toBeNull();
    expect(adapter.parseChatResponse('nope', 'fb')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Маршрутизация фасада
// ---------------------------------------------------------------------------

describe('chat: маршрутизация по провайдеру', () => {
  it('явный provider=anthropic уходит на Messages API', async () => {
    setFetchMock((url) =>
      makeResponse(
        200,
        {
          model: 'claude-x',
          content: [{ type: 'text', text: 'ответ' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        },
        url,
      ),
    );

    const result = await chat([{ role: 'user', content: 'привет' }], { provider: 'anthropic' });

    expect(fetch.calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sentHeaders(0)['x-api-key']).toBe(PRODUCT_ANTHROPIC);
    expect(sentBody(0).model).toBe('claude-x');
    expect(result.content).toBe('ответ');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(result.byok).toBe(false);
  });

  it('provider из конфига маршрутизирует запрос без явного выбора', async () => {
    setConfigOverrides({ chatProvider: 'deepseek' });
    setFetchMock((url) => makeResponse(200, { choices: [{ message: { content: 'ок' } }] }, url));

    await chat([{ role: 'user', content: 'привет' }]);

    expect(fetch.calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(sentHeaders(0).Authorization).toBe('Bearer deepseek-product-key');
    expect(sentBody(0).model).toBe('deepseek-chat');
  });

  it('BYOK одного провайдера не уезжает на endpoint другого', async () => {
    await ensureUser(USER);
    await updateUser(USER, { byok: await sealByok(USER, BYOK_KEY), modelProvider: 'gemini' });
    setFetchMock((url) =>
      makeResponse(
        200,
        { content: [{ type: 'text', text: 'ок' }], usage: { input_tokens: 1, output_tokens: 1 } },
        url,
      ),
    );

    const result = await chat([{ role: 'user', content: 'привет' }], {
      userId: USER,
      provider: 'anthropic',
      track: false,
    });

    expect(sentHeaders(0)['x-api-key']).toBe(PRODUCT_ANTHROPIC);
    expect(result.byok).toBe(false);
    expect(JSON.stringify(fetch.calls[0]?.init ?? {})).not.toContain(BYOK_KEY);
  });

  it('свой ключ своего провайдера используется и помечается byok', async () => {
    await ensureUser(USER);
    await updateUser(USER, {
      byok: await sealByok(USER, PRODUCT_ANTHROPIC),
      modelProvider: 'anthropic',
    });
    setFetchMock((url) =>
      makeResponse(
        200,
        { content: [{ type: 'text', text: 'ок' }], usage: { input_tokens: 1, output_tokens: 1 } },
        url,
      ),
    );

    const result = await chat([{ role: 'user', content: 'привет' }], {
      userId: USER,
      provider: 'anthropic',
      track: false,
    });

    expect(sentHeaders(0)['x-api-key']).toBe(PRODUCT_ANTHROPIC);
    expect(result.byok).toBe(true);
  });

  it('у Anthropic 404 уводит на следующую модель цепочки', async () => {
    setConfigOverrides({ anthropicModels: ['claude-a', 'claude-b'] });
    let call = 0;
    setFetchMock((url) => {
      call += 1;
      return call === 1
        ? makeResponse(404, { type: 'error', error: { message: 'model not found' } }, url)
        : makeResponse(
            200,
            { content: [{ type: 'text', text: 'готово' }], usage: { input_tokens: 1, output_tokens: 1 } },
            url,
          );
    });

    const result = await chat([{ role: 'user', content: 'привет' }], { provider: 'anthropic' });

    expect(fetch.calls).toHaveLength(2);
    expect(sentBody(0).model).toBe('claude-a');
    expect(sentBody(1).model).toBe('claude-b');
    expect(result.modelsTried).toEqual(['claude-a']);
  });

  it('без ключа выбранного провайдера падает до запроса', async () => {
    setConfigOverrides({ anthropicApiKey: '' });
    await expect(
      chat([{ role: 'user', content: 'привет' }], { provider: 'anthropic' }),
    ).rejects.toThrow(/API key is not configured \(ANTHROPIC_API_KEY or BYOK\)/);
    expect(fetch.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Биллинг не-Gemini моделей
// ---------------------------------------------------------------------------

describe('биллинг провайдеров', () => {
  it('знает ставки новых провайдеров и датированные ID', () => {
    expect(priceForModel('gpt-4o-mini')).toEqual({
      inputMicrosPerMillion: 150_000,
      outputMicrosPerMillion: 600_000,
    });
    expect(priceForModel('gpt-4o-mini-2024-07-18')).toEqual(priceForModel('gpt-4o-mini'));
    expect(priceForModel('claude-sonnet-4-5-20250929')).toEqual(priceForModel('claude-sonnet-4-5'));
    expect(priceForModel('claude-haiku-4-5')).toEqual({
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 5_000_000,
    });
    expect(priceForModel('deepseek-chat')).toEqual({
      inputMicrosPerMillion: 270_000,
      outputMicrosPerMillion: 1_100_000,
    });
  });

  it('не считает Anthropic по дефолтной ставке Gemini', () => {
    expect(estimateCostMicros('claude-sonnet-4-5', 1_000_000, 0)).toBe(3_000_000);
    expect(estimateCostMicros('gpt-4o', 0, 1_000_000)).toBe(10_000_000);
  });
});
