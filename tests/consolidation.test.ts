/**
 * `src/lib/consolidation.ts` — ночная консолидация заметок и её планировщик.
 *
 * Проверяем контракт, который легко сломать незаметно:
 *  1) идемпотентность: повторный прогон за ту же локальную дату ничего не делает
 *     (маркер в `kv`), `force` снимает запрет;
 *  2) ошибка модели не ставит маркер — следующий прогон повторяет работу;
 *  3) ответ модели: алиасы колонок upstream (`self`, `possible_tasks`, `archive`)
 *     приводятся к колонкам порта, дубликаты уезжают в `trash` с префиксом;
 *  4) работа идёт шагом `due_jobs` (`registerConsolidationHandler`), после
 *     успеха ставится следующая ночь, ошибка помечает задачу `failed`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { createNote, getNote } from '../src/lib/dal/notes';
import {
  getPendingJob,
  listPendingJobs,
  runDueJobs,
  schedule,
  unregisterJobHandler,
} from '../src/lib/dal/due_jobs';
import { kvGet, listEntities, listMentions, listRelations } from '../src/lib/dal/misc';
import { listFailureAggregates } from '../src/lib/evolution';
import {
  DEFAULT_NOTE_LIMIT,
  DUPLICATE_PREFIX,
  NIGHTLY_HOUR,
  consolidationMarkerKey,
  hasConsolidationChat,
  nextNightlyAt,
  normalizeColumn,
  parseConsolidationResponse,
  registerConsolidationHandler,
  runNightlyConsolidation,
  scheduleNightlyConsolidation,
  setConsolidationChat,
} from '../src/lib/consolidation';
import type { ConsolidationChatRequest } from '../src/lib/consolidation';

const USER = 401;
const OTHER_USER = 402;
const NOW = new Date('2026-03-10T22:00:00.000Z');
const DAY = '2026-03-10';

let calls: ConsolidationChatRequest[] = [];

/** Подключает модель-заглушку и запоминает запросы к ней. */
function useChat(handler: (request: ConsolidationChatRequest) => string | Promise<string>): void {
  setConsolidationChat(async (request) => {
    calls.push(request);
    return handler(request);
  });
}

/** Ответ «разобрать все присланные заметки в одну колонку». */
function respondAll(column = 'note'): (request: ConsolidationChatRequest) => string {
  return (request) => {
    const notes = JSON.parse(request.userPrompt) as Array<{ id: string; raw_text: string }>;
    return JSON.stringify({
      processed_notes: notes.map((note) => ({
        id: note.id,
        clean_text: `Чисто: ${note.raw_text}`,
        column,
        is_duplicate_of_id: null,
      })),
    });
  };
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  calls = [];
});

afterEach(() => {
  setConsolidationChat(null);
  unregisterJobHandler('nightly_consolidation');
});

