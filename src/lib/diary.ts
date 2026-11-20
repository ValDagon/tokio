/**
 * Дневник рефлексии.
 *
 * Порт `backend/app/services/diary.py`, но вместо файловой системы — хранилище
 * `kv` (`kvGet`/`kvSet`): в рантайме мини-аппа нет `fs`/`Buffer`.
 *
 * Ключ хранения: `diary:<userId>:<YYYY-MM-DD>`.
 * Дата берётся в таймзоне пользователя (`users.timezone`), момент времени —
 * из `opts.now` (детерминированные тесты).
 */

import { kvGet, kvSet } from './dal/misc';
import { listCategories, listTasks } from './dal/tasks';
import { getUser } from './dal/users';
import { dateKey, zonedParts } from './utils';

/** Шаблон нового дневника (если в шаблоне нет `{{DATE}}`, дата появится в заголовке). */
export const DEFAULT_DIARY_TEMPLATE =
  '# Дневник: {{DATE}}\n\n' +
  '## 🔋 1. Самочувствие и уровень энергии\n\n' +
  '## 🎯 2. Главное за день\n\n' +
  '## 💭 3. Мысли и рефлексия\n\n' +
  '## 💡 4. Выводы и фокус на завтра\n';

const HEADER_ENERGY = '## 🔋 1. Самочувствие и уровень энергии';
const HEADER_FOCUS = '## 🎯 2. Главное за день';
const HEADER_REFLECTION = '## 💭 3. Мысли и рефлексия';
const HEADER_TOMORROW = '## 💡 4.';

/** Куда может «упереться» вставка рефлексии — порядок важен (`## 💡` — префикс `## 💡 4.`). */
const NEXT_SECTION_CANDIDATES = ['## 💡 4.', '## 4.', '---', '## 💡'] as const;

const ENERGY_LINE_RE = /(\*\*Уровень энергии \(1–10\):\*\*)(.*)/;

const TASK_PAGE_SIZE = 500;
const MAX_TASK_PAGES = 40;

export type DiaryEnergy = number | string;

export interface DiaryOptions {
  /** Дата дневника (`YYYY-MM-DD`); по умолчанию — сегодня в таймзоне пользователя. */
  date?: string;
  /** Момент времени для расчёта даты и метки рефлексии. */
  now?: Date;
}

export interface DiaryRecord {
  date: string;
  content: string;
}

export interface DiaryCreateResult extends DiaryRecord {
  created: boolean;
}

/** Ключ в `kv`, под которым лежит дневник за дату. */
export function diaryStorageKey(userId: number, date: string): string {
  return `diary:${userId}:${date}`;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `HH:MM` в таймзоне пользователя. */
function stamp(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

async function resolveContext(userId: number, opts: DiaryOptions): Promise<{ date: string; timeZone: string; now: Date }> {
  const now = opts.now ?? new Date();
  const user = await getUser(userId);
  const timeZone = user?.timezone ?? 'UTC';
  const date = opts.date ?? dateKey(now, timeZone);
  return { date, timeZone, now };
}

/**
 * Выполненные за день задачи в виде `[x] [Категория] Заголовок`.
 *
 * Источник — `status = 'done'` и `updated_at` в пределах дня (в рантайме SQL-тега
 * нет `::date`, поэтому день вычисляется в JS по таймзоне пользователя).
 */
export async function getTodayCompletedTasks(
  userId: number,
  opts: { date: string; timeZone?: string },
): Promise<string[]> {
  const timeZone = opts.timeZone ?? (await getUser(userId))?.timezone ?? 'UTC';
  const categories = await listCategories(userId);
  const categoryNames = new Map<number, string>();
  for (const category of categories) categoryNames.set(category.id, category.name);

  const done: { title: string; categoryId: number | null; updatedAt: string }[] = [];

  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const chunk = await listTasks(userId, {
      status: 'done',
      limit: TASK_PAGE_SIZE,
      offset: page * TASK_PAGE_SIZE,
    });

    for (const task of chunk) {
      if (!task.updatedAt) continue;
      const updatedAt = new Date(task.updatedAt);
      if (Number.isNaN(updatedAt.getTime())) continue;
      if (dateKey(updatedAt, timeZone) !== opts.date) continue;
      done.push({ title: task.title, categoryId: task.categoryId, updatedAt: task.updatedAt });
    }

    if (chunk.length < TASK_PAGE_SIZE) break;
  }

  done.sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? -1 : 1));

  return done.map((task) => {
    const category = task.categoryId === null ? null : categoryNames.get(task.categoryId);
    return `[x] [${category && category.trim() !== '' ? category : 'Разное'}] ${task.title}`;
  });
}

