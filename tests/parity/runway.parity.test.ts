/**
 * Паритет Python ↔ TS: runway (ADR-004).
 *
 * Python-референс — `calculate_runway()` (`legacy/backend/app/services/runway.py`).
 * TS-реализация — `calculateRunway()` (`src/lib/runway.ts`).
 *
 * Харнесс: одна и та же фикстура (счета, обязательства, курсы, `now`, горизонт,
 * override прожигания) прогоняется через оба расчёта. «Сейчас» фиксировано —
 * 10:00 UTC дня кейса. Обязательства создаются с `paidMonths` (иначе TS
 * справедливо считает платёж неоплаченным и сравнение врёт).
 *
 * 22 из 25 кейсов — полный паритет по сравнимым полям.
 *
 * Задокументированные расхождения (см. README):
 *  1. `liability-payment-day-null` — Python не резервирует платёж без дня
 *     (`payment_day is None`), TS резервирует: reserved 5000 вместо 0.
 *  2. `unattached-eur-rent` — Python резервирует незакреплённый EUR-платёж по
 *     критерию очереди (Cash), TS без `accountId` не резервирует вовсе.
 *
 * Снято: `overdue-payment-day` (Python досчитывал просроченный платёж в горизонт,
 * TS — только будущие даты). Расхождение устранено: TS теперь считает и просрочку.
 *
 * Отдельно: `cashReserveCents` — Python при отсутствии cash-обязательств берёт
 * фиктивный резерв 420 €, TS — 0. При прикреплённом cash-обязательстве значения
 * совпадают (отдельный describe).
 *
 * Вне сравнения: `daysRemainingInMonth` (в TS поля нет), `runwayWeeks` (Python) и
 * `runwayMonths` (TS) — разные единицы, `accountEnvelopes` — Python-специфичная
 * классификация «mixed (rent+taxes + spendable)» по имени счёта, TS хранит
 * `envelope` в самом счёте.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { calculateRunway } from '../../src/lib/runway';
import type { RunwayResult } from '../../src/lib/runway';
import { createAccount, createLiability } from '../../src/lib/dal/finances';
import { ensureUser } from '../../src/lib/dal/users';
import { setRates } from '../../src/lib/dal/fx';
import { runwayFixture } from './loader';
import type { RunwayCase, RunwayPythonResult } from './loader';
import type { CurrencyCode, IsoMonth } from '../../src/types';

const USER = 1;

/** Сравнимые поля обоих результатов (одно имя — одно значение). */
interface Snapshot {
  horizonDays: number;
  totalLiquidCents: number;
  spendableCents: number;
  reservedCents: number;
  pendingThisMonthCents: number;
  pendingHorizonCents: number;
  reservedGapCents: number;
  totalMonthlyObligationsCents: number;
  netLiquidCents: number;
  dailyBurnCents: number;
  safeDailyCents: number;
  safeWeeklyCents: number;
  safeMonthlyCents: number;
  runwayDays: number;
  alreadyPaid: string[];
  upcoming: string[];
}

function pySnapshot(result: RunwayPythonResult): Snapshot {
  return {
    horizonDays: result.horizonDays,
    totalLiquidCents: result.totalLiquidCents,
    spendableCents: result.spendableCents,
    reservedCents: result.reservedCents,
    pendingThisMonthCents: result.pendingThisMonthCents,
    pendingHorizonCents: result.pendingHorizonCents,
    reservedGapCents: result.reservedGapCents,
    totalMonthlyObligationsCents: result.totalMonthlyObligationsCents,
    netLiquidCents: result.netLiquidCents,
    dailyBurnCents: result.dailyBurnCents,
    safeDailyCents: result.safeDailyCents,
    safeWeeklyCents: result.safeWeeklyCents,
    safeMonthlyCents: result.safeMonthlyCents,
    runwayDays: result.runwayDays,
    alreadyPaid: [...result.alreadyPaid].sort(),
    // Порядок при равных днях — деталь сортировки, сравниваем состав
    upcoming: result.upcoming.map((p) => `${p.name}@${String(p.paymentDay)}`).sort(),
  };
}

