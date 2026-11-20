/**
 * PATCH /api/notes → `src/endpoints/notes_update.ts`.
 *
 * Порт `backend/app/api/routes.py::update_note` →
 * `backend/app/services/notes.py::update_user_note` (`NoteSchema`).
 *
 * Паритет:
 *  - `clean_text`/`column` применяются только если реально переданы строкой:
 *    pydantic `str | None = None` означает, что явный `null` поле НЕ очищает;
 *  - `clean_text` пишется как есть, `column` — любая строка (upstream не
 *    валидировал значение по списку);
 *  - заметка не найдена/в корзине → 404 `Note not found`.
 *
 * Отличия: `updated_at` в ответе = `created_at` (в `notes` нет такой колонки).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { updateNote, type NotePatch } from '../lib/dal/notes.js';
import type { NoteColumn } from '../types.js';
import { toNoteSchema, type NoteSchema } from './notes_list.js';

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
): Promise<NoteSchema> {
  const userId = requireUserId(input, ctx);
  const noteId = readId(input);

  const patch: NotePatch = {};
  if (typeof input.raw_text === 'string') patch.rawText = input.raw_text;
  if (typeof input.clean_text === 'string') patch.cleanText = input.clean_text;
  if (typeof input.column === 'string') patch.column = input.column as NoteColumn;

  const updated = await updateNote(userId, noteId, patch);
  if (!updated) {
    throw new EndpointError('Note not found', { code: 'NOT_FOUND' });
  }
  return toNoteSchema(updated);
}
