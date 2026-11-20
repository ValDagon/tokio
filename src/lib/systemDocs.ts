/**
 * Системная документация (Docs-as-Code) — порт
 * `backend/app/services/system_docs.py` на per-user хранилище `doc_chapters`.
 *
 * Что изменилось осознанно (ADR-002):
 *  - upstream читал `docs/system/*.md` из репозитория и держал индекс в памяти;
 *    здесь главы лежат в БД и принадлежат пользователю, поэтому сервис не
 *    синглтон и не кэширует: `userId` — обязательный первый аргумент;
 *  - тексты upstream-файлов содержат персональные данные хозяина и НЕ
 *    переносятся. Нейтральный продуктовый набор — `DEFAULT_DOC_SEEDS`; сид
 *    запускает вызывающий (`seedDocs`), сам модуль хранилище не заполняет;
 *  - в цитатах нет имени продукта upstream: «Документация» без бренда.
 *
 * Что сохранено как в upstream (это контракт для агента и тестов):
 *  - разбор секций по `##` / `###` (заголовок `#` — только название главы);
 *     нет секций — одна секция размером с главу;
 *  - алиасы тем (`TOPIC_ALIASES`) — «финансы», «задачи», «заметки» и т.п.;
 *  - текстовый ответ поиска с блоками-цитатами и тем же скорингом
 *    (15 — фраза в заголовке секции, 8 — фраза в тексте, 5/3/1 — токены
 *    в заголовке секции / главы / тексте, +4 — попадание в целевую тему).
 *
 * Модуль чистый: только DAL + строковые операции, никаких сетевых вызовов.
 */

import type { DocChapterRow } from '../types.js';
import { seedChapters, getChapter, listChapters } from './dal/docs.js';
import type { DocChapterInput, SeedChaptersResult } from './dal/docs.js';
import { truncate } from './utils.js';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Секция главы: `##`/`###`-блок вместе с текстом до следующего заголовка. */
export interface DocSection {
  chapterSlug: string;
  chapterTitle: string;
  sectionTitle: string;
  /** 2 — `##`, 3 — `###`; 1 — фолбэк «вся глава одной секцией». */
  level: number;
  content: string;
}

/** Глава вместе с производными полями (сводка и разобранные секции). */
export interface DocChapterView extends DocChapterRow {
  summary: string;
  sections: DocSection[];
}

// ---------------------------------------------------------------------------
// Разбор Markdown
// ---------------------------------------------------------------------------

const SECTION_HEADING = /^(#{2,3})\s+(.+)$/gm;

/** Сводка главы: первый содержательный абзац, до 200 символов. */
export function summarizeChapter(content: string): string {
  const paragraphs = String(content ?? '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith('#')) continue;
    if (paragraph.length <= 20) continue;
    const flat = paragraph.replace(/\s*\n\s*/g, ' ');
    return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
  }
  return '';
}

/**
 * Разбирает главу на секции. Текст до первого `##`/`###` в секции не попадает
 * (как в upstream: это вступление/лид, он виден только в полном тексте главы).
 */
export function parseSections(
  slug: string,
  chapterTitle: string,
  content: string,
): DocSection[] {
  const text = String(content ?? '');
  const matches = [...text.matchAll(SECTION_HEADING)];

  if (matches.length === 0) {
    return [
      {
        chapterSlug: slug,
        chapterTitle,
        sectionTitle: chapterTitle,
        level: 1,
        content: text.trim(),
      },
    ];
  }

  const sections: DocSection[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = match[1] ?? '##';
    const rawTitle = match[2] ?? '';
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1];
    const end = next?.index ?? text.length;

    const body = text
      .slice(start, end)
      .replace(/(?:\n+|^)-{3,}\s*$/, '')
      .trim();

    sections.push({
      chapterSlug: slug,
      chapterTitle,
      sectionTitle: rawTitle.trim(),
      level: heading.length,
      content: body,
    });
  }
  return sections;
}

