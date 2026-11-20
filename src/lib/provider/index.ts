/**
 * Провайдеры чата: адаптеры и реестр.
 *
 * Один модуль, а не пять, потому что у платформы жёсткий лимит модулей на
 * приложение (`Too many modules per app`). Слой всё равно изолирован: наружу
 * торчат только `ProviderAdapter`, реестр и разбор id, а `lib/gemini.ts`
 * остаётся фасадом с ключами, биллингом и перебором моделей.
 *
 * Диалекты:
 *  - `openai-compat` — Gemini (`/v1beta/openai`), OpenAI, DeepSeek:
 *    `Authorization: Bearer`, Chat Completions, `tool_calls`;
 *  - `anthropic` — `/v1/messages`, `x-api-key`, `tool_use` / `tool_result`.
 */

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  JSON_MAX_TOKENS,
  JSON_TEMPERATURE,
} from './types.js';
import type {
  ChatContentPart,
  ChatUsage,
  ProviderAdapter,
  ProviderChatMessage,
  ProviderChatOptions,
  ProviderModelSources,
  ProviderParsedResponse,
  ProviderToolCall,
  ProviderToolSpec,
  ProviderId,
} from './types.js';

export type { ProviderAdapter, ProviderId } from './types.js';
export { GeminiError, shouldTryNextModel } from './types.js';
export type { GeminiErrorOptions } from './types.js';
export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  JSON_MAX_TOKENS,
  JSON_TEMPERATURE,
} from './types.js';
export type {
  ChatContentPart,
  ChatMessage,
  ChatRole,
  ChatUsage,
  ProviderChatMessage,
  ProviderChatOptions,
  ProviderHttpRequest,
  ProviderModelSources,
  ProviderParsedResponse,
  ProviderToolCall,
  ProviderToolResult,
  ProviderToolSpec,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function serializeContent(content: ProviderChatMessage['content']): string | ChatContentPart[] {
  if (typeof content === 'string') return content;
  const parts: ChatContentPart[] = [];
  for (const part of content ?? []) {
    if (part === null || part === undefined) continue;
    if (part.type === 'text') {
      parts.push({ type: 'text', text: String(part.text ?? '') });
    } else if (part.type === 'image_url') {
      parts.push({ type: 'image_url', image_url: { url: String(part.image_url?.url ?? '') } });
    }
  }
  return parts;
}

function hasContent(content: ProviderChatMessage['content']): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return (content ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// OpenAI-совместимый диалект
// ---------------------------------------------------------------------------

/** Пресеты, различающиеся только адресом и цепочкой моделей. */
export type OpenAiCompatPreset = 'gemini' | 'openai' | 'deepseek';

const PRESET_BASE_URLS: Record<OpenAiCompatPreset, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /** Непрозрачный блоб провайдера, возвращается модели как есть. */
    extra_content?: Record<string, unknown>;
  }>;
  tool_call_id?: string;
}

interface OpenAiRequestBody {
  model: string;
  messages: OpenAiMessage[];
  temperature: number;
  max_tokens: number;
  response_format?: { type: 'json_object' };
  tools?: unknown[];
}

interface OpenAiResponseBody {
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  model?: unknown;
}

/** Сообщения в форме OpenAI, включая задел под нативные вызовы инструментов. */
function toOpenAiMessages(
  messages: readonly ProviderChatMessage[],
  preset: OpenAiCompatPreset,
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  const unsignedCallIds = new Set<string>();

  for (const message of messages) {
    const content = serializeContent(message.content);
    const toolCalls = message.toolCalls ?? [];
    const toolResults = message.toolResults ?? [];

    // OpenAI требует, чтобы `tool`-сообщения шли сразу за ассистентом с
    // `tool_calls`, без текстового `user` между ними. Поэтому результаты уходят
    // первыми, а пустая текстовая обёртка не отправляется вовсе.
    // Для Gemini вызов без `extraContent` (`thought_signature`) даёт HTTP 400 —
    // такие исторические или текстовые ReAct-вызовы держим в текстовом виде.
    for (const result of toolResults) {
      if (unsignedCallIds.has(result.toolCallId)) {
        out.push({ role: 'user', content: `Observation: ${result.content}` });
      } else {
        out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
      }
    }

    if (toolResults.length > 0 && !hasContent(message.content) && toolCalls.length === 0) {
      continue;
    }

    const hasUnsignedForGemini =
      preset === 'gemini' && toolCalls.length > 0 && toolCalls.some((call) => !call.extraContent);

    if (hasUnsignedForGemini) {
      for (const call of toolCalls) unsignedCallIds.add(call.id);
      const fallbackText = toolCalls
        .map((call) => `Action: ${call.name}\nAction Input: ${JSON.stringify(call.args ?? {})}`)
        .join('\n');
      out.push({
        role: message.role,
        content: hasContent(message.content) ? content : fallbackText,
      });
      continue;
    }

    const base: OpenAiMessage = {
      role: message.role,
      content: hasContent(message.content) || toolCalls.length > 0 ? content : '',
    };
    if (toolCalls.length > 0) {
      base.tool_calls = toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        ...(call.extraContent ? { extra_content: call.extraContent } : {}),
      }));
    }
    out.push(base);
  }
  return out;
}

