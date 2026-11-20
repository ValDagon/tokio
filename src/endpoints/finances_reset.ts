/**
 * POST /api/finances/reset — очистка истории операций (балансы сохраняются).
 *
 * Порт `backend/app/api/routes.py::reset_finances`:
 *  - удаляет все транзакции пользователя (без подтверждения — как REST-роут);
 *  - отвечает `{status: 'ok', message: 'Финансовая история очищена'}`.
 *
 * DAL `resetTransactions` не трогает `accounts.current_balance`, т.е. поведение
 * совпадает с upstream `DELETE FROM ag.transactions`.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { resetTransactions } from '../lib/dal/finances.js';

export interface ResetResponse {
  status: 'ok';
  message: string;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<ResetResponse> {
  const userId = requireUserId(input, ctx);

  await resetTransactions(userId);

  return { status: 'ok', message: 'Финансовая история очищена' };
}