/** Строка БД → представление главы для поиска и выдачи. */
export function toChapterView(chapter: DocChapterRow): DocChapterView {
  return {
    ...chapter,
    summary: summarizeChapter(chapter.content) || `Документация раздела «${chapter.title}»`,
    sections: parseSections(chapter.slug, chapter.title, chapter.content),
  };
}

// ---------------------------------------------------------------------------
// Темы
// ---------------------------------------------------------------------------

/**
 * Алиасы тем: слово пользователя → слаг главы. Только нейтральные продуктовые
 * понятия; никаких имён банков, городов и сфер жизни хозяина (ADR-002).
 */
export const TOPIC_ALIASES: Readonly<Record<string, string>> = {
  overview: '00_overview',
  обзор: '00_overview',
  система: '00_overview',
  справка: '00_overview',
  начало: '00_overview',
  устройство: '00_overview',

  task: '01_tasks_and_reminders',
  tasks: '01_tasks_and_reminders',
  todo: '01_tasks_and_reminders',
  задачи: '01_tasks_and_reminders',
  задача: '01_tasks_and_reminders',
  дела: '01_tasks_and_reminders',
  reminder: '01_tasks_and_reminders',
  reminders: '01_tasks_and_reminders',
  напоминания: '01_tasks_and_reminders',
  повторы: '01_tasks_and_reminders',

  note: '02_notes_and_ideas',
  notes: '02_notes_and_ideas',
  заметки: '02_notes_and_ideas',
  заметка: '02_notes_and_ideas',
  идеи: '02_notes_and_ideas',
  канбан: '02_notes_and_ideas',
  инбокс: '02_notes_and_ideas',
  входящие: '02_notes_and_ideas',

  finance: '03_finances',
  finances: '03_finances',
  финансы: '03_finances',
  деньги: '03_finances',
  счета: '03_finances',
  бюджет: '03_finances',
  траты: '03_finances',
  долги: '03_finances',
  debt: '03_finances',
  debts: '03_finances',

  medication: '04_medications',
  medications: '04_medications',
  медикаменты: '04_medications',
  аптечка: '04_medications',
  таблетки: '04_medications',
  лекарства: '04_medications',

  agent: '05_agent_and_tools',
  агент: '05_agent_and_tools',
  инструменты: '05_agent_and_tools',
  тулзы: '05_agent_and_tools',
  tools: '05_agent_and_tools',
  возможности: '05_agent_and_tools',

  privacy: '06_privacy_and_data',
  данные: '06_privacy_and_data',
  приватность: '06_privacy_and_data',
  бэкап: '06_privacy_and_data',
  backup: '06_privacy_and_data',
  экспорт: '06_privacy_and_data',

  custom: '07_custom_instructions',
  стиль: '07_custom_instructions',
  стили: '07_custom_instructions',
  инструкции: '07_custom_instructions',
  директивы: '07_custom_instructions',
  персонализация: '07_custom_instructions',
};

/** Слово пользователя → слаг; неизвестное возвращается как есть (может быть слагом). */
export function resolveTopic(topic: string | null | undefined): string | null {
  const value = String(topic ?? '').trim().toLowerCase();
  if (!value) return null;
  return TOPIC_ALIASES[value] ?? value;
}

// ---------------------------------------------------------------------------
// Нейтральные дефолтные главы (сиды)
// ---------------------------------------------------------------------------

/**
 * Дефолтный набор глав: короткие нейтральные описания возможностей продукта.
 * Никаких персональных данных, брендов банков, городов и привычек хозяина —
 * это шаблон, который можно перезаписать (`seedDocs(userId, свои главы)`).
 */
