/**
 * DAL: главы системной документации пользователя (`doc_chapters`).
 *
 * Замена upstream `backend/app/services/system_docs.py`, который читал
 * `docs/system/*.md` из репозитория. По ADR-002 тексты глав — данные
 * пользователя, а не константы кода: upstream-файлы содержат персональные
 * сведения хозяина и в порт не переносятся. Нейтральные дефолтные главы
 * задаёт `lib/systemDocs.ts` (`seedDocs`), а этот модуль — только хранилище.
 *
 * Инварианты:
 *  - изоляция по `user_id` в каждом запросе, включая upsert;
 *  - `(user_id, slug)` уникальны (см. `src/db/tables.ts`) — upsert идёт через
 *    `ON CONFLICT(user_id, slug) DO UPDATE`, то есть глава адресуется слагом;
 *  - `is_pinned` = «главу нельзя перезаписать сидом дефолтов»: `seedChapters`
 *    пропускает защищённые главы, а `upsertChapter` как явная операция пишет
 *    всё, что ей передали (пин — политика сида, не ограничение хранилища);
 *  - сиды идемпотентны: повторный прогон с теми же данными ничего не меняет
 *    (сравнение по значениям, без лишних UPDATE и обновления `updated_at`).
 *
 * Кодирование значений: `is_pinned` — INTEGER 0/1 (наружу `boolean`),
 * даты — ISO-строки из `nowIso()`; `undefined` в параметры не попадает.
 */

import { db, sql } from 'sdk/db';
import type { DocChapterRow } from '../../types.js';
import { nowIso } from '../utils.js';

/** Полный список колонок `doc_chapters` — в одном месте, чтобы не разъезжались SELECT'ы. */
const CHAPTER_COLUMNS = `id, user_id, slug, filename, title, content, is_pinned, created_at, updated_at`;

// ---------------------------------------------------------------------------
// Строка БД → доменная модель
// ---------------------------------------------------------------------------

interface DocChapterDbRow {
  id: number;
  user_id: number;
  slug: string;
  filename: string | null;
  title: string;
  content: string;
  is_pinned: number | null;
  created_at: string | null;
  updated_at: string | null;
}

/** INTEGER 0/1 (или строка) → boolean. */
function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

function mapChapter(row: DocChapterDbRow): DocChapterRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    slug: row.slug,
    filename: row.filename ?? null,
    title: row.title,
    content: row.content,
    isPinned: toBool(row.is_pinned),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Слаг — ключ главы: обрезаем и запрещаем пустой. */
function normalizeSlug(slug: string): string {
  const value = String(slug ?? '').trim();
  if (!value) throw new Error('doc_chapters: slug is required');
  return value;
}

function normalizeTitle(title: string): string {
  const value = String(title ?? '').trim();
  if (!value) throw new Error('doc_chapters: title is required');
  return value;
}

// ---------------------------------------------------------------------------
// Создание и чтение
// ---------------------------------------------------------------------------

export interface DocChapterInput {
  slug: string;
  title: string;
  /** Markdown-текст главы целиком. */
  content: string;
  /** Имя файла-источника — только для цитат, файлов на диске в порте нет. */
  filename?: string | null;
  /** Защитить главу от перезаписи сидом дефолтов. */
  isPinned?: boolean;
}

/** Новая глава. Дубль слага у того же пользователя — ошибка UNIQUE из БД. */
export async function createChapter(
  userId: number,
  input: DocChapterInput,
): Promise<DocChapterRow> {
  const now = nowIso();
  const result = await db.run(sql`
    INSERT INTO doc_chapters (user_id, slug, filename, title, content, is_pinned, created_at, updated_at)
    VALUES (
      ${userId},
      ${normalizeSlug(input.slug)},
      ${input.filename ?? null},
      ${normalizeTitle(input.title)},
      ${String(input.content ?? '')},
      ${input.isPinned === true ? 1 : 0},
      ${now},
      ${now}
    )
    RETURNING ${sql.raw(CHAPTER_COLUMNS)}
  `);

  const row = result.rows[0] as unknown as DocChapterDbRow | undefined;
  if (!row) throw new Error('doc_chapters.createChapter: insert returned no row');
  return mapChapter(row);
}

/** Глава пользователя по слагу (без разрешения topic-алиасов — это `systemDocs`). */
export async function getChapter(userId: number, slug: string): Promise<DocChapterRow | null> {
  const row = await db.get<DocChapterDbRow>(sql`
    SELECT ${sql.raw(CHAPTER_COLUMNS)}
      FROM doc_chapters
     WHERE user_id = ${userId} AND slug = ${String(slug ?? '').trim()}
     LIMIT 1
  `);
  return row ? mapChapter(row) : null;
}

/** Глава пользователя по id (id уникален глобально, но user_id всё равно проверяем). */
export async function getChapterById(
  userId: number,
  chapterId: number,
): Promise<DocChapterRow | null> {
  const row = await db.get<DocChapterDbRow>(sql`
    SELECT ${sql.raw(CHAPTER_COLUMNS)}
      FROM doc_chapters
     WHERE id = ${chapterId} AND user_id = ${userId}
     LIMIT 1
  `);
  return row ? mapChapter(row) : null;
}

/** Все главы пользователя в стабильном порядке (по слагу — он и есть «номер» главы). */
export async function listChapters(userId: number): Promise<DocChapterRow[]> {
  const rows = await db.all<DocChapterDbRow>(sql`
    SELECT ${sql.raw(CHAPTER_COLUMNS)}
      FROM doc_chapters
     WHERE user_id = ${userId}
     ORDER BY slug ASC, id ASC
  `);
  return rows.map(mapChapter);
}

