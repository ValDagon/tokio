/**
 * Эмбеддинги текста — порт `backend/app/services/embeddings.py`.
 *
 * Модель (Gemini `text-embedding-004`, 768 измерений) инжектится снаружи:
 * HTTP-часть и ключи живут в `lib/gemini.ts` (T6), а здесь — кэш, обрезка
 * входа и косинусная близость.
 *
 * Кэш:
 *  - лежит в глобальной таблице `kv` (у неё нет `user_id`), поэтому владелец
 *    зашит в ключ: у каждого пользователя может быть свой ключ и своя квота,
 *    а значит и свой вектор на тот же текст;
 *  - ключ = префикс версии + `user_id` + хэш нормализованного текста, так что
 *    повторный вызов не тратит ни токены, ни квоту;
 *  - битый/чужой кэш (не массив чисел) считается промахом и перезаписывается.
 *
 * `cosineSimilarity` сознательно продублирован: в `dal/notes.ts` он приватный,
 * а тянуть зависимость от DAL в сервис — лишняя связность.
 */

import { EMBEDDING_DIMENSIONS } from './types.js';
import { kvGetJson, kvSetJson } from './dal/misc.js';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Модель эмбеддингов по умолчанию (как в upstream). */
export const EMBEDDING_MODEL = 'text-embedding-004';

/** Сколько символов входа отдаём модели — больше она всё равно не берёт. */
export const MAX_EMBEDDING_INPUT_CHARS = 8000;

/** Версия в ключе кэша: смена модели/формата делает старые векторы невалидными. */
const CACHE_KEY_PREFIX = 'embedding:v1';

// ---------------------------------------------------------------------------
// Инъекция модели
// ---------------------------------------------------------------------------

/**
 * Функция-модель: принимает подготовленный текст, отдаёт вектор.
 * `null` и исключение трактуются как «эмбеддинга нет».
 */
export type EmbeddingsModelFn = (text: string) => Promise<number[] | null>;

let modelFn: EmbeddingsModelFn | null = null;

/** Подключить модель эмбеддингов. `null` — отключить (останется только кэш). */
export function setEmbeddingsModel(fn: EmbeddingsModelFn | null): void {
  modelFn = fn;
}

/** Подключена ли модель (тесты/диагностика). */
export function hasEmbeddingsModel(): boolean {
  return modelFn !== null;
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** Обрезка и trim входа — единственная нормализация, которую видит модель. */
export function normalizeEmbeddingInput(text: string): string {
  return String(text ?? '')
    .trim()
    .slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/** Вектор нужной формы? (непустой массив конечных чисел) */
export function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

/**
 * FNV-1a 32 бита. Два прохода с разными seed'ами дают 64 бита — этого хватает,
 * чтобы коллизия кэша была событием, а не закономерностью. `crypto.subtle`
 * не используем: в isolate он асинхронный и не везде есть.
 */
function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Стабильный хэш нормализованного текста (`16` hex-символов). */
export function hashText(text: string): string {
  const normalized = normalizeEmbeddingInput(text);
  return `${fnv1a(normalized, 0x811c9dc5)}${fnv1a(normalized, 0x9e3779b9)}`;
}

/** Ключ кэша: юзер + хэш текста (длина — страховка от совпадения хэшей). */
export function embeddingCacheKey(userId: number, text: string): string {
  const normalized = normalizeEmbeddingInput(text);
  return `${CACHE_KEY_PREFIX}:${Math.trunc(userId)}:${hashText(normalized)}:${normalized.length}`;
}

// ---------------------------------------------------------------------------
// Близость
// ---------------------------------------------------------------------------

/**
 * Косинусная близость в диапазоне [-1, 1]. Разная размерность или нулевой
 * вектор → `0` (вместо NaN/исключения): такие пары просто не считаются похожими.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Основной вход
// ---------------------------------------------------------------------------

export interface EmbedTextOptions {
  /** `false` — игнорировать кэш (пересчитать и перезаписать). По умолчанию `true`. */
  useCache?: boolean;
}

/**
 * Вектор текста с кэшем в `kv`.
 *
 * Возвращает `null`, если текст пустой, модель не подключена или не смогла
 * посчитать вектор (как upstream: «нет эмбеддинга» — не ошибка, а факт).
 */
export async function embedText(
  userId: number,
  text: string,
  options: EmbedTextOptions = {},
): Promise<number[] | null> {
  const numericUserId = Math.trunc(Number(userId));
  if (!Number.isFinite(numericUserId)) {
    throw new Error('embeddings.embedText: userId is required');
  }

  const input = normalizeEmbeddingInput(text);
  if (!input) return null;

  const useCache = options.useCache !== false;
  const cacheKey = embeddingCacheKey(numericUserId, input);

  if (useCache) {
    const cached = await kvGetJson<unknown>(cacheKey, null);
    if (isEmbedding(cached)) return cached;
  }

  const model = modelFn;
  if (!model) return null;

  let vector: number[] | null;
  try {
    vector = await model(input);
  } catch {
    return null;
  }
  if (!isEmbedding(vector)) return null;

  await kvSetJson(cacheKey, vector);
  return vector;
}

/**
 * Есть ли модель нужной размерности (диагностика деплоя: `EMBEDDING_DIMENSIONS`
 * зашита в схему `notes.embedding`, менять её нельзя без миграции).
 */
export function matchesExpectedDimensions(vector: readonly number[]): boolean {
  return vector.length === EMBEDDING_DIMENSIONS;
}
