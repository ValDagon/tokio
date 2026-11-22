/**
 * Тулзы агента: задачи и напоминания (SPEC §3 T12, паритет с
 * `backend/app/agent/tools/tasks.py`).
 *
 * ADR-002 (время): «сейчас» и таймзона приходят только из `ctx.now` /
 * `ctx.timezone`, никаких собственных `ZoneInfo`/`Intl`-констант. Строки дат
 * без оффсета (`2026-03-16 09:00`) трактуются как локальное время пользователя
 * (two-pass через `zoneOffsetMs`), с оффсетом/`Z` — как есть.
 *
 * ADR-002 (категории): никакого хардкода категории по умолчанию. «Быт»
 * используется только если реально нашлась через `findCategoryByName`; иначе
 * задача создаётся без категории (`categoryId: null`).
 *
 * Отличия от upstream (осознанно, §8):
 *  - в TS нет русского парсинга дат/повторов: `remind_at`/`due_at` — только
 *    ISO-8601, `remind_in_minutes` — смещение в минутах, `recurrence` —
 *    структурный `RecurrenceRule` (строка «ежедневно» не разбирается);
 *  - get-or-create категорий недоступен: в DAL есть `createCategory` только
 *    для финансовых категорий, для `task_categories` — нет; поэтому неизвестная
 *    категория не создаётся, задача ложится без категории;
 *  - fallback-парсинг повтора/даты из `notes` (batch, add_task) выброшен;
 *  - `auto_detect_tasks` — порт `auto_detect_completed_task` без LLM-вызовов.
 */

import type { RecurrenceRule, TaskRow } from '../../../types';
import {
  completeTask,
  createTask,
  ensureSystemCategories,
  findCategoryByName,
  listCategories,
  listTasks,
  updateTask,
} from '../../dal/tasks';
import { softDeleteTask } from '../../dal/misc';
import type { TaskCategoryRow } from '../../../types';
import {
  addMinutes,
  formatDate,
  fromIso,
  timeKey,
  toIso,
  zoneOffsetMs,
} from '../../utils';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

