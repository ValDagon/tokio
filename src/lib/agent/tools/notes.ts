/**
 * Тулзы агента: заметки и канбан-доска (SPEC §3 T12, паритет с
 * `backend/app/agent/tools/notes.py`).
 *
 * ADR-003: эмбеддинги не создаются на месте — используется глобальный
 * `embedText(userId, text, { useCache: true })`; модель подключается платформой
 * через `setEmbeddingsModel`, а в тестах — заглушкой. Нет модели → поиск
 * деградирует до подстрочного (как «нет эмбеддинга» в upstream).
 *
 * Отличия от upstream (осознанно, SPEC §8):
 *  - в порте пять колонок (`raw | todo | note | idea | trash`) вместо семи:
 *    upstream `inbox` → `raw`, `ideas` → `idea`, `self | useful | archive` →
 *    `note`, `possible_tasks` → `todo`; синонимы сохранены;
 *  - `edit_note` правит только `clean_text` (`NotePatch` без `raw_text`/
 *    `embedding`/`processed_at`); upstream перезаписывал и `raw_text`;
 *  - у `notes` нет `updated_at` — правка/перенос не трогают метку времени;
 *  - SQL `lower()` не фолдит кириллицу, поэтому поиск по фрагменту — JS-фильтр
 *    поверх `listNotes` (свежие сверху), а не SQL `ILIKE`.
 */

import type {
  EntityRow,
  NoteColumn,
  NoteRow,
  RelationRow,
} from '../../../types';
import {
  createNote,
  listNotes,
  searchNotesHybrid,
  updateNote,
} from '../../dal/notes';
import {
  addRelation,
  getEntity,
  linkMention,
  listEntities,
  listEntityRelationsBidirectional,
  matchesEntityQuery,
  normalizeEntityName,
  parseKgEntities,
  parseKgRelations,
  softDeleteNote,
  upsertEntity,
} from '../../dal/misc';
import { embedText, isEmbedding } from '../../embeddings';
import { dateKey, fromIso, timeKey } from '../../utils';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import { asInt, asText, errorText, fail, snippet } from './tasks';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

const COLUMN_RU: Record<NoteColumn, string> = {
  raw: 'Сырое',
  idea: 'Идеи',
  note: 'О себе',
  todo: 'Возможные задачи',
  trash: 'Корзина',
};

/** Синонимы колонок канбан-доски (upstream + TS-имена). */
const COLUMN_SYNONYMS: Record<string, NoteColumn> = {
  входящие: 'raw',
  инбокс: 'raw',
  inbox: 'raw',
  сырое: 'raw',
  raw: 'raw',
  идеи: 'idea',
  идея: 'idea',
  ideas: 'idea',
  idea: 'idea',
  'о себе': 'note',
  личное: 'note',
  рефлексия: 'note',
  полезное: 'note',
  ресурсы: 'note',
  архив: 'note',
  self: 'note',
  useful: 'note',
  archive: 'note',
  note: 'note',
  'возможные задачи': 'todo',
  задачи: 'todo',
  possible_tasks: 'todo',
  todo: 'todo',
  корзина: 'trash',
  trash: 'trash',
};

function normalizeColumn(value: string | null): NoteColumn | null {
  if (!value) return null;
  return COLUMN_SYNONYMS[value.trim().toLowerCase()] ?? null;
}

function columnTitle(column: NoteColumn): string {
  return COLUMN_RU[column];
}

/** Текст заметки для показа: `clean_text` приоритетнее `raw_text`. */
function noteText(note: NoteRow): string {
  return (note.cleanText ?? note.rawText ?? '').trim();
}

/** Поиск заметки по фрагменту: `raw_text` или `clean_text`, свежие сверху. */
function matchNote(notes: readonly NoteRow[], query: string): NoteRow | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  for (const note of notes) {
    const haystack = `${note.rawText ?? ''}\n${note.cleanText ?? ''}`.toLowerCase();
    if (haystack.includes(needle)) return note;
  }
  return null;
}

interface KgRow {
  entity: string;
  kind: string;
  description: string;
  relation: string;
}

/**
 * Поиск по графу знаний (порт `query_knowledge_graph`): сущности, чьё имя,
 * алиас или описание содержит нормализованный запрос, плюс их двусторонние активные связи.
 */
