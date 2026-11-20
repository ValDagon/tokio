/**
 * DELETE /api/trash/{item_type}/{item_id} → `src/endpoints/trash_delete.ts`.
 *
 * Порт `backend/app/api/routes.py::delete_trash_permanently` +
 * `backend/app/services/trash.py::permanently_delete_trash_item`.
 *
 * Окончательное удаление элемента корзины. `item_type` — `'task' | 'note'`
 * (иначе 400), `item_id` — положительный целый id из тела. Нет такого
 * элемента в корзине → 404 `<Task|Note> not found in trash`.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { purgeTrashItem, type TrashItemType } from '../lib/dal/misc.js';

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
): Promise<{ status: 'permanently_deleted'; type: TrashItemType; id: string }> {
  const userId = requireUserId(input, ctx);
  const itemType = readItemType(input);
  const itemId = readItemId(input);

  const purged = await purgeTrashItem(userId, itemType, itemId);
  if (!purged) {
    throw new EndpointError(`${capitalize(itemType)} not found in trash`, { code: 'NOT_FOUND' });
  }
  return { status: 'permanently_deleted', type: itemType, id: String(itemId) };
}
