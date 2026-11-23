/**
 * Тулзы агента: глубокое рассуждение и персональные директивы (SPEC §3 T12).
 *
 * Держим инварианты тулз:
 *  - `synthesize_life_context` — только реальные данные пользователя: секции
 *    идут в стабильном порядке (💾 → 📝 → 📥 → 🧠 → 💳 → ✅ → 💊 → СДВГ-статус),
 *    пустые доменные секции не печатаются вовсе;
 *  - досье ограничено сверху: 6 заметок, 5 raw-записей, 6 KG-строк,
 *    6 задач — лимиты видны и в `data`-счётчиках;
 *  - KG-строка содержит ровно одну связь (`firstRelation`, в обе стороны),
 *    а тема фильтрует сущности по нормализованному имени/алиасам/описанию;
 *  - деньги печатаются посуммовыми центами через `formatMoney` (ADR-003);
 *  - директивы живут в главе `07_custom_instructions`, стиль — хвостом
 *    «Стиль общения: X», неизвестный стиль откатывается к `mentor`;
 *  - каждый пользователь видит только свои данные.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { CUSTOM_INSTRUCTIONS_SLUG } from '../../../src/lib/agent/engine';
import type { ExecutiveOverloadState } from '../../../src/lib/agent/prompts';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { reasoningTools } from '../../../src/lib/agent/tools/reasoning';
import { createChapter, getChapter, listChapters } from '../../../src/lib/dal/docs';
import { createLiability } from '../../../src/lib/dal/finances';
import { createMedication } from '../../../src/lib/dal/medications';
import { addRelation, upsertEntity } from '../../../src/lib/dal/misc';
import { createNote } from '../../../src/lib/dal/notes';
import { createTask, ensureSystemCategories, findCategoryByName } from '../../../src/lib/dal/tasks';
import { ensureUser, updateUser } from '../../../src/lib/dal/users';
import { addItem, buildSkillSpec, getItem, skillUsage } from '../../../src/lib/evolution';
import { formatMoney } from '../../../src/lib/utils';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');

const HEADER = '💾 **Срез реальных данных из вашей базы:**';

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

function contextFor(userId: number): ToolContext {
  return { ...CTX_A, userId };
}

function toolByName(name: string): Tool {
  const found = reasoningTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в reasoningTools`);
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

interface DossierData {
  topic: string | null;
  notes: number;
  raw_notes: number;
  knowledge: number;
  liabilities: number;
  tasks: number;
  medications: number;
  executiveOverload?: ExecutiveOverloadState;
}

interface DirectivesData {
  slug?: string;
  style: string;
  instructions?: string;
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

// ---------------------------------------------------------------------------
// Общий сценарий «жизнь как есть»
// ---------------------------------------------------------------------------

/**
 * Полный набор данных: заметка, идея, сырой буфер, две сущности со связью,
 * кредит, задача в категории «Быт» и лекарство.
 */
async function seedFullScenario(userId: number = USER_A) {
  await createNote(userId, 'Покупка квартиры рядом с парком', { column: 'note' });
  await createNote(userId, 'Идея приложения для заметок', { column: 'idea' });
  await createNote(userId, 'Сырая мысль про переезд', { column: 'raw' });

  const city = await upsertEntity(userId, {
    name: 'Москва',
    kind: 'place',
    description: 'Столица России',
  });
  const brother = await upsertEntity(userId, {
    name: 'Брат',
    kind: 'person',
    description: 'Родной брат',
  });
  await addRelation(userId, { subjectId: brother.id, predicate: 'живёт в', objectId: city.id });

  await createLiability(userId, {
    name: 'Кредит',
    amountCents: 123456,
    monthlyPaymentCents: 10000,
    paymentDay: 5,
  });

  await ensureSystemCategories(userId);
  const category = await findCategoryByName(userId, 'Быт');
  if (!category) throw new Error('категория «Быт» не создана');
  await createTask(userId, { title: 'Позвонить маме', categoryId: category.id });

  await createMedication(userId, {
    name: 'Магний',
    dosage: '1 таблетка',
    times: ['09:00', '21:00'],
  });

  return { city, brother, category };
}

// ---------------------------------------------------------------------------
// synthesize_life_context
// ---------------------------------------------------------------------------