/** Берёт из ответа `tool_calls`; битый `arguments` не роняет разбор. */
function parseOpenAiToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ProviderToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
      try {
        const parsed: unknown = JSON.parse(fn.arguments);
        if (isRecord(parsed)) args = parsed;
      } catch {
        args = {};
      }
    } else if (isRecord(fn.arguments)) {
      args = fn.arguments;
    }
    calls.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `call_${calls.length + 1}`,
      name,
      args,
      ...(isRecord(entry.extra_content) ? { extraContent: entry.extra_content } : {}),
    });
  }
  return calls;
}

/**
 * Создаёт адаптер OpenAI-совместимого провайдера.
 *
 * @param preset какой диалект (влияет только на базу URL и цепочку моделей)
 * @param baseUrlOverride адрес прокси/шлюза; пустая строка — пресет
 */
export function createOpenAiCompatAdapter(
  preset: OpenAiCompatPreset,
  baseUrlOverride?: string,
): ProviderAdapter {
  const override = String(baseUrlOverride ?? '').trim();
  const baseUrl = override || PRESET_BASE_URLS[preset];

  return {
    id: preset,
    baseUrl,
    hasEmbeddings: preset === 'gemini',

    authHeader(apiKey: string): Record<string, string> {
      return { Authorization: `Bearer ${apiKey}` };
    },

    modelChain(config: ProviderModelSources): readonly string[] {
      if (preset === 'openai') return config.openaiModels;
      if (preset === 'deepseek') return config.deepseekModels;
      return config.geminiModels;
    },

    buildToolRequests(tools: readonly ProviderToolSpec[]): unknown[] {
      return tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    },

    buildChatRequest(model, messages, apiKey, options) {
      const json = options.json === true;
      const body: OpenAiRequestBody = {
        model,
        messages: toOpenAiMessages(messages, preset),
        temperature: options.temperature ?? (json ? JSON_TEMPERATURE : DEFAULT_TEMPERATURE),
        max_tokens: options.maxTokens ?? (json ? JSON_MAX_TOKENS : DEFAULT_MAX_TOKENS),
      };
      if (json) body.response_format = { type: 'json_object' };
      if (options.tools && options.tools.length > 0) {
        body.tools = this.buildToolRequests(options.tools);
      }
      return {
        url: `${baseUrl}/chat/completions`,
        headers: {
          ...this.authHeader(apiKey),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      };
    },

    parseChatResponse(rawBody: unknown, fallbackModel: string): ProviderParsedResponse | null {
      if (!isRecord(rawBody)) return null;
      const parsed = rawBody as OpenAiResponseBody;
      const choice = parsed.choices?.[0];
      if (!choice || !isRecord(choice)) return null;

      const message = isRecord(choice.message) ? choice.message : {};
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      const toolCalls = parseOpenAiToolCalls(message.tool_calls);

      const promptTokens = asCount(parsed.usage?.prompt_tokens);
      const completionTokens = asCount(parsed.usage?.completion_tokens);
      const totalTokens = asCount(parsed.usage?.total_tokens) || promptTokens + completionTokens;
      const usage: ChatUsage = { promptTokens, completionTokens, totalTokens };

      return {
        content,
        toolCalls,
        usage,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : fallbackModel,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

/** Текущая версия Anthropic API, которую понимает адаптер. */
export const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: unknown[];
}

interface AnthropicResponseBody {
  content?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  stop_reason?: unknown;
  model?: unknown;
}

/** Строковая часть сообщения: у Anthropic системные сообщения — только текст. */
function textOf(content: string | readonly ChatContentPart[]): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('');
}

/** `data:<mime>;base64,<payload>` → base64-блок; обычный URL → url-блок. */
function toImageBlock(url: string): AnthropicBlock {
  const value = String(url ?? '');
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    const header = comma >= 0 ? value.slice(5, comma) : '';
    const mediaType = header.split(';')[0] || 'image/png';
    const data = comma >= 0 ? value.slice(comma + 1) : '';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  return { type: 'image', source: { type: 'url', url: value } };
}

function toBlocks(content: string | readonly ChatContentPart[]): AnthropicBlock[] {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'text', text: content }] : [];
  }
  const blocks: AnthropicBlock[] = [];
  for (const part of content ?? []) {
    if (part === null || part === undefined) continue;
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: String(part.text ?? '') });
    } else if (part.type === 'image_url') {
      blocks.push(toImageBlock(String(part.image_url?.url ?? '')));
    }
  }
  return blocks;
}

/**
 * Раскладывает общий список сообщений на системный промпт и `messages`.
 *
 * Системные сообщения склеиваются через пустую строку: у Anthropic это одно
 * поле, и терять середину инструкции нельзя. Одинаковые роли подряд
 * склеиваются — Anthropic требует чередования user/assistant.
 */
