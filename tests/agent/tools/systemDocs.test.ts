/**
 * Тулза агента: `consult_system_docs` (SPEC §3 T12).
 *
 * Это тонкая обёртка над `searchDocs`, поэтому проверяем сквозное поведение:
 *  - пустой/нестроковый `query` режется до `ok:false`, до БД дело не доходит;
 *  - на пустой базе возвращается манифест-приглашение, а не исключение;
 *  - запрос «оглавление/список/…» отдаёт карточку главы (с темой) или манифест;
 *  - промах по теме и промах вообще — разные тексты с разными подсказками;
 *  - алиас темы («финансы») ограничивает поиск одной главой;
 *  - глава без `##` — одна секция размером с главу; источник — `filename`
 *    либо фолбэк `<slug>.md`;
 *  - длинная сводка в манифесте обрезается до 200 символов плюс `...`;
 *  - чужие главы не видны.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { systemDocsTools } from '../../../src/lib/agent/tools/systemDocs';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { createChapter } from '../../../src/lib/dal/docs';
import { ensureUser } from '../../../src/lib/dal/users';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

function toolByName(name: string): Tool {
  const found = systemDocsTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в systemDocsTools`);
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

interface DocsData {
  query: string;
  topic: string | null;
}

/** Рамки блоков-цитат: по 50 символов, как в `searchDocs`. */
const FRAME = '='.repeat(50);
const DIVIDER = '-'.repeat(50);

const TASKS_SLUG = '01_tasks_and_reminders';
const TASKS_TITLE = 'Задачи и напоминания';
/** Первый содержательный абзац главы — он же сводка. */
const TASKS_SUMMARY =
  'Напишите её обычным сообщением. Ассистент выделит задачу из текста и положит в список.';
const TASKS_CONTENT = `# Задачи и напоминания

## Как добавить задачу

${TASKS_SUMMARY}

## Повторы

У задачи может быть правило повтора. После выполнения создаётся следующее вхождение.`;

const FIN_SLUG = '03_finances';
const FIN_TITLE = 'Финансы';
const FIN_CONTENT = `# Финансы

## Бюджеты

Бюджет задаётся на месяц и категорию.`;

/** Ловушка для проверки алиаса: по токену она сильнее главы «Финансы». */
const DECOY_CONTENT = `# Задачи и напоминания

## Бюджет в задачах

Бюджет в задачах упоминается не раз: бюджет, бюджет и ещё раз бюджет.`;

async function seedTasksChapter(userId: number = USER_A): Promise<void> {
  await createChapter(userId, {
    slug: TASKS_SLUG,
    filename: `${TASKS_SLUG}.md`,
    title: TASKS_TITLE,
    content: TASKS_CONTENT,
  });
}