export const DEFAULT_DOC_SEEDS: readonly DocChapterInput[] = [
  {
    slug: '00_overview',
    filename: '00_overview.md',
    title: 'Как устроен ассистент',
    content: `# Как устроен ассистент

Ассистент ведёт дела в мессенджере: принимает сообщения, раскладывает их по заметкам и задачам, напоминает о важном и отвечает на вопросы по вашим данным.

## Из чего он состоит

- чат — быстрый ввод мыслей и команд;
- заметки и канбан — входящие, идеи, дела, корзина;
- задачи и напоминания с повторами;
- финансы — счета, траты, бюджеты, долги;
- медикаменты — расписание приёма и журнал;
- утренний дайджест и ночная консолидация заметок.

## Как с ним работать

Пишите обычным языком: «напомни завтра про встречу», «потратил 12 евро на обед», «запиши идею». Ассистент сам поймёт, куда отнести запись, и покажет, что получилось.
`,
  },
  {
    slug: '01_tasks_and_reminders',
    filename: '01_tasks_and_reminders.md',
    title: 'Задачи и напоминания',
    content: `# Задачи и напоминания

## Как добавить задачу

Напишите её обычным сообщением. Ассистент выделит задачу из текста и положит в список. Срок можно указать словами: «завтра», «в пятницу», «каждый понедельник».

## Повторы

У задачи может быть правило повтора. После выполнения создаётся следующее вхождение, а выполненное остаётся в истории.

## Напоминания

Напоминание приходит в чат в назначенное время. Если задача отложена или уже выполнена, напоминание снимается.

## Приоритет

Задачи можно помечать как важные — они поднимаются выше в списке и попадают в утренний дайджест.
`,
  },
  {
    slug: '02_notes_and_ideas',
    filename: '02_notes_and_ideas.md',
    title: 'Заметки и идеи',
    content: `# Заметки и идеи

## Входящие

Всё, что вы пишете или наговариваете, сначала попадает во «Входящие» — без обязательной разметки.

## Колонки канбана

- «Идеи» — замыслы и гипотезы;
- «Заметки» — полезное и личное;
- «Дела» — то, что можно превратить в задачу;
- «Корзина» — неактуальное и дубликаты.

## Ночная консолидация

Раз в сутки ассистент разбирает входящие: чистит текст, убирает дубликаты и раскладывает заметки по колонкам. Повторный прогон за тот же день ничего не дублирует.
`,
  },
  {
    slug: '03_finances',
    filename: '03_finances.md',
    title: 'Финансы',
    content: `# Финансы

## Счета и балансы

Счёт описывается названием, валютой и стартовым балансом. Перевод между счетами не меняет общий капитал.

## Траты и доходы

Запись создаётся из сообщения: сумма, категория, счёт и дата. Список категорий можно расширять.

## Бюджеты

Бюджет задаётся на месяц и категорию. Ассистент показывает, сколько осталось, и предупреждает о перерасходе.

## Долги

Долг учитывается отдельно: сумма, ставка и регулярный платёж. Платежи уменьшают остаток и не считаются обычной тратой.

## Курсы валют

Счета в разных валютах пересчитываются по курсу на дату операции.
`,
  },
  {
    slug: '04_medications',
    filename: '04_medications.md',
    title: 'Медикаменты',
    content: `# Медикаменты

## Расписание

У препарата есть дозировка и время приёма. Напоминание приходит в чат, а отметка о приёме сохраняется в журнале.

## Журнал приёма

Журнал показывает, что и когда было принято. Пропуски видны в утреннем дайджесте.

## Осторожно

Ассистент напоминает о приёме, но не заменяет врача и не меняет назначения самостоятельно.
`,
  },
  {
    slug: '05_agent_and_tools',
    filename: '05_agent_and_tools.md',
    title: 'Агент и инструменты',
    content: `# Агент и инструменты

## Что умеет агент

Агент отвечает на вопросы по вашим данным, ищет по заметкам и документации, считает суммы и помогает строить планы.

## Инструменты

Каждый инструмент — отдельное действие: задачи, заметки, финансы, медикаменты, документация. Агент вызывает их сам, когда это уместно.

## Ограничения

Если данных для ответа нет, агент скажет об этом прямо, а не придумает факт.
`,
  },
  {
    slug: '06_privacy_and_data',
    filename: '06_privacy_and_data.md',
    title: 'Данные и приватность',
    content: `# Данные и приватность

## Где хранятся данные

Записи привязаны к вашему аккаунту. Другие пользователи их не видят: каждый запрос ограничен владельцем данных.

## Экспорт и бэкап

Полный экспорт можно запросить в любой момент: он содержит задачи, заметки, финансы и настройки.

## Удаление

Удалённые записи сначала попадают в корзину и удаляются окончательно по истечении срока хранения.
`,
  },
  {
    slug: '07_custom_instructions',
    filename: '07_custom_instructions.md',
    title: 'Персонализация',
    content: `# Персонализация

## Стиль ответов

Можно задать предпочтения: длину ответа, обращение, формат списков и язык.

## Часовой пояс и время

Дайджест и напоминания считаются в вашем часовом поясе; время утреннего дайджеста настраивается.

## Свои правила

Личные инструкции сохраняются отдельно и применяются к каждому ответу агента.
`,
  },
];

