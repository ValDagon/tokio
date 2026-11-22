/**
 * Фасад чата: ключи, биллинг, перебор моделей и эмбеддинги.
 *
 * Раньше этот модуль был единственным клиентом и жёстко знал про Gemini:
 * base URL, `Authorization: Bearer`, цепочку моделей и форму ответа. Теперь
 * транспорт вынесен в `lib/provider/*`, а здесь осталось то, что от провайдера
 * не зависит:
 *  - выбор ключа: BYOK пользователя (только для «своего» провайдера) либо
 *    продуктовый ключ нужного провайдера;
 *  - fallback-цепочка: 404/408/429/5xx → следующая модель, 400/401/403 →
 *    ошибка наверх (это не «модель протухла», это плохой запрос или ключ);
 *  - учёт токенов в `llm_usage` (`lib/billing.ts`); сбой учёта не ломает ответ;
 *  - эмбеддинги (`text-embedding-004`, 768 измерений) — намеренно прибиты к
 *    Gemini и не следуют за чат-провайдером, пока не случится отдельная
 *    миграция размерности.
 *
 * Публичный API модуля сохранён: `chat`, `chatJson`, типы, `GeminiError`,
 * `resolveModelChain`, `buildChatBody`, константы — их импортируют `stt.ts`,
 * `vision.ts`, `consolidation.ts`, движок агента и тесты.
 */

import { fetch } from 'sdk/fetch';
import type { FetchResponse } from 'sdk/fetch';
import { EMBEDDING_DIMENSIONS } from './types.js';
import { getConfig } from './config.js';
import { getUser } from './dal/users.js';
import { decryptByok, looksLikeApiKey } from './crypto.js';
import {
  checkSpendLimit,
  estimateCostMicros,
  recordUsage,
  SPEND_LIMIT_EXCEEDED_MESSAGE,
  type UsageRecord,
} from './billing.js';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  GeminiError,
  JSON_MAX_TOKENS,
  JSON_TEMPERATURE,
  getProvider,
  resolveProviderId,
  shouldTryNextModel,
  type ChatContentPart,
  type ChatMessage,
  type ChatRole,
  type ChatUsage,
  type ProviderId,
  type ProviderToolCall,
  type ProviderToolSpec,
} from './provider/index.js';

export { GeminiError, shouldTryNextModel } from './provider/index.js';
export type { GeminiErrorOptions } from './provider/index.js';
export type { ChatContentPart, ChatMessage, ChatRole, ChatUsage } from './provider/index.js';

// ---------------------------------------------------------------------------
// Адреса и дефолты
// ---------------------------------------------------------------------------

/** База OpenAI-совместимого API Gemini. */
export const GEMINI_OPENAI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

/** База «родного» API Gemini (эмбеддинги, `:embedContent`). */
export const GEMINI_NATIVE_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Чат-комплишены Gemini (OpenAI-совместимая форма). */
export const CHAT_URL = `${GEMINI_OPENAI_BASE}/chat/completions`;

/** Эмбеддинги в OpenAI-совместимой форме (fallback). */
export const EMBEDDINGS_URL = `${GEMINI_OPENAI_BASE}/embeddings`;

/** Модель эмбеддингов по умолчанию — как в upstream `embeddings.py`. */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';

/** Сколько символов входа отдаём модели (в Python — `text[:8000]`). */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

// Дефолты чата живут в `provider/defaults.ts`; реэкспорт держит старые импорты.
export { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, JSON_MAX_TOKENS, JSON_TEMPERATURE };

// ---------------------------------------------------------------------------
// Ключ
// ---------------------------------------------------------------------------

/**
 * Чинит обрезанные ключи Gemini Studio, потерявшие префикс `AQ.`
 * (эвристика ровно как в `get_gemini_api_key`).
 *
 * Применяется только к Gemini: у OpenAI ключ ~51 символ, у Anthropic — `sk-ant-…`,
 * и эвристика по длине испортила бы их.
 */
export function normalizeApiKey(key: string): string {
  const value = String(key ?? '').trim();
  if (!value) return '';
  if (value.startsWith('AQ.')) return value;
  if (value.startsWith('Ab8R') || value.length === 50) return `AQ.${value}`;
  return value;
}

/** Продуктовый ключ Gemini из конфига (нормализованный; пустая строка — не задан). */
export async function getGeminiApiKey(): Promise<string> {
  const config = await getConfig();
  return normalizeApiKey(config.geminiApiKey);
}

