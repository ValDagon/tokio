/**
 * Тулзы агента: заметки и канбан-доска (SPEC §3 T12).
 *
 * Держим инварианты тулз:
 *  - колонка по умолчанию — `raw` («Сырое»), синонимы разбираются регистронезависимо;
 *  - поиск без модели эмбеддингов деградирует до стемов (слово ≥5 символов →
 *    первые 5, ≥3 символов → слово целиком), а граф знаний ищется всегда;
 *  - `edit_note` правит только `clean_text`, `raw_text` остаётся исходным;
 *  - `delete_note` не удаляет строку, а уносит её в корзину;
 *  - дайджест инбокса — только `raw`, `limit` зажимается в [1, 50], дефолт 10;
 *  - каждый пользователь видит только свои заметки.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { notesTools, searchKnowledgeGraph } from '../../../src/lib/agent/tools/notes';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { createNote, listNotes } from '../../../src/lib/dal/notes';
import {
  addRelation,
  listEntities,
  listEntityRelationsBidirectional,
  listMentions,
  listTrash,
  upsertEntity,
} from '../../../src/lib/dal/misc';
import { ensureUser } from '../../../src/lib/dal/users';
import { setEmbeddingsModel } from '../../../src/lib/embeddings';
import { EMBEDDING_DIMENSIONS } from '../../../src/types';

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

function contextFor(userId: number): ToolContext {
  return { ...CTX_A, userId };
}

function toolByName(name: string): Tool {
  const found = notesTools.find((tool) => tool.name === name);
  if (!found) throw new Error(`тулза ${name} не зарегистрирована в notesTools`);
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

interface NoteData {
  note_id: number;
  column: string;
  column_name: string;
  has_embedding: boolean;
}

interface NoteItemData {
  id: number;
  column: string;
  text: string;
  created_at: string | null;
}

interface SearchData {
  notes: NoteItemData[];
  kg: Array<{ entity: string; kind: string; description: string; relation: string }>;
}

interface DigestData {
  count: number;
  notes: NoteItemData[];
}

/** Единичный вектор размерности модели: норма 1, косинус с другим one-hot = 0. */
function oneHot(index: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

beforeEach(async () => {
  setEmbeddingsModel(null);
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER_A);
  await ensureUser(USER_B);
});

afterEach(() => {
  setEmbeddingsModel(null);
});

// ---------------------------------------------------------------------------
// add_note
// ---------------------------------------------------------------------------

