/**
 * Runway — «на сколько мне хватит денег».
 *
 * Порт `backend/app/services/runway.py`. Отличия, зафиксированные ADR:
 *  - ADR-002: «конверт» счёта берётся из `accounts.envelope`; никаких догадок
 *    по имени счёта, банку или городу. «Наличными» считаются только счета, к
 *    которым привязаны обязательства (`liabilities.account_id`).
 *  - ADR-003: расчёт целиком в целых центах, float-арифметики нет; каждое
 *    округление выполняется один раз — при записи поля в результат.
 *
 * Внутри всё считается в EUR (`fx.BASE_CURRENCY`), наружу ключевые суммы
 * отдаются и в EUR-центах, и в валюте пользователя (`base`), если курс есть.
 */

import { BASE_CURRENCY, type RateTable, convert, getRates, hasRate } from './dal/fx';
import { listAccounts, listLiabilities, listTransactions } from './dal/finances';
import { getUser } from './dal/users';
import { addDays, dateKey, monthKey, zonedParts } from './utils';

/**
 * Минимальный горизонт в днях. В upstream объявлен, но не используется —
 * оставляем как явную константу, чтобы читатель не искал её в коде.
 */
export const MIN_HORIZON_DAYS = 7;

/** Пол по дневному прожиганию: меньше 15 €/день считать нельзя (нереалистично). */
const MIN_DAILY_BURN_CENTS = 1500;

/** Прожигание, когда транзакций ещё нет: 20 €/день. */
const SEED_DAILY_BURN_CENTS = 2000;

/** Жёсткая нижняя граница после всех поправок. */
const HARD_MIN_DAILY_BURN_CENTS = 100;

const BURN_WINDOW_DAYS = 30;

const TRANSACTION_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 40;

export interface RunwayOptions {
  /** Момент расчёта (для тестов и планировщика). */
  now?: Date;
  /** Ручное значение дневного прожигания в центах — заменяет расчёт по тратам. */
  dailyBurnOverrideCents?: number;
  /** Горизонт планирования в днях; по умолчанию — остаток месяца. */
  horizonDays?: number;
}

export interface RunwayAccount {
  id: number;
  name: string;
  currency: string;
  /** Баланс в валюте счёта, центы. */
  balanceCents: number;
  /** Баланс в EUR, центы (0, если курса валюты нет). */
  balanceEurCents: number;
  envelope: string;
}

export interface RunwayUpcomingPayment {
  id: number;
  name: string;
  queue: string;
  monthlyPaymentCents: number;
  currency: string;
  /** Месячный платёж в EUR, центы. */
  amountEurCents: number;
  paymentDay: number | null;
}

export interface RunwayResult {
  /** Валюта расчёта: все `*Cents` ниже — в ней (EUR). */
  currency: string;
  /** Валюта вывода: валюта пользователя, если для неё есть курс, иначе EUR. */
  baseCurrency: string;
  horizonDays: number;
  accounts: RunwayAccount[];
  totalLiquidCents: number;
  spendableCents: number;
  reservedCents: number;
  /** Часть резерва, лежащая на «наличных» счетах. */
  cashReserveCents: number;
  /** Сколько из резерва приходится на горизонт (платежи ближайших H дней). */
  pendingDebtHorizonCents: number;
  /** Насколько резерв больше платежей горизонта (может быть отрицательным). */
  reservedGapCents: number;
  pendingThisMonthCents: number;
  totalMonthlyObligationsCents: number;
  netLiquidCents: number;
  /** Сколько дней месяца ещё впереди, включая сегодняшний. */
  daysRemainingInMonth: number;
  /** Прожигание на остаток месяца: dailyBurn × daysRemainingInMonth. */
  monthCloseBurnCents: number;
  /** Нужно до конца месяца (платежи месяца + прожигание) минус вся ликвидность. */
  monthCloseGapCents: number;
  dailyBurnCents: number;
  safeDailyCents: number;
  safeWeeklyCents: number;
  safeMonthlyCents: number;
  runwayDays: number;
  runwayMonths: number;
  upcomingPayments: RunwayUpcomingPayment[];
  alreadyPaid: string[];
  /** Те же ключевые суммы в валюте пользователя. */
  base: {
    totalLiquidCents: number;
    spendableCents: number;
    reservedCents: number;
    cashReserveCents: number;
    pendingDebtHorizonCents: number;
    reservedGapCents: number;
    monthCloseBurnCents: number;
    monthCloseGapCents: number;
    dailyBurnCents: number;
    safeDailyCents: number;
    safeWeeklyCents: number;
    safeMonthlyCents: number;
  };
}

