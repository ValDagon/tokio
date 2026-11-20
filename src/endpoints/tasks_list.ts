/**
 * GET /api/tasks — список корневых задач с подзадачами-шагами.
 *
 * Паритет с `backend/app/api/routes.py::get_tasks`:
 *  - `status` по умолчанию `"todo"`; пустая строка/не задан — фильтра нет
 *    (upstream: `status: str = "todo"` + `if status:`);
 *  - только корневые задачи (`parent_id IS NULL`) и не удалённые;
 *  - шаги подтягиваются для возвращённых корней без фильтра по статусу и
 *    сортируются `position, created_at` (в routes.py второй запрос
 *    `WHERE parent_id = ANY(...) AND deleted_at IS NULL`);
 *  - порядок корней: `remind_at NULLS LAST, created_at DESC`. DAL умеет только
 *    `created_at DESC, id DESC`, поэтому пересортировываем в памяти;
 *  - `subcategory_id` DAL не фильтрует — фильтруем корни в памяти после чтения;
 *  - `recurrence` в ответе — объект (`TaskResponseSchema.recurrence: str|None` в
 *    upstream, но DAL уже распарсил json-колонку; битый json → `null`).
 *
 * Отличия от upstream (осознанные):
 *  - `autoAdvance` внутри `listTasks` сдвигает прошедшие события — это штатное
 *    поведение DAL, к паритету запроса не относится;
 *  - у DAL дефолтный `LIMIT 100`, поэтому передаём `limit: 1000`: upstream
 *    отдавал весь список без пагинации.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import {
  ensureSystemCategories,
  listCategories,
  listSubcategories,
  listTasks,
} from '../lib/dal/tasks.js';
import { ensureUser } from '../lib/dal/users.js';
import type { RecurrenceRule, TaskRow, TaskStatus } from '../types.js';

/** `TaskResponseSchema` из routes.py. */
interface TaskResponse {
  id: string;
  title: string;
  status: string;
  notes: string | null;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  steps: Array<{ id: string; title: string; status: string; position: number }>;
  created_at: string;
  due_at: string | null;
  remind_at: string | null;
  recurrence: RecurrenceRule | null;
}

/** `ORDER BY remind_at NULLS LAST, created_at DESC`. */
function compareRootTasks(a: TaskRow, b: TaskRow): number {
  if ((a.remindAt === null) !== (b.remindAt === null)) {
    return a.remindAt === null ? 1 : -1;
  }
  if (a.remindAt !== null && b.remindAt !== null && a.remindAt !== b.remindAt) {
    return a.remindAt < b.remindAt ? -1 : 1;
  }
  const aCreated = a.createdAt ?? '';
  const bCreated = b.createdAt ?? '';
  if (aCreated === bCreated) return b.id - a.id;
  return aCreated < bCreated ? 1 : -1;
}

/** `ORDER BY position, created_at`. */
function compareSteps(a: TaskRow, b: TaskRow): number {
  if (a.position !== b.position) return a.position - b.position;
  const aCreated = a.createdAt ?? '';
  const bCreated = b.createdAt ?? '';
  if (aCreated === bCreated) return a.id - b.id;
  return aCreated < bCreated ? -1 : 1;
}

/** Числовой id из тела запроса; `undefined` — поля нет. */
function optionalId(input: Record<string, unknown>, field: string): number | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new EndpointError(`Invalid ${field}`, { code: 'BAD_REQUEST' });
  }
  return parsed;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<TaskResponse[]> {
  const userId = requireUserId(input, ctx);

  await ensureUser(userId);
  await ensureSystemCategories(userId);

  // upstream: `status: str = "todo"`; пустая строка отключает фильтр
  const rawStatus = input.status === undefined || input.status === null ? 'todo' : input.status;
  if (typeof rawStatus !== 'string') {
    throw new EndpointError('Invalid status', { code: 'BAD_REQUEST' });
  }
  const status = rawStatus === '' ? undefined : (rawStatus as TaskStatus);

  const categoryId = optionalId(input, 'category_id');
  const subcategoryId = optionalId(input, 'subcategory_id');

  const roots = (await listTasks(userId, {
    status,
    categoryId,
    parentId: null,
    autoAdvance: true,
    limit: 1000,
  }))
    .filter((task) => subcategoryId === undefined || task.subcategoryId === subcategoryId)
    .sort(compareRootTasks);

  const rootIds = new Set(roots.map((task) => task.id));
  const allTasks = await listTasks(userId, { autoAdvance: false, limit: 1000 });
  const stepsByParent = new Map<number, TaskRow[]>();
  for (const task of allTasks) {
    if (task.parentId === null || !rootIds.has(task.parentId)) continue;
    const bucket = stepsByParent.get(task.parentId);
    if (bucket) bucket.push(task);
    else stepsByParent.set(task.parentId, [task]);
  }

  const categories = await listCategories(userId);
  const subcategoriesByCategory = await Promise.all(
    categories.map((category) => listSubcategories(userId, category.id)),
  );
  const categoryNames = new Map<number, string>(
    categories.map((category) => [category.id, category.name] as const),
  );
  const subcategoryNames = new Map<number, string>(
    subcategoriesByCategory
      .flat()
      .map((subcategory) => [subcategory.id, subcategory.name] as const),
  );

  return roots.map((task) => ({
    id: String(task.id),
    title: task.title,
    status: task.status,
    notes: task.notes,
    category_id: task.categoryId === null ? null : String(task.categoryId),
    category_name: task.categoryId === null ? null : categoryNames.get(task.categoryId) ?? null,
    subcategory_id: task.subcategoryId === null ? null : String(task.subcategoryId),
    subcategory_name:
      task.subcategoryId === null ? null : subcategoryNames.get(task.subcategoryId) ?? null,
    steps: [...(stepsByParent.get(task.id) ?? [])].sort(compareSteps).map((step) => ({
      id: String(step.id),
      title: step.title,
      status: step.status,
      position: step.position,
    })),
    created_at: task.createdAt ?? '',
    due_at: task.dueAt,
    remind_at: task.remindAt,
    recurrence: task.recurrence,
  }));
}
