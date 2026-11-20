/**
 * Контракт чат-провайдера.
 *
 * Модуль намеренно не импортирует ничего: адаптеры зависят только от этих
 * типов, `lib/gemini.ts` реэкспортирует их наружу, поэтому цикла
 * `gemini → provider → gemini` не возникает.
 *
 * Что здесь есть и чего нет:
 *  - чат описан полностью (сообщения, инструменты, ответ, HTTP-запрос);
 *  - эмбеддинги сюда не входят: они остаются за `lib/gemini.ts` и прибиты к
 *    `text-embedding-004` / 768 измерений, пока не случится отдельная
 *    миграция размерности. `hasEmbeddings` — только декларация возможности.
 */

/** Провайдеры, которых умеет маршрутизировать фасад. */
export type ProviderId = 'gemini' | 'openai' | 'deepseek' | 'anthropic';

/** Роль сообщения (общая для всех провайдеров). */
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * Часть мультимодального сообщения (OpenAI-совместимая форма).
 *
 * Нужна для vision: текст + картинка одним сообщением. Платформа не знает
 * `Buffer`, поэтому картинки передаются как `data:`-URL с base64.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  /** Строка — обычный текст; массив — текст и/или картинки (vision). */
  content: string | readonly ChatContentPart[];
}

/** Расход токенов одного вызова. */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Инструменты (задел T2: нативный function calling)
// ---------------------------------------------------------------------------

/** Описание инструмента в провайдеро-нейтральной форме. */
export interface ProviderToolSpec {
  name: string;
  description: string;
  /** JSON Schema аргументов. */
  parameters: Record<string, unknown>;
}

/** Вызов инструмента, который вернула модель. */
export interface ProviderToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Непрозрачный блоб провайдера (Gemini: `extra_content.google.thought_signature`). */
  extraContent?: Record<string, unknown>;
}

/** Результат инструмента, который надо вернуть модели. */
export interface ProviderToolResult {
  toolCallId: string;
  content: string;
}

/**
 * Сообщение с нативными артефактами инструментов.
 *
 * В T1 движок работает на текстовом ReAct-протоколе и эти поля не заполняет;
 * адаптеры уже умеют их сериализовать (`tool_calls` / `tool_use`), чтобы T2 не
 * переписывал транспорт.
 */
export interface ProviderChatMessage extends ChatMessage {
  /** Вызовы, объявленные ассистентом. */
  toolCalls?: readonly ProviderToolCall[];
  /** Результаты инструментов (на сообщении пользователя). */
  toolResults?: readonly ProviderToolResult[];
}

/** Нормализованный ответ модели. */
export interface ProviderParsedResponse {
  /** Склеенный текст, без хвостовых пробелов. */
  content: string;
  /** Вызовы инструментов; в T1 всегда пусто. */
  toolCalls: ProviderToolCall[];
  usage: ChatUsage;
  finishReason: string | null;
  /** Модель, ответившая фактически (или `fallbackModel`). */
  model: string;
}

/** Параметры запроса, общие для адаптеров. */
export interface ProviderChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** JSON-режим: у OpenAI-совместимых — `response_format`. */
  json?: boolean;
  tools?: readonly ProviderToolSpec[];
}

/** Готовый HTTP-запрос: адаптер сам решает URL, заголовки и тело. */
export interface ProviderHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Источники цепочек моделей.
 *
 * `AppConfig` удовлетворяет этому интерфейсу структурно — адаптеры не
 * импортируют `config.ts`, поэтому остаются чистыми и легко тестируются.
 */
export interface ProviderModelSources {
  geminiModels: readonly string[];
  openaiModels: readonly string[];
  deepseekModels: readonly string[];
  anthropicModels: readonly string[];
}

/**
 * Адаптер провайдера.
 *
 * Всё, что раньше было зашито в `lib/gemini.ts` (base URL, заголовок
 * авторизации, цепочка моделей, форма инструментов, разбор ответа), живёт
 * здесь. Фасад отвечает только за ключи, биллинг и перебор моделей.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly baseUrl: string;
  /** Есть ли у провайдера эмбеддинги (в T1 реально используются только Gemini). */
  readonly hasEmbeddings: boolean;
  /** Заголовки авторизации для выбранного ключа. */
  authHeader(apiKey: string): Record<string, string>;
  /** Цепочка моделей по умолчанию: основная → fallback. */
  modelChain(config: ProviderModelSources): readonly string[];
  /** Полный HTTP-запрос одного вызова чата. */
  buildChatRequest(
    model: string,
    messages: readonly ProviderChatMessage[],
    apiKey: string,
    options: ProviderChatOptions,
  ): ProviderHttpRequest;
  /** Описания инструментов в форме провайдера. */
  buildToolRequests(tools: readonly ProviderToolSpec[]): unknown[];
  /** Разбор успешного тела ответа; `null` — тело не похоже на ответ чата. */
  parseChatResponse(rawBody: unknown, fallbackModel: string): ProviderParsedResponse | null;
}

// ---------------------------------------------------------------------------
// Дефолты чата
// ---------------------------------------------------------------------------

/**
 * Дефолтные лимиты вывода (общие для всех провайдеров).
 *
 * Думающие модели (Gemini 2.5/3.x/4.x) расходуют `max_tokens` в том числе
 * на внутренние reasoning-токены: потолок 2048 регулярно обрывал русский
 * финальный ответ посередине предложения. 8192/4096 поддерживается всеми
 * четырьмя провайдерами и даёт запас и на размышления, и на полный ответ.
 */
export const DEFAULT_TEMPERATURE = 0.7;
export const JSON_TEMPERATURE = 0.1;
export const DEFAULT_MAX_TOKENS = 8192;
export const JSON_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Ошибки провайдера
// ---------------------------------------------------------------------------

/** Параметры `GeminiError`. */
export interface GeminiErrorOptions {
  /** HTTP-статус последней неудачной попытки; `0` — ошибка до запроса. */
  status?: number;
  /** Модель, на которой всё сломалось (последняя попытка). */
  model?: string | null;
  /** Тело ответа (или текст сетевой ошибки) — для логов. */
  body?: string;
  /** Стоит ли пробовать ещё раз (5xx, 429, 404). */
  retryable?: boolean;
  /** Какие модели успели попробовать — по порядку. */
  modelsTried?: readonly string[];
  /** Первопричина, если ошибка обёрнута. */
  cause?: unknown;
}

/**
 * Ошибка клиента чата.
 *
 * Имя `GeminiError` сохранено: его импортируют `lib/stt.ts`, `lib/vision.ts`,
 * `lib/consolidation.ts` и тесты, а форма ошибки от провайдера не зависит.
 */
export class GeminiError extends Error {
  readonly status: number;
  readonly model: string | null;
  readonly body: string;
  readonly retryable: boolean;
  readonly modelsTried: string[];

  constructor(message: string, options: GeminiErrorOptions = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = options.status ?? 0;
    this.model = options.model ?? null;
    this.body = options.body ?? '';
    this.retryable = options.retryable ?? false;
    this.modelsTried = [...(options.modelsTried ?? [])];
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Статусы, при которых имеет смысл идти к следующей модели цепочки. */
export function shouldTryNextModel(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}
