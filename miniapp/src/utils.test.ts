import { describe, it, expect } from 'vitest';
import {
  formatRecurrence,
  getNoteSummary,
  getOverdueBadgeText,
  formatTaskDate,
  formatTaskCreatedDate,
  getCurrencySymbol,
} from './utils';
import type { Task } from './types';

describe('formatRecurrence', () => {
  it('formats standard recurrence frequencies', () => {
    expect(formatRecurrence('daily')).toBe('Ежедневно');
    expect(formatRecurrence('weekly')).toBe('Еженедельно');
    expect(formatRecurrence('monthly')).toBe('Ежемесячно');
    expect(formatRecurrence('yearly')).toBe('Ежегодно');
  });

  it('formats custom intervals', () => {
    expect(formatRecurrence('every_3_days')).toBe('Каждые 3 дн.');
    expect(formatRecurrence('every_2_weeks')).toBe('Каждые 2 нед.');
  });

  it('handles empty and unrecognized inputs', () => {
    expect(formatRecurrence(null)).toBeNull();
    expect(formatRecurrence(undefined)).toBeNull();
    expect(formatRecurrence('')).toBeNull();
    expect(formatRecurrence('custom_rule')).toBe('custom_rule');
  });
});

describe('getNoteSummary', () => {
  it('strips markdown headings', () => {
    expect(getNoteSummary('# Главный заголовок\nДополнительный текст')).toBe('Главный заголовок');
    expect(getNoteSummary('### Подзаголовок')).toBe('Подзаголовок');
  });

  it('strips markdown list items and checkboxes', () => {
    expect(getNoteSummary('- [ ] Купить молоко\nВторой пункт')).toBe('Купить молоко');
    expect(getNoteSummary('* [x] Завершённое дело')).toBe('Завершённое дело');
    expect(getNoteSummary('1. Проверить почту')).toBe('Проверить почту');
  });

  it('strips bold and code formatting from summary preview', () => {
    expect(getNoteSummary('**Критично:** обновить SSL')).toBe('Критично: обновить SSL');
    expect(getNoteSummary('`SELECT *` запрос в базу')).toBe('SELECT * запрос в базу');
  });

  it('handles empty strings gracefully', () => {
    expect(getNoteSummary('')).toBe('Пустая заметка');
    expect(getNoteSummary('   \n  \n  ')).toBe('Пустая заметка');
  });
});

describe('getOverdueBadgeText', () => {
  const baseTask: Task = {
    id: 'test-1',
    title: 'Тестовая задача',
    status: 'todo',
    steps: [],
    created_at: new Date('2026-10-01T10:00:00Z').toISOString(),
  };

  it('returns null for completed tasks', () => {
    const doneTask: Task = {
      ...baseTask,
      status: 'done',
      due_at: new Date('2026-10-01T10:00:00Z').toISOString(),
    };
    expect(getOverdueBadgeText(doneTask)).toBeNull();
  });

  it('returns null when task is not overdue', () => {
    const futureTime = Date.now() + 1000 * 60 * 60;
    const task: Task = {
      ...baseTask,
      due_at: new Date(futureTime).toISOString(),
    };
    expect(getOverdueBadgeText(task)).toBeNull();
  });

  it('calculates overdue minutes', () => {
    const now = 1770000000000;
    const tenMinAgo = now - 10 * 60 * 1000;
    const task: Task = {
      ...baseTask,
      due_at: new Date(tenMinAgo).toISOString(),
    };
    expect(getOverdueBadgeText(task, now)).toBe('Просрочено на 10 мин.');
  });

  it('calculates overdue hours', () => {
    const now = 1770000000000;
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const task: Task = {
      ...baseTask,
      due_at: new Date(twoHoursAgo).toISOString(),
    };
    expect(getOverdueBadgeText(task, now)).toBe('Просрочено на 2 ч.');
  });

  it('calculates overdue days', () => {
    const now = 1770000000000;
    const oneDayAgo = now - 25 * 60 * 60 * 1000;
    const threeDaysAgo = now - 72 * 60 * 60 * 1000;

    const task1: Task = { ...baseTask, due_at: new Date(oneDayAgo).toISOString() };
    const task3: Task = { ...baseTask, due_at: new Date(threeDaysAgo).toISOString() };

    expect(getOverdueBadgeText(task1, now)).toBe('Просрочено на 1 дн.');
    expect(getOverdueBadgeText(task3, now)).toBe('Просрочено на 3 дн.');
  });
});