// ---------------------------------------------------------------------------
// Правка и удаление
// ---------------------------------------------------------------------------

/** Пользовательски изменяемые поля главы. */
export interface DocChapterPatch {
  title?: string;
  content?: string;
  filename?: string | null;
  isPinned?: boolean;
}

/**
 * Частичная правка (read-merge-write): динамический SET на платформе
 * недоступен, поэтому читаем строку, мержим присутствующие ключи и пишем все
 * мутабельные колонки одним UPDATE. Пустой патч ничего не пишет.
 */
export async function updateChapter(
  userId: number,
  slug: string,
  patch: DocChapterPatch,
): Promise<DocChapterRow | null> {
  const current = await getChapter(userId, slug);
  if (!current) return null;

  const hasTitle = Object.hasOwn(patch, 'title');
  const hasContent = Object.hasOwn(patch, 'content');
  const hasFilename = Object.hasOwn(patch, 'filename');
  const hasPinned = Object.hasOwn(patch, 'isPinned');
  if (!hasTitle && !hasContent && !hasFilename && !hasPinned) return current;

  const nextTitle = hasTitle ? normalizeTitle(patch.title ?? '') : current.title;
  const nextContent = hasContent ? String(patch.content ?? '') : current.content;
  const nextFilename = hasFilename ? (patch.filename ?? null) : current.filename;
  const nextPinned = hasPinned ? patch.isPinned === true : current.isPinned;

  await db.run(sql`
    UPDATE doc_chapters
       SET title = ${nextTitle},
           content = ${nextContent},
           filename = ${nextFilename},
           is_pinned = ${nextPinned ? 1 : 0},
           updated_at = ${nowIso()}
     WHERE id = ${current.id} AND user_id = ${userId}
  `);
  return getChapterById(userId, current.id);
}

/**
 * Полный upsert главы по слагу: вставляет или перезаписывает `title`,
 * `content`, `filename` и `is_pinned`. Именно «полный» — частичных полей
 * здесь нет, для них `updateChapter`.
 */
export async function upsertChapter(
  userId: number,
  input: DocChapterInput,
): Promise<DocChapterRow> {
  const now = nowIso();
  const result = await db.run(sql`
    INSERT INTO doc_chapters (user_id, slug, filename, title, content, is_pinned, created_at, updated_at)
    VALUES (
      ${userId},
      ${normalizeSlug(input.slug)},
      ${input.filename ?? null},
      ${normalizeTitle(input.title)},
      ${String(input.content ?? '')},
      ${input.isPinned === true ? 1 : 0},
      ${now},
      ${now}
    )
    ON CONFLICT(user_id, slug) DO UPDATE SET
      filename = excluded.filename,
      title = excluded.title,
      content = excluded.content,
      is_pinned = excluded.is_pinned,
      updated_at = excluded.updated_at
    RETURNING ${sql.raw(CHAPTER_COLUMNS)}
  `);

  const row = result.rows[0] as unknown as DocChapterDbRow | undefined;
  if (!row) throw new Error('doc_chapters.upsertChapter: upsert returned no row');
  return mapChapter(row);
}

/** Удаление главы по слагу. `true`, если строка реально была. */
export async function deleteChapter(userId: number, slug: string): Promise<boolean> {
  const result = await db.run(sql`
    DELETE FROM doc_chapters
     WHERE user_id = ${userId} AND slug = ${String(slug ?? '').trim()}
  `);
  return result.rowsAffected > 0;
}

// ---------------------------------------------------------------------------
// Сиды дефолтных глав
// ---------------------------------------------------------------------------

export interface SeedChaptersResult {
  /** Сколько глав создано. */
  created: number;
  /** Сколько существующих глав обновлено содержимым сида. */
  updated: number;
  /** Сколько пропущено: защищённые (`is_pinned`) или уже совпадающие по значениям. */
  skipped: number;
  /** Полный список глав пользователя после прогона. */
  chapters: DocChapterRow[];
}

/** Совпадает ли глава с сидом по всем перезаписываемым полям. */
function sameAsSeed(existing: DocChapterRow, seed: DocChapterInput): boolean {
  return (
    existing.title === seed.title.trim() &&
    existing.content === String(seed.content ?? '') &&
    existing.filename === (seed.filename ?? null)
  );
}

/**
 * Идемпотентный сид глав: создаёт отсутствующие, обновляет незапиненные,
 * защищённые (`is_pinned`) не трогает. Повторный прогон с теми же данными
 * даёт `{created: 0, updated: 0}` — никаких лишних UPDATE и `updated_at`.
 */
export async function seedChapters(
  userId: number,
  seeds: readonly DocChapterInput[],
): Promise<SeedChaptersResult> {
  const bySlug = new Map<string, DocChapterRow>();
  for (const chapter of await listChapters(userId)) bySlug.set(chapter.slug, chapter);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const seed of seeds) {
    const input: DocChapterInput = {
      slug: normalizeSlug(seed.slug),
      title: normalizeTitle(seed.title),
      content: String(seed.content ?? ''),
      filename: seed.filename ?? null,
      isPinned: seed.isPinned === true,
    };

    const existing = bySlug.get(input.slug);
    if (!existing) {
      const row = await createChapter(userId, input);
      bySlug.set(row.slug, row);
      created += 1;
      continue;
    }

    if (existing.isPinned || sameAsSeed(existing, input)) {
      skipped += 1;
      continue;
    }

    const row = await upsertChapter(userId, input);
    bySlug.set(row.slug, row);
    updated += 1;
  }

  return { created, updated, skipped, chapters: await listChapters(userId) };
}
