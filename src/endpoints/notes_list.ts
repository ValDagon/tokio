/**
 * GET /api/notes → `src/endpoints/notes_list.ts`.
 *
 * Порт `backend/app/api/routes.py::get_notes` →
 * `backend/app/services/notes.py::get_user_notes` (`NoteSchema[]`).
 *
 * Паритет:
 *  - только активные заметки (`deleted_at IS NULL`), новые сверху;
 *  - `column` — необязательный фильтр: пустое значение/отсутствие поля —
 *    фильтра нет (upstream `if column:`), иначе точное совпадение.
 *
 * Отличия от upstream: у DAL дефолтный `LIMIT 100`, upstream отдавал весь
 * список без пагинации — передаём `limit: 1000`. В `notes` нет колонки
 * `updated_at`, поэтому в ответе она равна `created_at` (спека T16).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { listNotes } from '../lib/dal/notes.js';
import type { NoteColumn, NoteRow } from '../types.js';

/** `NoteSchema` из routes.py (snake_case). */
export interface NoteSchema {
  id: string;
  raw_text: string;
  clean_text: string | null;
  column: string;
  created_at: string;
  updated_at: string;
}

/** Строка DAL → `NoteSchema`; `updated_at` = `created_at` (колонки нет). */
export function toNoteSchema(note: NoteRow): NoteSchema {
  const createdAt = note.createdAt ?? '';
  return {
    id: String(note.id),
    raw_text: note.rawText,
    clean_text: note.cleanText ?? null,
    column: note.column,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<NoteSchema[]> {
  const userId = requireUserId(input, ctx);

  const rawColumn = input.column;
  let column: NoteColumn | undefined;
  if (rawColumn === undefined || rawColumn === null || rawColumn === '') {
    column = undefined;
  } else if (typeof rawColumn === 'string') {
    // Значение не из `NoteColumn` не ошибка: upstream принимал любую строку,
    // и такая выборка просто пустая.
    column = rawColumn as NoteColumn;
  } else {
    throw new EndpointError('Invalid column', { code: 'BAD_REQUEST' });
  }

  const notes = await listNotes(userId, { column, limit: 1000 });
  return notes.map(toNoteSchema);
}
