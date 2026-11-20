/**
 * DAL `src/lib/dal/tasks.ts` — задачи, категории, подкатегории и повторы.
 *
 * Что здесь закреплено:
 *  - системные категории создаются идемпотентно и НЕ затирают порядок,
 *    выставленный пользователем (отличие от Python-версии с `DO UPDATE`);
 *  - любая операция скоупится `user_id`: юзер Б не видит и не меняет данные А;
 *  - кодирование значений ручное: boolean ↔ 0/1, `recurrence` ↔ json-текст,
 *    даты — только ISO-строки (в БД нет декодирования);
 *  - корзина — `deleted_at` с каскадом на подзадачи;
 *  - завершение задачи с повтором — паритет `complete_task_with_recurrence`;
 *  - `nextOccurrence` — чистая арифметика в UTC, строго в будущем, `until`
 *    включительно, кламп дня при monthly/yearly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  SYSTEM_CATEGORIES,
  SYSTEM_SUBCATEGORIES,
  autoAdvancePastEvents,
  completeTask,
  createTask,
  deleteTask,
  ensureSystemCategories,
  findCategoryByName,
  getTask,
  listCategories,
  listSubcategories,
  listTasks,
  nextOccurrence,
  restoreTask,
  updateTask,
} from '../../src/lib/dal/tasks';
import type { RecurrenceRule, TaskCategoryRow, TaskRow } from '../../src/types';
import { dateKey, toIso } from '../../src/lib/utils';

const USER = 1001;
const OTHER = 2002;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

/** Сырая строка таблицы `tasks` — чтобы проверять значения до маппинга. */
async function rawTask(id: number): Promise<Record<string, unknown>> {
  const row = await db.get<Record<string, unknown>>(sql`SELECT * FROM tasks WHERE id = ${id} LIMIT 1`);
  if (!row) throw new Error(`rawTask: задача ${id} не найдена`);
  return row;
}

/** Подменить `created_at` — для детерминированной сортировки в тестах. */
async function setCreatedAt(id: number, iso: string): Promise<void> {
  await db.run(sql`UPDATE tasks SET created_at = ${iso} WHERE id = ${id}`);
}

/** Флаг «напоминание отправлено» выставляется джобой, поэтому правим руками. */
async function setReminderSent(id: number, sent: boolean): Promise<void> {
  await db.run(sql`UPDATE tasks SET reminder_sent = ${sent ? 1 : 0} WHERE id = ${id}`);
}

function mustTask(task: TaskRow | null): TaskRow {
  if (!task) throw new Error('mustTask: ожидалась задача, пришёл null');
  return task;
}

function mustCategory(category: TaskCategoryRow | null): TaskCategoryRow {
  if (!category) throw new Error('mustCategory: ожидалась категория, пришёл null');
  return category;
}

/** Снимок всех данных пользователя (три таблицы задач) — для матрицы изоляции. */
async function snapshot(userId: number): Promise<string> {
  const categories = await db.all(sql`SELECT * FROM task_categories WHERE user_id = ${userId} ORDER BY id`);
  const subcategories = await db.all(
    sql`SELECT * FROM task_subcategories WHERE user_id = ${userId} ORDER BY id`,
  );
  const tasks = await db.all(sql`SELECT * FROM tasks WHERE user_id = ${userId} ORDER BY id`);
  return JSON.stringify({ categories, subcategories, tasks });
}

/** Детерминированный ISO-момент. */
const at = (iso: string): Date => new Date(iso);
const iso = (date: Date): string => toIso(date);

// ---------------------------------------------------------------------------
// 1. Системные категории
// ---------------------------------------------------------------------------