describe('прогон консолидации', () => {
  it('чистит текст и раскладывает заметки по колонкам', async () => {
    const first = await createNote(USER, 'купить хлеб срочно');
    const second = await createNote(USER, 'позвонить маме');

    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: String(first.id), clean_text: 'Купить хлеб', column: 'possible_tasks' },
          { id: String(second.id), clean_text: 'Позвонить маме', column: 'self' },
        ],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    expect(result.status).toBe('success');
    expect(result.dateKey).toBe(DAY);
    expect(result.processedCount).toBe(2);
    expect(result.noteIds.sort((a, b) => a - b)).toEqual([first.id, second.id].sort((a, b) => a - b));

    const updatedFirst = await getNote(USER, first.id);
    const updatedSecond = await getNote(USER, second.id);
    expect(updatedFirst?.cleanText).toBe('Купить хлеб');
    expect(updatedFirst?.column).toBe('todo');
    expect(updatedSecond?.cleanText).toBe('Позвонить маме');
    expect(updatedSecond?.column).toBe('note');
  });

  it('зовёт модель с пометкой биллинга и JSON-режимом', async () => {
    await createNote(USER, 'заметка');
    useChat(respondAll());

    await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe('consolidation');
    expect(calls[0].responseFormat).toBe('json_object');
    expect(calls[0].temperature).toBeGreaterThan(0);
    expect(calls[0].userId).toBe(USER);
    expect(calls[0].userPrompt).toContain('заметка');
  });

  it('повторный прогон за ту же дату — skipped без обращения к модели', async () => {
    await createNote(USER, 'заметка');
    useChat(respondAll());

    await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    const second = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    expect(second.status).toBe('skipped');
    expect(second.processedCount).toBe(0);
    expect(second.dateKey).toBe(DAY);
    expect(calls).toHaveLength(1);
  });

  it('маркер идемпотентности лежит в kv по ключу user+day', async () => {
    await createNote(USER, 'заметка');
    useChat(respondAll());

    await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    const marker = await kvGet(consolidationMarkerKey(USER, DAY));
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker as string)).toMatchObject({ dateKey: DAY, processedCount: 1 });
  });

  it('force прогоняет заново за ту же дату (берёт только новые raw-заметки)', async () => {
    await createNote(USER, 'первая');
    useChat(respondAll());
    await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    const late = await createNote(USER, 'поздняя');

    const skipped = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(skipped.status).toBe('skipped');

    const forced = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC', force: true });
    expect(forced.status).toBe('success');
    expect(forced.noteIds).toEqual([late.id]);
    expect(calls).toHaveLength(2);
    expect((await getNote(USER, late.id))?.column).toBe('note');
  });

  it('нет заметок — skipped и маркер (второй прогон тоже skipped)', async () => {
    useChat(respondAll());

    const first = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    const second = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    expect(first.status).toBe('skipped');
    expect(first.message).toContain('Нет новых заметок');
    expect(second.status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('ошибка модели — status error, маркера нет, следующий прогон повторяет', async () => {
    await createNote(USER, 'заметка');
    useChat(() => {
      throw new Error('model unavailable');
    });

    const failed = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(failed.status).toBe('error');
    expect(failed.message).toContain('model unavailable');
    expect(await kvGet(consolidationMarkerKey(USER, DAY))).toBeNull();

    // MU-3B: ночной отказ виден не только в ответе, которого никто не видел.
    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate).toMatchObject({
      signature: 'consolidation|none|consolidation_failed|-',
      count: 1,
    });
    expect(aggregate?.detail).toContain('model unavailable');

    useChat(respondAll('todo'));
    const retried = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(retried.status).toBe('success');
    expect(retried.processedCount).toBe(1);
  });

  it('битый ответ модели — успешный прогон без изменений (день закрыт)', async () => {
    await createNote(USER, 'заметка');
    useChat(() => '<не json>');

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(result.status).toBe('success');
    expect(result.processedCount).toBe(0);
    expect((await getNote(USER, (await listRawIds())[0]))?.column).toBe('raw');
    expect(await kvGet(consolidationMarkerKey(USER, DAY))).not.toBeNull();
  });

  it('единственная заметка: любой id из ответа применяется к ней', async () => {
    const note = await createNote(USER, 'одинокая заметка');
    useChat(() =>
      JSON.stringify({
        processed_notes: [{ id: 'no-such-id', clean_text: 'Одинокая заметка', column: 'idea' }],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(result.noteIds).toEqual([note.id]);
    expect((await getNote(USER, note.id))?.column).toBe('idea');
  });

  it('id вне выборки при нескольких заметках игнорируется', async () => {
    const first = await createNote(USER, 'первая заметка');
    await createNote(USER, 'вторая заметка');
    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: '999', clean_text: 'Чужая', column: 'note' },
          { id: String(first.id), clean_text: 'Первая', column: 'idea' },
        ],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(result.noteIds).toEqual([first.id]);
  });

  it('лимит прогона: берутся самые старые заметки', async () => {
    const oldest = await createNote(USER, 'самая старая');
    const middle = await createNote(USER, 'средняя');
    const newest = await createNote(USER, 'самая новая');
    await setCreatedAt(oldest.id, '2026-03-08T10:00:00.000Z');
    await setCreatedAt(middle.id, '2026-03-09T10:00:00.000Z');
    await setCreatedAt(newest.id, '2026-03-10T10:00:00.000Z');

    useChat(respondAll('todo'));
    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC', limit: 2 });

    expect(result.noteIds.sort((a, b) => a - b)).toEqual([oldest.id, middle.id].sort((a, b) => a - b));
    expect((await getNote(USER, newest.id))?.column).toBe('raw');
  });

  it('дефолтный лимит — 30 заметок', () => {
    expect(DEFAULT_NOTE_LIMIT).toBe(30);
  });

  it('не трогает заметки другого пользователя', async () => {
    const mine = await createNote(USER, 'моя');
    const foreign = await createNote(OTHER_USER, 'чужая');
    useChat(respondAll());

    await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    expect((await getNote(USER, mine.id))?.column).toBe('note');
    expect((await getNote(OTHER_USER, foreign.id))?.column).toBe('raw');
  });

  it('локальная дата берётся из таймзоны: разные дни — разные маркеры', async () => {
    const note = await createNote(USER, 'заметка');
    useChat(respondAll());

    const ny = await runNightlyConsolidation(USER, {
      now: new Date('2026-01-02T02:30:00.000Z'),
      timeZone: 'America/New_York',
    });
    expect(ny.dateKey).toBe('2026-01-01');
    expect(note.id).toBeGreaterThan(0);

    const utc = await runNightlyConsolidation(USER, {
      now: new Date('2026-01-02T02:30:00.000Z'),
      timeZone: 'UTC',
    });
    expect(utc.dateKey).toBe('2026-01-02');
    expect(utc.status).toBe('skipped'); // raw-заметок уже нет
    expect(await kvGet(consolidationMarkerKey(USER, '2026-01-01'))).not.toBeNull();
  });

  it('сохраняет entities, mentions (привязанные к noteId) и relations из ответа консолидации', async () => {
    const first = await createNote(USER, 'Артём работает в Acme');
    const second = await createNote(USER, 'Артём ведёт проект Tokio');

    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: String(first.id), clean_text: 'Артём работает в Acme', column: 'note' },
          { id: String(second.id), clean_text: 'Артём ведёт проект Tokio', column: 'idea' },
        ],
        entities: [
          {
            name: 'Артём',
            kind: 'person',
            aliases: ['Тёма'],
            description: 'Разработчик',
            source_note_id: first.id,
          },
          {
            name: 'Acme',
            kind: 'org',
            aliases: [],
            description: 'Компания',
            source_note_id: first.id,
          },
          {
            name: 'Tokio',
            kind: 'project',
            source_note_id: second.id,
          },
        ],
        relations: [
          {
            subject: 'Артём',
            predicate: 'работает в',
            object: 'Acme',
            source_note_id: first.id,
          },
          {
            subject: 'Артём',
            predicate: 'ведёт',
            object: 'Tokio',
            source_note_id: second.id,
          },
        ],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });

    expect(result.status).toBe('success');
    expect(result.processedCount).toBe(2);
    expect(result.entitiesUpserted).toBe(3);
    expect(result.relationsAdded).toBe(2);

    const entities = await listEntities(USER);
    expect(entities.map((e) => e.name).sort()).toEqual(['Acme', 'Tokio', 'Артём'].sort());

    const artem = entities.find((e) => e.name === 'Артём');
    const acme = entities.find((e) => e.name === 'Acme');
    const tokio = entities.find((e) => e.name === 'Tokio');
    if (!artem || !acme || !tokio) throw new Error('ожидались все 3 сущности');

    expect(artem).toMatchObject({ kind: 'person', aliases: ['Тёма'], description: 'Разработчик' });
    expect(acme).toMatchObject({ kind: 'org', description: 'Компания' });
    expect(tokio).toMatchObject({ kind: 'project' });

    const artemMentions = await listMentions(USER, artem.id);
    const acmeMentions = await listMentions(USER, acme.id);
    const tokioMentions = await listMentions(USER, tokio.id);
    expect(artemMentions).toHaveLength(1);
    expect(artemMentions[0]).toMatchObject({ sourceType: 'note', sourceId: first.id });
    expect(acmeMentions).toHaveLength(1);
    expect(acmeMentions[0]).toMatchObject({ sourceType: 'note', sourceId: first.id });
    expect(tokioMentions).toHaveLength(1);
    expect(tokioMentions[0]).toMatchObject({ sourceType: 'note', sourceId: second.id });

    const relations = await listRelations(USER, artem.id);
    expect(relations).toHaveLength(2);
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectId: artem.id,
          predicate: 'работает в',
          objectId: acme.id,
          sourceId: first.id,
          validTo: null,
        }),
        expect.objectContaining({
          subjectId: artem.id,
          predicate: 'ведёт',
          objectId: tokio.id,
          sourceId: second.id,
          validTo: null,
        }),
      ]),
    );
  });

  it('обратная совместимость: processed_notes без графа и голый массив возвращают 0/0 по сущностям и связям', async () => {
    const first = await createNote(USER, 'простая заметка');

    useChat(() =>
      JSON.stringify({
        processed_notes: [{ id: String(first.id), clean_text: 'Простая заметка', column: 'note' }],
      }),
    );

    const objResult = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(objResult.status).toBe('success');
    expect(objResult.processedCount).toBe(1);
    expect(objResult.entitiesUpserted).toBe(0);
    expect(objResult.relationsAdded).toBe(0);
    expect(await listEntities(USER)).toEqual([]);

    const second = await createNote(USER, 'мысль массивом');
    useChat(() =>
      JSON.stringify([{ id: String(second.id), clean_text: 'Мысль массивом', column: 'idea' }]),
    );

    const arrResult = await runNightlyConsolidation(USER, {
      now: NOW,
      timeZone: 'UTC',
      force: true,
    });
    expect(arrResult.status).toBe('success');
    expect(arrResult.processedCount).toBe(1);
    expect(arrResult.entitiesUpserted).toBe(0);
    expect(arrResult.relationsAdded).toBe(0);
    expect((await getNote(USER, second.id))?.column).toBe('idea');
    expect(await listEntities(USER)).toEqual([]);
  });

  it('устойчив к битым KG-записям: не-массив entities, невалидный kind → other, self-loop и чужой source_note_id', async () => {
    const note = await createNote(USER, 'тестовая заметка для KG');

    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: String(note.id), clean_text: 'Тестовая заметка для KG', column: 'note' },
        ],
        entities: 'bad',
        relations: [{ subject: 'Артём', predicate: 'знает', object: 'Артём', source_note_id: 999999 }],
      }),
    );

    const badEntitiesResult = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(badEntitiesResult.status).toBe('success');
    expect(badEntitiesResult.processedCount).toBe(1);
    expect(badEntitiesResult.entitiesUpserted).toBe(0);
    expect(badEntitiesResult.relationsAdded).toBe(0);
    expect(await listEntities(USER)).toEqual([]);

    const note2 = await createNote(USER, 'вторая заметка для KG');
    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: String(note2.id), clean_text: 'Вторая заметка для KG', column: 'note' },
        ],
        entities: [
          { name: 'Мария', kind: 'alien_kind', source_note_id: 999999 },
          { name: 'Acme', kind: 'org', source_note_id: note2.id },
        ],
        relations: [
          { subject: 'Мария', predicate: 'помогает', object: 'Мария', source_note_id: note2.id },
          { subject: 'Мария', predicate: 'работает в', object: 'Acme', source_note_id: 999999 },
        ],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC', force: true });
    expect(result.status).toBe('success');
    expect(result.entitiesUpserted).toBe(2);
    expect(result.relationsAdded).toBe(1);

    const entities = await listEntities(USER);
    const maria = entities.find((e) => e.name === 'Мария');
    const acme = entities.find((e) => e.name === 'Acme');
    if (!maria || !acme) throw new Error('ожидались сущности Мария и Acme');

    expect(maria.kind).toBe('other');
    expect(await listMentions(USER, maria.id)).toEqual([]);
    expect(await listMentions(USER, acme.id)).toHaveLength(1);

    const rels = await listRelations(USER, maria.id);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      subjectId: maria.id,
      predicate: 'работает в',
      objectId: acme.id,
      sourceId: null,
    });
  });
});

