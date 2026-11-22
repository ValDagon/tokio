/**
 * ReAct-движок агента (SPEC §3 T11).
 *
 * Порт `backend/app/agent/graph.py` без LangGraph: вместо графа с чекпоинтерами
 * — явный `while`-цикл, вместо `PostgresSaver` — json-массив сообщений в
 * `agent_state.thread` (`lib/dal/agentState.ts`).
 *
 * Один прогон = один ответ пользователю:
 *
 *   история → промпт → модель → `Thought`/`Action` → инструмент → `Observation`
 *           → промпт → … → `Final Answer` (или graceful-остановка)
 *
 * Инварианты, унаследованные от upstream:
 *  - `maxSteps` (по умолчанию 8 ходов LLM) — модель не может крутиться
 *    бесконечно; батч инструментов в одном ходе тратит 1 ход, сверху страхуют
 *    `MAX_TOOL_CALLS_PER_RUN` и loop guard на повторы; на исчерпании шагов
 *    движок даёт один финальный ход синтеза без инструментов, и только при
 *    его отказе пользователь получает `stepLimitReply`;
 *  - неизвестный инструмент и падение инструмента не рвут прогон: наблюдение
 *    с текстом ошибки уходит модели, и она пробует иначе;
 *  - испорченная история (модель отвечает `400`/`INVALID_CHAT_HISTORY`) чинится
 *    автоматически: история один раз сбрасывается, запрос повторяется;
 *  - прогоны одного пользователя сериализуются в процессе: два одновременных
 *    сообщения не должны читать-писать один и тот же тред (в upstream это
 *    делал per-user lock);
 *  - история санитизируется до отправки и перед записью (`lib/agent/sanitize.ts`),
 *    поэтому висячие вызовы инструментов не накапливаются.
 *
 * Зависимости инъектируемы: `chatFn` (LLM) и `store` (тред). По умолчанию —
 * `lib/gemini.ts` с `purpose: 'agent'` и DAL `agent_state`. Ни `setTimeout`,
 * ни глобального `fetch` здесь нет (SPEC §2.3).
 */

import type { AgentMessage } from '../../types.js';
import type { ProviderId, ProviderToolCall, ProviderToolSpec } from '../provider/types.js';
import { DEFAULT_BASE_CURRENCY, DEFAULT_TIMEZONE } from '../config.js';
import { getChapter } from '../dal/docs.js';
import { listDoses } from '../dal/medications.js';
import { kvSetJson } from '../dal/misc.js';
import { listTasks } from '../dal/tasks.js';
import { getUser } from '../dal/users.js';
import { listActiveSkills, recordFailure, recordSkillRun, type FailureReason } from '../evolution.js';
import { chat, type ChatMessage } from '../gemini.js';
import { normalizeLocale } from '../i18n.js';
import { getOverlay } from '../overlay.js';
import { dateKey } from '../utils.js';
import { CUSTOM_INSTRUCTIONS_SLUG } from './constants.js';
import {
  clearThread,
  loadThread,
  saveThread,
} from '../dal/agentState.js';
import {
  buildSystemPrompt,
  computeWorkloadMetrics,
  detectMode,
  evaluateExecutiveOverload,
  type AgentMode,
  type AgentProfile,
} from './prompts.js';
import {
  listTools,
  normalizeToolName,
  runTool,
  toolSummaries,
  type Tool,
  type ToolContext,
  type ToolOutcome,
} from './registry.js';
import {
  observationMeta,
  sanitizeThread,
  toChatMessages,
  toProviderMessages,
  toolCallsMeta,
  toolCallsOf,
  type ThreadToolCall,
} from './sanitize.js';
import { registerAllTools } from './tools/index.js';

// Регистрация идемпотентна (replaceTool, не registerTool).
// Без этого вызова реестр пуст и движок молча работает без инструментов.
registerAllTools();

// ---------------------------------------------------------------------------
// Контракты с внешним миром
// ---------------------------------------------------------------------------

/** Запрос к LLM: движок не знает, какой клиент под ним. */
export interface AgentChatRequest {
  /** Чей ключ тратить и в чью историю писать. */
  userId?: number;
  /** Провайдер чата; `undefined` — провайдер продукта (`config.chatProvider`). */
  provider?: ProviderId;
  /** Системный промпт прогона (собирается на каждый шаг — дата «сегодня»). */
  systemPrompt: string;
  /** История в формате чата: системного сообщения здесь нет. */
  messages: readonly ChatMessage[];
  /** Инструменты прогона для нативного function calling. */
  tools?: readonly ProviderToolSpec[];
  /** Метка в `llm_usage.purpose`. */
  purpose: 'agent';
  temperature?: number;
  maxTokens?: number;
}

/** Ответ модели: текст и, если модель попросила, нативные вызовы инструментов. */
export interface AgentChatReply {
  content: string;
  toolCalls: ProviderToolCall[];
  /** Причина остановки генерации провайдером (`'stop'`, `'length'`, `'max_tokens'`, …). */
  finishReason?: string | null;
}

/**
 * Инъекция «модели»: принимает запрос, отдаёт ответ.
 *
 * Строка — старый контракт текстового ReAct (исторические тесты и модели,
 * игнорирующие `tools`); объект — нативный function calling.
 */
export type AgentChatResult = AgentChatReply | string;

