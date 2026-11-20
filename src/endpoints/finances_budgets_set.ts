/**
 * POST /api/finances/budgets — лимит бюджета категории на текущий месяц.
 *
 * Порт `backend/app/api/routes.py::set_category_budget` +
 * `backend/app/services/accounts.py::set_user_budget`:
 *  - тело `BudgetSetSchema`: `category_name` + `limit_amount_eur` (float в EUR);
 *  - категория ищется по имени (get-or-create расходной), месяц — текущий;
 *  - ответ эхом отдаёт входную сумму в EUR, месяц и `status: 'ok'`.
 *
 * Отличия/уточнения (задокументированы в T16):
 *  - месяц берётся по UTC (`todayIso()`), upstream — по локальному времени сервера;
 *  - дополнительно принимаем `category_id` (fallback из спеки), если имени нет:
 *    категория должна существовать и быть расходной;
 *  - DAL сравнивает имена через SQLite `lower()` (ASCII-only), поэтому для
 *    кириллицы при ином регистре может создаться дубликат категории
 *    (upstream использовал `ILIKE` в Postgres).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { getCategory, setBudget } from '../lib/dal/finances.js';
import { todayIso } from '../lib/dal/fx.js';

export interface BudgetSetResponse {
  status: 'ok';
  month: string;
  limit_amount_eur: number;
}

function parseNumber(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseId(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw new EndpointError('category_id must be a positive integer', { code: 'BAD_REQUEST' });
  }
  return parsed;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<BudgetSetResponse> {
  const userId = requireUserId(input, ctx);

  const limitEur = parseNumber(input.limit_amount_eur);
  if (!Number.isFinite(limitEur)) {
    throw new EndpointError('limit_amount_eur must be a number', { code: 'BAD_REQUEST' });
  }

  const month = todayIso().slice(0, 7);
  const categoryName =
    typeof input.category_name === 'string' ? input.category_name.trim() : '';

  let categoryId: number | undefined;
  if (!categoryName) {
    if (input.category_id === undefined || input.category_id === null) {
      throw new EndpointError('Не указана категория', { code: 'BAD_REQUEST' });
    }
    categoryId = parseId(input.category_id);
    const category = await getCategory(userId, categoryId);
    if (!category) {
      throw new EndpointError('Категория не найдена', { code: 'BAD_REQUEST' });
    }
    if (category.kind !== 'expense') {
      throw new EndpointError('Бюджеты задаются только для расходных категорий', {
        code: 'BAD_REQUEST',
      });
    }
  }

  await setBudget(userId, {
    month,
    categoryId,
    categoryName: categoryName || undefined,
    limitAmountEurCents: Math.round(limitEur * 100),
  });

  return { status: 'ok', month, limit_amount_eur: limitEur };
}