describe('дубликаты и колонки', () => {
  it('нормализует алиасы колонок upstream в колонки порта', () => {
    expect(normalizeColumn('idea')).toBe('idea');
    expect(normalizeColumn('IDEAS')).toBe('idea');
    expect(normalizeColumn('note')).toBe('note');
    expect(normalizeColumn('self')).toBe('note');
    expect(normalizeColumn('useful')).toBe('note');
    expect(normalizeColumn('todo')).toBe('todo');
    expect(normalizeColumn('possible_tasks')).toBe('todo');
    expect(normalizeColumn('Task')).toBe('todo');
    expect(normalizeColumn('archive')).toBe('trash');
    expect(normalizeColumn('trash')).toBe('trash');
    expect(normalizeColumn('unknown')).toBe('idea');
    expect(normalizeColumn(42)).toBe('idea');
    expect(normalizeColumn(null)).toBe('idea');
  });

  it('дубликат уезжает в trash с префиксом, повторный префикс не добавляется', async () => {
    const original = await createNote(USER, 'позвонить маме');
    const duplicate = await createNote(USER, 'позвонить маме!!!');
    const already = await createNote(USER, 'позвонить маме');
    const unrelated = await createNote(USER, 'случайная мысль');

    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: String(original.id), clean_text: 'Позвонить маме', column: 'self' },
          {
            id: String(duplicate.id),
            clean_text: 'Позвонить маме',
            column: 'archive',
            is_duplicate_of_id: String(original.id),
          },
          {
            id: String(already.id),
            clean_text: `${DUPLICATE_PREFIX} Позвонить маме`,
            column: 'note',
            is_duplicate_of_id: String(original.id),
          },
          {
            id: String(unrelated.id),
            clean_text: 'Случайная мысль',
            column: 'possible_tasks',
            is_duplicate_of_id: '0',
          },
        ],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(result.processedCount).toBe(4);

    const dup = await getNote(USER, duplicate.id);
    expect(dup?.column).toBe('trash');
    expect(dup?.cleanText).toBe(`${DUPLICATE_PREFIX} Позвонить маме`);

    const prefixed = await getNote(USER, already.id);
    expect(prefixed?.column).toBe('trash');
    expect(prefixed?.cleanText).toBe(`${DUPLICATE_PREFIX} Позвонить маме`);

    const other = await getNote(USER, unrelated.id);
    expect(other?.column).toBe('todo');
    expect(other?.cleanText).toBe('Случайная мысль');
  });

  it('пустой clean_text или отсутствующий id пропускаются', async () => {
    const first = await createNote(USER, 'первая');
    const second = await createNote(USER, 'вторая');
    useChat(() =>
      JSON.stringify({
        processed_notes: [
          { id: String(first.id), clean_text: '   ', column: 'note' },
          { clean_text: 'Без id', column: 'note' },
          { id: String(second.id), clean_text: 'Вторая', column: 'note' },
        ],
      }),
    );

    const result = await runNightlyConsolidation(USER, { now: NOW, timeZone: 'UTC' });
    expect(result.noteIds).toEqual([second.id]);
    expect((await getNote(USER, first.id))?.column).toBe('raw');
  });
});

