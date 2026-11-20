/**
 * POST /api/trash/empty → `src/endpoints/trash_empty.ts`.
 *
 * Порт `backend/app/api/routes.py::empty_trash_endpoint` +
 * `backend/app/services/trash.py::empty_user_trash`.
 *
 * Удаляет всё содержимое корзины пользователя и возвращает количество
 * удалённых задач/заметок.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { emptyTrash } from '../lib/dal/misc.js';

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<{ status: 'emptied'; tasks_purged: number; notes_purged: number }> {
  const userId = requireUserId(input, ctx);

  const result = await emptyTrash(userId);
  return {
    status: 'emptied',
    tasks_purged: result.tasksPurged,
    notes_purged: result.notesPurged,
  };
}
