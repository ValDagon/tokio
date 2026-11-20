/**
 * `src/lib/embeddings.ts` — эмбеддинги с кэшем в `kv`.
 *
 * Проверяем три вещи, которые легко сломать незаметно:
 *  - кэш реально экономит вызов модели (это его единственный смысл);
 *  - ключ кэша различает пользователей (иначе чужая квота/модель «протечёт»);
 *  - «нет эмбеддинга» — это `null`, а не исключение (upstream ведёт себя так же).
 *
 * Модель всегда мок: тесты не должны ходить в сеть.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { kvGetJson, kvSet } from '../src/lib/dal/misc';
import {
  MAX_EMBEDDING_INPUT_CHARS,
  cosineSimilarity,
  embedText,
  embeddingCacheKey,
  hashText,
  isEmbedding,
  matchesExpectedDimensions,
  normalizeEmbeddingInput,
  setEmbeddingsModel,
} from '../src/lib/embeddings';
import type { EmbeddingsModelFn } from '../src/lib/embeddings';
import { EMBEDDING_DIMENSIONS } from '../src/types';

const USER_A = 1;
const USER_B = 2;

/** Вектор нужной размерности: первая компонента — «смысл», остальное нули. */
function vectorOf(value: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = value;
  return vector;
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

afterEach(() => {
  setEmbeddingsModel(null);
});

// ---------------------------------------------------------------------------
// Чистые утилиты
// ---------------------------------------------------------------------------

describe('нормализация входа и хэш', () => {
  it('тримит текст и обрезает по лимиту модели', () => {
    expect(normalizeEmbeddingInput('  привет  ')).toBe('привет');
    expect(normalizeEmbeddingInput('')).toBe('');

    const long = 'а'.repeat(MAX_EMBEDDING_INPUT_CHARS + 500);
    expect(normalizeEmbeddingInput(long)).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);
  });

  it('хэш стабилен, игнорирует trim и различает разные тексты', () => {
    expect(hashText('текст')).toBe(hashText('  текст '));
    expect(hashText('текст')).not.toBe(hashText('другой текст'));
    expect(hashText('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ключ кэша содержит юзера, хэш и длину', () => {
    const key = embeddingCacheKey(USER_A, 'текст');
    expect(key).toMatch(/^embedding:v1:1:[0-9a-f]{16}:5$/);
    expect(embeddingCacheKey(USER_A, 'текст')).toBe(key);
    expect(embeddingCacheKey(USER_B, 'текст')).not.toBe(key);
    expect(embeddingCacheKey(USER_A, 'другой')).not.toBe(key);
  });

  it('isEmbedding отбраковывает мусор', () => {
    expect(isEmbedding([1, 2, 3])).toBe(true);
    expect(isEmbedding([])).toBe(false);
    expect(isEmbedding([1, Number.NaN])).toBe(false);
    expect(isEmbedding([1, '2'])).toBe(false);
    expect(isEmbedding(null)).toBe(false);
    expect(isEmbedding({ length: 1 })).toBe(false);
  });

  it('cosineSimilarity считает близость и не падает на вырожденных входах', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([1, 0], [1, 0, 5])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('matchesExpectedDimensions сверяется с EMBEDDING_DIMENSIONS из схемы', () => {
    expect(matchesExpectedDimensions(vectorOf(1))).toBe(true);
    expect(matchesExpectedDimensions([1, 2, 3])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// embedText — кэш и отказы
// ---------------------------------------------------------------------------

describe('embedText', () => {
  it('зовёт модель один раз и отдаёт вектор из кэша', async () => {
    const model = vi.fn<EmbeddingsModelFn>(async () => vectorOf(0.5));
    setEmbeddingsModel(model);

    const first = await embedText(USER_A, 'купить молоко');
    const second = await embedText(USER_A, 'купить молоко');

    expect(first).toEqual(vectorOf(0.5));
    expect(second).toEqual(vectorOf(0.5));
    expect(model).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledWith('купить молоко');
  });

  it('кэширует trim-варианты как один и тот же текст', async () => {
    const model = vi.fn<EmbeddingsModelFn>(async () => vectorOf(1));
    setEmbeddingsModel(model);

    await embedText(USER_A, 'идея');
    await embedText(USER_A, '   идея  ');

    expect(model).toHaveBeenCalledTimes(1);
  });

  it('держит отдельные записи для разных пользователей и текстов', async () => {
    const model = vi.fn<EmbeddingsModelFn>(async () => vectorOf(1));
    setEmbeddingsModel(model);

    await embedText(USER_A, 'текст');
    await embedText(USER_B, 'текст');
    await embedText(USER_A, 'другой текст');

    expect(model).toHaveBeenCalledTimes(3);
  });

  it('кладёт вектор в kv под ключом кэша', async () => {
    setEmbeddingsModel(async () => vectorOf(0.25));
    await embedText(USER_A, 'проверка кэша');

    const cached = await kvGetJson<number[] | null>(embeddingCacheKey(USER_A, 'проверка кэша'), null);
    expect(cached).toEqual(vectorOf(0.25));
  });

  it('useCache:false пересчитывает и перезаписывает кэш', async () => {
    const model = vi
      .fn<EmbeddingsModelFn>()
      .mockResolvedValueOnce(vectorOf(1))
      .mockResolvedValueOnce(vectorOf(2));
    setEmbeddingsModel(model);

    expect((await embedText(USER_A, 'текст'))?.[0]).toBe(1);
    expect((await embedText(USER_A, 'текст', { useCache: false }))?.[0]).toBe(2);
    expect(model).toHaveBeenCalledTimes(2);

    // Пересчитанное значение уже лежит в кэше и отдаётся обычным путём.
    expect((await embedText(USER_A, 'текст'))?.[0]).toBe(2);
  });

  it('битый кэш считается промахом', async () => {
    await kvSet(embeddingCacheKey(USER_A, 'текст'), '{"not":"a vector"}');

    const model = vi.fn<EmbeddingsModelFn>(async () => vectorOf(7));
    setEmbeddingsModel(model);

    expect((await embedText(USER_A, 'текст'))?.[0]).toBe(7);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('пустой текст → null без вызова модели', async () => {
    const model = vi.fn<EmbeddingsModelFn>(async () => vectorOf(1));
    setEmbeddingsModel(model);

    expect(await embedText(USER_A, '')).toBeNull();
    expect(await embedText(USER_A, '   \n\t ')).toBeNull();
    expect(model).not.toHaveBeenCalled();
  });

  it('без модели → null (кэш всё равно читается)', async () => {
    expect(await embedText(USER_A, 'текст')).toBeNull();

    await kvSet(embeddingCacheKey(USER_A, 'текст'), JSON.stringify(vectorOf(3)));
    expect(await embedText(USER_A, 'текст')).toEqual(vectorOf(3));
  });

  it('исключение и мусор от модели → null', async () => {
    setEmbeddingsModel(async () => {
      throw new Error('quota exceeded');
    });
    expect(await embedText(USER_A, 'текст')).toBeNull();

    setEmbeddingsModel(async () => [] as number[]);
    expect(await embedText(USER_A, 'текст')).toBeNull();

    setEmbeddingsModel(async () => null);
    expect(await embedText(USER_A, 'текст')).toBeNull();
  });

  it('отказ валидирует userId', async () => {
    await expect(embedText(Number.NaN, 'текст')).rejects.toThrow(/userId is required/);
  });
});