/**
 * Идемпотентный сид глав. Без аргумента `chapters` сеет нейтральный набор
 * `DEFAULT_DOC_SEEDS`; защищённые (`is_pinned`) главы не перезаписываются.
 */
export async function seedDocs(
  userId: number,
  chapters: readonly DocChapterInput[] = DEFAULT_DOC_SEEDS,
): Promise<SeedChaptersResult> {
  return seedChapters(userId, chapters);
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

/** Все главы пользователя с разобранными секциями. */
export async function listDocs(userId: number): Promise<DocChapterView[]> {
  return (await listChapters(userId)).map(toChapterView);
}

/** Глава по слагу или алиасу темы (`'финансы'` → `03_finances`). */
export async function getDoc(
  userId: number,
  slugOrTopic: string,
): Promise<DocChapterView | null> {
  const slug = resolveTopic(slugOrTopic);
  if (!slug) return null;
  const chapter = await getChapter(userId, slug);
  return chapter ? toChapterView(chapter) : null;
}

// ---------------------------------------------------------------------------
// Поиск
// ---------------------------------------------------------------------------

/** Запрос «покажи оглавление» — отдаём манифест, а не результаты поиска. */
const LIST_QUERIES = new Set([
  'оглавление',
  'список',
  'темы',
  'главы',
  'docs',
  'help',
  'разделы',
  'что задокументировано',
]);

/** Служебные слова, которые не несут смысла при поиске (как в upstream). */
const STOP_TOKENS = new Set(['как', 'что', 'это', 'где', 'для', 'или', 'под', 'при', 'над']);

function manifestOf(chapters: readonly DocChapterView[]): string {
  if (chapters.length === 0) {
    return (
      '📖 Документация пока не заполнена.\n\n' +
      'Вызывающий код может создать главы через `seedDocs(userId)` или добавить свои.'
    );
  }
  const lines = ['📖 Доступные главы документации:'];
  for (const chapter of chapters) {
    lines.push(`• **${chapter.title}** (slug: \`${chapter.slug}\`)\n  ${chapter.summary}`);
  }
  lines.push(
    '\nЧтобы получить детальную информацию, укажите тему или ключевые слова ' +
      "(например: query='как добавить задачу', topic='задачи').",
  );
  return lines.join('\n\n');
}

function sectionsOf(chapters: readonly DocChapterView[]): DocSection[] {
  return chapters.flatMap((chapter) => chapter.sections);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.includes(needle) ? 1 : 0;
}

/** Токены запроса: слова длиннее двух символов без служебных. */
function queryTokens(query: string): string[] {
  return [...query.matchAll(/[\p{L}\p{N}_-]+/gu)]
    .map((match) => match[0].toLowerCase())
    .filter((token) => token.length > 2 && !STOP_TOKENS.has(token));
}

/**
 * Поиск по документации пользователя. Возвращает готовый текстовый блок для
 * агента: оглавление, «не найдено» или до трёх секций-цитат с источником.
 */
export async function searchDocs(
  userId: number,
  query: string,
  topic?: string | null,
): Promise<string> {
  const chapters = await listDocs(userId);
  const bySlug = new Map(chapters.map((chapter) => [chapter.slug, chapter]));
  const targetSlug = resolveTopic(topic);
  const queryClean = String(query ?? '').trim();

  if (chapters.length === 0) return manifestOf(chapters);

  if (!queryClean || LIST_QUERIES.has(queryClean.toLowerCase())) {
    const target = targetSlug ? bySlug.get(targetSlug) : undefined;
    if (target) {
      const sectionList = target.sections.map((section) => `- § ${section.sectionTitle}`).join('\n');
      return (
        `📖 [Документация: глава «${target.title}»]\n` +
        `Источник: ${target.filename ?? `${target.slug}.md`}\n\n` +
        `Краткое описание: ${target.summary}\n\n` +
        `Разделы главы:\n${sectionList}\n\n` +
        'Полный текст доступен по запросу конкретного раздела.'
      );
    }
    return manifestOf(chapters);
  }

  const tokens = queryTokens(queryClean);
  const phrase = queryClean.toLowerCase();

  const candidates = targetSlug
    ? sectionsOf(chapters.filter((chapter) => chapter.slug === targetSlug))
    : sectionsOf(chapters);
  const pool = candidates.length > 0 ? candidates : sectionsOf(chapters);

  const scored: Array<{ section: DocSection; score: number }> = [];
  for (const section of pool) {
    const sectionTitle = section.sectionTitle.toLowerCase();
    const chapterTitle = section.chapterTitle.toLowerCase();
    const body = section.content.toLowerCase();

    let score = 0;
    if (sectionTitle.includes(phrase)) score += 15;
    if (body.includes(phrase)) score += 8;

    for (const token of tokens) {
      if (sectionTitle.includes(token)) score += 5;
      if (chapterTitle.includes(token)) score += 3;
      if (body.includes(token)) score += 1;
    }

    if (targetSlug && section.chapterSlug === targetSlug) score += 4;
    // защита от «нашлось по одному слову главы, но не по запросу»
    if (score > 0 && tokens.some((token) => body.includes(token) || sectionTitle.includes(token))) {
      scored.push({ section, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const target = targetSlug ? bySlug.get(targetSlug) : undefined;
    if (target) {
      const sectionList = target.sections.map((section) => `- § ${section.sectionTitle}`).join('\n');
      return (
        `⚠️ По запросу «${queryClean}» точных совпадений в главе «${target.title}» не найдено.\n\n` +
        `Доступные разделы этой главы:\n${sectionList}\n\n` +
        'Попробуйте переформулировать запрос или запросить конкретный раздел.'
      );
    }
    const available = chapters
      .map((chapter) => `«${chapter.title}» (\`${chapter.slug}\`)`)
      .join(', ');
    return (
      `⚠️ По запросу «${queryClean}» информация в документации не найдена.\n` +
      `Доступные главы: ${available}.\n` +
      'Если пользователь спрашивает о несуществующей функции, честно скажите, что такой возможности в системе нет.'
    );
  }

  const blocks = scored.slice(0, 3).map(({ section }) => {
    const source = bySlug.get(section.chapterSlug)?.filename ?? `${section.chapterSlug}.md`;
    return (
      '==================================================\n' +
      `📄 [Документация: ${section.chapterTitle}]\n` +
      `Раздел: § ${section.sectionTitle}\n` +
      `Источник: ${source}\n` +
      '--------------------------------------------------\n' +
      `${truncate(section.content, 4000)}\n` +
      '=================================================='
    );
  });

  return blocks.join('\n\n');
}

/** Заголовки всех глав — для оглавления в UI/агенте. */
export async function docsManifest(userId: number): Promise<string> {
  return manifestOf(await listDocs(userId));
}

/** Вспомогательное: есть ли у пользователя хоть одна глава (без auto-seed). */
export async function hasDocs(userId: number): Promise<boolean> {
  return (await listChapters(userId)).length > 0;
}

// `countOccurrences` оставлен как точка расширения для будущего ранжирования;
// экспортируем, чтобы не плодить дубли в тестах и инструментах.
export { countOccurrences };