describe('add_note', () => {
  it('без колонки сохраняет в «Сырое» (raw) и печатает превью с хвостом', async () => {
    const outcome = await run('add_note', { text: 'Купить молоко' });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Записал в заметки: «Купить молоко...» (сохранено в «Сырое» — останется в первозданном виде без ночной обработки)',
    );

    const data = outcome.data as NoteData;
    expect(data.column).toBe('raw');
    expect(data.column_name).toBe('Сырое');

    const stored = await listNotes(USER_A);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ rawText: 'Купить молоко', column: 'raw', cleanText: null });
  });

  it('превью обрезается до 50 символов и всегда получает ASCII-многоточие', async () => {
    const longText = 'а'.repeat(60);

    const outcome = await run('add_note', { text: longText });
    expect(outcome.ok).toBe(true);

    expect(outcome.content).toContain(`«${'а'.repeat(50)}...»`);
    expect(outcome.content).not.toContain(longText);

    const stored = await listNotes(USER_A);
    expect(stored[0].rawText).toBe(longText);
  });

  it('синоним «о себе» сохраняет в колонку note с русским именем', async () => {
    const outcome = await run('add_note', { text: 'Люблю тишину', column: 'о себе' });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'Записал в заметки: «Люблю тишину...» (сохранено в «О себе»)',
    );

    const data = outcome.data as NoteData;
    expect(data.column).toBe('note');
    expect(data.column_name).toBe('О себе');

    const [stored] = await listNotes(USER_A);
    expect(stored.column).toBe('note');
  });

  it('без модели эмбеддингов has_embedding === false', async () => {
    const outcome = await run('add_note', { text: 'Мысль без вектора' });

    expect(outcome.ok).toBe(true);
    expect((outcome.data as NoteData).has_embedding).toBe(false);

    const [stored] = await listNotes(USER_A);
    expect(stored.embedding).toBeNull();
  });

  it('пустой или нестроковый text — ok:false без исключения', async () => {
    const empty = await run('add_note', {});
    expect(empty.ok).toBe(false);
    expect(empty.content).toBe('Укажите текст заметки (text).');

    const blank = await run('add_note', { text: '   ' });
    expect(blank.ok).toBe(false);
    expect(blank.content).toBe('Укажите текст заметки (text).');

    const wrongType = await run('add_note', { text: 42 });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.content).toBe('Укажите текст заметки (text).');

    expect(await listNotes(USER_A)).toEqual([]);
  });

  it('с опциональными entities и relations сохраняет сущности, mentions к noteId и активные связи', async () => {
    const outcome = await run('add_note', {
      text: 'Артём перешёл в Acme',
      column: 'note',
      entities: [
        { name: 'Артём', kind: 'person', aliases: ['Тёма'], description: 'Коллега' },
        { name: 'Acme', kind: 'org' },
      ],
      relations: [{ subject: 'Артём', predicate: 'работает в', object: 'Acme' }],
    });

    expect(outcome.ok).toBe(true);
    const noteId = (outcome.data as NoteData).note_id;

    const entities = await listEntities(USER_A);
    const artem = entities.find((e) => e.name === 'Артём');
    const acme = entities.find((e) => e.name === 'Acme');
    if (!artem || !acme) throw new Error('ожидались сущности Артём и Acme');

    expect(artem).toMatchObject({ kind: 'person', aliases: ['Тёма'], description: 'Коллега' });
    expect(acme).toMatchObject({ kind: 'org' });

    const artemMentions = await listMentions(USER_A, artem.id);
    const acmeMentions = await listMentions(USER_A, acme.id);
    expect(artemMentions).toHaveLength(1);
    expect(artemMentions[0]).toMatchObject({ sourceType: 'note', sourceId: noteId });
    expect(acmeMentions).toHaveLength(1);
    expect(acmeMentions[0]).toMatchObject({ sourceType: 'note', sourceId: noteId });

    const relations = await listEntityRelationsBidirectional(USER_A, artem.id);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      subjectId: artem.id,
      predicate: 'работает в',
      objectId: acme.id,
      sourceId: noteId,
      validTo: null,
    });
  });
});

// ---------------------------------------------------------------------------
// search_notes
// ---------------------------------------------------------------------------

