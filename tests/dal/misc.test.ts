/**
 * DAL `src/lib/dal/misc.ts` — служебный слой: kv, расход токенов, очередь
 * самоулучшений, граф знаний и корзина.
 *
 * Пять независимых секций в одном файле, поэтому и тесты сгруппированы по
 * секциям. Главные инварианты (SPEC §2.4):
 *  - `kv` — глобальная таблица, `user_id` у неё нет вообще;
 *  - всё остальное — юзерское, и юзер Б не видит и не правит данные юзера А;
 *  - корзина живёт на `deleted_at`, а не на отдельной таблице.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { monthKey } from '../../src/lib/utils';
import {
  TRASH_RETENTION_DAYS,
  addRelation,
  cleanupExpiredTrash,
  createEvolutionItem,
  daysRemaining,
  deleteEvolutionItem,
  deriveEvolutionTitle,
  emptyTrash,
  getEntity,
  getEvolutionItem,
  kvDelete,
  kvGet,
  kvGetJson,
  kvIncrement,
  kvSet,
  kvSetJson,
  linkMention,
  listEntities,
  listEntityRelationsBidirectional,
  listEvolutionItems,
  listMentions,
  listRelations,
  listTrash,
  monthUsage,
  normalizeEntityName,
  purgeTrashItem,
  recordUsage,
  restoreTrashItem,
  softDeleteNote,
  softDeleteTask,
  totalUsage,
  updateEvolutionItem,
  upsertEntity,
} from '../../src/lib/dal/misc';
import type { TrashItemType } from '../../src/lib/dal/misc';

const USER_A = 1;
const USER_B = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO-момент «N дней назад» — сроки корзины считаются от реального `Date.now()`. */
function isoAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

// ---------------------------------------------------------------------------
// kv — глобальные значения
// ---------------------------------------------------------------------------

