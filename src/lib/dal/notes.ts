/**
 * DAL: заметки (`notes`) — инбокс, канбан-колонки, эмбеддинги, корзина.
 *
 * Паритет с upstream:
 *  - `backend/app/services/notes.py` — создание/правка/выборка заметок;
 *  - `backend/app/services/trash.py` — soft delete (`deleted_at`) и восстановление.
 *
 * Отличия TS-порта, зафиксированные здесь осознанно:
 *  - `createNote` НЕ создаёт пользователя: на платформе нет внешних ключей,
 *    а `users` ведёт свой DAL (в Python `create_user_note` делал
 *    `INSERT INTO users … ON CONFLICT DO NOTHING` просто ради FK);
 *  - дефолтная колонка новой заметки — `'raw'` (источник правды — `src/db/tables.ts`),
 *    а не `'inbox'`, как было в Python: набор допустимых значений задаёт `NoteColumn`;
 *  - у `notes` НЕТ колонки `updated_at` (в Python она была): правка заметки не
 *    обновляет никакой «updated»-таймштамп — обновляем только изменённые поля.
 *
 * Кодирование значений — руками (SDK/мок не декодируют строки при чтении):
 *  - `embedding` и `metadata` — TEXT с JSON внутри: `JSON.stringify` на запись,
 *    `JSON.parse` на чтение (битый json → `null` / `{}`);
 *  - даты — только ISO-строки (`nowIso()`), никаких объектов `Date` в параметрах;
 *  - `undefined` в параметры не попадает — только явный `null`.
 *
 * `"column"` — ключевое слово SQL, поэтому колонка всегда в двойных кавычках.
 */

import { db, sql } from 'sdk/db';
import type { NoteColumn, NoteMetadata, NoteRow, NoteSourceType } from '../../types.js';
import { EMBEDDING_DIMENSIONS } from '../types.js';
import { nowIso } from '../utils.js';

const DEFAULT_COLUMN: NoteColumn = 'raw';
const DEFAULT_SOURCE_TYPE: NoteSourceType = 'text';
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_NEAREST_LIMIT = 5;

// ---------------------------------------------------------------------------
// Строка БД → доменная модель
// ---------------------------------------------------------------------------

/** Сырая строка `notes` (snake_case, как лежит в SQLite). */
interface NoteDbRow {
  id: number;
  user_id: number;
  raw_text: string;
  clean_text: string | null;
  /** `"column"` в SQL — ключевое слово, в JS-объекте имя обычное. */
  column: string;
  embedding: string | null;
  merged_into: number | null;
  source_message_id: number | null;
  source_type: string;
  file_id: string | null;
  metadata: string | null;
  deleted_at: string | null;
  processed_at: string | null;
  created_at: string | null;
}

/** json-колонка `embedding` → массив чисел; битый json или не массив → `null`. */
function parseEmbedding(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((value) => Number(value));
  } catch {
    return null;
  }
}

/** json-колонка `metadata` → объект; битый json / не объект → `{}`. */
function parseMetadata(raw: unknown): NoteMetadata {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as NoteMetadata;
  } catch {
    return {};
  }
}

function mapNote(row: NoteDbRow): NoteRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    rawText: row.raw_text,
    cleanText: row.clean_text ?? null,
    column: row.column as NoteColumn,
    embedding: parseEmbedding(row.embedding),
    mergedInto: row.merged_into === null ? null : Number(row.merged_into),
    sourceMessageId: row.source_message_id === null ? null : Number(row.source_message_id),
    sourceType: row.source_type as NoteSourceType,
    fileId: row.file_id ?? null,
    metadata: parseMetadata(row.metadata),
    deletedAt: row.deleted_at ?? null,
    processedAt: row.processed_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Создание и чтение
// ---------------------------------------------------------------------------

export interface NoteCreateInput {
  column?: NoteColumn;
  sourceMessageId?: number | null;
  sourceType?: NoteSourceType;
  fileId?: string | null;
  metadata?: NoteMetadata;
  embedding?: number[] | null;
}

/**
 * Новая заметка. `raw_text` — обрезанный по краям пользовательский текст,
 * `clean_text` — всегда `NULL` (его заполняет классификатор/агент позже).
 */
