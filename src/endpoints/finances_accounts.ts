/**
 * GET /api/finances/accounts — активные счета с балансами в EUR.
 *
 * Порт `backend/app/api/routes.py::get_accounts` +
 * `backend/app/services/accounts.py::get_user_accounts`:
 *  - только активные счета (`listAccounts` по умолчанию фильтрует `is_active`);
 *  - `balance_eur` = баланс, сконвертированный в EUR и округлённый до 2 знаков;
 *  - id отдаются строками (платформенные id числовые, upstream — UUID).
 *
 * Отличие от upstream: при отсутствии курса валюты upstream берёт fallback-курс
 * (`FALLBACK_RATES` в `services/fx.py`), а TS-курсов может не быть вовсе —
 * тогда `balance_eur = 0` (как `accountEurCents` в `src/lib/runway.ts`).
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { BASE_CURRENCY, convert, getRates, hasRate } from '../lib/dal/fx.js';
import { listAccounts } from '../lib/dal/finances.js';

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Пересчёт остатка счёта в EUR-центы. Экспортируется, потому что тот же ответ
 * отдают PATCH/POST `/api/finances/accounts` в `rpc.ts`: один источник правды,
 * иначе мутирующая ручка рапортует баланс в валюте счёта как евро (Wallet 42.28
 * USD → «42.28 EUR»).
 */
export function balanceEurCents(cents: number, currency: string, rates: Record<string, number>): number {
  if (currency.toUpperCase() === BASE_CURRENCY) return Math.round(cents);
  if (!hasRate(currency, rates)) return 0;
  try {
    return convert(cents, currency, BASE_CURRENCY, rates);
  } catch {
    return 0;
  }
}

export interface AccountResponse {
  id: string;
  name: string;
  currency: string;
  current_balance: number;
  balance_eur: number;
  is_active: boolean;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<AccountResponse[]> {
  const userId = requireUserId(input, ctx);

  const [accounts, rates] = await Promise.all([listAccounts(userId), getRates()]);

  return accounts.map((account) => ({
    id: String(account.id),
    name: account.name,
    currency: account.currency,
    current_balance: account.currentBalanceCents / 100,
    balance_eur: round2(balanceEurCents(account.currentBalanceCents, account.currency, rates) / 100),
    is_active: account.isActive,
  }));
}