export type AgentChatFn = (request: AgentChatRequest) => Promise<AgentChatResult>;

/** Хранилище треда диалога. `null` в опциях — работа без персистентности. */
export interface AgentThreadStore {
  load(userId: number): Promise<AgentMessage[]>;
  save(userId: number, thread: readonly AgentMessage[]): Promise<void>;
  clear(userId: number): Promise<void>;
}

/** Запрос к модели по умолчанию — общий чат `lib/gemini.ts`. */
const defaultChat: AgentChatFn = async (request) => {
  const result = await chat([{ role: 'system', content: request.systemPrompt }, ...request.messages], {
    userId: request.userId,
    provider: request.provider,
    purpose: request.purpose,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
  });
  return {
    content: result.content ?? '',
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
  };
};

/** Тред в БД (`agent_state`). */
export const dbThreadStore: AgentThreadStore = {
  load: (userId) => loadThread(userId),
  async save(userId, thread) {
    await saveThread(userId, thread);
  },
  async clear(userId) {
    await clearThread(userId);
  },
};

// ---------------------------------------------------------------------------
// Результаты прогона
// ---------------------------------------------------------------------------

/** Почему цикл остановился. */
export type AgentStopReason = 'final' | 'step_limit' | 'empty_reply' | 'llm_error' | 'confirm';

/**
 * Стадия прогона для живой индикации (`handlers/progress.ts`): перед обращением
 * к модели и перед выполнением инструмента. Движок ничего не знает про Telegram,
 * поэтому наружу уходит только факт стадии и имя тулзы.
 */
export interface AgentProgressEvent {
  stage: 'model' | 'tool';
  /** Номер шага цикла (0 — первый). */
  step: number;
  /** Имя инструмента для стадии `tool`. */
  tool?: string;
}

/** Один шаг цикла: что модель подумала и что из этого вышло. */
export interface AgentStep {
  index: number;
  thought: string | null;
  action: { name: string; args: Record<string, unknown> } | null;
  observation: string | null;
  /** `false` — инструмент не найден или упал (наблюдение содержит ошибку). */
  ok: boolean;
  /** Данные результата вызова инструмента (если возвращены). */
  data?: unknown;
}

export interface AgentRunResult {
  /** Текст для пользователя (без разметки протокола). */
  reply: string;
  /** Режим, в котором шёл прогон (`auto` разворачивается в конкретный). */
  mode: AgentMode;
  steps: AgentStep[];
  stopReason: AgentStopReason;
  /** Итоговый (санитизированный) тред — то, что ушло в хранилище. */
  thread: AgentMessage[];
  /**
   * Id включённых скиллов, которые были в промпте этого прогона. Внутреннее
   * поле для замера: наружу не показывается, за прогон считается один раз.
   */
  appliedSkillIds: number[];
}

export interface RunAgentOptions {
  /** Telegram id пользователя (натуральный ключ). */
  userId: number;
  /** Реплика пользователя. */
  text: string;
  /** `'auto'` (по умолчанию) — режим определяет `detectMode`. */
  mode?: AgentMode | 'auto';
  /** Предел шагов ReAct-цикла (1…20, по умолчанию 8 — как `recursion_limit`). */
  maxSteps?: number;
  /** Инструменты прогона; по умолчанию — весь реестр. */
  tools?: readonly Tool[];
  /** Хранилище треда; `null` — без персистентности. */
  store?: AgentThreadStore | null;
  /** Клиент LLM; по умолчанию — `lib/gemini.ts`. */
  chatFn?: AgentChatFn;
  /** Профиль пользователя; по умолчанию читается из БД (`loadAgentProfile`). */
  profile?: Partial<AgentProfile> | null;
  /** Момент прогона (для промпта и контекста инструментов). */
  now?: Date;
  /**
   * Живая индикация стадий («печатает…» и строка прогресса). Хук необязателен,
   * а его ошибки проглатываются: падение индикатора не должно рвать ход.
   */
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Предел ходов LLM по умолчанию — батч тулз в одном ответе тратит 1 ход. */
export const DEFAULT_MAX_STEPS = 8;

/** Верхняя граница ходов LLM, чтобы никто не выкрутил лимит в сотни итераций. */
export const MAX_STEPS_CAP = 20;

/** Жёсткий потолок суммарных вызовов инструментов за один прогон. */
export const MAX_TOOL_CALLS_PER_RUN = 30;

/** Сколько подряд одинаковых ходов (tool+args) считаем зацикливанием. */
export const MAX_CONSECUTIVE_DUPLICATE_TURNS = 3;

const FINAL_SYNTHESIS_DIRECTIVE = `[ФИНАЛЬНЫЙ ХОД — СИНТЕЗ БЕЗ ИНСТРУМЕНТОВ]
Бюджет вызовов инструментов исчерпан. Больше не вызывай инструменты и не выводи Action / Action Input.
Дай пользователю цельный, честный и структурированный финальный ответ на основе уже собранных данных.
Если чего-то не хватило — коротко отметь в конце, что можно проверить следующим сообщением.`;

const CONTINUATION_USER_PROMPT =
  'Твой предыдущий ответ оборвался по лимиту длины. Продолжи строго с места обрыва, без приветствия и без повторения уже написанного, и заверши мысль.';

/** Слаг главы с пользовательскими директивами (upstream: `custom_instructions`). */
export { CUSTOM_INSTRUCTIONS_SLUG };

/** Ответ на пустой ответ модели. */
export const EMPTY_REPLY_TEXT = 'Не получилось сформулировать ответ. Сформулируйте вопрос иначе, и я попробую снова.';

/** Ответ при сбое модели. */
export const LLM_ERROR_TEXT = 'Не удалось получить ответ от модели. Попробуйте ещё раз через минуту.';

/**
 * `reply` — заглушка сбоя модели, а не ответ по существу.
 *
 * Нужна отправляющей стороне: заглушку нельзя ставить рядом с ответом, который
 * в том же ходе собрал детерминированный путь (сводка, задача, заметка) — см.
 * `lib/reply_turn.ts`.
 */
export function isLlmErrorReply(reply: string): boolean {
  return reply.trim() === LLM_ERROR_TEXT;
}

/** Подпись подтверждения в схеме деструктивного инструмента. */
export const CONFIRM_ARG_DESCRIPTION =
  'Явное подтверждение пользователя. Ставь true только если он прямо согласился выполнить действие.';

/** Наблюдение модели: деструктивное действие не выполнено без подтверждения. */
export function confirmationObservation(name: string): string {
  return `Требуется подтверждение пользователя: ${name}. Действие не выполнено.`;
}

/** Вопрос пользователю, когда деструктивный вызов пришёл без подтверждения. */
export function confirmationPrompt(name: string, args: Record<string, unknown>): string {
  const payload = { ...args };
  delete payload.confirm;
  const detail = Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : '';
  return `⚠️ Подтвердите действие: ${name}${detail}\n\nПока ничего не изменено. Ответьте «да» — и я выполню.`;
}

// ---------------------------------------------------------------------------
// Профиль пользователя
// ---------------------------------------------------------------------------

/**
 * Профиль для промпта: всё персональное приходит из БД, а не из кода
 * (ADR-002). `personaStyle` в схеме пользователя пока не хранится — его может
 * передать вызывающий код (`options.profile`); без него стиль не навязывается.
 */
export async function loadAgentProfile(userId: number, now: Date = new Date()): Promise<AgentProfile> {
  const [user, custom, skills] = await Promise.all([
    getUser(userId),
    getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG),
    // Скиллы — часть профиля прогона, а не отдельный источник: включаются тем
    // же чтением один раз. Сбой загрузки не должен лишать пользователя ответа.
    listActiveSkills(userId).catch(() => []),
  ]);

