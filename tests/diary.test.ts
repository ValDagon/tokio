/**
 * `src/lib/diary.ts` — дневник рефлексии поверх `kv`.
 *
 * Ключевые инварианты: дневник создаётся один раз, задачи за день попадают
 * в секцию «Главное за день», рефлексия дописывается с меткой времени,
 * энергия перезаписывается, а хранилище изолировано по пользователю и дате.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import {
  DEFAULT_DIARY_TEMPLATE,
  appendReflection,
  appendReflectionToDiary,
  createOrGetDiary,
  diaryStorageKey,
  getOrCreateDailyDiary,
  getTodayCompletedTasks,
  readDailyDiary,
} from '../src/lib/diary';
import { createTask, updateTask } from '../src/lib/dal/tasks';
import { ensureUser } from '../src/lib/dal/users';
import { dateKey } from '../src/lib/utils';

const USER = 1;
const USER2 = 2;
const today = dateKey(new Date(), 'UTC');
const NOW = new Date('2026-11-06T18:30:00.000Z');

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('getOrCreateDailyDiary', () => {
  it('создаёт дневник из шаблона и второй раз его не пересоздаёт', async () => {
    await ensureUser(USER);

    expect(await readDailyDiary(USER)).toBeNull();

    const first = await getOrCreateDailyDiary(USER);

    expect(first.created).toBe(true);
    expect(first.date).toBe(today);
    expect(first.content).toContain(`# Дневник: ${today}`);
    expect(first.content).toContain('## 🔋 1. Самочувствие и уровень энергии');
    expect(first.content).toContain('## 🎯 2. Главное за день');
    expect(first.content).toContain('## 💭 3. Мысли и рефлексия');
    expect(first.content).toContain('## 💡 4. Выводы и фокус на завтра');
    expect(await readDailyDiary(USER)).toBe(first.content);

    const second = await getOrCreateDailyDiary(USER);

    expect(second.created).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('подставляет выполненные задачи в секцию «Главное за день»', async () => {
    await ensureUser(USER);
    const task = await createTask(USER, { title: 'Разобрать архив' });
    await updateTask(USER, task.id, { status: 'done' });

    const diary = await getOrCreateDailyDiary(USER);

    const header = '## 🎯 2. Главное за день';
    const line = `- [x] [Разное] ${task.title}`;
    expect(diary.content).toContain(line);
    expect(diary.content.indexOf(header)).toBeLessThan(diary.content.indexOf(line));
  });

  it('принимает свой шаблон и подставляет дату', async () => {
    await ensureUser(USER);

    const diary = await getOrCreateDailyDiary(USER, {
      date: '2026-11-03',
      template: '# Мой дневник {{DATE}}\n',
    });

    expect(diary.content).toBe('# Мой дневник 2026-11-03\n');
  });

  it('хранит дневники разных пользователей раздельно', async () => {
    await ensureUser(USER);
    await ensureUser(USER2);
    await appendReflection(USER, 'Личная мысль', { date: '2026-11-06', now: NOW });

    const other = await getOrCreateDailyDiary(USER2, { date: '2026-11-06' });

    expect(other.created).toBe(true);
    expect(other.content).not.toContain('Личная мысль');
    expect(diaryStorageKey(USER, '2026-11-06')).not.toBe(diaryStorageKey(USER2, '2026-11-06'));
  });
});

describe('appendReflection', () => {
  it('дописывает рефлексию с меткой времени и уровнем энергии', async () => {
    await ensureUser(USER);

    const { content } = await appendReflection(USER, 'Было тяжело, но справился', {
      date: '2026-11-06',
      now: NOW,
      energy: 7,
    });

    expect(content).toContain('- **Уровень энергии (1–10):** 7');
    expect(content).toContain('**[18:30]** Было тяжело, но справился');

    // Энергия — в первой секции, рефлексия — в третьей.
    expect(content.indexOf('Уровень энергии')).toBeLessThan(content.indexOf('**[18:30]**'));
  });

  it('каждая запись добавляется отдельной строкой', async () => {
    await ensureUser(USER);
    await appendReflection(USER, 'Первая мысль', { date: '2026-11-06', now: NOW });
    const { content } = await appendReflection(USER, 'Вторая мысль', {
      date: '2026-11-06',
      now: new Date('2026-11-06T19:05:00.000Z'),
    });

    expect(content).toContain('**[18:30]** Первая мысль');
    expect(content).toContain('**[19:05]** Вторая мысль');
    expect(content.match(/\*\*\[\d\d:\d\d\]\*\*/g)).toHaveLength(2);
  });

  it('перезаписывает уровень энергии, а не дублирует его', async () => {
    await ensureUser(USER);
    await appendReflection(USER, 'Утро', { date: '2026-11-06', now: NOW, energy: 7 });
    const { content } = await appendReflection(USER, 'Вечер', {
      date: '2026-11-06',
      now: new Date('2026-11-06T20:00:00.000Z'),
      energy: 9,
    });

    expect(content).toContain('**Уровень энергии (1–10):** 9');
    expect(content).not.toContain('**Уровень энергии (1–10):** 7');
    expect(content.match(/Уровень энергии/g)).toHaveLength(1);
  });

  it('пустая рефлексия не меняет дневник', async () => {
    await ensureUser(USER);
    const before = await getOrCreateDailyDiary(USER, { date: '2026-11-02' });

    const after = await appendReflection(USER, '   ', { date: '2026-11-02', now: NOW });

    expect(after.content).toBe(before.content);
  });

  it('без третьей секции в шаблоне дописывает её в конец', async () => {
    await ensureUser(USER);
    await getOrCreateDailyDiary(USER, {
      date: '2026-11-01',
      template: '# Дневник\n\n## 🎯 2. Главное за день\n',
    });

    const { content } = await appendReflection(USER, 'Свободная мысль', {
      date: '2026-11-01',
      now: NOW,
    });

    expect(content).toContain('## 💭 3. Мысли и рефлексия');
    expect(content).toContain('**[18:30]** Свободная мысль');
  });

  it('пишет в дневник указанной даты, не трогая сегодняшний', async () => {
    await ensureUser(USER);

    await appendReflection(USER, 'Вчерашняя мысль', {
      date: '2026-11-04',
      now: new Date('2026-11-06T10:00:00.000Z'),
    });

    expect(await readDailyDiary(USER, { date: '2026-11-04' })).toContain('Вчерашняя мысль');
    expect(await readDailyDiary(USER, { date: '2026-11-06' })).toBeNull();
  });
});

describe('getTodayCompletedTasks', () => {
  it('отдаёт выполненные сегодня задачи в формате `[x] [Категория]`', async () => {
    await ensureUser(USER);
    const task = await createTask(USER, { title: 'Сходить в зал' });
    await updateTask(USER, task.id, { status: 'done' });

    expect(await getTodayCompletedTasks(USER, { date: today })).toEqual([
      `[x] [Разное] ${task.title}`,
    ]);
  });

  it('пустой список, если задач не закрывали', async () => {
    await ensureUser(USER);
    await createTask(USER, { title: 'Ещё в работе' });

    expect(await getTodayCompletedTasks(USER, { date: today })).toEqual([]);
  });
});

describe('алиасы и шаблон', () => {
  it('экспортирует upstream-имена', () => {
    expect(createOrGetDiary).toBe(getOrCreateDailyDiary);
    expect(appendReflectionToDiary).toBe(appendReflection);
    expect(DEFAULT_DIARY_TEMPLATE).toContain('{{DATE}}');
  });

  it('неизвестный пользователь не ломает создание дневника', async () => {
    const diary = await getOrCreateDailyDiary(USER2);

    expect(diary.created).toBe(true);
    expect(diary.content).toContain('# Дневник:');
  });
});
