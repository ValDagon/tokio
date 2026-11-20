/**
 * Тулзы агента: корзина (SPEC §3 T12, паритет с
 * `backend/app/agent/tools/trash.py`).
 *
 * Отличия от upstream (осознанно, SPEC §8):
 *  - идентификаторы — числовые (`id`), а не UUID: в порте PK — integer;
 *  - корзина читается через `listTrash` (только корневые задачи и заметки,
 *    `daysRemaining` считает DAL от `Date.now()`);
 *  - неизвестный `item_type` — `ok:false` с подсказкой (upstream молча
 *    фильтровал выдачу).
 */

import type { TrashList, TrashNoteItem, TrashTaskItem } from '../../dal/misc';
import { emptyTrash, listTrash, restoreTrashItem } from '../../dal/misc';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import { asText, errorText, fail, snippet } from './tasks';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function noteText(note: TrashNoteItem): string {
  return (note.cleanText ?? note.rawText ?? '').trim();
}

/** Поиск удалённой задачи по названию (без учёта регистра). */
function matchTrashTask(tasks: readonly TrashTaskItem[], query: string): TrashTaskItem | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  return tasks.find((task) => task.title.toLowerCase().includes(needle)) ?? null;
}

/** Поиск удалённой заметки по фрагменту текста. */
function matchTrashNote(notes: readonly TrashNoteItem[], query: string): TrashNoteItem | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  return (
    notes.find((note) => `${note.rawText ?? ''}\n${note.cleanText ?? ''}`.toLowerCase().includes(needle)) ??
    null
  );
}

// ---------------------------------------------------------------------------
// view_trash
// ---------------------------------------------------------------------------

async function viewTrash(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const trash: TrashList = await listTrash(ctx.userId);
    if (trash.totalCount === 0) {
      return {
        ok: true,
        content:
          'Корзина пуста. Все удалённые задачи и заметки хранятся 30 дней перед автоочисткой.',
        data: { tasks: [], notes: [], total_count: 0 },
      };
    }

    const lines: string[] = [
      `🗑️ В корзине ${trash.totalCount} объектов (хранятся 30 дней):`,
    ];

    if (trash.tasks.length > 0) {
      lines.push('\n📋 **Задачи:**');
      for (const task of trash.tasks) {
        const steps = task.stepsCount > 0 ? ` (${task.stepsCount} шагов)` : '';
        lines.push(
          `• ${task.title} [${task.categoryName}]${steps} — удалится через ${task.daysRemaining} дн. (id: ${task.id})`,
        );
      }
    }

    if (trash.notes.length > 0) {
      lines.push('\n📝 **Заметки:**');
      for (const note of trash.notes) {
        lines.push(
          `• [${note.column}] «${snippet(noteText(note), 60)}» — удалится через ${note.daysRemaining} дн. (id: ${note.id})`,
        );
      }
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        total_count: trash.totalCount,
        tasks: trash.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          category: task.categoryName,
          steps_count: task.stepsCount,
          days_remaining: task.daysRemaining,
        })),
        notes: trash.notes.map((note) => ({
          id: note.id,
          column: note.column,
          text: noteText(note),
          days_remaining: note.daysRemaining,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось открыть корзину: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// restore_from_trash
// ---------------------------------------------------------------------------

/** Тип элемента из аргумента: `task`/`note` (RU-синонимы допускаются). */
function readItemType(value: unknown): 'task' | 'note' | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === 'task' || lower === 'задача') return 'task';
  if (lower === 'note' || lower === 'заметка') return 'note';
  return undefined;
}

async function restoreFromTrash(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Укажите задачу, заметку или id элемента корзины (query).');

  const itemType = readItemType(args.item_type);
  if (itemType === undefined) {
    return fail('item_type — «task» или «note» (или не указывайте вовсе).');
  }

  try {
    // 1. Числовой id (в upstream был UUID): задача, затем заметка.
    if (/^\d+$/.test(query)) {
      const id = Number(query);
      const order: Array<'task' | 'note'> = itemType ? [itemType] : ['task', 'note'];
      for (const type of order) {
        const restored = await restoreTrashItem(ctx.userId, type, id);
        if (restored) {
          return {
            ok: true,
            content: `✅ Элемент ${type} успешно восстановлен из корзины!`,
            data: { item_type: type, item_id: id, restored: true },
          };
        }
      }
      return fail(`Не найден элемент с ID ${query} в корзине.`);
    }

    const trash = await listTrash(ctx.userId);

    // 2. Задача по названию.
    if (itemType !== 'note') {
      const task = matchTrashTask(trash.tasks, query);
      if (task) {
        const restored = await restoreTrashItem(ctx.userId, 'task', task.id);
        if (restored) {
          return {
            ok: true,
            content: `✅ Задача «${task.title}» успешно восстановлена из корзины!`,
            data: { item_type: 'task', item_id: task.id, restored: true },
          };
        }
      }
    }

    // 3. Заметка по фрагменту текста.
    if (itemType !== 'task') {
      const note = matchTrashNote(trash.notes, query);
      if (note) {
        const restored = await restoreTrashItem(ctx.userId, 'note', note.id);
        if (restored) {
          return {
            ok: true,
            content: `✅ Заметка «${noteText(note).slice(0, 40)}...» успешно восстановлена из корзины!`,
            data: { item_type: 'note', item_id: note.id, restored: true },
          };
        }
      }
    }

    return fail(`Не удалось найти элемент, похожий на «${query}», в корзине.`);
  } catch (error) {
    return fail(`Не удалось восстановить элемент из корзины: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// clear_trash
// ---------------------------------------------------------------------------

async function clearTrash(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const result = await emptyTrash(ctx.userId);
    return {
      ok: true,
      content: `🗑️ Корзина очищена: удалено ${result.tasksPurged} задач и ${result.notesPurged} заметок навсегда.`,
      data: {
        tasks_purged: result.tasksPurged,
        notes_purged: result.notesPurged,
      },
    };
  } catch (error) {
    return fail(`Не удалось очистить корзину: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

export const trashTools: Tool[] = [
  {
    name: 'view_trash',
    description:
      'Показывает содержимое корзины (удалённые задачи и заметки) и сколько дней осталось до автоочистки.',
    schema: { type: 'object', properties: {}, required: [] },
    run: viewTrash,
  },
  {
    name: 'restore_from_trash',
    description: 'Восстанавливает удалённую задачу или заметку из корзины по названию, фразе или id.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название задачи, фрагмент текста заметки или id.' },
        item_type: { type: 'string', description: 'Опционально: «task» или «note».' },
      },
      required: ['query'],
    },
    run: restoreFromTrash,
  },
  {
    name: 'clear_trash',
    destructive: true,
    description: 'Полностью и безвозвратно очищает корзину пользователя.',
    schema: { type: 'object', properties: {}, required: [] },
    run: clearTrash,
  },
];

