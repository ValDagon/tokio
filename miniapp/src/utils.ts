import type { Task } from './types';
import { getActiveLocale, LOCALE_BCP47, translate, type LocaleCode } from './i18n/core';

export function formatTaskDate(
  dateStr: string | null | undefined,
  isOverdue = false,
  locale: LocaleCode = getActiveLocale()
): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';

  const bcp47 = LOCALE_BCP47[locale] || 'ru-RU';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const diffDays = Math.round((targetDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const timeStr = d.toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit' });
  const hasSpecificTime = !(d.getHours() === 0 && d.getMinutes() === 0);

  if (isOverdue) {
    if (diffDays === 0) {
      return hasSpecificTime ? translate(locale, 'utils.todayAt', { time: timeStr }) : translate(locale, 'utils.today');
    } else if (diffDays === -1) {
      return hasSpecificTime ? translate(locale, 'utils.yesterdayAt', { time: timeStr }) : translate(locale, 'utils.yesterday');
    } else if (diffDays < -1) {
      const absDays = Math.abs(diffDays);
      const formattedDate = d.toLocaleDateString(bcp47, { day: 'numeric', month: 'short' });
      return hasSpecificTime
        ? translate(locale, 'utils.daysAgoTime', { days: absDays, date: formattedDate, time: timeStr })
        : translate(locale, 'utils.daysAgo', { days: absDays, date: formattedDate });
    }
  }

  if (diffDays === 0) {
    return hasSpecificTime ? translate(locale, 'utils.todayComma', { time: timeStr }) : translate(locale, 'utils.today');
  } else if (diffDays === 1) {
    return hasSpecificTime ? translate(locale, 'utils.tomorrowComma', { time: timeStr }) : translate(locale, 'utils.tomorrow');
  } else if (diffDays === -1) {
    return hasSpecificTime ? translate(locale, 'utils.yesterdayComma', { time: timeStr }) : translate(locale, 'utils.yesterday');
  } else {
    const isThisYear = d.getFullYear() === now.getFullYear();
    const datePart = d.toLocaleDateString(bcp47, {
      day: 'numeric',
      month: 'short',
      year: isThisYear ? undefined : 'numeric'
    });
    return hasSpecificTime ? `${datePart}, ${timeStr}` : datePart;
  }
}

export function getOverdueBadgeText(
  task: Task,
  referenceNow = Date.now(),
  locale: LocaleCode = getActiveLocale()
): string | null {
  if (task.status !== 'todo') return null;
  const now = referenceNow;
  const dateStr = task.due_at || task.remind_at;
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime()) || d.getTime() >= now) return null;

  const diffMs = now - d.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 60) {
    return translate(locale, 'utils.overdueMin', { count: Math.max(1, diffMinutes) });
  } else if (diffHours < 24) {
    return translate(locale, 'utils.overdueHours', { count: diffHours });
  } else if (diffDays === 1) {
    return translate(locale, 'utils.overdueOneDay');
  } else {
    return translate(locale, 'utils.overdueDays', { count: diffDays });
  }
}

export function formatRecurrence(
  rec: string | null | undefined,
  locale: LocaleCode = getActiveLocale()
): string | null {
  if (!rec) return null;
  switch (rec) {
    case 'daily':
      return translate(locale, 'utils.daily');
    case 'weekly':
      return translate(locale, 'utils.weekly');
    case 'monthly':
      return translate(locale, 'utils.monthly');
    case 'yearly':
      return translate(locale, 'utils.yearly');
    default:
      if (rec.startsWith('every_') && rec.endsWith('_days')) {
        const n = rec.replace('every_', '').replace('_days', '');
        return translate(locale, 'utils.everyNDays', { n });
      }
      if (rec.startsWith('every_') && rec.endsWith('_weeks')) {
        const n = rec.replace('every_', '').replace('_weeks', '');
        return translate(locale, 'utils.everyNWeeks', { n });
      }
      return rec;
  }
}

