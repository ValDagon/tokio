/**
 * Тулза агента: разбор задач (PLAN-AGENT-FIRST T2).
 *
 * Заменяет удалённый `scripts/tasks_triage.py`, который читал PostgreSQL-схему
 * `ag`, невидимую продакшну. Здесь тот же смысл на SQLite-DAL:
 *
 *  - `focus` — микро-фокус дня по правилу Треугольника 1+3: строго задачи на
 *    сегодня и просроченные, не больше четырёх, без задач будущих дней;
 *  - `sphere` — контекстная изоляция одной сферы (категории или подкатегории).
 *
 * Анти-абулический шаг считается детерминированно: если задача просрочена и не
 * двигалась два дня (`updated_at`), к ней добавляется предложение двухминутного
 * шага. Никаких LLM-вызовов внутри тулзы.
 */

import {
  listCategories,
  listSubcategories,
  listTasks,
} from '../../dal/tasks.js';
import type { TaskRow } from '../../../types.js';
import { dateKey } from '../../utils.js';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry.js';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Фокус дня: правило Треугольника 1+3 (1 ключевая + до 3 операционных). */
export const FOCUS_LIMIT = 4;

/** Жёсткий потолок фокуса: правило 1+3 не растягивается по просьбе модели. */
export const FOCUS_LIMIT_CAP = FOCUS_LIMIT;

export const SPHERE_LIMIT = 20;
export const SPHERE_LIMIT_CAP = 50;

/** Через сколько дней без движения задача считается застрявшей. */
export const STALE_AFTER_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLimit(args: ToolArgs, fallback: number, cap: number): number {
  const raw = args.limit;
  const parsed = typeof raw === 'number' ? Math.floor(raw) : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(cap, parsed);
}

/** `YYYY-MM-DD` задачи в таймзоне пользователя; `null` — дата не задана. */
function dueDateKey(task: TaskRow, timeZone: string): string | null {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  return dateKey(due, timeZone);
}

/** Задача «застряла»: обновлялась не позже чем `STALE_AFTER_DAYS` дней назад. */
function isStale(task: TaskRow, now: Date): boolean {
  if (!task.updatedAt) return false;
  const updated = new Date(task.updatedAt);
  if (Number.isNaN(updated.getTime())) return false;
  return now.getTime() - updated.getTime() >= STALE_AFTER_DAYS * DAY_MS;
}

interface TriageNames {
  category: (id: number | null) => string | null;
  subcategory: (id: number | null) => string | null;
}

async function loadNames(userId: number): Promise<TriageNames> {
  const categories = await listCategories(userId);
  const categoryNames = new Map<number, string>();
  const subcategoryNames = new Map<number, string>();
  for (const category of categories) {
    categoryNames.set(category.id, category.name);
    for (const subcategory of await listSubcategories(userId, category.id)) {
      subcategoryNames.set(subcategory.id, subcategory.name);
    }
  }
  return {
    category: (id) => (id === null ? null : categoryNames.get(id) ?? null),
    subcategory: (id) => (id === null ? null : subcategoryNames.get(id) ?? null),
  };
}