async function seedFinancesChapter(userId: number = USER_A): Promise<void> {
  await createChapter(userId, {
    slug: FIN_SLUG,
    filename: `${FIN_SLUG}.md`,
    title: FIN_TITLE,
    content: FIN_CONTENT,
  });
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// Валидация и пустая база
// ---------------------------------------------------------------------------

describe('consult_system_docs: пустой ввод и пустая база', () => {
  it('пустой, пробельный и нестроковый query — ok:false', async () => {
    const missing = await run('consult_system_docs', {});
    expect(missing.ok).toBe(false);
    expect(missing.content).toBe('Пустой запрос — нечего искать в документации.');

    const blank = await run('consult_system_docs', { query: '   ' });
    expect(blank.ok).toBe(false);
    expect(blank.content).toBe('Пустой запрос — нечего искать в документации.');

    const wrongType = await run('consult_system_docs', { query: 42 });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.content).toBe('Пустой запрос — нечего искать в документации.');
  });

  it('на пустой базе отдаёт манифест-приглашение и данные запроса', async () => {
    // Чужие главы не должны «просачиваться» в манифест.
    await createChapter(USER_B, {
      slug: 'b_only',
      title: 'Только у B',
      content: '## Раздел\n\nТекст раздела у второго пользователя.',
    });

    const outcome = await run('consult_system_docs', { query: 'как добавить задачу' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '📖 Документация пока не заполнена.\n\n' +
        'Вызывающий код может создать главы через `seedDocs(userId)` или добавить свои.',
    );
    expect(outcome.data as DocsData).toEqual({
      query: 'как добавить задачу',
      topic: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Поиск по секциям
// ---------------------------------------------------------------------------

describe('consult_system_docs: поиск по секциям', () => {
  it('находит раздел и отдаёт блок-цитату с источником', async () => {
    await seedTasksChapter();

    const outcome = await run('consult_system_docs', { query: 'как добавить задачу' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      [
        FRAME,
        `📄 [Документация: ${TASKS_TITLE}]`,
        'Раздел: § Как добавить задачу',
        `Источник: ${TASKS_SLUG}.md`,
        DIVIDER,
        TASKS_SUMMARY,
        FRAME,
      ].join('\n'),
    );
    expect(outcome.data as DocsData).toEqual({
      query: 'как добавить задачу',
      topic: null,
    });
  });

  it('тема передаётся в поиск и возвращается в data', async () => {
    await seedTasksChapter();

    const outcome = await run('consult_system_docs', {
      query: 'как добавить задачу',
      topic: '  задачи  ',
    });
    expect(outcome.ok).toBe(true);
    // asText обрезает пробелы, в data уходит уже нормализованная тема.
    expect(outcome.data as DocsData).toEqual({
      query: 'как добавить задачу',
      topic: 'задачи',
    });
    expect(outcome.content).toContain('Раздел: § Как добавить задачу');
  });

  it('глава без `##` — одна секция размером с главу, источник из слага', async () => {
    await createChapter(USER_A, {
      slug: 'plain',
      title: 'Памятка',
      content: 'Полезные сведения о работе системы без заголовков.',
    });

    const outcome = await run('consult_system_docs', { query: 'сведения' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      [
        FRAME,
        '📄 [Документация: Памятка]',
        'Раздел: § Памятка',
        'Источник: plain.md',
        DIVIDER,
        'Полезные сведения о работе системы без заголовков.',
        FRAME,
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Оглавление и промахи
// ---------------------------------------------------------------------------

describe('consult_system_docs: оглавление и промахи', () => {
  it('запрос-оглавление с темой отдаёт карточку главы', async () => {
    await seedTasksChapter();

    const outcome = await run('consult_system_docs', {
      query: 'оглавление',
      topic: 'задачи',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      `📖 [Документация: глава «${TASKS_TITLE}»]\n` +
        `Источник: ${TASKS_SLUG}.md\n\n` +
        `Краткое описание: ${TASKS_SUMMARY}\n\n` +
        'Разделы главы:\n' +
        '- § Как добавить задачу\n' +
        '- § Повторы\n\n' +
        'Полный текст доступен по запросу конкретного раздела.',
    );
  });

  it('запрос-оглавление без темы отдаёт манифест со сводкой и подсказкой', async () => {
    await seedTasksChapter();

    const outcome = await run('consult_system_docs', { query: 'список' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      [
        '📖 Доступные главы документации:',
        `• **${TASKS_TITLE}** (slug: \`${TASKS_SLUG}\`)\n  ${TASKS_SUMMARY}`,
        '\nЧтобы получить детальную информацию, укажите тему или ключевые слова ' +
          "(например: query='как добавить задачу', topic='задачи').",
      ].join('\n\n'),
    );
  });

  it('длинная сводка в манифесте обрезается до 200 символов плюс `...`', async () => {
    const longParagraph = 'Длинное описание '.repeat(20).trim();
    expect(longParagraph.length).toBeGreaterThan(200);

    await createChapter(USER_A, {
      slug: 'long',
      title: 'Длинная глава',
      filename: 'long.md',
      content: `# Длинная глава\n\n${longParagraph}\n\n## Раздел\n\nТекст раздела.`,
    });

    const outcome = await run('consult_system_docs', { query: 'оглавление' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain(`${longParagraph.slice(0, 200)}...`);
    expect(outcome.content).not.toContain(longParagraph);
    expect(outcome.content).toContain('(slug: `long`)');
  });

  it('промах внутри темы перечисляет разделы именно этой главы', async () => {
    await seedTasksChapter();

    const outcome = await run('consult_system_docs', {
      query: 'квантовый',
      topic: 'задачи',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      `⚠️ По запросу «квантовый» точных совпадений в главе «${TASKS_TITLE}» не найдено.\n\n` +
        'Доступные разделы этой главы:\n' +
        '- § Как добавить задачу\n' +
        '- § Повторы\n\n' +
        'Попробуйте переформулировать запрос или запросить конкретный раздел.',
    );
  });

  it('общий промах перечисляет все главы и советует не выдумывать', async () => {
    await seedTasksChapter();
    await seedFinancesChapter();

    const outcome = await run('consult_system_docs', { query: 'квантовый' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '⚠️ По запросу «квантовый» информация в документации не найдена.\n' +
        `Доступные главы: «${TASKS_TITLE}» (\`${TASKS_SLUG}\`), «${FIN_TITLE}» (\`${FIN_SLUG}\`).\n` +
        'Если пользователь спрашивает о несуществующей функции, честно скажите, что такой возможности в системе нет.',
    );
  });
});

// ---------------------------------------------------------------------------
// Алиасы тем
// ---------------------------------------------------------------------------

describe('consult_system_docs: алиас темы', () => {
  it('«финансы» ограничивает поиск главой 03_finances, даже если другая глава ближе по токену', async () => {
    // Проверяем именно фильтр пула: без него DECOY выиграл бы по очкам.
    await createChapter(USER_A, {
      slug: TASKS_SLUG,
      filename: `${TASKS_SLUG}.md`,
      title: TASKS_TITLE,
      content: DECOY_CONTENT,
    });
    await seedFinancesChapter();

    const outcome = await run('consult_system_docs', {
      query: 'бюджет',
      topic: 'финансы',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      [
        FRAME,
        `📄 [Документация: ${FIN_TITLE}]`,
        'Раздел: § Бюджеты',
        `Источник: ${FIN_SLUG}.md`,
        DIVIDER,
        'Бюджет задаётся на месяц и категорию.',
        FRAME,
      ].join('\n'),
    );
    expect(outcome.content).not.toContain('Бюджет в задачах');
  });
});