/** Сконфигурирован ли продуктовый ключ Gemini. */
export async function isGeminiConfigured(): Promise<boolean> {
  return (await getGeminiApiKey()) !== '';
}

/** Имя переменной окружения для ключа провайдера. */
function apiKeyEnvName(provider: ProviderId): string {
  if (provider === 'openai') return 'OPENAI_API_KEY';
  if (provider === 'deepseek') return 'DEEPSEEK_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  return 'GEMINI_API_KEY';
}

/** Продуктовый ключ выбранного провайдера (без BYOK). */
async function getProductApiKey(provider: ProviderId): Promise<string> {
  const config = await getConfig();
  if (provider === 'openai') return String(config.openaiApiKey ?? '').trim();
  if (provider === 'deepseek') return String(config.deepseekApiKey ?? '').trim();
  if (provider === 'anthropic') return String(config.anthropicApiKey ?? '').trim();
  return normalizeApiKey(config.geminiApiKey);
}

/** Выбранный ключ и его происхождение. */
export interface ResolvedApiKey {
  apiKey: string;
  /** `true` — ключ пользователя (квота продукта не тратится). */
  byok: boolean;
}

/**
 * Предупреждение о нечитаемом BYOK — не чаще раза в 10 минут на пользователя.
 * Иначе один ход агента печатает его на каждый вызов модели (наблюдалось 8 раз
 * за сообщение) и лог перестаёт быть читаемым.
 */
const BYOK_WARN_TTL_MS = 10 * 60 * 1000;
const byokWarnedAt = new Map<number, number>();

function warnBrokenByokOnce(userId: number, message: string): void {
  const now = Date.now();
  const last = byokWarnedAt.get(userId) ?? 0;
  if (now - last < BYOK_WARN_TTL_MS) return;
  byokWarnedAt.set(userId, now);
  console.warn(message);
}

/**
 * Ключ для вызова: BYOK пользователя, иначе продуктовый.
 *
 * BYOK используется только если он сохранён для того же провайдера, к которому
 * идёт запрос: иначе ключ одного сервиса уехал бы на endpoint другого. Легаси
 * записи без `model_provider` считаются Gemini-ключами.
 *
 * Расшифровка BYOK не бросает наверх: ChaCha20 без тега может дать мусор, и
 * единственная разумная реакция — предупредить в лог и уйти на продуктовый
 * ключ (пользователь получит ответ, пусть и за счёт продукта).
 */
export async function resolveApiKey(
  userId?: number,
  provider: ProviderId = 'gemini',
): Promise<ResolvedApiKey> {
  if (typeof userId === 'number') {
    try {
      const user = await getUser(userId);
      const byok = user?.byok ?? null;
      const declared = user?.modelProvider ?? 'gemini';
      if (byok && byok.ciphertext && byok.nonce) {
        if (declared !== provider) {
          console.warn(
            `gemini: BYOK key of user ${userId} belongs to ${declared}, not ${provider}; using the product key`,
          );
        } else {
          const plaintext = await decryptByok(userId, byok.ciphertext, byok.nonce);
          const normalized = provider === 'gemini' ? normalizeApiKey(plaintext) : plaintext.trim();
          if (looksLikeApiKey(normalized)) {
            return { apiKey: normalized, byok: true };
          }
          warnBrokenByokOnce(
            userId,
            `gemini: BYOK key of user ${userId} failed the sanity check, using product key`,
          );
        }
      }
    } catch (error) {
      console.warn(`gemini: could not decrypt BYOK key of user ${userId}:`, error);
    }
  }

  const apiKey = await getProductApiKey(provider);
  if (!apiKey) {
    throw new GeminiError(
      `${provider}: API key is not configured (${apiKeyEnvName(provider)} or BYOK)`,
      { status: 0, retryable: false },
    );
  }
  return { apiKey, byok: false };
}

// ---------------------------------------------------------------------------
// Чат: типы
// ---------------------------------------------------------------------------

export interface ChatOptions {
  /** Чей ключ тратить и в чью квоту/историю писать. */
  userId?: number;
  /** Провайдер чата; по умолчанию — `config.chatProvider` (обычно Gemini). */
  provider?: ProviderId;
  /** Начать цепочку с этой модели, остальные — из конфига. */
  model?: string;
  /** Явная цепочка моделей (перебивает и `model`, и конфиг). */
  models?: readonly string[];
  temperature?: number;
  maxTokens?: number;
  /** JSON-режим: у OpenAI-совместимых — `response_format`. */
  json?: boolean;
  /** Описания инструментов для нативного function calling. */
  tools?: readonly ProviderToolSpec[];
  /** Метка в `llm_usage.purpose` (по умолчанию `agent`). */
  purpose?: string | null;
  /** `false` — не писать в `llm_usage` (например, сухой прогон в тестах). */
  track?: boolean;
}

