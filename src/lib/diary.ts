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

import { kvGet, kvListByPrefix, kvSet } from './dal/misc';
import { listCategories, listTasks } from './dal/tasks';
import { getUser } from './dal/users';
import { loadUserPrefs, type DiaryPrefs, type UserPrefs } from './prefs';
import { dateKey, truncate, zonedParts } from './utils';

const HEADER_ENERGY = '## 🔋 1. Самочувствие и уровень энергии';
const HEADER_FOCUS = '## 🎯 2. Главное за день';
const HEADER_REFLECTION = '## 💭 3. Мысли и рефлексия';
const HEADER_TOMORROW_FULL = '## 💡 4. Выводы и фокус на завтра';

/** Шаблон нового дневника (если в шаблоне нет `{{DATE}}`, дата появится в заголовке). */
export const DEFAULT_DIARY_TEMPLATE =
  '# Дневник: {{DATE}}\n\n' +
  `${HEADER_ENERGY}\n\n` +
  `${HEADER_FOCUS}\n\n` +
  `${HEADER_REFLECTION}\n\n` +
  `${HEADER_TOMORROW_FULL}\n`;

/** Строит шаблон дневника с учётом пользовательских настроек `diary`. */
export function buildDiaryTemplateFromPrefs(diary?: DiaryPrefs | null): string {
  const hasCustomSections = Array.isArray(diary?.sections) && diary.sections.length > 0;
  const hasCustomHeader = Boolean(diary?.headerTemplate?.trim());
  if (!hasCustomSections && !hasCustomHeader) {
    return DEFAULT_DIARY_TEMPLATE;
  }

  const rawHeader = diary?.headerTemplate?.trim() || '# Дневник: {{DATE}}';
  const header = rawHeader.startsWith('#') ? rawHeader : `# ${rawHeader}`;
  const rawSections = hasCustomSections
    ? diary!.sections!
    : [HEADER_ENERGY, HEADER_FOCUS, HEADER_REFLECTION, HEADER_TOMORROW_FULL];

  const renderedSections = rawSections.map((sec, idx) => {
    const trimmed = sec.trim();
    if (trimmed.startsWith('## ')) return trimmed;
    if (trimmed.startsWith('# ')) return `#${trimmed}`;
    return `## ${idx + 1}. ${trimmed}`;
  });

  return `${header}\n\n${renderedSections.join('\n\n')}\n`;
}

/** Куда может «упереться» вставка рефлексии — порядок важен (`## 💡` — префикс `## 💡 4.`). */
const NEXT_SECTION_CANDIDATES = ['## 💡 4.', '## 4.', '---', '## 💡'] as const;

const FOCUS_HEADING_RE = /^##\s+[^\n]*(?:главн|задач|фокус|выполн|tasks|focus|done)[^\n]*$/im;
const ENERGY_HEADING_RE = /^##\s+[^\n]*(?:энерг|самочувств|состоян|energy|mood)[^\n]*$/im;
const REFLECTION_HEADING_RE =
  /^##\s+[^\n]*(?:мысл|рефлекс|итог|заметк|reflection|thoughts|notes|journal)[^\n]*$/im;

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
 * Рендерит дневник за дату **без записи в kv**: шаблон + блок выполненных
 * задач. Используется и ленивым созданием (`getOrCreateDailyDiary`), и
 * агентом для чтения отсутствующей записи — чтение не должно менять данные.
 */
export async function renderDailyDiary(
  userId: number,
  opts: DiaryOptions & { includeTasks?: boolean; template?: string } = {},
): Promise<DiaryRecord> {
  const { date, timeZone } = await resolveContext(userId, opts);
  return { date, content: await renderContent(userId, date, timeZone, opts) };
}

/** Шаблон + выполненные задачи для уже разрешённой даты (без kv). */
const WEEKDAY_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

function weekdayLabel(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return '';
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return WEEKDAY_SHORT_RU[utc.getUTCDay()] ?? '';
}

async function renderContent(
  userId: number,
  date: string,
  timeZone: string,
  opts: { includeTasks?: boolean; template?: string },
): Promise<string> {
  const needsPrefs = !(opts.template && opts.template.trim() !== '') || opts.includeTasks === undefined;
  const prefs = needsPrefs
    ? await loadUserPrefs(userId).catch((): UserPrefs => ({}))
    : undefined;

  let content =
    opts.template && opts.template.trim() !== ''
      ? opts.template
      : buildDiaryTemplateFromPrefs(prefs?.diary);
  const weekday = weekdayLabel(date);
  content = content
    .replace(/\{\{DATE\}\}|\{date\}/g, date)
    .replace(/\{\{WEEKDAY\}\}|\{weekday\}/g, weekday);

  const includeTasks = opts.includeTasks ?? prefs?.diary?.includeTasks ?? true;
  if (includeTasks) {
    const completed = await getTodayCompletedTasks(userId, { date, timeZone });
    if (completed.length > 0) {
      const block = completed.map((task) => `- ${task}`).join('\n');
      const anchor = `${HEADER_FOCUS}\n- `;
      if (content.includes(anchor)) {
        content = content.replace(anchor, `${HEADER_FOCUS}\n${block}\n- `);
      } else if (content.includes(HEADER_FOCUS)) {
        content = content.replace(HEADER_FOCUS, `${HEADER_FOCUS}\n${block}`);
      } else {
        const customFocus = FOCUS_HEADING_RE.exec(content);
        if (customFocus) {
          content = content.replace(customFocus[0], `${customFocus[0]}\n${block}`);
        }
      }
    }
  }

  return content;
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

  const content = await renderContent(userId, date, timeZone, opts);
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
  const customEnergy = ENERGY_HEADING_RE.exec(content);
  if (customEnergy) {
    return content.replace(
      customEnergy[0],
      `${customEnergy[0]}\n- **Уровень энергии (1–10):** ${String(energy)}`,
    );
  }
  const titleMatch = /^#\s+[^\n]+/m.exec(content);
  if (titleMatch) {
    return content.replace(
      titleMatch[0],
      `${titleMatch[0]}\n\n- **Уровень энергии (1–10):** ${String(energy)}`,
    );
  }
  return content;
}