function label(task: TaskRow, names: TriageNames): string {
  const category = names.category(task.categoryId) ?? 'Разное';
  const subcategory = names.subcategory(task.subcategoryId);
  return subcategory ? `${category} / ${subcategory}` : category;
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

async function triageTasks(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const mode = args.mode === 'sphere' ? 'sphere' : 'focus';
  const today = dateKey(ctx.now, ctx.timezone);
  const staleThreshold = new Date(ctx.now.getTime() - STALE_AFTER_DAYS * DAY_MS);

  try {
    const names = await loadNames(ctx.userId);
    if (mode === 'sphere') {
      const sphere = typeof args.sphere === 'string' ? args.sphere.trim() : '';
      if (!sphere) return fail('Для режима sphere нужна сфера (sphere): категория или подкатегория.');

      const wanted = sphere.toLowerCase();
      const all = await listTasks(ctx.userId, { status: 'todo', itemType: 'task', limit: 200 });
      const matched = all.filter((task) => {
        const category = names.category(task.categoryId)?.toLowerCase() ?? '';
        const subcategory = names.subcategory(task.subcategoryId)?.toLowerCase() ?? '';
        return category === wanted || subcategory === wanted || category.includes(wanted) || subcategory.includes(wanted);
      });
      if (matched.length === 0) {
        const available = new Set<string>();
        for (const task of all) available.add(names.category(task.categoryId) ?? 'Разное');
        const list = [...available].sort().join(', ') || '—';
        return fail(`Сфера «${sphere}» не найдена. Доступные сферы: ${list}.`);
      }

      const limit = readLimit(args, SPHERE_LIMIT, SPHERE_LIMIT_CAP);
      const sorted = [...matched].sort(byDue);
      const items = sorted.slice(0, limit);
      const lines = items.map((task, index) =>
        formatLine(task, index + 1, names, today, staleThreshold, ctx.timezone),
      );
      return {
        ok: true,
        content: [
          `📂 Контекстная изоляция: «${sphere}» (${items.length} из ${matched.length})`,
          ...lines,
        ].join('\n'),
        data: { mode, date: today, sphere, items: items.map(toData) },
      };
    }

    const all = await listTasks(ctx.userId, { status: 'todo', itemType: 'task', limit: 200 });
    const focus = all.filter((task) => {
      const due = dueDateKey(task, ctx.timezone);
      return due !== null && due <= today;
    });
    const limit = readLimit(args, FOCUS_LIMIT, FOCUS_LIMIT_CAP);
    const items = [...focus].sort(byDue).slice(0, limit);

    if (items.length === 0) {
      return {
        ok: true,
        content: '✓ На сегодня и в просрочках ничего не осталось — можно отдохнуть.',
        data: { mode, date: today, items: [] },
      };
    }

    const lines = items.map((task, index) =>
      formatLine(task, index + 1, names, today, staleThreshold, ctx.timezone),
    );
    return {
      ok: true,
      content: [
        `🎯 Микро-фокус дня (не больше ${FOCUS_LIMIT} задач, на сегодня и просроченные):`,
        ...lines,
      ].join('\n'),
      data: { mode, date: today, items: items.map(toData) },
    };
  } catch (error) {
    return fail(`Не удалось собрать разбор задач: ${errorText(error)}`);
  }
}

/** Сортировка по сроку: ближайшие и просроченные первыми, без срока — в конце. */
function byDue(a: TaskRow, b: TaskRow): number {
  const left = a.dueAt ?? '9999-12-31';
  const right = b.dueAt ?? '9999-12-31';
  if (left === right) return a.id - b.id;
  return left < right ? -1 : 1;
}

function formatLine(
  task: TaskRow,
  index: number,
  names: TriageNames,
  today: string,
  staleThreshold: Date,
  timeZone: string,
): string {
  const due = dueDateKey(task, timeZone);
  const overdue = due !== null && due < today;
  const dueLabel = due ? ` [${overdue ? 'просрочено до' : 'до'} ${due}]` : '';
  const notes = task.notes?.trim() ? `\n   ↳ ${task.notes.trim()}` : '';
  const nudge = overdue && isStale(task, staleThreshold)
    ? `\n   ⚡️ Двухминутный шаг: ${task.title.trim()}`
    : '';
  return `${index}. [${label(task, names)}] ${task.title}${dueLabel}${notes}${nudge}`;
}

function toData(task: TaskRow): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    dueAt: task.dueAt,
    status: task.status,
  };
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

export const triageTools: Tool[] = [
  {
    name: 'triage_tasks',
    effect: { kind: 'read' },
    description:
      'Разбирает задачи: режим focus даёт микро-фокус дня (только сегодня и просроченные, не более 4, с двухминутным шагом для застрявших), режим sphere — изоляцию одной сферы.',
    schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: "Режим: 'focus' (по умолчанию) или 'sphere'.",
        },
        sphere: {
          type: 'string',
          description: 'Категория или подкатегория для режима sphere (например «Быт»).',
        },
        limit: {
          type: 'integer',
          description: 'Сколько задач показать (focus: по умолчанию и максимум 4; sphere: 20, максимум 50).',
        },
      },
      required: [],
    },
    run: triageTasks,
  },
];
