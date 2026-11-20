/**
 * POST /api/finances/accounts/{id}/balance — ручная правка остатка счёта.
 *
 * Порт `backend/app/api/routes.py::update_account_balance` +
 * `backend/app/services/accounts.py::update_account_balance`:
 *  - тело `BalanceUpdateSchema`: `balance` (float в валюте счёта);
 *  - ответ эхом отдаёт сумму и `status: 'ok'`.
 *
 * Отличие от upstream (задокументировано в T16): upstream делает «слепой»
 * `UPDATE ... WHERE id AND telegram_id` и возвращает `ok` даже для
 * несуществующего/чужого счёта. `setAccountBalance` в этом случае бросает
 * исключение, поэтому здесь сначала проверяем счёт через `getAccount`:
 * если его нет — просто возвращаем `ok` без записи (паритет по ответу).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { getAccount, setAccountBalance } from '../lib/dal/finances.js';

export interface AccountBalanceSetResponse {
  status: 'ok';
  balance: number;
}

function parseId(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw new EndpointError('account_id must be a positive integer', { code: 'BAD_REQUEST' });
  }
  return parsed;
}

function parseNumber(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new EndpointError('balance must be a number', { code: 'BAD_REQUEST' });
  }
  return parsed;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<AccountBalanceSetResponse> {
  const userId = requireUserId(input, ctx);

  const accountId = parseId(input.account_id ?? input.id);
  const balance = parseNumber(input.balance);

  const account = await getAccount(userId, accountId);
  if (account) {
    await setAccountBalance(userId, accountId, Math.round(balance * 100));
  }

  return { status: 'ok', balance };
}