export interface ChatResult {
  content: string;
  /** Модель, которая ответила. */
  model: string;
  usage: ChatUsage;
  /** Стоимость вызова в микро-долларах (0 при `track: false`). */
  costMicros: number;
  /** Ответ оплачен ключом пользователя. */
  byok: boolean;
  /** Модели, которые успели отказать (404/429/5xx), по порядку. */
  modelsTried: string[];
  finishReason: string | null;
  /** Нативные вызовы инструментов; в T1 всегда пусто (ReAct текстовый). */
  toolCalls: ProviderToolCall[];
  /** Сырой JSON ответа — на случай отладки и нестандартных полей. */
  raw: unknown;
  /** Строка `llm_usage`, если учёт писался. */
  record: UsageRecord | null;
}

// ---------------------------------------------------------------------------
// Чат: разбор ответа
// ---------------------------------------------------------------------------

function errorMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === 'string') return error.message;
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body ?? '');
}

/** Читает тело один раз: у платформенного `Response` `bodyUsed` необратим. */
async function readBody(response: FetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return String(error);
  }
}

function parseJson(text: string): unknown {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Достаёт JSON из ответа модели: снимает markdown-фенсы, отбрасывает
 * пояснения вокруг объекта и, если совсем не вышло, бросает `GeminiError`.
 */
export function parseJsonContent<T = unknown>(content: string): T {
  const text = String(content ?? '').trim();
  if (!text) throw new GeminiError('gemini: model returned an empty answer', { retryable: false });

  const unfenced = text
    .replace(/^```(?:json|JSON)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();

  for (const candidate of [unfenced, text]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // пробуем вырезать объект/массив из текста
    }
  }

  const firstBrace = unfenced.indexOf('{');
  const lastBrace = unfenced.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = unfenced.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice) as T;
    } catch {
      // ниже — общая ошибка
    }
  }
  const firstBracket = unfenced.indexOf('[');
  const lastBracket = unfenced.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const slice = unfenced.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(slice) as T;
    } catch {
      // ниже — общая ошибка
    }
  }

  throw new GeminiError('gemini: model returned non-JSON content', {
    retryable: false,
    body: text.slice(0, 500),
  });
}

// ---------------------------------------------------------------------------
// Чат: цепочка моделей
// ---------------------------------------------------------------------------

/**
 * Цепочка моделей для вызова: явная → `model` + цепочка провайдера → цепочка.
 *
 * `provider` по умолчанию — Gemini: `lib/stt.ts` использует этот же резолвер
 * для нативного аудио-endpoint'а и не должен зависеть от `LLM_PROVIDER`.
 */
export async function resolveModelChain(
  options: ChatOptions = {},
  provider: ProviderId = 'gemini',
): Promise<string[]> {
  const explicit = (options.models ?? []).map((model) => String(model ?? '').trim()).filter(Boolean);
  if (explicit.length > 0) return dedupe(explicit);

  const config = await getConfig();
  const chain: string[] = [];
  const head = String(options.model ?? '').trim();
  if (head) chain.push(head);
  for (const model of getProvider(provider).modelChain(config)) chain.push(model);

  const resolved = dedupe(chain.map((model) => model.trim()).filter(Boolean));
  if (resolved.length === 0) {
    throw new GeminiError(`${provider}: model chain is empty`, { retryable: false });
  }
  return resolved;
}

function dedupe(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

interface ChatRequestBody {
  model: string;
  messages: Array<{ role: ChatRole; content: string | readonly ChatContentPart[] }>;
  temperature: number;
  max_tokens: number;
  response_format?: { type: 'json_object' };
}

/**
 * Тело запроса в форме OpenAI-совместимого Gemini.
 *
 * Тонкая обёртка над адаптером: тесты и вызывающий код исторически проверяют
 * именно этот shape, а сам билдер живёт в `provider/openai-compat.ts`.
 */
export function buildChatBody(
  model: string,
  messages: readonly ChatMessage[],
  options: ChatOptions = {},
): ChatRequestBody {
  const request = getProvider('gemini').buildChatRequest(model, messages, '', options);
  return request.body as ChatRequestBody;
}

/** Провайдер и его база URL из конфига (override — только для не-Gemini). */
async function resolveProvider(
  options: ChatOptions,
): Promise<{ id: ProviderId; adapter: ReturnType<typeof getProvider> }> {
  const config = await getConfig();
  const id = resolveProviderId(options.provider ?? config.chatProvider);
  const baseUrl =
    id === 'openai'
      ? config.openaiBaseUrl
      : id === 'deepseek'
        ? config.deepseekBaseUrl
        : id === 'anthropic'
          ? config.anthropicBaseUrl
          : '';
  return { id, adapter: getProvider(id, baseUrl) };
}

/**
 * Один вызов модели (чат).
 *
 * Проходит по цепочке моделей до первого содержательного ответа. Пустой
 * `content` считается отказом модели — идём дальше, как в Python.
 *
 * @throws {GeminiError} если ни одна модель не ответила или ответ отброшен
 *         как «не тот запрос» (400/403) — тогда цепочка не продолжается
 */
export async function chat(
  messages: readonly ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  if (messages.length === 0) {
    throw new GeminiError('gemini.chat: messages are empty', { retryable: false });
  }

  const { id: providerId, adapter } = await resolveProvider(options);

  // [public-only] Лимит $2 на общий ключ — только публичная редакция.
  // Проверяется после выбора провайдера: BYOK освобождает лишь от расходов
  // своего провайдера, а не от продуктового ключа чужого.
  if (typeof options.userId === 'number') {
    const spend = await checkSpendLimit(options.userId, providerId);
    if (!spend.allowed) {
      throw new GeminiError(SPEND_LIMIT_EXCEEDED_MESSAGE, { status: 429, retryable: false });
    }
  }

  const chain = await resolveModelChain(options, providerId);
  const { apiKey, byok } = await resolveApiKey(options.userId, providerId);
  const modelsTried: string[] = [];

  let lastStatus = 0;
  let lastBody = '';

  for (const model of chain) {
    const request = adapter.buildChatRequest(model, messages, apiKey, options);

    let response: FetchResponse;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
    } catch (error) {
      // Сетевая ошибка: платформа не дала даже ответа — пробуем следующую модель.
      modelsTried.push(model);
      lastStatus = 0;
      lastBody = error instanceof Error ? error.message : String(error);
      continue;
    }

    const text = await readBody(response);
    const parsed = parseJson(text);

    if (!response.ok || !parsed) {
      modelsTried.push(model);
      lastStatus = response.status;
      lastBody = text;
      if (shouldTryNextModel(response.status)) continue;
      throw new GeminiError(
        `${providerId}: ${model} answered ${response.status}: ${errorMessage(parsed ?? text)}`,
        { status: response.status, model, body: text, retryable: false, modelsTried },
      );
    }

    const answer = adapter.parseChatResponse(parsed, model);
    if (!answer || (!answer.content && answer.toolCalls.length === 0)) {
      modelsTried.push(model);
      lastStatus = response.status;
      lastBody = text;
      continue;
    }

    const { promptTokens, completionTokens, totalTokens } = answer.usage;
    const usage: ChatUsage = { promptTokens, completionTokens, totalTokens };
    const answeredModel = answer.model || model;

    let record: UsageRecord | null = null;
    let costMicros = estimateCostMicros(answeredModel, promptTokens, completionTokens);
    if (typeof options.userId === 'number' && options.track !== false) {
      try {
        record = await recordUsage(options.userId, {
          model: answeredModel,
          promptTokens,
          completionTokens,
          costMicros,
          purpose: options.purpose ?? 'agent',
          byok,
        });
        costMicros = record.costMicros;
      } catch (error) {
        console.warn('gemini: could not record LLM usage:', error);
      }
    }

    return {
      content: answer.content,
      model: answeredModel,
      usage,
      costMicros,
      byok,
      modelsTried,
      finishReason: answer.finishReason,
      toolCalls: answer.toolCalls,
      raw: parsed,
      record,
    };
  }

  throw new GeminiError(
    `${providerId}: all models failed (${chain.join(', ')})${lastBody ? `: ${lastBody.slice(0, 300)}` : ''}`,
    {
      status: lastStatus,
      model: chain[chain.length - 1] ?? null,
      body: lastBody,
      retryable: lastStatus === 0 || shouldTryNextModel(lastStatus),
      modelsTried,
    },
  );
}

export interface JsonChatResult<T> extends ChatResult {
  data: T;
}

/**
 * Чат в JSON-режиме с разбором ответа.
 *
 * `T` — ожидаемая форма (проверять её — дело вызывающего: модель может
 * ответить валидным JSON с другими полями, как и в Python).
 */
export async function chatJson<T = unknown>(
  messages: readonly ChatMessage[],
  options: ChatOptions = {},
): Promise<JsonChatResult<T>> {
  const result = await chat(messages, { ...options, json: true });
  let data: T;
  try {
    data = parseJsonContent<T>(result.content);
  } catch (error) {
    const wrapped =
      error instanceof GeminiError
        ? new GeminiError(error.message, {
            status: error.status,
            model: result.model,
            body: error.body,
            retryable: error.retryable,
            modelsTried: result.modelsTried,
            cause: error,
          })
        : new GeminiError('gemini: could not parse JSON answer', {
            model: result.model,
            modelsTried: result.modelsTried,
            cause: error,
          });
    throw wrapped;
  }
  return { ...result, data };
}

// ---------------------------------------------------------------------------
// Эмбеддинги
// ---------------------------------------------------------------------------

export interface EmbedOptions {
  /** Чей ключ тратить (BYOK/квота). */
  userId?: number;
  /** Модель эмбеддингов; по умолчанию `text-embedding-004`. */
  model?: string;
  /** Размерность вектора; по умолчанию 768 (`EMBEDDING_DIMENSIONS`). */
  dimensions?: number;
}

/** Подготовка входа: trim + обрезка до 8000 символов (как в Python). */
export function normalizeEmbeddingText(text: string): string {
  return String(text ?? '')
    .trim()
    .slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

interface NativeEmbedResponse {
  embedding?: { values?: unknown };
  error?: { message?: unknown };
}

interface OpenAiEmbedResponse {
  data?: Array<{ embedding?: unknown }>;
  error?: { message?: unknown };
}

function toVector(values: unknown): number[] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const out: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

/**
 * Вектор текста.
 *
 * Сначала «родной» `:embedContent` (дешевле и точнее по размерности), затем
 * OpenAI-совместимый `/embeddings`. Пустой текст, как и в Python, даёт пустой
 * вектор без обращения к сети.
 *
 * Ключ всегда Gemini: размерность (`halfvec(768)`) и модель фиксированы, и
 * ключ другого провайдера здесь был бы невалиден.
 *
 * @throws {GeminiError} если оба endpoint'а отказали
 */
export async function embed(text: string, options: EmbedOptions = {}): Promise<number[]> {
  const input = normalizeEmbeddingText(text);
  if (!input) return [];

  const model = String(options.model ?? DEFAULT_EMBEDDING_MODEL).trim() || DEFAULT_EMBEDDING_MODEL;
  const dimensions =
    typeof options.dimensions === 'number' && options.dimensions > 0
      ? Math.trunc(options.dimensions)
      : EMBEDDING_DIMENSIONS;

  const { apiKey } = await resolveApiKey(options.userId, 'gemini');

  const nativeUrl = `${GEMINI_NATIVE_BASE}/models/${encodeURIComponent(model)}:embedContent`;
  try {
    const response = await fetch(nativeUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: input }] },
        outputDimensionality: dimensions,
      }),
    });
    const text_ = await readBody(response);
    if (response.ok) {
      const parsed = parseJson(text_) as NativeEmbedResponse | null;
      const vector = toVector(parsed?.embedding?.values);
      if (vector) return vector;
    }
  } catch (error) {
    console.warn('gemini: native embedding endpoint failed, falling back:', error);
  }

  let fallbackStatus = 0;
  let fallbackBody = '';
  try {
    const response = await fetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ model, input, dimensions }),
    });
    fallbackBody = await readBody(response);
    fallbackStatus = response.status;
    if (response.ok) {
      const parsed = parseJson(fallbackBody) as OpenAiEmbedResponse | null;
      const vector = toVector(parsed?.data?.[0]?.embedding);
      if (vector && vector.length > 0) return vector;
    }
  } catch (error) {
    fallbackBody = error instanceof Error ? error.message : String(error);
  }

  throw new GeminiError(
    `gemini: embedding failed${fallbackBody ? `: ${errorMessage(fallbackBody).slice(0, 300)}` : ''}`,
    { status: fallbackStatus, model, body: fallbackBody, retryable: shouldTryNextModel(fallbackStatus) },
  );
}

/**
 * Мягкая версия `embed`: любая ошибка (сеть, ключ, размерность) → `null`.
 * Ровно эта форма нужна `lib/embeddings.ts` (`EmbeddingsModelFn`).
 */
export async function tryEmbed(text: string, options: EmbedOptions = {}): Promise<number[] | null> {
  try {
    return await embed(text, options);
  } catch (error) {
    console.warn('gemini: embedding unavailable:', error);
    return null;
  }
}
