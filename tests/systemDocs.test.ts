/**
 * `src/lib/systemDocs.ts` — чтение глав документации, разбор Markdown, темы
 * и текстовый поиск для агента.
 *
 * Ключевые инварианты порта (ADR-002):
 *  - главы — данные пользователя: модуль ничего не сеет сам, на пустой БД
 *    возвращает манифест, а не встроенный текст;
 *  - алиасы тем ведут к слагам глав, неизвестная тема не ломает запрос;
 *  - поиск — тот же скоринг, что в upstream: до трёх блоков-цитат с источником.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import type { DocChapterInput } from '../src/lib/dal/docs';
import {
  DEFAULT_DOC_SEEDS,
  TOPIC_ALIASES,
  countOccurrences,
  docsManifest,
  getDoc,
  hasDocs,
  listDocs,
  parseSections,
  resolveTopic,
  searchDocs,
  seedDocs,
  summarizeChapter,
} from '../src/lib/systemDocs';

const USER_A = 301;
const USER_B = 302;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

const DOCS: readonly DocChapterInput[] = [
  {
    slug: 'a_alpha',
    filename: 'a_alpha.md',
    title: 'Альфа',
    content: `# Альфа

Общая вводная часть про продукт, достаточно длинная для сводки.

## Цели и планы

Здесь собраны цели и планы на неделю: приоритеты и сроки.

## Отчёты

Здесь описаны отчёты и метрики за месяц.`,
  },
  {
    slug: 'b_beta',
    title: 'Бета',
    content: `# Бета

Вторая глава с описанием архива.

## Архив записей

Тут только архив записей и ничего больше.`,
  },
];

describe('summarizeChapter', () => {
  it('берёт первый содержательный абзац, пропуская заголовки и короткие строки', () => {
    const summary = summarizeChapter(
      '# Заголовок\n\n## Секция\n\nКоротко.\n\nЭто содержательный абзац длиннее двадцати символов.',
    );
    expect(summary).toBe('Это содержательный абзац длиннее двадцати символов.');
  });

  it('склеивает переносы строк внутри абзаца', () => {
    const summary = summarizeChapter('Первая строка абзаца\nи его продолжение, вместе длиннее двадцати.');
    expect(summary).toBe('Первая строка абзаца и его продолжение, вместе длиннее двадцати.');
  });

  it('обрезает длинный абзац до 200 символов с многоточием', () => {
    const summary = summarizeChapter('а'.repeat(250));
    expect(summary).toBe(`${'а'.repeat(200)}...`);
  });

  it('пустой текст → пустая сводка', () => {
    expect(summarizeChapter('')).toBe('');
    expect(summarizeChapter('# Только заголовок')).toBe('');
  });
});

describe('parseSections', () => {
  it('разбирает ## и ### на секции, текст до первого заголовка не входит', () => {
    const sections = parseSections(
      'a_alpha',
      'Альфа',
      '# Альфа\n\nЛид главы.\n\n## Раздел 1\n\nТекст 1\n\n### Подраздел\n\nТекст 2\n\n## Раздел 2\n\nТекст 3',
    );

    expect(sections.map((section) => section.sectionTitle)).toEqual([
      'Раздел 1',
      'Подраздел',
      'Раздел 2',
    ]);
    expect(sections.map((section) => section.level)).toEqual([2, 3, 2]);
    expect(sections[0].content).toBe('Текст 1');
    expect(sections[1].content).toBe('Текст 2');
    expect(sections[2].content).toBe('Текст 3');
    expect(sections[0].chapterSlug).toBe('a_alpha');
    expect(sections[0].chapterTitle).toBe('Альфа');
  });

  it('глава без секций — одна секция во всю главу', () => {
    const sections = parseSections('plain', 'Просто', '  Просто текст без заголовков.  ');

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      sectionTitle: 'Просто',
      level: 1,
      content: 'Просто текст без заголовков.',
    });
  });

  it('разделитель --- в конце секции отбрасывается', () => {
    const sections = parseSections('x', 'Икс', '## Первая\n\nТекст\n\n---\n\n## Вторая\n\nЕщё текст');
    expect(sections[0].content).toBe('Текст');
    expect(sections[1].content).toBe('Ещё текст');
  });
});

describe('resolveTopic / TOPIC_ALIASES', () => {
  it('алиасы ведут к слагам глав', () => {
    expect(resolveTopic('финансы')).toBe('03_finances');
    expect(resolveTopic('  Задачи ')).toBe('01_tasks_and_reminders');
    expect(resolveTopic('NOTES')).toBe('02_notes_and_ideas');
  });

  it('неизвестная тема возвращается как есть (может быть слагом)', () => {
    expect(resolveTopic('a_alpha')).toBe('a_alpha');
    expect(resolveTopic('Неизвестно')).toBe('неизвестно');
  });

  it('пустая тема → null', () => {
    expect(resolveTopic('')).toBeNull();
    expect(resolveTopic('   ')).toBeNull();
    expect(resolveTopic(null)).toBeNull();
    expect(resolveTopic(undefined)).toBeNull();
  });

  it('все алиасы ведут на нейтральные слаги', () => {
    for (const [alias, slug] of Object.entries(TOPIC_ALIASES)) {
      expect(alias.trim()).toBe(alias);
      expect(slug).toMatch(/^\d{2}_[a-z_]+$/);
    }
  });
});

describe('seedDocs / чтение', () => {
  it('на пустой БД ничего не сеет: манифест, hasDocs false', async () => {
    expect(await hasDocs(USER_A)).toBe(false);
    expect(await listDocs(USER_A)).toEqual([]);
    expect(await docsManifest(USER_A)).toContain('Документация пока не заполнена');
    expect(await getDoc(USER_A, 'финансы')).toBeNull();
  });

  it('сеет нейтральный дефолтный набор (8 глав) идемпотентно', async () => {
    const first = await seedDocs(USER_A);
    expect(first.created).toBe(DEFAULT_DOC_SEEDS.length);
    expect(DEFAULT_DOC_SEEDS.length).toBe(8);

    const second = await seedDocs(USER_A);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(DEFAULT_DOC_SEEDS.length);

    const chapters = await listDocs(USER_A);
    expect(chapters).toHaveLength(8);
    for (const chapter of chapters) {
      expect(chapter.summary.length).toBeGreaterThan(0);
      expect(chapter.sections.length).toBeGreaterThan(0);
      expect(chapter.isPinned).toBe(false);
    }
  });

  it('принимает свои главы от вызывающего', async () => {
    const result = await seedDocs(USER_A, DOCS);
    expect(result.created).toBe(2);

    const chapter = await getDoc(USER_A, 'a_alpha');
    expect(chapter?.title).toBe('Альфа');
    expect(chapter?.sections.map((section) => section.sectionTitle)).toEqual([
      'Цели и планы',
      'Отчёты',
    ]);
  });

  it('getDoc разрешает алиас темы и не видит чужие главы', async () => {
    await seedDocs(USER_A);

    expect((await getDoc(USER_A, 'финансы'))?.slug).toBe('03_finances');
    expect((await getDoc(USER_A, '03_finances'))?.slug).toBe('03_finances');
    expect(await getDoc(USER_B, 'финансы')).toBeNull();
    expect(await hasDocs(USER_B)).toBe(false);
  });

  it('сводка-фолбэк, когда в главе нет содержательного абзаца', async () => {
    await seedDocs(USER_A, [{ slug: 'short', title: 'Короткая', content: '# Короткая\n\n## Раздел' }]);

    const chapter = await getDoc(USER_A, 'short');
    expect(chapter?.summary).toBe('Документация раздела «Короткая»');
  });
});

describe('searchDocs', () => {
  it('пустая БД → манифест «не заполнена»', async () => {
    const answer = await searchDocs(USER_A, 'как добавить задачу');
    expect(answer).toContain('Документация пока не заполнена');
  });

  it('запрос «оглавление» отдаёт манифест со сводками', async () => {
    await seedDocs(USER_A, DOCS);

    const answer = await searchDocs(USER_A, 'оглавление');
    expect(answer).toContain('📖 Доступные главы документации:');
    expect(answer).toContain('**Альфа**');
    expect(answer).toContain('`b_beta`');
  });

  it('пустой запрос со темой отдаёт карточку главы со списком разделов', async () => {
    await seedDocs(USER_A, DOCS);

    const answer = await searchDocs(USER_A, '', 'a_alpha');
    expect(answer).toContain('📖 [Документация: глава «Альфа»]');
    expect(answer).toContain('Источник: a_alpha.md');
    expect(answer).toContain('- § Цели и планы');
    expect(answer).toContain('- § Отчёты');
  });

  it('находит секцию по запросу и отдаёт блок-цитату с источником', async () => {
    await seedDocs(USER_A, DOCS);

    const answer = await searchDocs(USER_A, 'отчёты');
    expect(answer).toContain('📄 [Документация: Альфа]');
    expect(answer).toContain('Раздел: § Отчёты');
    expect(answer).toContain('Источник: a_alpha.md');
    expect(answer).toContain('Здесь описаны отчёты и метрики за месяц.');
  });

  it('источник для главы без filename — <slug>.md', async () => {
    await seedDocs(USER_A, DOCS);

    const answer = await searchDocs(USER_A, 'архив');
    expect(answer).toContain('📄 [Документация: Бета]');
    expect(answer).toContain('Источник: b_beta.md');
  });

  it('отдаёт не больше трёх блоков', async () => {
    await seedDocs(USER_A, [
      {
        slug: 'c_many',
        title: 'Много',
        content:
          '# Много\n\n## Один\n\nметрика один.\n\n## Два\n\nметрика два.\n\n## Три\n\nметрика три.\n\n## Четыре\n\nметрика четыре.',
      },
    ]);

    const answer = await searchDocs(USER_A, 'метрика');
    const blocks = answer.match(/📄 \[Документация:/g) ?? [];
    expect(blocks).toHaveLength(3);
  });

  it('countOccurrences — булев признак вхождения', () => {
    expect(countOccurrences('есть метрика', 'метрика')).toBe(1);
    expect(countOccurrences('нет', 'метрика')).toBe(0);
  });

  it('фильтр по теме ищет только в её главе', async () => {
    await seedDocs(USER_A, DOCS);

    const answer = await searchDocs(USER_A, 'отчёты', 'b_beta');
    expect(answer).toContain('в главе «Бета» не найдено');
    expect(answer).toContain('- § Архив записей');
    expect(answer).not.toContain('Раздел: § Отчёты');
  });

  it('ничего не нашлось → честное «не найдено» со списком глав', async () => {
    await seedDocs(USER_A, DOCS);

    const answer = await searchDocs(USER_A, 'квазар');
    expect(answer).toContain('информация в документации не найдена');
    expect(answer).toContain('«Альфа»');
    expect(answer).toContain('«Бета»');
  });

  it('поиск ограничен владельцем данных', async () => {
    await seedDocs(USER_A, DOCS);

    const forB = await searchDocs(USER_B, 'отчёты');
    expect(forB).toContain('Документация пока не заполнена');
  });
});
