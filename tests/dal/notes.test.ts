/**
 * DAL `src/lib/dal/notes.ts` — заметки, канбан-колонки, корзина, эмбеддинги.
 *
 * Проверяем три вещи, которые легко «поплывут» при рефакторинге:
 *  1) кодирование значений: `embedding` и `metadata` лежат в TEXT как JSON,
 *     даты — ISO-строки, `null` остаётся `null` (никаких `undefined`);
 *  2) `"column"` — ключевое слово SQL, поэтому и в DAL, и в сидах оно в кавычках;
 *  3) изоляцию по `user_id`: ни одно чтение/изменение не задевает чужие строки.
 *
 * Часть проверок идёт через доменный API, часть — сырыми SELECT'ами: только так
 * видно, что в БД реально лежит строка `'{}'`, а не объект.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { EMBEDDING_DIMENSIONS } from '../../src/types';
import {
  cosineSimilarityFloat32,
  createNote,
  deleteNote,
  findNearestNotes,
  getNote,
  getNoteFloat32Vector,
  listNotes,
  restoreNote,
  searchNotesHybrid,
  updateNote,
} from '../../src/lib/dal/notes';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Единичный вектор по оси `i` — база для проверки косинусной сортировки. */
const vec = (i: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, k) => (k === i ? 1 : 0));

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

interface RawNote {
  user_id: number;
  raw_text: string;
  clean_text: string | null;
  column: string;
  embedding: string | null;
  metadata: string | null;
  deleted_at: string | null;
  created_at: string | null;
}

async function rawNote(id: number): Promise<RawNote | null> {
  return db.get<RawNote>(sql`
    SELECT user_id, raw_text, clean_text, "column", embedding, metadata,
           deleted_at, created_at
      FROM notes WHERE id = ${id}
  `);
}

interface SeedOptions {
  column?: string;
  embedding?: string | null;
  deletedAt?: string | null;
  createdAt: string;
}

