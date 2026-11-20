/**
 * GET /api/trash → `src/endpoints/trash_list.ts`.
 *
 * Порт `backend/app/api/routes.py::get_trash` →
 * `backend/app/services/trash.py::list_trash_items` (`TrashResponseSchema`).
 *
 * DAL уже отдаёт готовые элементы корзины; здесь только перекладываем
 * camelCase → snake_case, id — строкой. `kind` из DAL в ответ не попадает:
 * в upstream-схемах задачи и заметки лежат в разных массивах.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { listTrash, type TrashList } from '../lib/dal/misc.js';

/** `TrashTaskItem` из routes.py. */
export interface TrashTaskSchema {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  category_id: string | null;
  category_name: string;
  steps_count: number;
  created_at: string | null;
  deleted_at: string | null;
  days_remaining: number;
}

/** `TrashNoteItem` из routes.py. */
export interface TrashNoteSchema {
  id: string;
  raw_text: string;
  clean_text: string | null;
  column: string;
  created_at: string | null;
  deleted_at: string | null;
  days_remaining: number;
}

/** `TrashResponseSchema` из routes.py. */
export interface TrashResponseSchema {
  tasks: TrashTaskSchema[];
  notes: TrashNoteSchema[];
  total_count: number;
}

/** Перекладывает ответ DAL в snake_case-схему ответа. */
export function toTrashResponse(trash: TrashList): TrashResponseSchema {
  return {
    tasks: trash.tasks.map((task) => ({
      id: String(task.id),
      title: task.title,
      notes: task.notes,
      status: task.status,
      category_id: task.categoryId === null ? null : String(task.categoryId),
      category_name: task.categoryName,
      steps_count: task.stepsCount,
      created_at: task.createdAt,
      deleted_at: task.deletedAt,
      days_remaining: task.daysRemaining,
    })),
    notes: trash.notes.map((note) => ({
      id: String(note.id),
      raw_text: note.rawText,
      clean_text: note.cleanText,
      column: note.column,
      created_at: note.createdAt,
      deleted_at: note.deletedAt,
      days_remaining: note.daysRemaining,
    })),
    total_count: trash.totalCount,
  };
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<TrashResponseSchema> {
  const userId = requireUserId(input, ctx);

  const trash = await listTrash(userId);
  return toTrashResponse(trash);
}
