/**
 * DAL: задачи — `task_categories`, `task_subcategories`, `tasks`.
 *
 * Паритет с Python-бэкендом:
 *  - системные категории и сабки — `backend/app/agent/tools/tasks.py`
 *    (`DEFAULT_CATEGORIES` / `DEFAULT_SUBCATEGORIES`);
 *  - завершение с повтором — `backend/app/services/tasks.py`
 *    (`complete_task_with_recurrence`);
 *  - корзина (soft delete с каскадом на подзадачи) —
 *    `backend/app/services/trash.py` (`soft_delete_task` / `restore_trash_item`).
 *
 * Правила слоя (см. SPEC §2.5):
 *  - каждый запрос принудительно ограничен `user_id` — «прочитать всё» невозможно;
 *  - FK на платформе нет (§2.3), целостность держится здесь: родитель/категория
 *    не проверяются базой, поэтому все UPDATE/DELETE дополнительно скоупятся юзером;
 *  - весь SQL — только через sql-тег с именованными параметрами `:pN`
 *    (никакой конкатенации строк, никакой динамической сборки SET — для частичных
 *    апдейтов используется read-merge-write с ОДНИМ фиксированным UPDATE);
 *  - кодирование значений ручное, т.к. мок/платформа НЕ декодируют строки при чтении:
 *    boolean → 0/1, `recurrence` → `JSON.stringify` / `JSON.parse`,
 *    даты → только ISO-строки (`nowIso()` / `toIso()`), `undefined` не передаём.
 */

import { db, sql } from 'sdk/db';
import { withTransaction } from './finances.js';
import type {
  RecurrenceRule,
  TaskCategoryRow,
  TaskItemType,
  TaskRow,
  TaskStatus,
  TaskSubcategoryRow,
} from '../../types.js';
import { addDays, dateKey, fromIso, nowIso, toIso } from '../utils.js';

// ---------------------------------------------------------------------------
// Внутренние строки БД (snake_case, сырые значения как они лежат в SQLite)
// ---------------------------------------------------------------------------

interface TaskCategoryDbRow {
  id: number;
  user_id: number;
  name: string;
  color: string | null;
  position: number;
  created_at: string | null;
}

interface TaskSubcategoryDbRow {
  id: number;
  user_id: number;
  category_id: number;
  name: string;
  position: number;
  created_at: string | null;
}

interface TaskDbRow {
  id: number;
  user_id: number;
  category_id: number | null;
  subcategory_id: number | null;
  parent_id: number | null;
  title: string;
  notes: string | null;
  status: string;
  item_type?: string | null;
  position: number;
  source_text: string | null;
  created_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  due_at: string | null;
  remind_at: string | null;
  reminder_sent: number | boolean;
  recurrence: string | null;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Кодирование/декодирование значений
// ---------------------------------------------------------------------------

const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];

const RECURRENCE_FREQS: readonly RecurrenceRule['freq'][] = ['daily', 'weekly', 'monthly', 'yearly'];

/**
 * Строка из БД → статус. Неизвестное значение (старые данные, ручная правка)
 * трактуем как `todo`: без статуса задача остаётся активной, а не «пропадает».
 */
function toTaskStatus(value: string | null | undefined): TaskStatus {
  const status = String(value ?? '').trim();
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : 'todo';
}

/** json-колонка `recurrence` → правило. `null`, битый json и мусор → `null`. */
function parseRecurrence(raw: string | null | undefined): RecurrenceRule | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rule = parsed as RecurrenceRule;
    if (!RECURRENCE_FREQS.includes(rule.freq)) return null;
    return rule;
  } catch {
    // битый json в колонке — молча считаем, что правила нет
    return null;
  }
}

/** Правило → json-текст колонки `recurrence` (пустая строка/`undefined` → NULL). */
function encodeRecurrence(rule: RecurrenceRule | null | undefined): string | null {
  return rule ? JSON.stringify(rule) : null;
}

function mapCategory(row: TaskCategoryDbRow): TaskCategoryRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color ?? null,
    position: row.position,
    createdAt: row.created_at ?? null,
  };
}

function mapSubcategory(row: TaskSubcategoryDbRow): TaskSubcategoryRow {
  return {
    id: row.id,
    userId: row.user_id,
    categoryId: row.category_id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at ?? null,
  };
}