export function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Целое из аргумента (число или строка); `null` — не разобрать. */
export function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Обрезка до `n` символов с ASCII-многоточием (upstream-семантика). */
export function snippet(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}...` : text;
}

/** Момент времени, разобранный из аргумента. */
type Moment = { ok: true; value: Date | null } | { ok: false; content: string };

const FREQS: readonly string[] = ['daily', 'weekly', 'monthly', 'yearly'];
const NAIVE_ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const ZONED_ISO = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO-8601 → Date. Строка без оффсета — локальное время пользователя.
 * `null` — не ISO / невалидная дата.
 */
function parseWhen(raw: unknown, timeZone: string): Date | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  if (ZONED_ISO.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const naive = NAIVE_ISO.exec(value);
  if (!naive) return null;
  const [, y, mo, d, h, mi, s, ms] = naive;
  const naiveUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? '0'),
    Number(mi ?? '0'),
    Number(s ?? '0'),
    Number((ms ?? '0').padEnd(3, '0')),
  );
  // two-pass: смещение может измениться на границе DST
  const first = new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc), timeZone));
  return new Date(naiveUtc - zoneOffsetMs(first, timeZone));
}

function readMoment(value: unknown, ctx: ToolContext, label: string): Moment {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const parsed = parseWhen(value, ctx.timezone);
  if (!parsed) {
    return {
      ok: false,
      content: `${label} должен быть датой ISO-8601 (например «2026-03-16T09:00:00+01:00» или «2026-03-16 09:00»).`,
    };
  }
  return { ok: true, value: parsed };
}

/** Напоминание: `remind_in_minutes` приоритетнее `remind_at` (паритет с upstream). */
function readReminder(args: ToolArgs, ctx: ToolContext): Moment {
  const minutesRaw = args.remind_in_minutes;
  if (minutesRaw !== undefined && minutesRaw !== null && minutesRaw !== '') {
    const minutes = asInt(minutesRaw);
    if (minutes === null) return { ok: false, content: 'remind_in_minutes должен быть целым числом.' };
    return { ok: true, value: addMinutes(ctx.now, minutes) };
  }
  return readMoment(args.remind_at, ctx, 'remind_at');
}

type RecurrenceParse = { ok: true; value: RecurrenceRule | null } | { ok: false; content: string };

const RECURRENCE_HINT =
  'recurrence — объект вида {"freq": "weekly", "interval": 2, "weekdays": [0, 2]} (freq: daily|weekly|monthly|yearly).';

/** Структурное правило повтора. Строка допускается только с именем частоты или «none». */
function readRecurrence(value: unknown): RecurrenceParse {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (!lower) return { ok: true, value: null };
    if (['none', 'нет', 'отменить', 'без повтора'].includes(lower)) return { ok: true, value: null };
    if (FREQS.includes(lower)) return { ok: true, value: { freq: lower as RecurrenceRule['freq'] } };
    return { ok: false, content: RECURRENCE_HINT };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, content: RECURRENCE_HINT };
  }

  const raw = value as Record<string, unknown>;
  const freq = typeof raw.freq === 'string' ? raw.freq.trim().toLowerCase() : '';
  if (!FREQS.includes(freq)) return { ok: false, content: RECURRENCE_HINT };

  const rule: RecurrenceRule = { freq: freq as RecurrenceRule['freq'] };

  if (raw.interval !== undefined && raw.interval !== null) {
    const interval = asInt(raw.interval);
    if (interval === null || interval < 1) {
      return { ok: false, content: 'interval в recurrence должен быть целым числом ≥ 1.' };
    }
    rule.interval = interval;
  }

  if (raw.weekdays !== undefined && raw.weekdays !== null) {
    if (!Array.isArray(raw.weekdays)) {
      return { ok: false, content: 'weekdays в recurrence — массив чисел 0..6 (0 = понедельник).' };
    }
    const days: number[] = [];
    for (const item of raw.weekdays) {
      const day = asInt(item);
      if (day === null || day < 0 || day > 6) {
        return { ok: false, content: 'weekdays в recurrence — массив чисел 0..6 (0 = понедельник).' };
      }
      if (!days.includes(day)) days.push(day);
    }
    if (days.length > 0) rule.weekdays = days;
  }

  if (raw.until !== undefined && raw.until !== null && raw.until !== '') {
    if (typeof raw.until !== 'string' || !DATE_ONLY.test(raw.until.trim())) {
      return { ok: false, content: 'until в recurrence — дата «YYYY-MM-DD».' };
    }
    rule.until = raw.until.trim();
  }

  if (raw.count !== undefined && raw.count !== null) {
    const count = asInt(raw.count);
    if (count === null || count < 1) {
      return { ok: false, content: 'count в recurrence должен быть целым числом ≥ 1.' };
    }
    rule.count = count;
  }

  return { ok: true, value: rule };
}

/** Человекочитаемый повтор (порт `format_recurrence_ru`). */
function recurrenceRu(rule: RecurrenceRule): string {
  const interval = rule.interval !== undefined && rule.interval > 1 ? rule.interval : 1;
  switch (rule.freq) {
    case 'daily':
      return interval === 1 ? 'ежедневно' : `каждые ${interval} дн.`;
    case 'weekly':
      return interval === 1 ? 'еженедельно' : `каждые ${interval} нед.`;
    case 'monthly':
      return interval === 1 ? 'ежемесячно' : `каждые ${interval} мес.`;
    case 'yearly':
      return interval === 1 ? 'ежегодно' : `каждые ${interval} г.`;
    default:
      return rule.freq;
  }
}

/** `16.03.2026 в 09:00` в таймзоне пользователя. */
function dateInWords(date: Date, timeZone: string): string {
  return `${formatDate(date, timeZone)} в ${timeKey(date, timeZone)}`;
}

/** `16.03 09:00` — компактная метка напоминания (паритет с `list_tasks` upstream). */
function shortDate(date: Date, timeZone: string): string {
  return `${formatDate(date, timeZone).slice(0, 5)} ${timeKey(date, timeZone)}`;
}

/**
 * Категория по имени: `ensureSystemCategories` создаёт системные, дальше —
 * точный `findCategoryByName`. Не нашли → `null` (get-or-create в DAL нет).
 */
async function resolveCategoryId(ctx: ToolContext, name: string | null): Promise<number | null> {
  if (!name) return null;
  await ensureSystemCategories(ctx.userId);
  const category = await findCategoryByName(ctx.userId, name);
  return category ? category.id : null;
}

function categoryMap(categories: readonly TaskCategoryRow[]): Map<number, string> {
  return new Map(categories.map((category) => [category.id, category.name]));
}

/** Шаги: `undefined` — не заданы, `null` — заданы невалидно. */
function asSteps(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const steps: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) steps.push(item.trim());
  }
  return steps;
}

/** Корневые открытые задачи, свежие сверху (порт условия upstream). */
async function listOpenRoots(ctx: ToolContext): Promise<TaskRow[]> {
  const tasks = await listTasks(ctx.userId, { status: 'todo', parentId: null, limit: 500 });
  return tasks;
}

/** Поиск задачи по названию: точное совпадение без регистра, иначе подстрока. */
function matchTask(tasks: readonly TaskRow[], query: string): TaskRow | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  return tasks.find((task) => task.title.toLowerCase().includes(needle)) ?? null;
}

// ---------------------------------------------------------------------------
// set_reminder
// ---------------------------------------------------------------------------

/**
 * Ставит напоминание: задача с `dueAt = remindAt`. Без времени — «через час»
 * от `ctx.now` (upstream-fallback).
 */
async function setReminder(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const title = asText(args.title);
  if (!title) return fail('Укажите, о чём напомнить (title).');

  const reminder = readReminder(args, ctx);
  if (!reminder.ok) return fail(reminder.content);

  const recurrence = readRecurrence(args.recurrence);
  if (!recurrence.ok) return fail(recurrence.content);

  const notes = args.notes === undefined ? null : asText(args.notes);
  const categoryName = asText(args.category_name);

  try {
    const categoryId = await resolveCategoryId(ctx, categoryName);
    const when = reminder.value ?? addMinutes(ctx.now, 60);
    const whenIso = toIso(when);

    const task = await createTask(ctx.userId, {
      title,
      categoryId,
      notes,
      dueAt: whenIso,
      remindAt: whenIso,
      recurrence: recurrence.value,
    });

    const recDesc = recurrence.value ? `, повтор: ${recurrenceRu(recurrence.value)}` : '';
    // у «каждые 2 нед.» уже есть точка — второй не ставим
    const tail = recDesc.endsWith('.') ? '' : '.';
    return {
      ok: true,
      content: `⏰ Напоминание установлено! Я пришлю уведомление в Telegram ${dateInWords(
        when,
        ctx.timezone,
      )} по задаче: «${task.title}»${recDesc}${tail}`,
      data: {
        task_id: task.id,
        title: task.title,
        remind_at: task.remindAt,
        due_at: task.dueAt,
        recurrence: task.recurrence,
      },
    };
  } catch (error) {
    return fail(`Не удалось установить напоминание: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