describe('search_notes', () => {
  it('фолбэк по стемам: слово ≥5 символов ищется по первым 5 символам', async () => {
    await createNote(USER_A, 'Купить молоко и творог');

    const outcome = await run('search_notes', { query: 'молока' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• [raw] Купить молоко и творог');

    const data = outcome.data as SearchData;
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0].text).toBe('Купить молоко и творог');
  });

  it('фолбэк по стемам: слово из 3–4 символов ищется как есть (подстрока)', async () => {
    await createNote(USER_A, 'Сходить за хлебом и домой');

    const four = await run('search_notes', { query: 'хлеб' });
    expect(four.ok).toBe(true);
    expect((four.data as SearchData).notes).toHaveLength(1);

    // 3 символа не усекаются и не стеммируются: «дом» — подстрока «домой».
    const three = await run('search_notes', { query: 'дом' });
    expect(three.ok).toBe(true);
    expect((three.data as SearchData).notes).toHaveLength(1);
    expect((three.data as SearchData).notes[0].text).toBe('Сходить за хлебом и домой');

    // А вот «дома» в «домой» не содержится — совпадения нет.
    const noMatch = await run('search_notes', { query: 'дома' });
    expect(noMatch.ok).toBe(true);
    expect((noMatch.data as SearchData).notes).toEqual([]);
    expect(noMatch.content).toBe('По запросу «дома» ничего не найдено в заметках и памяти.');
  });

  it('пустой query — ok:false', async () => {
    const missing = await run('search_notes', {});
    expect(missing.ok).toBe(false);
    expect(missing.content).toBe('Укажите поисковый запрос (query).');

    const blank = await run('search_notes', { query: '  ' });
    expect(blank.ok).toBe(false);
    expect(blank.content).toBe('Укажите поисковый запрос (query).');
  });

  it('находит сущность графа знаний со связью', async () => {
    const moscow = await upsertEntity(USER_A, {
      name: 'Москва',
      kind: 'place',
      description: 'Столица России',
    });
    const russia = await upsertEntity(USER_A, { name: 'Россия', kind: 'place' });
    await addRelation(USER_A, {
      subjectId: moscow.id,
      predicate: 'столица',
      objectId: russia.id,
    });

    const outcome = await run('search_notes', { query: 'Москва' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('🧠 **Связи в памяти:**');
    expect(outcome.content).toContain('• Москва [place]: Столица России (столица ➔ Россия)');

    const data = outcome.data as SearchData;
    expect(data.notes).toEqual([]);
    expect(data.kg).toHaveLength(1);
  });

  it('ничего не найдено — точная строка про заметки и память', async () => {
    const outcome = await run('search_notes', { query: 'кварцевый' });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'По запросу «кварцевый» ничего не найдено в заметках и памяти.',
    );
    expect(outcome.data).toEqual({ notes: [], kg: [] });
  });

  it('с DI-моделью ищет через гибридный поиск: точный хит фильтрует ортогональный шум, а семантический запрос сортирует по близости', async () => {
    setEmbeddingsModel(async (text) =>
      text.toLowerCase().includes('солн') || text.toLowerCase().includes('погод')
        ? oneHot(0)
        : oneHot(1),
    );

    const sun = await run('add_note', { text: 'Солнечный день на море' });
    const rain = await run('add_note', { text: 'Дождливый вечер дома' });
    expect((sun.data as NoteData).has_embedding).toBe(true);
    expect((rain.data as NoteData).has_embedding).toBe(true);

    // При наличии лексического совпадения ортогональная заметка (cosine 0 < 0.25) отсекается.
    const hybridOutcome = await run('search_notes', { query: 'солнечный' });
    expect(hybridOutcome.ok).toBe(true);
    const hybridData = hybridOutcome.data as SearchData;
    expect(hybridData.notes).toHaveLength(1);
    expect(hybridData.notes[0].text).toBe('Солнечный день на море');

    // Чисто семантический запрос без лексического пересечения возвращает все векторные совпадения по близости.
    const semanticOutcome = await run('search_notes', { query: 'погода' });
    expect(semanticOutcome.ok).toBe(true);
    const semanticData = semanticOutcome.data as SearchData;
    expect(semanticData.notes).toHaveLength(2);
    expect(semanticData.notes[0].text).toBe('Солнечный день на море');
    expect(semanticData.notes[1].text).toBe('Дождливый вечер дома');
    expect(semanticOutcome.content.indexOf('Солнечный день на море')).toBeLessThan(
      semanticOutcome.content.indexOf('Дождливый вечер дома'),
    );
  });

  it('заметки другого пользователя не находятся', async () => {
    await createNote(USER_B, 'Секретная мысль про молоко');

    const outcome = await run('search_notes', { query: 'молоко' }, contextFor(USER_A));
    expect(outcome.content).toBe(
      'По запросу «молоко» ничего не найдено в заметках и памяти.',
    );
  });

  it('searchKnowledgeGraph и search_notes ищут по алиасам и нормализации ё→е', async () => {
    const artem = await upsertEntity(USER_A, {
      name: 'Артём',
      kind: 'person',
      aliases: ['Тёма', 'Артёмыч'],
      description: 'Бэкенд-разработчик',
    });
    const lake = await upsertEntity(USER_A, { name: 'Озёрный', kind: 'place' });
    await addRelation(USER_A, {
      subjectId: artem.id,
      predicate: 'живёт в',
      objectId: lake.id,
    });

    const byAlias = await searchKnowledgeGraph(USER_A, 'тема');
    expect(byAlias).toEqual([
      {
        entity: 'Артём',
        kind: 'person',
        description: 'Бэкенд-разработчик',
        relation: 'живёт в ➔ Озёрный',
      },
    ]);

    const byNormalizedName = await searchKnowledgeGraph(USER_A, '«артем»');
    expect(byNormalizedName).toEqual(byAlias);

    const outcome = await run('search_notes', { query: 'тема' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('• Артём [person]: Бэкенд-разработчик (живёт в ➔ Озёрный)');
    expect((outcome.data as SearchData).kg).toEqual(byAlias);
  });

  it('searchKnowledgeGraph и search_notes возвращают исходящие и входящие активные связи, исключая закрытые', async () => {
    const alice = await upsertEntity(USER_A, { name: 'Алиса', kind: 'person' });
    const bob = await upsertEntity(USER_A, { name: 'Борис', kind: 'person' });
    const oldOrg = await upsertEntity(USER_A, { name: 'Старая компания', kind: 'org' });
    const newOrg = await upsertEntity(USER_A, { name: 'Новая компания', kind: 'org' });

    // Первая связь закроется автоматически (valid_to IS NOT NULL) при смене объекта по тому же предикату
    await addRelation(USER_A, {
      subjectId: alice.id,
      predicate: 'работает в',
      objectId: oldOrg.id,
    });
    await addRelation(USER_A, {
      subjectId: alice.id,
      predicate: 'работает в',
      objectId: newOrg.id,
    });
    await addRelation(USER_A, {
      subjectId: bob.id,
      predicate: 'наставник',
      objectId: alice.id,
    });

    const kgRows = await searchKnowledgeGraph(USER_A, 'Алиса');
    expect(kgRows).toEqual([
      {
        entity: 'Алиса',
        kind: 'person',
        description: '',
        relation: 'работает в ➔ Новая компания',
      },
      {
        entity: 'Алиса',
        kind: 'person',
        description: '',
        relation: 'Борис ➔ наставник ➔ Алиса',
      },
    ]);

    const outcome = await run('search_notes', { query: 'Алиса' });
    expect(outcome.ok).toBe(true);
    expect((outcome.data as SearchData).kg).toEqual(kgRows);
    expect(outcome.content).toContain('работает в ➔ Новая компания');
    expect(outcome.content).toContain('Борис ➔ наставник ➔ Алиса');
    expect(outcome.content).not.toContain('Старая компания');
  });
});

// ---------------------------------------------------------------------------
// edit_note
// ---------------------------------------------------------------------------

describe('edit_note', () => {
  it('правит только clean_text, raw_text остаётся прежним', async () => {
    const note = await createNote(USER_A, 'Исходный текст заметки');

    const outcome = await run('edit_note', { query: 'Исходный', new_text: 'Полностью новый текст' });
    expect(outcome.ok).toBe(true);

    const [stored] = await listNotes(USER_A);
    expect(stored.id).toBe(note.id);
    expect(stored.rawText).toBe('Исходный текст заметки');
    expect(stored.cleanText).toBe('Полностью новый текст');
    expect(stored.column).toBe('raw');
  });

  it('сообщение содержит колонку и новый текст', async () => {
    await createNote(USER_A, 'Исходный текст заметки');

    const outcome = await run('edit_note', { query: 'Исходный', new_text: 'Полностью новый текст' });
    expect(outcome.content).toBe(
      '✅ Заметка в колонке «Сырое» обновлена:\n«Полностью новый текст»',
    );
  });

  it('промах по заметке, пустой query и пустой new_text — ok:false', async () => {
    await createNote(USER_A, 'Исходный текст заметки');

    const missing = await run('edit_note', { query: 'нет такой', new_text: 'Что-то' });
    expect(missing.ok).toBe(false);
    expect(missing.content).toBe('Не нашёл заметку, похожую на «нет такой».');

    const noQuery = await run('edit_note', { new_text: 'Что-то' });
    expect(noQuery.ok).toBe(false);
    expect(noQuery.content).toBe('Укажите, какую заметку править (query).');

    const noText = await run('edit_note', { query: 'Исходный', new_text: '  ' });
    expect(noText.ok).toBe(false);
    expect(noText.content).toBe('Текст заметки не может быть пустым.');

    const [stored] = await listNotes(USER_A);
    expect(stored.cleanText).toBeNull();
  });

  it('с опциональными entities и relations сохраняет сущности, mentions к noteId и активные связи', async () => {
    const note = await createNote(USER_A, 'Встреча с Леной');

    const outcome = await run('edit_note', {
      query: 'Встреча',
      new_text: 'Елена ведёт проект Марс',
      entities: [
        { name: 'Елена', kind: 'person', aliases: ['Лена'] },
        { name: 'Марс', kind: 'project', description: 'Ключевой запуск' },
      ],
      relations: [{ subject: 'Елена', predicate: 'ведёт', object: 'Марс' }],
    });

    expect(outcome.ok).toBe(true);
    const [stored] = await listNotes(USER_A);
    expect(stored.cleanText).toBe('Елена ведёт проект Марс');

    const entities = await listEntities(USER_A);
    const elena = entities.find((e) => e.name === 'Елена');
    const mars = entities.find((e) => e.name === 'Марс');
    if (!elena || !mars) throw new Error('ожидались сущности Елена и Марс');

    expect(elena).toMatchObject({ kind: 'person', aliases: ['Лена'] });
    expect(mars).toMatchObject({ kind: 'project', description: 'Ключевой запуск' });

    const elenaMentions = await listMentions(USER_A, elena.id);
    const marsMentions = await listMentions(USER_A, mars.id);
    expect(elenaMentions).toHaveLength(1);
    expect(elenaMentions[0]).toMatchObject({ sourceType: 'note', sourceId: note.id });
    expect(marsMentions).toHaveLength(1);
    expect(marsMentions[0]).toMatchObject({ sourceType: 'note', sourceId: note.id });

    const relations = await listEntityRelationsBidirectional(USER_A, elena.id);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      subjectId: elena.id,
      predicate: 'ведёт',
      objectId: mars.id,
      sourceId: note.id,
      validTo: null,
    });
  });
});

// ---------------------------------------------------------------------------
// move_note
// ---------------------------------------------------------------------------

describe('move_note', () => {
  it('переносит по синониму колонки «идеи» → idea', async () => {
    await createNote(USER_A, 'Идея для нового проекта');

    const outcome = await run('move_note', { query: 'Идея', target_column: 'идеи' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('успешно перемещена в колонку «Идеи»');

    const data = outcome.data as { note_id: number; column: string; moved: boolean };
    expect(data.column).toBe('idea');
    expect(data.moved).toBe(true);

    const [stored] = await listNotes(USER_A);
    expect(stored.column).toBe('idea');
  });

  it('повторный перенос в ту же колонку — moved:false', async () => {
    await createNote(USER_A, 'Идея для нового проекта', { column: 'idea' });

    const outcome = await run('move_note', { query: 'Идея', target_column: 'ideas' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe('Заметка уже находится в колонке «Идеи».');
    expect((outcome.data as { moved: boolean }).moved).toBe(false);
  });

  it('неизвестная колонка — ok:false со списком доступных', async () => {
    await createNote(USER_A, 'Идея для нового проекта');

    const outcome = await run('move_note', { query: 'Идея', target_column: 'марс' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe(
      'Неизвестная колонка «марс». Доступные колонки: «Сырое» (raw), «Идеи» (idea), «О себе» (note), «Возможные задачи» (todo).',
    );

    const [stored] = await listNotes(USER_A);
    expect(stored.column).toBe('raw');
  });

  it('не найденная заметка — ok:false', async () => {
    await createNote(USER_A, 'Идея для нового проекта');

    const outcome = await run('move_note', { query: 'нет такой', target_column: 'todo' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toBe('Не нашёл заметку, похожую на «нет такой».');
  });
});

// ---------------------------------------------------------------------------
// delete_note
// ---------------------------------------------------------------------------

describe('delete_note', () => {
  it('уносит заметку в корзину, не удаляя строку', async () => {
    const note = await createNote(USER_A, 'Старая мысль про отпуск');

    const outcome = await run('delete_note', { query: 'отпуск' });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      '🗑️ Заметка «Старая мысль про отпуск» перемещена в корзину (будет храниться 30 дней).',
    );
    expect((outcome.data as { note_id: number; deleted: boolean }).deleted).toBe(true);

    expect(await listNotes(USER_A)).toEqual([]);
    const trash = await listTrash(USER_A);
    expect(trash.notes).toHaveLength(1);
    expect(trash.notes[0]).toMatchObject({ id: note.id, rawText: 'Старая мысль про отпуск' });
  });

  it('не найденная заметка и пустой query — ok:false', async () => {
    await createNote(USER_A, 'Старая мысль про отпуск');

    const missing = await run('delete_note', { query: 'нет такой' });
    expect(missing.ok).toBe(false);
    expect(missing.content).toBe('Не нашёл заметку, похожую на «нет такой».');

    const noQuery = await run('delete_note', {});
    expect(noQuery.ok).toBe(false);
    expect(noQuery.content).toBe('Укажите, какую заметку удалить (query).');

    expect(await listNotes(USER_A)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// get_inbox_digest
// ---------------------------------------------------------------------------

describe('get_inbox_digest', () => {
  it('пустой инбокс — точная строка (и чужие заметки не видны)', async () => {
    await createNote(USER_A, 'Мысль пользователя A');

    const outcome = await run('get_inbox_digest', {}, contextFor(USER_B));
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toBe(
      'В инбоксе и сырых заметках (raw) сейчас пусто. Все мысли разобраны!',
    );
    expect(outcome.data).toEqual({ notes: [], count: 0 });
  });

  it('limit зажимается: 0 → 1, 999 → 50, дефолт 10', async () => {
    for (let index = 0; index < 55; index += 1) {
      await createNote(USER_A, `Мысль номер ${index + 1}`);
    }

    const zero = await run('get_inbox_digest', { limit: 0 });
    expect((zero.data as DigestData).count).toBe(1);

    const huge = await run('get_inbox_digest', { limit: 999 });
    const hugeData = huge.data as DigestData;
    expect(hugeData.count).toBe(50);
    expect(huge.content).toContain('📥 **Неразобранные мысли и инбокс (50 шт.):**');
    const hugeLines = huge.content
      .split('\n')
      .filter((line) => /^\d+\. \[Сырое \(raw\)\]/.test(line));
    expect(hugeLines).toHaveLength(50);

    const fallback = await run('get_inbox_digest', {});
    expect((fallback.data as DigestData).count).toBe(10);
  });

  it('строки формата «N. [Сырое (raw)] текст _(id=…, YYYY-MM-DD HH:MM)_»', async () => {
    const note = await createNote(USER_A, 'Проверить формат дайджеста');
    await createNote(USER_A, 'Идея вне инбокса', { column: 'idea' });

    const outcome = await run('get_inbox_digest', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('📥 **Неразобранные мысли и инбокс (1 шт.):**');

    const lines = outcome.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(
      new RegExp(
        `^1\\. \\[Сырое \\(raw\\)\\] Проверить формат дайджеста _\\(id=${note.id}, \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\)_$`,
      ),
    );

    const data = outcome.data as DigestData;
    expect(data.count).toBe(1);
    expect(data.notes[0]).toMatchObject({ id: note.id, column: 'raw' });
  });

  it('в дайджест попадают только raw-заметки', async () => {
    await createNote(USER_A, 'Сырая мысль');
    await createNote(USER_A, 'Оформившаяся идея', { column: 'idea' });
    await createNote(USER_A, 'Личная заметка', { column: 'note' });
    await createNote(USER_A, 'Возможная задача', { column: 'todo' });

    const outcome = await run('get_inbox_digest', {});
    expect(outcome.content).toContain('(1 шт.)');
    expect(outcome.content).toContain('Сырая мысль');
    expect(outcome.content).not.toContain('Оформившаяся идея');
    expect(outcome.content).not.toContain('Личная заметка');
    expect(outcome.content).not.toContain('Возможная задача');
  });
});
