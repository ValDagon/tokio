/**
 * T16 endpoints: задачи (category / create / list / update / delete).
 *
 * Покрытие `src/endpoints/categories_list.ts` + `tasks_{list,create,update,delete}.ts`:
 *  - авторизация (`requireUserId` → `EndpointError('Unauthorized')`);
 *  - формат `TaskResponseSchema` (snake_case, id строками, steps-дети);
 *  - фильтр `status` (дефолт `'todo'`, литеральное значение — без спец-`'all'`);
 *  - PATCH-семантика: `updated` / `no change` / `done` + 404;
 *  - soft delete с 404 на повторное удаление.
 *
 * Данные только самосевные: каждое утверждение опирается на значения,
 * созданные самим тестом. `steps` у `tasks_create` — `list[str]`
 * (`TaskCreateSchema.steps` в routes.py), поэтому объекты `{title}` не
 * поддерживаются и здесь не используются.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { ensureSystemCategories } from '../../src/lib/dal/tasks';
import categoriesList from '../../src/endpoints/categories_list';
import tasksList from '../../src/endpoints/tasks_list';
import tasksCreate from '../../src/endpoints/tasks_create';
import tasksUpdate from '../../src/endpoints/tasks_update';
import tasksDelete from '../../src/endpoints/tasks_delete';

const TEST_USER = 777000111;
const mockCtx = { initData: { user: { id: TEST_USER } } };

const UNAUTHORIZED = {
  name: 'EndpointError',
  message: 'Unauthorized',
  parameters: { code: 'UNAUTHORIZED' },
};

describe('T16 endpoints: tasks', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('без initData tasks_list и categories_list отвечают Unauthorized', async () => {
    const unauthenticated: Array<() => Promise<unknown>> = [
      () => categoriesList({}, undefined),
      () => tasksList({}, undefined),
    ];

    for (const call of unauthenticated) {
      await expect(call()).rejects.toMatchObject(UNAUTHORIZED);
    }
  });

  it('categories_list идемпотентно создаёт системные категории с подкатегориями', async () => {
    await ensureSystemCategories(TEST_USER);

    const categories = (await categoriesList({}, mockCtx)) as Array<{
      id: string;
      name: string;
      color: string | null;
      position: number;
      subcategories: Array<{
        id: string;
        category_id: string;
        name: string;
        position: number;
      }>;
    }>;

    expect(categories.map((category) => category.name)).toEqual([
      'Стартап',
      'Фриланс',
      'Поиск работы',
      'Хобби',
      'Быт',
      'Другое',
    ]);

    const startup = categories[0];
    expect(startup).toEqual({
      id: expect.any(String),
      name: 'Стартап',
      color: null,
      position: 0,
      subcategories: [],
    });
    expect(Number(startup.id)).toBeGreaterThan(0);

    const hobby = categories.find((category) => category.name === 'Хобби');
    expect(hobby).toBeDefined();
    expect(hobby?.subcategories.map((sub) => sub.name)).toEqual(['YouTube', 'Церковь']);

    const household = categories.find((category) => category.name === 'Быт');
    expect(household).toBeDefined();
    expect(household?.subcategories.map((sub) => sub.name)).toEqual([
      'Гигиена и уборка',
      'Питание',
      'Здоровье',
      'Социализация',
    ]);
    expect(household?.subcategories[1]).toEqual({
      id: expect.any(String),
      category_id: String(household?.id),
      name: 'Питание',
      position: 1,
    });
  });

  it('tasks_create создаёт задачу со шагами и отдаёт полный TaskResponse', async () => {
    const created = (await tasksCreate(
      {
        title: 'Купить молоко',
        notes: '2 литра',
        steps: ['Взять корзину'],
      },
      mockCtx,
    )) as {
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
      recurrence: unknown;
    };

    expect(created).toEqual({
      id: expect.any(String),
      title: 'Купить молоко',
      status: 'todo',
      notes: '2 литра',
      category_id: null,
      category_name: null,
      subcategory_id: null,
      subcategory_name: null,
      steps: [
        {
          id: expect.any(String),
          title: 'Взять корзину',
          status: 'todo',
          position: 0,
        },
      ],
      created_at: expect.any(String),
      due_at: null,
      remind_at: null,
      recurrence: null,
    });
    expect(Number(created.id)).toBeGreaterThan(0);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('tasks_list по умолчанию отдаёт todo-корни, а status — литеральный фильтр', async () => {
    const created = await tasksCreate(
      {
        title: 'Позвонить в банк',
        steps: ['Найти номер', 'Набрать'],
      },
      mockCtx,
    );

    const todo = await tasksList({}, mockCtx);
    expect(todo).toHaveLength(1);
    expect(todo[0]).toEqual({
      id: String(created.id),
      title: 'Позвонить в банк',
      status: 'todo',
      notes: null,
      category_id: null,
      category_name: null,
      subcategory_id: null,
      subcategory_name: null,
      steps: [
        { id: expect.any(String), title: 'Найти номер', status: 'todo', position: 0 },
        { id: expect.any(String), title: 'Набрать', status: 'todo', position: 1 },
      ],
      created_at: expect.any(String),
      due_at: null,
      remind_at: null,
      recurrence: null,
    });

    // Спец-значения `'all'` нет: `status` уходит в SQL как есть (upstream `WHERE status = :status`).
    await expect(tasksList({ status: 'all' }, mockCtx)).resolves.toHaveLength(0);
    await expect(tasksList({ status: 'in_progress' }, mockCtx)).resolves.toHaveLength(0);
    await expect(tasksList({ status: 'todo' }, mockCtx)).resolves.toHaveLength(1);
    // Пустая строка отключает фильтр и возвращает всё (upstream: `if status:`).
    await expect(tasksList({ status: '' }, mockCtx)).resolves.toHaveLength(1);
  });

  it('tasks_update: title → updated, пустой патч → no change, done → done, чужой id → 404', async () => {
    const created = await tasksCreate({ title: 'Купить молоко' }, mockCtx);

    const renamed = await tasksUpdate(
      { id: created.id, title: 'Купить хлеб' },
      mockCtx,
    );
    expect(renamed).toEqual({
      status: 'updated',
      id: String(created.id),
      title: 'Купить хлеб',
      category_id: null,
      category_name: null,
      subcategory_id: null,
      subcategory_name: null,
    });

    const noChange = await tasksUpdate({ id: created.id }, mockCtx);
    expect(noChange).toEqual({ status: 'no change' });

    const done = await tasksUpdate({ id: created.id, status: 'done' }, mockCtx);
    expect(done).toEqual({
      status: 'done',
      next_task_id: null,
      next_occurrence: null,
    });
    await expect(tasksList({ status: 'done' }, mockCtx)).resolves.toHaveLength(1);

    await expect(
      tasksUpdate({ id: 999999, title: 'Призрак' }, mockCtx),
    ).rejects.toMatchObject({
      name: 'EndpointError',
      message: 'Task not found',
      parameters: { code: 'NOT_FOUND' },
    });
  });

  it('tasks_delete помещает задачу в корзину и второй раз отдаёт 404', async () => {
    const created = await tasksCreate({ title: 'Удаляемая задача' }, mockCtx);

    const deleted = await tasksDelete({ id: created.id }, mockCtx);
    expect(deleted).toEqual({ status: 'deleted', in_trash: true });
    await expect(tasksList({ status: '' }, mockCtx)).resolves.toHaveLength(0);

    await expect(tasksDelete({ id: created.id }, mockCtx)).rejects.toMatchObject({
      name: 'EndpointError',
      message: 'Task not found or already in trash',
      parameters: { code: 'NOT_FOUND' },
    });
  });
});