function mapTask(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    userId: row.user_id,
    categoryId: row.category_id ?? null,
    subcategoryId: row.subcategory_id ?? null,
    parentId: row.parent_id ?? null,
    title: row.title,
    notes: row.notes ?? null,
    status: toTaskStatus(row.status),
    itemType: (row.item_type === 'event' ? 'event' : 'task') as TaskItemType,
    position: row.position ?? 0,
    sourceText: row.source_text ?? null,
    createdAt: row.created_at ?? null,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at ?? null,
    dueAt: row.due_at ?? null,
    remindAt: row.remind_at ?? null,
    // INTEGER 0/1 → boolean (в БД колонка integer, декодируем руками)
    reminderSent: Boolean(row.reminder_sent),
    recurrence: parseRecurrence(row.recurrence),
    deletedAt: row.deleted_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Системные категории
// ---------------------------------------------------------------------------

/** Дефолтные категории (порядок = `position`), как `DEFAULT_CATEGORIES` в Python. */
export const SYSTEM_CATEGORIES: readonly string[] = [
  'Стартап',
  'Фриланс',
  'Поиск работы',
  'Хобби',
  'Быт',
  'Другое',
];

/** Дефолтные сабки по категориям (порядок = `position`). */
export const SYSTEM_SUBCATEGORIES: Readonly<Record<string, readonly string[]>> = {
  Хобби: ['YouTube', 'Церковь'],
  Быт: ['Гигиена и уборка', 'Питание', 'Здоровье', 'Социализация'],
};

/**
 * Идемпотентно создаёт системные категории и подкатегории пользователя.
 *
 * Отличие от Python: там `ON CONFLICT … DO UPDATE SET position = EXCLUDED.position`,
 * то есть при каждом входе пользовательские перестановки категорий затирались.
 * Здесь `DO NOTHING` — юзер мог переставить категории, идемпотентность важнее
 * «правильного» порядка (см. тест «ensure не перезаписывает position»).
 */
export async function ensureSystemCategories(userId: number): Promise<void> {
  const now = nowIso();

  for (const [index, name] of SYSTEM_CATEGORIES.entries()) {
    await db.run(sql`
      INSERT INTO task_categories (user_id, name, position, created_at)
      VALUES (${userId}, ${name}, ${index}, ${now})
      ON CONFLICT (user_id, name) DO NOTHING
    `);

    // id нужен для сабок — читаем и после вставки, и после конфликта
    const category = await db.get<{ id: number }>(sql`
      SELECT id FROM task_categories WHERE user_id = ${userId} AND name = ${name} LIMIT 1
    `);
    if (!category) continue;

    const subcategories = SYSTEM_SUBCATEGORIES[name] ?? [];
    for (const [subIndex, subName] of subcategories.entries()) {
      await db.run(sql`
        INSERT INTO task_subcategories (user_id, category_id, name, position, created_at)
        VALUES (${userId}, ${category.id}, ${subName}, ${subIndex}, ${now})
        ON CONFLICT (category_id, name) DO NOTHING
      `);
    }
  }
}

/** Категории пользователя: `ORDER BY position, id`. */
export async function listCategories(userId: number): Promise<TaskCategoryRow[]> {
  const rows = await db.all<TaskCategoryDbRow>(sql`
    SELECT * FROM task_categories
    WHERE user_id = ${userId}
    ORDER BY position ASC, id ASC
  `);
  return rows.map(mapCategory);
}

/**
 * Категория по точному имени.
 *
 * Python-ветка искала через `ILIKE`, но SQLite `lower()` кириллицу не понижает,
 * поэтому регистронезависимый поиск здесь не работает — сравниваем точно.
 * Вызывающие нормализуют имя сами (как это делает классификатор).
 */
export async function findCategoryByName(
  userId: number,
  name: string,
): Promise<TaskCategoryRow | null> {
  const row = await db.get<TaskCategoryDbRow>(sql`
    SELECT * FROM task_categories WHERE user_id = ${userId} AND name = ${name} LIMIT 1
  `);
  return row ? mapCategory(row) : null;
}

/** Создаёт новую пользовательскую категорию задач. */
export async function createCategory(
  userId: number,
  name: string,
  color?: string | null,
): Promise<TaskCategoryRow> {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('tasks.createCategory: name is required');
  const maxPosRow = await db.get<{ max_pos: number | null }>(sql`
    SELECT MAX(position) as max_pos FROM task_categories WHERE user_id = ${userId}
  `);
  const position = (maxPosRow?.max_pos ?? -1) + 1;
  const now = nowIso();
  const result = await db.run(sql`
    INSERT INTO task_categories (user_id, name, color, position, created_at)
    VALUES (${userId}, ${trimmed}, ${color ?? null}, ${position}, ${now})
    RETURNING id, user_id, name, color, position, created_at
  `);
  const row = result.rows[0] as unknown as TaskCategoryDbRow | undefined;
  if (!row) throw new Error('tasks.createCategory: insert returned no row');
  return mapCategory(row);
}

/** Подкатегории категории: `ORDER BY position, id`. */
export async function listSubcategories(
  userId: number,
  categoryId: number,
): Promise<TaskSubcategoryRow[]> {
  const rows = await db.all<TaskSubcategoryDbRow>(sql`
    SELECT * FROM task_subcategories
    WHERE user_id = ${userId} AND category_id = ${categoryId}
    ORDER BY position ASC, id ASC
  `);
  return rows.map(mapSubcategory);
}

/** Регистронезависимый поиск категории задач в JS (SQLite `lower()` не работает с кириллицей). */
export async function findCategoryByNameInsensitive(
  userId: number,
  name: string,
): Promise<TaskCategoryRow | null> {
  const needle = String(name ?? '').trim().toLowerCase();
  if (!needle) return null;
  const categories = await listCategories(userId);
  return categories.find((cat) => cat.name.trim().toLowerCase() === needle) ?? null;
}

/** Регистронезависимый поиск подкатегории задач в JS (кирилл-безопасный). */
export async function findSubcategoryByNameInsensitive(
  userId: number,
  categoryId: number,
  name: string,
): Promise<TaskSubcategoryRow | null> {
  const needle = String(name ?? '').trim().toLowerCase();
  if (!needle) return null;
  const subs = await listSubcategories(userId, categoryId);
  return subs.find((sub) => sub.name.trim().toLowerCase() === needle) ?? null;
}

/** Обновляет категорию задач (имя, цвет, позиция). */
export async function updateCategory(
  userId: number,
  categoryId: number,
  patch: { name?: string; color?: string | null; position?: number },
): Promise<TaskCategoryRow | null> {
  const categories = await listCategories(userId);
  const current = categories.find((c) => c.id === categoryId) ?? null;
  if (!current) return null;

  let nextName = current.name;
  if (patch.name !== undefined) {
    const trimmed = String(patch.name).trim();
    if (!trimmed) throw new Error('tasks.updateCategory: name cannot be empty');
    const conflict = categories.find(
      (c) => c.id !== categoryId && c.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (conflict) {
      throw new Error(`tasks.updateCategory: category "${conflict.name}" already exists`);
    }
    nextName = trimmed;
  }
  const nextColor = patch.color !== undefined ? patch.color : current.color;
  const nextPosition =
    typeof patch.position === 'number' && Number.isFinite(patch.position)
      ? Math.trunc(patch.position)
      : current.position;

  await db.run(sql`
    UPDATE task_categories
    SET name = ${nextName}, color = ${nextColor}, position = ${nextPosition}
    WHERE id = ${categoryId} AND user_id = ${userId}
  `);

  const updated = await db.get<TaskCategoryDbRow>(sql`
    SELECT * FROM task_categories WHERE id = ${categoryId} AND user_id = ${userId} LIMIT 1
  `);
  return updated ? mapCategory(updated) : null;
}

/**
 * Безопасно удаляет категорию задач: отвязывает задачи (`category_id = NULL`,
 * `subcategory_id = NULL`), удаляет её подкатегории и саму категорию. Задачи не удаляются.
 */
export async function deleteCategory(
  userId: number,
  categoryId: number,
): Promise<{ deleted: boolean; unlinkedTasks: number }> {
  const current = await db.get<{ id: number }>(sql`
    SELECT id FROM task_categories WHERE id = ${categoryId} AND user_id = ${userId} LIMIT 1
  `);
  if (!current) return { deleted: false, unlinkedTasks: 0 };

  return withTransaction(async () => {
    const unlinkRes = await db.run(sql`
      UPDATE tasks
      SET category_id = NULL, subcategory_id = NULL, updated_at = ${nowIso()}
      WHERE user_id = ${userId} AND category_id = ${categoryId}
    `);
    await db.run(sql`
      DELETE FROM task_subcategories WHERE user_id = ${userId} AND category_id = ${categoryId}
    `);
    await db.run(sql`
      DELETE FROM task_categories WHERE id = ${categoryId} AND user_id = ${userId}
    `);
    return { deleted: true, unlinkedTasks: Number(unlinkRes.rowsAffected ?? 0) };
  });
}

/** Создаёт подкатегорию задач внутри категории владельца. */
export async function createSubcategory(
  userId: number,
  categoryId: number,
  name: string,
  position?: number,
): Promise<TaskSubcategoryRow> {
  const cat = await db.get<{ id: number }>(sql`
    SELECT id FROM task_categories WHERE id = ${categoryId} AND user_id = ${userId} LIMIT 1
  `);
  if (!cat) throw new Error(`tasks.createSubcategory: category ${categoryId} not found`);

  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('tasks.createSubcategory: name is required');

  const existing = await listSubcategories(userId, categoryId);
  const conflict = existing.find((s) => s.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (conflict) {
    throw new Error(`tasks.createSubcategory: subcategory "${conflict.name}" already exists`);
  }

  const nextPos =
    typeof position === 'number' && Number.isFinite(position)
      ? Math.trunc(position)
      : existing.reduce((max, s) => Math.max(max, s.position), -1) + 1;

  const now = nowIso();
  const res = await db.run(sql`
    INSERT INTO task_subcategories (user_id, category_id, name, position, created_at)
    VALUES (${userId}, ${categoryId}, ${trimmed}, ${nextPos}, ${now})
    RETURNING id, user_id, category_id, name, position, created_at
  `);
  const row = res.rows[0] as unknown as TaskSubcategoryDbRow | undefined;
  if (!row) throw new Error('tasks.createSubcategory: insert returned no row');
  return mapSubcategory(row);
}

/** Обновляет подкатегорию задач (имя, позиция). */
export async function updateSubcategory(
  userId: number,
  subcategoryId: number,
  patch: { name?: string; position?: number },
): Promise<TaskSubcategoryRow | null> {
  const row = await db.get<TaskSubcategoryDbRow>(sql`
    SELECT * FROM task_subcategories WHERE id = ${subcategoryId} AND user_id = ${userId} LIMIT 1
  `);
  if (!row) return null;
  const current = mapSubcategory(row);

  let nextName = current.name;
  if (patch.name !== undefined) {
    const trimmed = String(patch.name).trim();
    if (!trimmed) throw new Error('tasks.updateSubcategory: name cannot be empty');
    const siblings = await listSubcategories(userId, current.categoryId);
    const conflict = siblings.find(
      (s) => s.id !== subcategoryId && s.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (conflict) {
      throw new Error(`tasks.updateSubcategory: subcategory "${conflict.name}" already exists`);
    }
    nextName = trimmed;
  }
  const nextPosition =
    typeof patch.position === 'number' && Number.isFinite(patch.position)
      ? Math.trunc(patch.position)
      : current.position;

  await db.run(sql`
    UPDATE task_subcategories
    SET name = ${nextName}, position = ${nextPosition}
    WHERE id = ${subcategoryId} AND user_id = ${userId}
  `);

  const updated = await db.get<TaskSubcategoryDbRow>(sql`
    SELECT * FROM task_subcategories WHERE id = ${subcategoryId} AND user_id = ${userId} LIMIT 1
  `);
  return updated ? mapSubcategory(updated) : null;
}

/** Безопасно удаляет подкатегорию: отвязывает задачи (`subcategory_id = NULL`), не удаляя сами задачи. */
export async function deleteSubcategory(
  userId: number,
  subcategoryId: number,
): Promise<{ deleted: boolean; unlinkedTasks: number }> {
  const row = await db.get<{ id: number }>(sql`
    SELECT id FROM task_subcategories WHERE id = ${subcategoryId} AND user_id = ${userId} LIMIT 1
  `);
  if (!row) return { deleted: false, unlinkedTasks: 0 };

  return withTransaction(async () => {
    const unlinkRes = await db.run(sql`
      UPDATE tasks
      SET subcategory_id = NULL, updated_at = ${nowIso()}
      WHERE user_id = ${userId} AND subcategory_id = ${subcategoryId}
    `);
    await db.run(sql`
      DELETE FROM task_subcategories WHERE id = ${subcategoryId} AND user_id = ${userId}
    `);
    return { deleted: true, unlinkedTasks: Number(unlinkRes.rowsAffected ?? 0) };
  });
}

// ---------------------------------------------------------------------------
// Задачи: создание и чтение
// ---------------------------------------------------------------------------

export interface TaskCreateInput {
  title: string;
  categoryId?: number | null;
  subcategoryId?: number | null;
  parentId?: number | null;
  notes?: string | null;
  status?: TaskStatus;
  itemType?: TaskItemType;
  position?: number;
  sourceText?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  recurrence?: RecurrenceRule | null;
}

/**
 * Вычисляет время напоминания за 1 час (60 минут) до dueAt.
 * Предотвращает ситуацию, когда напоминание приходит в момент начала события.
 */
export function defaultRemindAtForDue(dueAt: string | Date | null | undefined): string | null {
  if (!dueAt) return null;
  const d = typeof dueAt === 'string' ? fromIso(dueAt) ?? new Date(dueAt) : dueAt;
  if (!d || isNaN(d.getTime())) return null;
  return toIso(new Date(d.getTime() - 60 * 60_000));
}

/**
 * Разрешает remindAt с учётом правила «за 1 час до срока»:
 *  - если remindAt явно передан и отличается от dueAt — сохраняет его;
 *  - если remindAt опущен или равен dueAt — ставит за 60 минут до dueAt.
 */
export function resolveRemindAt(
  dueAt: string | null | undefined,
  remindAt: string | null | undefined,
): string | null {
  if (!dueAt) return remindAt ?? null;
  if (!remindAt || remindAt === dueAt) {
    return defaultRemindAtForDue(dueAt);
  }
  return remindAt;
}

/**
 * Создаёт задачу и возвращает вставленную строку.
 *
 * Форма INSERT фиксированная (динамическая сборка колонок через sql.join не
 * поддерживается), поэтому дефолты схемы для `status`/`position`/`reminder_sent`
 * продублированы в коде явно — итоговая строка от этого не меняется.
 */
export async function createTask(userId: number, input: TaskCreateInput): Promise<TaskRow> {
  const now = nowIso();
  const itemType = input.itemType === 'event' ? 'event' : 'task';
  const result = await db.run(sql`
    INSERT INTO tasks (
      user_id, category_id, subcategory_id, parent_id, title, notes, status, item_type, position,
      source_text, created_at, updated_at, due_at, remind_at, reminder_sent, recurrence
    ) VALUES (
      ${userId}, ${input.categoryId ?? null}, ${input.subcategoryId ?? null},
      ${input.parentId ?? null}, ${input.title}, ${input.notes ?? null},
      ${input.status ?? 'todo'}, ${itemType}, ${input.position ?? 0}, ${input.sourceText ?? null},
      ${now}, ${now}, ${input.dueAt ?? null}, ${input.remindAt ?? null},
      0, ${encodeRecurrence(input.recurrence)}
    )
    RETURNING *
  `);

  const row = result.rows[0] as unknown as TaskDbRow | undefined;
  if (!row) throw new Error('tasks.createTask: INSERT returned no row');
  return mapTask(row);
}

/** Задача по id. Удалённые (в корзине) видны только с `includeDeleted`. */
export async function getTask(
  userId: number,
  taskId: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<TaskRow | null> {
  const includeDeleted = opts.includeDeleted === true ? 1 : 0;
  const row = await db.get<TaskDbRow>(sql`
    SELECT * FROM tasks
    WHERE id = ${taskId} AND user_id = ${userId}
      AND (${includeDeleted} = 1 OR deleted_at IS NULL)
    LIMIT 1
  `);
  return row ? mapTask(row) : null;
}

export interface TaskListOptions {
  status?: TaskStatus;
  itemType?: TaskItemType;
  categoryId?: number;
  /** null → только корневые (parent_id IS NULL); без ключа → все. */
  parentId?: number | null;
  includeDeleted?: boolean;
  autoAdvance?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Авто-ротация / авто-завершение прошедших событий (`item_type = 'event'`):
 *  - если день события прошёл (due_at < nowIso), и статус всё ещё 'todo':
 *    - при наличии правила повтора: сдвигает due_at / remind_at на следующее вхождение (nextOccurrence)
 *    - при разовом событии (без повтора): мягко завершает (status = 'done') без вины за просрочку.
 */
export async function autoAdvancePastEvents(
  userId: number,
  referenceDate: Date = new Date(),
): Promise<{ advanced: number; completed: number }> {
  const now = toIso(referenceDate);
  const pastEvents = await db.all<TaskDbRow>(sql`
    SELECT * FROM tasks
    WHERE user_id = ${userId}
      AND item_type = 'event'
      AND status = 'todo'
      AND deleted_at IS NULL
      AND due_at IS NOT NULL
      AND due_at < ${now}
  `);

  let advanced = 0;
  let completed = 0;

  for (const row of pastEvents) {
    const task = mapTask(row);
    const rule = task.recurrence;
    if (rule) {
      let base = fromIso(task.dueAt) ?? referenceDate;
      let next = nextOccurrence(rule, base);
      while (next && next.getTime() < referenceDate.getTime()) {
        const nextCycle = nextOccurrence(rule, next);
        if (!nextCycle || nextCycle.getTime() <= next.getTime()) break;
        next = nextCycle;
      }
      if (next) {
        const nextIso = toIso(next);
        const nextRemindIso = toIso(new Date(next.getTime() - 60 * 60_000));
        await db.run(sql`
          UPDATE tasks SET
            due_at = ${nextIso},
            remind_at = ${nextRemindIso},
            reminder_sent = 0,
            updated_at = ${now}
          WHERE id = ${task.id} AND user_id = ${userId}
        `);
        advanced++;
        continue;
      }
    }

    await db.run(sql`
      UPDATE tasks SET
        status = 'done',
        completed_at = ${now},
        updated_at = ${now}
      WHERE id = ${task.id} AND user_id = ${userId}
    `);
    completed++;
  }

  return { advanced, completed };
}

/**
 * Список задач пользователя, свежие сверху.
 *
 * Фильтры передаются в один статический SQL: отсутствующий фильтр — `NULL`-параметр,
 * который гасит своё условие (`:p IS NULL OR col = :p`). Динамическая склейка WHERE
 * запрещена (SPEC §6: только sql-тег).
 */
export async function listTasks(
  userId: number,
  opts: TaskListOptions = {},
): Promise<TaskRow[]> {
  if (opts.autoAdvance !== false) {
    await autoAdvancePastEvents(userId);
  }

  const status = opts.status ?? null;
  const itemType = opts.itemType ?? null;
  const categoryId = opts.categoryId ?? null;

  // 0 — без фильтра по родителю, 1 — только корневые, 2 — конкретный родитель
  const parentMode = !Object.hasOwn(opts, 'parentId') ? 0 : opts.parentId === null ? 1 : 2;
  const parentId = opts.parentId ?? null;

  const includeDeleted = opts.includeDeleted === true ? 1 : 0;
  const limit = typeof opts.limit === 'number' && Number.isInteger(opts.limit) && opts.limit > 0
    ? opts.limit
    : 100;
  const offset = typeof opts.offset === 'number' && Number.isInteger(opts.offset) && opts.offset > 0
    ? opts.offset
    : 0;

  const rows = await db.all<TaskDbRow>(sql`
    SELECT * FROM tasks
    WHERE user_id = ${userId}
      AND (${status} IS NULL OR status = ${status})
      AND (${itemType} IS NULL OR item_type = ${itemType})
      AND (${categoryId} IS NULL OR category_id = ${categoryId})
      AND (${parentMode} = 0
        OR (${parentMode} = 1 AND parent_id IS NULL)
        OR (${parentMode} = 2 AND parent_id = ${parentId}))
      AND (${includeDeleted} = 1 OR deleted_at IS NULL)
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map(mapTask);
}

// ---------------------------------------------------------------------------
// Задачи: обновление
// ---------------------------------------------------------------------------

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  itemType?: TaskItemType;
  position?: number;
  categoryId?: number | null;
  subcategoryId?: number | null;
  parentId?: number | null;
  sourceText?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  recurrence?: RecurrenceRule | null;
}

/** Известные ключи патча — по ним определяется, изменилось ли что-нибудь. */
const PATCH_KEYS = [
  'title',
  'notes',
  'status',
  'itemType',
  'position',
  'categoryId',
  'subcategoryId',
  'parentId',
  'sourceText',
  'dueAt',
  'remindAt',
  'recurrence',
] as const satisfies readonly (keyof TaskPatch)[];

/**
 * Частичное обновление задачи: read-merge-write.
 *
 * Динамический `SET` на платформе не собрать, поэтому:
 *  1. читаем актуальную строку (удалённая → `null`, апдейта нет);
 *  2. мержим только ПРИСУТСТВУЮЩИЕ ключи патча (`Object.hasOwn`), `null` — явная очистка;
 *  3. пустой патч → UPDATE не выполняется вовсе (`updated_at` не двигается);
 *  4. иначе один фиксированный UPDATE всех мутабельных колонок и перечитывание.
 *
 * `completed_at` здесь не трогается никогда: завершение — только `completeTask`.
 * Если в патче есть `remindAt` (перенос напоминания), флаг `reminder_sent` сбрасывается —
 * паритет с Python `update_task`.
 */
export async function updateTask(
  userId: number,
  taskId: number,
  patch: TaskPatch,
): Promise<TaskRow | null> {
  const current = await db.get<TaskDbRow>(sql`
    SELECT * FROM tasks
    WHERE id = ${taskId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!current) return null;

  const task = mapTask(current);
  const keys = PATCH_KEYS.filter((key) => Object.hasOwn(patch, key) && patch[key] !== undefined);
  if (keys.length === 0) return task;

  const title = patch.title !== undefined ? (patch.title ?? task.title) : task.title;
  const notes = patch.notes !== undefined ? (patch.notes ?? null) : task.notes;
  const status = patch.status !== undefined ? patch.status : task.status;
  const itemType = patch.itemType !== undefined ? patch.itemType : task.itemType;
  const position = patch.position !== undefined ? patch.position : task.position;
  const categoryId = patch.categoryId !== undefined ? (patch.categoryId ?? null) : task.categoryId;
  const subcategoryId = patch.subcategoryId !== undefined ? (patch.subcategoryId ?? null) : task.subcategoryId;
  const parentId = patch.parentId !== undefined ? (patch.parentId ?? null) : task.parentId;
  const sourceText = patch.sourceText !== undefined ? (patch.sourceText ?? null) : task.sourceText;
  const dueAt = patch.dueAt !== undefined ? (patch.dueAt ?? null) : task.dueAt;
  const remindAt = patch.remindAt !== undefined ? (patch.remindAt ?? null) : task.remindAt;
  const recurrence = patch.recurrence !== undefined ? (patch.recurrence ?? null) : task.recurrence;

  // перенос напоминания → флаг отправки сбрасывается (как в Python update_task).
  // Сброс — только при фактической смене значения: PATCH с тем же `remind_at`
  // не должен «переоткрывать» уже доставленное напоминание.
  const remindAtChanged = patch.remindAt !== undefined && remindAt !== task.remindAt;
  const reminderSent = remindAtChanged ? 0 : task.reminderSent ? 1 : 0;
  const updatedAt = nowIso();

  await db.run(sql`
    UPDATE tasks SET
      title = ${title},
      notes = ${notes},
      status = ${status},
      item_type = ${itemType},
      position = ${position},
      category_id = ${categoryId},
      subcategory_id = ${subcategoryId},
      parent_id = ${parentId},
      source_text = ${sourceText},
      due_at = ${dueAt},
      remind_at = ${remindAt},
      recurrence = ${encodeRecurrence(recurrence)},
      reminder_sent = ${reminderSent},
      updated_at = ${updatedAt}
    WHERE id = ${taskId} AND user_id = ${userId} AND deleted_at IS NULL
  `);

  return getTask(userId, taskId);
}

// ---------------------------------------------------------------------------
// Корзина: soft delete / restore (каскад на подзадачи, паритет trash.py)
// ---------------------------------------------------------------------------

/**
 * Отправляет задачу в корзину вместе с подзадачами (`parent_id = taskId`).
 * Каскад — часть контракта; `user_id` в условии обязателен: подзадача другого
 * юзера с тем же `parent_id` не должна пострадать (FK на платформе нет).
 */
export async function deleteTask(userId: number, taskId: number): Promise<boolean> {
  // Корень обязан быть своим и активным: иначе каскад по чужому parent_id
  // задел бы подзадачи «того» пользователя (FK нет, целостность на нас).
  const root = await db.get<{ id: number }>(sql`
    SELECT id FROM tasks
    WHERE id = ${taskId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!root) return false;

  const now = nowIso();
  const result = await db.run(sql`
    UPDATE tasks SET deleted_at = ${now}, updated_at = ${now}
    WHERE (id = ${taskId} OR parent_id = ${taskId})
      AND user_id = ${userId} AND deleted_at IS NULL
  `);
  return result.rowsAffected > 0;
}

/** Возвращает задачу и её подзадачи из корзины. `null`, если восстанавливать было нечего. */
export async function restoreTask(userId: number, taskId: number): Promise<TaskRow | null> {
  const root = await db.get<{ id: number }>(sql`
    SELECT id FROM tasks
    WHERE id = ${taskId} AND user_id = ${userId} AND deleted_at IS NOT NULL
    LIMIT 1
  `);
  if (!root) return null;

  const now = nowIso();
  await db.run(sql`
    UPDATE tasks SET deleted_at = NULL, updated_at = ${now}
    WHERE (id = ${taskId} OR parent_id = ${taskId})
      AND user_id = ${userId} AND deleted_at IS NOT NULL
  `);

  const row = await db.get<TaskDbRow>(sql`
    SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${userId} LIMIT 1
  `);
  return row ? mapTask(row) : null;
}

// ---------------------------------------------------------------------------
// Повторение: чистая арифметика (всё в UTC)
// ---------------------------------------------------------------------------

/** Предохранитель от бесконечного шагания (битое правило/очень старая дата). */
const MAX_STEPS = 100_000;

/** День недели в нотации правила: 0=Пн … 6=Вс. */
function weekdayOf(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/** Сколько дней в месяце (monthIndex — 0..11). */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Тот же момент, но с клампом дня: 31 янв + 1 месяц → 28/29 фев.
 * Время суток сохраняется.
 */
function withClampedDay(date: Date, year: number, monthIndex: number): Date {
  const day = Math.min(date.getUTCDate(), daysInMonth(year, monthIndex));
  return new Date(
    Date.UTC(
      year,
      monthIndex,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** +N месяцев с клампом дня. Кламп «прилипает»: 31 янв → 28 фев → 28 мар. */
function addMonths(date: Date, months: number): Date {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  return withClampedDay(date, year, monthIndex);
}

/** +N лет с тем же клампом (29 фев → 28 фев в невисокосный год). */
function addYears(date: Date, years: number): Date {
  return withClampedDay(date, date.getUTCFullYear() + years, date.getUTCMonth());
}

/** Валидные дни недели без дублей (0..6); мусор отбрасывается. */
function normalizeWeekdays(values: readonly number[] | undefined): number[] {
  const out: number[] = [];
  for (const value of values ?? []) {
    if (!Number.isInteger(value) || value < 0 || value > 6) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Ближайший момент по правилу, строго позже `now`.
 *
 * `count` здесь НЕ обрабатывается — это ответственность `completeTask`.
 * `until` включительно: `dateKey(next) === until` допустимо, больше — `null`.
 * Чистая функция: ни I/O, ни `Date.now()` без явного аргумента.
 */
export function nextOccurrence(
  rule: RecurrenceRule,
  base: Date,
  now: Date = new Date(),
): Date | null {
  if (!RECURRENCE_FREQS.includes(rule.freq)) return null;

  const rawInterval = rule.interval;
  const interval =
    typeof rawInterval === 'number' && Number.isInteger(rawInterval) && rawInterval >= 1
      ? rawInterval
      : 1;

  let step: (from: Date) => Date;
  if (rule.freq === 'daily') {
    step = (from) => addDays(from, interval);
  } else if (rule.freq === 'weekly') {
    const weekdays = normalizeWeekdays(rule.weekdays);
    if (weekdays.length === 0) {
      // без валидных weekdays — просто раз в N недель
      step = (from) => addDays(from, 7 * interval);
    } else {
      // с weekdays: шагаем по одному дню до нужного дня недели (interval игнорируется)
      step = (from) => {
        let candidate = addDays(from, 1);
        for (let guard = 0; guard < 7; guard += 1) {
          if (weekdays.includes(weekdayOf(candidate))) return candidate;
          candidate = addDays(candidate, 1);
        }
        return addDays(from, 7); // недостижимо: какой-то день недели найдётся всегда
      };
    }
  } else if (rule.freq === 'monthly') {
    step = (from) => addMonths(from, interval);
  } else {
    step = (from) => addYears(from, interval);
  }

  const until = rule.until ? String(rule.until) : null;
  let next = step(base);
  for (let guard = 0; guard < MAX_STEPS; guard += 1) {
    // даты монотонно растут → ранний выход по until эквивалентен проверке в конце
    if (until !== null && dateKey(next) > until) return null;
    if (next.getTime() > now.getTime()) return next;
    next = step(next);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Завершение задачи (и спавн следующей по повтору)
// ---------------------------------------------------------------------------

export interface CompleteTaskResult {
  completed: boolean;
  nextTask: TaskRow | null;
}

/**
 * Отмечает задачу выполненной (каскадом — её подзадачи) и при наличии правила
 * повтора создаёт следующую итерацию.
 *
 * Паритет с Python `complete_task_with_recurrence`:
 *  - чтение БЕЗ фильтра по статусу (повторно завершить не страшно);
 *  - UPDATE «id = task OR parent_id = task», но с усилением `user_id` (в Python
 *    подзадачи обновлялись без скоупа) — изоляция юзеров важнее буквального паритета;
 *  - `parse_recurrence(notes)` в порт не входит (T7): правило берём только из колонки;
 *  - следующая задача копирует `category_id`, `title`, `notes`, `recurrence`
 *    (сабкатегорию НЕ копируем — как в Python);
 *  - `count` уменьшается на 1; `count <= 1` — последняя итерация, спавна нет.
 */
export async function completeTask(
  userId: number,
  taskId: number,
): Promise<CompleteTaskResult> {
  const row = await db.get<TaskDbRow>(sql`
    SELECT * FROM tasks
    WHERE id = ${taskId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!row) return { completed: false, nextTask: null };

  const task = mapTask(row);
  const now = nowIso();

  await db.run(sql`
    UPDATE tasks SET status = 'done', completed_at = ${now}, updated_at = ${now}
    WHERE (id = ${taskId} OR parent_id = ${taskId}) AND user_id = ${userId}
  `);

  const rule = task.recurrence;
  if (!rule) return { completed: true, nextTask: null };
  if (rule.count !== undefined && rule.count <= 1) return { completed: true, nextTask: null };

  const base = fromIso(task.dueAt) ?? fromIso(task.remindAt) ?? new Date();
  const next = nextOccurrence(rule, base);
  if (!next) return { completed: true, nextTask: null };

  const nextRule: RecurrenceRule =
    rule.count !== undefined && rule.count > 1 ? { ...rule, count: rule.count - 1 } : rule;
  const nextIso = toIso(next);
  const nextRemindIso = toIso(new Date(next.getTime() - 60 * 60_000));

  // position не задаём — остаётся дефолт схемы (0), как в Python-вставке
  const inserted = await db.run(sql`
    INSERT INTO tasks (
      user_id, category_id, title, notes, status, item_type, recurrence,
      due_at, remind_at, reminder_sent, created_at, updated_at
    ) VALUES (
      ${userId}, ${task.categoryId}, ${task.title}, ${task.notes}, 'todo', ${task.itemType},
      ${encodeRecurrence(nextRule)}, ${nextIso}, ${nextRemindIso}, 0, ${now}, ${now}
    )
    RETURNING *
  `);

  const created = inserted.rows[0] as unknown as TaskDbRow | undefined;
  if (!created) throw new Error('tasks.completeTask: INSERT of the next occurrence returned no row');
  return { completed: true, nextTask: mapTask(created) };
}

// ---------------------------------------------------------------------------
// Задачи: доставка напоминаний
// ---------------------------------------------------------------------------
//
// В изоляте нет таймера, поэтому «крон» ленивый: любой апдейт бота или запрос
// Mini App — повод проверить созревшие напоминания. Инварианты:
//  - `reminder_sent` — единственный флаг доставки, `1` ставится ДО отправки
//    (claim, как в `due_jobs`), иначе два параллельных прохода пришлют дубль;
//  - отправка не удалась — claim снимается, напоминание доставится в следующий раз;
//  - просроченные дольше `REMINDER_MAX_AGE_DAYS` гасим молча: после выката фичи
//    пачка старых `remind_at` не должна вываливаться в чат;
//  - задача выполнена/отменена или удалена — напоминание не доставляется вовсе.

/** Сколько напоминаний доставляем за один проход (остальные — в следующий). */
export const DEFAULT_REMINDERS_PER_PASS = 3;

/** Насколько старое напоминание ещё имеет смысл доставлять. */
export const REMINDER_MAX_AGE_DAYS = 7;

/** Созревшее напоминание: задача, которую пора показать пользователю. */
export async function listDueReminders(
  userId: number,
  now: Date = new Date(),
  limit: number = DEFAULT_REMINDERS_PER_PASS,
): Promise<TaskRow[]> {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_REMINDERS_PER_PASS;
  const nowIsoValue = toIso(now);
  const rows = await db.all<TaskDbRow>(sql`
    SELECT * FROM tasks
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND remind_at IS NOT NULL
      AND reminder_sent = 0
      AND status IN ('todo', 'in_progress')
      AND remind_at <= ${nowIsoValue}
    ORDER BY remind_at ASC, id ASC
    LIMIT ${cap}
  `);
  return rows.map(mapTask);
}

/**
 * Гасит напоминания старше `maxAgeDays` без отправки.
 * Возвращает число погашенных задач.
 */
export async function expireStaleReminders(
  userId: number,
  now: Date = new Date(),
  maxAgeDays: number = REMINDER_MAX_AGE_DAYS,
): Promise<number> {
  const cutoff = toIso(addDays(now, -Math.abs(maxAgeDays)));
  const result = await db.run(sql`
    UPDATE tasks SET reminder_sent = 1
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND remind_at IS NOT NULL
      AND reminder_sent = 0
      AND status IN ('todo', 'in_progress')
      AND remind_at < ${cutoff}
  `);
  return result.rowsAffected;
}

/**
 * Атомарно забирает напоминание под доставку.
 * `true` — этот проход владеет задачей, `false` — её уже забрал другой.
 */
export async function claimReminder(
  userId: number,
  taskId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db.run(sql`
    UPDATE tasks SET reminder_sent = 1, updated_at = ${toIso(now)}
    WHERE id = ${taskId} AND user_id = ${userId} AND reminder_sent = 0
  `);
  return result.rowsAffected > 0;
}

/** Снимает claim после неудачной отправки: доставим в следующий проход. */
export async function releaseReminder(userId: number, taskId: number): Promise<void> {
  await db.run(sql`
    UPDATE tasks SET reminder_sent = 0
    WHERE id = ${taskId} AND user_id = ${userId}
  `);
}
