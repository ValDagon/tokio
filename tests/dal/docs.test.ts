/**
 * DAL `src/lib/dal/docs.ts` — главы системной документации (`doc_chapters`).
 *
 * Что проверяем (SPEC §3 T10, ADR-002):
 *  1) изоляцию по `user_id`: пользователь А не видит и не меняет главы Б,
 *     даже когда слаги совпадают;
 *  2) адресацию главы слагом: `upsertChapter` обновляет существующую строку,
 *     а не плодит дубли (`UNIQUE(user_id, slug)`);
 *  3) идемпотентность сидов: повторный прогон не делает UPDATE и не двигает
 *     `updated_at`; защищённые (`is_pinned`) главы не перезаписываются;
 *  4) кодирование `is_pinned` как INTEGER 0/1 — проверяется сырым SELECT'ом.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  createChapter,
  deleteChapter,
  getChapter,
  getChapterById,
  listChapters,
  seedChapters,
  updateChapter,
  upsertChapter,
} from '../../src/lib/dal/docs';
import type { DocChapterInput } from '../../src/lib/dal/docs';

const USER_A = 101;
const USER_B = 202;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

/** Сырая строка `doc_chapters` — чтобы видеть, что реально лежит в БД. */
async function rawChapter(userId: number, slug: string): Promise<Record<string, unknown> | null> {
  return db.get<Record<string, unknown>>(sql`
    SELECT id, user_id, slug, filename, title, content, is_pinned, created_at, updated_at
      FROM doc_chapters
     WHERE user_id = ${userId} AND slug = ${slug}
     LIMIT 1
  `);
}

const seed = (slug: string, title: string, content: string, extra: Partial<DocChapterInput> = {}): DocChapterInput => ({
  slug,
  title,
  content,
  ...extra,
});