  const timezone = user?.timezone?.trim() || DEFAULT_TIMEZONE;
  const localDateStr = dateKey(now, timezone);

  const [todoTasks, doses] = await Promise.all([
    listTasks(userId, { status: 'todo', parentId: null, autoAdvance: false, limit: 500 }).catch(() => []),
    listDoses(userId, localDateStr).catch(() => []),
  ]);

  const { activeTodoCount, overdueTaskCount, missedMedsCount } = computeWorkloadMetrics(
    todoTasks,
    doses,
    timezone,
    now,
  );

  return {
    userName: user?.name ?? null,
    timezone,
    baseCurrency: user?.baseCurrency || DEFAULT_BASE_CURRENCY,
    locale: normalizeLocale(user?.language, getOverlay().manifest.defaultLocale),
    personaStyle: null,
    customInstructions: custom?.content ?? null,
    activeSkills: skills,
    lowStimulationMode: Boolean(user?.lowStimulationMode),
    overdueTaskCount,
    activeTodoCount,
    missedMedsCount,
  };
}

// ---------------------------------------------------------------------------
// Разбор ответа модели
// ---------------------------------------------------------------------------

export interface ParsedAgentReply {
  kind: 'final' | 'action';
  /** Чистый текст финального ответа. */
  final: string | null;
  /** Рассуждение перед действием (для логов и graceful-ответа). */
  thought: string | null;
  action: { name: string; args: Record<string, unknown> } | null;
}

const FINAL_MARKER = /final\s*answer\s*[:：]/i;
const ACTION_MARKER = /(?:^|\n)[ \t>*#-]*action[ \t]*[:：][ \t]*([^\n]+)/i;
const ACTION_INPUT_MARKER = /action[ \t]*input[ \t]*[:：][ \t]*([\s\S]*)/i;
const THOUGHT_MARKER = /thought[ \t]*[:：][ \t]*/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Снимает markdown-обёртку и висячие маркеры протокола с финального текста. */
function cleanFinal(text: string): string {
  let value = text.trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  }
  return value;
}

/** Разбор `Action Input`: JSON, JSON внутри текста либо `{ input: raw }`. */
export function parseActionArgs(raw: string | null | undefined): Record<string, unknown> {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source) return {};

  const text = cleanFinal(source);
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // пробуем следующий вариант
    }
  }
  return { input: text };
}

/** Вытаскивает рассуждение: текст до маркера действия/ответа. */
function extractThought(text: string, markerIndex: number): string | null {
  const head = text.slice(0, markerIndex === -1 ? text.length : markerIndex).trim();
  if (!head) return null;
  const thoughtMatch = THOUGHT_MARKER.exec(head);
  const body = thoughtMatch ? head.slice(thoughtMatch.index + thoughtMatch[0].length) : head;
  const cleaned = cleanFinal(body);
  return cleaned || null;
}