/** Читает дневник за дату; `null`, если записи ещё нет. */
export async function readDailyDiary(userId: number, opts: DiaryOptions = {}): Promise<string | null> {
  const { date } = await resolveContext(userId, opts);
  return kvGet(diaryStorageKey(userId, date));
}

/**
 * Возвращает дневник за дату, создавая его из шаблона при первом обращении.
 * В новый дневник подставляется блок выполненных задач (если `includeTasks`).
 */
export async function getOrCreateDailyDiary(
  userId: number,
  opts: DiaryOptions & { includeTasks?: boolean; template?: string } = {},
): Promise<DiaryCreateResult> {
  const { date, timeZone } = await resolveContext(userId, opts);

  const existing = await kvGet(diaryStorageKey(userId, date));
  if (existing !== null) return { date, content: existing, created: false };

  let content = opts.template && opts.template.trim() !== '' ? opts.template : DEFAULT_DIARY_TEMPLATE;
  // Шаблон-строка: поддерживаем и `{{DATE}}`, и «пустой» заголовок.
  content = content.includes('{{DATE}}') ? content.replace(/\{\{DATE\}\}/g, date) : content;

  if (opts.includeTasks !== false) {
    const completed = await getTodayCompletedTasks(userId, { date, timeZone });
    if (completed.length > 0) {
      const block = completed.map((task) => `- ${task}`).join('\n');
      const anchor = `${HEADER_FOCUS}\n- `;
      if (content.includes(anchor)) {
        content = content.replace(anchor, `${HEADER_FOCUS}\n${block}\n- `);
      } else if (content.includes(HEADER_FOCUS)) {
        content = content.replace(HEADER_FOCUS, `${HEADER_FOCUS}\n${block}`);
      }
    }
  }

  await kvSet(diaryStorageKey(userId, date), content);
  return { date, content, created: true };
}

/** Подставляет/перезаписывает уровень энергии в первой секции. */
function applyEnergy(content: string, energy: DiaryEnergy): string {
  if (ENERGY_LINE_RE.test(content)) {
    return content.replace(ENERGY_LINE_RE, `$1 ${String(energy)}`);
  }
  if (content.includes(HEADER_ENERGY)) {
    return content.replace(HEADER_ENERGY, `${HEADER_ENERGY}\n- **Уровень энергии (1–10):** ${String(energy)}`);
  }
  return content;
}

/** Вставляет запись рефлексии в секцию 3 (последней строкой перед следующей секцией). */
function applyReflection(content: string, reflection: string, time: string): string {
  const text = reflection.trim();
  if (text === '') return content;

  const entryLine = `\n\n**[${time}]** ${text}\n`;

  if (!content.includes(HEADER_REFLECTION)) {
    return `${content}\n\n${HEADER_REFLECTION}${entryLine}`;
  }

  const [head, tail] = content.split(HEADER_REFLECTION) as [string, string];
  const nextSection = NEXT_SECTION_CANDIDATES.find((candidate) => tail.includes(candidate));

  if (nextSection) {
    const index = tail.indexOf(nextSection);
    const reflectionPart = tail.slice(0, index);
    const after = tail.slice(index + nextSection.length);
    return head + HEADER_REFLECTION + reflectionPart.replace(/\s+$/u, '') + entryLine + '\n' + nextSection + after;
  }

  return head + HEADER_REFLECTION + tail.replace(/\s+$/u, '') + entryLine;
}

/**
 * Добавляет запись рефлексии за день (создавая дневник при необходимости)
 * и опционально обновляет уровень энергии.
 */
export async function appendReflection(
  userId: number,
  reflection: string,
  opts: DiaryOptions & { energy?: DiaryEnergy | null } = {},
): Promise<DiaryRecord> {
  const { date, timeZone, now } = await resolveContext(userId, opts);
  const { content: base } = await getOrCreateDailyDiary(userId, { date, now, includeTasks: false });

  let content = base;
  if (opts.energy !== undefined && opts.energy !== null && String(opts.energy).trim() !== '') {
    content = applyEnergy(content, opts.energy);
  }
  content = applyReflection(content, reflection, stamp(now, timeZone));

  await kvSet(diaryStorageKey(userId, date), content);
  return { date, content };
}

// Совместимость с именованием upstream.
export const createOrGetDiary = getOrCreateDailyDiary;
export const appendReflectionToDiary = appendReflection;