function splitMessages(
  messages: readonly ProviderChatMessage[],
): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOf(message.content).trim();
      if (text) systemParts.push(text);
      continue;
    }

    const blocks = toBlocks(message.content);
    if (message.toolResults && message.toolResults.length > 0) {
      for (const result of message.toolResults) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.content,
        });
      }
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
    }
    if (blocks.length === 0) continue;

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = out[out.length - 1];
    if (previous && previous.role === role) {
      previous.content.push(...blocks);
      continue;
    }
    out.push({ role, content: blocks });
  }

  return { system: systemParts.join('\n\n'), messages: out };
}

function parseAnthropicToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ProviderToolCall[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name.trim() : '';
    if (!name) continue;
    calls.push({
      id: typeof block.id === 'string' && block.id ? block.id : `toolu_${calls.length + 1}`,
      name,
      args: isRecord(block.input) ? block.input : {},
    });
  }
  return calls;
}

/**
 * Создаёт адаптер Anthropic.
 *
 * @param baseUrlOverride адрес прокси/шлюза; пустая строка — официальный API
 */
export function createAnthropicAdapter(baseUrlOverride?: string): ProviderAdapter {
  const override = String(baseUrlOverride ?? '').trim();
  const baseUrl = override || ANTHROPIC_DEFAULT_BASE_URL;

  return {
    id: 'anthropic',
    baseUrl,
    hasEmbeddings: false,

    authHeader(apiKey: string): Record<string, string> {
      return { 'x-api-key': apiKey };
    },

    modelChain(config: ProviderModelSources): readonly string[] {
      return config.anthropicModels;
    },

    buildToolRequests(tools: readonly ProviderToolSpec[]): unknown[] {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    },

    buildChatRequest(model, messages, apiKey, options: ProviderChatOptions) {
      const json = options.json === true;
      const split = splitMessages(messages);
      const body: AnthropicRequestBody = {
        model,
        max_tokens: options.maxTokens ?? (json ? JSON_MAX_TOKENS : DEFAULT_MAX_TOKENS),
        temperature: options.temperature ?? (json ? JSON_TEMPERATURE : DEFAULT_TEMPERATURE),
        messages: split.messages,
      };
      if (split.system) body.system = split.system;
      if (options.tools && options.tools.length > 0) {
        body.tools = this.buildToolRequests(options.tools);
      }
      return {
        url: `${baseUrl}/messages`,
        headers: {
          ...this.authHeader(apiKey),
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      };
    },

    parseChatResponse(rawBody: unknown, fallbackModel: string): ProviderParsedResponse | null {
      if (!isRecord(rawBody)) return null;
      const parsed = rawBody as AnthropicResponseBody;
      if (!Array.isArray(parsed.content)) return null;

      let content = '';
      for (const block of parsed.content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          content += block.text;
        }
      }

      const promptTokens = asCount(parsed.usage?.input_tokens);
      const completionTokens = asCount(parsed.usage?.output_tokens);
      const usage: ChatUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };

      return {
        content: content.trim(),
        toolCalls: parseAnthropicToolCalls(parsed.content),
        usage,
        finishReason: typeof parsed.stop_reason === 'string' ? parsed.stop_reason : null,
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : fallbackModel,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Реестр
// ---------------------------------------------------------------------------

/** Провайдер по умолчанию: поведение до T1 не меняется. */
export const DEFAULT_PROVIDER: ProviderId = 'gemini';

/** Полный список поддерживаемых провайдеров. */
export const PROVIDER_IDS: readonly ProviderId[] = ['gemini', 'openai', 'deepseek', 'anthropic'];

/** Строка из БД/конфига → провайдер; мусор → `null` (решает вызывающий). */
export function parseProviderId(value: unknown): ProviderId | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  for (const id of PROVIDER_IDS) {
    if (id === text) return id;
  }
  return null;
}

/** Строка из БД/конфига → провайдер с дефолтом (никогда не бросает). */
export function resolveProviderId(value: unknown): ProviderId {
  return parseProviderId(value) ?? DEFAULT_PROVIDER;
}

const REGISTRY: Readonly<Record<ProviderId, ProviderAdapter>> = {
  gemini: createOpenAiCompatAdapter('gemini'),
  openai: createOpenAiCompatAdapter('openai'),
  deepseek: createOpenAiCompatAdapter('deepseek'),
  anthropic: createAnthropicAdapter(),
};

/** Провайдеры с базами URL по умолчанию. */
export const PROVIDERS = REGISTRY;

/**
 * Адаптер провайдера.
 *
 * @param id провайдер
 * @param baseUrlOverride непустая строка перебивает официальный адрес
 *        (прокси, шлюз); каждый вызов с override создаёт новый адаптер
 */
export function getProvider(id: ProviderId, baseUrlOverride?: string): ProviderAdapter {
  const base = REGISTRY[id] ?? REGISTRY[DEFAULT_PROVIDER];
  const override = String(baseUrlOverride ?? '').trim();
  if (!override) return base;
  if (id === 'anthropic') return createAnthropicAdapter(override);
  const preset = id === 'openai' || id === 'deepseek' ? id : 'gemini';
  return createOpenAiCompatAdapter(preset, override);
}
