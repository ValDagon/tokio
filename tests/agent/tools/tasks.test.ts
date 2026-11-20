/**
 * Тулзы агента: задачи и напоминания (SPEC §3 T12).
 *
 * Держим инварианты тулз:
 *  - время считается только от `ctx.now`/`ctx.timezone`; строка без оффсета —
 *    локальное время пользователя;
 *  - кривые аргументы (даты, минуты, recurrence, шаги) дают `ok:false` с
 *    подсказкой, а не исключение;
 *  - категория ищется точным именем; неизвестная категория не создаётся и
 *    задача ложится без категории (`categoryId: null`);
 *  - `list_tasks` показывает только открытые корневые задачи, сортирует по
 *    ближайшему напоминанию (null — в конце) и считает открытые шаги;
 *  - `update_task`/`delete_task`/`auto_detect_tasks` работают только с открытыми
 *    корневыми задачами, `complete_task` — со всеми открытыми (включая шаги);
 *  - завершение повторяющейся задачи создаёт следующую итерацию, кроме
 *    `count <= 1`;
 *  - каждый пользователь видит и меняет только свои задачи.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { tasksTools } from '../../../src/lib/agent/tools/tasks';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import {
  createTask,
  ensureSystemCategories,
  findCategoryByName,
  listTasks,
} from '../../../src/lib/dal/tasks';
import { listTrash } from '../../../src/lib/dal/misc';
import { ensureUser } from '../../../src/lib/dal/users';
import type { RecurrenceRule } from '../../../src/types';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду (UTC+1). */
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
  const found = tasksTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в tasksTools`);
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

async function categoryId(name: string, userId: number = USER_A): Promise<number> {
  await ensureSystemCategories(userId);
  const category = await findCategoryByName(userId, name);
  if (!category) throw new Error(`категория «${name}» не найдена`);
  return category.id;
}

interface ReminderData {
  task_id: number;
  title: string;
  remind_at: string | null;
  due_at: string | null;
  recurrence: RecurrenceRule | null;
}

interface AddTaskData {
  task_id: number;
  title: string;
  category_id: number | null;
  category_name: string | null;
  notes: string | null;
  due_at: string | null;
  remind_at: string | null;
  recurrence: RecurrenceRule | null;
  steps_created: number;
}

interface BatchData {
  created: number[];
  count: number;
  skipped: number[];
}

interface CompleteData {
  task_id: number;
  title: string;
  next_task_id: number | null;
  next_due_at: string | null;
}

interface ListData {
  count: number;
  tasks: Array<{
    id: number;
    title: string;
    category: string | null;
    remind_at: string | null;
    due_at: string | null;
    recurrence: RecurrenceRule | null;
    subtasks_count: number;
  }>;
}

interface UpdateData {
  task_id: number;
  title: string;
  category_id: number | null;
  notes: string | null;
  due_at: string | null;
  remind_at: string | null;
  recurrence: RecurrenceRule | null;
  changes: string[];
}

interface DeleteData {
  task_id: number;
  title: string;
  deleted: boolean;
}

interface DetectData {
  task_id: number;
  title: string;
  next_task_id: number | null;
  details: string | null;
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// set_reminder
// ---------------------------------------------------------------------------

describe('set_reminder', () => {
  it('без title — ok:false с подсказкой', async () => {
    const outcome = await run('set_reminder', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Укажите, о чём напомнить (title).');
  });

  it('ставит напоминание с ISO-датой и оффсетом (due = remind)', async () => {
    const outcome = await run('set_reminder', {
      title: 'Позвонить маме',
      remind_at: '2026-03-16T09:00:00+01:00',
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as ReminderData;
    expect(data.title).toBe('Позвонить маме');
    expect(data.remind_at).toBe('2026-03-16T08:00:00.000Z');
    expect(data.due_at).toBe(data.remind_at);
    expect(data.recurrence).toBeNull();

    expect(outcome.content).toBe(
      '⏰ Напоминание установлено! Я пришлю уведомление в Telegram 16.03.2026 в 09:00 по задаче: «Позвонить маме».',
    );
  });

  it('дата без оффсета трактуется как локальное время пользователя', async () => {
    const outcome = await run('set_reminder', {
      title: 'Выпить воду',
      remind_at: '2026-03-16 09:00',
    });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as ReminderData).remind_at).toBe('2026-03-16T08:00:00.000Z');
    expect(outcome.content).toContain('16.03.2026 в 09:00');
  });

  it('без времени — fallback «через час» от ctx.now', async () => {
    const outcome = await run('set_reminder', { title: 'Размяться' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as ReminderData).remind_at).toBe('2026-03-15T11:00:00.000Z');
    expect(outcome.content).toContain('15.03.2026 в 12:00');
  });

  it('remind_in_minutes приоритетнее remind_at', async () => {
    const outcome = await run('set_reminder', {
      title: 'Проверить почту',
      remind_at: '2026-03-20T09:00:00+01:00',
      remind_in_minutes: 30,
    });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as ReminderData).remind_at).toBe('2026-03-15T10:30:00.000Z');
    expect(outcome.content).toContain('15.03.2026 в 11:30');
  });

  it('кривая дата и кривые минуты — ok:false', async () => {
    const badDate = await run('set_reminder', { title: 'X', remind_at: 'завтра утром' });
    expect(badDate.ok).toBe(false);
    expect(badDate.content).toBe(
      'remind_at должен быть датой ISO-8601 (например «2026-03-16T09:00:00+01:00» или «2026-03-16 09:00»).',
    );

    const badMinutes = await run('set_reminder', { title: 'X', remind_in_minutes: 'скоро' });
    expect(badMinutes.ok).toBe(false);
    expect(badMinutes.content).toBe('remind_in_minutes должен быть целым числом.');
  });

  it('повтор попадает в текст и в данные', async () => {
    const outcome = await run('set_reminder', {
      title: 'Медитация',
      remind_in_minutes: 60,
      recurrence: { freq: 'weekly', interval: 2 },
    });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as ReminderData).recurrence).toEqual({ freq: 'weekly', interval: 2 });
    expect(outcome.content).toContain('по задаче: «Медитация», повтор: каждые 2 нед.');
  });

  it('битый recurrence — ok:false с подсказкой', async () => {
    const outcome = await run('set_reminder', { title: 'X', recurrence: { freq: 'hourly' } });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'recurrence — объект вида {"freq": "weekly", "interval": 2, "weekdays": [0, 2]} (freq: daily|weekly|monthly|yearly).',
    );
  });

  it('неизвестная категория — задача без категории', async () => {
    const outcome = await run('set_reminder', { title: 'Полить цветы', category_name: 'Работа' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as ReminderData).task_id).toBeGreaterThan(0);
    const [stored] = await listTasks(USER_A, { status: 'todo' });
    expect(stored.categoryId).toBeNull();
  });

  it('известная категория проставляется', async () => {
    await run('set_reminder', { title: 'Полить цветы', category_name: 'Быт' });
    const expected = await categoryId('Быт');
    const [stored] = await listTasks(USER_A, { status: 'todo' });
    expect(stored.categoryId).toBe(expected);
  });

  it('напоминание одного пользователя не видно другому', async () => {
    await run('set_reminder', { title: 'Только моё' });
    expect(await listTasks(USER_B, { status: 'todo' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

describe('add_task', () => {
  it('без title — ok:false', async () => {
    const outcome = await run('add_task', { notes: 'детали' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Укажите название задачи (title).');
  });

  it('минимальная задача ложится без категории и без напоминания', async () => {
    const outcome = await run('add_task', { title: 'Купить молоко' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as AddTaskData;
    expect(data.title).toBe('Купить молоко');
    expect(data.category_id).toBeNull();
    expect(data.category_name).toBeNull();
    expect(data.due_at).toBeNull();
    expect(data.remind_at).toBeNull();
    expect(data.steps_created).toBe(0);

    expect(outcome.content).toBe('Записал задачу: «Купить молоко» (категория: без категории)');
  });

  it('известная категория печатается и сохраняется', async () => {
    const outcome = await run('add_task', { title: 'Помыть посуду', category_name: 'Быт' });
    expect(outcome.ok).toBe(true);
    const data = outcome.data as AddTaskData;
    expect(data.category_id).toBe(await categoryId('Быт'));
    expect(outcome.content).toContain('(категория: Быт)');
  });

  it('неизвестная категория — без категории и с пометкой', async () => {
    const outcome = await run('add_task', { title: 'Собеседование', category_name: 'Работа' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as AddTaskData).category_id).toBeNull();
    expect(outcome.content).toContain('(категория: без категории, «Работа» не найдена)');
  });

  it('шаги создаются подзадачами с позициями', async () => {
    const outcome = await run('add_task', {
      title: 'Смонтировать ролик',
      steps: ['Найти видео', 'Скачать', '  '],
      category_name: 'Хобби',
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as AddTaskData;
    expect(data.steps_created).toBe(2);
    expect(outcome.content).toContain(' с 2 шагами');

    // listTasks сортирует по created_at DESC, id DESC — шаги приходят в обратном порядке
    const steps = await listTasks(USER_A, { parentId: data.task_id });
    expect(steps.map((step) => step.title)).toEqual(['Скачать', 'Найти видео']);
    expect(steps.map((step) => step.position)).toEqual([1, 0]);
    expect(steps.every((step) => step.categoryId === data.category_id)).toBe(true);
  });

  it('steps не массив — ok:false', async () => {
    const outcome = await run('add_task', { title: 'X', steps: 'шаг' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('steps — массив строк с короткими шагами задачи.');
  });

  it('due_at без напоминания — только срок, без «напомню»', async () => {
    const outcome = await run('add_task', {
      title: 'Сдать отчёт',
      due_at: '2026-03-20T18:00:00+01:00',
    });
    expect(outcome.ok).toBe(true);
    const data = outcome.data as AddTaskData;
    expect(data.due_at).toBe('2026-03-20T17:00:00.000Z');
    expect(data.remind_at).toBeNull();
    expect(outcome.content).not.toContain('напомню');
  });

  it('remind_at без срока — срок равен напоминанию', async () => {
    const outcome = await run('add_task', {
      title: 'Позвонить врачу',
      remind_at: '2026-03-16 09:00',
    });
    expect(outcome.ok).toBe(true);
    const data = outcome.data as AddTaskData;
    expect(data.remind_at).toBe('2026-03-16T08:00:00.000Z');
    expect(data.due_at).toBe(data.remind_at);
    expect(outcome.content).toContain(', напомню 16.03.2026 в 09:00');
  });

  it('remind_in_minutes задаёт и напоминание, и срок', async () => {
    const outcome = await run('add_task', { title: 'Через полчаса', remind_in_minutes: 30 });
    expect(outcome.ok).toBe(true);
    const data = outcome.data as AddTaskData;
    expect(data.remind_at).toBe('2026-03-15T10:30:00.000Z');
    expect(data.due_at).toBe(data.remind_at);
    expect(outcome.content).toContain('напомню 15.03.2026 в 11:30');
  });

  it('полный набор: категория, повтор, напоминание, заметка и шаги', async () => {
    const outcome = await run('add_task', {
      title: 'Смонтировать ролик',
      category_name: 'Хобби',
      steps: ['Найти видео', 'Скачать'],
      notes: 'для YouTube',
      remind_at: '2026-03-16 09:00',
      recurrence: { freq: 'weekly', interval: 2 },
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as AddTaskData;
    expect(data.notes).toBe('для YouTube');
    expect(data.recurrence).toEqual({ freq: 'weekly', interval: 2 });
    expect(outcome.content).toBe(
      'Записал задачу: «Смонтировать ролик» (категория: Хобби), повтор: каждые 2 нед., напомню 16.03.2026 в 09:00 с 2 шагами',
    );
  });

  it('кривые due_at и recurrence — ok:false', async () => {
    const badDue = await run('add_task', { title: 'X', due_at: 'послезавтра' });
    expect(badDue.ok).toBe(false);
    expect(badDue.content).toBe(
      'due_at должен быть датой ISO-8601 (например «2026-03-16T09:00:00+01:00» или «2026-03-16 09:00»).',
    );

    const badRecurrence = await run('add_task', { title: 'X', recurrence: { freq: 'daily', interval: 0 } });
    expect(badRecurrence.ok).toBe(false);
    expect(badRecurrence.content).toBe('interval в recurrence должен быть целым числом ≥ 1.');
  });
});

// ---------------------------------------------------------------------------
// add_tasks_batch
// ---------------------------------------------------------------------------

describe('add_tasks_batch', () => {
  it('пустой или невалидный список — ok:false', async () => {
    const empty = await run('add_tasks_batch', { tasks: [] });
    expect(empty.ok).toBe(false);
    expect(empty.content).toBe('Список задач пуст.');

    const notArray = await run('add_tasks_batch', { tasks: 'список' });
    expect(notArray.ok).toBe(false);
    expect(notArray.content).toBe('Список задач пуст.');
  });

  it('все названия пустые — ok:false', async () => {
    const outcome = await run('add_tasks_batch', { tasks: [{ title: '  ' }, {}, { title: '' }] });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не удалось добавить задачи (пустые названия).');
  });

  it('добавляет пачку, помечает пропуски и печатает строки', async () => {
    const outcome = await run('add_tasks_batch', {
      tasks: [
        {
          title: 'Купить молоко',
          category_name: 'Быт',
          notes: '2 литра',
          recurrence: { freq: 'daily' },
        },
        { title: 'Позвонить маме', remind_at: '2026-03-16 09:00' },
        { title: '   ', category: 'Хобби' },
        'не объект',
      ],
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as BatchData;
    expect(data.count).toBe(2);
    expect(data.created).toHaveLength(2);
    expect(data.skipped).toEqual([2, 3]);

    expect(outcome.content).toBe(
      [
        'Успешно зафиксировал 2 задач в списке дел:',
        '• «Купить молоко» [Быт] [🔁 ежедневно] — 2 литра',
        '• «Позвонить маме» [без категории]',
      ].join('\n'),
    );

    const stored = await listTasks(USER_A, { status: 'todo' });
    expect(stored).toHaveLength(2);
    const call = stored.find((task) => task.title === 'Позвонить маме');
    expect(call?.remindAt).toBe('2026-03-16T08:00:00.000Z');
    expect(call?.dueAt).toBe('2026-03-16T08:00:00.000Z');
  });

  it('неизвестная категория помечается «→ без категории (не найдена)»', async () => {
    const outcome = await run('add_tasks_batch', {
      tasks: [{ title: 'Собеседование', category_name: 'Работа' }],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• «Собеседование» [Работа → без категории (не найдена)]');
  });

  it('поддерживает alias category вместо category_name', async () => {
    const outcome = await run('add_tasks_batch', {
      tasks: [{ title: 'Посмотреть фильм', category: 'Хобби' }],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• «Посмотреть фильм» [Хобби]');

    const [stored] = await listTasks(USER_A, { status: 'todo' });
    expect(stored.categoryId).toBe(await categoryId('Хобби'));
  });

  it('due_at внутри элемента задаёт remind и due', async () => {
    await run('add_tasks_batch', {
      tasks: [{ title: 'Оплатить свет', due_at: '2026-03-20 10:00' }],
    });
    const [stored] = await listTasks(USER_A, { status: 'todo' });
    expect(stored.remindAt).toBe('2026-03-20T09:00:00.000Z');
    expect(stored.dueAt).toBe(stored.remindAt);
  });

  it('кривая дата внутри элемента — ok:false', async () => {
    const outcome = await run('add_tasks_batch', {
      tasks: [{ title: 'X', remind_at: 'вчера' }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'remind_at должен быть датой ISO-8601 (например «2026-03-16T09:00:00+01:00» или «2026-03-16 09:00»).',
    );
  });
});

// ---------------------------------------------------------------------------
// complete_task
// ---------------------------------------------------------------------------

describe('complete_task', () => {
  it('без query — ok:false', async () => {
    const outcome = await run('complete_task', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Укажите задачу (query).');
  });

  it('находит задачу по фрагменту без учёта регистра', async () => {
    const task = await createTask(USER_A, { title: 'Купить молоко' });

    const outcome = await run('complete_task', { query: 'МОЛОКО' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as CompleteData;
    expect(data.task_id).toBe(task.id);
    expect(data.title).toBe('Купить молоко');
    expect(data.next_task_id).toBeNull();
    expect(outcome.content).toBe('Отлично! Задача «Купить молоко» выполнена 🎉');

    const [stored] = await listTasks(USER_A, { status: 'done' });
    expect(stored.completedAt).not.toBeNull();
  });

  it('не найдено — ok:false с текстом запроса', async () => {
    const outcome = await run('complete_task', { query: 'уборка' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не нашёл открытую задачу, похожую на «уборка».');
  });

  it('закрытие родителя закрывает и его шаги', async () => {
    const parent = await createTask(USER_A, { title: 'Собрать документы' });
    await createTask(USER_A, { title: 'Скачать форму', parentId: parent.id, position: 0 });

    await run('complete_task', { query: 'документы' });

    expect(await listTasks(USER_A, { status: 'todo' })).toEqual([]);
    const done = await listTasks(USER_A, { status: 'done' });
    expect(done.map((task) => task.title).sort()).toEqual(['Скачать форму', 'Собрать документы']);
  });

  it('ищет и среди шагов (не только корней)', async () => {
    const parent = await createTask(USER_A, { title: 'Собрать документы' });
    const step = await createTask(USER_A, {
      title: 'Скачать форму',
      parentId: parent.id,
      position: 0,
    });

    const outcome = await run('complete_task', { query: 'скачать' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as CompleteData).task_id).toBe(step.id);
  });

  it('повторяющаяся задача порождает следующую итерацию', async () => {
    await createTask(USER_A, {
      title: 'Полить цветы',
      dueAt: '2026-03-16T08:00:00.000Z',
      remindAt: '2026-03-16T08:00:00.000Z',
      recurrence: { freq: 'daily' },
    });

    const outcome = await run('complete_task', { query: 'цветы' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as CompleteData;
    expect(data.next_task_id).not.toBeNull();
    expect(data.next_due_at).not.toBeNull();
    expect(outcome.content).toContain('Создано следующее повторение на');

    const open = await listTasks(USER_A, { status: 'todo' });
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('Полить цветы');
    expect(open[0].id).toBe(data.next_task_id);
    expect(open[0].recurrence).toEqual({ freq: 'daily' });
  });

  it('count = 1 — последняя итерация, спавна нет', async () => {
    await createTask(USER_A, {
      title: 'Разово',
      dueAt: '2026-03-16T08:00:00.000Z',
      recurrence: { freq: 'daily', count: 1 },
    });

    const outcome = await run('complete_task', { query: 'разово' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as CompleteData).next_task_id).toBeNull();
    expect(outcome.content).not.toContain('Создано следующее повторение');
    expect(await listTasks(USER_A, { status: 'todo' })).toEqual([]);
  });

  it('чужую задачу не закрывает', async () => {
    await createTask(USER_B, { title: 'Купить молоко' });

    const outcome = await run('complete_task', { query: 'молоко' }, contextFor(USER_A));
    expect(outcome.ok).toBe(false);
    expect(await listTasks(USER_B, { status: 'todo' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe('list_tasks', () => {
  it('пусто — дружелюбное сообщение', async () => {
    const outcome = await run('list_tasks', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'У вас пока нет открытых задач. Отличный момент для отдыха или новой идеи!',
    );
    expect((outcome.data as ListData)).toEqual({ tasks: [], count: 0 });
  });

  it('показывает только корни, с категорией, повтором, напоминанием и шагами', async () => {
    await ensureSystemCategories(USER_A);
    const id = await categoryId('Быт');
    const root = await createTask(USER_A, {
      title: 'Купить молоко',
      categoryId: id,
      remindAt: '2026-03-16T08:00:00.000Z',
      dueAt: '2026-03-16T08:00:00.000Z',
      recurrence: { freq: 'daily' },
    });
    await createTask(USER_A, { title: 'Взять тележку', parentId: root.id, position: 0 });
    await createTask(USER_A, { title: 'Оплатить', parentId: root.id, position: 1 });

    const outcome = await run('list_tasks', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Ваши актуальные дела:\n• Купить молоко [Быт] 🔁 ежедневно ⏰ 16.03 09:00 (2 шагов)',
    );

    const data = outcome.data as ListData;
    expect(data.count).toBe(1);
    expect(data.tasks[0]).toMatchObject({
      id: root.id,
      title: 'Купить молоко',
      category: 'Быт',
      remind_at: '2026-03-16T08:00:00.000Z',
      due_at: '2026-03-16T08:00:00.000Z',
      recurrence: { freq: 'daily' },
      subtasks_count: 2,
    });
  });

  it('сортирует по ближайшему напоминанию, без напоминания — в конце', async () => {
    await createTask(USER_A, { title: 'Без времени' });
    await createTask(USER_A, { title: 'Позже', remindAt: '2026-03-16T08:00:00.000Z' });
    await createTask(USER_A, { title: 'Раньше', remindAt: '2026-03-15T11:00:00.000Z' });

    const outcome = await run('list_tasks', {});
    const content = outcome.content;
    expect(content.indexOf('Раньше')).toBeLessThan(content.indexOf('Позже'));
    expect(content.indexOf('Позже')).toBeLessThan(content.indexOf('Без времени'));
  });

  it('фильтр по категории без учёта регистра (кириллица)', async () => {
    const id = await categoryId('Быт');
    await createTask(USER_A, { title: 'Помыть посуду', categoryId: id });
    await createTask(USER_A, { title: 'Смонтировать ролик' });

    const outcome = await run('list_tasks', { category_name: 'быт' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Помыть посуду');
    expect(outcome.content).not.toContain('Смонтировать ролик');
    expect((outcome.data as ListData).count).toBe(1);
  });

  it('фильтр по несуществующей категории — пустой список', async () => {
    await createTask(USER_A, { title: 'Смонтировать ролик' });
    const outcome = await run('list_tasks', { category_name: 'Работа' });
    expect(outcome.content).toBe(
      'У вас пока нет открытых задач. Отличный момент для отдыха или новой идеи!',
    );
  });

  it('закрытые задачи и чужие задачи не показывает', async () => {
    const done = await createTask(USER_A, { title: 'Уже сделано' });
    await run('complete_task', { query: 'сделано' });
    await createTask(USER_B, { title: 'Чужая задача' });
    expect(done.id).toBeGreaterThan(0);

    const outcome = await run('list_tasks', {});
    expect(outcome.content).toBe(
      'У вас пока нет открытых задач. Отличный момент для отдыха или новой идеи!',
    );
  });
});

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

describe('update_task', () => {
  it('без query — ok:false', async () => {
    const outcome = await run('update_task', { new_title: 'X' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Укажите задачу (query).');
  });

  it('не найдено — ok:false', async () => {
    const outcome = await run('update_task', { query: 'уборка', new_title: 'X' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не нашёл открытую задачу, похожую на «уборка».');
  });

  it('без изменений — ok:false с названием задачи', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', { query: 'молоко' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Для задачи «Купить молоко» не указано никаких изменений.');
  });

  it('переименовывает задачу', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', { query: 'молоко', new_title: 'Купить хлеб' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as UpdateData;
    expect(data.title).toBe('Купить хлеб');
    expect(data.changes).toEqual(['название: «Купить хлеб»']);
    expect(outcome.content).toBe(
      '✅ Задача «Купить хлеб» успешно обновлена (название: «Купить хлеб»).',
    );
  });

  it('переносит напоминание (и срок вместе с ним)', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', {
      query: 'молоко',
      remind_at: '2026-03-16 09:00',
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as UpdateData;
    expect(data.remind_at).toBe('2026-03-16T08:00:00.000Z');
    expect(data.due_at).toBe(data.remind_at);
    expect(data.changes).toEqual(['напоминание: 16.03.2026 в 09:00']);
  });

  it('remind_in_minutes считается от ctx.now', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', { query: 'молоко', remind_in_minutes: 15 });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as UpdateData).remind_at).toBe('2026-03-15T10:15:00.000Z');
    expect(outcome.content).toContain('напоминание: 15.03.2026 в 11:15');
  });

  it('due_at без напоминания описывается как срок', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', {
      query: 'молоко',
      due_at: '2026-03-20T18:00:00+01:00',
    });
    expect(outcome.ok).toBe(true);
    const data = outcome.data as UpdateData;
    expect(data.due_at).toBe('2026-03-20T17:00:00.000Z');
    expect(data.remind_at).toBeNull();
    expect(data.changes).toEqual(['срок: 20.03.2026 в 18:00']);
  });

  it('меняет категорию на существующую', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', { query: 'молоко', category_name: 'Быт' });
    expect(outcome.ok).toBe(true);
    const data = outcome.data as UpdateData;
    expect(data.category_id).toBe(await categoryId('Быт'));
    expect(data.changes).toEqual(['категория: Быт']);
  });

  it('несуществующая категория — ok:false со списком доступных', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('update_task', { query: 'молоко', category_name: 'Работа' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Категория «Работа» не найдена. Доступные категории:');
    expect(outcome.content).toContain('Стартап');
    expect(outcome.content).toContain('Быт');
  });

  it('заметка ставится и очищается пустой строкой', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });

    const set = await run('update_task', { query: 'молоко', notes: '2 литра' });
    expect(set.ok).toBe(true);
    expect((set.data as UpdateData).notes).toBe('2 литра');
    expect(set.content).toContain('заметка: 2 литра');

    const cleared = await run('update_task', { query: 'молоко', notes: '' });
    expect(cleared.ok).toBe(true);
    expect((cleared.data as UpdateData).notes).toBeNull();
    expect(cleared.content).toContain('заметка: —');
  });

  it('строка частоты включает повтор', async () => {
    await createTask(USER_A, { title: 'Полить цветы' });
    const outcome = await run('update_task', { query: 'цветы', recurrence: 'daily' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as UpdateData).recurrence).toEqual({ freq: 'daily' });
    expect(outcome.content).toContain('повтор: ежедневно');
  });

  it('«none» отключает повтор', async () => {
    await createTask(USER_A, {
      title: 'Полить цветы',
      recurrence: { freq: 'daily' },
    });
    const outcome = await run('update_task', { query: 'цветы', recurrence: 'none' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as UpdateData).recurrence).toBeNull();
    expect(outcome.content).toContain('повтор отключён');
  });

  it('recurrence: null не считается изменением', async () => {
    await createTask(USER_A, {
      title: 'Полить цветы',
      recurrence: { freq: 'daily' },
    });
    const outcome = await run('update_task', { query: 'цветы', recurrence: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Для задачи «Полить цветы» не указано никаких изменений.');
  });

  it('шаг не находится: ищем только среди корней', async () => {
    const parent = await createTask(USER_A, { title: 'Собрать документы' });
    await createTask(USER_A, { title: 'Скачать форму', parentId: parent.id, position: 0 });

    const outcome = await run('update_task', { query: 'скачать', new_title: 'Скачать PDF' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не нашёл открытую задачу, похожую на «скачать».');
  });

  it('чужую задачу не правит', async () => {
    await createTask(USER_B, { title: 'Купить молоко' });
    const outcome = await run('update_task', { query: 'молоко', new_title: 'X' }, contextFor(USER_A));
    expect(outcome.ok).toBe(false);
    const [stored] = await listTasks(USER_B, { status: 'todo' });
    expect(stored.title).toBe('Купить молоко');
  });
});

// ---------------------------------------------------------------------------
// delete_task
// ---------------------------------------------------------------------------

describe('delete_task', () => {
  it('без query — ok:false', async () => {
    const outcome = await run('delete_task', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Укажите задачу (query).');
  });

  it('не найдено — ok:false', async () => {
    const outcome = await run('delete_task', { query: 'уборка' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не нашёл открытую задачу, похожую на «уборка».');
  });

  it('удаляет задачу в корзину и убирает из открытых', async () => {
    const task = await createTask(USER_A, { title: 'Купить молоко' });

    const outcome = await run('delete_task', { query: 'молоко' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as DeleteData;
    expect(data).toEqual({ task_id: task.id, title: 'Купить молоко', deleted: true });
    expect(outcome.content).toBe(
      '🗑️ Задача «Купить молоко» удалена и перемещена в корзину (будет храниться 30 дней).',
    );

    expect(await listTasks(USER_A, { status: 'todo' })).toEqual([]);
    const trash = await listTrash(USER_A);
    expect(trash.totalCount).toBe(1);
    expect(trash.tasks[0]).toMatchObject({ id: task.id, title: 'Купить молоко', kind: 'task' });
  });

  it('шаги уходят в корзину вместе с родителем', async () => {
    const parent = await createTask(USER_A, { title: 'Собрать документы' });
    await createTask(USER_A, { title: 'Скачать форму', parentId: parent.id, position: 0 });
    await createTask(USER_A, { title: 'Распечатать', parentId: parent.id, position: 1 });

    const outcome = await run('delete_task', { query: 'документы' });
    expect(outcome.ok).toBe(true);

    expect(await listTasks(USER_A, { status: 'todo' })).toEqual([]);
    const trash = await listTrash(USER_A);
    expect(trash.tasks).toHaveLength(1);
    expect(trash.tasks[0].stepsCount).toBe(2);
  });

  it('шаг отдельно не удаляется (только корни)', async () => {
    const parent = await createTask(USER_A, { title: 'Собрать документы' });
    await createTask(USER_A, { title: 'Скачать форму', parentId: parent.id, position: 0 });

    const outcome = await run('delete_task', { query: 'скачать' });
    expect(outcome.ok).toBe(false);
    expect(await listTasks(USER_A, { status: 'todo' })).toHaveLength(2);
  });

  it('чужую задачу не удаляет', async () => {
    await createTask(USER_B, { title: 'Купить молоко' });
    const outcome = await run('delete_task', { query: 'молоко' }, contextFor(USER_A));
    expect(outcome.ok).toBe(false);
    expect(await listTasks(USER_B, { status: 'todo' })).toHaveLength(1);
    expect((await listTrash(USER_B)).totalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// auto_detect_tasks
// ---------------------------------------------------------------------------

describe('auto_detect_tasks', () => {
  it('без текста действия — ok:false', async () => {
    const outcome = await run('auto_detect_tasks', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Укажите текст выполненного действия (action_text).');
  });

  it('слишком короткий текст — ok:false', async () => {
    const outcome = await run('auto_detect_tasks', { action_text: 'ок' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не нашёл открытых задач, совпадающих с действием «ок».');
  });

  it('находит задачу по стему ключевого слова и закрывает её', async () => {
    await createTask(USER_A, { title: 'Оплатить интернет' });

    const outcome = await run('auto_detect_tasks', {
      action_text: 'оплатил интернет 50 евро',
    });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as DetectData;
    expect(data.title).toBe('Оплатить интернет');
    expect(data.next_task_id).toBeNull();
    expect(data.details).toBeNull();
    expect(outcome.content).toBe(
      '🎯 Авто-детект: задача «Оплатить интернет» найдена и успешно отмечена выполненной! 🎉',
    );
    expect(await listTasks(USER_A, { status: 'todo' })).toEqual([]);
  });

  it('поддерживает alias text', async () => {
    await createTask(USER_A, { title: 'Позвонить маме' });
    const outcome = await run('auto_detect_tasks', { text: 'позвонил маме' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as DetectData).title).toBe('Позвонить маме');
  });

  it('ищет совпадения и в заметках задачи', async () => {
    await createTask(USER_A, { title: 'Домашние дела', notes: 'пропылесосить квартиру' });
    const outcome = await run('auto_detect_tasks', { action_text: 'пропылесосил квартиру' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as DetectData).title).toBe('Домашние дела');
  });

  it('нет совпадений — ok:false с текстом действия', async () => {
    await createTask(USER_A, { title: 'Купить молоко' });
    const outcome = await run('auto_detect_tasks', { action_text: 'починил велосипед' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'Не нашёл открытых задач, совпадающих с действием «починил велосипед».',
    );
  });

  it('только стоп-слова: fallback по первым словам всё равно ищет', async () => {
    await createTask(USER_A, { title: 'Оплатить интернет' });
    const outcome = await run('auto_detect_tasks', { action_text: 'оплата' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as DetectData).title).toBe('Оплатить интернет');
  });

  it('повторяющаяся задача: детали следующего повторения в тексте', async () => {
    await createTask(USER_A, {
      title: 'Полить цветы',
      dueAt: '2026-03-16T08:00:00.000Z',
      recurrence: { freq: 'daily' },
    });

    const outcome = await run('auto_detect_tasks', { action_text: 'полил цветы' });
    expect(outcome.ok).toBe(true);

    const data = outcome.data as DetectData;
    expect(data.next_task_id).not.toBeNull();
    expect(data.details).toContain('создано следующее повторение на');
    expect(outcome.content).toContain('(создано следующее повторение на');
  });

  it('чужую задачу не закрывает', async () => {
    await createTask(USER_B, { title: 'Оплатить интернет' });
    const outcome = await run('auto_detect_tasks', { action_text: 'оплатил интернет' }, contextFor(USER_A));
    expect(outcome.ok).toBe(false);
    expect(await listTasks(USER_B, { status: 'todo' })).toHaveLength(1);
  });
});
