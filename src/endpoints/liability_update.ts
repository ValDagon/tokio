/**
 * PATCH /api/finances/liabilities/{id} — частичное обновление обязательства.
 *
 * Порт `backend/app/api/routes.py::update_liability_api`:
 *  - `404 'Обязательство не найдено'`, если обязательства нет у пользователя;
 *  - `400 'Счёт не найден'`, если передан чужой/несуществующий `account_id`;
 *  - патчатся только переданные (не `null`) поля: `account_id`, `notes`,
 *    `monthly_payment`, `payment_day`;
 *  - возвращается полный `LiabilitySchema` (с `account_name` из LEFT JOIN).
 *
 * Отличия от upstream (задокументированы в T16):
 *  - `payment_day` проверяем на целое 1..31 (DAL `assertPaymentDay`), upstream
 *    pydantic принимал любое целое и падал уже в SQL/CHECK;
 *  - «нет месячного платежа» в DAL — `0` центов, поэтому `0` отдаём как `null`;
 *  - текущий месяц для `is_paid_this_month` считается по UTC.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import {
  getAccount,
  getLiability,
  updateLiability,
  type UpdateLiabilityInput,
} from '../lib/dal/finances.js';
import { todayIso, getRates, toEurCents } from '../lib/dal/fx.js';

export interface LiabilityResponse {
  id: string;
  name: string;
  queue: string;
  amount: number;
  currency: string;
  amount_eur: number;
  monthly_payment: number | null;
  payment_day: number | null;
  total_payments: number | null;
  end_date: string | null;
  notes: string | null;
  is_active: boolean;
  paid_months: string[];
  is_paid_this_month: boolean;
  last_payment_date: string | null;
  account_id: string | null;
  account_name: string | null;
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

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<LiabilityResponse> {
  const userId = requireUserId(input, ctx);

  const liabilityId = parseId(input.id ?? input.liability_id, 'id');

  const existing = await getLiability(userId, liabilityId);
  if (!existing) {
    throw new EndpointError('Обязательство не найдено', { code: 'NOT_FOUND' });
  }

  const patch: UpdateLiabilityInput = {};

  if (input.account_id !== undefined && input.account_id !== null) {
    const accountId = parseId(input.account_id, 'account_id');
    const account = await getAccount(userId, accountId);
    if (!account) {
      throw new EndpointError('Счёт не найден', { code: 'BAD_REQUEST' });
    }
    patch.accountId = accountId;
  }

  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string') {
      throw new EndpointError('notes must be a string', { code: 'BAD_REQUEST' });
    }
    patch.notes = input.notes;
  }

  if (input.monthly_payment !== undefined && input.monthly_payment !== null) {
    const monthlyPayment = parseNumber(input.monthly_payment, 'monthly_payment');
    patch.monthlyPaymentCents = Math.round(monthlyPayment * 100);
  }

  if (input.payment_day !== undefined && input.payment_day !== null) {
    const paymentDay = parseNumber(input.payment_day, 'payment_day');
    if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) {
      throw new EndpointError('payment_day must be an integer between 1 and 31', {
        code: 'BAD_REQUEST',
      });
    }
    patch.paymentDay = paymentDay;
  }

  // Выключение вместо удаления: подписка уходит из списков и из runway,
  // история платежей остаётся.
  if (input.is_active !== undefined && input.is_active !== null) {
    if (typeof input.is_active !== 'boolean') {
      throw new EndpointError('is_active must be a boolean', { code: 'BAD_REQUEST' });
    }
    patch.isActive = input.is_active;
  }

  const liability = Object.keys(patch).length
    ? await updateLiability(userId, liabilityId, patch)
    : existing;

  const account =
    liability.accountId === null ? null : await getAccount(userId, liability.accountId);
  const month = todayIso().slice(0, 7);
  const rates = await getRates();

  return {
    id: String(liability.id),
    name: liability.name,
    queue: liability.queue,
    amount: liability.amountCents / 100,
    currency: liability.currency,
    amount_eur:
      (toEurCents(liability.amountCents, liability.currency, rates) ??
        liability.amountEurCents) / 100,
    monthly_payment:
      liability.monthlyPaymentCents === 0 ? null : liability.monthlyPaymentCents / 100,
    payment_day: liability.paymentDay,
    total_payments: liability.totalPayments,
    end_date: liability.endDate,
    notes: liability.notes,
    is_active: liability.isActive,
    paid_months: [...liability.paidMonths],
    is_paid_this_month: liability.paidMonths.includes(month),
    last_payment_date: liability.lastPaymentDate,
    account_id: liability.accountId === null ? null : String(liability.accountId),
    account_name: account?.name ?? null,
  };
}