describe('parseConsolidationResponse', () => {
  const payload = {
    processed_notes: [
      { id: '1', clean_text: 'Раз', column: 'note' },
      { id: '2', clean_text: 'Два', column: 'todo' },
    ],
  };

  it('чистый JSON', () => {
    expect(parseConsolidationResponse(JSON.stringify(payload))).toHaveLength(2);
  });

  it('JSON в markdown-фенсе', () => {
    const answer = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    expect(parseConsolidationResponse(answer)).toHaveLength(2);
  });

  it('JSON с текстом вокруг', () => {
    const answer = `Вот результат:\n${JSON.stringify(payload)}\nГотово.`;
    expect(parseConsolidationResponse(answer)).toHaveLength(2);
  });

  it('мусор и неверная форма → пустой список', () => {
    expect(parseConsolidationResponse('не json')).toEqual([]);
    expect(parseConsolidationResponse('')).toEqual([]);
    expect(parseConsolidationResponse('{"processed_notes": {}}')).toEqual([]);
    expect(parseConsolidationResponse('{"other": []}')).toEqual([]);
  });

  it('не-объекты в списке отбрасываются', () => {
    const answer = JSON.stringify({ processed_notes: [payload.processed_notes[0], 'мусор', null] });
    expect(parseConsolidationResponse(answer)).toHaveLength(1);
  });
});