describe('synthesize_life_context', () => {
  it('на пустой базе печатает только заголовок, СДВГ-статус Норма и нулевые счётчики', async () => {
    const outcome = await run('synthesize_life_context', {});

    expect(outcome.ok).toBe(true);
    expect(outcome.content.startsWith(HEADER)).toBe(true);
    expect(outcome.content).toContain('\n### СДВГ-статус и когнитивная нагрузка');
    expect(outcome.content).toContain('• Режим: Норма');
    expect(outcome.content).toContain('• Активные факторы: не выявлены');
    expect(outcome.content).toContain('• Строгое правило:');
    expect(outcome.content).not.toContain('📝 **Заметки и мысли:**');
    expect(outcome.content).not.toContain('✅ **Текущие задачи и фокус:**');

    const data = outcome.data as DossierData;
    expect(data.topic).toBeNull();
    expect(data).toMatchObject({
      notes: 0,
      raw_notes: 0,
      knowledge: 0,
      liabilities: 0,
      tasks: 0,
      medications: 0,
      executiveOverload: {
        isOverloaded: false,
        lowStimulationMode: false,
        activeTodoCount: 0,
        overdueTaskCount: 0,
        missedMedsCount: 0,
      },
    });
  });

  it('собирает секции в стабильном порядке и не печатает пустые', async () => {
    await seedFullScenario();

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    const content = outcome.content;

    const headers = [
      '💾',
      '\n📝 **Заметки и мысли:**',
      '\n📥 **Свежие мысли и инбокс (raw / inbox):**',
      '\n🧠 **Связи, проекты и ключевые сущности:**',
      '\n💳 **Финансовые обязательства:**',
      '\n✅ **Текущие задачи и фокус:**',
      '\n💊 **Приём препаратов:**',
      '\n### СДВГ-статус и когнитивная нагрузка',
    ];

    const positions = headers.map((header) => content.indexOf(header));
    for (const [index, position] of positions.entries()) {
      expect(position, `секция «${headers[index]}» отсутствует`).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    // Содержимое заметок и сырого буфера.
    expect(content).toContain('• [note] Покупка квартиры рядом с парком');
    expect(content).toContain('• [idea] Идея приложения для заметок');
    expect(content).toContain('• [raw] Сырая мысль про переезд');

    // Заметка (приоритет) идёт раньше идеи.
    expect(content.indexOf('Покупка квартиры рядом с парком')).toBeLessThan(
      content.indexOf('Идея приложения для заметок'),
    );

    const data = outcome.data as DossierData;
    expect(data).toMatchObject({
      topic: null,
      notes: 2,
      raw_notes: 1,
      knowledge: 2,
      liabilities: 1,
      tasks: 1,
      medications: 1,
    });
  });

  it('печатает суммы долгов и регулярные платежи через formatMoney', async () => {
    await createLiability(USER_A, {
      name: 'Кредит',
      amountCents: 123456,
      monthlyPaymentCents: 10000,
      paymentDay: 5,
    });

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);

    expect(outcome.content).toContain(
      `• Общий объём долгов/кредитов: ~${formatMoney(123456, 'EUR')}`,
    );
    expect(outcome.content).toContain(
      `• Регулярные платежи: Кредит: ${formatMoney(10000, 'EUR')} (день 5)`,
    );
    // ADR-003: узкий/обычный пробел не важен — сверяем сам вид суммы.
    expect(outcome.content).toContain('~€1 234,56');
  });

  it('KG-строка содержит описание и ровно одну связь (включая входящую)', async () => {
    await seedFullScenario();

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    const content = outcome.content;

    expect(content).toContain('• Брат (person): Родной брат -> живёт в Москва');
    expect(content).toContain('• Москва (place): Столица России -> Брат — живёт в → Москва');
    // Одна активная связь на узел: исходящая у «Брат» и входящая у «Москва».
    expect(content.split(' -> ')).toHaveLength(3);
  });

  it('печатает препараты с дозировкой и временем приёма', async () => {
    await createMedication(USER_A, {
      name: 'Магний',
      dosage: '1 таблетка',
      times: ['09:00', '21:00'],
    });

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• Магний (1 таблетка) в 09:00, 21:00');
  });

  it('печатает задачи с именем категории', async () => {
    await ensureSystemCategories(USER_A);
    const category = await findCategoryByName(USER_A, 'Быт');
    if (!category) throw new Error('категория «Быт» не создана');
    await createTask(USER_A, { title: 'Позвонить маме', categoryId: category.id });

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• Позвонить маме [Быт]');
  });

  it('тема фильтрует заметки и KG по вхождению в имя или описание', async () => {
    await upsertEntity(USER_A, {
      name: 'Москва',
      kind: 'place',
      description: 'Столица России',
    });
    await upsertEntity(USER_A, {
      name: 'Санкт-Петербург',
      kind: 'place',
      description: 'Город на Неве',
    });
    await upsertEntity(USER_A, {
      name: 'Переезд',
      kind: 'project',
      description: 'Планы: Москва, весна',
    });
    await createNote(USER_A, 'Москва зовёт', { column: 'note' });
    await createNote(USER_A, 'Купить хлеб', { column: 'note' });

    const outcome = await run('synthesize_life_context', { topic: 'Москва' });
    expect(outcome.ok).toBe(true);
    const content = outcome.content;

    const data = outcome.data as DossierData;
    expect(data.topic).toBe('Москва');
    expect(data.knowledge).toBe(2);
    expect(data.notes).toBe(1);

    expect(content).toContain('• Москва (place): Столица России');
    expect(content).toContain('• Переезд (project): Планы: Москва, весна');
    expect(content).not.toContain('Санкт-Петербург');

    expect(content).toContain('• [note] Москва зовёт');
    expect(content).not.toContain('Купить хлеб');
  });

  it('держит лимиты: 6 заметок, 5 raw-записей, 6 KG-строк и 6 задач', async () => {
    for (let index = 1; index <= 8; index += 1) {
      await createNote(USER_A, `Заметка ${index}`, { column: 'note' });
    }
    for (let index = 1; index <= 7; index += 1) {
      await createNote(USER_A, `Сырьё ${index}`, { column: 'raw' });
    }
    for (let index = 1; index <= 8; index += 1) {
      await upsertEntity(USER_A, {
        name: `Сущность ${index}`,
        kind: 'other',
        description: `описание ${index}`,
      });
    }
    for (let index = 1; index <= 8; index += 1) {
      await createTask(USER_A, { title: `Задача ${index}` });
    }

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    const content = outcome.content;

    const data = outcome.data as DossierData;
    expect(data).toMatchObject({
      notes: 6,
      raw_notes: 5,
      knowledge: 6,
      tasks: 6,
    });

    // Отрезаются самые старые записи (свежие идут первыми).
    expect(content).toContain('Заметка 8');
    expect(content).not.toContain('Заметка 1\n');
    expect(content).toContain('Сырьё 7');
    expect(content).not.toContain('Сырьё 1');
    expect(content).toContain('• Задача 8');
    expect(content).not.toContain('• Задача 1\n');
  });

  it('тема фильтрует KG по алиасам с нормализацией ё/е, регистра и кавычек', async () => {
    await upsertEntity(USER_A, {
      name: 'Проект Ёлка',
      kind: 'project',
      aliases: ['Праздничный старт'],
      description: 'Зимний запуск',
    });
    await upsertEntity(USER_A, {
      name: 'Другая сущность',
      kind: 'other',
      description: 'Не связано',
    });

    const byNormalizedName = await run('synthesize_life_context', { topic: '«елка»' });
    expect(byNormalizedName.ok).toBe(true);
    expect(byNormalizedName.content).toContain('• Проект Ёлка (project): Зимний запуск');
    expect(byNormalizedName.content).not.toContain('Другая сущность');

    const byAlias = await run('synthesize_life_context', { topic: 'праздничный старт' });
    expect(byAlias.ok).toBe(true);
    expect(byAlias.content).toContain('• Проект Ёлка (project): Зимний запуск');
    expect(byAlias.content).not.toContain('Другая сущность');
  });

  it('СДВГ-статус: считает полный объём задач/просрочки/лекарств и активирует щит при перегрузе', async () => {
    await updateUser(USER_A, { lowStimulationMode: false });
    // Создаём 8 просроченных задач (> 6 отображаемых, >= 3 для wipOverload).
    for (let index = 1; index <= 8; index += 1) {
      await createTask(USER_A, {
        title: `Просрочка ${index}`,
        dueAt: '2026-03-10',
      });
    }
    // Препарат на 09:00 при CTX_A.now = 11:00 -> пропущен (> 30 мин).
    await createMedication(USER_A, {
      name: 'Магний',
      dosage: '1 шт',
      times: ['09:00'],
    });

    const outcome = await run('synthesize_life_context', { topic: 'перегруз на работе' });
    expect(outcome.ok).toBe(true);
    const content = outcome.content;

    expect(content).toContain('### СДВГ-статус и когнитивная нагрузка');
    expect(content).toContain('• Режим: ПЕРЕГРУЗ / ЩИТ АКТИВЕН');
    expect(content).toContain(
      '• Активные задачи: 8, просроченные: 8, пропущенные приёмы лекарств: 1',
    );
    expect(content).toContain('высокий объём дел (активных: 8, просроченных: 8)');
    expect(content).toContain('неотмеченные приёмы лекарств (1)');
    expect(content).toContain('маркеры перегрузки/ступора в запросе: перегруз');
    expect(content).toContain('≤ 2 минут');
    expect(content).toContain('не переноси, не редактируй и не удаляй задачи пользователя в БД автоматически');

    const data = outcome.data as DossierData;
    expect(data.tasks).toBe(6);
    expect(data.executiveOverload).toMatchObject({
      isOverloaded: true,
      activeFactorCount: 3,
      activeTodoCount: 8,
      overdueTaskCount: 8,
      missedMedsCount: 1,
    });
  });

  it('СДВГ-статус: ручной lowStimulationMode активирует щит даже на пустой базе', async () => {
    await updateUser(USER_A, { lowStimulationMode: true });

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• Режим: ПЕРЕГРУЗ / ЩИТ АКТИВЕН');
    expect(outcome.content).toContain('ручной спокойный режим (low-stimulation)');
    expect(outcome.content).toContain('≤ 2 минут');
    expect((outcome.data as DossierData).executiveOverload?.isOverloaded).toBe(true);
  });

  it('СДВГ-статус: считает локальный час, просрочку и пропуски лекарств строго в таймзоне пользователя', async () => {
    const momentUtc = new Date('2026-11-06T19:30:00Z');
    // 3 просроченные задачи на 2026-11-05 + 1 на сегодня (2026-11-06, не просрочена).
    for (let index = 1; index <= 3; index += 1) {
      await createTask(USER_A, { title: `Вчерашняя ${index}`, dueAt: '2026-11-05' });
    }
    await createTask(USER_A, { title: 'Сегодняшняя', dueAt: '2026-11-06' });
    // Препарат на 21:00: в Europe/Moscow (22:30) пропущен, в America/New_York (14:30) ещё нет.
    await createMedication(USER_A, { name: 'Мелатонин', dosage: '3 мг', times: ['21:00'] });

    // 19:30Z -> 14:30 в America/New_York (EST): нет вечернего окна и нет пропуска дозы -> Норма (1 фактор WIP).
    const nyOutcome = await run('synthesize_life_context', {}, {
      userId: USER_A,
      timezone: 'America/New_York',
      baseCurrency: 'EUR',
      now: momentUtc,
    });
    expect(nyOutcome.ok).toBe(true);
    expect(nyOutcome.content).toContain('• Режим: Норма');
    expect((nyOutcome.data as DossierData).executiveOverload).toMatchObject({
      isOverloaded: false,
      localHour: 14,
      activeTodoCount: 4,
      overdueTaskCount: 3,
      missedMedsCount: 0,
      activeFactorCount: 1,
      factors: {
        wipOverload: true,
        circadianOrTherapyLoad: false,
        emotionalDistressMarker: false,
      },
    });

    // 19:30Z -> 22:30 в Europe/Moscow: вечернее окно + пропуск 21:00 -> ПЕРЕГРУЗ (2 фактора).
    const mskOutcome = await run('synthesize_life_context', {}, {
      userId: USER_A,
      timezone: 'Europe/Moscow',
      baseCurrency: 'EUR',
      now: momentUtc,
    });
    expect(mskOutcome.ok).toBe(true);
    expect(mskOutcome.content).toContain('• Режим: ПЕРЕГРУЗ / ЩИТ АКТИВЕН');
    expect(mskOutcome.content).toContain('позднее/ночное время (22:00)');
    expect(mskOutcome.content).toContain('неотмеченные приёмы лекарств (1)');
    expect((mskOutcome.data as DossierData).executiveOverload).toMatchObject({
      isOverloaded: true,
      localHour: 22,
      activeTodoCount: 4,
      overdueTaskCount: 3,
      missedMedsCount: 1,
      activeFactorCount: 2,
      factors: {
        wipOverload: true,
        circadianOrTherapyLoad: true,
        emotionalDistressMarker: false,
      },
    });
  });

  it('KG: ищет сущность по нормализованному алиасу (ё -> е), показывает активные входящие/исходящие связи и скрывает закрытые (valid_to IS NOT NULL)', async () => {
    const hub = await upsertEntity(USER_A, {
      name: 'Проект Альфа',
      kind: 'project',
      aliases: ['Чёрный список'],
      description: 'Главный проект',
    });
    const oldTarget = await upsertEntity(USER_A, { name: 'Старый подрядчик', kind: 'other' });
    const newTarget = await upsertEntity(USER_A, { name: 'Новый подрядчик', kind: 'other' });

    // Закрытая (valid_to IS NOT NULL) и активная исходящие связи у `hub`.
    await addRelation(USER_A, {
      subjectId: hub.id,
      predicate: 'подрядчик',
      objectId: oldTarget.id,
      validTo: '2026-01-10T00:00:00Z',
    });
    await addRelation(USER_A, {
      subjectId: hub.id,
      predicate: 'подрядчик',
      objectId: newTarget.id,
    });

    const report = await upsertEntity(USER_A, {
      name: 'Сводка квартала',
      kind: 'other',
      aliases: ['Звёздный отчёт'],
      description: 'Итоги',
    });
    const archivedAuthor = await upsertEntity(USER_A, { name: 'Архивный бот', kind: 'person' });
    const activeAuthor = await upsertEntity(USER_A, { name: 'Анна', kind: 'person' });

    // Закрытая и активная входящие связи у `report`.
    await addRelation(USER_A, {
      subjectId: archivedAuthor.id,
      predicate: 'составил',
      objectId: report.id,
      validTo: '2026-01-15T00:00:00Z',
    });
    await addRelation(USER_A, {
      subjectId: activeAuthor.id,
      predicate: 'ведёт',
      objectId: report.id,
    });

    const outgoingOutcome = await run('synthesize_life_context', { topic: 'черный список' });
    expect(outgoingOutcome.ok).toBe(true);
    expect(outgoingOutcome.content).toContain(
      '• Проект Альфа (project): Главный проект -> подрядчик Новый подрядчик',
    );
    expect(outgoingOutcome.content).not.toContain('Старый подрядчик');

    const incomingOutcome = await run('synthesize_life_context', { topic: 'звездный отчет' });
    expect(incomingOutcome.ok).toBe(true);
    expect(incomingOutcome.content).toContain(
      '• Сводка квартала (other): Итоги -> Анна — ведёт → Сводка квартала',
    );
    expect(incomingOutcome.content).not.toContain('Архивный бот');
  });

  it('не показывает данные чужого пользователя', async () => {
    await seedFullScenario(USER_B);

    const outcome = await run('synthesize_life_context', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content.startsWith(HEADER)).toBe(true);
    expect(outcome.content).toContain('• Режим: Норма');
    expect(outcome.content).not.toContain('Покупка квартиры рядом с парком');
    expect(outcome.content).not.toContain('Москва');
    expect(outcome.content).not.toContain('Магний');

    const data = outcome.data as DossierData;
    expect(data).toMatchObject({
      notes: 0,
      raw_notes: 0,
      knowledge: 0,
      liabilities: 0,
      tasks: 0,
      medications: 0,
      executiveOverload: {
        isOverloaded: false,
        activeTodoCount: 0,
        overdueTaskCount: 0,
        missedMedsCount: 0,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// update_custom_directives
// ---------------------------------------------------------------------------

describe('update_custom_directives', () => {
  it('создаёт запиненную главу директив с хвостом стиля', async () => {
    const outcome = await run('update_custom_directives', {
      instructions: 'Будь краток',
      persona_style: 'concise',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('✨ Системный промпт и правила поведения обновлены:');
    expect(outcome.content).toContain('«Будь краток»');
    expect(outcome.data).toEqual({ slug: '07_custom_instructions', style: 'concise' });
    expect(CUSTOM_INSTRUCTIONS_SLUG).toBe('07_custom_instructions');

    const chapter = await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG);
    if (!chapter) throw new Error('глава директив не создана');
    expect(chapter.title).toBe('Персональные директивы');
    expect(chapter.isPinned).toBe(true);
    expect(chapter.content).toBe('Будь краток\n\nСтиль общения: concise');

    expect((await listChapters(USER_A)).map((item) => item.slug)).toEqual([
      '07_custom_instructions',
    ]);
  });

  it('повторный патч переписывает только хвост стиля и не теряет инструкции', async () => {
    // В самих инструкциях тоже есть маркер стиля — разбор обязан брать последний.
    const instructions = 'Правило:\nСтиль общения: кратко';
    const first = await run('update_custom_directives', {
      instructions,
      persona_style: 'concise',
    });
    expect(first.ok).toBe(true);

    const second = await run('update_custom_directives', {
      instructions,
      persona_style: 'strategist',
    });
    expect(second.ok).toBe(true);
    expect(second.data).toEqual({ slug: '07_custom_instructions', style: 'strategist' });

    const chapter = await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG);
    if (!chapter) throw new Error('глава директив не создана');
    expect(chapter.content).toBe(`${instructions}\n\nСтиль общения: strategist`);

    const read = await run('get_custom_directives', {});
    expect(read.ok).toBe(true);
    expect(read.content).toBe(
      `🎯 Текущие системные директивы (стиль: strategist):\n«${instructions}»`,
    );
    expect(read.data).toEqual({ style: 'strategist', instructions });
  });

  it('неизвестный стиль — ok:false со списком доступных и без записи главы', async () => {
    const outcome = await run('update_custom_directives', {
      instructions: 'Будь краток',
      persona_style: 'pirate',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'Неизвестный стиль «pirate». Доступные: mentor, strategist, calm_partner, concise.',
    );
    expect(await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG)).toBeNull();
  });

  it('пустые инструкции — ok:false', async () => {
    const blank = await run('update_custom_directives', { instructions: '   ' });
    expect(blank.ok).toBe(false);
    expect(blank.content).toBe('Укажите новые директивы (instructions).');

    const missing = await run('update_custom_directives', {});
    expect(missing.ok).toBe(false);
    expect(missing.content).toBe('Укажите новые директивы (instructions).');

    expect(await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG)).toBeNull();
  });

  it('стиль не указан — остаётся текущий (по умолчанию mentor)', async () => {
    const outcome = await run('update_custom_directives', { instructions: 'Говори по делу' });
    expect(outcome.ok).toBe(true);
    expect(outcome.data).toEqual({ slug: '07_custom_instructions', style: 'mentor' });

    const chapter = await getChapter(USER_A, CUSTOM_INSTRUCTIONS_SLUG);
    if (!chapter) throw new Error('глава директив не создана');
    expect(chapter.content).toBe('Говори по делу\n\nСтиль общения: mentor');
  });
});

// ---------------------------------------------------------------------------
// get_custom_directives
// ---------------------------------------------------------------------------

describe('get_custom_directives', () => {
  it('без главы печатает стандартные настройки', async () => {
    const outcome = await run('get_custom_directives', {});

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Персональных директив пока не задано. Действуют стандартные настройки заботливого когнитивного ментора (ADHD-friendly).',
    );
    expect(outcome.data).toEqual({ style: 'mentor', instructions: '' });
  });

  it('после апдейта печатает инструкции и стиль', async () => {
    await run('update_custom_directives', {
      instructions: 'Будь краток',
      persona_style: 'concise',
    });

    const outcome = await run('get_custom_directives', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '🎯 Текущие системные директивы (стиль: concise):\n«Будь краток»',
    );
    expect(outcome.data).toEqual({ style: 'concise', instructions: 'Будь краток' });
  });

  it('неизвестный стиль в контенте главы парсится как mentor', async () => {
    await createChapter(USER_A, {
      slug: CUSTOM_INSTRUCTIONS_SLUG,
      title: 'Персональные директивы',
      content: 'Будь добрым\n\nСтиль общения: pirate',
    });

    const outcome = await run('get_custom_directives', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '🎯 Текущие системные директивы (стиль: mentor):\n«Будь добрым»',
    );
    expect(outcome.data).toEqual({ style: 'mentor', instructions: 'Будь добрым' });
  });

  it('директивы другого пользователя не видны', async () => {
    await run('update_custom_directives', {
      instructions: 'Только для Б',
      persona_style: 'calm_partner',
    }, contextFor(USER_B));

    const outcome = await run('get_custom_directives', {}, contextFor(USER_A));
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Персональных директив пока не задано. Действуют стандартные настройки заботливого когнитивного ментора (ADHD-friendly).',
    );
    expect((outcome.data as DirectivesData).instructions).toBe('');
  });
});

// ---------------------------------------------------------------------------
// list_skills / read_skill / draft_skill
// ---------------------------------------------------------------------------

describe('list_skills, read_skill, draft_skill', () => {
  it('list_skills возвращает встроенные .md-скиллы и пользовательские скиллы SQLite', async () => {
    const spec = buildSkillSpec({
      key: 'custom-sql-skill',
      version: 1,
      originFailure: null,
      supersedes: null,
      body: '## When to Use\nКогда надо.\n\n## Procedure\n1. Шаг.\n\n## Pitfalls\n- Нет.\n\n## Verification\n- Проверка.',
    });
    await addItem(USER_A, { rawInput: 'test', category: 'skill', title: 'Custom SQL', spec });

    const outcome = await run('list_skills', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('inbox-triage');
    expect(outcome.content).toContain('custom-sql-skill');
    const data = outcome.data as {
      builtin_skills: Array<{ id: string }>;
      user_skills: Array<{ key: string; status: string }>;
    };
    expect(data.builtin_skills.some((s) => s.id === 'inbox-triage')).toBe(true);
    expect(data.user_skills.some((s) => s.key === 'custom-sql-skill' && s.status === 'pending')).toBe(true);
  });

  it('read_skill читает .md-скилл оверлея и SQLite-скилл (с инкрементом views)', async () => {
    const builtin = await run('read_skill', { name_or_id: 'inbox-triage' });
    expect(builtin.ok).toBe(true);
    expect(builtin.data).toMatchObject({ source: 'overlay', id: 'inbox-triage', status: 'active' });
    expect(builtin.content).toContain('get_inbox_digest');

    const spec = buildSkillSpec({
      key: 'my-proc',
      version: 1,
      originFailure: null,
      supersedes: null,
      body: '## When to Use\nВсегда.\n\n## Procedure\n1. Действуй.\n\n## Pitfalls\n- Не спеши.\n\n## Verification\n- Проверить list_tasks.',
    });
    const item = await addItem(USER_A, { rawInput: 'x', category: 'skill', title: 'My Proc', spec });

    const byId = await run('read_skill', { name_or_id: String(item.id) });
    expect(byId.ok).toBe(true);
    expect(byId.data).toMatchObject({ source: 'sqlite', id: item.id, name: 'my-proc' });
    expect(byId.content).toContain('Проверить list_tasks');
    expect((await skillUsage(USER_A, item.id)).views).toBe(1);

    const missing = await run('read_skill', { name_or_id: 'no-such-skill-xyz' });
    expect(missing.ok).toBe(false);
  });

  it('draft_skill всегда создаёт pending-черновик и никогда не активирует сам', async () => {
    const bad = await run('draft_skill', { key: 'x', title: 'X' });
    expect(bad.ok).toBe(false);

    const created = await run('draft_skill', {
      key: 'Weekly Review',
      title: 'Еженедельный разбор',
      when_to_use: 'Каждое воскресенье вечером',
      procedure: '1. Открыть задачи.\n2. Разобрать инбокс.',
      verification: 'Проверить list_tasks.',
    });
    expect(created.ok).toBe(true);
    const data = created.data as { skill_id: number; key: string; status: string; requires_approval: boolean };
    expect(data.key).toBe('weekly-review');
    expect(data.status).toBe('pending');
    expect(data.requires_approval).toBe(true);

    const row = await getItem(USER_A, data.skill_id);
    expect(row?.status).toBe('pending');
    expect(row?.category).toBe('skill');

    const updated = await run('draft_skill', {
      key: 'weekly-review',
      title: 'Еженедельный разбор v2',
      when_to_use: 'В воскресенье в 19:00',
      procedure: '1. Проверить долги.\n2. Открыть задачи.',
      verification: 'Проверить list_tasks и get_finances.',
    });
    expect(updated.ok).toBe(true);
    const updatedData = updated.data as { skill_id: number; status: string };
    expect(updatedData.skill_id).toBe(data.skill_id);
    expect(updatedData.status).toBe('pending');
  });
});