/** Вставляет запись рефлексии в секцию рефлексии (последней строкой перед следующей секцией). */
function applyReflection(content: string, reflection: string, time: string): string {
  const text = reflection.trim();
  if (text === '') return content;

  const entryLine = `\n\n**[${time}]** ${text}\n`;

  if (content.includes(HEADER_REFLECTION)) {
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

  const customHeading = REFLECTION_HEADING_RE.exec(content);
  if (customHeading) {
    const header = customHeading[0];
    const idx = customHeading.index;
    const head = content.slice(0, idx);
    const tail = content.slice(idx + header.length);
    const nextMatch = /\n(##\s+|---)/m.exec(tail);
    if (nextMatch) {
      const reflectionPart = tail.slice(0, nextMatch.index);
      const after = tail.slice(nextMatch.index);
      return head + header + reflectionPart.replace(/\s+$/u, '') + entryLine + after;
    }
    return head + header + tail.replace(/\s+$/u, '') + entryLine;
  }

  return `${content}\n\n${HEADER_REFLECTION}${entryLine}`;
}

/**
 * Добавляет запись рефлексии за день (создавая дневник при необходимости)
 * и опционально обновляет уровень энергии.
 */
export async function appendReflection(
  userId: number,
  reflection: string,
  opts: DiaryOptions & { energy?: DiaryEnergy | null; includeTasks?: boolean } = {},
): Promise<DiaryRecord> {
  const { date, timeZone, now } = await resolveContext(userId, opts);
  const { content: base } = await getOrCreateDailyDiary(userId, {
    date,
    now,
    ...(opts.includeTasks !== undefined ? { includeTasks: opts.includeTasks } : {}),
  });

  let content = base;
  if (opts.energy !== undefined && opts.energy !== null && String(opts.energy).trim() !== '') {
    content = applyEnergy(content, opts.energy);
  }
  content = applyReflection(content, reflection, stamp(now, timeZone));

  await kvSet(diaryStorageKey(userId, date), content);
  return { date, content };
}

export interface DiaryEntrySummary {
  date: string;
  preview: string;
  energy: string | null;
}

const DIARY_PREFIX_RE = /^(?:в\s+)?(?:дневник|diary)(?:$|[\s,:;—–.-]+([\s\S]*))$/iu;

/**
 * Распознаёт явный префикс «дневник» / «в дневник» / «diary» в начале текста или речи.
 * Однокоренные слова вроде «дневника» или «дневниковый» не срабатывают.
 */
export function parseDiaryPrefix(text: string): { matched: boolean; body: string } {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { matched: false, body: '' };
  const match = DIARY_PREFIX_RE.exec(trimmed);
  if (!match) return { matched: false, body: '' };
  return { matched: true, body: (match[1] ?? '').trim() };
}

function extractDiaryPreview(content: string): string {
  let slice = content;
  if (content.includes(HEADER_REFLECTION)) {
    const [, afterHeader = ''] = content.split(HEADER_REFLECTION);
    const nextSection = NEXT_SECTION_CANDIDATES.find((candidate) => afterHeader.includes(candidate));
    slice = nextSection ? afterHeader.slice(0, afterHeader.indexOf(nextSection)) : afterHeader;
  } else {
    const stampedLine = content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^\*\*\[\d{2}:\d{2}\]\*\*/.test(line));
    if (stampedLine) {
      return truncate(stampedLine.replace(/^\*\*\[[^\]]+\]\*\*\s*/, '').trim(), 140);
    }
  }
  const lines = slice
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== '---' && !line.startsWith('#'));

  for (const line of lines) {
    const cleaned = line
      .replace(/^\*\*\[[^\]]+\]\*\*\s*/, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/^[-*]\s*/, '')
      .trim();
    if (cleaned) return truncate(cleaned, 140);
  }

  const fallbackLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line !== '---');
  return fallbackLines.length > 0 ? truncate(fallbackLines[0]!, 140) : '';
}

/** Список дневников пользователя по датам (свежие сверху). */
export async function listDiaryDates(userId: number, limit = 60): Promise<DiaryEntrySummary[]> {
  const prefix = `diary:${userId}:`;
  const keyRe = new RegExp(`^diary:${userId}:(\\d{4}-\\d{2}-\\d{2})$`);
  const rows = await kvListByPrefix(prefix);
  const entries: DiaryEntrySummary[] = [];

  for (const row of rows) {
    const match = keyRe.exec(row.key);
    if (!match?.[1]) continue;
    const energyMatch = ENERGY_LINE_RE.exec(row.value);
    const rawEnergy = energyMatch?.[2]?.trim() ?? '';
    entries.push({
      date: match[1],
      preview: extractDiaryPreview(row.value),
      energy: rawEnergy || null,
    });
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries.slice(0, Math.max(0, limit));
}

// Совместимость с именованием upstream.
export const createOrGetDiary = getOrCreateDailyDiary;
export const appendReflectionToDiary = appendReflection;