/**
 * Разбирает ответ модели в терминах ReAct-протокола.
 *
 * Приоритет — `Final Answer`: модель иногда дописывает рассуждение с примером
 * `Action:` выше финала, и принимать пример за вызов нельзя. Дальше — `Action`
 * + `Action Input`. JSON-объект целиком (`{"action": …, "action_input": …}`)
 * тоже принимается: некоторые модели игнорируют текстовый протокол. Всё
 * остальное считается финальным ответом — молча ронять реплику нельзя.
 */
export function parseAgentReply(reply: string | null | undefined): ParsedAgentReply {
  const text = typeof reply === 'string' ? reply.trim() : '';
  if (!text) return { kind: 'final', final: '', thought: null, action: null };

  // 1. JSON-объект вместо протокола.
  if (text.startsWith('{') && text.endsWith('}')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      const actionName =
        typeof parsed.action === 'string'
          ? parsed.action
          : typeof parsed.name === 'string'
            ? parsed.name
            : '';
      if (actionName.trim()) {
        const rawArgs = parsed.action_input ?? parsed.args ?? parsed.input;
        const args = isRecord(rawArgs) ? rawArgs : parseActionArgs(typeof rawArgs === 'string' ? rawArgs : '');
        return {
          kind: 'action',
          final: null,
          thought: typeof parsed.thought === 'string' ? cleanFinal(parsed.thought) : null,
          action: { name: actionName.trim(), args },
        };
      }
      const finalValue =
        parsed.final_answer ?? parsed.final ?? parsed.answer ?? parsed.response ?? parsed.text;
      if (typeof finalValue === 'string' && finalValue.trim()) {
        return {
          kind: 'final',
          final: cleanFinal(finalValue),
          thought: typeof parsed.thought === 'string' ? cleanFinal(parsed.thought) : null,
          action: null,
        };
      }
    }
  }

  // 2. Текстовый протокол: Final Answer важнее Action.
  const finalMatch = FINAL_MARKER.exec(text);
  if (finalMatch) {
    const markerIndex = finalMatch.index;
    const finalText = cleanFinal(text.slice(markerIndex + finalMatch[0].length));
    const before = text.slice(0, markerIndex);
    return {
      kind: 'final',
      final: finalText || cleanFinal(before),
      thought: extractThought(text, markerIndex),
      action: null,
    };
  }

  const actionMatch = ACTION_MARKER.exec(text);
  if (actionMatch) {
    const name = (actionMatch[1] ?? '').trim().replace(/^[`"']+|[`"']+$/g, '');
    const tail = text.slice(actionMatch.index + actionMatch[0].length);
    const inputMatch = ACTION_INPUT_MARKER.exec(tail);
    return {
      kind: 'action',
      final: null,
      thought: extractThought(text, actionMatch.index),
      action: { name, args: parseActionArgs(inputMatch?.[1] ?? '') },
    };
  }

  return { kind: 'final', final: cleanFinal(text), thought: null, action: null };
}

// ---------------------------------------------------------------------------
// Сериализация прогонов одного пользователя
// ---------------------------------------------------------------------------

/** Очередь прогонов по пользователю: второй запрос ждёт первый (без таймеров). */
const userLocks = new Map<number, Promise<unknown>>();

async function withUserLock<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = userLocks.get(userId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  userLocks.set(userId, guard);
  void guard.then(() => {
    if (userLocks.get(userId) === guard) userLocks.delete(userId);
  });
  return run;
}

/** Ошибка похожа на испорченную историю (upstream: `INVALID_CHAT_HISTORY`, 400)? */
export function isRecoverableHistoryError(message: string): boolean {
  const text = String(message ?? '');
  if (!text) return false;
  return /INVALID_CHAT_HISTORY|invalid[_\s-]?chat[_\s-]?history|messages?\s+(?:must|should)|tool[_\s-]?(?:call|result)|400|bad request/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

function normalizeMaxSteps(value: number | undefined): number {
  const requested = Number.isFinite(value) ? Math.floor(value as number) : DEFAULT_MAX_STEPS;
  return Math.min(MAX_STEPS_CAP, Math.max(1, requested));
}

function assertUserId(userId: number): number {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`agent.engine: invalid user_id "${String(userId)}"`);
  }
  return userId;
}

/** Ответ, когда шаги кончились: отдаём последнее наблюдение/мысль, а не ошибку. */
function stepLimitReply(steps: readonly AgentStep[]): string {
  const lastObservation = [...steps].reverse().find((step) => step.observation)?.observation;
  const lastThought = [...steps].reverse().find((step) => step.thought)?.thought;
  const detail = lastObservation
    ? `Последнее, что удалось выяснить: ${lastObservation}`
    : lastThought
      ? `Последнее рассуждение: ${lastThought}`
      : '';
  const base = `Действие оказалось слишком длинным — я остановился на лимите шагов и не довёл его до конца.`;
  return detail ? `${base}\n\n${detail}` : base;
}

/** Детерминированная каноническая сериализация JSON (устойчива к порядку ключей). */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Подпись одного хода вызовов инструментов для обнаружения зацикливания. */
function turnCallSignature(
  calls: ReadonlyArray<{ name: string; args?: Record<string, unknown> }>,
): string {
  return calls.map((call) => `${call.name}:${canonicalJson(call.args ?? {})}`).join('|');
}