export function formatTaskCreatedDate(
  createdStr: string,
  locale: LocaleCode = getActiveLocale()
): string {
  const d = new Date(createdStr);
  if (isNaN(d.getTime())) return '';
  const bcp47 = LOCALE_BCP47[locale] || 'ru-RU';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const createdDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - createdDay.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return translate(locale, 'utils.createdToday');
  if (diffDays === 1) return translate(locale, 'utils.createdYesterday');
  if (diffDays < 7) return translate(locale, 'utils.createdDaysAgo', { days: diffDays });
  return translate(locale, 'utils.createdOn', {
    date: d.toLocaleDateString(bcp47, { day: 'numeric', month: 'short' }),
  });
}

export function stripMarkdownInline(text: string): string {
  return text
    .replace(/^#+\s+/, '')
    .replace(/^>\s*(\[![A-Z]+\])?\s*/, '')
    .replace(/^[-*•]\s+(\[[ xX]\]\s*)?/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export function getNoteSummary(text: string, locale: LocaleCode = getActiveLocale()): string {
  if (!text) return translate(locale, 'utils.emptyNote');
  const lines = text.split('\n').map(l => l.trim()).filter(l => Boolean(l) && !/^---+$/.test(l));
  if (lines.length === 0) return translate(locale, 'utils.emptyNote');
  const firstLine = stripMarkdownInline(lines[0]);
  return firstLine || translate(locale, 'utils.noteDefault');
}

export interface NoteTitleAndBody {
  title: string;
  body: string;
  hasExplicitHeading: boolean;
}

export function extractNoteTitleAndBody(text: string, locale: LocaleCode = getActiveLocale()): NoteTitleAndBody {
  if (!text || !text.trim()) {
    return {
      title: translate(locale, 'utils.emptyNote'),
      body: '',
      hasExplicitHeading: false,
    };
  }

  const hasExplicitHeading = /^\s*#+\s+/.test(text);
  if (hasExplicitHeading) {
    return {
      title: getNoteSummary(text, locale),
      body: text,
      hasExplicitHeading: true,
    };
  }

  const lines = text.split('\n');
  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx === -1) {
    return {
      title: translate(locale, 'utils.emptyNote'),
      body: '',
      hasExplicitHeading: false,
    };
  }

  const rawFirstLine = lines[firstNonEmptyIdx];
  const title = getNoteSummary(rawFirstLine, locale);
  const remainingLines = lines.slice(firstNonEmptyIdx + 1);
  const body = remainingLines.join('\n');

  return {
    title,
    body,
    hasExplicitHeading: false,
  };
}

export function getNotePreview(text: string, locale: LocaleCode = getActiveLocale()): { title: string; snippet: string } {
  if (!text) return { title: translate(locale, 'utils.emptyNote'), snippet: '' };
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => Boolean(l) && !/^---+$/.test(l) && !/^```/.test(l));
  if (lines.length === 0) return { title: translate(locale, 'utils.emptyNote'), snippet: '' };

  const title = stripMarkdownInline(lines[0]) || translate(locale, 'utils.noteDefault');
  const restLines = lines
    .slice(1)
    .map(l => stripMarkdownInline(l))
    .filter(Boolean);
  const snippet = restLines.join(' · ').slice(0, 220);
  return { title, snippet };
}

export interface TocHeading {
  id: string;
  title: string;
  level: number;
}

export function stripHeadingFormatting(text: string): string {
  return text
    .replace(/^#+\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export function slugifyHeading(title: string, index: number): string {
  const base = stripHeadingFormatting(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `sec-${index}-${base || 'item'}`;
}

export function extractTocHeadings(markdown: string): TocHeading[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const headings: TocHeading[] = [];
  let inCodeBlock = false;
  let idx = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (match) {
      const level = match[1].length;
      const cleanTitle = stripHeadingFormatting(match[2]);
      if (cleanTitle) {
        headings.push({
          id: slugifyHeading(cleanTitle, idx),
          title: cleanTitle,
          level,
        });
        idx += 1;
      }
    }
  }
  return headings;
}

export interface DocSectionMatch {
  sectionTitle: string;
  snippet: string;
}

export function findDocSectionMatches(
  chapter: {
    title: string;
    summary: string;
    sections?: { section_title: string; content: string }[];
  },
  query: string
): DocSectionMatch[] {
  const q = query.trim().toLowerCase();
  if (!q || !chapter.sections || chapter.sections.length === 0) return [];

  const matches: DocSectionMatch[] = [];
  for (const sec of chapter.sections) {
    const titleLower = sec.section_title.toLowerCase();
    const contentLower = sec.content.toLowerCase();
    const titleIdx = titleLower.indexOf(q);
    const contentIdx = contentLower.indexOf(q);

    if (titleIdx !== -1 || contentIdx !== -1) {
      let snippet = '';
      if (contentIdx !== -1) {
        const start = Math.max(0, contentIdx - 36);
        const end = Math.min(sec.content.length, contentIdx + q.length + 64);
        const rawSlice = sec.content.slice(start, end).replace(/\s+/g, ' ').trim();
        snippet = `${start > 0 ? '…' : ''}${stripMarkdownInline(rawSlice)}${end < sec.content.length ? '…' : ''}`;
      }
      matches.push({
        sectionTitle: stripMarkdownInline(sec.section_title),
        snippet,
      });
    }
  }
  return matches;
}

export interface TaskDayGroup {
  id: string;
  title: string;
  dateKey?: string;
  isOverdue?: boolean;
  isToday?: boolean;
  isDistant?: boolean;
  tasks: Task[];
}

export function groupTasksByDay(
  tasks: Task[],
  referenceNow = Date.now(),
  locale: LocaleCode = getActiveLocale()
): TaskDayGroup[] {
  const bcp47 = LOCALE_BCP47[locale] || 'ru-RU';
  const now = new Date(referenceNow);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msInDay = 24 * 60 * 60 * 1000;
  const startOfTomorrow = startOfToday + msInDay;
  const startOfDayAfter = startOfToday + 2 * msInDay;
  const nearHorizonLimit = startOfToday + 14 * msInDay;

  const overdueTasks: Task[] = [];
  const todayTasks: Task[] = [];
  const tomorrowTasks: Task[] = [];
  const futureMap = new Map<string, { date: Date; tasks: Task[] }>();
  const noDateTasks: Task[] = [];

  for (const task of tasks) {
    const dateStr = task.due_at || task.remind_at;
    if (!dateStr) {
      noDateTasks.push(task);
      continue;
    }

    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      noDateTasks.push(task);
      continue;
    }

    const tTime = d.getTime();
    if (task.status === 'todo' && tTime < startOfToday) {
      overdueTasks.push(task);
    } else if (tTime >= startOfToday && tTime < startOfTomorrow) {
      todayTasks.push(task);
    } else if (tTime >= startOfTomorrow && tTime < startOfDayAfter) {
      tomorrowTasks.push(task);
    } else if (tTime >= startOfDayAfter) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const key = `${year}-${month}-${day}`;
      const entry = futureMap.get(key);
      if (entry) {
        entry.tasks.push(task);
      } else {
        futureMap.set(key, { date: new Date(year, d.getMonth(), d.getDate()), tasks: [task] });
      }
    } else {
      // Completed tasks with past date or edge cases
      todayTasks.push(task);
    }
  }

  const groups: TaskDayGroup[] = [];

  if (overdueTasks.length > 0) {
    groups.push({
      id: 'overdue',
      title: translate(locale, 'utils.groupOverdue'),
      isOverdue: true,
      tasks: overdueTasks,
    });
  }

  if (todayTasks.length > 0) {
    groups.push({
      id: 'today',
      title: translate(locale, 'utils.groupToday'),
      isToday: true,
      tasks: todayTasks,
    });
  }

  if (tomorrowTasks.length > 0) {
    groups.push({
      id: 'tomorrow',
      title: translate(locale, 'utils.groupTomorrow'),
      tasks: tomorrowTasks,
    });
  }

  // Sort future dates chronologically and partition into near (<= 14 days) and distant (> 14 days)
  const sortedFutureKeys = Array.from(futureMap.keys()).sort();
  const distantGroups: TaskDayGroup[] = [];

  for (const key of sortedFutureKeys) {
    const entry = futureMap.get(key)!;
    if (entry.tasks.length > 0) {
      const d = entry.date;
      const weekday = d.toLocaleDateString(bcp47, { weekday: 'short' });
      const capWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
      const isThisYear = d.getFullYear() === now.getFullYear();
      const dayMonth = d.toLocaleDateString(bcp47, {
        day: 'numeric',
        month: 'short',
        year: isThisYear ? undefined : 'numeric',
      });
      const title = `${capWeekday}, ${dayMonth}`;
      const isDistant = d.getTime() > nearHorizonLimit;

      const group: TaskDayGroup = {
        id: `day-${key}`,
        dateKey: key,
        title,
        isDistant,
        tasks: entry.tasks,
      };

      if (isDistant) {
        distantGroups.push(group);
      } else {
        groups.push(group);
      }
    }
  }

  // "Без срока" group placed right after near days, before distant horizon
  if (noDateTasks.length > 0) {
    groups.push({
      id: 'no_date',
      title: translate(locale, 'utils.groupNoDate'),
      tasks: noDateTasks,
    });
  }

  // Distant dates placed after "Без срока"
  if (distantGroups.length > 0) {
    groups.push(...distantGroups);
  }

  return groups;
}

export function getTaskTimeDisplay(
  task: Task,
  referenceNow = Date.now(),
  locale: LocaleCode = getActiveLocale()
): { timeStr: string; isPast: boolean } | null {
  const dateStr = task.due_at || task.remind_at;
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;

  const hasSpecificTime = !(d.getHours() === 0 && d.getMinutes() === 0);
  if (!hasSpecificTime) return null;

  const bcp47 = LOCALE_BCP47[locale] || 'ru-RU';
  const timeStr = d.toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit' });
  const isPast = task.status === 'todo' && d.getTime() < referenceNow;
  return { timeStr, isPast };
}

export function getTargetDateForGroup(groupId: string, dateKey?: string, referenceNow = Date.now()): string | undefined {
  const now = new Date(referenceNow);
  if (groupId === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    return d.toISOString();
  }
  if (groupId === 'tomorrow') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
    return d.toISOString();
  }
  if (groupId.startsWith('day-') && dateKey) {
    const [y, m, day] = dateKey.split('-').map(Number);
    const d = new Date(y, m - 1, day, 12, 0, 0);
    return d.toISOString();
  }
  return undefined;
}

/**
 * Telegram WebApp alert dialog with browser fallback.
 */
export function showAlert(message: string): Promise<void> {
  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
  const showAlertFn = tg?.showAlert;
  if (typeof showAlertFn === 'function') {
    return new Promise(resolve => {
      showAlertFn.call(tg, message, () => resolve());
    });
  }
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message);
  }
  return Promise.resolve();
}

/**
 * Telegram WebApp confirm dialog with browser fallback.
 */
export function showConfirm(message: string): Promise<boolean> {
  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
  const showConfirmFn = tg?.showConfirm;
  if (typeof showConfirmFn === 'function') {
    return new Promise(resolve => {
      showConfirmFn.call(tg, message, confirmed => resolve(Boolean(confirmed)));
    });
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return Promise.resolve(window.confirm(message));
  }
  return Promise.resolve(false);
}

/**
 * Currency symbol helper mapping currency ISO/crypto codes to standard symbols.
 */
export function getCurrencySymbol(code?: string): string {
  if (!code) return '€';
  const c = code.trim().toUpperCase();
  switch (c) {
    case 'EUR':
      return '€';
    case 'RUB':
      return '₽';
    case 'USD':
      return '$';
    case 'KZT':
      return '₸';
    case 'TRY':
      return '₺';
    case 'USDT':
      return 'USDT';
    default:
      return code;
  }
}