type AccountRow = Awaited<ReturnType<typeof listAccounts>>[number];
type LiabilityRow = Awaited<ReturnType<typeof listLiabilities>>[number];

const pad2 = (value: number): string => String(value).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Баланс счёта в EUR: пересчёт по курсу, без курса — 0 (и это видно по счёту). */
function accountEurCents(account: AccountRow, rates: RateTable): number {
  const cents = Math.round(account.currentBalanceCents);
  if (account.currency.toUpperCase() === BASE_CURRENCY) return cents;
  if (!hasRate(account.currency, rates)) return 0;
  try {
    return convert(cents, account.currency, BASE_CURRENCY, rates);
  } catch {
    return 0;
  }
}

/** Сумма в EUR-центах или null, если курса нет (тогда сумма выпадает из EUR-итогов). */
function toEurCents(cents: number, currency: string, rates: RateTable): number | null {
  if (currency.toUpperCase() === BASE_CURRENCY) return Math.round(cents);
  if (!hasRate(currency, rates)) return null;
  try {
    return convert(cents, currency, BASE_CURRENCY, rates);
  } catch {
    return null;
  }
}

interface BurnStats {
  spentCents: number;
  earliest: Date | null;
  count: number;
}

async function expensesSince(userId: number, from: Date, to: Date, timeZone: string): Promise<BurnStats> {
  let spentCents = 0;
  let earliest: Date | null = null;
  let count = 0;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const chunk = await listTransactions(userId, {
      from: dateKey(from, timeZone),
      to: dateKey(to, timeZone),
      kind: 'expense',
      limit: TRANSACTION_PAGE_SIZE,
      offset: page * TRANSACTION_PAGE_SIZE,
    });

    for (const row of chunk) {
      spentCents += Math.round(row.amountEurCents);
      count += 1;
      const occurred = new Date(row.occurredAt);
      if (!Number.isNaN(occurred.getTime()) && (earliest === null || occurred < earliest)) {
        earliest = occurred;
      }
    }

    if (chunk.length < TRANSACTION_PAGE_SIZE) break;
  }

  return { spentCents, earliest, count };
}

/**
 * Дневное прожигание: среднее по расходам за 30 дней, но не меньше 15 €.
 * Если транзакций нет — 20 €. Значение в целых EUR-центах.
 */
function computeDailyBurn(stats: BurnStats, now: Date): number {
  if (stats.count === 0 || stats.earliest === null) return SEED_DAILY_BURN_CENTS;

  const msPerDay = 86_400_000;
  const observedDays = Math.max(1, Math.floor((now.getTime() - stats.earliest.getTime()) / msPerDay) + 1);
  const divisor = Math.min(BURN_WINDOW_DAYS, observedDays);
  const observed = Math.round(stats.spentCents / divisor);

  return Math.max(Math.max(observed, MIN_DAILY_BURN_CENTS), HARD_MIN_DAILY_BURN_CENTS);
}

