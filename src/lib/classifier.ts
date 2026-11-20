/**
 * Классификатор входящих сообщений (инбокс) — порт
 * `backend/app/services/gemini.py::normalize_inbox_message`.
 *
 * Что здесь важно и почему именно так:
 *  - модель НЕ вызывается напрямую: наружу торчит `setClassifierChat()`, и весь
 *    HTTP/fallback-цепочку моделей делает `lib/gemini.ts` (T6). Классификатор
 *    остаётся чистым и тестируется моком — без сети и без ключей;
 *  - ответ модели приходит «грязным»: markdown-фенсы, пояснения вокруг JSON,
 *    обрезанный хвост. `parseClassifierJson()` переживает всё это, а на полный
 *    провал отдаётся fallback из Python (категория `thought`, сырой текст);
 *  - поля нормализуются по правилам Python: неизвестная категория → `thought`,
 *    не-массив тегов → `["inbox"]`, пустой `clean_text` → исходный текст.
 *
 * Формат ответа (JSON-режим, temperature 0.1) — ровно как в upstream:
 * `{category, clean_title, clean_text, tags, actionable, extracted_meta}`.
 */

import type { LocaleCode } from './i18n.js';
import { getOverlay, getOverlayPrompt } from './overlay.js';
import { truncate } from './utils.js';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Допустимые категории инбокса (совпадают с upstream). */
export const INBOX_CATEGORIES = ['idea', 'expense', 'task', 'medical', 'thought'] as const;

export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

/** Валюты, которые просит модель для трат; прочие коды сохраняются как есть. */
export const INBOX_CURRENCIES = ['EUR', 'RUB', 'USD'] as const;

export type InboxCurrency = (typeof INBOX_CURRENCIES)[number];

/**
 * Дополнительные поля, вытащенные из сообщения. Ключи оставлены в snake_case,
 * потому что объект целиком уезжает в `notes.metadata` и читается кодом,
 * который ждёт python-совместимую форму (`extracted_meta.amount` и т.д.).
 */
export interface ExtractedMeta {
  amount?: number | null;
  currency?: string | null;
  due_date?: string | null;
  [key: string]: unknown;
}

/** Результат нормализации сообщения. */
export interface NormalizedInboxMessage {
  category: InboxCategory;
  cleanTitle: string;
  cleanText: string;
  tags: string[];
  actionable: boolean;
  extractedMeta: ExtractedMeta;
}

/** Запрос к LLM: классификатор не знает, какой клиент под ним (T6). */
export interface ClassifierRequest {
  /** Чей ключ тратить (BYOK/квоты) — прокидывается клиенту как есть. */
  userId?: number;
  systemPrompt: string;
  userPrompt: string;
  responseFormat: 'json_object';
  temperature: number;
  maxTokens: number;
  /** Назначение вызова для `llm_usage` (как в upstream). */
  purpose: 'inbox_normalization';
}

/**
 * Инъекция «чата»: принимает запрос, отдаёт содержимое ответа модели.
 * Бросать исключение разрешено — классификатор откатится на fallback.
 */
export type ClassifierChatFn = (request: ClassifierRequest) => Promise<string>;

export interface NormalizeInboxOptions {
  userId?: number;
  /** Язык промпта классификатора. */
  locale?: LocaleCode;
  /** Дополнительный контекст (например, предыдущее сообщение в диалоге). */
  context?: string;
}

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Максимум для `clean_title` — как в промпте upstream. */
export const MAX_TITLE_LENGTH = 60;

/** Заголовок, если текст пустой или модель ничего не вернула. */
export const FALLBACK_TITLE = 'Заметка';

/** Длина сырого текста, из которого берётся fallback-заголовок (как в Python). */
const FALLBACK_TITLE_SOURCE_LENGTH = 80;

const CLASSIFIER_TEMPERATURE = 0.1;
const CLASSIFIER_MAX_TOKENS = 4096;

/** Строит системную инструкцию классификатора из оверлея для заданной локали. */
export function buildClassifierSystemPrompt(locale: LocaleCode = 'ru'): string {
  const currencies = getOverlay()
    .manifest.defaults.inboxCurrencies.map((c) => `"${c}"`)
    .join('|');
  return getOverlayPrompt(locale, 'classifier', { currencies });
}

export const CLASSIFIER_SYSTEM_PROMPT = buildClassifierSystemPrompt('ru');

// ---------------------------------------------------------------------------
// Инъекция модели
// ---------------------------------------------------------------------------

let chatFn: ClassifierChatFn | null = null;

/** Подключить клиент LLM. `null` — вернуть поведение «модели нет» (только fallback). */
export function setClassifierChat(fn: ClassifierChatFn | null): void {
  chatFn = fn;
}

/** Подключён ли клиент (для тестов и диагностики). */
export function hasClassifierChat(): boolean {
  return chatFn !== null;
}

// ---------------------------------------------------------------------------
// Промпты
// ---------------------------------------------------------------------------

