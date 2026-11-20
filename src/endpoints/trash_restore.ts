/**
 * POST /api/trash/restore → `src/endpoints/trash_restore.ts`.
 *
 * Порт `backend/app/api/routes.py::restore_trash` +
 * `backend/app/services/trash.py::restore_trash_item`.
 *
 * `item_type` — только `'task' | 'note'` (иначе 400 с текстом upstream);
 * `item_id` — положительный целый id из тела. Нечего восстанавливать → 404
 * `<Task|Note> not found in trash`.
 *
 * Отличие от upstream: невалидный `item_type` там отсекался pydantic
 * (`Literal`) как 422, здесь — 400 по спеке T16.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { restoreTrashItem, type TrashItemType } from '../lib/dal/misc.js';

const INVALID_TYPE_MESSAGE = "Invalid item type. Must be 'task' or 'note'";

function readItemType(input: Record<string, unknown>): TrashItemType {
  const raw = input.item_type;
  if (raw === 'task' || raw === 'note') return raw;
  throw new EndpointError(INVALID_TYPE_MESSAGE, { code: 'BAD_REQUEST' });
}

function readItemId(input: Record<string, unknown>): number {
  const raw = input.item_id;
  const parsed = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EndpointError('Invalid item_id', { code: 'BAD_REQUEST' });
  }
  return parsed;
}

function capitalize(value: TrashItemType): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<{ status: 'restored'; type: TrashItemType; id: string }> {
  const userId = requireUserId(input, ctx);
  const itemType = readItemType(input);
  const itemId = readItemId(input);

  const restored = await restoreTrashItem(userId, itemType, itemId);
  if (!restored) {
    throw new EndpointError(`${capitalize(itemType)} not found in trash`, { code: 'NOT_FOUND' });
  }
  return { status: 'restored', type: itemType, id: String(itemId) };
}
