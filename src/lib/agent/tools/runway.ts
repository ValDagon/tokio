/**
 * Тулзы агента: прогноз runway (SPEC §3 T13, паритет с
 * `backend/app/agent/tools/runway.py`).
 *
 * ADR-003: на границе DAL деньги — только INTEGER cents. Суммы в аргументах
 * тулз приходят десятичной строкой (паритет с upstream float-UX) и парсятся
 * через parseAmountToCents; в content/data — cents (int) или formatCents.
 *
 * Отличия от upstream (задокументированы осознанно):
 *  - upstream печатает runway в неделях (`runway_weeks`), TS-расчёт отдаёт
 *    `runwayMonths` — печатаем месяцы (§8.7);
 *  - в upstream «свободные деньги» = отдельный банковский счёт и резерв =
 *    остальные счета; здесь это свойство данных пользователя
 *    (`accounts.envelope`, ADR-002) — в тексте никаких имён банков.
 */

import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import { calculateRunway } from '../../runway';
import { formatCents, formatMoney, parseAmountToCents } from '../../utils';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Необязательная сумма из аргументов: `undefined` — не задана, `null` — кривая. */
function optionalCents(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  try {
    return parseAmountToCents(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// get_runway_forecast
// ---------------------------------------------------------------------------

/**
 * Прогноз runway: сколько дней денег хватит при текущем расходе, сколько
 * можно безопасно тратить в день и какие платежи впереди.
 */
async function getRunwayForecast(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const override = optionalCents(args.daily_burn_override);
  if (override === null) {
    return fail(
      `Не понял дневной расход «${String(args.daily_burn_override)}» — передайте сумму, например 25 или "25,50".`,
    );
  }
  if (override !== undefined && override <= 0) {
    return fail('Дневной расход должен быть больше нуля.');
  }

  try {
    const result = await calculateRunway(ctx.userId, {
      now: ctx.now,
      ...(override !== undefined ? { dailyBurnOverrideCents: override } : {}),
    });

    // Суммы печатаем в валюте пользователя (result.base.*), расчёт — в EUR-центах.
    const currency = result.baseCurrency;
    const money = (cents: number): string => formatMoney(cents, currency);
    const base = result.base;

    const lines: string[] = [
      '🛫 Финансовый Runway и прогноз ликвидности:',
      `• Свободные деньги: ${money(base.spendableCents)}`,
      `• Уже распределено (резерв, это НЕ бюджет): ${money(base.reservedCents)}`,
      `• Платежи в ближайшие ${result.horizonDays} дн.: ${money(base.pendingDebtHorizonCents)} (запас под них: ${money(base.reservedGapCents)})`,
      `• Текущий дневной расход (Daily Burn): ${money(base.dailyBurnCents)}/день`,
      `• Запас прочности (Runway): ${result.runwayDays} дн. (~${result.runwayMonths} мес.)`,
      `• Безопасный дневной расход: ${money(base.safeDailyCents)}/день (на ближайшие ${result.horizonDays} дн.)`,
      `• Закрытие месяца (платежи месяца + прожигание до конца − вся ликвидность): ${money(base.monthCloseGapCents)} — плюс значит «не закрывается»`,
    ];

    if (result.upcomingPayments.length > 0) {
      lines.push('', 'Предстоящие платежи в этом месяце:');
      for (const payment of result.upcomingPayments) {
        const day = payment.paymentDay === null ? '' : ` (${payment.paymentDay}-е число)`;
        lines.push(
          `• ${payment.name}: ${formatMoney(payment.monthlyPaymentCents, payment.currency)} (~${formatCents(payment.amountEurCents)} €)${day}`,
        );
      }
    }

    if (result.alreadyPaid.length > 0) {
      lines.push('', `Уже оплачено в этом месяце: ${result.alreadyPaid.join(', ')}`);
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        currency: result.currency,
        base_currency: result.baseCurrency,
        horizon_days: Math.trunc(result.horizonDays),
        total_liquid_cents: Math.round(base.totalLiquidCents),
        spendable_cents: Math.round(base.spendableCents),
        reserved_cents: Math.round(base.reservedCents),
        pending_debt_horizon_cents: Math.round(base.pendingDebtHorizonCents),
        reserved_gap_cents: Math.round(base.reservedGapCents),
        daily_burn_cents: Math.round(base.dailyBurnCents),
        days_remaining_in_month: Math.trunc(result.daysRemainingInMonth),
        month_close_burn_cents: Math.round(base.monthCloseBurnCents),
        month_close_gap_cents: Math.round(base.monthCloseGapCents),
        safe_daily_cents: Math.round(base.safeDailyCents),
        runway_days: Math.trunc(result.runwayDays),
        runway_months: result.runwayMonths,
        upcoming_payments: result.upcomingPayments.map((payment) => ({
          id: payment.id,
          name: payment.name,
          monthly_payment_cents: Math.round(payment.monthlyPaymentCents),
          currency: payment.currency,
          amount_eur_cents: Math.round(payment.amountEurCents),
          payment_day: payment.paymentDay,
        })),
        already_paid: [...result.alreadyPaid],
      },
    };
  } catch (error) {
    return fail(`Не удалось посчитать Runway: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

/** Константы, не фабрики: реестр регистрирует их как есть. */
export const runwayTools: Tool[] = [
  {
    name: 'get_runway_forecast',
    description:
      'Прогноз runway: сколько дней денег хватит при текущем расходе, сколько можно безопасно тратить в день и какие платежи впереди.',
    schema: {
      type: 'object',
      properties: {
        daily_burn_override: {
          type: 'string',
          description:
            'Опционально ручной дневной расход (десятичная строка, например "25" или "25,50"); по умолчанию считается по тратам за последние 30 дней.',
        },
      },
      required: [],
    },
    run: getRunwayForecast,
  },
];