export async function createNote(
  userId: number,
  text: string,
  opts: NoteCreateInput = {},
): Promise<NoteRow> {
  const embedding = opts.embedding ?? null;
  const result = await db.run(sql`
    INSERT INTO notes (
      user_id, raw_text, clean_text, "column", embedding, merged_into,
      source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
    ) VALUES (
      ${userId},
      ${String(text).trim()},
      ${null},
      ${opts.column ?? DEFAULT_COLUMN},
      ${embedding === null ? null : JSON.stringify(embedding)},
      ${null},
      ${opts.sourceMessageId ?? null},
      ${opts.sourceType ?? DEFAULT_SOURCE_TYPE},
      ${opts.fileId ?? null},
      ${JSON.stringify(opts.metadata ?? {})},
      ${null},
      ${null},
      ${nowIso()}
    )
    RETURNING id, user_id, raw_text, clean_text, "column", embedding, merged_into,
      source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
  `);

  const row = result.rows[0] as unknown as NoteDbRow | undefined;
  if (!row) throw new Error('notes.createNote: insert returned no row');
  return mapNote(row);
}

/** Заметка пользователя. Удалённые по умолчанию невидимы (`includeDeleted`). */
export async function getNote(
  userId: number,
  noteId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<NoteRow | null> {
  const row = opts.includeDeleted === true
    ? await db.get<NoteDbRow>(sql`
        SELECT id, user_id, raw_text, clean_text, "column", embedding, merged_into,
          source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
        FROM notes
        WHERE id = ${noteId} AND user_id = ${userId}
        LIMIT 1
      `)
    : await db.get<NoteDbRow>(sql`
        SELECT id, user_id, raw_text, clean_text, "column", embedding, merged_into,
          source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
        FROM notes
        WHERE id = ${noteId} AND user_id = ${userId} AND deleted_at IS NULL
        LIMIT 1
      `);
  return row ? mapNote(row) : null;
}

export interface NoteListOptions {
  column?: NoteColumn;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

/** Заметки пользователя, новые сверху. Изоляция по `user_id` — в каждом запросе. */
export async function listNotes(userId: number, opts: NoteListOptions = {}): Promise<NoteRow[]> {
  const limit = Math.max(0, Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  if (limit === 0) return [];

  const columnFilter = opts.column === undefined ? sql`` : sql` AND "column" = ${opts.column}`;
  const deletedFilter = opts.includeDeleted === true ? sql`` : sql` AND deleted_at IS NULL`;

  const rows = await db.all<NoteDbRow>(sql`
    SELECT id, user_id, raw_text, clean_text, "column", embedding, merged_into,
      source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
    FROM notes
    WHERE user_id = ${userId}${columnFilter}${deletedFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map(mapNote);
}

// ---------------------------------------------------------------------------
// Правка
// ---------------------------------------------------------------------------

/**
 * Пользовательски изменяемые поля: текст, колонка и json-метаданные.
 *
 * `metadata` патчится целиком (read-merge-write на стороне вызывающего): так
 * аварийная заметка голоса обновляет причину и номер попытки, не пересоздаваясь
 * (MU-1). `file_id` и `source_message_id` неизменяемы — это исходное входящее.
 */
export interface NotePatch {
  rawText?: string | null;
  cleanText?: string | null;
  column?: NoteColumn;
  metadata?: NoteMetadata;
}

/**
 * Частичная правка (read-merge-write).
 *
 * Динамический SET не поддерживается (`sql.join` на платформе нет), поэтому
 * читаем текущую строку, смёрживаем присутствующие ключи и пишем поля
 * одним UPDATE. Пустой патч не делает UPDATE вовсе — возвращаем как есть.
 * `updated_at` не трогаем: такой колонки в `notes` нет.
 */
export async function updateNote(
  userId: number,
  noteId: number,
  patch: NotePatch,
): Promise<NoteRow | null> {
  const current = await getNote(userId, noteId);
  if (!current) return null;

  const hasRawText = Object.hasOwn(patch, 'rawText');
  const hasCleanText = Object.hasOwn(patch, 'cleanText');
  const hasColumn = Object.hasOwn(patch, 'column');
  const hasMetadata = Object.hasOwn(patch, 'metadata');
  if (!hasRawText && !hasCleanText && !hasColumn && !hasMetadata) return current;

  // явный null — очистка поля; undefined в патче — «не менять»
  const nextRawText = hasRawText ? (patch.rawText ?? current.rawText) : current.rawText;
  const nextCleanText = hasCleanText ? (patch.cleanText ?? null) : current.cleanText;
  const nextColumn = hasColumn ? (patch.column ?? current.column) : current.column;

  // json-колонку трогаем только по явному патчу: правка текста не должна
  // переписывать сырые байты `metadata` (битый json нормализовался бы в `{}`).
  // `CASE` вместо второго UPDATE — одна атомарная запись, `sql.join` недоступен.
  const writeMetadata = hasMetadata ? 1 : 0;
  const nextMetadata = JSON.stringify(patch.metadata ?? {});

  await db.run(sql`
    UPDATE notes
    SET raw_text = ${nextRawText}, clean_text = ${nextCleanText}, "column" = ${nextColumn},
      metadata = CASE WHEN ${writeMetadata} = 1 THEN ${nextMetadata} ELSE metadata END
    WHERE id = ${noteId} AND user_id = ${userId} AND deleted_at IS NULL
  `);
  return getNote(userId, noteId);
}

// ---------------------------------------------------------------------------
// Корзина (soft delete / restore)
// ---------------------------------------------------------------------------

/**
 * Мягкое удаление: проставляем `deleted_at`, колонку НЕ меняем
 * (`trash` — только UI-значение). `true`, если заметка реально была активной.
 */
export async function deleteNote(userId: number, noteId: number): Promise<boolean> {
  const result = await db.run(sql`
    UPDATE notes SET deleted_at = ${nowIso()}
    WHERE id = ${noteId} AND user_id = ${userId} AND deleted_at IS NULL
  `);
  return result.rowsAffected > 0;
}

/** Восстановление из корзины; `null`, если восстанавливать было нечего. */
export async function restoreNote(userId: number, noteId: number): Promise<NoteRow | null> {
  const result = await db.run(sql`
    UPDATE notes SET deleted_at = NULL
    WHERE id = ${noteId} AND user_id = ${userId} AND deleted_at IS NOT NULL
  `);
  if (result.rowsAffected === 0) return null;
  return getNote(userId, noteId, { includeDeleted: true });
}

// ---------------------------------------------------------------------------
// Кэш векторов эмбеддингов (Float32Array) и косинусная похожесть
// ---------------------------------------------------------------------------

const embeddingVecCache = new Map<number, { raw: string; vec: Float32Array }>();
const MAX_VEC_CACHE = 5000;

/**
 * Возвращает кэшированный `Float32Array` для строки заметки, перепарсивая
 * при первом обращении или при изменении сырой JSON-строки `embedding`.
 */
export function getNoteFloat32Vector(
  row: Pick<NoteDbRow, 'id' | 'embedding'>,
): Float32Array | null {
  if (!row.embedding) {
    embeddingVecCache.delete(row.id);
    return null;
  }

  const cached = embeddingVecCache.get(row.id);
  if (cached && cached.raw === row.embedding) {
    return cached.vec;
  }

  const parsed = parseEmbedding(row.embedding);
  if (!parsed || parsed.length !== EMBEDDING_DIMENSIONS) {
    embeddingVecCache.delete(row.id);
    return null;
  }

  const vec = new Float32Array(parsed);
  if (!embeddingVecCache.has(row.id) && embeddingVecCache.size >= MAX_VEC_CACHE) {
    const oldestKey = embeddingVecCache.keys().next().value;
    if (oldestKey !== undefined) {
      embeddingVecCache.delete(oldestKey);
    }
  }
  embeddingVecCache.set(row.id, { raw: row.embedding, vec });
  return vec;
}

/** Косинусная похожесть поверх `Float32Array`; нулевая/невалидная норма → 0. */
export function cosineSimilarityFloat32(a: ArrayLike<number>, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  if (!Number.isFinite(dot) || !Number.isFinite(normA) || !Number.isFinite(normB)) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Ближайшие заметки пользователя по косинусной похожести.
 *
 * pgvector на платформе нет, поэтому считаем в JS: тянем все активные заметки
 * с эмбеддингом и сортируем. Заметки с битым json или размерностью
 * ≠ `EMBEDDING_DIMENSIONS` молча пропускаются.
 */
export async function findNearestNotes(
  userId: number,
  embedding: number[],
  opts: { limit?: number } = {},
): Promise<NoteRow[]> {
  const limit = Math.max(0, Math.trunc(opts.limit ?? DEFAULT_NEAREST_LIMIT));
  if (limit === 0) return [];
  if (embedding.length !== EMBEDDING_DIMENSIONS) return [];

  const rows = await db.all<NoteDbRow>(sql`
    SELECT id, user_id, raw_text, clean_text, "column", embedding, merged_into,
      source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
    FROM notes
    WHERE user_id = ${userId} AND deleted_at IS NULL AND embedding IS NOT NULL
  `);

  const scored: Array<{ row: NoteDbRow; score: number }> = [];
  for (const row of rows) {
    const vec = getNoteFloat32Vector(row);
    if (!vec) continue;
    scored.push({ row, score: cosineSimilarityFloat32(embedding, vec) });
  }

  scored.sort((a, b) => (b.score - a.score) || (a.row.id - b.row.id));
  return scored.slice(0, limit).map((item) => mapNote(item.row));
}

// ---------------------------------------------------------------------------
// Гибридный поиск (BM25 + косинусный вектор + Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

export interface HybridNoteSearchOptions {
  query: string;
  embedding?: number[] | null;
  limit?: number;
  column?: NoteColumn;
}

interface QueryToken {
  token: string;
  weight: number;
}

interface DocumentTokens {
  tf: Map<string, number>;
  docLen: number;
}

interface RankedNoteScore {
  row: NoteDbRow;
  score: number;
}

interface Bm25Result {
  scores: Map<number, number>;
  ranked: RankedNoteScore[];
  queryTokens: QueryToken[];
}

function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function normalizeNumericToken(raw: string): string {
  if (raw.startsWith('*')) return `=${raw}`;
  let normalized = raw.replace(',', '.');
  if (normalized.includes('.')) {
    normalized = normalized.replace(/\.?0+$/, '');
  }
  return `=${normalized}`;
}

function extractHybridTokens(text: string): { normalized: string; tokens: QueryToken[] } {
  const normalized = normalizeSearchText(text);
  const tokens: QueryToken[] = [];

  for (const match of normalized.matchAll(/\*?\d+(?:[.,]\d+)?/g)) {
    tokens.push({ token: normalizeNumericToken(match[0]), weight: 2.2 });
  }

  for (const match of normalized.matchAll(/#[a-zа-я0-9_]+/g)) {
    tokens.push({ token: match[0], weight: 2.0 });
  }

  for (const match of normalized.matchAll(/[a-zа-я0-9]{2,}/g)) {
    const word = match[0];
    tokens.push({ token: word, weight: 1.3 });
    if (word.length >= 5 && !/^\d+$/.test(word)) {
      tokens.push({ token: `~${word.slice(0, 5)}`, weight: 0.8 });
    }
  }

  return { normalized, tokens };
}

function tokenizeQuery(query: string): { normalized: string; tokens: QueryToken[] } {
  const { normalized, tokens } = extractHybridTokens(query);
  const weights = new Map<string, number>();

  for (const { token, weight } of tokens) {
    const prev = weights.get(token);
    if (prev === undefined || weight > prev) {
      weights.set(token, weight);
    }
  }

  return {
    normalized,
    tokens: Array.from(weights, ([token, weight]) => ({ token, weight })),
  };
}

function tokenizeDocument(text: string): { normalized: string; doc: DocumentTokens } {
  const { normalized, tokens } = extractHybridTokens(text);
  const tf = new Map<string, number>();

  for (const { token } of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  return {
    normalized,
    doc: { tf, docLen: Math.max(1, tokens.length) },
  };
}

function computeBm25Scores(rows: NoteDbRow[], trimmedQuery: string): Bm25Result {
  const scores = new Map<number, number>();
  const ranked: RankedNoteScore[] = [];
  if (!trimmedQuery) {
    return { scores, ranked, queryTokens: [] };
  }

  const { normalized: normalizedQuery, tokens: queryTokens } = tokenizeQuery(trimmedQuery);
  const queryTokenSet = new Set(queryTokens.map((qt) => qt.token));

  const df = new Map<string, number>();
  let totalDocTokens = 0;
  const docData = rows.map((row) => {
    const { normalized: docText, doc } = tokenizeDocument(
      `${row.raw_text ?? ''}\n${row.clean_text ?? ''}`,
    );
    totalDocTokens += doc.docLen;
    for (const token of queryTokenSet) {
      if ((doc.tf.get(token) ?? 0) > 0) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    return { row, docText, doc };
  });

  const k1 = 1.2;
  const b = 0.75;
  const N = rows.length;
  const avgdl = Math.max(1, totalDocTokens / Math.max(1, N));

  for (const { row, docText, doc } of docData) {
    let lexScore = 0;
    for (const qt of queryTokens) {
      const tf = doc.tf.get(qt.token) ?? 0;
      if (tf <= 0) continue;
      const docFreq = df.get(qt.token) ?? 0;
      if (docFreq <= 0) continue;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.docLen / avgdl)));
      lexScore += qt.weight * idf * tfNorm;
    }

    if (normalizedQuery.length >= 2 && docText.includes(normalizedQuery)) {
      lexScore += 1.5;
    }

    if (lexScore > 0) {
      scores.set(row.id, lexScore);
      ranked.push({ row, score: lexScore });
    }
  }

  ranked.sort((a, b) => (b.score - a.score) || (b.row.id - a.row.id));
  return { scores, ranked, queryTokens };
}

function computeVectorScores(
  rows: NoteDbRow[],
  embedding: number[] | null | undefined,
  minVecScore: number,
): { scores: Map<number, number>; ranked: RankedNoteScore[] } {
  const scores = new Map<number, number>();
  const ranked: RankedNoteScore[] = [];
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    return { scores, ranked };
  }

  for (const row of rows) {
    const vec = getNoteFloat32Vector(row);
    if (!vec) continue;
    const vecScore = cosineSimilarityFloat32(embedding, vec);
    if (vecScore >= minVecScore) {
      scores.set(row.id, vecScore);
      ranked.push({ row, score: vecScore });
    }
  }

  ranked.sort((a, b) => (b.score - a.score) || (b.row.id - a.row.id));
  return { scores, ranked };
}

function buildRankMap(ranked: RankedNoteScore[]): Map<number, number> {
  const rankMap = new Map<number, number>();
  for (let i = 0; i < ranked.length; i += 1) {
    rankMap.set(ranked[i]!.row.id, i + 1);
  }
  return rankMap;
}

function mergeWithRrf(
  lex: Bm25Result,
  vec: { scores: Map<number, number>; ranked: RankedNoteScore[] },
): NoteDbRow[] {
  const hasSpecialToken = lex.queryTokens.some(
    (qt) => qt.token.startsWith('=') || qt.token.startsWith('#'),
  );
  const wLex = hasSpecialToken ? 1.35 : 1.0;
  const wVec = hasSpecialToken ? 0.85 : 1.15;

  const lexRankMap = buildRankMap(lex.ranked);
  const vecRankMap = buildRankMap(vec.ranked);

  const candidateMap = new Map<number, NoteDbRow>();
  for (const item of lex.ranked) candidateMap.set(item.row.id, item.row);
  for (const item of vec.ranked) candidateMap.set(item.row.id, item.row);

  const combined: Array<{
    row: NoteDbRow;
    rrfScore: number;
    lexScore: number;
    vecScore: number;
  }> = [];

  for (const [id, row] of candidateMap) {
    const lexRank = lexRankMap.get(id);
    const vecRank = vecRankMap.get(id);
    const rrfScore =
      (vecRank !== undefined ? wVec / (60 + vecRank) : 0) +
      (lexRank !== undefined ? wLex / (60 + lexRank) : 0);
    combined.push({
      row,
      rrfScore,
      lexScore: lex.scores.get(id) ?? 0,
      vecScore: vec.scores.get(id) ?? -2,
    });
  }

  combined.sort(
    (a, b) =>
      (b.rrfScore - a.rrfScore) ||
      (b.lexScore - a.lexScore) ||
      (b.vecScore - a.vecScore) ||
      (b.row.id - a.row.id),
  );

  return combined.map((item) => item.row);
}

/**
 * Гибридный поиск по заметкам: BM25 (точные числа, *хвосты карт, хэштеги,
 * слова и 5-символьные стемы + подстрочный бонус) + косинусная близость
 * эмбеддингов, объединённые через Reciprocal Rank Fusion (`k = 60`).
 */
export async function searchNotesHybrid(
  userId: number,
  opts: HybridNoteSearchOptions,
): Promise<NoteRow[]> {
  const limit = Math.max(0, Math.trunc(opts.limit ?? DEFAULT_NEAREST_LIMIT));
  if (limit === 0) return [];

  const trimmedQuery = opts.query.trim();
  const hasValidEmbedding = Boolean(
    opts.embedding && opts.embedding.length === EMBEDDING_DIMENSIONS,
  );
  if (!trimmedQuery && !hasValidEmbedding) return [];

  const columnFilter = opts.column === undefined ? sql`` : sql` AND "column" = ${opts.column}`;
  const rows = await db.all<NoteDbRow>(sql`
    SELECT id, user_id, raw_text, clean_text, "column", embedding, merged_into,
      source_message_id, source_type, file_id, metadata, deleted_at, processed_at, created_at
    FROM notes
    WHERE user_id = ${userId} AND deleted_at IS NULL${columnFilter}
  `);
  if (rows.length === 0) return [];

  const lex = computeBm25Scores(rows, trimmedQuery);
  const minVecScore = lex.ranked.length > 0 ? 0.25 : -Infinity;
  const vec = computeVectorScores(rows, opts.embedding, minVecScore);

  return mergeWithRrf(lex, vec).slice(0, limit).map(mapNote);
}