describe('tasks: системные категории', () => {
  it('создаёт весь набор с position по порядку и сабки по категориям', async () => {
    await ensureSystemCategories(USER);

    const categories = await listCategories(USER);
    expect(categories).toHaveLength(SYSTEM_CATEGORIES.length);
    expect(categories.map((c) => c.name)).toEqual([...SYSTEM_CATEGORIES]);
    expect(categories.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(categories.every((c) => c.userId === USER)).toBe(true);
    expect(categories.every((c) => typeof c.createdAt === 'string')).toBe(true);

    const hobby = mustCategory(await findCategoryByName(USER, 'Хобби'));
    const hobbySubs = await listSubcategories(USER, hobby.id);
    expect(hobbySubs.map((s) => s.name)).toEqual([...SYSTEM_SUBCATEGORIES['Хобби']]);
    expect(hobbySubs.map((s) => s.position)).toEqual([0, 1]);

    const home = (await findCategoryByName(USER, 'Быт')) as { id: number };
    const homeSubs = await listSubcategories(USER, home.id);
    expect(homeSubs.map((s) => s.name)).toEqual([...SYSTEM_SUBCATEGORIES['Быт']]);
    expect(homeSubs.map((s) => s.position)).toEqual([0, 1, 2, 3]);

    const other = (await findCategoryByName(USER, 'Стартап')) as { id: number };
    expect(await listSubcategories(USER, other.id)).toEqual([]);
  });

  it('идемпотентен: повторный вызов не плодит дубли', async () => {
    await ensureSystemCategories(USER);
    const first = await listCategories(USER);
    await ensureSystemCategories(USER);

    const second = await listCategories(USER);
    expect(second).toHaveLength(first.length);
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));

    const hobby = first.find((c) => c.name === 'Хобби');
    if (!hobby) throw new Error('нет категории Хобби');
    const subs = await listSubcategories(USER, hobby.id);
    expect(subs.map((s) => s.id)).toEqual(
      (await listSubcategories(USER, hobby.id)).map((s) => s.id),
    );
  });

  it('не перезаписывает position, выставленный пользователем', async () => {
    await ensureSystemCategories(USER);
    await db.run(sql`
      UPDATE task_categories SET position = 99 WHERE user_id = ${USER} AND name = 'Стартап'
    `);

    await ensureSystemCategories(USER);

    const categories = await listCategories(USER);
    const startup = categories.find((c) => c.name === 'Стартап');
    expect(startup?.position).toBe(99);
    // остальные позиции остались прежними
    expect(categories.filter((c) => c.name !== 'Стартап').map((c) => c.position)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('вызывается для двух юзеров независимо', async () => {
    await ensureSystemCategories(USER);
    await ensureSystemCategories(OTHER);

    const mine = await listCategories(USER);
    const theirs = await listCategories(OTHER);
    expect(theirs).toHaveLength(mine.length);
    expect(theirs.every((c) => c.userId === OTHER)).toBe(true);
    expect(theirs.map((c) => c.id)).not.toEqual(mine.map((c) => c.id));
  });
});

// ---------------------------------------------------------------------------
// 2. Поиск категории по имени
// ---------------------------------------------------------------------------

describe('tasks: findCategoryByName', () => {
  it('находит по точному имени и отдаёт null для незнакомого', async () => {
    await ensureSystemCategories(USER);

    const found = await findCategoryByName(USER, 'Фриланс');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('Фриланс');
    expect(found?.userId).toBe(USER);

    expect(await findCategoryByName(USER, 'фриланс')).toBeNull();
    expect(await findCategoryByName(USER, 'Нет такой')).toBeNull();
  });

  it('не находит категорию другого пользователя', async () => {
    await ensureSystemCategories(USER);
    await ensureSystemCategories(OTHER);

    expect(await findCategoryByName(OTHER, 'Быт')).not.toBeNull();
    // у USER та же категория есть — но у каждого своя строка
    const mine = await findCategoryByName(USER, 'Быт');
    const theirs = await findCategoryByName(OTHER, 'Быт');
    expect(mine?.id).not.toBe(theirs?.id);
  });
});

// ---------------------------------------------------------------------------
// 3. createTask / getTask
// ---------------------------------------------------------------------------

describe('tasks: createTask и getTask', () => {
  it('подставляет дефолты схемы', async () => {
    const task = await createTask(USER, { title: 'Купить хлеб' });

    expect(task.title).toBe('Купить хлеб');
    expect(task.userId).toBe(USER);
    expect(task.status).toBe('todo');
    expect(task.position).toBe(0);
    expect(task.reminderSent).toBe(false);
    expect(task.recurrence).toBeNull();
    expect(task.categoryId).toBeNull();
    expect(task.subcategoryId).toBeNull();
    expect(task.parentId).toBeNull();
    expect(task.notes).toBeNull();
    expect(task.sourceText).toBeNull();
    expect(task.dueAt).toBeNull();
    expect(task.remindAt).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.deletedAt).toBeNull();
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(task.updatedAt).toBe(task.createdAt);

    // в БД флаг лежит числом, json — текстом
    const raw = await rawTask(task.id);
    expect(raw.reminder_sent).toBe(0);
    expect(raw.recurrence).toBeNull();
    expect(raw.status).toBe('todo');
  });

  it('сохраняет все переданные поля, включая json-правило повтора', async () => {
    const parent = await createTask(USER, { title: 'Родитель' });
    const rule: RecurrenceRule = { freq: 'weekly', weekdays: [2, 4], interval: 2, count: 5 };

    const task = await createTask(USER, {
      title: 'Созвон',
      notes: 'с командой',
      status: 'in_progress',
      position: 7,
      categoryId: 42,
      subcategoryId: 4242,
      parentId: parent.id,
      sourceText: 'завтра созвон с командой',
      dueAt: '2026-11-10T09:00:00.000Z',
      remindAt: '2026-11-10T08:45:00.000Z',
      recurrence: rule,
    });

    expect(task).toMatchObject({
      userId: USER,
      title: 'Созвон',
      notes: 'с командой',
      status: 'in_progress',
      position: 7,
      categoryId: 42,
      subcategoryId: 4242,
      parentId: parent.id,
      sourceText: 'завтра созвон с командой',
      dueAt: '2026-11-10T09:00:00.000Z',
      remindAt: '2026-11-10T08:45:00.000Z',
    });
    expect(task.recurrence).toEqual(rule);

    const raw = await rawTask(task.id);
    expect(typeof raw.recurrence).toBe('string');
    expect(JSON.parse(String(raw.recurrence))).toEqual(rule);

    // и обратное чтение не теряет правило
    const again = mustTask(await getTask(USER, task.id));
    expect(again.recurrence).toEqual(rule);
    expect(again).toEqual(task);
  });

  it('не отдаёт задачу чужому пользователю', async () => {
    const task = await createTask(USER, { title: 'Личное' });
    expect(await getTask(OTHER, task.id)).toBeNull();
  });

  it('скрывает удалённую задачу, пока не попросили includeDeleted', async () => {
    const task = await createTask(USER, { title: 'В корзину' });
    await deleteTask(USER, task.id);

    expect(await getTask(USER, task.id)).toBeNull();
    const deleted = mustTask(await getTask(USER, task.id, { includeDeleted: true }));
    expect(deleted.deletedAt).not.toBeNull();
  });

  it('пустая строка notes/sourceText сохраняется как есть, undefined — как NULL', async () => {
    const task = await createTask(USER, { title: 'Проверка', notes: '', sourceText: undefined });
    expect(task.notes).toBe('');
    expect(task.sourceText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. listTasks
// ---------------------------------------------------------------------------

describe('tasks: listTasks', () => {
  it('фильтрует по статусу и категории', async () => {
    await createTask(USER, { title: 'a', status: 'todo' });
    await createTask(USER, { title: 'b', status: 'in_progress', categoryId: 5 });
    await createTask(USER, { title: 'c', status: 'done' });

    expect((await listTasks(USER, { status: 'done' })).map((t) => t.title)).toEqual(['c']);
    expect((await listTasks(USER, { status: 'todo' })).map((t) => t.title)).toEqual(['a']);
    expect((await listTasks(USER, { categoryId: 5 })).map((t) => t.title)).toEqual(['b']);
    expect(await listTasks(USER, { status: 'cancelled' })).toEqual([]);
  });

  it('parentId: null — только корневые, число — только дети', async () => {
    const parent = await createTask(USER, { title: 'parent' });
    const child = await createTask(USER, { title: 'child', parentId: parent.id });
    await createTask(USER, { title: 'standalone' });

    const roots = await listTasks(USER, { parentId: null });
    expect(roots.map((t) => t.title).sort()).toEqual(['parent', 'standalone']);

    const children = await listTasks(USER, { parentId: parent.id });
    expect(children.map((t) => t.id)).toEqual([child.id]);

    const all = await listTasks(USER);
    expect(all).toHaveLength(3);
  });

  it('сортирует свежие сверху и поддерживает limit/offset', async () => {
    const first = await createTask(USER, { title: 'first' });
    const second = await createTask(USER, { title: 'second' });
    const third = await createTask(USER, { title: 'third' });

    await setCreatedAt(first.id, '2026-01-01T00:00:00.000Z');
    await setCreatedAt(second.id, '2026-02-01T00:00:00.000Z');
    await setCreatedAt(third.id, '2026-03-01T00:00:00.000Z');

    expect((await listTasks(USER)).map((t) => t.title)).toEqual(['third', 'second', 'first']);
    expect((await listTasks(USER, { limit: 2 })).map((t) => t.title)).toEqual(['third', 'second']);
    expect((await listTasks(USER, { limit: 2, offset: 1 })).map((t) => t.title)).toEqual([
      'second',
      'first',
    ]);
    expect((await listTasks(USER, { offset: 5 }))).toEqual([]);
  });

  it('по умолчанию прячет корзину, с includeDeleted — показывает', async () => {
    const active = await createTask(USER, { title: 'active' });
    const trashed = await createTask(USER, { title: 'trashed' });
    await deleteTask(USER, trashed.id);

    expect((await listTasks(USER)).map((t) => t.id)).toEqual([active.id]);
    const withDeleted = await listTasks(USER, { includeDeleted: true });
    expect(withDeleted.map((t) => t.id).sort()).toEqual([active.id, trashed.id].sort());
  });

  it('не показывает задачи другого пользователя', async () => {
    await createTask(USER, { title: 'моё' });
    await createTask(OTHER, { title: 'чужое' });

    expect((await listTasks(USER)).map((t) => t.title)).toEqual(['моё']);
    expect((await listTasks(OTHER)).map((t) => t.title)).toEqual(['чужое']);
  });
});

// ---------------------------------------------------------------------------
// 5. updateTask
// ---------------------------------------------------------------------------

describe('tasks: updateTask', () => {
  it('меняет только переданные поля (read-merge-write)', async () => {
    const task = await createTask(USER, {
      title: 'старое',
      notes: 'заметка',
      dueAt: '2026-11-10T09:00:00.000Z',
    });

    const updated = mustTask(await updateTask(USER, task.id, { title: 'новое' }));
    expect(updated.title).toBe('новое');
    expect(updated.notes).toBe('заметка');
    expect(updated.dueAt).toBe('2026-11-10T09:00:00.000Z');
  });

  it('null в патче — явная очистка поля', async () => {
    const task = await createTask(USER, {
      title: 'задача',
      notes: 'заметка',
      categoryId: 3,
      recurrence: { freq: 'daily' },
    });

    const updated = mustTask(
      await updateTask(USER, task.id, { notes: null, categoryId: null, recurrence: null }),
    );
    expect(updated.notes).toBeNull();
    expect(updated.categoryId).toBeNull();
    expect(updated.recurrence).toBeNull();
    expect((await rawTask(task.id)).recurrence).toBeNull();
  });

  it('не трогает completed_at и удалённые задачи', async () => {
    const task = await createTask(USER, { title: 'задача' });
    await completeTask(USER, task.id);
    const doned = mustTask(await getTask(USER, task.id));
    expect(doned.completedAt).not.toBeNull();

    const updated = mustTask(await updateTask(USER, task.id, { title: 'переименована' }));
    expect(updated.completedAt).toBe(doned.completedAt);
    expect(updated.status).toBe('done');

    const trashed = await createTask(USER, { title: 'в корзине' });
    await deleteTask(USER, trashed.id);
    expect(await updateTask(USER, trashed.id, { title: 'x' })).toBeNull();
    expect(await updateTask(USER, 999_999, { title: 'x' })).toBeNull();
  });

  it('перенос напоминания сбрасывает reminder_sent, прочие правки — нет', async () => {
    const task = await createTask(USER, {
      title: 'напоминание',
      remindAt: '2026-11-10T08:45:00.000Z',
    });
    await setReminderSent(task.id, true);
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);

    const renamed = mustTask(await updateTask(USER, task.id, { title: 'переименована' }));
    expect(renamed.reminderSent).toBe(true);

    const rescheduled = mustTask(
      await updateTask(USER, task.id, { remindAt: '2026-11-11T08:45:00.000Z' }),
    );
    expect(rescheduled.remindAt).toBe('2026-11-11T08:45:00.000Z');
    expect(rescheduled.reminderSent).toBe(false);
    expect((await rawTask(task.id)).reminder_sent).toBe(0);
  });

  it('пустой патч не выполняет UPDATE и не двигает updated_at', async () => {
    const task = await createTask(USER, { title: 'неизменная', notes: 'n' });
    await setCreatedAt(task.id, '2026-01-01T00:00:00.000Z');
    await db.run(sql`UPDATE tasks SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ${task.id}`);

    const before = mustTask(await getTask(USER, task.id));
    const after = await updateTask(USER, task.id, {});

    expect(after).toEqual(before);
    expect(after?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('не даёт править задачу другого пользователя', async () => {
    const task = await createTask(USER, { title: 'моё' });
    expect(await updateTask(OTHER, task.id, { title: 'взлом' })).toBeNull();
    expect((await getTask(USER, task.id))?.title).toBe('моё');
  });
});

// ---------------------------------------------------------------------------
// 6. Корзина: delete / restore
// ---------------------------------------------------------------------------

describe('tasks: deleteTask и restoreTask', () => {
  it('удаляет задачу каскадом на подзадачи и восстанавливает их', async () => {
    const parent = await createTask(USER, { title: 'parent' });
    const child = await createTask(USER, { title: 'child', parentId: parent.id });

    expect(await deleteTask(USER, parent.id)).toBe(true);
    expect(await getTask(USER, parent.id)).toBeNull();
    expect(await getTask(USER, child.id)).toBeNull();

    const deletedParent = mustTask(await getTask(USER, parent.id, { includeDeleted: true }));
    const deletedChild = mustTask(await getTask(USER, child.id, { includeDeleted: true }));
    expect(deletedParent.deletedAt).not.toBeNull();
    expect(deletedChild.deletedAt).toBe(deletedParent.deletedAt);

    const restored = mustTask(await restoreTask(USER, parent.id));
    expect(restored.id).toBe(parent.id);
    expect(restored.deletedAt).toBeNull();
    expect((await getTask(USER, child.id))?.deletedAt).toBeNull();
  });

  it('повторное удаление возвращает false, восстановление несуществующего — null', async () => {
    const task = await createTask(USER, { title: 'раз' });
    expect(await deleteTask(USER, task.id)).toBe(true);
    expect(await deleteTask(USER, task.id)).toBe(false);

    const active = await createTask(USER, { title: 'два' });
    expect(await restoreTask(USER, active.id)).toBeNull();
    expect(await restoreTask(USER, 999_999)).toBeNull();
  });

  it('каскад не задевает подзадачи другого пользователя с тем же parent_id', async () => {
    const mine = await createTask(USER, { title: 'моё' });
    const foreignChild = await createTask(OTHER, { title: 'чужой ребёнок', parentId: mine.id });

    expect(await deleteTask(USER, mine.id)).toBe(true);
    expect(await getTask(OTHER, foreignChild.id)).not.toBeNull();

    expect(await deleteTask(OTHER, mine.id)).toBe(false);
    expect(await restoreTask(OTHER, mine.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. completeTask без повтора
// ---------------------------------------------------------------------------

describe('tasks: completeTask без повтора', () => {
  it('ставит done и каскадом завершает подзадачи', async () => {
    const parent = await createTask(USER, { title: 'parent' });
    const child = await createTask(USER, { title: 'child', parentId: parent.id });

    const result = await completeTask(USER, parent.id);
    expect(result.completed).toBe(true);
    expect(result.nextTask).toBeNull();

    const done = mustTask(await getTask(USER, parent.id));
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();

    const doneChild = mustTask(await getTask(USER, child.id));
    expect(doneChild.status).toBe('done');
    expect(doneChild.completedAt).not.toBeNull();
  });

  it('несуществующая и удалённая задача — completed: false', async () => {
    expect(await completeTask(USER, 999_999)).toEqual({ completed: false, nextTask: null });

    const task = await createTask(USER, { title: 'в корзине' });
    await deleteTask(USER, task.id);
    expect(await completeTask(USER, task.id)).toEqual({ completed: false, nextTask: null });
  });

  it('не завершает задачи других пользователей', async () => {
    const mine = await createTask(USER, { title: 'моё' });
    expect(await completeTask(OTHER, mine.id)).toEqual({ completed: false, nextTask: null });
    expect((await getTask(USER, mine.id))?.status).toBe('todo');

    // подзадача другого юзера с тем же parent_id остаётся активной
    const foreignChild = await createTask(OTHER, { title: 'чужое', parentId: mine.id });
    await completeTask(USER, mine.id);
    expect((await getTask(OTHER, foreignChild.id))?.status).toBe('todo');
  });

  it('повторное завершение не падает и не плодит дублей', async () => {
    const task = await createTask(USER, { title: 'одна' });
    const first = await completeTask(USER, task.id);
    const second = await completeTask(USER, task.id);

    expect(first).toEqual({ completed: true, nextTask: null });
    expect(second).toEqual({ completed: true, nextTask: null });
    expect(await listTasks(USER, { includeDeleted: true })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. completeTask с повтором
// ---------------------------------------------------------------------------

describe('tasks: completeTask с повтором', () => {
  const PAST = '2020-01-01T09:00:00.000Z';

  it('спавнит следующую итерацию в будущем и копирует поля', async () => {
    const original = await createTask(USER, {
      title: 'Зарядка',
      notes: '10 минут',
      categoryId: 7,
      subcategoryId: 8,
      position: 3,
      dueAt: PAST,
      remindAt: PAST,
      recurrence: { freq: 'daily' },
    });

    const result = await completeTask(USER, original.id);
    expect(result.completed).toBe(true);
    const next = mustTask(result.nextTask);

    expect(next.id).not.toBe(original.id);
    expect(next.title).toBe('Зарядка');
    expect(next.notes).toBe('10 минут');
    expect(next.categoryId).toBe(7);
    expect(next.subcategoryId).toBeNull();
    expect(next.status).toBe('todo');
    expect(next.recurrence).toEqual({ freq: 'daily' });
    expect(new Date(String(next.remindAt)).getTime()).toBe(
      new Date(String(next.dueAt)).getTime() - 60 * 60_000,
    );
    expect(next.dueAt).not.toBe(PAST);
    // строго будущее, но не дальше одного шага daily (слот сохраняет 09:00 UTC)
    const nextAt = new Date(String(next.dueAt)).getTime();
    const nowMs = Date.now();
    expect(nextAt).toBeGreaterThan(nowMs);
    expect(nextAt - nowMs).toBeLessThanOrEqual(DAY);
    expect(new Date(nextAt).getUTCHours()).toBe(9);
    expect(next.reminderSent).toBe(false);

    const done = mustTask(await getTask(USER, original.id));
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    expect(await listTasks(USER)).toHaveLength(2);
  });

  it('уменьшает count: 3 → 2 → 1 → null', async () => {
    const first = await createTask(USER, {
      title: 'Полив',
      dueAt: PAST,
      recurrence: { freq: 'daily', count: 3 },
    });

    const step1 = await completeTask(USER, first.id);
    const second = mustTask(step1.nextTask);
    expect(second.recurrence).toEqual({ freq: 'daily', count: 2 });

    const step2 = await completeTask(USER, second.id);
    const third = mustTask(step2.nextTask);
    expect(third.recurrence).toEqual({ freq: 'daily', count: 1 });

    const step3 = await completeTask(USER, third.id);
    expect(step3.nextTask).toBeNull();
    expect(step3.completed).toBe(true);
    expect(await listTasks(USER)).toHaveLength(3);
  });

  it('не спавнит итерацию за пределами until', async () => {
    const task = await createTask(USER, {
      title: 'Просроченный повтор',
      dueAt: PAST,
      recurrence: { freq: 'daily', until: '2020-01-05' },
    });

    const result = await completeTask(USER, task.id);
    expect(result.completed).toBe(true);
    expect(result.nextTask).toBeNull();
  });

  it('без due_at/remind_at считает от текущего момента и всё равно спавнит', async () => {
    const task = await createTask(USER, { title: 'Ежедневник', recurrence: { freq: 'daily' } });

    const result = await completeTask(USER, task.id);
    const next = mustTask(result.nextTask);
    const nextTime = new Date(String(next.dueAt)).getTime();
    expect(nextTime).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(nextTime).toBeLessThan(Date.now() + 25 * HOUR);
    expect(new Date(String(next.remindAt)).getTime()).toBe(
      new Date(String(next.dueAt)).getTime() - 60 * 60_000,
    );
  });

  it('правило берёт из колонки, а не из notes', async () => {
    const task = await createTask(USER, {
      title: 'Без правила',
      notes: '{"freq": "daily"}',
      dueAt: PAST,
    });

    const result = await completeTask(USER, task.id);
    expect(result.nextTask).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. nextOccurrence — чистая арифметика
// ---------------------------------------------------------------------------

describe('tasks: nextOccurrence', () => {
  const base = at('2026-11-01T09:00:00.000Z');

  it('daily: шагает строго в будущее с учётом interval', () => {
    expect(iso(nextOccurrence({ freq: 'daily' }, base, base) as Date)).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(
      iso(nextOccurrence({ freq: 'daily', interval: 3 }, base, at('2026-11-10T12:00:00.000Z')) as Date),
    ).toBe('2026-11-13T09:00:00.000Z');
    // ровно сутки назад → ближайший кандидат равен now, значит берём следующий
    const almost = new Date(base.getTime() + DAY - HOUR);
    expect(iso(nextOccurrence({ freq: 'daily' }, base, almost) as Date)).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(
      iso(nextOccurrence({ freq: 'daily' }, base, new Date(base.getTime() + DAY)) as Date),
    ).toBe('2026-11-03T09:00:00.000Z');
  });

  it('daily: битый interval трактуется как 1', () => {
    expect(iso(nextOccurrence({ freq: 'daily', interval: 0 }, base, base) as Date)).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(iso(nextOccurrence({ freq: 'daily', interval: -5 }, base, base) as Date)).toBe(
      '2026-11-02T09:00:00.000Z',
    );
  });

  it('weekly: без weekdays — раз в N недель', () => {
    expect(iso(nextOccurrence({ freq: 'weekly' }, base, base) as Date)).toBe(
      '2026-11-08T09:00:00.000Z',
    );
    expect(iso(nextOccurrence({ freq: 'weekly', interval: 2 }, base, base) as Date)).toBe(
      '2026-11-15T09:00:00.000Z',
    );
  });

  it('weekly: weekdays 0=Пн … 6=Вс, interval игнорируется', () => {
    const monday = at('2026-11-02T09:00:00.000Z');
    expect(iso(nextOccurrence({ freq: 'weekly', weekdays: [2] }, monday, monday) as Date)).toBe(
      '2026-11-04T09:00:00.000Z',
    );
    // тот же день недели, что и база, — берём следующую неделю
    expect(iso(nextOccurrence({ freq: 'weekly', weekdays: [0] }, monday, monday) as Date)).toBe(
      '2026-11-09T09:00:00.000Z',
    );
    // мусорные значения отбрасываются
    expect(
      iso(nextOccurrence({ freq: 'weekly', weekdays: [9, 2] }, monday, monday) as Date),
    ).toBe('2026-11-04T09:00:00.000Z');
    // все значения мусорные → деградация до «раз в неделю»
    expect(iso(nextOccurrence({ freq: 'weekly', weekdays: [9] }, monday, monday) as Date)).toBe(
      '2026-11-09T09:00:00.000Z',
    );
    expect(iso(nextOccurrence({ freq: 'weekly', weekdays: [] }, monday, monday) as Date)).toBe(
      '2026-11-09T09:00:00.000Z',
    );
    // interval не влияет на выбор дня недели
    expect(
      iso(nextOccurrence({ freq: 'weekly', weekdays: [2], interval: 5 }, monday, monday) as Date),
    ).toBe('2026-11-04T09:00:00.000Z');
  });

  it('monthly: кламп дня «прилипает» (31 янв → 28 фев → 28 мар)', () => {
    const jan31 = at('2026-01-31T09:00:00.000Z');
    const feb28 = nextOccurrence({ freq: 'monthly' }, jan31, jan31) as Date;
    expect(dateKey(feb28)).toBe('2026-02-28');
    expect(iso(feb28)).toBe('2026-02-28T09:00:00.000Z');

    expect(iso(nextOccurrence({ freq: 'monthly' }, feb28, feb28) as Date)).toBe(
      '2026-03-28T09:00:00.000Z',
    );
    // interval 2 сохраняет день, если он есть в целевом месяце
    expect(iso(nextOccurrence({ freq: 'monthly', interval: 2 }, jan31, jan31) as Date)).toBe(
      '2026-03-31T09:00:00.000Z',
    );
  });

  it('yearly: 29 фев → 28 фев в невисокосный год', () => {
    const leap = at('2024-02-29T09:00:00.000Z');
    const next = nextOccurrence({ freq: 'yearly' }, leap, leap) as Date;
    expect(iso(next)).toBe('2025-02-28T09:00:00.000Z');
    expect(iso(nextOccurrence({ freq: 'yearly' }, next, next) as Date)).toBe(
      '2026-02-28T09:00:00.000Z',
    );
    expect(iso(nextOccurrence({ freq: 'yearly', interval: 2 }, leap, leap) as Date)).toBe(
      '2026-02-28T09:00:00.000Z',
    );
  });

  it('until включительно: дата ровно until допустима, следующая — уже нет', () => {
    const nov3 = at('2026-11-03T09:00:00.000Z');
    const now = at('2026-11-03T12:00:00.000Z');

    expect(
      iso(nextOccurrence({ freq: 'daily', until: '2026-11-04' }, nov3, now) as Date),
    ).toBe('2026-11-04T09:00:00.000Z');
    expect(nextOccurrence({ freq: 'daily', until: '2026-11-03' }, nov3, now)).toBeNull();
    expect(nextOccurrence({ freq: 'daily', until: '2026-11-02' }, nov3, now)).toBeNull();
  });

  it('неизвестная частота → null', () => {
    const bogus = { freq: 'hourly' } as unknown as RecurrenceRule;
    expect(nextOccurrence(bogus, base, base)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Матрица изоляции
// ---------------------------------------------------------------------------

describe('tasks: изоляция пользователей', () => {
  it('полный жизненный цикл юзера А не меняет данные юзера Б', async () => {
    await ensureSystemCategories(OTHER);
    const otherCategory = await findCategoryByName(OTHER, 'Быт');
    const otherTask = await createTask(OTHER, {
      title: 'чужое',
      categoryId: otherCategory?.id ?? null,
      recurrence: { freq: 'weekly' },
    });
    const before = await snapshot(OTHER);

    await ensureSystemCategories(USER);
    const parent = await createTask(USER, { title: 'моё', recurrence: { freq: 'daily' } });
    await createTask(USER, { title: 'подзадача', parentId: parent.id });
    await updateTask(USER, parent.id, { title: 'переименовано', notes: 'x' });
    await completeTask(USER, parent.id);
    await deleteTask(USER, parent.id);
    await restoreTask(USER, parent.id);
    expect(await getTask(USER, otherTask.id)).toBeNull();

    expect(await snapshot(OTHER)).toBe(before);
    // и свои данные на месте
    expect((await listTasks(USER, { includeDeleted: true })).length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 11. item_type (task vs event) и авто-продвижение
// ---------------------------------------------------------------------------

describe('tasks: item_type (task vs event) и авто-продвижение', () => {
  it('по умолчанию создаётся с itemType = task', async () => {
    const task = await createTask(USER, { title: 'Обычная задача' });
    expect(task.itemType).toBe('task');
    const read = await getTask(USER, task.id);
    expect(read?.itemType).toBe('task');
  });

  it('создаётся с явным itemType = event', async () => {
    const event = await createTask(USER, {
      title: 'Воскресное собрание',
      itemType: 'event',
      dueAt: '2026-11-08T10:00:00.000Z',
    });
    expect(event.itemType).toBe('event');
    const read = await getTask(USER, event.id);
    expect(read?.itemType).toBe('event');
  });

  it('updateTask позволяет менять itemType', async () => {
    const item = await createTask(USER, { title: 'План' });
    expect(item.itemType).toBe('task');
    const updated = await updateTask(USER, item.id, { itemType: 'event' });
    expect(updated?.itemType).toBe('event');
  });

  it('completeTask сохраняет itemType для следующего повторения', async () => {
    const event = await createTask(USER, {
      title: 'Еженедельный разбор',
      itemType: 'event',
      dueAt: '2026-11-01T18:00:00.000Z',
      recurrence: { freq: 'weekly' },
    });
    const res = await completeTask(USER, event.id);
    expect(res.completed).toBe(true);
    expect(res.nextTask?.itemType).toBe('event');
  });

  it('listTasks фильтрует по itemType', async () => {
    await createTask(USER, { title: 'Задача 1', itemType: 'task' });
    await createTask(USER, { title: 'Событие 1', itemType: 'event' });
    const onlyTasks = await listTasks(USER, { itemType: 'task' });
    const onlyEvents = await listTasks(USER, { itemType: 'event' });
    expect(onlyTasks.every((t) => t.itemType === 'task')).toBe(true);
    expect(onlyEvents.every((t) => t.itemType === 'event')).toBe(true);
  });

  it('autoAdvancePastEvents: разовое прошедшее событие автоматически завершается', async () => {
    const pastOneOff = await createTask(USER, {
      title: 'Разовый концерт',
      itemType: 'event',
      dueAt: '2026-11-01T12:00:00.000Z',
    });
    const result = await autoAdvancePastEvents(USER, new Date('2026-11-07T12:00:00.000Z'));
    expect(result.completed).toBe(1);
    const updated = await getTask(USER, pastOneOff.id);
    expect(updated?.status).toBe('done');
  });

  it('autoAdvancePastEvents: повторяющееся прошедшее событие сдвигается на следующий период', async () => {
    const pastRecurring = await createTask(USER, {
      title: 'Еженедельная молитва',
      itemType: 'event',
      dueAt: '2026-11-01T10:00:00.000Z',
      recurrence: { freq: 'weekly' },
    });
    const result = await autoAdvancePastEvents(USER, new Date('2026-11-07T12:00:00.000Z'));
    expect(result.advanced).toBe(1);
    const updated = await getTask(USER, pastRecurring.id);
    expect(updated?.status).toBe('todo');
    expect(new Date(updated!.dueAt!).getTime()).toBeGreaterThan(new Date('2026-11-07T12:00:00.000Z').getTime());
  });
});