/** Пользовательская часть промпта; `context` добавляет префикс, как в Python. */
export function buildClassifierUserPrompt(rawText: string, context = ''): string {
  const text = `Входящее сообщение: «${rawText}»`;
  const trimmedContext = String(context ?? '').trim();
  return trimmedContext ? `Контекст: ${trimmedContext}\n${text}` : text;
}

// ---------------------------------------------------------------------------
// Разбор ответа модели
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInboxCategory(value: unknown): value is InboxCategory {
  return typeof value === 'string' && (INBOX_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Достаёт JSON-объект из ответа модели.
 *
 * Понимает: чистый JSON, JSON в markdown-фенсе (```json ... ```), JSON с
 * пояснениями до/после. Возвращает `null`, если объекта нет ни в одном варианте.
 */
export function parseClassifierJson(content: string): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;

  let text = content.trim();
  if (!text) return null;

  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // пробуем следующий вариант
    }
  }
  return null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Заголовок: чистим пробелы и режем до 60 символов (промпт просит столько же). */
function normalizeTitle(value: unknown): string {
  return truncate(asTrimmedString(value), MAX_TITLE_LENGTH);
}

/** Сумма: число либо числовая строка (`1 234,56 €`), иначе `null`. */
function normalizeAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[\s\u00A0\u202F']/g, '').replace(/[^\d.,+\-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;

  // «1.234,56» → десятичная запятая; «1,234.56» → десятичная точка
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned.replace(/,/g, '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Валюта: трёхбуквенный код в верхнем регистре, иначе `null`. */
function normalizeCurrency(value: unknown): string | null {
  const code = asTrimmedString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** `extracted_meta` → типизированный объект; лишние ключи сохраняются как есть. */
function normalizeExtractedMeta(value: unknown): ExtractedMeta {
  if (!isRecord(value)) return {};
  return {
    ...value,
    amount: normalizeAmount(value.amount),
    currency: normalizeCurrency(value.currency),
    due_date: asTrimmedString(value.due_date) || null,
  };
}

/** Теги: массив → строки без пустых; всё остальное → `["inbox"]` (как в Python). */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return ['inbox'];
  return value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : String(tag ?? '').trim()))
    .filter((tag) => tag.length > 0);
}

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

/**
 * Fallback: модель недоступна, ответила мусором или промолчала.
 * Повторяет поведение Python один в один (только заголовок ужат до 60).
 */
export function buildInboxFallback(rawText: string): NormalizedInboxMessage {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  const titleSource = trimmed.slice(0, FALLBACK_TITLE_SOURCE_LENGTH).trim();
  return {
    category: 'thought',
    cleanTitle: normalizeTitle(titleSource) || FALLBACK_TITLE,
    cleanText: trimmed,
    tags: ['raw'],
    actionable: false,
    extractedMeta: {},
  };
}

/**
 * Приводит разобранный ответ модели к доменной форме. Все странности
 * (неизвестная категория, пустые строки, теги-не-массив) гасятся здесь.
 */
export function normalizeClassifierPayload(
  payload: unknown,
  rawText: string,
): NormalizedInboxMessage {
  const fallback = buildInboxFallback(rawText);
  if (!isRecord(payload)) return fallback;

  const rawCategory = asTrimmedString(payload.category).toLowerCase();
  const category = isInboxCategory(rawCategory) ? rawCategory : 'thought';

  const cleanText = asTrimmedString(payload.clean_text);

  return {
    category,
    cleanTitle: normalizeTitle(payload.clean_title) || fallback.cleanTitle,
    cleanText: cleanText || fallback.cleanText,
    tags: normalizeTags(payload.tags),
    actionable: payload.actionable === true,
    extractedMeta: normalizeExtractedMeta(payload.extracted_meta),
  };
}

/**
 * Нормализует входящее сообщение: один вызов модели в JSON-режиме + разбор.
 * Никогда не бросает — на любой сбой отдаёт fallback, чтобы сообщение не терялось.
 */
export async function normalizeInboxMessage(
  rawText: string,
  options: NormalizeInboxOptions = {},
): Promise<NormalizedInboxMessage> {
  const text = typeof rawText === 'string' ? rawText : '';
  const fallback = buildInboxFallback(text);

  if (!text.trim()) return fallback;
  const chat = chatFn;
  if (!chat) return fallback;

  try {
    const locale = options.locale ?? getOverlay().manifest.defaultLocale;
    const content = await chat({
      userId: options.userId,
      systemPrompt: buildClassifierSystemPrompt(locale),
      userPrompt: buildClassifierUserPrompt(text, options.context ?? ''),
      responseFormat: 'json_object',
      temperature: CLASSIFIER_TEMPERATURE,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      purpose: 'inbox_normalization',
    });
    const payload = parseClassifierJson(content);
    return normalizeClassifierPayload(payload, text);
  } catch {
    return fallback;
  }
}