/**
 * Добавляет задачу: категория, шаги, заметки, напоминание, срок, повтор.
 * `due_at` без `remind_at` → срок; напоминание без срока → срок = напоминание.
 */
async function addTask(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const title = asText(args.title);
  if (!title) return fail('Укажите название задачи (title).');

  const reminder = readReminder(args, ctx);
  if (!reminder.ok) return fail(reminder.content);

  const due = readMoment(args.due_at, ctx, 'due_at');
  if (!due.ok) return fail(due.content);

  const recurrence = readRecurrence(args.recurrence);
  if (!recurrence.ok) return fail(recurrence.content);

  const steps = asSteps(args.steps);
  if (steps === null) return fail('steps — массив строк с короткими шагами задачи.');

  const notes = args.notes === undefined ? null : asText(args.notes);
  const categoryName = asText(args.category_name);

  try {
    const categoryId = await resolveCategoryId(ctx, categoryName);
    const remindAt = reminder.value;
    const dueAt = due.value ?? remindAt;

    const task = await createTask(ctx.userId, {
      title,
      categoryId,
      notes,
      dueAt: dueAt ? toIso(dueAt) : null,
      remindAt: remindAt ? toIso(remindAt) : null,
      recurrence: recurrence.value,
    });

    let stepsCreated = 0;
    if (steps) {
      for (const [position, step] of steps.entries()) {
        await createTask(ctx.userId, {
          title: step,
          categoryId,
          parentId: task.id,
          position,
        });
        stepsCreated += 1;
      }
    }

    const recDesc = recurrence.value ? `, повтор: ${recurrenceRu(recurrence.value)}` : '';
    const remindDesc = remindAt ? `, напомню ${dateInWords(remindAt, ctx.timezone)}` : '';
    const categoryPart = categoryName
      ? categoryId !== null
        ? categoryName
        : `без категории, «${categoryName}» не найдена`
      : 'без категории';
    let content = `Записал задачу: «${task.title}» (категория: ${categoryPart})${recDesc}${remindDesc}`;
    if (stepsCreated > 0) content += ` с ${stepsCreated} шагами`;

    return {
      ok: true,
      content,
      data: {
        task_id: task.id,
        title: task.title,
        category_id: task.categoryId,
        category_name: categoryName,
        notes: task.notes,
        due_at: task.dueAt,
        remind_at: task.remindAt,
        recurrence: task.recurrence,
        steps_created: stepsCreated,
      },
    };
  } catch (error) {
    return fail(`Не удалось добавить задачу: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// add_tasks_batch
// ---------------------------------------------------------------------------

interface BatchLine {
  title: string;
  categoryName: string | null;
  notes: string | null;
  remindAt: string | null;
  dueAt: string | null;
  recurrence: RecurrenceRule | null;
}

/**
 * Пакетное добавление задач (импорт списка со скриншота или из текста).
 * Дата одна на задачу: `remind_at ?? due_at` → due = remind (как в upstream).
 */
async function addTasksBatch(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const raw = args.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return fail('Список задач пуст.');

  const parsed: BatchLine[] = [];
  const skipped: number[] = [];

  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      skipped.push(index);
      continue;
    }
    const entry = item as Record<string, unknown>;
    const title = asText(entry.title);
    if (!title) {
      skipped.push(index);
      continue;
    }

    const reminder = readMoment(entry.remind_at, ctx, 'remind_at');
    if (!reminder.ok) return fail(reminder.content);
    const due = readMoment(entry.due_at, ctx, 'due_at');
    if (!due.ok) return fail(due.content);
    const recurrence = readRecurrence(entry.recurrence);
    if (!recurrence.ok) return fail(recurrence.content);

    const moment = reminder.value ?? due.value;
    const categoryName = asText(entry.category_name) ?? asText(entry.category);

    parsed.push({
      title,
      categoryName,
      notes: asText(entry.notes),
      remindAt: moment ? toIso(moment) : null,
      dueAt: moment ? toIso(moment) : null,
      recurrence: recurrence.value,
    });
  }

  if (parsed.length === 0) return fail('Не удалось добавить задачи (пустые названия).');

  try {
    const lines: string[] = [];
    const createdIds: number[] = [];

    for (const line of parsed) {
      const categoryId = await resolveCategoryId(ctx, line.categoryName);
      const task = await createTask(ctx.userId, {
        title: line.title,
        categoryId,
        notes: line.notes,
        dueAt: line.dueAt,
        remindAt: line.remindAt,
        recurrence: line.recurrence,
      });
      createdIds.push(task.id);

      const cat = line.categoryName
        ? categoryId !== null
          ? line.categoryName
          : `${line.categoryName} → без категории (не найдена)`
        : 'без категории';
      const recPart = line.recurrence ? ` [🔁 ${recurrenceRu(line.recurrence)}]` : '';
      const notePart = line.notes ? ` — ${line.notes}` : '';
      lines.push(`• «${line.title}» [${cat}]${recPart}${notePart}`);
    }

    return {
      ok: true,
      content: `Успешно зафиксировал ${lines.length} задач в списке дел:\n${lines.join('\n')}`,
      data: {
        created: createdIds,
        count: createdIds.length,
        skipped,
      },
    };
  } catch (error) {
    return fail(`Не удалось добавить задачи: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// complete_task
// ---------------------------------------------------------------------------

/**
 * Отмечает задачу выполненной по названию/фрагменту; при повторе создаёт
 * следующую итерацию.
 */
async function completeTaskTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите задачу (query).');

  try {
    // Паритет с upstream: ищем среди ВСЕХ открытых задач (включая шаги), свежие сверху.
    const tasks = await listTasks(ctx.userId, { status: 'todo', limit: 500 });
    const matched = matchTask(tasks, query);
    if (!matched) return fail(`Не нашёл открытую задачу, похожую на «${query}».`);

    const result = await completeTask(ctx.userId, matched.id);
    if (!result.completed) return fail(`Не нашёл открытую задачу, похожую на «${query}».`);

    const next = result.nextTask;
    const nextPart = next
      ? ` Создано следующее повторение на ${dateInWords(
          fromIso(next.remindAt) ?? fromIso(next.dueAt) ?? ctx.now,
          ctx.timezone,
        )}!`
      : '';

    return {
      ok: true,
      content: `Отлично! Задача «${matched.title}» выполнена 🎉${nextPart}`,
      data: {
        task_id: matched.id,
        title: matched.title,
        next_task_id: next ? next.id : null,
        next_due_at: next ? next.dueAt : null,
      },
    };
  } catch (error) {
    return fail(`Не удалось завершить задачу: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

/**
 * Открытые корневые задачи: категория, повтор, ближайшее напоминание, число
 * шагов. Фильтр по категории — по имени (без регистра).
 */
async function listTasksTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const categoryName = asText(args.category_name);

  try {
    const categories = categoryMap(await listCategories(ctx.userId));
    const all = await listTasks(ctx.userId, { status: 'todo', limit: 500 });

    let roots = all.filter((task) => task.parentId === null && task.status === 'todo');
    if (categoryName) {
      const needle = categoryName.toLowerCase();
      roots = roots.filter((task) => {
        const name = task.categoryId === null ? null : categories.get(task.categoryId);
        return name ? name.toLowerCase() === needle : false;
      });
    }

    const stepsByParent = new Map<number, number>();
    for (const task of all) {
      if (task.parentId === null || task.status !== 'todo') continue;
      stepsByParent.set(task.parentId, (stepsByParent.get(task.parentId) ?? 0) + 1);
    }

    roots.sort((a, b) => {
      const left = fromIso(a.remindAt);
      const right = fromIso(b.remindAt);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return left.getTime() - right.getTime();
    });

    const top = roots.slice(0, 20);
    if (top.length === 0) {
      return {
        ok: true,
        content: 'У вас пока нет открытых задач. Отличный момент для отдыха или новой идеи!',
        data: { tasks: [], count: 0 },
      };
    }

    const lines: string[] = ['Ваши актуальные дела:'];
    for (const task of top) {
      const category = task.categoryId === null ? null : categories.get(task.categoryId);
      const cat = category ? ` [${category}]` : '';
      const steps = stepsByParent.get(task.id) ?? 0;
      const sub = steps > 0 ? ` (${steps} шагов)` : '';
      const rec = task.recurrence ? ` 🔁 ${recurrenceRu(task.recurrence)}` : '';
      const remindAt = fromIso(task.remindAt);
      const remind = remindAt ? ` ⏰ ${shortDate(remindAt, ctx.timezone)}` : '';
      lines.push(`• ${task.title}${cat}${rec}${remind}${sub}`);
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        count: top.length,
        tasks: top.map((task) => ({
          id: task.id,
          title: task.title,
          category: task.categoryId === null ? null : (categories.get(task.categoryId) ?? null),
          remind_at: task.remindAt,
          due_at: task.dueAt,
          recurrence: task.recurrence,
          subtasks_count: stepsByParent.get(task.id) ?? 0,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось получить список задач: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

/**
 * Правит задачу: название, напоминание/срок, категория, заметка, повтор.
 * Пустой набор изменений → `ok:false` (паритет с upstream).
 */
async function updateTaskTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите задачу (query).');

  const newTitle = args.new_title === undefined ? null : asText(args.new_title);
  const reminder = readReminder(args, ctx);
  if (!reminder.ok) return fail(reminder.content);
  const due = readMoment(args.due_at, ctx, 'due_at');
  if (!due.ok) return fail(due.content);
  const recurrence = readRecurrence(args.recurrence);
  if (!recurrence.ok) return fail(recurrence.content);

  try {
    const roots = await listOpenRoots(ctx);
    const task = matchTask(roots, query);
    if (!task) return fail(`Не нашёл открытую задачу, похожую на «${query}».`);

    const patch: Parameters<typeof updateTask>[2] = {};
    const changes: string[] = [];

    if (newTitle) {
      patch.title = newTitle;
      changes.push(`название: «${newTitle}»`);
    }

    const remindAt = reminder.value;
    const dueAt = due.value ?? remindAt;

    if (remindAt) {
      patch.remindAt = toIso(remindAt);
      changes.push(`напоминание: ${dateInWords(remindAt, ctx.timezone)}`);
    }
    if (dueAt) {
      patch.dueAt = toIso(dueAt);
      // «срок» описываем отдельно только если напоминание не задавали (upstream)
      if (!remindAt) changes.push(`срок: ${dateInWords(dueAt, ctx.timezone)}`);
    }

    if (args.category_name !== undefined && args.category_name !== null) {
      const categoryName = asText(args.category_name);
      if (categoryName) {
        const category = await resolveCategoryId(ctx, categoryName);
        if (category === null) {
          const available = await listCategories(ctx.userId);
          const names = available.map((item) => item.name).join(', ');
          return fail(
            `Категория «${categoryName}» не найдена. Доступные категории: ${names || 'нет — создайте категорию в интерфейсе'}.`,
          );
        }
        patch.categoryId = category;
        changes.push(`категория: ${categoryName}`);
      }
    }

    if (args.notes !== undefined) {
      const notes = asText(args.notes);
      patch.notes = notes;
      changes.push(`заметка: ${notes ?? '—'}`);
    }

    if (args.recurrence !== undefined && args.recurrence !== null) {
      if (recurrence.value === null) {
        patch.recurrence = null;
        changes.push('повтор отключён');
      } else {
        patch.recurrence = recurrence.value;
        changes.push(`повтор: ${recurrenceRu(recurrence.value)}`);
      }
    }

    if (changes.length === 0) {
      return fail(`Для задачи «${task.title}» не указано никаких изменений.`);
    }

    const updated = await updateTask(ctx.userId, task.id, patch);
    if (!updated) return fail(`Не нашёл открытую задачу, похожую на «${query}».`);

    const titleUsed = newTitle ?? task.title;
    return {
      ok: true,
      content: `✅ Задача «${titleUsed}» успешно обновлена (${changes.join(', ')}).`,
      data: {
        task_id: updated.id,
        title: updated.title,
        category_id: updated.categoryId,
        notes: updated.notes,
        due_at: updated.dueAt,
        remind_at: updated.remindAt,
        recurrence: updated.recurrence,
        changes,
      },
    };
  } catch (error) {
    return fail(`Не удалось обновить задачу: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// delete_task
// ---------------------------------------------------------------------------

/** Мягкое удаление задачи в корзину (30 дней). */
async function deleteTaskTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите задачу (query).');

  try {
    const roots = await listOpenRoots(ctx);
    const task = matchTask(roots, query);
    if (!task) return fail(`Не нашёл открытую задачу, похожую на «${query}».`);

    const deleted = await softDeleteTask(ctx.userId, task.id);
    if (!deleted) return fail(`Не удалось удалить задачу «${task.title}».`);

    return {
      ok: true,
      content: `🗑️ Задача «${task.title}» удалена и перемещена в корзину (будет храниться 30 дней).`,
      data: { task_id: task.id, title: task.title, deleted: true },
    };
  } catch (error) {
    return fail(`Не удалось удалить задачу: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// auto_detect_tasks
// ---------------------------------------------------------------------------

const AUTO_DETECT_STOP_WORDS = new Set([
  'оплата',
  'расход',
  'перевод',
  'деньги',
  'купил',
  'купила',
  'сделал',
  'сделала',
  'отправил',
  'отправила',
  'евро',
  'рублей',
  'счёт',
  'банка',
  'оплатил',
  'оплатила',
]);

const WORD_RE = /[a-zA-Zа-яА-ЯёЁ0-9]{4,}/g;

/**
 * Авто-детект выполненной задачи (порт `auto_detect_completed_task` без LLM):
 * ключевые слова действия (стемы по 5 символов) ищутся в названии/заметках
 * открытых корневых задач; первое совпадение закрывается.
 */
async function autoDetectTasks(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const actionText = asText(args.action_text) ?? asText(args.text);
  if (!actionText) return fail('Укажите текст выполненного действия (action_text).');

  if (actionText.length < 3) {
    return fail(`Не нашёл открытых задач, совпадающих с действием «${actionText}».`);
  }

  try {
    const rawWords = actionText.toLowerCase().match(WORD_RE) ?? [];
    let keywords = rawWords.filter((word) => !AUTO_DETECT_STOP_WORDS.has(word));
    if (keywords.length === 0 && rawWords.length > 0) keywords = rawWords.slice(0, 3);
    if (keywords.length === 0) {
      return fail(`Не нашёл открытых задач, совпадающих с действием «${actionText}».`);
    }

    const roots = await listOpenRoots(ctx);
    let matched: TaskRow | null = null;
    for (const task of roots) {
      const haystack = `${task.title.toLowerCase()} ${(task.notes ?? '').toLowerCase()}`;
      for (const keyword of keywords) {
        const stem = keyword.length >= 5 ? keyword.slice(0, 5) : keyword;
        if (haystack.includes(stem)) {
          matched = task;
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      return fail(`Не нашёл открытых задач, совпадающих с действием «${actionText}».`);
    }

    const result = await completeTask(ctx.userId, matched.id);
    if (!result.completed) {
      return fail(`Не нашёл открытых задач, совпадающих с действием «${actionText}».`);
    }

    const next = result.nextTask;
    const details = next
      ? `создано следующее повторение на ${dateInWords(
          fromIso(next.remindAt) ?? fromIso(next.dueAt) ?? ctx.now,
          ctx.timezone,
        )}`
      : null;

    return {
      ok: true,
      content: `🎯 Авто-детект: задача «${matched.title}» найдена и успешно отмечена выполненной! 🎉${
        details ? ` (${details})` : ''
      }`,
      data: {
        task_id: matched.id,
        title: matched.title,
        next_task_id: next ? next.id : null,
        details,
      },
    };
  } catch (error) {
    return fail(`Не удалось обработать действие: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** Константы, не фабрики: реестр регистрирует их как есть. */
export const tasksTools: Tool[] = [
  {
    name: 'set_reminder',
    effect: { kind: 'create' },
    description:
      'Ставит точное напоминание в Telegram: задача с датой и (опционально) повтором. Время — ISO-8601 или смещение в минутах.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'О чём напомнить, например «Позвонить маме».' },
        remind_at: {
          type: 'string',
          description:
            'Когда напомнить: ISO-8601 «2026-03-16T09:00:00+01:00» или «2026-03-16 09:00» (локальное время).',
        },
        remind_in_minutes: {
          type: 'integer',
          description: 'Смещение в минутах от текущего момента (например 60).',
        },
        recurrence: {
          type: 'object',
          description: 'Правило повтора: {"freq":"daily|weekly|monthly|yearly","interval":N}.',
        },
        notes: { type: 'string', description: 'Детали к напоминанию.' },
        category_name: {
          type: 'string',
          description: 'Категория («Быт», «Работа», …); неизвестная — задача без категории.',
        },
      },
      required: ['title'],
    },
    run: setReminder,
  },
  {
    name: 'add_task',
    effect: { kind: 'create' },
    description:
      'Добавляет задачу в список дел: категория, шаги, заметки, напоминание, срок и повтор.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Название задачи.' },
        category_name: {
          type: 'string',
          description: 'Категория («Работа», «Быт», «Хобби», …); неизвестная — без категории.',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Короткие атомарные шаги (до 15 минут каждый).',
        },
        notes: { type: 'string', description: 'Дополнительные заметки к задаче.' },
        remind_at: { type: 'string', description: 'Время напоминания ISO-8601.' },
        due_at: { type: 'string', description: 'Срок выполнения ISO-8601.' },
        recurrence: {
          type: 'object',
          description: 'Правило повтора: {"freq":"daily|weekly|monthly|yearly","interval":N}.',
        },
        remind_in_minutes: {
          type: 'integer',
          description: 'Смещение в минутах от текущего момента для таймера.',
        },
      },
      required: ['title'],
    },
    run: addTask,
  },
  {
    name: 'add_tasks_batch',
    effect: { kind: 'create', bulk: true },
    description:
      'Добавляет сразу несколько задач за один раз (импорт списка дел или напоминаний со скриншота).',
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description:
            'Список задач: {title, category_name?, notes?, remind_at?, due_at?, recurrence?}.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Название задачи (обязательно).' },
              category_name: { type: 'string', description: 'Категория задачи.' },
              notes: { type: 'string', description: 'Детали задачи.' },
              remind_at: { type: 'string', description: 'Время напоминания ISO-8601.' },
              due_at: { type: 'string', description: 'Срок выполнения ISO-8601.' },
              recurrence: {
                type: 'object',
                description: 'Правило повтора: {"freq":"daily|weekly|monthly|yearly"}.',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    run: addTasksBatch,
  },
  {
    name: 'complete_task',
    effect: { kind: 'mutate' },
    description:
      'Отмечает задачу выполненной по названию или фрагменту. При повторе создаёт следующую итерацию.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название задачи или его часть.' },
      },
      required: ['query'],
    },
    run: completeTaskTool,
  },
  {
    name: 'list_tasks',
    effect: { kind: 'read' },
    description:
      'Показывает актуальные незавершённые задачи с категорией, повтором, ближайшим напоминанием и числом шагов.',
    schema: {
      type: 'object',
      properties: {
        category_name: { type: 'string', description: 'Фильтр по категории (без учёта регистра).' },
      },
      required: [],
    },
    run: listTasksTool,
  },
  {
    name: 'update_task',
    effect: { kind: 'mutate' },
    description:
      'Обновляет или переносит задачу: название, напоминание/срок, категорию, заметку, повтор.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название существующей задачи или его часть.' },
        new_title: { type: 'string', description: 'Новое название задачи.' },
        remind_at: { type: 'string', description: 'Новое время напоминания ISO-8601.' },
        remind_in_minutes: {
          type: 'integer',
          description: 'Перенос на N минут от текущего момента.',
        },
        due_at: { type: 'string', description: 'Новый срок выполнения ISO-8601.' },
        category_name: { type: 'string', description: 'Новая категория.' },
        notes: { type: 'string', description: 'Новая заметка (пустая строка — очистить).' },
        recurrence: {
          type: 'object',
          description: 'Правило повтора или строка «none» для отключения.',
        },
      },
      required: ['query'],
    },
    run: updateTaskTool,
  },
  {
    name: 'delete_task',
    effect: { kind: 'destroy', recovery: 'trash' },
    description: 'Удаляет задачу в корзину (хранится 30 дней, можно восстановить).',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название задачи или его часть.' },
      },
      required: ['query'],
    },
    run: deleteTaskTool,
  },
  {
    name: 'auto_detect_tasks',
    effect: { kind: 'mutate' },
    description:
      'Анализирует рассказ о совершённом действии и закрывает соответствующую открытую задачу (с повторами).',
    schema: {
      type: 'object',
      properties: {
        action_text: { type: 'string', description: 'Текст о выполненном действии.' },
      },
      required: ['action_text'],
    },
    run: autoDetectTasks,
  },
];
