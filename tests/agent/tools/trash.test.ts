/**
 * Тулзы агента: корзина (SPEC §3 T12).
 *
 * Держим инварианты:
 *  - `view_trash` показывает только корневые удалённые задачи (с числом шагов) и
 *    заметки, `daysRemaining` считает DAL от реального `Date.now()`;
 *  - `restore_from_trash` умеет и числовой id, и поиск по названию/фрагменту;
 *    задача ищется раньше заметки, `item_type` ограничивает поиск;
 *  - неизвестный `item_type` и пустой `query` дают `ok:false` с подсказкой;
 *  - `clear_trash` опустошает корзину пользователя и только его;
 *  - каждый пользователь видит только свою корзину.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { trashTools } from '../../../src/lib/agent/tools/trash';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { listTrash, softDeleteNote, softDeleteTask } from '../../../src/lib/dal/misc';
import { createTask, listTasks } from '../../../src/lib/dal/tasks';
import { createNote, listNotes, updateNote } from '../../../src/lib/dal/notes';
import { ensureUser } from '../../../src/lib/dal/users';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

function contextFor(userId: number): ToolContext {
  return { ...CTX_A, userId };
}

function toolByName(name: string): Tool {
  const found = trashTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в trashTools`);
  return found;
}

async function run(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = CTX_A,
): Promise<ToolOutcome> {
  const outcome = await toolByName(name).run(args, ctx);
  return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
}

interface TrashTaskData {
  id: number;
  title: string;
  category: string;
  steps_count: number;
  days_remaining: number;
}

interface TrashNoteData {
  id: number;
  column: string;
  text: string;
  days_remaining: number;
}

interface TrashData {
  total_count: number;
  tasks: TrashTaskData[];
  notes: TrashNoteData[];
}

interface RestoreData {
  item_type: string;
  item_id: number;
  restored: boolean;
}

interface PurgeData {
  tasks_purged: number;
  notes_purged: number;
}

/** Длиннее 60 символов — проверяем обрезку в `view_trash`. */
const LONG_NOTE =
  'Очень длинная заметка, которая точно не помещается в шестьдесят символов целиком';

async function seedDeletedTask(
  title = 'Купить молоко',
  userId: number = USER_A,
): Promise<number> {
  const task = await createTask(userId, { title });
  await softDeleteTask(userId, task.id);
  return task.id;
}

