/**
 * POST /api/tasks — создание задачи со шагами.
 *
 * Паритет с `backend/app/api/routes.py::create_task`:
 *  - `title` обязателен и обрезается (`.strip()`);
 *  - категория: явный `category_id` побеждает; иначе ищем по `category_name`
 *    без учёта регистра. `lower()` в SQLite кириллицу не понижает, поэтому
 *    нормализуем в JS (`toLocaleLowerCase('ru')`) и сравниваем по списку
 *    `listCategories`;
 *  - подкатегория: явный `subcategory_id` побеждает; иначе ищем по
 *    `subcategory_name` среди подкатегорий найденной категории;
 *  - `due_at` по умолчанию равен `remind_at` (upstream: `target_due = due_at or
 *    remind_at or parse(notes)`);
 *  - `status` всегда `'todo'`, `item_type` — дефолтный `'task'` (upstream INSERT
 *    статус не принимает из тела);
 *  - шаги создаются дочерними задачами (`parent_id`, `position = idx`,
 *    `category_id` родителя), пустые строки пропускаются, но индекс `idx`
 *    расходуется — точно как `enumerate(body.steps)` в upstream;
 *  - ответ — полный `TaskResponseSchema` с шагами и именами категории/подкатегории.
 *
 * Отличия от upstream (осознанные, см. `src/lib/agent/tools/tasks.ts`):
 *  - get-or-create категорий/подкатегорий недоступен: в DAL нет create для
 *    `task_categories` / `task_subcategories` (только `finances.createCategory`,
 *    это другая таблица), а свой SQL в эндпоинтах запрещён. Неизвестное имя
 *    молча игнорируется — задача создаётся без категории/подкатегории;
 *  - нет русского парсинга дат и повторов: `due_at`/`remind_at` принимаются
 *    только ISO-строкой и кладутся как есть; `recurrence` — JSON-строка или
 *    объект `RecurrenceRule`, текстовые описания («ежедневно») не разбираются;
 *  - fallback-парсинг `recurrence`/даты из `notes` не портирован (T7-решение).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import {
  createTask,
  ensureSystemCategories,
  listCategories,
  listSubcategories,
} from '../lib/dal/tasks.js';
import { ensureUser } from '../lib/dal/users.js';
import type { RecurrenceRule } from '../types.js';

/** `TaskResponseSchema` из routes.py (id — строкой). */
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

const RECURRENCE_FREQS: readonly RecurrenceRule['freq'][] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
];

/** Кириллице-безопасная нормализация имени категории/подкатегории. */
function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase('ru');
}

/** Числовой id из тела; `null` — поля нет/пустое. */
function optionalId(input: Record<string, unknown>, field: string): number | null {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new EndpointError(`Invalid ${field}`, { code: 'BAD_REQUEST' });
  }
  return parsed;
}

/** Строка из тела; `null` — поля нет. Неверный тип → 400 (upstream 422). */
function optionalString(input: Record<string, unknown>, field: string): string | null {
  const raw = input[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new EndpointError(`Invalid ${field}`, { code: 'BAD_REQUEST' });
  }
  return raw;
}

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

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<TaskResponse> {
  const userId = requireUserId(input, ctx);

  await ensureUser(userId);
  await ensureSystemCategories(userId);

  if (typeof input.title !== 'string') {
    throw new EndpointError('Invalid title', { code: 'BAD_REQUEST' });
  }
  const title = input.title.trim();

  const notes = optionalString(input, 'notes');
  const explicitCategoryId = optionalId(input, 'category_id');
  const categoryNameInput = optionalString(input, 'category_name');
  const explicitSubcategoryId = optionalId(input, 'subcategory_id');
  const subcategoryNameInput = optionalString(input, 'subcategory_name');
  const rawRemindAt = optionalString(input, 'remind_at');
  const rawDueAt = optionalString(input, 'due_at');

  const categories = await listCategories(userId);

  let categoryId: number | null = explicitCategoryId;
  let categoryName: string | null =
    categoryId === null
      ? null
      : categories.find((category) => category.id === categoryId)?.name ?? null;

  if (categoryId === null && categoryNameInput !== null) {
    const wanted = normalizeName(categoryNameInput);
    const match = categories.find((category) => normalizeName(category.name) === wanted);
    if (match) {
      categoryId = match.id;
      categoryName = match.name;
    }
    // имя не найдено: создать категорию нечем (см. шапку файла) — null
  }

  // Подкатегории нужны только если есть id или имя
  let subcategoryId: number | null = explicitSubcategoryId;
  let subcategoryName: string | null = null;
  if (subcategoryId !== null || (categoryId !== null && subcategoryNameInput !== null)) {
    // имени сабки upstream ищет по id без привязки к категории — поэтому при
    // явном subcategory_id и пустой категории смотрим все подкатегории
    const subcategories =
      categoryId !== null
        ? await listSubcategories(userId, categoryId)
        : (await Promise.all(
            categories.map((category) => listSubcategories(userId, category.id)),
          )).flat();

    if (subcategoryId !== null) {
      subcategoryName =
        subcategories.find((subcategory) => subcategory.id === subcategoryId)?.name ?? null;
    } else if (subcategoryNameInput !== null) {
      const wanted = normalizeName(subcategoryNameInput);
      const match = subcategories.find(
        (subcategory) => normalizeName(subcategory.name) === wanted,
      );
      if (match) {
        subcategoryId = match.id;
        subcategoryName = match.name;
      }
    }
  }

  const remindAt = rawRemindAt !== null && rawRemindAt.trim() ? rawRemindAt.trim() : null;
  const dueAt =
    rawDueAt !== null && rawDueAt.trim()
      ? rawDueAt.trim()
      : // upstream: due_at = due_at or remind_at (or parse(notes) — не портировано)
        remindAt;

  const created = await createTask(userId, {
    title,
    notes,
    status: 'todo',
    itemType: 'task',
    categoryId,
    subcategoryId,
    dueAt,
    remindAt,
    recurrence: parseRecurrenceValue(input.recurrence),
  });

  const steps: TaskResponse['steps'] = [];
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  for (const [index, rawStep] of rawSteps.entries()) {
    if (typeof rawStep !== 'string' || !rawStep.trim()) continue;
    const step = await createTask(userId, {
      title: rawStep.trim(),
      status: 'todo',
      categoryId,
      parentId: created.id,
      position: index,
    });
    steps.push({
      id: String(step.id),
      title: step.title,
      status: step.status,
      position: step.position,
    });
  }

  return {
    id: String(created.id),
    title: created.title,
    status: created.status,
    notes: created.notes,
    category_id: categoryId === null ? null : String(categoryId),
    category_name: categoryName,
    subcategory_id: subcategoryId === null ? null : String(subcategoryId),
    subcategory_name: subcategoryName,
    steps,
    created_at: created.createdAt ?? '',
    due_at: created.dueAt,
    remind_at: created.remindAt,
    recurrence: created.recurrence,
  };
}
