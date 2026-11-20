/**
 * GET /api/finances/liabilities — активные обязательства пользователя.
 *
 * Порт `backend/app/api/routes.py::get_liabilities` (inline SQL + LEFT JOIN accounts):
 *  - `is_paid_this_month` = текущий месяц (`YYYY-MM`) есть в `paid_months`;
 *  - `account_name` — имя привязанного счёта (LEFT JOIN);
 *  - `monthly_payment` = `null`, если платёж не задан.
 *
 * Отличия от upstream (задокументированы в T16):
 *  - порядок: DAL сортирует `subscription/service/queue_1..queue_4`, upstream —
 *    `bank/queue_1..queue_3/investors`; типы очередей в TS-схеме другие;
 *  - DAL хранит «нет месячного платежа» как `0` центов → отдаём `null`;
 *  - текущий месяц считается по UTC (`todayIso()`), upstream — локальное время.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { listAccounts, listLiabilities } from '../lib/dal/finances.js';
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

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<LiabilityResponse[]> {
  const userId = requireUserId(input, ctx);

  const month = todayIso().slice(0, 7);
  const [liabilities, accounts] = await Promise.all([
    listLiabilities(userId, 'active'),
    listAccounts(userId, { includeInactive: true }),
  ]);

  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const rates = await getRates();

  return liabilities.map((liability) => ({
    id: String(liability.id),
    name: liability.name,
    queue: liability.queue,
    amount: liability.amountCents / 100,
    currency: liability.currency,
    // Живой курс, а не сохранённый amount_eur_cents: иначе тот же платёж
    // показывается здесь и в /runway двумя разными суммами.
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
    account_name:
      liability.accountId === null ? null : accountNames.get(liability.accountId) ?? null,
  }));
}
