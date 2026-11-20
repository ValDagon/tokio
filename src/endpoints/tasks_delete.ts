/**
 * DELETE /api/tasks/{id} — мягкое удаление задачи (id приходит в теле как `id`).
 *
 * Паритет с `backend/app/api/routes.py::delete_task`:
 *  - `soft_delete_task` вернул `false` → 404 `"Task not found or already in trash"`;
 *  - успех → `{status:'deleted', in_trash:true}`.
 *
 * Отличия от upstream (осознанные):
 *  - id в пути upstream — UUID; у нас число из тела, мусор → 400;
 *  - upstream здесь не вызывает `ensure_user` / `ensure_system_categories`
 *    (в отличие от соседних роутов) — повторяем это же поведение;
 *  - удаление корня каскадит на подзадачи внутри `deleteTask`, отдельного
 *    запроса не нужно.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { deleteTask } from '../lib/dal/tasks.js';

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<Record<string, unknown>> {
  const userId = requireUserId(input, ctx);

  const rawId = input.id;
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new EndpointError('Invalid task id', { code: 'BAD_REQUEST' });
  }
  const taskId = Number(rawId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new EndpointError('Invalid task id', { code: 'BAD_REQUEST' });
  }

  const deleted = await deleteTask(userId, taskId);
  if (!deleted) {
    throw new EndpointError('Task not found or already in trash', { code: 'NOT_FOUND' });
  }

  return { status: 'deleted', in_trash: true };
}
