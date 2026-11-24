/**
 * GET /api/finances/summary — месячная сводка финансов.
 *
 * Порт `backend/app/api/routes.py::get_finance_summary` +
 * `backend/app/services/accounts.py::get_finance_summary_data`:
 *  - `total_net_worth_eur` — сумма EUR-эквивалентов активных счетов;
 *  - `total_spent_eur` / `total_income_eur` — суммы `amount_eur` за текущий месяц;
 *  - `categories` — только расходные категории, у которых есть траты или бюджет,
 *    отсортированные по тратам убыванию (как upstream `ORDER BY spent_eur DESC`);
 *  - `percent_used` = spent / limit * 100 с округлением до 1 знака, `null` без бюджета.
 *
 * Отличия от upstream (задокументированы в T16):
 *  - месяц берётся по UTC (`todayIso()`), upstream использует серверное локальное время;
 *  - `listTransactions` жёстко ограничивает выборку 500 строками (upstream — без лимита),
 *    поэтому при >500 операциях в месяце итоги недосчитаются;
 *  - без курса валюты upstream берёт fallback-курс, здесь баланс в EUR считается нулём.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { BASE_CURRENCY, convert, getRates, hasRate, todayIso } from '../lib/dal/fx.js';
import {
  listAccounts,
  listBudgets,
  listCategories,
  listTransactions,
} from '../lib/dal/finances.js';

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;

function balanceEurCents(cents: number, currency: string, rates: Record<string, number>): number {
  if (currency.toUpperCase() === BASE_CURRENCY) return Math.round(cents);
  if (!hasRate(currency, rates)) return 0;
  try {
    return convert(cents, currency, BASE_CURRENCY, rates);
  } catch {
    return 0;
  }
}

function monthRange(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export interface CategorySpendingResponse {
  category_id: string | null;
  category_name: string;
  spent_eur: number;
  limit_eur: number | null;
  percent_used: number | null;
}

export interface FinanceSummaryResponse {
  total_net_worth_eur: number;
  month: string;
  total_spent_eur: number;
  total_income_eur: number;
  total_budgeted_eur: number;
  total_budgeted_spent_eur: number;
  categories: CategorySpendingResponse[];
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<FinanceSummaryResponse> {
  const userId = requireUserId(input, ctx);

  const month = todayIso().slice(0, 7);
  const { from, to } = monthRange(month);

  const [accounts, rates, transactions, categories, budgets] = await Promise.all([
    listAccounts(userId),
    getRates(),
    listTransactions(userId, { from, to, limit: 500 }),
    listCategories(userId, 'expense'),
    listBudgets(userId, month),
  ]);

  let netWorthCents = 0;
  for (const account of accounts) {
    netWorthCents += balanceEurCents(account.currentBalanceCents, account.currency, rates);
  }

  let totalSpentCents = 0;
  let totalIncomeCents = 0;
  const spentByCategory = new Map<number, number>();

  for (const transaction of transactions) {
    if (transaction.kind === 'expense') {
      totalSpentCents += transaction.amountEurCents;
      if (transaction.categoryId !== null) {
        spentByCategory.set(
          transaction.categoryId,
          (spentByCategory.get(transaction.categoryId) ?? 0) + transaction.amountEurCents,
        );
      }
    } else if (transaction.kind === 'income') {
      totalIncomeCents += transaction.amountEurCents;
    }
  }

  const limitByCategory = new Map<number, number>();
  let totalBudgetedCents = 0;
  let totalBudgetedSpentCents = 0;
  for (const budget of budgets) {
    limitByCategory.set(budget.categoryId, budget.limitAmountEurCents);
    totalBudgetedCents += budget.limitAmountEurCents;
    totalBudgetedSpentCents += spentByCategory.get(budget.categoryId) ?? 0;
  }

  const categoryRows: CategorySpendingResponse[] = [];
  for (const category of categories) {
    const spentCents = spentByCategory.get(category.id) ?? 0;
    const limitCents = limitByCategory.get(category.id);
    if (spentCents <= 0 && limitCents === undefined) continue;

    const spentEur = round2(spentCents / 100);
    const limitEur = limitCents === undefined ? null : limitCents / 100;
    const percentUsed =
      limitEur !== null && limitEur > 0 ? round1((spentEur / limitEur) * 100) : null;

    categoryRows.push({
      category_id: String(category.id),
      category_name: category.name,
      spent_eur: spentEur,
      limit_eur: limitEur,
      percent_used: percentUsed,
    });
  }

  categoryRows.sort(
    (a, b) =>
      b.spent_eur - a.spent_eur ||
      (b.limit_eur ?? 0) - (a.limit_eur ?? 0) ||
      a.category_name.localeCompare(b.category_name),
  );

  return {
    total_net_worth_eur: round2(netWorthCents / 100),
    month,
    total_spent_eur: round2(totalSpentCents / 100),
    total_income_eur: round2(totalIncomeCents / 100),
    total_budgeted_eur: round2(totalBudgetedCents / 100),
    total_budgeted_spent_eur: round2(totalBudgetedSpentCents / 100),
    categories: categoryRows,
  };
}
