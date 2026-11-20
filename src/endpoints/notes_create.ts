/**
 * POST /api/notes → `src/endpoints/notes_create.ts`.
 *
 * Порт `backend/app/api/routes.py::create_note` →
 * `backend/app/services/notes.py::create_user_note` (`NoteSchema`).
 *
 * Паритет:
 *  - `ensureUser` перед вставкой (upstream делал
 *    `INSERT INTO users … ON CONFLICT DO NOTHING` ради FK);
 *  - `raw_text` обрезается по краям, `clean_text` всегда `NULL`;
 *  - переданная `column` сохраняется как есть.
 *
 * Отличия (осознанные): дефолтная колонка новой заметки — `'raw'`, а не
 * `'inbox'`: набор допустимых значений задаёт `NoteColumn` платформы.
 * `updated_at` в ответе = `created_at` (колонки `updated_at` нет).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { createNote } from '../lib/dal/notes.js';
import { ensureUser } from '../lib/dal/users.js';
import type { NoteColumn } from '../types.js';
import { toNoteSchema, type NoteSchema } from './notes_list.js';

const DEFAULT_COLUMN: NoteColumn = 'raw';

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<NoteSchema> {
  const userId = requireUserId(input, ctx);

  const text = input.text;
  if (typeof text !== 'string') {
    throw new EndpointError('Invalid text', { code: 'BAD_REQUEST' });
  }

  const rawColumn = input.column;
  let column: NoteColumn = DEFAULT_COLUMN;
  if (rawColumn !== undefined && rawColumn !== null && rawColumn !== '') {
    if (typeof rawColumn !== 'string') {
      throw new EndpointError('Invalid column', { code: 'BAD_REQUEST' });
    }
    // Любая строка, как в upstream (`col = body.column or "inbox"`).
    column = rawColumn as NoteColumn;
  }

  await ensureUser(userId);
  const note = await createNote(userId, text, { column });
  return toNoteSchema(note);
}