function tsSnapshot(result: RunwayResult): Snapshot {
  return {
    horizonDays: result.horizonDays,
    totalLiquidCents: result.totalLiquidCents,
    spendableCents: result.spendableCents,
    reservedCents: result.reservedCents,
    pendingThisMonthCents: result.pendingThisMonthCents,
    pendingHorizonCents: result.pendingDebtHorizonCents,
    reservedGapCents: result.reservedGapCents,
    totalMonthlyObligationsCents: result.totalMonthlyObligationsCents,
    netLiquidCents: result.netLiquidCents,
    dailyBurnCents: result.dailyBurnCents,
    safeDailyCents: result.safeDailyCents,
    safeWeeklyCents: result.safeWeeklyCents,
    safeMonthlyCents: result.safeMonthlyCents,
    runwayDays: result.runwayDays,
    alreadyPaid: [...result.alreadyPaid].sort(),
    upcoming: result.upcomingPayments
      .map((p) => `${p.name}@${String(p.paymentDay)}`)
      .sort(),
  };
}

/** Явные TS-ожидания для кейсов с задокументированными расхождениями. */
const KNOWN_DIVERGENCES: Readonly<Record<string, Partial<Snapshot>>> = {
  // Python: `if not payment_day: continue` — обязательство без дня не резервируется
  // и не попадает в pending horizon. TS резервирует по accountId.
  'liability-payment-day-null': {
    spendableCents: 25_000,
    reservedCents: 5_000,
    reservedGapCents: 5_000,
    safeDailyCents: 1_667,
    safeWeeklyCents: 11_669,
    safeMonthlyCents: 25_000,
    runwayDays: 12,
  },
  // Python резервирует платёж без accountId по очереди queue_1 как cash-платёж;
  // TS резерв строит строго по accountId, поэтому незакреплённый платёж не резервируется.
  'unattached-eur-rent': {
    spendableCents: 120_000,
    reservedCents: 0,
    reservedGapCents: -30_000,
    safeDailyCents: 4_800,
    safeWeeklyCents: 33_600,
    safeMonthlyCents: 120_000,
    runwayDays: 60,
  },
};