export async function searchKnowledgeGraph(
  userId: number,
  query: string,
  limit = 10,
): Promise<KgRow[]> {
  const q = normalizeEntityName(query);
  if (!q) return [];

  const entities = await listEntities(userId, { limit: 500 });
  const entityCache = new Map<number, EntityRow | null>(
    entities.map((entity) => [entity.id, entity]),
  );

  const resolveEntityName = async (entityId: number): Promise<string> => {
    if (entityCache.has(entityId)) {
      return entityCache.get(entityId)?.name ?? '';
    }
    try {
      const loaded = await getEntity(userId, entityId);
      entityCache.set(entityId, loaded);
      return loaded?.name ?? '';
    } catch {
      entityCache.set(entityId, null);
      return '';
    }
  };

  const matched = entities.filter((entity) => matchesEntityQuery(entity, q));

  const rows: KgRow[] = [];
  for (const entity of matched) {
    if (rows.length >= limit) break;

    const base: Omit<KgRow, 'relation'> = {
      entity: entity.name,
      kind: entity.kind,
      description: entity.description ?? '',
    };

    let relations: RelationRow[] = [];
    try {
      relations = await listEntityRelationsBidirectional(userId, entity.id);
    } catch {
      relations = [];
    }

    if (relations.length === 0) {
      rows.push({ ...base, relation: '' });
      continue;
    }

    for (const relation of relations) {
      if (rows.length >= limit) break;
      if (relation.subjectId === entity.id) {
        const targetName = await resolveEntityName(relation.objectId);
        rows.push({
          ...base,
          relation: targetName ? `${relation.predicate} ➔ ${targetName}` : relation.predicate,
        });
      } else {
        const sourceName = await resolveEntityName(relation.subjectId);
        rows.push({
          ...base,
          relation: sourceName
            ? `${sourceName} ➔ ${relation.predicate} ➔ ${entity.name}`
            : `← ${relation.predicate}`,
        });
      }
    }
  }

  return rows;
}

/** Сохраняет опционально переданные в `add_note`/`edit_note` сущности и связи. */
async function ingestNoteKnowledgeGraph(
  userId: number,
  noteId: number,
  args: Record<string, unknown>,
): Promise<void> {
  for (const ent of parseKgEntities(args.entities)) {
    try {
      const entity = await upsertEntity(userId, {
        name: ent.name,
        kind: ent.kind,
        aliases: ent.aliases,
        description: ent.description,
      });
      await linkMention(userId, {
        entityId: entity.id,
        sourceType: 'note',
        sourceId: noteId,
      });
    } catch {
      // Ошибка записи отдельной сущности не должна откатывать заметку.
    }
  }

  for (const rel of parseKgRelations(args.relations)) {
    try {
      const subj = await upsertEntity(userId, { name: rel.subject });
      const obj = await upsertEntity(userId, { name: rel.object });
      await addRelation(userId, {
        subjectId: subj.id,
        predicate: rel.predicate,
        objectId: obj.id,
        sourceId: noteId,
      });
    } catch {
      // Ошибка записи отдельной связи не должна откатывать заметку.
    }
  }
}