/** Сырой инсерт: нужен, когда важна конкретная `created_at` или битый json. */
async function seedNote(
  userId: number,
  rawText: string,
  opts: SeedOptions,
): Promise<number> {
  const result = await db.run(sql`
    INSERT INTO notes (user_id, raw_text, "column", embedding, metadata, deleted_at,
                       source_type, created_at)
    VALUES (${userId}, ${rawText}, ${opts.column ?? 'raw'},
            ${opts.embedding ?? null}, ${'{}'}, ${opts.deletedAt ?? null},
            ${'text'}, ${opts.createdAt})
  `);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// createNote
// ---------------------------------------------------------------------------

describe('notes: createNote', () => {
  it('обрезает текст и проставляет дефолты', async () => {
    const note = await createNote(1, '  а б  ');

    expect(note.id).toBeGreaterThan(0);
    expect(note.userId).toBe(1);
    expect(note.rawText).toBe('а б');
    expect(note.cleanText).toBeNull();
    expect(note.column).toBe('raw');
    expect(note.sourceType).toBe('text');
    expect(note.embedding).toBeNull();
    expect(note.mergedInto).toBeNull();
    expect(note.sourceMessageId).toBeNull();
    expect(note.fileId).toBeNull();
    expect(note.metadata).toEqual({});
    expect(note.deletedAt).toBeNull();
    expect(note.processedAt).toBeNull();
    expect(note.createdAt).toMatch(ISO);

    const raw = await rawNote(note.id);
    expect(raw).not.toBeNull();
    // в БД json лежит строкой, а не объектом
    expect(raw?.metadata).toBe('{}');
    expect(raw?.embedding).toBeNull();
    expect(raw?.column).toBe('raw');
    expect(raw?.created_at).toMatch(ISO);
  });

  it('сохраняет переданные опции и кодирует json-колонки', async () => {
    const note = await createNote(1, 'голосовое', {
      column: 'idea',
      sourceType: 'voice',
      sourceMessageId: 42,
      fileId: 'file-9',
      metadata: { durationSec: 12, transcript: 'привет' },
      embedding: vec(3),
    });

    expect(note.column).toBe('idea');
    expect(note.sourceType).toBe('voice');
    expect(note.sourceMessageId).toBe(42);
    expect(note.fileId).toBe('file-9');
    expect(note.metadata).toEqual({ durationSec: 12, transcript: 'привет' });
    expect(note.embedding).toEqual(vec(3));

    const raw = await rawNote(note.id);
    expect(raw?.embedding).toBe(JSON.stringify(vec(3)));
    expect(JSON.parse(raw?.embedding ?? 'null')).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(JSON.parse(raw?.metadata ?? 'null')).toEqual({
      durationSec: 12,
      transcript: 'привет',
    });
  });

  it('разные пользователи не мешают друг другу', async () => {
    const first = await createNote(1, 'первая');
    const second = await createNote(2, 'вторая');

    expect(second.id).not.toBe(first.id);
    expect((await getNote(1, first.id))?.rawText).toBe('первая');
    expect((await getNote(2, second.id))?.rawText).toBe('вторая');
    expect(await getNote(1, second.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getNote
// ---------------------------------------------------------------------------

describe('notes: getNote', () => {
  it('возвращает свою заметку', async () => {
    const created = await createNote(1, 'заметка');
    const fetched = await getNote(1, created.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.rawText).toBe('заметка');
  });

  it('чужая и несуществующая → null', async () => {
    const created = await createNote(1, 'заметка');

    expect(await getNote(2, created.id)).toBeNull();
    expect(await getNote(1, created.id + 1000)).toBeNull();
  });

  it('удалённая невидима, но доступна с includeDeleted', async () => {
    const created = await createNote(1, 'в корзине');
    expect(await deleteNote(1, created.id)).toBe(true);

    expect(await getNote(1, created.id)).toBeNull();

    const trashed = await getNote(1, created.id, { includeDeleted: true });
    expect(trashed).not.toBeNull();
    expect(trashed?.deletedAt).toMatch(ISO);
  });
});

// ---------------------------------------------------------------------------
// listNotes
// ---------------------------------------------------------------------------

describe('notes: listNotes', () => {
  it('фильтрует по колонке', async () => {
    await createNote(1, 'сырая');
    await createNote(1, 'идея 1', { column: 'idea' });
    await createNote(1, 'идея 2', { column: 'idea' });

    const ideas = await listNotes(1, { column: 'idea' });
    expect(ideas).toHaveLength(2);
    expect(ideas.every((note) => note.column === 'idea')).toBe(true);
  });

  it('по умолчанию скрывает удалённые, includeDeleted — показывает', async () => {
    const alive = await createNote(1, 'живая');
    const trashed = await createNote(1, 'удалённая');
    await deleteNote(1, trashed.id);

    const visible = await listNotes(1);
    expect(visible.map((note) => note.id)).toEqual([alive.id]);

    const all = await listNotes(1, { includeDeleted: true });
    expect(all).toHaveLength(2);
  });

  it('сортирует новые сверху и соблюдает limit/offset', async () => {
    for (let day = 1; day <= 5; day += 1) {
      await seedNote(1, `note-0${day}`, {
        createdAt: `2026-01-0${day}T00:00:00.000Z`,
      });
    }

    const all = await listNotes(1);
    expect(all.map((note) => note.rawText)).toEqual([
      'note-05',
      'note-04',
      'note-03',
      'note-02',
      'note-01',
    ]);

    const window = await listNotes(1, { limit: 2, offset: 2 });
    expect(window.map((note) => note.rawText)).toEqual(['note-03', 'note-02']);

    expect(await listNotes(1, { limit: 0 })).toEqual([]);
  });

  it('изоляция: операции первого пользователя не видны второму', async () => {
    await createNote(2, 'чужая');
    const foreignBefore = await listNotes(2);

    const mine = await createNote(1, 'моя');
    await createNote(1, 'ещё одна');
    await deleteNote(1, mine.id);
    await listNotes(1, { includeDeleted: true });
    await updateNote(1, mine.id, { cleanText: 'x' });

    expect(await listNotes(2)).toEqual(foreignBefore);
    expect(foreignBefore).toHaveLength(1);
    expect(foreignBefore[0]?.userId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// updateNote
// ---------------------------------------------------------------------------

describe('notes: updateNote', () => {
  it('правит только переданные поля', async () => {
    const created = await createNote(1, 'текст', { column: 'idea' });

    const patched = await updateNote(1, created.id, { cleanText: 'чистый текст' });
    expect(patched?.cleanText).toBe('чистый текст');
    expect(patched?.column).toBe('idea');
    expect(patched?.rawText).toBe('текст');
    expect(patched?.createdAt).toBe(created.createdAt);

    const moved = await updateNote(1, created.id, { column: 'todo' });
    expect(moved?.column).toBe('todo');
    expect(moved?.cleanText).toBe('чистый текст');
  });

  it('cleanText: null очищает поле', async () => {
    const created = await createNote(1, 'текст');
    await updateNote(1, created.id, { cleanText: 'было' });

    const cleared = await updateNote(1, created.id, { cleanText: null });
    expect(cleared?.cleanText).toBeNull();

    const raw = await rawNote(created.id);
    expect(raw?.clean_text).toBeNull();
  });

  it('метаданные меняются только по явному патчу, текст их не переписывает', async () => {
    const created = await createNote(1, 'текст', { metadata: { durationSec: 7 } });

    await updateNote(1, created.id, { rawText: 'новый текст' });
    expect((await getNote(1, created.id))?.metadata).toEqual({ durationSec: 7 });

    const patched = await updateNote(1, created.id, { metadata: { durationSec: 9 } });
    expect(patched?.metadata).toEqual({ durationSec: 9 });
  });

  it('правка текста не трогает сырые байты metadata (битый json остаётся как был)', async () => {
    const id = await seedNote(1, 'сырьё', { createdAt: '2026-01-01T00:00:00.000Z' });
    await db.run(sql`UPDATE notes SET metadata = ${'{"битый"'} WHERE id = ${id}`);

    await updateNote(1, id, { rawText: 'новый текст' });

    expect((await rawNote(id))?.raw_text).toBe('новый текст');
    expect((await rawNote(id))?.metadata).toBe('{"битый"');
  });

  it('пустой патч не делает UPDATE и возвращает строку как есть', async () => {    const created = await createNote(1, 'текст');
    const before = await getNote(1, created.id);

    const after = await updateNote(1, created.id, {});
    expect(after).toEqual(before);

    const raw = await rawNote(created.id);
    expect(raw?.clean_text).toBeNull();
    expect(raw?.created_at).toBe(created.createdAt);
  });

  it('несуществующая, чужая и удалённая → null', async () => {
    const mine = await createNote(1, 'моя');
    const foreign = await createNote(2, 'чужая');
    const trashed = await createNote(1, 'в корзине');
    await deleteNote(1, trashed.id);

    expect(await updateNote(1, mine.id + 1000, { cleanText: 'x' })).toBeNull();
    expect(await updateNote(1, foreign.id, { cleanText: 'взлом' })).toBeNull();
    expect(await updateNote(1, trashed.id, { cleanText: 'из корзины' })).toBeNull();

    // чужая строка не изменилась
    expect((await getNote(2, foreign.id))?.cleanText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteNote / restoreNote
// ---------------------------------------------------------------------------

describe('notes: deleteNote и restoreNote', () => {
  it('удаляет мягко: deleted_at заполнен, колонка не меняется', async () => {
    const created = await createNote(1, 'в корзину', { column: 'idea' });

    expect(await deleteNote(1, created.id)).toBe(true);
    expect(await getNote(1, created.id)).toBeNull();

    const raw = await rawNote(created.id);
    expect(raw?.deleted_at).toMatch(ISO);
    expect(raw?.column).toBe('idea');
  });

  it('повторное удаление и удаление чужой → false', async () => {
    const created = await createNote(1, 'моя');
    const foreign = await createNote(2, 'чужая');

    expect(await deleteNote(1, created.id)).toBe(true);
    expect(await deleteNote(1, created.id)).toBe(false);
    expect(await deleteNote(1, foreign.id)).toBe(false);
    expect(await getNote(2, foreign.id)).not.toBeNull();
  });

  it('восстанавливает из корзины, сохраняя колонку', async () => {
    const created = await createNote(1, 'вернуть', { column: 'idea' });
    await deleteNote(1, created.id);

    const restored = await restoreNote(1, created.id);
    expect(restored).not.toBeNull();
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.column).toBe('idea');

    const raw = await rawNote(created.id);
    expect(raw?.deleted_at).toBeNull();

    // восстановление активной заметки — нечего делать
    expect(await restoreNote(1, created.id)).toBeNull();
    expect(await restoreNote(1, created.id + 1000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findNearestNotes
// ---------------------------------------------------------------------------

describe('notes: findNearestNotes', () => {
  async function seedVectors() {
    const a = await createNote(1, 'A', { embedding: vec(0) });
    const b = await createNote(1, 'B', { embedding: vec(1) });
    const c = await createNote(1, 'C', { embedding: vec(0).map((value) => -value) });
    return { a, b, c };
  }

  it('сортирует по косинусной похожести', async () => {
    const { a, b, c } = await seedVectors();

    const nearest = await findNearestNotes(1, vec(0));
    expect(nearest.map((note) => note.id)).toEqual([a.id, b.id, c.id]);
  });

  it('соблюдает limit', async () => {
    const { a, b } = await seedVectors();

    expect((await findNearestNotes(1, vec(0), { limit: 1 })).map((n) => n.id)).toEqual([a.id]);
    expect((await findNearestNotes(1, vec(0), { limit: 2 })).map((n) => n.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(await findNearestNotes(1, vec(0), { limit: 0 })).toEqual([]);
  });

  it('пропускает битый json, чужую размерность, чужих и удалённых', async () => {
    const { a, b, c } = await seedVectors();

    await seedNote(1, 'битый', { embedding: 'not-json', createdAt: '2026-01-01T00:00:00.000Z' });
    await seedNote(1, 'короткий', {
      embedding: JSON.stringify([1, 2, 3]),
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await createNote(2, 'чужая', { embedding: vec(0) });
    const trashed = await createNote(1, 'удалённая', { embedding: vec(0) });
    await deleteNote(1, trashed.id);

    const nearest = await findNearestNotes(1, vec(0));
    expect(nearest.map((note) => note.id)).toEqual([a.id, b.id, c.id]);
    expect(nearest.every((note) => note.userId === 1)).toBe(true);
  });

  it('вектор запроса чужой размерности → пустой результат', async () => {
    await seedVectors();

    expect(await findNearestNotes(1, [1, 2, 3])).toEqual([]);
    expect(await findNearestNotes(1, [])).toEqual([]);
  });

  it('по умолчанию отдаёт не больше пяти ближайших', async () => {
    for (let i = 0; i < 7; i += 1) {
      await createNote(1, `note-${i}`, { embedding: vec(i) });
    }

    const nearest = await findNearestNotes(1, vec(0));
    expect(nearest).toHaveLength(5);
    expect(nearest[0]?.rawText).toBe('note-0');
  });
});

// ---------------------------------------------------------------------------
// searchNotesHybrid & Float32Array cache
// ---------------------------------------------------------------------------

describe('notes: searchNotesHybrid', () => {
  /** Вектор с косинусом ~0.99 к vec(0) и 0.14 к vec(1) для проверки перевеса лексики. */
  const nearVec0 = (): number[] => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    v[0] = 0.99;
    v[1] = 0.14;
    return v;
  };

  /** Вектор с косинусом 0.4 к vec(0) — проходит порог 0.25, но слабее отвлекающей заметки. */
  const weakVec0 = (): number[] => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    v[0] = 0.4;
    v[2] = Math.sqrt(1 - 0.16);
    return v;
  };

  it('точное совпадение номера карты (*1234) и суммы (4500 ↔ 4500.00) перебивает отвлекающий вектор', async () => {
    const cardTarget = await createNote(1, 'Оплата по карте *1234 в аптеке', {
      embedding: weakVec0(),
    });
    const amountTarget = await createNote(1, 'Перевод аренды 4500.00 EUR', {
      embedding: vec(3),
    });
    await createNote(1, 'Размышления о финансах и банках без деталей', {
      embedding: nearVec0(),
    });

    const cardResults = await searchNotesHybrid(1, {
      query: '*1234',
      embedding: vec(0),
      limit: 5,
    });
    expect(cardResults.length).toBeGreaterThanOrEqual(1);
    expect(cardResults[0]?.id).toBe(cardTarget.id);

    const amountResults = await searchNotesHybrid(1, {
      query: '4500',
      embedding: vec(0),
      limit: 5,
    });
    expect(amountResults.length).toBeGreaterThanOrEqual(1);
    expect(amountResults[0]?.id).toBe(amountTarget.id);
  });

  it('чисто семантический запрос без лексического пересечения возвращает векторные совпадения', async () => {
    const best = await createNote(1, 'Билеты на самолёт в Лиссабон', {
      embedding: vec(0),
    });
    const second = await createNote(1, 'Бронь отеля у океана', {
      embedding: nearVec0(),
    });
    const worst = await createNote(1, 'Заметка на другую тему', {
      embedding: vec(4),
    });

    const results = await searchNotesHybrid(1, {
      query: 'путешествие к морю',
      embedding: vec(0),
      limit: 5,
    });
    expect(results.map((n) => n.id)).toEqual([best.id, second.id, worst.id]);
  });

  it('чисто лексический запрос (embedding: null) ранжирует по BM25 и поддерживает хэштеги, ё→е и column', async () => {
    const match = await createNote(1, 'Купить свежий тёплый мёд #покупки', {
      column: 'todo',
    });
    await createNote(1, 'Свежий обзор новостей #новости', {
      column: 'raw',
    });

    const byWord = await searchNotesHybrid(1, {
      query: 'мед #покупки',
      embedding: null,
    });
    expect(byWord.map((n) => n.id)).toEqual([match.id]);

    const wrongColumn = await searchNotesHybrid(1, {
      query: 'мед',
      embedding: null,
      column: 'idea',
    });
    expect(wrongColumn).toEqual([]);
  });

  it('уважает limit = 0, пустой запрос без эмбеддинга, удаление и изоляцию userId', async () => {
    const active = await createNote(1, 'Секрет *9911', { embedding: vec(0) });
    const trashed = await createNote(1, 'Удалённый *9911', { embedding: vec(0) });
    await deleteNote(1, trashed.id);
    await createNote(2, 'Чужой *9911', { embedding: vec(0) });

    expect(await searchNotesHybrid(1, { query: '*9911', limit: 0 })).toEqual([]);
    expect(await searchNotesHybrid(1, { query: '   ', embedding: null })).toEqual([]);

    const found = await searchNotesHybrid(1, { query: '*9911', embedding: vec(0) });
    expect(found.map((n) => n.id)).toEqual([active.id]);
  });

  it('Float32Array кэш: переиспользует вектор при совпадении строки и обновляется при изменении embedding', async () => {
    const note = await createNote(1, 'Первая заметка', { embedding: vec(0) });
    const initialRaw = JSON.stringify(vec(0));
    const updatedRaw = JSON.stringify(vec(1));

    const v1 = getNoteFloat32Vector({ id: note.id, embedding: initialRaw });
    const v2 = getNoteFloat32Vector({ id: note.id, embedding: initialRaw });
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v2).toBe(v1);
    expect(cosineSimilarityFloat32(vec(0), v1!)).toBeCloseTo(1, 5);

    // Обновляем embedding в БД и проверяем кэш + поиск
    await db.run(sql`UPDATE notes SET embedding = ${updatedRaw} WHERE id = ${note.id}`);

    const v3 = getNoteFloat32Vector({ id: note.id, embedding: updatedRaw });
    expect(v3).toBeInstanceOf(Float32Array);
    expect(v3).not.toBe(v1);
    expect(cosineSimilarityFloat32(vec(1), v3!)).toBeCloseTo(1, 5);

    const other = await createNote(1, 'Вторая заметка', { embedding: vec(0) });
    const semantic = await searchNotesHybrid(1, {
      query: 'непересекающийся запрос',
      embedding: vec(1),
      limit: 2,
    });
    expect(semantic.map((n) => n.id)).toEqual([note.id, other.id]);
  });
});
