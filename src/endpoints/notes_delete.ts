/**
 * DELETE /api/notes → `src/endpoints/notes_delete.ts`.
 *
 * Порт `backend/app/api/routes.py::delete_note` +
 * `backend/app/services/trash.py::soft_delete_note`.
 *
 * Мягкое удаление (в корзину): проставляем `deleted_at`, колонку не меняем.
 * Уже удалённая/чужая/несуществующая заметка → 404
 * `Note not found or already in trash`.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { deleteNote } from '../lib/dal/notes.js';

/** Положительный целочисленный id из тела (upstream — path `UUID`). */
function readId(input: Record<string, unknown>): number {
  const raw = input.id;
  const parsed = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EndpointError('Invalid id', { code: 'BAD_REQUEST' });
  }
  return parsed;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<{ status: 'deleted'; in_trash: true }> {
  const userId = requireUserId(input, ctx);
  const noteId = readId(input);

  const deleted = await deleteNote(userId, noteId);
  if (!deleted) {
    throw new EndpointError('Note not found or already in trash', { code: 'NOT_FOUND' });
  }
  return { status: 'deleted', in_trash: true };
}
