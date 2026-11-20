/**
 * Тулзы агента: дневник рефлексии (PLAN-AGENT-FIRST T2).
 *
 * Раньше дневник был доступен только внешнему скрипту, который читал
 * устаревшую схему `ag`, — продакшн её не видит. Тулзы ходят в тот же
 * `lib/diary.ts`, что и Mini App: `kv`-ключ `diary:<userId>:<YYYY-MM-DD>`.
 *
 * ADR-002 (время): «сейчас» и таймзона берутся только из `ctx.now` /
 * `ctx.timezone`; дату можно передать явно (`date`, `YYYY-MM-DD`), иначе это
 * сегодня в таймзоне пользователя.
 */

import {
  appendReflection,
  getOrCreateDailyDiary,
  readDailyDiary,
} from '../../diary.js';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry.js';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата дневника из аргументов: `YYYY-MM-DD` либо `undefined` (сегодня). */
function readDate(args: ToolArgs): string | undefined {
  const raw = args.date;
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (value === '') return undefined;
  return DATE_RE.test(value) ? value : undefined;
}

/** Уровень энергии: число 1–10 или короткая строка; иначе `null`. */
function readEnergy(args: ToolArgs): number | string | null {
  const raw = args.energy;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.round(raw))) : null;
  }
  const value = String(raw).trim();
  return value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

/**
 * Дневник за дату. Если записи нет, она создаётся из шаблона вместе с блоком
 * выполненных за день задач — так же, как это делал удалённый скрипт.
 */
async function readDiary(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const date = readDate(args);
  try {
    const existing = await readDailyDiary(ctx.userId, { date, now: ctx.now });
    if (existing !== null) {
      return { ok: true, content: existing, data: { date: date ?? null, created: false } };
    }

    const created = await getOrCreateDailyDiary(ctx.userId, {
      date,
      now: ctx.now,
      includeTasks: args.include_tasks !== false,
    });
    return { ok: true, content: created.content, data: { date: created.date, created: true } };
  } catch (error) {
    return fail(`Не удалось прочитать дневник: ${errorText(error)}`);
  }
}

/** Добавляет запись рефлексии за день и, если передано, уровень энергии. */
async function appendDiary(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return fail('Нужен текст рефлексии (text).');

  try {
    const record = await appendReflection(ctx.userId, text, {
      date: readDate(args),
      now: ctx.now,
      energy: readEnergy(args),
    });
    return {
      ok: true,
      content: `Записал в дневник за ${record.date}.`,
      data: { date: record.date },
    };
  } catch (error) {
    return fail(`Не удалось записать рефлексию: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

export const diaryTools: Tool[] = [
  {
    name: 'read_daily_diary',
    description:
      'Показывает дневник рефлексии за день (по умолчанию — сегодня). Если записи ещё нет, создаёт её из шаблона и подставляет выполненные задачи.',
    schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата в формате YYYY-MM-DD; по умолчанию сегодня.' },
        include_tasks: {
          type: 'boolean',
          description: 'Подставлять выполненные задачи в новый дневник (по умолчанию да).',
        },
      },
      required: [],
    },
    run: readDiary,
  },
  {
    name: 'append_reflection',
    description:
      'Добавляет вечернюю запись рефлексии в дневник за день и, если указано, обновляет уровень энергии.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст рефлексии.' },
        energy: {
          type: 'string',
          description: 'Уровень энергии: число 1–10 или короткое описание самочувствия.',
        },
        date: { type: 'string', description: 'Дата в формате YYYY-MM-DD; по умолчанию сегодня.' },
      },
      required: ['text'],
    },
    run: appendDiary,
  },
];