async function runCase(testCase: RunwayCase): Promise<RunwayResult> {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  await ensureUser(USER);
  await setRates(testCase.today, runwayFixture.rates);

  const accountIds = new Map<string, number>();
  for (const account of testCase.accounts) {
    const created = await createAccount(USER, {
      name: account.name,
      currency: account.currency as CurrencyCode,
      initialBalanceCents: account.balanceCents,
      envelope: account.envelope,
    });
    accountIds.set(account.name, created.id);
  }

  for (const liability of testCase.liabilities) {
    await createLiability(USER, {
      name: liability.name,
      queue: liability.queue,
      amountCents: liability.monthlyCents,
      currency: liability.currency as CurrencyCode,
      monthlyPaymentCents: liability.monthlyCents,
      paymentDay: liability.paymentDay,
      paidMonths: liability.paidMonths as readonly IsoMonth[],
      accountId: liability.account === null ? null : (accountIds.get(liability.account) ?? null),
    });
  }

  return calculateRunway(USER, {
    now: new Date(`${testCase.today}T10:00:00.000Z`),
    ...(testCase.horizonDays === null ? {} : { horizonDays: testCase.horizonDays }),
    dailyBurnOverrideCents: testCase.dailyBurnOverrideCents,
  });
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('runway: паритет по сравнимым полям', () => {
  it('23 кейса без известных расхождений совпадают полностью', async () => {
    const aligned = runwayFixture.cases.filter((c) => !(c.id in KNOWN_DIVERGENCES));
    expect(aligned.length).toBe(23);

    for (const testCase of aligned) {
      const ts = tsSnapshot(await runCase(testCase));
      expect(ts, testCase.id).toEqual(pySnapshot(testCase.python));
    }
  });

  it('2 задокументированных расхождения зафиксированы явно', async () => {
    for (const [id, overrides] of Object.entries(KNOWN_DIVERGENCES)) {
      const testCase = runwayFixture.cases.find((c) => c.id === id);
      expect(testCase, `нет кейса ${id} в фикстуре`).toBeDefined();
      if (!testCase) continue;

      const py = pySnapshot(testCase.python);
      const ts = tsSnapshot(await runCase(testCase));

      // Python-эталон действительно расходится с TS в этих полях
      for (const key of Object.keys(overrides) as Array<keyof Snapshot>) {
        expect(py[key], `${id}: python ${key}`).not.toEqual(ts[key]);
      }

      expect(ts, id).toEqual({ ...py, ...overrides });
    }
  });

  it('guard: набор расхождений runway не изменился', async () => {
    const actual: string[] = [];
    for (const testCase of runwayFixture.cases) {
      const ts = tsSnapshot(await runCase(testCase));
      if (JSON.stringify(ts) !== JSON.stringify(pySnapshot(testCase.python))) {
        actual.push(testCase.id);
      }
    }
    expect(actual.sort()).toEqual(Object.keys(KNOWN_DIVERGENCES).sort());
  });
});

describe('runway: cashReserveCents', () => {
  /** Кейсы без cash-обязательств: Python подставляет фиктивные 420 €, TS — 0. */
  const FALLBACK = [
    'empty',
    'single-spendable',
    'spendable-plus-reserved',
    'horizon-override-10',
    'last-day-of-month',
    'last-day-february-leap',
    'usd-account',
    'rub-account',
    'zero-and-negative-balances',
    'reserved-only',
    'burn-override-below-floor',
    'burn-override-odd',
    'liability-zero-monthly',
  ];

  /** Прикреплённое cash-обязательство: резерв считается одинаково. */
  const ATTACHED = [
    'cash-rent-partial',
    'cash-rent-full',
    'cash-two-liabilities',
    'liability-paid-this-month',
    'different-payment-days',
    'horizon-override-40',
    'usd-liability-attached',
    'payment-day-31-in-november',
    'overdue-payment-day',
    'big-balances',
  ];

  it('fallback 420 € есть только в Python', async () => {
    for (const id of FALLBACK) {
      const testCase = runwayFixture.cases.find((c) => c.id === id);
      expect(testCase, `нет кейса ${id}`).toBeDefined();
      if (!testCase) continue;

      expect(testCase.python.cashReserveCents, `${id}: python`).toBe(42_000);
      expect((await runCase(testCase)).cashReserveCents, `${id}: ts`).toBe(0);
    }
  });

  it('при прикреплённом cash-обязательстве значения совпадают', async () => {
    for (const id of ATTACHED) {
      const testCase = runwayFixture.cases.find((c) => c.id === id);
      expect(testCase, `нет кейса ${id}`).toBeDefined();
      if (!testCase) continue;

      const ts = await runCase(testCase);
      expect(ts.cashReserveCents, id).toBe(testCase.python.cashReserveCents);
    }
  });

  it('особые случаи: null paymentDay и незакреплённое обязательство', async () => {
    const nullDay = runwayFixture.cases.find((c) => c.id === 'liability-payment-day-null');
    const unattached = runwayFixture.cases.find((c) => c.id === 'unattached-eur-rent');
    expect(nullDay).toBeDefined();
    expect(unattached).toBeDefined();
    if (!nullDay || !unattached) return;

    // Python не резервирует платёж без дня → fallback 420 €; TS резервирует 5000
    expect(nullDay.python.cashReserveCents).toBe(42_000);
    expect((await runCase(nullDay)).cashReserveCents).toBe(5_000);

    // Python резервирует незакреплённый платёж как cash-платёж; TS — нет
    expect(unattached.python.cashReserveCents).toBe(30_000);
    expect((await runCase(unattached)).cashReserveCents).toBe(0);
  });

  it('guard: все кейсы покрыты одной из трёх групп', () => {
    const covered = [...FALLBACK, ...ATTACHED, 'liability-payment-day-null', 'unattached-eur-rent'];
    expect(covered.sort()).toEqual(runwayFixture.cases.map((c) => c.id).sort());
  });
});