describe('kv', () => {
  it('возвращает null для отсутствующего ключа и перезаписывает существующий', async () => {
    expect(await kvGet('schema_version')).toBeNull();

    const first = await kvSet('schema_version', '1');
    expect(first.key).toBe('schema_version');
    expect(first.value).toBe('1');
    expect(first.updatedAt).toBeTruthy();
    expect(await kvGet('schema_version')).toBe('1');

    const second = await kvSet('schema_version', '2');
    expect(second.value).toBe('2');
    expect(await kvGet('schema_version')).toBe('2');
  });

  it('держит ключи независимо друг от друга', async () => {
    await kvSet('a', '1');
    await kvSet('b', '2');
    expect(await kvGet('a')).toBe('1');
    expect(await kvGet('b')).toBe('2');
    expect(await kvDelete('a')).toBe(true);
    expect(await kvGet('a')).toBeNull();
    expect(await kvGet('b')).toBe('2');
  });

  it('сериализует json и отдаёт fallback на битом значении', async () => {
    expect(await kvGetJson('missing', { a: 1 })).toEqual({ a: 1 });

    await kvSetJson('flags', { beta: true, limit: 3 });
    expect(await kvGetJson('flags', { beta: false })).toEqual({ beta: true, limit: 3 });

    await kvSet('broken', '{не json');
    expect(await kvGetJson('broken', { fallback: true })).toEqual({ fallback: true });
  });

  it('удаляет ключ один раз', async () => {
    await kvSet('tmp', 'v');
    expect(await kvDelete('tmp')).toBe(true);
    expect(await kvDelete('tmp')).toBe(false);
    expect(await kvGet('tmp')).toBeNull();
  });

  it('даёт точную сумму при параллельных инкрементах', async () => {
    const key = 'failure_count:v1:1:stt|voice|transcription_failed|-';

    await Promise.all(Array.from({ length: 50 }, () => kvIncrement(key)));

    // Ни один инкремент не потерян: сложение делает SQLite, а не JS.
    expect(await kvGet(key)).toBe('50');
    expect(Number(await kvGet(key))).toBe(50);
  });

  it('инкрементирует с шагом и возвращает новое значение', async () => {
    expect(await kvIncrement('counter', 5)).toBe(5);
    expect(await kvIncrement('counter', 5)).toBe(10);
    expect(await kvIncrement('counter')).toBe(11);
    expect(await kvGet('counter')).toBe('11');

    await Promise.all([kvIncrement('counter'), kvIncrement('counter'), kvIncrement('counter')]);
    expect(await kvGet('counter')).toBe('14');
  });

  it('считает нечисловое значение нулём', async () => {
    await kvSet('json-ish', '{"a":1}');
    expect(await kvIncrement('json-ish')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// llm_usage — расход токенов
// ---------------------------------------------------------------------------

interface UsageFixture {
  id: number;
  userId?: number;
  createdAt: string;
  prompt?: number;
  completion?: number;
  cost?: number;
}

async function insertUsage(fixture: UsageFixture): Promise<void> {
  await db.run(sql`
    INSERT INTO llm_usage (
      id, user_id, model, prompt_tokens, completion_tokens, cost_micros, purpose, created_at
    ) VALUES (
      ${fixture.id}, ${fixture.userId ?? USER_A}, 'test-model',
      ${fixture.prompt ?? 0}, ${fixture.completion ?? 0}, ${fixture.cost ?? 0},
      NULL, ${fixture.createdAt}
    )
  `);
}

describe('llm_usage', () => {
  it('записывает вызов и обнуляет отрицательные значения', async () => {
    const row = await recordUsage(USER_A, {
      model: '  glm-4  ',
      promptTokens: -50,
      completionTokens: 12.9,
      costMicros: -1,
      purpose: 'agent',
    });

    expect(row.userId).toBe(USER_A);
    expect(row.model).toBe('glm-4');
    expect(row.promptTokens).toBe(0);
    expect(row.completionTokens).toBe(12);
    expect(row.costMicros).toBe(0);
    expect(row.purpose).toBe('agent');
    expect(row.createdAt).toBeTruthy();
  });

  it('подставляет нули для незаданных полей', async () => {
    const row = await recordUsage(USER_A, { model: 'glm-4' });
    expect(row.promptTokens).toBe(0);
    expect(row.completionTokens).toBe(0);
    expect(row.costMicros).toBe(0);
    expect(row.purpose).toBeNull();
  });

  it('требует модель', async () => {
    await expect(recordUsage(USER_A, { model: '   ' })).rejects.toThrow(/model is required/);
  });

  it('суммирует расход за месяц по ISO-границам', async () => {
    await insertUsage({ id: 1, createdAt: '2026-11-01T00:00:00.000Z', prompt: 10, completion: 5, cost: 100 });
    await insertUsage({ id: 2, createdAt: '2026-11-30T23:59:59.000Z', prompt: 20, completion: 7, cost: 200 });
    await insertUsage({ id: 3, createdAt: '2026-10-31T23:59:59.000Z', prompt: 1000, cost: 900 });
    await insertUsage({ id: 4, createdAt: '2026-12-01T00:00:00.000Z', prompt: 4000, cost: 500 });
    await insertUsage({ id: 5, createdAt: '2026-12-31T23:59:59.000Z', prompt: 40, cost: 60 });
    await insertUsage({ id: 6, userId: USER_B, createdAt: '2026-11-15T12:00:00.000Z', prompt: 777, cost: 999 });

    expect(await monthUsage(USER_A, '2026-11')).toEqual({
      promptTokens: 30,
      completionTokens: 12,
      costMicros: 300,
      calls: 2,
    });
    // декабрь закрывается границей 2027-01-01, а не концом года
    expect(await monthUsage(USER_A, '2026-12')).toEqual({
      promptTokens: 4040,
      completionTokens: 0,
      costMicros: 560,
      calls: 2,
    });
    expect(await monthUsage(USER_A, '2026-10')).toEqual({
      promptTokens: 1000,
      completionTokens: 0,
      costMicros: 900,
      calls: 1,
    });
    expect(await monthUsage(USER_A, '2026-09')).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      costMicros: 0,
      calls: 0,
    });
  });

  it('считает расход за всё время и не смешивает юзеров', async () => {
    await insertUsage({ id: 1, createdAt: '2026-11-01T00:00:00.000Z', prompt: 10, completion: 5, cost: 100 });
    await insertUsage({ id: 2, createdAt: '2026-11-30T23:59:59.000Z', prompt: 20, completion: 7, cost: 200 });
    await insertUsage({ id: 3, createdAt: '2026-10-31T23:59:59.000Z', prompt: 1000, cost: 900 });
    await insertUsage({ id: 4, createdAt: '2026-12-01T00:00:00.000Z', prompt: 4000, cost: 500 });
    await insertUsage({ id: 5, createdAt: '2026-12-31T23:59:59.000Z', prompt: 40, cost: 60 });
    await insertUsage({ id: 6, userId: USER_B, createdAt: '2026-11-15T12:00:00.000Z', prompt: 777, cost: 999 });

    expect(await totalUsage(USER_A)).toEqual({
      promptTokens: 5070,
      completionTokens: 12,
      costMicros: 1760,
      calls: 5,
    });
    expect(await totalUsage(USER_B)).toEqual({
      promptTokens: 777,
      completionTokens: 0,
      costMicros: 999,
      calls: 1,
    });
  });

  it('по умолчанию берёт текущий месяц', async () => {
    const current = monthKey();
    await insertUsage({ id: 1, createdAt: `${current}-15T12:00:00.000Z`, prompt: 5, cost: 7 });
    await insertUsage({ id: 2, createdAt: '2020-01-15T12:00:00.000Z', prompt: 100, cost: 100 });

    const byDefault = await monthUsage(USER_A);
    expect(byDefault).toEqual(await monthUsage(USER_A, current));
    expect(byDefault.calls).toBe(1);
    expect(byDefault.promptTokens).toBe(5);
  });

  it('падает на некорректном месяце', async () => {
    await expect(monthUsage(USER_A, '2026-13')).rejects.toThrow(/invalid month/);
  });
});

// ---------------------------------------------------------------------------
// evolution_items — очередь самоулучшений
// ---------------------------------------------------------------------------

describe('deriveEvolutionTitle', () => {
  it('берёт первую непустую строку', () => {
    expect(deriveEvolutionTitle('\n\n  Хочу автоучёт  \nдетали')).toBe('Хочу автоучёт');
    expect(deriveEvolutionTitle('   ')).toBe('Без названия');
  });

  it('режет заголовок до 80 символов', () => {
    const title = deriveEvolutionTitle(`${'а'.repeat(120)}\nвторая строка`);
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('evolution_items', () => {
  it('создаёт элемент со значениями по умолчанию', async () => {
    const item = await createEvolutionItem(USER_A, {
      rawInput: '  Хочу напоминания о лекарствах  ',
    });

    expect(item.userId).toBe(USER_A);
    expect(item.rawInput).toBe('Хочу напоминания о лекарствах');
    expect(item.title).toBe('Хочу напоминания о лекарствах');
    expect(item.category).toBe('feature');
    expect(item.status).toBe('pending');
    expect(item.priority).toBe('medium');
    expect(item.spec).toBeNull();
    expect(item.branchName).toBeNull();
    expect(item.commitHash).toBeNull();
    expect(item.createdAt).toBeTruthy();
  });

  it('уважает явный заголовок и категорию', async () => {
    const item = await createEvolutionItem(USER_A, {
      rawInput: 'многострочный ввод\nвторая строка',
      title: '  Своё имя  ',
      category: 'bug',
      priority: 'high',
    });

    expect(item.title).toBe('Своё имя');
    expect(item.category).toBe('bug');
    expect(item.priority).toBe('high');
  });

  it('требует непустой rawInput', async () => {
    await expect(createEvolutionItem(USER_A, { rawInput: '   ' })).rejects.toThrow(
      /rawInput is required/,
    );
  });

  it('обновляет частично: null очищает, undefined не трогает', async () => {
    const created = await createEvolutionItem(USER_A, { rawInput: 'Идея' });

    const updated = await updateEvolutionItem(USER_A, created.id, {
      spec: 'спека',
      status: 'in_progress',
      branchName: 'feat/idea',
      commitHash: 'abc123',
    });
    expect(updated?.spec).toBe('спека');
    expect(updated?.status).toBe('in_progress');
    expect(updated?.branchName).toBe('feat/idea');
    expect(updated?.commitHash).toBe('abc123');
    expect(updated?.title).toBe('Идея');
    expect(updated?.category).toBe('feature');

    const cleared = await updateEvolutionItem(USER_A, created.id, {
      spec: null,
      branchName: null,
    });
    expect(cleared?.spec).toBeNull();
    expect(cleared?.branchName).toBeNull();
    expect(cleared?.status).toBe('in_progress');
    expect(cleared?.commitHash).toBe('abc123');
  });

  it('не принимает пустой заголовок при обновлении', async () => {
    const created = await createEvolutionItem(USER_A, { rawInput: 'Идея' });
    await expect(updateEvolutionItem(USER_A, created.id, { title: '   ' })).rejects.toThrow(
      /title cannot be empty/,
    );
  });

  it('фильтрует список по статусу', async () => {
    const first = await createEvolutionItem(USER_A, { rawInput: 'Первая' });
    const second = await createEvolutionItem(USER_A, { rawInput: 'Вторая' });
    await updateEvolutionItem(USER_A, second.id, { status: 'shipped' });

    const shipped = await listEvolutionItems(USER_A, { status: 'shipped' });
    expect(shipped.map((item) => item.id)).toEqual([second.id]);

    const all = await listEvolutionItems(USER_A);
    expect(all).toHaveLength(2);
    expect(all.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('не отдаёт и не даёт править чужой элемент', async () => {
    const item = await createEvolutionItem(USER_A, { rawInput: 'Идея' });

    expect(await getEvolutionItem(USER_B, item.id)).toBeNull();
    expect(await updateEvolutionItem(USER_B, item.id, { status: 'shipped' })).toBeNull();
    expect(await deleteEvolutionItem(USER_B, item.id)).toBe(false);
    expect(await getEvolutionItem(USER_A, item.id)).not.toBeNull();
  });

  it('удаляет элемент', async () => {
    const item = await createEvolutionItem(USER_A, { rawInput: 'Идея' });
    expect(await deleteEvolutionItem(USER_A, item.id)).toBe(true);
    expect(await getEvolutionItem(USER_A, item.id)).toBeNull();
    expect(await deleteEvolutionItem(USER_A, item.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Граф знаний: entities
// ---------------------------------------------------------------------------

describe('normalizeEntityName', () => {
  it('обрезает пробелы и кавычки, схлопывает пробелы, меняет ё→е и понижает регистр', () => {
    expect(normalizeEntityName('  «Артём   Иванов»  ')).toBe('артем иванов');
    expect(normalizeEntityName('"\'Ёжик\t\nв   Тумане\'"')).toBe('ежик в тумане');
    expect(normalizeEntityName('  "  Tokio  " ')).toBe('tokio');
    expect(normalizeEntityName('   ')).toBe('');
  });
});

describe('граф знаний: entities', () => {
  it('создаёт сущность и матчит её без учёта регистра, не меняя kind', async () => {
    const created = await upsertEntity(USER_A, {
      name: '  Москва  ',
      kind: 'place',
      description: 'столица',
    });
    expect(created.name).toBe('Москва');
    expect(created.kind).toBe('place');
    expect(created.aliases).toEqual([]);
    expect(created.description).toBe('столица');
    expect(created.embedding).toBeNull();
    expect(created.createdAt).toBeTruthy();

    const again = await upsertEntity(USER_A, { name: 'москва', kind: 'project' });
    expect(again.id).toBe(created.id);
    expect(again.kind).toBe('place');
  });

  it('дописывает описание через точку с запятой и не дублирует его', async () => {
    const first = await upsertEntity(USER_A, {
      name: 'Москва',
      kind: 'place',
      description: 'столица',
    });
    const second = await upsertEntity(USER_A, { name: 'Москва', description: 'город' });
    expect(second.id).toBe(first.id);
    expect(second.description).toBe('столица; город');

    const third = await upsertEntity(USER_A, { name: 'Москва', description: 'город' });
    expect(third.id).toBe(first.id);
    expect(third.description).toBe('столица; город');
  });

  it('объединяет алиасы без учёта регистра', async () => {
    const first = await upsertEntity(USER_A, { name: 'Москва', aliases: ['Мск', 'Moscow'] });
    expect(first.aliases).toEqual(['Мск', 'Moscow']);

    const second = await upsertEntity(USER_A, {
      name: 'москва',
      aliases: ['мск', ' Moscow ', 'Столица'],
    });
    expect(second.id).toBe(first.id);
    expect(second.aliases).toEqual(['Мск', 'Moscow', 'Столица']);
  });

  it('сохраняет эмбеддинг, если он не передан, и перезаписывает непустым', async () => {
    const first = await upsertEntity(USER_A, { name: 'Вектор', embedding: [0.1, 0.2] });
    expect(first.embedding).toEqual([0.1, 0.2]);

    const second = await upsertEntity(USER_A, { name: 'Вектор' });
    expect(second.embedding).toEqual([0.1, 0.2]);

    const third = await upsertEntity(USER_A, { name: 'Вектор', embedding: [0.3] });
    expect(third.embedding).toEqual([0.3]);
  });

  it('держит сущности разных юзеров раздельно', async () => {
    const own = await upsertEntity(USER_A, { name: 'Общий', kind: 'project' });
    const foreign = await upsertEntity(USER_B, { name: 'Общий', kind: 'project' });

    expect(foreign.id).not.toBe(own.id);
    expect(await getEntity(USER_A, foreign.id)).toBeNull();
  });

  it('требует имя', async () => {
    await expect(upsertEntity(USER_A, { name: '   ' })).rejects.toThrow(/name is required/);
    await expect(upsertEntity(USER_A, { name: '«»' })).rejects.toThrow(/name is required/);
  });

  it('фильтрует список по виду', async () => {
    await upsertEntity(USER_A, { name: 'Анна', kind: 'person' });
    await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    await upsertEntity(USER_A, { name: 'Tokio', kind: 'project' });
    await upsertEntity(USER_B, { name: 'Борис', kind: 'person' });

    const people = await listEntities(USER_A, { kind: 'person' });
    expect(people.map((entity) => entity.name)).toEqual(['Анна']);

    const all = await listEntities(USER_A);
    expect(all).toHaveLength(3);
  });

  it('дедуплицирует по name и aliases (включая ё/е и регистр) и сливает алиасы без дублей', async () => {
    const first = await upsertEntity(USER_A, {
      name: 'Артём',
      kind: 'person',
      aliases: ['Тёма', 'Артемка'],
    });

    // Совпадение по существующему алиасу с ё→е и другим регистром
    const byAlias = await upsertEntity(USER_A, {
      name: 'тема',
      aliases: ['«АРТЁМ»', '  ТеМыЧ  ', 'темыч', 'артёмка'],
    });
    expect(byAlias.id).toBe(first.id);
    expect(byAlias.name).toBe('Артём');
    expect(byAlias.aliases).toEqual(['Тёма', 'Артемка', 'ТеМыЧ']);

    // Совпадение когда новое имя — другое, а один из входящих алиасов матчит existing.name
    const byIncomingAlias = await upsertEntity(USER_A, {
      name: 'Том',
      aliases: ['артем'],
    });
    expect(byIncomingAlias.id).toBe(first.id);
    expect(byIncomingAlias.aliases).toEqual(['Тёма', 'Артемка', 'ТеМыЧ', 'Том']);
  });

  it('повышает kind с other до конкретного и не перезаписывает уже конкретный kind', async () => {
    const created = await upsertEntity(USER_A, { name: 'Tokio', kind: 'other' });
    expect(created.kind).toBe('other');

    const upgraded = await upsertEntity(USER_A, { name: 'tokio', kind: 'project' });
    expect(upgraded.id).toBe(created.id);
    expect(upgraded.kind).toBe('project');

    const preservedOnOther = await upsertEntity(USER_A, { name: 'Tokio', kind: 'other' });
    expect(preservedOnOther.kind).toBe('project');

    const preservedOnDifferent = await upsertEntity(USER_A, { name: 'Tokio', kind: 'org' });
    expect(preservedOnDifferent.kind).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// Граф знаний: mentions
// ---------------------------------------------------------------------------

describe('граф знаний: mentions', () => {
  it('пишет контекст только при известном source_id и режет до 250 символов', async () => {
    const entity = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });

    const withSource = await linkMention(USER_A, {
      entityId: entity.id,
      sourceType: 'note',
      sourceId: 500,
      context: 'а'.repeat(300),
    });
    expect(withSource.userId).toBe(USER_A);
    expect(withSource.entityId).toBe(entity.id);
    expect(withSource.sourceId).toBe(500);
    expect(withSource.context).toHaveLength(250);
    expect(withSource.context?.endsWith('…')).toBe(true);
    expect(withSource.at).toBeTruthy();

    const withoutSource = await linkMention(USER_A, {
      entityId: entity.id,
      sourceType: 'message',
      context: 'короткий текст',
    });
    expect(withoutSource.sourceId).toBeNull();
    expect(withoutSource.context).toBeNull();
  });

  it('не даёт привязать упоминание к чужой сущности', async () => {
    const foreign = await upsertEntity(USER_B, { name: 'Чужая', kind: 'other' });
    await expect(
      linkMention(USER_A, { entityId: foreign.id, sourceType: 'note', sourceId: 1 }),
    ).rejects.toThrow(/not found for user/);
  });

  it('отдаёт упоминания сущности свежими сверху', async () => {
    const entity = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    const first = await linkMention(USER_A, {
      entityId: entity.id,
      sourceType: 'note',
      sourceId: 1,
      context: 'первое',
    });
    const second = await linkMention(USER_A, {
      entityId: entity.id,
      sourceType: 'note',
      sourceId: 2,
      context: 'второе',
    });

    const mentions = await listMentions(USER_A, entity.id);
    expect(mentions.map((mention) => mention.id)).toEqual([second.id, first.id]);
  });
});

// ---------------------------------------------------------------------------
// Граф знаний: relations
// ---------------------------------------------------------------------------

describe('граф знаний: relations', () => {
  it('создаёт связь один раз, не дублирует активную', async () => {
    const moscow = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    const russia = await upsertEntity(USER_A, { name: 'Россия', kind: 'place' });

    const relation = await addRelation(USER_A, {
      subjectId: moscow.id,
      predicate: 'столица',
      objectId: russia.id,
    });
    if (!relation) throw new Error('ожидалась связь');
    expect(relation.predicate).toBe('столица');
    expect(relation.validTo).toBeNull();
    expect(relation.validFrom).toBeTruthy();
    expect(relation.sourceId).toBeNull();

    const duplicate = await addRelation(USER_A, {
      subjectId: moscow.id,
      predicate: 'столица',
      objectId: russia.id,
    });
    expect(duplicate?.id).toBe(relation.id);
  });

  it('после закрытия активной связи создаёт новую', async () => {
    const moscow = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    const russia = await upsertEntity(USER_A, { name: 'Россия', kind: 'place' });

    const relation = await addRelation(USER_A, {
      subjectId: moscow.id,
      predicate: 'столица',
      objectId: russia.id,
    });
    if (!relation) throw new Error('ожидалась связь');

    await db.run(sql`UPDATE relations SET valid_to = ${isoAgo(1)} WHERE id = ${relation.id}`);

    const fresh = await addRelation(USER_A, {
      subjectId: moscow.id,
      predicate: 'столица',
      objectId: russia.id,
    });
    expect(fresh).not.toBeNull();
    expect(fresh?.id).not.toBe(relation.id);
  });

  it('не пишет связь сущности с самой собой', async () => {
    const moscow = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    expect(
      await addRelation(USER_A, { subjectId: moscow.id, predicate: 'рядом', objectId: moscow.id }),
    ).toBeNull();
  });

  it('требует предикат и обе сущности пользователя', async () => {
    const moscow = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    const foreign = await upsertEntity(USER_B, { name: 'Чужая', kind: 'other' });

    await expect(
      addRelation(USER_A, { subjectId: moscow.id, predicate: '   ', objectId: moscow.id + 1 }),
    ).rejects.toThrow(/predicate is required/);

    await expect(
      addRelation(USER_A, { subjectId: moscow.id, predicate: '«»', objectId: moscow.id + 1 }),
    ).rejects.toThrow(/predicate is required/);

    await expect(
      addRelation(USER_A, { subjectId: moscow.id, predicate: 'рядом', objectId: foreign.id }),
    ).rejects.toThrow(/not found for user/);
  });

  it('в списке связей только активные', async () => {
    const moscow = await upsertEntity(USER_A, { name: 'Москва', kind: 'place' });
    const russia = await upsertEntity(USER_A, { name: 'Россия', kind: 'place' });
    const petersburg = await upsertEntity(USER_A, { name: 'Петербург', kind: 'place' });

    const active = await addRelation(USER_A, {
      subjectId: moscow.id,
      predicate: 'столица',
      objectId: russia.id,
    });
    const closing = await addRelation(USER_A, {
      subjectId: petersburg.id,
      predicate: 'город',
      objectId: russia.id,
    });
    if (!active || !closing) throw new Error('ожидались связи');

    await db.run(sql`UPDATE relations SET valid_to = ${isoAgo(1)} WHERE id = ${closing.id}`);

    const relations = await listRelations(USER_A, moscow.id);
    expect(relations.map((relation) => relation.id)).toEqual([active.id]);
    expect(await listRelations(USER_A, petersburg.id)).toEqual([]);
  });

  it('закрывает прежнюю активную связь при смене объекта, но сохраняет идемпотентный дубль активным', async () => {
    const artem = await upsertEntity(USER_A, { name: 'Артём', kind: 'person' });
    const belgrade = await upsertEntity(USER_A, { name: 'Белград', kind: 'place' });
    const berlin = await upsertEntity(USER_A, { name: 'Берлин', kind: 'place' });

    const first = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живёт в',
      objectId: belgrade.id,
    });
    if (!first) throw new Error('ожидалась первая связь');

    // Смена объекта с тем же нормализованным предикатом (ё → е) закрывает старую связь
    const replacement = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живет в',
      objectId: berlin.id,
    });
    if (!replacement) throw new Error('ожидалась новая связь');
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.validTo).toBeNull();

    const oldRow = await db.get<{ valid_to: string | null }>(sql`
      SELECT valid_to FROM relations WHERE id = ${first.id}
    `);
    expect(oldRow?.valid_to).toBeTruthy();
    expect(Number.isNaN(Date.parse(oldRow?.valid_to ?? ''))).toBe(false);

    // Идемпотентный дубль оставляет текущую связь активной без закрытия и дублирования
    const idempotent = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живёт в',
      objectId: berlin.id,
    });
    expect(idempotent?.id).toBe(replacement.id);
    expect(idempotent?.validTo).toBeNull();

    const active = await listRelations(USER_A, artem.id);
    expect(active.map((row) => row.id)).toEqual([replacement.id]);
  });

  it('уважает replaceExistingPredicate: false и держит несколько активных объектов', async () => {
    const artem = await upsertEntity(USER_A, { name: 'Артём', kind: 'person' });
    const acme = await upsertEntity(USER_A, { name: 'Acme', kind: 'org' });
    const beta = await upsertEntity(USER_A, { name: 'Beta', kind: 'org' });

    const first = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'работает в',
      objectId: acme.id,
    });
    const second = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'работает в',
      objectId: beta.id,
      replaceExistingPredicate: false,
    });
    if (!first || !second) throw new Error('ожидались обе связи');

    const active = await listRelations(USER_A, artem.id);
    expect(active.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [first.id, second.id].sort((a, b) => a - b),
    );
    expect(active.every((row) => row.validTo === null)).toBe(true);
  });

  it('listEntityRelationsBidirectional возвращает исходящие и входящие активные связи, исключая закрытые', async () => {
    const alice = await upsertEntity(USER_A, { name: 'Алиса', kind: 'person' });
    const bob = await upsertEntity(USER_A, { name: 'Борис', kind: 'person' });
    const acme = await upsertEntity(USER_A, { name: 'Acme', kind: 'org' });
    const oldCity = await upsertEntity(USER_A, { name: 'Омск', kind: 'place' });
    const newCity = await upsertEntity(USER_A, { name: 'Сочи', kind: 'place' });

    const outgoing = await addRelation(USER_A, {
      subjectId: alice.id,
      predicate: 'работает в',
      objectId: acme.id,
    });
    const incoming = await addRelation(USER_A, {
      subjectId: bob.id,
      predicate: 'наставник',
      objectId: alice.id,
    });
    const closed = await addRelation(USER_A, {
      subjectId: alice.id,
      predicate: 'жил в',
      objectId: oldCity.id,
    });
    const currentCity = await addRelation(USER_A, {
      subjectId: alice.id,
      predicate: 'жил в',
      objectId: newCity.id,
    });
    if (!outgoing || !incoming || !closed || !currentCity) {
      throw new Error('ожидались тестовые связи');
    }

    const bidirectional = await listEntityRelationsBidirectional(USER_A, alice.id);
    expect(bidirectional.map((row) => row.id)).toEqual([outgoing.id, incoming.id, currentCity.id]);
    expect(bidirectional.map((row) => row.id)).not.toContain(closed.id);
    expect(await listEntityRelationsBidirectional(USER_B, alice.id)).toEqual([]);
  });

  it('историческая связь (validTo != null) не закрывает текущую активную связь и не возвращает её вместо вставки', async () => {
    const artem = await upsertEntity(USER_A, { name: 'Артём', kind: 'person' });
    const berlin = await upsertEntity(USER_A, { name: 'Берлин', kind: 'place' });
    const belgrade = await upsertEntity(USER_A, { name: 'Белград', kind: 'place' });

    const active = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живёт в',
      objectId: berlin.id,
    });
    if (!active) throw new Error('ожидалась активная связь');

    const historicalDiffObject = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живёт в',
      objectId: belgrade.id,
      validFrom: '2020-01-01T00:00:00.000Z',
      validTo: '2022-01-01T00:00:00.000Z',
    });
    const historicalSameObject = await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живёт в',
      objectId: berlin.id,
      validFrom: '2018-01-01T00:00:00.000Z',
      validTo: '2019-01-01T00:00:00.000Z',
    });

    expect(historicalDiffObject?.id).not.toBe(active.id);
    expect(historicalDiffObject?.validTo).toBe('2022-01-01T00:00:00.000Z');
    expect(historicalSameObject?.id).not.toBe(active.id);
    expect(historicalSameObject?.validTo).toBe('2019-01-01T00:00:00.000Z');

    const stillActive = await listRelations(USER_A, artem.id);
    expect(stillActive.map((row) => row.id)).toEqual([active.id]);
    expect(stillActive[0]?.validTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Корзина — фикстуры
// ---------------------------------------------------------------------------

interface TaskFixture {
  id: number;
  title: string;
  userId?: number;
  parentId?: number | null;
  categoryId?: number | null;
  notes?: string | null;
  deletedAt?: string | null;
  createdAt?: string | null;
}

async function insertTask(fixture: TaskFixture): Promise<void> {
  await db.run(sql`
    INSERT INTO tasks (
      id, user_id, category_id, parent_id, title, notes, status, position,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${fixture.id}, ${fixture.userId ?? USER_A}, ${fixture.categoryId ?? null},
      ${fixture.parentId ?? null}, ${fixture.title}, ${fixture.notes ?? null}, 'todo', 0,
      ${fixture.createdAt ?? isoAgo(5)}, ${isoAgo(5)}, ${fixture.deletedAt ?? null}
    )
  `);
}

interface NoteFixture {
  id: number;
  rawText: string;
  userId?: number;
  cleanText?: string | null;
  column?: string;
  deletedAt?: string | null;
  createdAt?: string | null;
}

async function insertNote(fixture: NoteFixture): Promise<void> {
  await db.run(sql`
    INSERT INTO notes (
      id, user_id, raw_text, clean_text, "column", source_type, metadata, created_at, deleted_at
    ) VALUES (
      ${fixture.id}, ${fixture.userId ?? USER_A}, ${fixture.rawText},
      ${fixture.cleanText ?? null}, ${fixture.column ?? 'raw'}, 'text', '{}',
      ${fixture.createdAt ?? isoAgo(5)}, ${fixture.deletedAt ?? null}
    )
  `);
}

async function insertCategory(id: number, userId: number, name: string): Promise<void> {
  await db.run(sql`
    INSERT INTO task_categories (id, user_id, name, position, created_at)
    VALUES (${id}, ${userId}, ${name}, 0, ${isoAgo(30)})
  `);
}

describe('корзина', () => {
  beforeEach(async () => {
    await insertCategory(5, USER_A, 'Работа');

    // удалённая задача с двумя шагами и категорией
    await insertTask({
      id: 12,
      title: 'Собрать отчёт',
      categoryId: 5,
      notes: 'черновик',
      deletedAt: isoAgo(5),
      createdAt: isoAgo(9),
    });
    await insertTask({ id: 14, title: 'Шаг 1', parentId: 12, deletedAt: isoAgo(5) });
    await insertTask({ id: 15, title: 'Шаг 2', parentId: 12, deletedAt: isoAgo(5) });

    // удалённая задача без категории и без шагов
    await insertTask({ id: 10, title: 'Позвонить в клинику', deletedAt: isoAgo(2) });

    // живые задачи
    await insertTask({ id: 11, title: 'Активная задача' });
    await insertTask({ id: 20, title: 'Активная с шагами' });
    await insertTask({ id: 21, title: 'Шаг активной', parentId: 20 });

    // чужое
    await insertTask({ id: 40, userId: USER_B, title: 'Чужая удалённая', deletedAt: isoAgo(3) });

    // заметки
    await insertNote({
      id: 30,
      rawText: 'Заметка в корзине',
      deletedAt: isoAgo(3),
      createdAt: isoAgo(4),
    });
    await insertNote({ id: 31, rawText: 'Живая заметка', createdAt: isoAgo(1) });
    await insertNote({ id: 32, userId: USER_B, rawText: 'Чужая заметка', deletedAt: isoAgo(1) });
  });

  it('показывает только задачи верхнего уровня и заметки пользователя', async () => {
    const trash = await listTrash(USER_A);

    expect(trash.tasks.map((task) => task.id)).toEqual([10, 12]);
    expect(trash.notes.map((note) => note.id)).toEqual([30]);
    expect(trash.totalCount).toBe(3);

    const withCategory = trash.tasks.find((task) => task.id === 12);
    expect(withCategory?.categoryName).toBe('Работа');
    expect(withCategory?.categoryId).toBe(5);
    expect(withCategory?.notes).toBe('черновик');
    expect(withCategory?.stepsCount).toBe(2);
    expect(withCategory?.kind).toBe('task');
    expect(withCategory?.daysRemaining).toBe(25);

    const withoutCategory = trash.tasks.find((task) => task.id === 10);
    expect(withoutCategory?.categoryName).toBe('Быт');
    expect(withoutCategory?.categoryId).toBeNull();
    expect(withoutCategory?.stepsCount).toBe(0);
    expect(withoutCategory?.daysRemaining).toBe(28);

    const note = trash.notes[0];
    expect(note.kind).toBe('note');
    expect(note.rawText).toBe('Заметка в корзине');
    expect(note.cleanText).toBeNull();
    expect(note.column).toBe('raw');
    expect(note.daysRemaining).toBe(27);
  });

  it('удаляет в корзину задачу вместе с шагами', async () => {
    expect(await softDeleteTask(USER_A, 20)).toBe(true);

    const rows = await db.all<{ id: number; deleted_at: string | null }>(sql`
      SELECT id, deleted_at FROM tasks WHERE id IN (20, 21) ORDER BY id
    `);
    expect(rows.map((row) => row.deleted_at !== null)).toEqual([true, true]);

    const trash = await listTrash(USER_A);
    expect(trash.tasks.map((task) => task.id)).toEqual([20, 10, 12]);
    expect(trash.tasks.find((task) => task.id === 20)?.stepsCount).toBe(1);

    // повторное удаление ничего не делает
    expect(await softDeleteTask(USER_A, 20)).toBe(false);
    // чужая задача не удаляется
    expect(await softDeleteTask(USER_B, 10)).toBe(false);
  });

  it('удаляет заметку в корзину один раз', async () => {
    expect(await softDeleteNote(USER_A, 31)).toBe(true);
    expect(await softDeleteNote(USER_A, 31)).toBe(false);
    expect(await softDeleteNote(USER_B, 31)).toBe(false);

    const trash = await listTrash(USER_A);
    expect(trash.notes.map((note) => note.id)).toEqual([31, 30]);
  });

  it('восстанавливает задачу вместе с шагами', async () => {
    expect(await restoreTrashItem(USER_A, 'task', 12)).toBe(true);

    const rows = await db.all<{ id: number; deleted_at: string | null }>(sql`
      SELECT id, deleted_at FROM tasks WHERE id IN (12, 14, 15) ORDER BY id
    `);
    expect(rows.map((row) => row.deleted_at)).toEqual([null, null, null]);

    const trash = await listTrash(USER_A);
    expect(trash.tasks.map((task) => task.id)).toEqual([10]);
    expect(await restoreTrashItem(USER_A, 'task', 12)).toBe(false);
    expect(await restoreTrashItem(USER_B, 'task', 10)).toBe(false);
  });

  it('восстанавливает заметку', async () => {
    expect(await restoreTrashItem(USER_A, 'note', 30)).toBe(true);
    expect(await restoreTrashItem(USER_A, 'note', 30)).toBe(false);

    const trash = await listTrash(USER_A);
    expect(trash.notes).toEqual([]);
    expect(trash.totalCount).toBe(2);
  });

  it('окончательно удаляет задачу с шагами только из корзины', async () => {
    expect(await purgeTrashItem(USER_A, 'task', 11)).toBe(false);
    expect(await purgeTrashItem(USER_A, 'task', 12)).toBe(true);

    const rows = await db.all<{ id: number }>(sql`
      SELECT id FROM tasks WHERE id IN (12, 14, 15)
    `);
    expect(rows).toEqual([]);
    expect(await purgeTrashItem(USER_A, 'task', 12)).toBe(false);
  });

  it('окончательно удаляет заметку только из корзины', async () => {
    expect(await purgeTrashItem(USER_A, 'note', 31)).toBe(false);
    expect(await purgeTrashItem(USER_A, 'note', 30)).toBe(true);

    const rows = await db.all<{ id: number }>(sql`SELECT id FROM notes WHERE id = 30`);
    expect(rows).toEqual([]);
    expect(await purgeTrashItem(USER_B, 'note', 32)).toBe(true);
  });

  it('падает на неизвестном типе элемента', async () => {
    await expect(
      restoreTrashItem(USER_A, 'bogus' as TrashItemType, 10),
    ).rejects.toThrow(/unknown item type/);
    await expect(purgeTrashItem(USER_A, 'bogus' as TrashItemType, 10)).rejects.toThrow(
      /unknown item type/,
    );
  });

  it('опустошает корзину пользователя целиком', async () => {
    const result = await emptyTrash(USER_A);

    expect(result.tasksPurged).toBe(4); // 10, 12, 14, 15
    expect(result.notesPurged).toBe(1); // 30

    const trash = await listTrash(USER_A);
    expect(trash.totalCount).toBe(0);

    // чужое не тронуто
    const remaining = await db.all<{ id: number }>(sql`
      SELECT id FROM tasks WHERE user_id = ${USER_B}
    `);
    expect(remaining.map((row) => row.id)).toEqual([40]);
  });

  it('вычищает только просроченное', async () => {
    await insertTask({ id: 16, title: 'Старая удалённая', deletedAt: isoAgo(40) });
    await insertNote({ id: 33, rawText: 'Старая заметка', deletedAt: isoAgo(40) });
    await insertNote({ id: 34, rawText: 'Свежая заметка', deletedAt: isoAgo(10) });

    const result = await cleanupExpiredTrash();
    expect(result.tasksPurged).toBe(1);
    expect(result.notesPurged).toBe(1);

    const taskIds = await db.all<{ id: number }>(sql`SELECT id FROM tasks ORDER BY id`);
    expect(taskIds.map((row) => row.id)).not.toContain(16);

    const noteIds = await db.all<{ id: number }>(sql`SELECT id FROM notes ORDER BY id`);
    expect(noteIds.map((row) => row.id)).toEqual([30, 31, 32, 34]);
  });
});

describe('daysRemaining', () => {
  it('считает остаток срока хранения', () => {
    expect(daysRemaining(null)).toBe(TRASH_RETENTION_DAYS);
    expect(daysRemaining(undefined)).toBe(TRASH_RETENTION_DAYS);
    expect(daysRemaining('не дата')).toBe(TRASH_RETENTION_DAYS);
    expect(daysRemaining(isoAgo(0))).toBe(TRASH_RETENTION_DAYS);
    expect(daysRemaining(isoAgo(10))).toBe(20);
    expect(daysRemaining(isoAgo(40))).toBe(0);
  });

  it('уважает свой срок хранения', () => {
    expect(daysRemaining(isoAgo(3), 7)).toBe(4);
    expect(daysRemaining(isoAgo(1), 0)).toBe(0);
  });
});