/** Эмбеддинг текста через глобальную модель с кэшем; ошибки → `null`. */
async function embed(ctx: ToolContext, text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  try {
    const result = await embedText(ctx.userId, text, { useCache: true });
    return isEmbedding(result) ? result : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// add_note
// ---------------------------------------------------------------------------

async function addNote(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const text = asText(args.text);
  if (!text) return fail('Укажите текст заметки (text).');

  const requested = asText(args.column);
  const column: NoteColumn = normalizeColumn(requested) ?? 'raw';

  try {
    const embedding = await embed(ctx, text);
    const note = await createNote(ctx.userId, text, { column, embedding });
    if (args.entities !== undefined || args.relations !== undefined) {
      await ingestNoteKnowledgeGraph(ctx.userId, note.id, args);
    }

    const preview = `${text.slice(0, 50)}...`;
    const tail =
      column === 'raw'
        ? ` — останется в первозданном виде без ночной обработки`
        : '';
    return {
      ok: true,
      content: `Записал в заметки: «${preview}» (сохранено в «${columnTitle(column)}»${tail})`,
      data: {
        note_id: note.id,
        column: note.column,
        column_name: columnTitle(note.column),
        has_embedding: note.embedding !== null,
      },
    };
  } catch (error) {
    return fail(`Не удалось сохранить заметку: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// search_notes
// ---------------------------------------------------------------------------

async function searchNotes(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите поисковый запрос (query).');

  try {
    const embedding = await embed(ctx, query);
    const notes = await searchNotesHybrid(ctx.userId, { query, embedding, limit: 5 });

    const kgRows = await searchKnowledgeGraph(ctx.userId, query, 10);

    if (notes.length === 0 && kgRows.length === 0) {
      return {
        ok: true,
        content: `По запросу «${query}» ничего не найдено в заметках и памяти.`,
        data: { notes: [], kg: [] },
      };
    }

    const lines: string[] = [`Найдено по запросу «${query}»:`];

    if (notes.length > 0) {
      lines.push('📝 **Заметки:**');
      for (const note of notes) {
        lines.push(`• [${note.column}] ${noteText(note)}`);
      }
    }

    if (kgRows.length > 0) {
      lines.push('\n🧠 **Связи в памяти:**');
      for (const row of kgRows.slice(0, 4)) {
        const descPart = row.description?.trim() ? `: ${row.description.trim()}` : '';
        const relPart = row.relation ? ` (${row.relation})` : '';
        lines.push(`• ${row.entity} [${row.kind}]${descPart}${relPart}`);
      }
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        notes: notes.map((note) => ({
          id: note.id,
          column: note.column,
          text: noteText(note),
          created_at: note.createdAt,
        })),
        kg: kgRows.slice(0, 4),
      },
    };
  } catch (error) {
    return fail(`Не удалось выполнить поиск по заметкам: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// edit_note
// ---------------------------------------------------------------------------

async function editNote(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите, какую заметку править (query).');
  const newText = asText(args.new_text);
  if (!newText) return fail('Текст заметки не может быть пустым.');

  try {
    const notes = await listNotes(ctx.userId, { limit: 500 });
    const note = matchNote(notes, query);
    if (!note) return fail(`Не нашёл заметку, похожую на «${query}».`);

    // NotePatch умеет только cleanText/column: raw_text и embedding не трогаем.
    const updated = await updateNote(ctx.userId, note.id, { cleanText: newText });
    if (!updated) return fail(`Не нашёл заметку, похожую на «${query}».`);
    if (args.entities !== undefined || args.relations !== undefined) {
      await ingestNoteKnowledgeGraph(ctx.userId, updated.id, args);
    }

    const title = columnTitle(updated.column);
    return {
      ok: true,
      content: `✅ Заметка в колонке «${title}» обновлена:\n«${newText}»`,
      data: { note_id: updated.id, column: updated.column, clean_text: updated.cleanText },
    };
  } catch (error) {
    return fail(`Не удалось обновить заметку: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// move_note
// ---------------------------------------------------------------------------

async function moveNote(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите, какую заметку переместить (query).');

  const targetRaw = asText(args.target_column);
  const target = normalizeColumn(targetRaw);
  if (!target) {
    const options = (Object.keys(COLUMN_RU) as NoteColumn[])
      .filter((column) => column !== 'trash')
      .map((column) => `«${COLUMN_RU[column]}» (${column})`)
      .join(', ');
    return fail(`Неизвестная колонка «${targetRaw ?? ''}». Доступные колонки: ${options}.`);
  }

  try {
    const notes = await listNotes(ctx.userId, { limit: 500 });
    const note = matchNote(notes, query);
    if (!note) return fail(`Не нашёл заметку, похожую на «${query}».`);

    if (note.column === target) {
      return {
        ok: true,
        content: `Заметка уже находится в колонке «${columnTitle(target)}».`,
        data: { note_id: note.id, column: note.column, moved: false },
      };
    }

    const updated = await updateNote(ctx.userId, note.id, { column: target });
    if (!updated) return fail(`Не нашёл заметку, похожую на «${query}».`);

    return {
      ok: true,
      content: `📦 Заметка «${snippet(noteText(note), 50)}» успешно перемещена в колонку «${columnTitle(target)}».`,
      data: { note_id: updated.id, column: updated.column, moved: true },
    };
  } catch (error) {
    return fail(`Не удалось переместить заметку: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// delete_note
// ---------------------------------------------------------------------------

async function deleteNote(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите, какую заметку удалить (query).');

  try {
    const notes = await listNotes(ctx.userId, { limit: 500 });
    const note = matchNote(notes, query);
    if (!note) return fail(`Не нашёл заметку, похожую на «${query}».`);

    const deleted = await softDeleteNote(ctx.userId, note.id);
    if (!deleted) return fail('Не удалось удалить заметку.');

    return {
      ok: true,
      content: `🗑️ Заметка «${snippet(noteText(note), 50)}» перемещена в корзину (будет храниться 30 дней).`,
      data: { note_id: note.id, deleted: true },
    };
  } catch (error) {
    return fail(`Не удалось удалить заметку: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// get_inbox_digest
// ---------------------------------------------------------------------------

async function getInboxDigest(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const requested = asInt(args.limit);
  const limit = requested === null ? 10 : Math.min(50, Math.max(1, requested));

  try {
    const notes = await listNotes(ctx.userId, { column: 'raw', limit });

    if (notes.length === 0) {
      return {
        ok: true,
        content:
          'В инбоксе и сырых заметках (raw) сейчас пусто. Все мысли разобраны!',
        data: { notes: [], count: 0 },
      };
    }

    const lines: string[] = [`📥 **Неразобранные мысли и инбокс (${notes.length} шт.):**`];
    for (const [index, note] of notes.entries()) {
      const created = fromIso(note.createdAt);
      const stamp = created ? `${dateKey(created, ctx.timezone)} ${timeKey(created, ctx.timezone)}` : '';
      lines.push(`${index + 1}. [Сырое (raw)] ${noteText(note)} _(id=${note.id}, ${stamp})_`);
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        count: notes.length,
        notes: notes.map((note) => ({
          id: note.id,
          column: note.column,
          text: noteText(note),
          created_at: note.createdAt,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось собрать дайджест инбокса: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

const KG_SCHEMA_PROPERTIES = {
  entities: {
    type: 'array',
    description:
      'Опционально: сущности (люди, места, проекты, организации), упомянутые в заметке, для графа знаний.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Основное имя или название сущности.' },
        kind: {
          type: 'string',
          enum: ['person', 'place', 'project', 'org', 'other'],
          description: 'Тип сущности.',
        },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Альтернативные имена или сокращения.',
        },
        description: { type: 'string', description: 'Краткий факт или роль.' },
      },
      required: ['name'],
    },
  },
  relations: {
    type: 'array',
    description:
      'Опционально: связи между сущностями (например: работает в / живёт в / руководит).',
    items: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Имя субъекта.' },
        predicate: { type: 'string', description: 'Предикат (связь).' },
        object: { type: 'string', description: 'Имя объекта.' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
};

export const notesTools: Tool[] = [
  {
    name: 'add_note',
    description:
      'Сохраняет мысль, инсайт или заметку на канбан-доске. Колонка по умолчанию — «Сырое» (raw).',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Содержимое мысли или заметки.' },
        column: {
          type: 'string',
          description:
            'Колонка: raw/inbox/«сырое»/«входящие», idea/ideas/«идеи», note/self/useful/archive/«о себе»/«полезное», todo/possible_tasks/«возможные задачи».',
        },
        ...KG_SCHEMA_PROPERTIES,
      },
      required: ['text'],
    },
    run: addNote,
  },
  {
    name: 'search_notes',
    description:
      'Ищет в заметках и долговременной памяти по смыслу (векторный поиск) и по ключевым словам.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос.' },
      },
      required: ['query'],
    },
    run: searchNotes,
  },
  {
    name: 'edit_note',
    description: 'Редактирует текст существующей заметки на канбан-доске.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Фрагмент текста или ключевые слова заметки.' },
        new_text: { type: 'string', description: 'Новый текст заметки.' },
        ...KG_SCHEMA_PROPERTIES,
      },
      required: ['query', 'new_text'],
    },
    run: editNote,
  },
  {
    name: 'move_note',
    description: 'Перемещает заметку между колонками канбан-доски.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Фрагмент текста заметки.' },
        target_column: {
          type: 'string',
          description: 'Целевая колонка: raw, idea, note, todo (и их русские синонимы).',
        },
      },
      required: ['query', 'target_column'],
    },
    run: moveNote,
  },
  {
    name: 'delete_note',
    description:
      'Удаляет заметку в корзину (хранится 30 дней с возможностью восстановления).',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Фрагмент текста заметки.' },
      },
      required: ['query'],
    },
    run: deleteNote,
  },
  {
    name: 'get_inbox_digest',
    description:
      'Дайджест последних необработанных заметок из «Сырого» (raw) для утреннего разбора.',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Сколько заметок вывести (по умолчанию 10).' },
      },
      required: [],
    },
    run: getInboxDigest,
  },
];
