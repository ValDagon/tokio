/**
 * GET /api/finances/transactions — последние операции с именами счёта/категории.
 *
 * Порт `backend/app/api/routes.py::get_transactions` +
 * `backend/app/services/accounts.py::get_user_transactions`:
 *  - `limit` по умолчанию 50, `offset` upstream принимает, но не использует;
 *  - `account_name` / `to_account_name` / `category_name` — имена из JOIN;
 *  - деньги отдаются float в валюте операции (`amount`) и в EUR (`amount_eur`).
 *
 * Отличия от upstream (задокументированы в T16):
 *  - `listTransactions` ограничивает `limit` диапазоном 1..500 (upstream — без потолка);
 *  - имена счетов берутся из `listAccounts({includeInactive:true})`, категории —
 *    из `listCategories`; при «висячем» id (строка ссылается на удалённую запись)
 *    отдаём `''` / `null` как это делал LEFT JOIN upstream.
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { listAccounts, listCategories, listTransactions } from '../lib/dal/finances.js';
import type { TransactionRow } from '../types.js';

export interface TransactionItemResponse {
  id: string;
  occurred_at: string;
  kind: string;
  amount: number;
  currency: string;
  amount_eur: number;
  fx_rate: number;
  account_name: string;
  to_account_name: string | null;
  category_name: string | null;
  description: string | null;
  /** Ноги одного обмена делят этот id: Mini App показывает их одной строкой. */
  transfer_group_id: string | null;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return 50;
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new EndpointError('limit must be an integer', { code: 'BAD_REQUEST' });
  }
  return parsed;
}

/**
 * Строки транзакций в форме ответа API. Один маппер на чтение (GET) и на запись
 * (POST /api/finances/transactions), чтобы форма ответа не разъезжалась.
 */
export async function toTransactionItems(
  userId: number,
  rows: readonly TransactionRow[],
): Promise<TransactionItemResponse[]> {
  if (rows.length === 0) return [];

  const [accounts, categories] = await Promise.all([
    listAccounts(userId, { includeInactive: true }),
    listCategories(userId),
  ]);

  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  return rows.map((transaction) => ({
    id: String(transaction.id),
    occurred_at: transaction.occurredAt,
    kind: transaction.kind,
    amount: transaction.amountCents / 100,
    currency: transaction.currency,
    amount_eur: transaction.amountEurCents / 100,
    fx_rate: transaction.fxRate,
    account_name: accountNames.get(transaction.accountId) ?? '',
    to_account_name:
      transaction.toAccountId === null
        ? null
        : accountNames.get(transaction.toAccountId) ?? null,
    category_name:
      transaction.categoryId === null
        ? null
        : categoryNames.get(transaction.categoryId) ?? null,
    description: transaction.description,
    transfer_group_id: transaction.transferGroupId,
  }));
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<TransactionItemResponse[]> {
  const userId = requireUserId(input, ctx);

  // `offset` upstream объявлен в сигнатуре, но в SQL не попадает — игнорируем.
  const limit = parseLimit(input.limit);

  const transactions = await listTransactions(userId, { limit });
  return toTransactionItems(userId, transactions);
}

