/**
 * POST /api/finances/liabilities/{id}/pay — отметить обязательство оплаченным.
 *
 * Порт `backend/app/api/routes.py::pay_liability_api` +
 * `backend/app/services/liabilities.py::pay_liability`:
 *  - `404 'Обязательство не найдено'`, если активного обязательства нет;
 *  - сумма по умолчанию — месячный платёж (или остаток), можно передать `amount`;
 *  - `deduct_from_account` списывает платёж с баланса счёта (и пишет расход);
 *  - повторный платёж в том же месяце идемпотентен (DAL оставляет всё как есть);
 *  - ответ: `{status, message, new_amount, paid_months}`.
 *
 * Отличия от upstream (задокументированы в T16):
 *  - upstream принимает любой `amount` (даже ≤ 0), DAL требует положительную
 *    сумму — отдаём `BAD_REQUEST`;
 *  - невалидная `payment_date` у upstream молча заменялась сегодняшней — здесь
 *    так же (не строка формата `YYYY-MM-DD` → берём текущую дату);
 *  - `new_amount` — остаток в валюте обязательства (`amount_cents / 100`).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { LiabilityNotFoundError, payLiability } from '../lib/dal/finances.js';

export interface LiabilityPayResponse {
  status: 'ok';
  message: string;
  new_amount: number;
  paid_months: string[];
}

function parseId(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw new EndpointError(`${field} must be a positive integer`, { code: 'BAD_REQUEST' });
  }
  return parsed;
}

function parseNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new EndpointError(`${field} must be a number`, { code: 'BAD_REQUEST' });
  }
  return parsed;
}

/** Строго `YYYY-MM-DD` и существующая дата; иначе upstream брал сегодня. */
function parsePaymentDate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new EndpointError('payment_date must be a string', { code: 'BAD_REQUEST' });
  }
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return undefined;
  }
  return raw;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<LiabilityPayResponse> {
  const userId = requireUserId(input, ctx);

  const liabilityId = parseId(input.id ?? input.liability_id, 'id');
  const paymentDate = parsePaymentDate(input.payment_date);

  let amountCents: number | undefined;
  if (input.amount !== undefined && input.amount !== null) {
    const amount = parseNumber(input.amount, 'amount');
    amountCents = Math.round(amount * 100);
    if (amountCents <= 0) {
      throw new EndpointError('amount must be greater than zero', { code: 'BAD_REQUEST' });
    }
  }

  let accountId: number | undefined;
  if (input.account_id !== undefined && input.account_id !== null) {
    accountId = parseId(input.account_id, 'account_id');
  }

  const deductFromAccount = input.deduct_from_account === true;

  let result;
  try {
    result = await payLiability(userId, {
      liabilityId,
      amountCents,
      accountId,
      deductFromAccount,
      paymentDate,
    });
  } catch (error) {
    if (error instanceof LiabilityNotFoundError) {
      throw new EndpointError('Обязательство не найдено', { code: 'NOT_FOUND' });
    }
    throw error;
  }

  return {
    status: 'ok',
    message: `Обязательство «${result.liability.name}» отмечено как оплаченное`,
    new_amount: result.liability.amountCents / 100,
    paid_months: [...result.liability.paidMonths],
  };
}