describe('createChapter / getChapter', () => {
  it('создаёт главу и возвращает доменную модель', async () => {
    const chapter = await createChapter(USER_A, seed('01_tasks', 'Задачи', '# Задачи\n\nТекст.'));

    expect(chapter.id).toBeGreaterThan(0);
    expect(chapter.userId).toBe(USER_A);
    expect(chapter.slug).toBe('01_tasks');
    expect(chapter.title).toBe('Задачи');
    expect(chapter.content).toBe('# Задачи\n\nТекст.');
    expect(chapter.filename).toBeNull();
    expect(chapter.isPinned).toBe(false);
    expect(chapter.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(chapter.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('обрезает слаг и заголовок, пустые — ошибка', async () => {
    const chapter = await createChapter(USER_A, seed('  02_notes  ', '  Заметки  ', 'текст'));
    expect(chapter.slug).toBe('02_notes');
    expect(chapter.title).toBe('Заметки');

    await expect(createChapter(USER_A, seed('   ', 'Заголовок', 'x'))).rejects.toThrow(/slug is required/);
    await expect(createChapter(USER_A, seed('03_x', '   ', 'x'))).rejects.toThrow(/title is required/);
  });

  it('is_pinned пишется как INTEGER 0/1', async () => {
    await createChapter(USER_A, seed('a', 'А', '1', { isPinned: true }));
    await createChapter(USER_A, seed('b', 'Б', '2'));

    const pinned = await rawChapter(USER_A, 'a');
    const plain = await rawChapter(USER_A, 'b');
    expect(pinned?.is_pinned).toBe(1);
    expect(plain?.is_pinned).toBe(0);
  });

  it('дубль слага у того же пользователя — ошибка UNIQUE', async () => {
    await createChapter(USER_A, seed('dup', 'Глава', 'текст'));
    await expect(createChapter(USER_A, seed('dup', 'Другая', 'другой'))).rejects.toThrow(/UNIQUE/i);
  });

  it('getChapter возвращает null для чужой и несуществующей главы', async () => {
    await createChapter(USER_A, seed('only_a', 'Только А', 'текст'));

    expect(await getChapter(USER_A, 'only_a')).not.toBeNull();
    expect(await getChapter(USER_B, 'only_a')).toBeNull();
    expect(await getChapter(USER_A, 'нет_такой')).toBeNull();
  });
});

describe('изоляция по user_id', () => {
  it('одинаковый слаг у двух пользователей — две независимые строки', async () => {
    const a = await createChapter(USER_A, seed('01_finances', 'Финансы А', 'текст А'));
    const b = await createChapter(USER_B, seed('01_finances', 'Финансы Б', 'текст Б'));

    expect(a.id).not.toBe(b.id);
    expect((await getChapter(USER_A, '01_finances'))?.title).toBe('Финансы А');
    expect((await getChapter(USER_B, '01_finances'))?.title).toBe('Финансы Б');
    expect(await listChapters(USER_A)).toHaveLength(1);
    expect(await listChapters(USER_B)).toHaveLength(1);
  });

  it('listChapters не показывает чужие главы и сортирует по слагу', async () => {
    await createChapter(USER_A, seed('b', 'Б', '2'));
    await createChapter(USER_A, seed('a', 'А', '1'));
    await createChapter(USER_B, seed('c', 'Чужая', '3'));

    expect((await listChapters(USER_A)).map((chapter) => chapter.slug)).toEqual(['a', 'b']);
  });

  it('getChapterById и updateChapter не достают чужую строку', async () => {
    const a = await createChapter(USER_A, seed('shared', 'А', 'старое'));

    expect(await getChapterById(USER_B, a.id)).toBeNull();
    expect(await updateChapter(USER_B, 'shared', { title: 'Взлом' })).toBeNull();

    const stillA = await getChapter(USER_A, 'shared');
    expect(stillA?.title).toBe('А');
  });

  it('deleteChapter удаляет только свою главу', async () => {
    await createChapter(USER_A, seed('same', 'А', 'a'));
    await createChapter(USER_B, seed('same', 'Б', 'b'));

    expect(await deleteChapter(USER_A, 'same')).toBe(true);
    expect(await getChapter(USER_A, 'same')).toBeNull();
    expect(await getChapter(USER_B, 'same')).not.toBeNull();
    expect(await deleteChapter(USER_A, 'same')).toBe(false);
  });
});

describe('updateChapter', () => {
  it('меняет только переданные поля (read-merge-write)', async () => {
    await createChapter(USER_A, seed('x', 'Старое имя', 'старый текст', { filename: 'x.md' }));

    const updated = await updateChapter(USER_A, 'x', { title: 'Новое имя' });
    expect(updated?.title).toBe('Новое имя');
    expect(updated?.content).toBe('старый текст');
    expect(updated?.filename).toBe('x.md');
  });

  it('filename: null очищает поле', async () => {
    await createChapter(USER_A, seed('x', 'Имя', 'текст', { filename: 'x.md' }));

    const updated = await updateChapter(USER_A, 'x', { filename: null });
    expect(updated?.filename).toBeNull();
  });

  it('пустой патч ничего не пишет и не двигает updated_at', async () => {
    const STAMP = '2020-01-01T00:00:00.000Z';
    await createChapter(USER_A, seed('x', 'Имя', 'текст'));
    await db.run(sql`
      UPDATE doc_chapters SET updated_at = ${STAMP}
       WHERE user_id = ${USER_A} AND slug = ${'x'}
    `);

    const before = await getChapter(USER_A, 'x');
    const after = await updateChapter(USER_A, 'x', {});

    expect(before?.updatedAt).toBe(STAMP);
    expect(after?.updatedAt).toBe(STAMP);
    expect(after?.id).toBe(before?.id);
  });

  it('несуществующая глава → null', async () => {
    expect(await updateChapter(USER_A, 'ghost', { title: 'Нет' })).toBeNull();
  });
});

describe('upsertChapter', () => {
  it('создаёт новую главу', async () => {
    const chapter = await upsertChapter(USER_A, seed('new', 'Новая', 'текст'));

    expect(chapter.slug).toBe('new');
    expect(await listChapters(USER_A)).toHaveLength(1);
  });

  it('обновляет существующую главу по слагу, не создавая дубль', async () => {
    const created = await createChapter(USER_A, seed('slug', 'Старое', 'старый', { filename: 'old.md' }));

    const updated = await upsertChapter(USER_A, seed('slug', 'Новое', 'новый', { filename: 'new.md' }));
    const all = await listChapters(USER_A);

    expect(all).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe('Новое');
    expect(updated.content).toBe('новый');
    expect(updated.filename).toBe('new.md');
  });

  it('перезаписывает is_pinned (это явная операция, не сид)', async () => {
    await createChapter(USER_A, seed('slug', 'Имя', 'текст', { isPinned: true }));

    const updated = await upsertChapter(USER_A, seed('slug', 'Имя', 'текст', { isPinned: false }));
    expect(updated.isPinned).toBe(false);
    expect((await rawChapter(USER_A, 'slug'))?.is_pinned).toBe(0);
  });
});

describe('seedChapters', () => {
  const SEEDS: DocChapterInput[] = [
    seed('01_tasks', 'Задачи', '# Задачи\n\nПервый текст.'),
    seed('02_notes', 'Заметки', '# Заметки\n\nВторой текст.'),
  ];

  it('первый прогон создаёт все главы', async () => {
    const result = await seedChapters(USER_A, SEEDS);

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.chapters.map((chapter) => chapter.slug)).toEqual(['01_tasks', '02_notes']);
  });

  it('повторный прогон идемпотентен: ничего не пишет и не двигает updated_at', async () => {
    const STAMP = '2020-01-01T00:00:00.000Z';
    await seedChapters(USER_A, SEEDS);
    await db.run(sql`
      UPDATE doc_chapters SET updated_at = ${STAMP} WHERE user_id = ${USER_A}
    `);

    const again = await seedChapters(USER_A, SEEDS);

    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.chapters).toHaveLength(2);
    expect(again.chapters.every((chapter) => chapter.updatedAt === STAMP)).toBe(true);
  });

  it('изменённый сид обновляет главу', async () => {
    await seedChapters(USER_A, SEEDS);

    const changed = await seedChapters(USER_A, [
      seed('01_tasks', 'Задачи', '# Задачи\n\nНовый текст.'),
      SEEDS[1],
    ]);

    expect(changed.created).toBe(0);
    expect(changed.updated).toBe(1);
    expect(changed.skipped).toBe(1);
    expect((await getChapter(USER_A, '01_tasks'))?.content).toBe('# Задачи\n\nНовый текст.');
  });

  it('защищённую (is_pinned) главу сид не перезаписывает', async () => {
    await createChapter(USER_A, seed('01_tasks', 'Моя глава', 'мой текст', { isPinned: true }));

    const result = await seedChapters(USER_A, SEEDS);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    const own = await getChapter(USER_A, '01_tasks');
    expect(own?.title).toBe('Моя глава');
    expect(own?.content).toBe('мой текст');
  });

  it('сид одного пользователя не видит главы другого', async () => {
    await seedChapters(USER_A, SEEDS);
    const forB = await seedChapters(USER_B, SEEDS);

    expect(forB.created).toBe(2);
    expect(await listChapters(USER_B)).toHaveLength(2);
    // у А ничего не задвоилось
    expect(await listChapters(USER_A)).toHaveLength(2);
  });

  it('пустой набор сидов — no-op', async () => {
    const result = await seedChapters(USER_A, []);
    expect(result).toMatchObject({ created: 0, updated: 0, skipped: 0, chapters: [] });
  });
});
