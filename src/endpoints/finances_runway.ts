/**
 * GET /api/finances/runway — прогноз «на сколько хватит денег».
 *
 * Порт `backend/app/api/routes.py::get_runway_forecast` +
 * `backend/app/services/runway.py::calculate_runway`. Доменный расчёт живёт в
 * `src/lib/runway.ts` (целые центы, ADR-003); здесь только маппинг cents → float
 * в snake_case под `RunwayResponseSchema`.
 *
 * Отличия от upstream (задокументированы в T16):
 *  - `true_free_cash_eur` в TS-расчёте отсутствует как отдельное поле; по тикету
 *    выводим его как `spendable − pending_debt_horizon` (upstream отдавал просто
 *    `round(spendable, 2)`);
 *  - `runway_weeks` не хранится в `RunwayResult` — считаем `runway_days / 7`;
 *  - `days_remaining_in_month` считаем по UTC (`new Date()`), upstream — по
 *    локальному времени сервера (может отличаться на границе суток);
 *  - `envelope` счёта берётся из БД (`spendable` | `reserved`), upstream мог
 *    возвращать смешанные подписи вроде `mixed (rent+taxes + spendable)`.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { calculateRunway } from '../lib/runway.js';

const eur = (cents: number): number => Math.round(cents) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;

export interface RunwayAccountResponse {
  id: string;
  name: string;
  currency: string;
  current_balance: number;
  balance_eur: number;
  envelope: string;
}

export interface RunwayPaymentResponse {
  id: string;
  name: string;
  queue: string;
  monthly_payment: number;
  currency: string;
  amount_eur: number;
  payment_day: number | null;
}

export interface RunwayResponse {
  total_liquid_eur: number;
  pending_debt_this_month_eur: number;
  net_liquid_eur: number;
  total_monthly_obligations_eur: number;
  true_free_cash_eur: number;
  spendable_eur: number;
  reserved_eur: number;
  cash_reserve_eur: number;
  pending_debt_horizon_eur: number;
  reserved_gap_eur: number;
  horizon_days: number;
  daily_burn_eur: number;
  runway_days: number;
  runway_weeks: number;
  safe_daily_spend_eur: number;
  safe_weekly_spend_eur: number;
  safe_monthly_spend_eur: number;
  days_remaining_in_month: number;
  month_close_burn_eur: number;
  month_close_gap_eur: number;
  accounts: RunwayAccountResponse[];
  upcoming_payments: RunwayPaymentResponse[];
  already_paid: string[];
  runway_months: number;
  burn_rate_monthly_eur: number;
  total_spendable_eur: number;
  status: 'safe' | 'warning' | 'danger';
  envelopes: any[];
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<RunwayResponse> {
  const userId = requireUserId(input, ctx);

  const runway = await calculateRunway(userId);

  // Тикет T16: «истинно свободные деньги» = свободные минус платежи горизонта.
  // Upstream отдавал здесь просто round(spendable, 2).
  const trueFreeCashEur = eur(runway.spendableCents - runway.pendingDebtHorizonCents);

  const runwayWeeks =
    runway.spendableCents <= 0 ? 0 : round1(runway.runwayDays / 7);

  return {
    total_liquid_eur: eur(runway.totalLiquidCents),
    pending_debt_this_month_eur: eur(runway.pendingThisMonthCents),
    net_liquid_eur: eur(runway.netLiquidCents),
    total_monthly_obligations_eur: eur(runway.totalMonthlyObligationsCents),
    true_free_cash_eur: trueFreeCashEur,
    spendable_eur: eur(runway.spendableCents),
    reserved_eur: eur(runway.reservedCents),
    cash_reserve_eur: eur(runway.cashReserveCents),
    pending_debt_horizon_eur: eur(runway.pendingDebtHorizonCents),
    reserved_gap_eur: eur(runway.reservedGapCents),
    horizon_days: runway.horizonDays,
    daily_burn_eur: eur(runway.dailyBurnCents),
    runway_days: runway.runwayDays,
    runway_weeks: runwayWeeks,
    safe_daily_spend_eur: eur(runway.safeDailyCents),
    safe_weekly_spend_eur: eur(runway.safeWeeklyCents),
    safe_monthly_spend_eur: eur(runway.safeMonthlyCents),
    days_remaining_in_month: runway.daysRemainingInMonth,
    month_close_burn_eur: eur(runway.monthCloseBurnCents),
    month_close_gap_eur: eur(runway.monthCloseGapCents),
    accounts: runway.accounts.map((account) => ({
      id: String(account.id),
      name: account.name,
      currency: account.currency,
      current_balance: account.balanceCents / 100,
      balance_eur: account.balanceEurCents / 100,
      envelope: account.envelope,
    })),
    upcoming_payments: runway.upcomingPayments.map((payment) => ({
      id: String(payment.id),
      name: payment.name,
      queue: payment.queue,
      monthly_payment: payment.monthlyPaymentCents / 100,
      currency: payment.currency,
      amount_eur: payment.amountEurCents / 100,
      payment_day: payment.paymentDay,
    })),
    already_paid: [...runway.alreadyPaid],
    runway_months: runway.runwayMonths,
    burn_rate_monthly_eur: eur(runway.dailyBurnCents * 30),
    total_spendable_eur: eur(runway.spendableCents),
    status: runway.runwayMonths >= 6 ? 'safe' : runway.runwayMonths >= 3 ? 'warning' : 'danger',
    envelopes: [],
  };
}
