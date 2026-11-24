/**
 * Тулза агента: разбор задач (PLAN-AGENT-FIRST T2).
 *
 * Держим инварианты, которые раньше давал удалённый `scripts/tasks_triage.py`:
 *  - `focus` показывает только задачи на сегодня и просроченные, задачи
 *    будущих дней и события в фокус не попадают (Треугольник 1+3);
 *  - фокус зажат до четырёх задач даже при явно большем `limit`;
 *  - застрявшая просроченная задача получает детерминированный двухминутный шаг;
 *  - `sphere` изолирует одну категорию/подкатегорию и подсказывает доступные
 *    сферы, если запрошенной нет;
 *  - каждый пользователь видит только свои задачи.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { triageTools } from '../../../src/lib/agent/tools/triage';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import {
  createTask,
  ensureSystemCategories,
  findCategoryByName,
} from '../../../src/lib/dal/tasks';
import { ensureUser } from '../../../src/lib/dal/users';
import { saveUserPrefs } from '../../../src/lib/prefs';
import type { TaskItemType } from '../../../src/types';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта 2026, 11:00 по Белграду. */
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
  const found = triageTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в triageTools`);
  return found;
}

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = CTX_A,
): Promise<ToolOutcome> {
  const outcome = await toolByName('triage_tasks').run(args, ctx);
  return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
}

async function addTask(
  title: string,
  options: { userId?: number; dueAt?: string | null; categoryId?: number | null; itemType?: TaskItemType } = {},
): Promise<number> {
  const task = await createTask(options.userId ?? USER_A, {
    title,
    dueAt: options.dueAt ?? null,
    categoryId: options.categoryId ?? null,
    itemType: options.itemType ?? 'task',
  });
  return task.id;
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
  await ensureSystemCategories(USER_A);
  await ensureSystemCategories(USER_B);
});

// ---------------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------------

describe('triage_tasks: focus', () => {
  it('берёт только сегодня и просроченные задачи, без будущих и событий', async () => {
    await addTask('Просроченная', { dueAt: '2026-03-14T09:00:00.000Z' });
    await addTask('Сегодняшняя', { dueAt: '2026-03-15T09:00:00.000Z' });
    await addTask('Будущая', { dueAt: '2026-03-20T09:00:00.000Z' });
    await addTask('Встреча', { dueAt: '2026-03-15T09:00:00.000Z', itemType: 'event' });

    const outcome = await run({});

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Просроченная');
    expect(outcome.content).toContain('Сегодняшняя');
    expect(outcome.content).not.toContain('Будущая');
    expect(outcome.content).not.toContain('Встреча');
    expect(outcome.content).toContain('[просрочено до 2026-03-14]');
  });

  it('зажимает фокус до четырёх задач даже при большем лимите', async () => {
    for (let index = 0; index < 6; index += 1) {
      await addTask(`Задача ${index + 1}`, { dueAt: '2026-03-15T09:00:00.000Z' });
    }

    const outcome = await run({ limit: 20 });

    expect(outcome.ok).toBe(true);
    const items = (outcome.data as { items: unknown[] }).items;
    expect(items).toHaveLength(4);
  });

  it('добавляет двухминутный шаг застрявшей просроченной задаче', async () => {
    const id = await addTask('Зависла', { dueAt: '2026-03-10T09:00:00.000Z' });
    // Движения не было два дня — это и есть условие анти-абулического шага.
    await db.run(sql`UPDATE tasks SET updated_at = '2026-03-10T09:00:00.000Z' WHERE id = ${id}`);

    const outcome = await run({});

    expect(outcome.content).toContain('Двухминутный шаг: Зависла');
  });

  it('на пустом фокусе отвечает без вины и без списка', async () => {
    const outcome = await run({});

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('ничего не осталось');
    expect((outcome.data as { items: unknown[] }).items).toHaveLength(0);
  });

  it('не показывает задачи другого пользователя', async () => {
    await addTask('Чужая задача', { userId: USER_B, dueAt: '2026-03-15T09:00:00.000Z' });

    const outcome = await run({});

    expect(outcome.content).not.toContain('Чужая задача');
  });
});

// ---------------------------------------------------------------------------
// sphere
// ---------------------------------------------------------------------------

describe('triage_tasks: sphere', () => {
  it('изолирует одну категорию', async () => {
    const household = await findCategoryByName(USER_A, 'Быт');
    const startup = await findCategoryByName(USER_A, 'Стартап');
    await addTask('Помыть посуду', { categoryId: household?.id ?? null });
    await addTask('Написать лендинг', { categoryId: startup?.id ?? null });

    const outcome = await run({ mode: 'sphere', sphere: 'Быт' });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Помыть посуду');
    expect(outcome.content).not.toContain('Написать лендинг');
  });

  it('на неизвестной сфере отвечает ok:false со списком доступных', async () => {
    const outcome = await run({ mode: 'sphere', sphere: 'Космос' });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Космос');
    expect(outcome.content).toContain('Доступные сферы');
  });

  it('без имени сферы просит её указать', async () => {
    const outcome = await run({ mode: 'sphere' });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('sphere');
  });
});

describe('triage_tasks: Волна 2 СДВГ-переопределения', () => {
  it('не считает задачу застрявшей через 36 часов и срабатывает ровно с 2 дней по умолчанию', async () => {
    const freshId = await addTask('Недавно трогал', { dueAt: '2026-03-10T09:00:00.000Z' });
    // 36 часов до NOW (2026-03-15T10:00Z -> 2026-03-13T22:00Z)
    await db.run(sql`UPDATE tasks SET updated_at = '2026-03-13T22:00:00.000Z' WHERE id = ${freshId}`);

    const staleId = await addTask('Простаивает 49 часов', { dueAt: '2026-03-10T09:00:00.000Z' });
    await db.run(sql`UPDATE tasks SET updated_at = '2026-03-13T09:00:00.000Z' WHERE id = ${staleId}`);

    const outcome = await run({});
    expect(outcome.content).not.toContain('Двухминутный шаг: Недавно трогал');
    expect(outcome.content).toContain('Двухминутный шаг: Простаивает 49 часов');
  });

  it('применяет adhd.focusLimit и adhd.staleAfterDays из user_prefs', async () => {
    await saveUserPrefs(USER_A, { adhd: { focusLimit: 2, staleAfterDays: 5 } });
    for (let i = 1; i <= 5; i += 1) {
      const id = await addTask(`Задача ${i}`, { dueAt: '2026-03-10T09:00:00.000Z' });
      // 3 дня простоя (< 5)
      await db.run(sql`UPDATE tasks SET updated_at = '2026-03-12T10:00:00.000Z' WHERE id = ${id}`);
    }

    const outcome = await run({ limit: 10 });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { items: unknown[] }).items).toHaveLength(2);
    expect(outcome.content).not.toContain('Двухминутный шаг:');
  });
});