/** История для финального хода синтеза без `tools`: текстовые наблюдения вместо `tool_calls`. */
function toSynthesisMessages(messages: readonly AgentMessage[]): ChatMessage[] {
  const normalized = messages.map((message) => {
    if (message.role !== 'assistant' || message.content.trim()) return message;
    const calls = toolCallsOf(message);
    if (calls.length === 0) return message;
    const summary = calls
      .map((call) => `Вызов ${call.name}(${canonicalJson(call.args ?? {})})`)
      .join('\n');
    return { ...message, content: summary };
  });
  return toChatMessages(normalized);
}

function toolObservation(
  outcome: ToolOutcome,
  name: string,
): { content: string; ok: boolean } {
  const content = typeof outcome.content === 'string' && outcome.content.trim()
    ? outcome.content.trim()
    : outcome.ok
      ? 'Готово.'
      : `Инструмент «${name}» не вернул результата.`;
  return { content, ok: outcome.ok !== false };
}

function isTruncatedFinishReason(reason: string | null | undefined): boolean {
  const normalized = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  return normalized === 'length' || normalized === 'max_tokens';
}

/** Склеивает оборванную первую часть ответа с продолжением без дублей и лишних пробелов. */
export function joinContinuation(head: string, tail: string): string {
  const left = head;
  const right = tail.trimEnd();
  if (!right) return left;
  if (!left) return right.trimStart();
  if (/^[\s.,!?;:»)"'\]—–-]/.test(right)) return `${left}${right}`;
  if (
    /[«(["'—–-]$/.test(left) ||
    (/[\p{L}\p{N}]$/u.test(left) && /^[\p{Ll}\p{N}]/u.test(right))
  ) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

/** Приводит ответ модели к `{ content, toolCalls, finishReason }`; строка — старый контракт. */
function normalizeChatReply(reply: AgentChatResult): AgentChatReply {
  if (typeof reply === 'string') return { content: reply, toolCalls: [], finishReason: null };
  return {
    content: typeof reply?.content === 'string' ? reply.content : '',
    toolCalls: Array.isArray(reply?.toolCalls) ? reply.toolCalls : [],
    finishReason: typeof reply?.finishReason === 'string' ? reply.finishReason : null,
  };
}

/** Деструктивный инструмент без явного `confirm: true` не выполняется. */
function needsConfirmation(tool: Tool | null, args: Record<string, unknown>): boolean {
  return tool?.destructive === true && args.confirm !== true;
}

/** Инструменты без побочных эффектов: смежные вызовы в одном ходе безопасны для Promise.all. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_tasks',
  'search_notes',
  'get_inbox_digest',
  'read_daily_diary',
  'triage_tasks',
  'query_spending',
  'can_i_afford',
  'get_fin_balances',
  'get_liabilities',
  'list_transactions',
  'get_medications_today',
  'get_runway_forecast',
  'view_trash',
  'consult_system_docs',
  'synthesize_life_context',
  'get_custom_directives',
]);

function isParallelSafeReadCall(call: ThreadToolCall, tools: readonly Tool[]): boolean {
  const validName = normalizeToolName(call.name);
  if (!validName || !READ_ONLY_TOOL_NAMES.has(validName)) return false;
  const target = tools.find((t) => t.name === validName) ?? null;
  if (!target || target.destructive || needsConfirmation(target, call.args ?? {})) return false;
  return true;
}

/**
 * Полный прогон агента: реплика пользователя → ответ.
 *
 * Никогда не бросает на ошибках модели (они превращаются в `stopReason`), но
 * бросает на невалидном `userId` — это ошибка программиста, а не пользователя.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const userId = assertUserId(options.userId);
  const text = typeof options.text === 'string' ? options.text.trim() : '';
  const maxSteps = normalizeMaxSteps(options.maxSteps);
  const now = options.now ?? new Date();
  const chatFn = options.chatFn ?? defaultChat;
  const store = options.store === undefined ? dbThreadStore : options.store === null ? null : options.store;

  return withUserLock(userId, async () => {
    const profile = options.profile ?? (await loadAgentProfile(userId, now));
    // Профиль заморожен на прогон: внутри цикла он не перечитывается, поэтому
    // включение скилла посреди прогона видно только следующему прогону.
    const appliedSkills = [...(profile.activeSkills ?? [])];
    const resolvedMode: AgentMode =
      options.mode && options.mode !== 'auto' ? options.mode : detectMode(text);
    const tools = options.tools ?? listTools();
    const toolSpecs: ProviderToolSpec[] = tools.map((tool) => {
      // Без схемы инструмент остаётся вызываемым: пустой объект валиден.
      const parameters = tool.schema ?? { type: 'object', properties: {} };
      if (tool.destructive !== true) {
        return { name: tool.name, description: tool.description, parameters };
      }
      // Деструктивный инструмент получает поле подтверждения в самой схеме,
      // чтобы модель видела требование, а не узнавала о нём из ошибки.
      const properties = isRecord(parameters.properties) ? parameters.properties : {};
      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            confirm: { type: 'boolean', description: CONFIRM_ARG_DESCRIPTION },
          },
        },
      };
    });
    const ctx: ToolContext = {
      userId,
      timezone: profile.timezone?.trim() || DEFAULT_TIMEZONE,
      baseCurrency: profile.baseCurrency || DEFAULT_BASE_CURRENCY,
      now,
    };

    const stored = store ? sanitizeThread(await store.load(userId)) : [];
    if (!text) {
      return {
        reply: '',
        mode: resolvedMode,
        steps: [],
        stopReason: 'empty_reply',
        thread: stored,
        appliedSkillIds: [],
      };
    }

    let working: AgentMessage[] = [...stored, { role: 'user', content: text }];
    const executiveOverload = evaluateExecutiveOverload({
      lowStimulationMode: profile.lowStimulationMode,
      timezone: profile.timezone?.trim() || DEFAULT_TIMEZONE,
      now,
      overdueTaskCount: profile.overdueTaskCount,
      activeTodoCount: profile.activeTodoCount,
      missedMedsCount: profile.missedMedsCount,
      userText: text,
    });
    const steps: AgentStep[] = [];
    let reply = '';
    let stopReason: AgentStopReason = 'step_limit';
    let healed = false;
    let iteration = 0;
    let totalToolCalls = 0;
    let lastTurnSignature: string | null = null;
    let consecutiveSameTurn = 0;
    let pendingConfirmation: { name: string; args: Record<string, unknown> } | null = null;
    /** Хвост причины отказа модели — уходит в журнал вместе с `llm_error`. */
    let llmErrorDetail: string | null = null;
    /** Неожиданные отказы инструментов: имя тулзы = часть сигнатуры. */
    const unexpectedTools = new Set<string>();

    /** Стадия прогона наружу: ошибки индикации не рвут ход. */
    const notifyProgress = async (event: AgentProgressEvent): Promise<void> => {
      if (!options.onProgress) return;
      try {
        await options.onProgress(event);
      } catch {
        // индикация — украшение, а не часть прогона
      }
    };

    const registerTurnSignature = (
      calls: ReadonlyArray<{ name: string; args?: Record<string, unknown> }>,
    ): boolean => {
      const signature = turnCallSignature(calls);
      consecutiveSameTurn = signature === lastTurnSignature ? consecutiveSameTurn + 1 : 1;
      lastTurnSignature = signature;
      return consecutiveSameTurn >= MAX_CONSECUTIVE_DUPLICATE_TURNS;
    };

    const completeIfTruncated = async (
      partialReply: string,
      finishReason: string | null | undefined,
      activeSystemPrompt: string,
    ): Promise<string> => {
      if (!isTruncatedFinishReason(finishReason) || !partialReply.trim()) return partialReply;
      try {
        const prepared = sanitizeThread([
          ...working,
          { role: 'assistant', content: partialReply },
        ]);
        await notifyProgress({ stage: 'model', step: iteration });
        const contRaw = await chatFn({
          userId,
          systemPrompt: activeSystemPrompt,
          messages: [
            ...toSynthesisMessages(prepared),
            { role: 'user', content: CONTINUATION_USER_PROMPT },
          ],
          purpose: 'agent',
        });
        const contNative = normalizeChatReply(contRaw);
        const contCalls = contNative.toolCalls.filter(
          (call) => typeof call.name === 'string' && call.name.trim(),
        );
        const contAnswer = contNative.content.trim();
        if (contCalls.length === 0 && contAnswer) {
          const contParsed = parseAgentReply(contAnswer);
          if (contParsed.kind === 'final') {
            const contText = (contParsed.final || cleanFinal(contAnswer)).trim();
            if (contText) return joinContinuation(partialReply, contText);
          }
        }
      } catch {
        // Если добор обрыва не удался — отдаём то, что уже успели получить.
      }
      return partialReply;
    };

    while (iteration < maxSteps && totalToolCalls < MAX_TOOL_CALLS_PER_RUN) {
      const prepared = sanitizeThread(working);
      const systemPrompt = buildSystemPrompt({
        locale: profile.locale,
        profile: {
          ...profile,
          lowStimulationMode: executiveOverload.lowStimulationMode,
        },
        mode: resolvedMode,
        focus: null,
        tools: toolSummaries(tools),
        maxSteps,
        now,
        executiveOverload,
      });

      await notifyProgress({ stage: 'model', step: iteration });
      let raw: AgentChatResult;
      try {
        raw = await chatFn({
          userId,
          systemPrompt,
          messages: toProviderMessages(prepared),
          tools: toolSpecs,
          purpose: 'agent',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!healed && isRecoverableHistoryError(message)) {
          healed = true;
          working = [{ role: 'user', content: text }];
          if (store) {
            try {
              await store.clear(userId);
            } catch {
              // сброс истории — вспомогательный шаг: не мешаем повтору запроса
            }
          }
          continue;
        }
        stopReason = 'llm_error';
        reply = LLM_ERROR_TEXT;
        llmErrorDetail = message;
        // Причина отказа едет в `kv`: по ней строится ответ при недоступной
        // модели (`summary.modelOutageReply`), и по ней видно, чинить ключ или
        // ждать квоту. Пишем в своём try — телеметрия не должна валить ход.
        try {
          const status = (error as { status?: number }).status ?? 0;
          const rawBody = (error as { body?: unknown }).body;
          const providerBody =
            typeof rawBody === 'string' && rawBody.trim() ? rawBody.slice(0, 500) : null;
          await kvSetJson('llm_last_failure', {
            status: Number.isFinite(status) ? status : 0,
            at: new Date().toISOString(),
            detail: message.slice(0, 200),
            providerBody,
          });
        } catch {
          // журнал отказов — вспомогательный шаг
        }
        break;
      }

      const native = normalizeChatReply(raw);
      const answer = native.content.trim();
      const nativeCalls = native.toolCalls.filter((call) => typeof call.name === 'string' && call.name.trim());
      if (!answer && nativeCalls.length === 0) {
        stopReason = 'empty_reply';
        reply = EMPTY_REPLY_TEXT;
        break;
      }

      // Нативный function calling: модель попросила инструменты — выполняем их.
      if (nativeCalls.length > 0) {
        const remainingToolCalls = Math.max(0, MAX_TOOL_CALLS_PER_RUN - totalToolCalls);
        const calls: ThreadToolCall[] = nativeCalls
          .slice(0, remainingToolCalls)
          .map((call, index) => ({
            id: call.id?.trim() || `call_${steps.length + index + 1}`,
            name: normalizeToolName(call.name) || call.name.trim(),
            args: call.args ?? {},
            ...(call.extraContent ? { extraContent: call.extraContent } : {}),
          }));

        if (registerTurnSignature(calls)) {
          break;
        }

        working.push({
          role: 'assistant',
          content: answer,
          ...(calls.length > 0 ? { meta: toolCallsMeta(calls) } : {}),
        });

        const available = tools.map((tool) => tool.name).join(', ') || '—';
        const recordOutcome = (call: ThreadToolCall, outcome: ToolOutcome): void => {
          if (outcome.unexpected === true) unexpectedTools.add(call.name);
          const observation = toolObservation(outcome, call.name);

          working.push({
            role: 'user',
            content: observation.content,
            meta: observationMeta({ id: call.id, name: call.name, ok: observation.ok }),
          });
          steps.push({
            index: steps.length,
            thought: answer || null,
            action: { name: call.name, args: call.args ?? {} },
            observation: observation.content,
            ok: observation.ok,
            data: outcome.data,
          });
          totalToolCalls += 1;
        };

        let i = 0;
        while (i < calls.length) {
          const current = calls[i]!;
          if (isParallelSafeReadCall(current, tools)) {
            const batch: ThreadToolCall[] = [];
            while (i < calls.length && isParallelSafeReadCall(calls[i]!, tools)) {
              batch.push(calls[i]!);
              i += 1;
            }
            const outcomes = await Promise.all(
              batch.map(async (c) => {
                const name = normalizeToolName(c.name)!;
                await notifyProgress({ stage: 'tool', step: iteration, tool: name });
                return runTool(name, c.args ?? {}, ctx, tools);
              }),
            );
            for (let k = 0; k < batch.length; k += 1) {
              recordOutcome(batch[k]!, outcomes[k]!);
            }
            continue;
          }

          const call = current;
          i += 1;
          const validName = normalizeToolName(call.name);
          const args = call.args ?? {};
          const target = tools.find((tool) => tool.name === validName) ?? null;

          // Гардрейл: деструктивное действие без явного «да» не выполняется —
          // прогон останавливается и спрашивает пользователя.
          if (needsConfirmation(target, args)) {
            const observation = confirmationObservation(call.name);
            working.push({
              role: 'user',
              content: observation,
              meta: observationMeta({ id: call.id, name: call.name, ok: false }),
            });
            steps.push({
              index: steps.length,
              thought: answer || null,
              action: { name: call.name, args },
              observation,
              ok: false,
            });
            totalToolCalls += 1;
            pendingConfirmation = { name: call.name, args };
            break;
          }

          const outcome: ToolOutcome = validName
            ? await (async () => {
                await notifyProgress({ stage: 'tool', step: iteration, tool: validName });
                return runTool(validName, args, ctx, tools);
              })()
            : {
                ok: false,
                unexpected: true,
                content: `Имя инструмента не распознано: «${call.name || 'пусто'}». Доступные инструменты: ${available}.`,
              };
          recordOutcome(call, outcome);
        }

        if (pendingConfirmation) {
          stopReason = 'confirm';
          reply = confirmationPrompt(pendingConfirmation.name, pendingConfirmation.args);
          working.push({ role: 'assistant', content: reply });
          break;
        }
        iteration += 1;
        continue;
      }

      const parsed = parseAgentReply(answer);
      if (parsed.kind === 'final') {
        const baseReply = parsed.final || cleanFinal(answer);
        const completed = await completeIfTruncated(baseReply, native.finishReason, systemPrompt);
        working.push({
          role: 'assistant',
          content: completed !== baseReply ? completed : answer,
        });
        steps.push({
          index: steps.length,
          thought: parsed.thought,
          action: null,
          observation: null,
          ok: true,
        });
        reply = completed;
        stopReason = 'final';
        iteration += 1;
        break;
      }

      const rawName = parsed.action?.name ?? '';
      const name = normalizeToolName(rawName);
      const args = parsed.action?.args ?? {};
      const call: ThreadToolCall = { id: `call_${steps.length + 1}`, name: name || rawName || 'unknown', args };

      if (registerTurnSignature([{ name: call.name, args }])) {
        break;
      }

      working.push({
        role: 'assistant',
        content: answer,
        meta: toolCallsMeta([call]),
      });

      const available = tools.map((tool) => tool.name).join(', ') || '—';
      const target = tools.find((tool) => tool.name === name) ?? null;
      if (needsConfirmation(target, args)) {
        const observation = confirmationObservation(call.name);
        working.push({
          role: 'user',
          content: observation,
          meta: observationMeta({ id: call.id, name: call.name, ok: false }),
        });
        steps.push({
          index: steps.length,
          thought: parsed.thought,
          action: { name: call.name, args },
          observation,
          ok: false,
        });
        totalToolCalls += 1;
        stopReason = 'confirm';
        reply = confirmationPrompt(call.name, args);
        working.push({ role: 'assistant', content: reply });
        break;
      }

      const outcome: ToolOutcome = name
        ? await (async () => {
            await notifyProgress({ stage: 'tool', step: iteration, tool: name });
            return runTool(name, args, ctx, tools);
          })()
        : {
            ok: false,
            unexpected: true,
            content: `Имя инструмента не распознано: «${rawName || 'пусто'}». Доступные инструменты: ${available}.`,
          };
      if (outcome.unexpected === true) unexpectedTools.add(call.name);
      const observation = toolObservation(outcome, call.name);

      working.push({
        role: 'user',
        content: observation.content,
        meta: observationMeta({ id: call.id, name: call.name, ok: observation.ok }),
      });
      steps.push({
        index: steps.length,
        thought: parsed.thought,
        action: { name: call.name, args },
        observation: observation.content,
        ok: observation.ok,
        data: outcome.data,
      });
      totalToolCalls += 1;
      iteration += 1;
    }

    if (stopReason === 'step_limit' && steps.length > 0) {
      try {
        const prepared = sanitizeThread(working);
        const synthesisSystemPrompt = `${buildSystemPrompt({
          locale: profile.locale,
          profile: {
            ...profile,
            lowStimulationMode: executiveOverload.lowStimulationMode,
          },
          mode: resolvedMode,
          focus: null,
          tools: toolSummaries(tools),
          maxSteps,
          now,
          executiveOverload,
        })}\n\n${FINAL_SYNTHESIS_DIRECTIVE}`;

        await notifyProgress({ stage: 'model', step: iteration });
        const synthRaw = await chatFn({
          userId,
          systemPrompt: synthesisSystemPrompt,
          messages: toSynthesisMessages(prepared),
          purpose: 'agent',
        });
        const synthNative = normalizeChatReply(synthRaw);
        const synthCalls = synthNative.toolCalls.filter(
          (call) => typeof call.name === 'string' && call.name.trim(),
        );
        const synthAnswer = synthNative.content.trim();
        if (synthCalls.length === 0 && synthAnswer) {
          const synthParsed = parseAgentReply(synthAnswer);
          if (synthParsed.kind === 'final') {
            const baseReply = (synthParsed.final || cleanFinal(synthAnswer)).trim();
            if (baseReply) {
              reply = await completeIfTruncated(
                baseReply,
                synthNative.finishReason,
                synthesisSystemPrompt,
              );
              stopReason = 'final';
              steps.push({
                index: steps.length,
                thought: synthParsed.thought,
                action: null,
                observation: null,
                ok: true,
              });
              working.push({ role: 'assistant', content: reply });
            }
          }
        }
      } catch {
        // Если синтез не ответил — безопасно откатываемся к stepLimitReply(steps).
      }
    }

    if (stopReason === 'step_limit') {
      reply = stepLimitReply(steps);
      working.push({ role: 'assistant', content: reply });
    }

    const thread = sanitizeThread(working);
    if (store) {
      try {
        await store.save(userId, thread);
      } catch {
        // сбой записи не должен отнимать у пользователя готовый ответ
      }
    }

    // Журнал повторяемости: одна сигнатура на прогон за терминальную причину и
    // по одной на неожиданный отказ инструмента. `final` и `confirm` — не сбои,
    // ожидаемые отказы инструментов сюда не попадают (см. `ToolOutcome.unexpected`).
    // Запись не бросает, поэтому результат прогона не меняется.
    const terminalReason: FailureReason | null =
      stopReason === 'llm_error'
        ? 'llm_error'
        : stopReason === 'empty_reply'
          ? 'empty_reply'
          : stopReason === 'step_limit'
            ? 'step_limit'
            : null;
    if (terminalReason) {
      await recordFailure(userId, {
        stage: 'agent',
        reason: terminalReason,
        detail: terminalReason === 'llm_error' ? llmErrorDetail : null,
      });
    }
    for (const toolName of unexpectedTools) {
      await recordFailure(userId, {
        stage: 'agent',
        reason: 'tool_error',
        tool: toolName,
      });
    }

    // Замер применения скиллов: ровно один инкремент на прогон, а не на шаг.
    // `pending`/`rejected` сюда попасть не могут — их нет в профиле.
    const appliedSkillIds = appliedSkills.map((skill) => skill.id);
    if (appliedSkills.length > 0) {
      await recordSkillRun(userId, {
        skills: appliedSkills,
        stopReason,
        steps,
      });
    }

    return { reply, mode: resolvedMode, steps, stopReason, thread, appliedSkillIds };
  });
}

// ---------------------------------------------------------------------------
// Диагностика
// ---------------------------------------------------------------------------

/** Сколько прогонов сейчас в очереди (для тестов и health-проверок). */
export function pendingAgentRuns(): number {
  return userLocks.size;
}