describe('планировщик', () => {
  it('nextNightlyAt: сегодня, если час ещё не наступил, иначе завтра', () => {
    const early = nextNightlyAt(new Date('2026-03-10T01:00:00.000Z'), 3, 'UTC');
    const late = nextNightlyAt(new Date('2026-03-10T04:00:00.000Z'), 3, 'UTC');

    expect(early.toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(late.toISOString()).toBe('2026-03-11T03:00:00.000Z');
  });

  it('nextNightlyAt зажимает час в диапазон 0..23', () => {
    const clamped = nextNightlyAt(new Date('2026-03-10T01:00:00.000Z'), 30, 'UTC');
    expect(clamped.toISOString()).toBe('2026-03-10T23:00:00.000Z');
  });

  it('дефолтный час — 3 ночи', () => {
    expect(NIGHTLY_HOUR).toBe(3);
  });

  it('scheduleNightlyConsolidation идемпотентна: одна ожидающая задача', async () => {
    const first = await scheduleNightlyConsolidation(USER, {
      now: new Date('2026-03-10T01:00:00.000Z'),
      timeZone: 'UTC',
    });
    const second = await scheduleNightlyConsolidation(USER, {
      now: new Date('2026-03-10T05:00:00.000Z'),
      timeZone: 'UTC',
    });

    expect(second.id).toBe(first.id);
    expect(first.runAt).toBe('2026-03-10T03:00:00.000Z');
    expect(second.runAt).toBe('2026-03-11T03:00:00.000Z');
    expect(await listPendingJobs(USER)).toHaveLength(1);
  });

  it('обработчик в due_jobs: разбирает заметки и ставит следующую ночь', async () => {
    const note = await createNote(USER, 'заметка из планировщика');
    useChat(respondAll('note'));
    registerConsolidationHandler({ hour: 3, timeZone: 'UTC' });

    expect(hasConsolidationChat()).toBe(true);
    await schedule(USER, 'nightly_consolidation', new Date('2026-03-10T02:59:00.000Z'), {
      hour: 3,
    });

    const before = new Date();
    const run = await runDueJobs(new Date('2026-03-10T03:00:00.000Z'));
    const after = new Date();

    expect(run.claimed).toBe(1);
    expect(run.done).toBe(1);
    expect(run.failed).toBe(0);
    expect((await getNote(USER, note.id))?.column).toBe('note');

    const next = await getPendingJob(USER, 'nightly_consolidation');
    expect(next).not.toBeNull();
    expect([nextNightlyAt(before, 3, 'UTC').toISOString(), nextNightlyAt(after, 3, 'UTC').toISOString()])
      .toContain(next?.runAt);
  });

  it('ошибка прогона: задача failed с причиной и без следующей ночи', async () => {
    await createNote(USER, 'заметка');
    useChat(() => {
      throw new Error('model down');
    });
    registerConsolidationHandler({ hour: 3, timeZone: 'UTC' });

    await schedule(USER, 'nightly_consolidation', new Date('2026-03-10T02:59:00.000Z'));

    const run = await runDueJobs(new Date('2026-03-10T03:00:00.000Z'));
    expect(run.failed).toBe(1);
    expect(run.done).toBe(0);

    const row = await db.get<{ status: string; last_error: string | null }>(sql`
      SELECT status, last_error FROM due_jobs
       WHERE user_id = ${USER} AND kind = ${'nightly_consolidation'}
       LIMIT 1
    `);
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('model down');
    expect(await listPendingJobs(USER)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Вспомогательное
// ---------------------------------------------------------------------------

async function setCreatedAt(noteId: number, createdAt: string): Promise<void> {
  await db.run(sql`UPDATE notes SET created_at = ${createdAt} WHERE id = ${noteId}`);
}

async function listRawIds(): Promise<number[]> {
  const rows = await db.all<{ id: number }>(sql`
    SELECT id FROM notes WHERE user_id = ${USER} AND "column" = 'raw' ORDER BY id
  `);
  return rows.map((row) => Number(row.id));
}
