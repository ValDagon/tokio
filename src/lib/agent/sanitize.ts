/**
 * Санитизация истории диалога (SPEC §3 T11).
 *
 * Порт `sanitize_history_hook` из upstream `backend/app/agent/graph.py`, но без
 * LangChain-типов. В upstream проверка защищала Postgres-чекпоинт LangGraph от
 * `INVALID_CHAT_HISTORY`: висячий `ToolMessage` без `tool_call` в предыдущем
 * `AIMessage` роняет весь вызов. В порте чекпоинтов нет — история лежит json-
 * массивом в `agent_state.thread`, — но грабли те же: процесс мог упасть между
 * шагом модели и записью наблюдения, и тогда следующий прогон увидит «вызов
 * без результата» либо «результат без вызова». Модель в таком состоянии
 * начинает выдумывать Observation'ы, поэтому история чинится до отправки.
 *
 * Формат сообщения (`AgentMessage` из `src/types.ts`):
 *  - `role: 'user'` — реплика пользователя ИЛИ наблюдение инструмента
 *    (`meta.toolResult`), потому что ролей в таблице только три;
 *  - `role: 'assistant'` — шаг модели как есть: `Thought`/`Action`/`Final Answer`;
 *  - `role: 'system'` — старые системные сообщения, в промпт не идут (промпт
 *    собирается заново на каждый вызов).
 *
 * Что делает `sanitizeThread`:
 *  1. выбрасывает мусор (нестроковый content, неизвестная роль);
 *  2. выбрасывает «сиротские» наблюдения — те, чей `toolCallId` не объявлен в
 *     непосредственно предшествующем шаге ассистента;
 *  3. чинит обратную дыру: на каждый объявленный вызов без наблюдения
 *     синтезирует результат («Действие успешно зафиксировано.», как в upstream);
 *  4. обрезает разросшиеся наблюдения и тайминит историю по бюджету токенов,
 *     начиная окно с настоящей реплики пользователя (upstream `start_on="human"`).
 *
 * Все функции чистые: ни БД, ни сети, ни таймеров — только массивы сообщений.
 */

import type { AgentMessage } from '../../types.js';
import type { ChatMessage } from '../gemini.js';
import type { ProviderChatMessage } from '../provider/types.js';
import { truncate } from '../utils.js';

// ---------------------------------------------------------------------------
// Метаданные шага
// ---------------------------------------------------------------------------

/** Ключ `meta` у шага ассистента: объявленные вызовы инструментов. */
export const TOOL_CALLS_KEY = 'toolCalls';

/** Ключ `meta` у наблюдения: какому вызову оно отвечает. */
export const TOOL_RESULT_KEY = 'toolResult';

/** Текст синтезированного наблюдения — дословно как в upstream. */
export const SYNTHESIZED_OBSERVATION = 'Действие успешно зафиксировано.';

/** Объявленный моделью вызов инструмента. */
export interface ThreadToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  /** Непрозрачный блоб провайдера (Gemini: `extra_content.google.thought_signature`). */
  extraContent?: Record<string, unknown>;
}

/** Метаданные наблюдения. */
export interface ThreadToolResult {
  id: string;
  name: string;
  ok: boolean;
}

/** Текст наблюдения в формате протокола (модель видит `Observation: …`). */
export const OBSERVATION_PREFIX = 'Observation: ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Приводит произвольный `meta.toolCalls` к списку вызовов (мусор отбрасывается). */
export function toolCallsOf(message: AgentMessage): ThreadToolCall[] {
  const raw = message.meta?.[TOOL_CALLS_KEY];
  if (!Array.isArray(raw)) return [];
  const calls: ThreadToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    const args = isRecord(entry.args) ? entry.args : undefined;
    const extraContent = isRecord(entry.extraContent) ? entry.extraContent : undefined;
    calls.push({
      id,
      name,
      ...(args ? { args } : {}),
      ...(extraContent ? { extraContent } : {}),
    });
  }
  return calls;
}

/** Наблюдение инструмента (роль `user` + метка в `meta`). */
export function toolResultOf(message: AgentMessage): ThreadToolResult | null {
  const raw = message.meta?.[TOOL_RESULT_KEY];
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id) return null;
  return { id, name, ok: raw.ok !== false };
}

/** Сообщение является наблюдением инструмента? */
export function isObservation(message: AgentMessage): boolean {
  return toolResultOf(message) !== null;
}

/** Собирает метаданные наблюдения. */
export function observationMeta(result: ThreadToolResult): Record<string, unknown> {
  return { [TOOL_RESULT_KEY]: { id: result.id, name: result.name, ok: result.ok } };
}

