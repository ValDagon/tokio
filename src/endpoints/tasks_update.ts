/**
 * PATCH /api/tasks/{id} — обновление задачи (id приходит в теле как `id`).
 *
 * Паритет с `backend/app/api/routes.py::update_task`:
 *  - задача ищется среди не удалённых → иначе 404 `"Task not found"`;
 *  - `status === 'done'` → `completeTask` и ответ
 *    `{status:'done', next_task_id, next_occurrence}` (без `id` — ровно как upstream);
 *  - остальные поля патча считаются заданными только если они не `null`
 *    (pydantic-семантика `is not None`): `null` = «не менять», а не «очистить»;
 *  - пустой патч → `{status:'no change'}`;
 *  - иначе `updateTask` и ответ `{status:'updated', id, title, category_id,
 *    category_name, subcategory_id, subcategory_name}`.
 *
 * Отличия от upstream (осознанные):
 *  - `category_name`/`subcategory_name` не принимаются: в `TaskUpdateSchema`
 *    их нет, а `extra="forbid"` в upstream вернул бы 422 — здесь просто
 *    игнорируются;
 *  - вместо `parse_datetime_ru` даты кладутся ISO-строкой (пустая → `null`);
 *  - `recurrence` — JSON-строка/объект; текстовые правила не разбираются;
 *  - id в пути upstream — UUID; у нас число из тела, мусор → 400;
 *  - `updateTask` вернул `null` (строку удалили между проверкой и апдейтом) —
 *    отдаём 404, upstream упал бы на `updated_row["id"]`.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import {
  completeTask,
  getTask,
  listCategories,
  listSubcategories,
  updateTask,
  type TaskPatch,
} from '../lib/dal/tasks.js';
import type { RecurrenceRule, TaskStatus } from '../types.js';

const RECURRENCE_FREQS: readonly RecurrenceRule['freq'][] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
];

/** `recurrence` из тела: JSON-строка или готовый объект → правило либо `null`. */
function parseRecurrenceValue(value: unknown): RecurrenceRule | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rule = parsed as RecurrenceRule;
  if (!RECURRENCE_FREQS.includes(rule.freq)) return null;
  return rule;
}

/** Поле присутствует и не `null` (upstream: `is not None`). */
function isSet(input: Record<string, unknown>, field: string): boolean {
  return input[field] !== undefined && input[field] !== null;
}

/** Обязательная для патча строка (неверный тип → 400, upstream 422). */
function stringValue(input: Record<string, unknown>, field: string): string {
  const raw = input[field];
  if (typeof raw !== 'string') {
    throw new EndpointError(`Invalid ${field}`, { code: 'BAD_REQUEST' });
  }
  return raw;
}

/** Обязательный для патча числовой id. */
function idValue(input: Record<string, unknown>, field: string): number {
  const parsed = Number(input[field]);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new EndpointError(`Invalid ${field}`, { code: 'BAD_REQUEST' });
  }
  return parsed;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<Record<string, unknown>> {
  const userId = requireUserId(input, ctx);

  const rawId = input.id;
  const taskId = Number(rawId);
  if (rawId === undefined || rawId === null || rawId === '' || !Number.isInteger(taskId) || taskId <= 0) {
    throw new EndpointError('Invalid task id', { code: 'BAD_REQUEST' });
  }

  const existing = await getTask(userId, taskId);
  if (!existing) {
    throw new EndpointError('Task not found', { code: 'NOT_FOUND' });
  }

  if (input.status === 'done') {
    const result = await completeTask(userId, taskId);
    return {
      status: 'done',
      next_task_id: result.nextTask ? String(result.nextTask.id) : null,
      next_occurrence: result.nextTask?.dueAt ?? null,
    };
  }

  const patch: TaskPatch = {};

  if (isSet(input, 'title')) {
    patch.title = stringValue(input, 'title').trim();
  }
  if (isSet(input, 'notes')) {
    patch.notes = stringValue(input, 'notes');
  }
  if (isSet(input, 'category_id')) {
    patch.categoryId = idValue(input, 'category_id');
  }
  if (isSet(input, 'subcategory_id')) {
    patch.subcategoryId = idValue(input, 'subcategory_id');
  }
  if (isSet(input, 'status')) {
    patch.status = stringValue(input, 'status') as TaskStatus;
  }
  if (isSet(input, 'remind_at')) {
    // upstream: `parse_datetime_ru(x) if x else None` — пустая строка очищает поле
    const raw = stringValue(input, 'remind_at');
    patch.remindAt = raw.trim() ? raw.trim() : null;
  }
  if (isSet(input, 'due_at')) {
    const raw = stringValue(input, 'due_at');
    patch.dueAt = raw.trim() ? raw.trim() : null;
  }
  if (isSet(input, 'recurrence')) {
    patch.recurrence = parseRecurrenceValue(input.recurrence);
  }

  if (Object.keys(patch).length === 0) {
    return { status: 'no change' };
  }

  const updated = await updateTask(userId, taskId, patch);
  if (!updated) {
    throw new EndpointError('Task not found', { code: 'NOT_FOUND' });
  }

  let categoryName: string | null = null;
  if (updated.categoryId !== null) {
    const categories = await listCategories(userId);
    categoryName = categories.find((category) => category.id === updated.categoryId)?.name ?? null;
  }

  let subcategoryName: string | null = null;
  if (updated.subcategoryId !== null) {
    const subcategories =
      updated.categoryId !== null
        ? await listSubcategories(userId, updated.categoryId)
        : (await Promise.all(
            (await listCategories(userId)).map((category) =>
              listSubcategories(userId, category.id),
            ),
          )).flat();
    subcategoryName =
      subcategories.find((subcategory) => subcategory.id === updated.subcategoryId)?.name ?? null;
  }

  return {
    status: 'updated',
    id: String(updated.id),
    title: updated.title,
    category_id: updated.categoryId === null ? null : String(updated.categoryId),
    category_name: categoryName,
    subcategory_id: updated.subcategoryId === null ? null : String(updated.subcategoryId),
    subcategory_name: subcategoryName,
  };
}