async function seedDeletedNote(
  text = 'Позвонить в клинику завтра утром',
  userId: number = USER_A,
): Promise<number> {
  const note = await createNote(userId, text);
  await softDeleteNote(userId, note.id);
  return note.id;
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// view_trash
// ---------------------------------------------------------------------------

describe('view_trash', () => {
  it('пустая корзина — фиксированный текст и пустые данные', async () => {
    const outcome = await run('view_trash', {});

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Корзина пуста. Все удалённые задачи и заметки хранятся 30 дней перед автоочисткой.',
    );

    const data = outcome.data as TrashData;
    expect(data.total_count).toBe(0);
    expect(data.tasks).toEqual([]);
    expect(data.notes).toEqual([]);
  });

  it('показывает задачу с шагами и заметку с обрезкой текста', async () => {
    const task = await createTask(USER_A, { title: 'Купить молоко' });
    await createTask(USER_A, { title: 'Взять сумку', parentId: task.id });
    await softDeleteTask(USER_A, task.id);

    const note = await createNote(USER_A, LONG_NOTE);
    await softDeleteNote(USER_A, note.id);

    const outcome = await run('view_trash', {});
    expect(outcome.ok).toBe(true);

    const expected = [
      '🗑️ В корзине 2 объектов (хранятся 30 дней):',
      '',
      '📋 **Задачи:**',
      `• Купить молоко [Быт] (1 шагов) — удалится через 30 дн. (id: ${task.id})`,
      '',
      '📝 **Заметки:**',
      `• [raw] «${LONG_NOTE.slice(0, 60)}...» — удалится через 30 дн. (id: ${note.id})`,
    ].join('\n');
    expect(outcome.content).toBe(expected);

    const data = outcome.data as TrashData;
    expect(data.total_count).toBe(2);
    expect(data.tasks).toEqual([
      {
        id: task.id,
        title: 'Купить молоко',
        category: 'Быт',
        steps_count: 1,
        days_remaining: 30,
      },
    ]);
    expect(data.notes).toEqual([
      {
        id: note.id,
        column: 'raw',
        text: LONG_NOTE,
        days_remaining: 30,
      },
    ]);
  });

  it('заметка без шагов и короткий текст не обрезается', async () => {
    const task = await createTask(USER_A, { title: 'Помыть посуду' });
    await softDeleteTask(USER_A, task.id);
    await seedDeletedNote('Короткая заметка', USER_A);

    const outcome = await run('view_trash', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• Помыть посуду [Быт] — удалится через 30 дн.');
    expect(outcome.content).toContain('• [raw] «Короткая заметка» — удалится через 30 дн.');
  });

  it('корзина одного пользователя не видна другому', async () => {
    await seedDeletedTask('Купить молоко', USER_A);
    await seedDeletedNote('Заметка пользователя A', USER_A);

    const outcome = await run('view_trash', {}, contextFor(USER_B));
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Корзина пуста. Все удалённые задачи и заметки хранятся 30 дней перед автоочисткой.',
    );
    expect((outcome.data as TrashData).total_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// restore_from_trash — числовой id
// ---------------------------------------------------------------------------

describe('restore_from_trash: числовой id', () => {
  it('восстанавливает задачу по id вместе с шагами', async () => {
    const task = await createTask(USER_A, { title: 'Купить молоко' });
    const step = await createTask(USER_A, { title: 'Взять сумку', parentId: task.id });
    await softDeleteTask(USER_A, task.id);

    const outcome = await run('restore_from_trash', { query: String(task.id) });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('✅ Элемент task успешно восстановлен из корзины!');
    expect(outcome.data as RestoreData).toMatchObject({
      item_type: 'task',
      item_id: task.id,
      restored: true,
    });

    const rootTasks = await listTasks(USER_A, { parentId: null });
    expect(rootTasks.map((item) => item.id)).toContain(task.id);
    const stepTasks = await listTasks(USER_A, { parentId: task.id });
    expect(stepTasks.map((item) => item.id)).toContain(step.id);
    expect((await listTrash(USER_A)).totalCount).toBe(0);
  });

  it('восстанавливает заметку по id после неудачной попытки с задачей', async () => {
    const noteId = await seedDeletedNote('Позвонить в клинику завтра утром');

    const outcome = await run('restore_from_trash', { query: String(noteId) });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('✅ Элемент note успешно восстановлен из корзины!');
    expect(outcome.data as RestoreData).toMatchObject({
      item_type: 'note',
      item_id: noteId,
      restored: true,
    });

    const notes = await listNotes(USER_A);
    expect(notes.map((note) => note.id)).toContain(noteId);
    expect((await listTrash(USER_A)).totalCount).toBe(0);
  });

  it('несуществующий id — ok:false с точным числом', async () => {
    const outcome = await run('restore_from_trash', { query: '999' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не найден элемент с ID 999 в корзине.');
  });

  it('item_type=task не даёт восстановить заметку по её id', async () => {
    const noteId = await seedDeletedNote();

    const outcome = await run('restore_from_trash', {
      query: String(noteId),
      item_type: 'task',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(`Не найден элемент с ID ${noteId} в корзине.`);
    expect(await listNotes(USER_A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// restore_from_trash — по названию/фрагменту
// ---------------------------------------------------------------------------

describe('restore_from_trash: поиск по тексту', () => {
  it('находит задачу по подстроке названия без учёта регистра', async () => {
    await seedDeletedTask('Купить молоко');

    const outcome = await run('restore_from_trash', { query: 'молок' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '✅ Задача «Купить молоко» успешно восстановлена из корзины!',
    );

    expect(await listTasks(USER_A, { parentId: null })).toHaveLength(1);
  });

  it('находит заметку по фрагменту текста (первые 40 символов в ответе)', async () => {
    const text = 'Позвонить в клинику завтра утром';
    await seedDeletedNote(text);

    const outcome = await run('restore_from_trash', { query: 'клинику' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      `✅ Заметка «${text.slice(0, 40)}...» успешно восстановлена из корзины!`,
    );

    const notes = await listNotes(USER_A);
    expect(notes).toHaveLength(1);
    expect(notes[0].rawText).toBe(text);
  });

  it('ищет заметку по clean_text, если он заполнен', async () => {
    const note = await createNote(USER_A, 'сырой текст заметки');
    await updateNote(USER_A, note.id, { cleanText: 'Чистый текст про клинику' });
    await softDeleteNote(USER_A, note.id);

    const view = await run('view_trash', {});
    expect(view.content).toContain('«Чистый текст про клинику»');

    const outcome = await run('restore_from_trash', { query: 'клинику' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '✅ Заметка «Чистый текст про клинику...» успешно восстановлена из корзины!',
    );
  });

  it('ничего похожего — ok:false с исходным запросом', async () => {
    await seedDeletedTask('Купить молоко');

    const outcome = await run('restore_from_trash', { query: 'ибупрофен' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'Не удалось найти элемент, похожий на «ибупрофен», в корзине.',
    );
    expect(await listTrash(USER_A)).toMatchObject({ totalCount: 1 });
  });

  it('русские синонимы item_type: «задача» и «заметка»', async () => {
    await seedDeletedTask('Купить молоко');
    await seedDeletedNote('Позвонить в клинику');

    const byTask = await run('restore_from_trash', {
      query: 'молоко',
      item_type: 'задача',
    });
    expect(byTask.ok).toBe(true);
    expect(byTask.content).toBe(
      '✅ Задача «Купить молоко» успешно восстановлена из корзины!',
    );

    const byNote = await run('restore_from_trash', {
      query: 'клинику',
      item_type: 'заметка',
    });
    expect(byNote.ok).toBe(true);
    expect(byNote.content).toBe(
      '✅ Заметка «Позвонить в клинику...» успешно восстановлена из корзины!',
    );

    expect((await listTrash(USER_A)).totalCount).toBe(0);
  });

  it('задачу чужого пользователя не восстанавливает', async () => {
    await seedDeletedTask('Купить молоко', USER_B);

    const outcome = await run('restore_from_trash', { query: 'молоко' });
    expect(outcome.ok).toBe(false);
    expect((await listTrash(USER_B)).totalCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// restore_from_trash — кривые аргументы
// ---------------------------------------------------------------------------

describe('restore_from_trash: валидация', () => {
  it('пустой query — ok:false с подсказкой', async () => {
    const missing = await run('restore_from_trash', {});
    expect(missing.ok).toBe(false);
    expect(missing.content).toBe(
      'Укажите задачу, заметку или id элемента корзины (query).',
    );

    const blank = await run('restore_from_trash', { query: '   ' });
    expect(blank.ok).toBe(false);
    expect(blank.content).toBe(
      'Укажите задачу, заметку или id элемента корзины (query).',
    );
  });

  it('неизвестный item_type — ok:false, без похода в DAL', async () => {
    await seedDeletedTask('Купить молоко');

    const outcome = await run('restore_from_trash', {
      query: 'молоко',
      item_type: 'invoice',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'item_type — «task» или «note» (или не указывайте вовсе).',
    );
    expect((await listTrash(USER_A)).totalCount).toBe(1);
  });

  it('нестроковый item_type — тоже ok:false', async () => {
    const outcome = await run('restore_from_trash', { query: 'молоко', item_type: 42 });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'item_type — «task» или «note» (или не указывайте вовсе).',
    );
  });
});

// ---------------------------------------------------------------------------
// clear_trash
// ---------------------------------------------------------------------------

describe('clear_trash', () => {
  it('пустая корзина — нули в тексте и данных', async () => {
    const outcome = await run('clear_trash', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '🗑️ Корзина очищена: удалено 0 задач и 0 заметок навсегда.',
    );
    expect(outcome.data as PurgeData).toEqual({ tasks_purged: 0, notes_purged: 0 });
  });

  it('удаляет навсегда все задачи и заметки пользователя', async () => {
    await seedDeletedTask('Купить молоко');
    await seedDeletedTask('Помыть посуду');
    await seedDeletedNote('Позвонить в клинику');

    const outcome = await run('clear_trash', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '🗑️ Корзина очищена: удалено 2 задач и 1 заметок навсегда.',
    );
    expect(outcome.data as PurgeData).toEqual({ tasks_purged: 2, notes_purged: 1 });

    expect((await listTrash(USER_A)).totalCount).toBe(0);
    expect(await listTasks(USER_A, { includeDeleted: true })).toEqual([]);
    expect(await listNotes(USER_A, { includeDeleted: true })).toEqual([]);
  });

  it('не трогает активные записи и корзину другого пользователя', async () => {
    const active = await createTask(USER_A, { title: 'Активная задача' });
    await seedDeletedTask('Удалённая задача', USER_A);
    await seedDeletedNote('Заметка B', USER_B);

    const outcome = await run('clear_trash', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.data as PurgeData).toEqual({ tasks_purged: 1, notes_purged: 0 });

    const tasks = await listTasks(USER_A, { includeDeleted: true });
    expect(tasks.map((task) => task.id)).toEqual([active.id]);

    expect((await listTrash(USER_B)).totalCount).toBe(1);
  });
});