export async function calculateRunway(userId: number, opts: RunwayOptions = {}): Promise<RunwayResult> {
  const now = opts.now ?? new Date();
  const user = await getUser(userId);
  const timeZone = user?.timezone ?? 'UTC';
  const baseCurrencyPreference = user?.baseCurrency ?? BASE_CURRENCY;

  const [accounts, liabilities, rates] = await Promise.all([
    listAccounts(userId),
    listLiabilities(userId, 'active'),
    getRates(),
  ]);

  const parts = zonedParts(now, timeZone);
  const month = monthKey(now, timeZone);

  // --- горизонт ------------------------------------------------------------
  const daysRemaining = Math.max(1, daysInMonth(parts.year, parts.month) - parts.day + 1);

  let horizonDays: number;
  if (opts.horizonDays !== undefined) {
    horizonDays = Math.max(1, Math.trunc(opts.horizonDays));
  } else if (daysRemaining <= 1) {
    // Последний день месяца: планируем сразу на весь следующий месяц.
    const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
    const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
    horizonDays = daysInMonth(nextYear, nextMonth);
  } else {
    horizonDays = daysRemaining;
  }

  const horizonEndKey = dateKey(addDays(now, horizonDays), timeZone);

  // --- обязательства -------------------------------------------------------
  const accountById = new Map<number, AccountRow>();
  for (const account of accounts) accountById.set(account.id, account);

  const monthlyEurCents = (liability: LiabilityRow): number | null => {
    const monthly = Math.round(liability.monthlyPaymentCents);
    if (monthly <= 0) return null;
    return toEurCents(monthly, liability.currency, rates);
  };

  // Резерв считается per-account: деньги «наличного» счёта закрывают те
  // платежи, которые с него и платятся.
  const reserveByAccount = new Map<number, number>();
  for (const liability of liabilities) {
    if (liability.accountId === null) continue;
    if (!accountById.has(liability.accountId)) continue;
    if (liability.paidMonths.includes(month)) continue;
    const monthly = monthlyEurCents(liability);
    if (monthly === null) continue;
    reserveByAccount.set(liability.accountId, (reserveByAccount.get(liability.accountId) ?? 0) + monthly);
  }

  // --- ход по счетам -------------------------------------------------------
  let totalLiquidCents = 0;
  let spendableCents = 0;
  let reservedCents = 0;
  let cashReserveCents = 0;

  const accountsOut: RunwayAccount[] = [];

  for (const account of accounts) {
    const balanceCents = Math.round(account.currentBalanceCents);
    const balanceEurCents = accountEurCents(account, rates);

    accountsOut.push({
      id: account.id,
      name: account.name,
      currency: account.currency,
      balanceCents,
      balanceEurCents,
      envelope: String(account.envelope),
    });

    if (balanceEurCents <= 0) continue;

    totalLiquidCents += balanceEurCents;

    const reservedForAccount = reserveByAccount.get(account.id) ?? 0;
    if (reservedForAccount > 0) {
      const reservedHere = Math.min(balanceEurCents, reservedForAccount);
      const spendableHere = Math.max(0, balanceEurCents - reservedForAccount);
      reservedCents += reservedHere;
      cashReserveCents += reservedHere;
      spendableCents += spendableHere;
    } else if (account.envelope === 'spendable') {
      spendableCents += balanceEurCents;
    } else {
      reservedCents += balanceEurCents;
    }
  }

  // --- метрики по обязательствам ------------------------------------------
  let totalMonthlyObligationsCents = 0;
  let pendingThisMonthCents = 0;
  let pendingHorizonCents = 0;
  const alreadyPaid: string[] = [];
  const upcoming: RunwayUpcomingPayment[] = [];

  for (const liability of liabilities) {
    const monthly = monthlyEurCents(liability);
    if (monthly === null) continue;

    totalMonthlyObligationsCents += monthly;

    if (liability.paidMonths.includes(month)) {
      alreadyPaid.push(liability.name);
      continue;
    }

    pendingThisMonthCents += monthly;

    const day = liability.paymentDay;
    if (day !== null) {
      const dueThis = `${parts.year}-${pad2(parts.month)}-${pad2(
        Math.min(day, daysInMonth(parts.year, parts.month)),
      )}`;
      if (dueThis <= horizonEndKey) pendingHorizonCents += monthly;

      const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
      const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
      const dueNext = `${nextYear}-${pad2(nextMonth)}-${pad2(Math.min(day, daysInMonth(nextYear, nextMonth)))}`;
      if (dueNext <= horizonEndKey) pendingHorizonCents += monthly;
    }

    upcoming.push({
      id: liability.id,
      name: liability.name,
      queue: String(liability.queue),
      monthlyPaymentCents: Math.round(liability.monthlyPaymentCents),
      currency: liability.currency,
      amountEurCents: monthly,
      paymentDay: day,
    });
  }

  upcoming.sort((a, b) => {
    const dayA = a.paymentDay ?? 99;
    const dayB = b.paymentDay ?? 99;
    if (dayA !== dayB) return dayA - dayB;
    return a.name.localeCompare(b.name, 'ru');
  });

  // --- прожигание ----------------------------------------------------------
  let burnCents: number;
  if (opts.dailyBurnOverrideCents !== undefined) {
    burnCents = Math.max(HARD_MIN_DAILY_BURN_CENTS, Math.round(opts.dailyBurnOverrideCents));
  } else {
    const from = addDays(now, -BURN_WINDOW_DAYS);
    const stats = await expensesSince(userId, from, now, timeZone);
    burnCents = computeDailyBurn(stats, now);
  }

  // --- деньги к тратам -----------------------------------------------------
  const netLiquidCents = totalLiquidCents - pendingThisMonthCents;

  // Закрытие месяца: к платежам месяца прибавляем прожигание на остаток дней.
  // Отдельной метрикой, потому что burn и обязательства нигде не складывались
  // и «остаток после платежей» читался как свободные деньги.
  const monthCloseBurnCents = Math.round(burnCents * daysRemaining);
  const monthCloseGapCents = pendingThisMonthCents + monthCloseBurnCents - totalLiquidCents;

  let runwayDays = 0;
  let runwayMonths = 0;
  let safeDailyCents = 0;
  let safeWeeklyCents = 0;
  let safeMonthlyCents = 0;

  if (spendableCents > 0) {
    runwayDays = Math.floor(spendableCents / burnCents);
    runwayMonths = Math.round((spendableCents / (burnCents * 30)) * 10) / 10;
    safeDailyCents = Math.round(spendableCents / horizonDays);
    safeWeeklyCents = safeDailyCents * 7;
    safeMonthlyCents = spendableCents;
  }

  const reservedGapCents = reservedCents - pendingHorizonCents;

  // --- вывод в валюте пользователя ----------------------------------------
  let baseCurrency = BASE_CURRENCY;
  let toBase = (cents: number): number => Math.round(cents);
  if (baseCurrencyPreference.toUpperCase() !== BASE_CURRENCY) {
    try {
      // Проверяем курс «пробной» суммой: нет курса — остаёмся в EUR.
      convert(100, BASE_CURRENCY, baseCurrencyPreference, rates);
      const target = baseCurrencyPreference;
      baseCurrency = target;
      toBase = (cents: number): number => convert(cents, BASE_CURRENCY, target, rates);
    } catch {
      baseCurrency = BASE_CURRENCY;
    }
  }

  return {
    currency: BASE_CURRENCY,
    baseCurrency,
    horizonDays,
    accounts: accountsOut,
    totalLiquidCents,
    spendableCents,
    reservedCents,
    cashReserveCents,
    pendingDebtHorizonCents: pendingHorizonCents,
    reservedGapCents,
    pendingThisMonthCents,
    totalMonthlyObligationsCents,
    netLiquidCents,
    daysRemainingInMonth: daysRemaining,
    monthCloseBurnCents,
    monthCloseGapCents,
    dailyBurnCents: burnCents,
    safeDailyCents,
    safeWeeklyCents,
    safeMonthlyCents,
    runwayDays,
    runwayMonths,
    upcomingPayments: upcoming,
    alreadyPaid,
    base: {
      totalLiquidCents: toBase(totalLiquidCents),
      spendableCents: toBase(spendableCents),
      reservedCents: toBase(reservedCents),
      cashReserveCents: toBase(cashReserveCents),
      pendingDebtHorizonCents: toBase(pendingHorizonCents),
      reservedGapCents: toBase(reservedGapCents),
      monthCloseBurnCents: toBase(monthCloseBurnCents),
      monthCloseGapCents: toBase(monthCloseGapCents),
      dailyBurnCents: toBase(burnCents),
      safeDailyCents: toBase(safeDailyCents),
      safeWeeklyCents: toBase(safeWeeklyCents),
      safeMonthlyCents: toBase(safeMonthlyCents),
    },
  };
}