describe('formatTaskDate and formatTaskCreatedDate', () => {
  it('handles empty dates', () => {
    expect(formatTaskDate(null)).toBe('');
    expect(formatTaskDate(undefined)).toBe('');
    expect(formatTaskDate('invalid-date')).toBe('');
  });

  it('formats task created date', () => {
    const now = new Date();
    expect(formatTaskCreatedDate(now.toISOString())).toBe('создана сегодня');
  });
});

describe('groupTasksByDay', () => {
  const baseTask: Task = {
    id: 't-1',
    title: 'Задача 1',
    status: 'todo',
    steps: [],
    created_at: '2026-10-10T10:00:00Z',
  };

  it('groups tasks correctly into day sections', async () => {
    // Fixed now reference: 2026-10-11 at 12:00:00 local time
    const fixedNow = new Date('2026-10-11T12:00:00').getTime();

    const tasks: Task[] = [
      {
        ...baseTask,
        id: 't-overdue',
        title: 'Вчерашняя невыполненная задача',
        due_at: '2026-10-10T15:00:00',
      },
      {
        ...baseTask,
        id: 't-today-1',
        title: 'В 10:15 быть возле Аромы',
        due_at: '2026-10-11T09:00:00',
      },
      {
        ...baseTask,
        id: 't-today-2',
        title: 'Церковный проект',
        due_at: '2026-10-11T15:00:00',
      },
      {
        ...baseTask,
        id: 't-tomorrow',
        title: 'Поздравить деда',
        due_at: '2026-10-12T09:00:00',
      },
      {
        ...baseTask,
        id: 't-future',
        title: 'Будущая задача',
        due_at: '2026-10-15T14:00:00',
      },
      {
        ...baseTask,
        id: 't-nodate',
        title: 'Мысль без даты',
      },
    ];

    // import groupTasksByDay
    const { groupTasksByDay } = await import('./utils');
    const groups = groupTasksByDay(tasks, fixedNow);

    expect(groups.length).toBe(5);

    // Overdue group
    expect(groups[0].id).toBe('overdue');
    expect(groups[0].title).toBe('Просрочено');
    expect(groups[0].tasks.map(t => t.id)).toEqual(['t-overdue']);

    // Today group
    expect(groups[1].id).toBe('today');
    expect(groups[1].title).toBe('Сегодня');
    expect(groups[1].tasks.map(t => t.id)).toEqual(['t-today-1', 't-today-2']);

    // Tomorrow group
    expect(groups[2].id).toBe('tomorrow');
    expect(groups[2].title).toBe('Завтра');
    expect(groups[2].tasks.map(t => t.id)).toEqual(['t-tomorrow']);

    // Future day group
    expect(groups[3].id).toContain('2026-10-15');
    expect(groups[3].tasks.map(t => t.id)).toEqual(['t-future']);
    expect(groups[3].isDistant).toBe(false);

    // No date group
    expect(groups[4].id).toBe('no_date');
    expect(groups[4].title).toBe('Без срока');
    expect(groups[4].tasks.map(t => t.id)).toEqual(['t-nodate']);
  });

  it('partitions near days (<= 14 days), no_date tasks, and distant horizon (> 14 days) in correct order', async () => {
    // Fixed now reference: Sunday, 2026-10-11 at 12:00:00
    const fixedNow = new Date('2026-10-11T12:00:00').getTime();

    const tasks: Task[] = [
      {
        ...baseTask,
        id: 't-today',
        title: 'Купить батарейки',
        due_at: '2026-10-11T10:00:00',
      },
      {
        ...baseTask,
        id: 't-near-7d',
        title: 'Встреча через неделю',
        due_at: '2026-10-18T14:00:00', // +7 days (near)
      },
      {
        ...baseTask,
        id: 't-near-14d',
        title: 'Дедлайн ровно через 14 дней',
        due_at: '2026-10-25T18:00:00', // +14 days (near)
      },
      {
        ...baseTask,
        id: 't-nodate-1',
        title: 'Pokemon Legacy (активный проект)',
      },
      {
        ...baseTask,
        id: 't-nodate-2',
        title: 'Проект для Лёхи',
      },
      {
        ...baseTask,
        id: 't-distant-15d',
        title: 'Задача через 15 дней',
        due_at: '2026-10-26T10:00:00', // +15 days (distant)
      },
      {
        ...baseTask,
        id: 't-bday-2027',
        title: 'День рождения в 2027 году',
        due_at: '2027-03-20T00:00:00', // year 2027 (distant)
      },
    ];

    const { groupTasksByDay } = await import('./utils');
    const groups = groupTasksByDay(tasks, fixedNow);

    // Order must be:
    // 0: today (2026-10-11)
    // 1: day-2026-10-18 (near, isDistant: false)
    // 2: day-2026-10-25 (near, isDistant: false)
    // 3: no_date ("Без срока" with Pokemon Legacy and Проект для Лёхи)
    // 4: day-2026-10-26 (distant, isDistant: true)
    // 5: day-2027-03-20 (distant, isDistant: true, title contains 2027)

    expect(groups.length).toBe(6);

    expect(groups[0].id).toBe('today');
    expect(groups[0].tasks.map(t => t.id)).toEqual(['t-today']);

    expect(groups[1].id).toBe('day-2026-10-18');
    expect(groups[1].isDistant).toBe(false);
    expect(groups[1].tasks.map(t => t.id)).toEqual(['t-near-7d']);

    expect(groups[2].id).toBe('day-2026-10-25');
    expect(groups[2].isDistant).toBe(false);
    expect(groups[2].tasks.map(t => t.id)).toEqual(['t-near-14d']);

    // "Без срока" comes BEFORE distant dates
    expect(groups[3].id).toBe('no_date');
    expect(groups[3].title).toBe('Без срока');
    expect(groups[3].tasks.map(t => t.id)).toEqual(['t-nodate-1', 't-nodate-2']);

    // Distant dates come AFTER "Без срока"
    expect(groups[4].id).toBe('day-2026-10-26');
    expect(groups[4].isDistant).toBe(true);
    expect(groups[4].tasks.map(t => t.id)).toEqual(['t-distant-15d']);

    expect(groups[5].id).toBe('day-2027-03-20');
    expect(groups[5].isDistant).toBe(true);
    expect(groups[5].title).toContain('2027');
    expect(groups[5].tasks.map(t => t.id)).toEqual(['t-bday-2027']);
  });

  it('places no_date tasks before distant dates even when no near dates exist', async () => {
    const fixedNow = new Date('2026-10-11T12:00:00').getTime();

    const tasks: Task[] = [
      {
        ...baseTask,
        id: 't-nodate',
        title: 'Мысль без даты',
      },
      {
        ...baseTask,
        id: 't-bday-2027',
        title: 'День рождения в 2027',
        due_at: '2027-05-10T00:00:00',
      },
    ];

    const { groupTasksByDay } = await import('./utils');
    const groups = groupTasksByDay(tasks, fixedNow);

    expect(groups.length).toBe(2);
    expect(groups[0].id).toBe('no_date');
    expect(groups[0].title).toBe('Без срока');
    expect(groups[1].id).toBe('day-2027-05-10');
    expect(groups[1].isDistant).toBe(true);
  });

  it('excludes empty day sections', async () => {
    const fixedNow = new Date('2026-10-11T12:00:00').getTime();
    const tasks: Task[] = [
      {
        ...baseTask,
        id: 't-today',
        title: 'Дело на сегодня',
        due_at: '2026-10-11T16:00:00',
      },
    ];

    const { groupTasksByDay } = await import('./utils');
    const groups = groupTasksByDay(tasks, fixedNow);

    expect(groups.length).toBe(1);
    expect(groups[0].id).toBe('today');
    expect(groups[0].title).toBe('Сегодня');
  });

  it('correctly extracts time display and past status', async () => {
    const fixedNow = new Date('2026-10-11T12:00:00').getTime();
    const { getTaskTimeDisplay } = await import('./utils');

    const pastTask: Task = {
      ...baseTask,
      due_at: '2026-10-11T09:00:00',
    };
    const futureTask: Task = {
      ...baseTask,
      due_at: '2026-10-11T18:00:00',
    };
    const midnightTask: Task = {
      ...baseTask,
      due_at: '2026-10-11T00:00:00',
    };

    const pastRes = getTaskTimeDisplay(pastTask, fixedNow);
    expect(pastRes).not.toBeNull();
    expect(pastRes?.timeStr).toBe('09:00');
    expect(pastRes?.isPast).toBe(true);

    const futureRes = getTaskTimeDisplay(futureTask, fixedNow);
    expect(futureRes).not.toBeNull();
    expect(futureRes?.timeStr).toBe('18:00');
    expect(futureRes?.isPast).toBe(false);

    const midnightRes = getTaskTimeDisplay(midnightTask, fixedNow);
    expect(midnightRes).toBeNull();
  });

  it('calculates target ISO date for groups correctly', async () => {
    const fixedNow = new Date('2026-10-11T12:00:00').getTime();
    const { getTargetDateForGroup } = await import('./utils');

    const todayDate = getTargetDateForGroup('today', undefined, fixedNow);
    expect(todayDate).toBeDefined();
    const parsedToday = new Date(todayDate!);
    expect(parsedToday.getDate()).toBe(11);
    expect(parsedToday.getMonth()).toBe(9); // 0-indexed October

    const tomorrowDate = getTargetDateForGroup('tomorrow', undefined, fixedNow);
    expect(tomorrowDate).toBeDefined();
    const parsedTomorrow = new Date(tomorrowDate!);
    expect(parsedTomorrow.getDate()).toBe(12);

    const futureDate = getTargetDateForGroup('day-2026-10-15', '2026-10-15', fixedNow);
    expect(futureDate).toBeDefined();
    const parsedFuture = new Date(futureDate!);
    expect(parsedFuture.getDate()).toBe(15);

    const noDate = getTargetDateForGroup('no_date', undefined, fixedNow);
    expect(noDate).toBeUndefined();
  });

  describe('showAlert and showConfirm', () => {
    it('uses Telegram WebApp.showAlert when available', async () => {
      const { showAlert } = await import('./utils');
      let calledMsg = '';
      const fakeWindow = {
        Telegram: {
          WebApp: {
            showAlert: (msg: string, cb?: () => void) => {
              calledMsg = msg;
              cb?.();
            },
          },
        },
      };
      (globalThis as unknown as { window: unknown }).window = fakeWindow;

      await showAlert('Test Alert');
      expect(calledMsg).toBe('Test Alert');
      delete (globalThis as unknown as { window?: unknown }).window;
    });

    it('falls back to window.alert when WebApp is missing', async () => {
      const { showAlert } = await import('./utils');
      let alertMsg = '';
      const fakeWindow = {
        alert: (msg: string) => {
          alertMsg = msg;
        },
      };
      (globalThis as unknown as { window: unknown }).window = fakeWindow;

      await showAlert('Fallback Alert');
      expect(alertMsg).toBe('Fallback Alert');
      delete (globalThis as unknown as { window?: unknown }).window;
    });

    it('uses Telegram WebApp.showConfirm when available', async () => {
      const { showConfirm } = await import('./utils');
      const fakeWindow = {
        Telegram: {
          WebApp: {
            showConfirm: (_msg: string, cb?: (ok: boolean) => void) => {
              cb?.(true);
            },
          },
        },
      };
      (globalThis as unknown as { window: unknown }).window = fakeWindow;

      const result = await showConfirm('Do something?');
      expect(result).toBe(true);
      delete (globalThis as unknown as { window?: unknown }).window;
    });

    it('falls back to window.confirm when WebApp is missing', async () => {
      const { showConfirm } = await import('./utils');
      const fakeWindow = {
        confirm: () => false,
      };
      (globalThis as unknown as { window: unknown }).window = fakeWindow;

      const result = await showConfirm('Are you sure?');
      expect(result).toBe(false);
      delete (globalThis as unknown as { window?: unknown }).window;
    });
  });

  describe('Reader and Markdown utilities', () => {
    it('extracts multi-line note preview title and snippet cleanly', async () => {
      const { getNotePreview } = await import('./utils');
      const sample = [
        '# Идея видео: «Как полюбить небытие»',
        '---',
        '**Тема:** переосмысление Тибетской книги мёртвых.',
        '1. Тезисы и структура хук-разбор-вывод',
      ].join('\n');

      const preview = getNotePreview(sample);
      expect(preview.title).toBe('Идея видео: «Как полюбить небытие»');
      expect(preview.snippet).toContain('Тема: переосмысление Тибетской книги мёртвых.');
      expect(preview.snippet).toContain('Тезисы и структура хук-разбор-вывод');
    });

    it('extracts TOC headings while ignoring headings inside fenced code blocks', async () => {
      const { extractTocHeadings } = await import('./utils');
      const md = [
        '# 00. Общий обзор',
        '## Миссия и назначение',
        '```bash',
        '# comment inside code block should not become TOC',
        '```',
        '### 1. Режим быстрого действия',
      ].join('\n');

      const headings = extractTocHeadings(md);
      expect(headings).toHaveLength(3);
      expect(headings[0].title).toBe('00. Общий обзор');
      expect(headings[1].title).toBe('Миссия и назначение');
      expect(headings[2].title).toBe('1. Режим быстрого действия');
    });

    it('finds full-text matches inside chapter sections with snippets', async () => {
      const { findDocSectionMatches } = await import('./utils');
      const chapter = {
        title: '01. Финансы и бюджет',
        summary: 'Мультивалютный учёт',
        sections: [
          {
            section_title: 'Целевая карта счетов',
            content: 'Накопительный счёт (EUR): резерв на регулярные сервисы (100 €) и подписки (50 €).',
          },
          {
            section_title: 'Курсы валют',
            content: 'Конвертация по биржевому курсу.',
          },
        ],
      };

      const matches = findDocSectionMatches(chapter, 'регулярные');
      expect(matches).toHaveLength(1);
      expect(matches[0].sectionTitle).toBe('Целевая карта счетов');
      expect(matches[0].snippet).toContain('регулярные');
    });

    it('extractNoteTitleAndBody cleanly separates title and body without duplication', async () => {
      const { extractNoteTitleAndBody } = await import('./utils');

      // 1. Multi-line note without markdown heading
      const multiLine = 'Купить молоко\nВ магазине у дома\nИ хлеб';
      const res1 = extractNoteTitleAndBody(multiLine);
      expect(res1.hasExplicitHeading).toBe(false);
      expect(res1.title).toBe('Купить молоко');
      expect(res1.body).toBe('В магазине у дома\nИ хлеб');

      // 2. Single-line note without markdown heading
      const singleLine = 'Купить хлеб';
      const res2 = extractNoteTitleAndBody(singleLine);
      expect(res2.hasExplicitHeading).toBe(false);
      expect(res2.title).toBe('Купить хлеб');
      expect(res2.body).toBe('');

      // 3. Note with explicit H1 heading
      const withH1 = '# Список дел\n1. Первое дело\n2. Второе дело';
      const res3 = extractNoteTitleAndBody(withH1);
      expect(res3.hasExplicitHeading).toBe(true);
      expect(res3.title).toBe('Список дел');
      expect(res3.body).toBe(withH1);

      // 4. Note with explicit H2 heading
      const withH2 = '## Подзаголовок\nДетали плана';
      const res4 = extractNoteTitleAndBody(withH2);
      expect(res4.hasExplicitHeading).toBe(true);
      expect(res4.title).toBe('Подзаголовок');
      expect(res4.body).toBe(withH2);

      // 5. Note with leading empty lines
      const withBlanks = '\n  \nКупить сыр\nГауда или Чеддер';
      const res5 = extractNoteTitleAndBody(withBlanks);
      expect(res5.hasExplicitHeading).toBe(false);
      expect(res5.title).toBe('Купить сыр');
      expect(res5.body).toBe('Гауда или Чеддер');

      // 6. Empty / whitespace note
      const resEmpty = extractNoteTitleAndBody('   \n  ');
      expect(resEmpty.hasExplicitHeading).toBe(false);
      expect(resEmpty.title).toBe('Пустая заметка');
      expect(resEmpty.body).toBe('');
    });
  });

  describe('getCurrencySymbol', () => {
    it('maps known currency codes to symbols', () => {
      expect(getCurrencySymbol('EUR')).toBe('€');
      expect(getCurrencySymbol('eur')).toBe('€');
      expect(getCurrencySymbol('RUB')).toBe('₽');
      expect(getCurrencySymbol('USD')).toBe('$');
      expect(getCurrencySymbol('KZT')).toBe('₸');
      expect(getCurrencySymbol('TRY')).toBe('₺');
      expect(getCurrencySymbol('USDT')).toBe('USDT');
    });

    it('handles empty or unrecognized currencies gracefully', () => {
      expect(getCurrencySymbol(undefined)).toBe('€');
      expect(getCurrencySymbol('')).toBe('€');
      expect(getCurrencySymbol('GBP')).toBe('GBP');
    });
  });
});