/** Собирает метаданные шага ассистента с вызовами. */
export function toolCallsMeta(calls: readonly ThreadToolCall[]): Record<string, unknown> {
  return {
    [TOOL_CALLS_KEY]: calls.map((call) => ({
      id: call.id,
      name: call.name,
      ...(call.args ? { args: call.args } : {}),
      ...(call.extraContent ? { extraContent: call.extraContent } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

const ROLES = new Set(['user', 'assistant', 'system']);

function isWellFormed(message: unknown): message is AgentMessage {
  if (!isRecord(message)) return false;
  if (typeof message.role !== 'string' || !ROLES.has(message.role)) return false;
  return typeof message.content === 'string';
}

function cloneMessage(message: AgentMessage): AgentMessage {
  const clone: AgentMessage = { role: message.role, content: message.content };
  if (isRecord(message.meta)) clone.meta = { ...message.meta };
  return clone;
}

// ---------------------------------------------------------------------------
// Санитизация
// ---------------------------------------------------------------------------

/**
 * Дропает наблюдения, которые не отвечают на объявленный вызов, и синтезирует
 * отсутствующие результаты. Ожидаемые id сбрасываются на любой реплике,
 * которая не является наблюдением, — как в upstream.
 */
function repairToolPairing(messages: readonly AgentMessage[]): AgentMessage[] {
  // Шаг 1: сиротские наблюдения.
  const filtered: AgentMessage[] = [];
  let expected = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      expected = new Set(toolCallsOf(message).map((call) => call.id));
      filtered.push(message);
      continue;
    }
    const result = toolResultOf(message);
    if (result) {
      if (expected.has(result.id)) filtered.push(message);
      continue;
    }
    expected = new Set();
    filtered.push(message);
  }

  // Шаг 2: на каждый вызов — наблюдение.
  const repaired: AgentMessage[] = [];
  let index = 0;
  while (index < filtered.length) {
    const message = filtered[index]!;
    repaired.push(message);
    const calls = message.role === 'assistant' ? toolCallsOf(message) : [];
    if (calls.length === 0) {
      index += 1;
      continue;
    }

    let cursor = index + 1;
    const existing = new Set<string>();
    const results: AgentMessage[] = [];
    while (cursor < filtered.length && isObservation(filtered[cursor]!)) {
      const observation = filtered[cursor]!;
      const result = toolResultOf(observation)!;
      if (existing.has(result.id)) {
        cursor += 1;
        continue;
      }
      existing.add(result.id);
      results.push(observation);
      cursor += 1;
    }

    repaired.push(...results);
    for (const call of calls) {
      if (existing.has(call.id)) continue;
      repaired.push({
        role: 'user',
        content: SYNTHESIZED_OBSERVATION,
        meta: observationMeta({ id: call.id, name: call.name, ok: true }),
      });
    }
    index = cursor;
  }

  return repaired;
}

export interface TrimOptions {
  /** Бюджет истории в токенах (upstream: 2500). */
  maxTokens?: number;
  /** Жёсткий предел числа сообщений. */
  maxMessages?: number;
  /** Предел длины одного наблюдения в символах. */
  maxObservationChars?: number;
}

export const DEFAULT_MAX_TOKENS = 2500;
export const DEFAULT_MAX_MESSAGES = 80;
export const DEFAULT_MAX_OBSERVATION_CHARS = 4000;

/**
 * Во сколько раз окно может превысить бюджет, если иначе из него выпадает
 * последняя реплика пользователя. Вопрос в запросе важнее бюджета, но не любой
 * ценой: слишком большое окно — это латентность, с которой борется дедлайн хода.
 */
export const ANCHOR_BUDGET_FACTOR = 4;

/**
 * Грубая оценка токенов без токенизатора: кириллица и латиница в среднем
 * укладываются в ~4 символа на токен, плюс накладные расходы на сообщение.
 * Точность здесь не нужна — нужен предсказуемый и дешёвый потолок.
 */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

const MESSAGE_OVERHEAD_TOKENS = 4;

function messageTokens(message: AgentMessage): number {
  return approximateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** Обрезает слишком длинные наблюдения (модель не должна получать простыни). */
function clampObservations(
  messages: readonly AgentMessage[],
  maxChars: number,
): AgentMessage[] {
  if (maxChars <= 0) return [...messages];
  return messages.map((message) => {
    if (!isObservation(message) || message.content.length <= maxChars) return message;
    return { ...cloneMessage(message), content: truncate(message.content, maxChars) };
  });
}

/**
 * Оставляет хвост истории в бюджете токенов и сообщений. Окно всегда начинается
 * с настоящей реплики пользователя: обрезанное наблюдение без своего вызова
 * сбивает модель с толку, а запрос, который начинается с tool-результата,
 * провайдер отвергает (`function_response.name: Name cannot be empty`).
 */
export function trimThread(messages: readonly AgentMessage[], options: TrimOptions = {}): AgentMessage[] {
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
  const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
  const budgeted = clampObservations(
    messages,
    Math.floor(options.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS),
  );
  if (budgeted.length === 0) return [];

  /** Последняя настоящая реплика пользователя: якорь окна. */
  let anchor = -1;
  for (let index = budgeted.length - 1; index >= 0; index -= 1) {
    const message = budgeted[index]!;
    if (message.role === 'user' && !isObservation(message)) {
      anchor = index;
      break;
    }
  }

  const kept: AgentMessage[] = [];
  let tokens = 0;
  /** Индекс первого сообщения, попавшего в бюджетное окно. */
  let windowStart = budgeted.length;
  for (let index = budgeted.length - 1; index >= 0; index -= 1) {
    const message = budgeted[index]!;
    const cost = messageTokens(message);
    if (kept.length >= maxMessages) break;
    if (kept.length > 0 && tokens + cost > maxTokens) break;
    kept.unshift(message);
    tokens += cost;
    windowStart = index;
  }

  // Поднимаем начало окна до реплики пользователя (не наблюдения).
  let start = windowStart;
  while (start < budgeted.length) {
    const message = budgeted[start]!;
    if (message.role === 'user' && !isObservation(message)) break;
    start += 1;
  }
  if (start >= budgeted.length) {
    // Бюджет вытеснил вопрос: длинный ход набрал наблюдений больше, чем влезает.
    // Начинаем с последней реплики пользователя — без вопроса история бесполезна,
    // а наблюдение первым сообщением провайдер отвергает. Но окно всё равно
    // ограничено: иначе «спасение» вопроса превращается в огромный запрос.
    const anchored = anchor >= 0 ? anchor : windowStart;
    let anchoredTokens = 0;
    for (let index = anchored; index < budgeted.length; index += 1) {
      anchoredTokens += messageTokens(budgeted[index]!);
    }
    start = anchoredTokens <= maxTokens * ANCHOR_BUDGET_FACTOR ? anchored : windowStart;
  }
  return budgeted.slice(start);
}

export interface SanitizeOptions extends TrimOptions {
  /** `false` — только починить пары вызов/наблюдение, без обрезки по бюджету. */
  trim?: boolean;
}

/**
 * Полная подготовка истории к отправке модели: мусор → пары вызов/наблюдение →
 * бюджет токенов. Идемпотентна: повторный прогон не меняет результат.
 */
export function sanitizeThread(
  messages: readonly AgentMessage[] | null | undefined,
  options: SanitizeOptions = {},
): AgentMessage[] {
  const source = Array.isArray(messages) ? messages : [];
  const wellFormed = source.filter(isWellFormed).map(cloneMessage);
  const repaired = repairToolPairing(wellFormed);
  return options.trim === false ? repaired : trimThread(repaired, options);
}

// ---------------------------------------------------------------------------
// История → сообщения чата
// ---------------------------------------------------------------------------

/**
 * Разворачивает thread в сообщения для `lib/gemini.ts`. Наблюдение уходит в
 * роль `user` с префиксом `Observation:` — каноническая текстовая форма ReAct,
 * которую модель уверенно дочитывает. Системные сообщения выбрасываются:
 * системный промпт собирается заново на каждый вызов.
 */
export function toChatMessages(messages: readonly AgentMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const content = isObservation(message)
        ? `${OBSERVATION_PREFIX}${message.content}`
        : message.content;
      result.push({ role: 'user', content });
      continue;
    }
    result.push({ role: 'assistant', content: message.content });
  }
  return result;
}

/**
 * Разворачивает thread в сообщения провайдера с нативными артефактами
 * инструментов: вызовы ассистента уходят в `toolCalls`, результаты — в
 * `toolResults` (адаптеры сериализуют их как `tool_calls` / `tool` у
 * OpenAI-совместимых и `tool_use` / `tool_result` у Anthropic).
 *
 * Наблюдение без метаданных (история, записанная текстовым ReAct до перехода
 * на нативный function calling) остаётся текстом с префиксом `Observation:` —
 * старые треды читаются дальше.
 *
 * Наблюдение, чей вызов не объявлен в непосредственно предшествующем шаге
 * ассистента, тоже уходит текстом. Иначе провайдер получает tool-результат без
 * имени функции и отвечает 400 `function_response.name: Name cannot be empty`
 * (живой сбой 22.11.2026: «Разбери инбокс» — ход умирал именно так).
 */
export function toProviderMessages(messages: readonly AgentMessage[]): ProviderChatMessage[] {
  const result: ProviderChatMessage[] = [];
  /** Id вызовов последнего шага ассистента: только они имеют право на `toolResults`. */
  let declared = new Set<string>();

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'assistant') {
      const calls = toolCallsOf(message).map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args ?? {},
        ...(call.extraContent ? { extraContent: call.extraContent } : {}),
      }));
      declared = new Set(calls.map((call) => call.id));
      result.push(
        calls.length > 0
          ? { role: 'assistant', content: message.content, toolCalls: calls }
          : { role: 'assistant', content: message.content },
      );
      continue;
    }

    const observation = toolResultOf(message);
    if (observation) {
      if (!declared.has(observation.id)) {
        // Сирота: пары нет (тред обрезан, история починена наполовину, ход
        // продолжен с середины). Текстовое наблюдение читается моделью так же.
        result.push({
          role: 'user',
          content: `${OBSERVATION_PREFIX}${message.content}`,
        });
        continue;
      }
      // Текст наблюдения — тело tool-результата. Дублировать его ещё и в
      // `user`-сообщении нельзя: OpenAI ждёт `tool` сразу за ассистентом.
      result.push({
        role: 'user',
        content: '',
        toolResults: [{ toolCallId: observation.id, content: message.content }],
      });
      continue;
    }

    declared = new Set();
    result.push({ role: 'user', content: message.content });
  }
  return result;
}
