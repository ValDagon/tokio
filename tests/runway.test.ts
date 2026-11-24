/**
 * `src/lib/runway.ts` — сколько денег реально можно тратить и на сколько хватит.
 *
 * Держим инварианты модуля:
 *  - резерв считается per-account: деньги «наличного» счёта закрывают платежи,
 *    которые с него и платятся (аренда с Cash не съедает Wallet);
 *  - горизонт по умолчанию — остаток месяца, в последний день — следующий месяц;
 *  - прожигание не опускается ниже 15 €/день и считается по EUR-эквивалентам;
 *  - вывод в валюте пользователя делается только при наличии курса.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { calculateRunway } from '../src/lib/runway';
import { createAccount, createLiability, createTransaction } from '../src/lib/dal/finances';
import { ensureUser, updateUser } from '../src/lib/dal/users';
import { setRates } from '../src/lib/dal/fx';
import { saveUserPrefs } from '../src/lib/prefs';
import type { LiabilityQueue } from '../src/types';

const USER = 1;
const NOW = new Date('2026-11-06T10:00:00.000Z');

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('calculateRunway: база', () => {
  it('без счетов и трат — сид 20 €/день, нулевой ранеэй', async () => {
    await ensureUser(USER);

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.currency).toBe('EUR');
    expect(result.baseCurrency).toBe('EUR');
    expect(result.horizonDays).toBe(25); // 30 - 6 + 1
    expect(result.accounts).toEqual([]);
    expect(result.totalLiquidCents).toBe(0);
    expect(result.spendableCents).toBe(0);
    expect(result.reservedCents).toBe(0);
    expect(result.dailyBurnCents).toBe(2000);
    expect(result.runwayDays).toBe(0);
    expect(result.safeDailyCents).toBe(0);
    expect(result.upcomingPayments).toEqual([]);
  });

  it('явный горизонт и ручной прожиг дают дневную/недельную/месячную норму', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Wallet', currency: 'EUR', initialBalanceCents: 100_000 });

    const result = await calculateRunway(USER, {
      now: NOW,
      horizonDays: 10,
      dailyBurnOverrideCents: 2000,
    });

    expect(result.horizonDays).toBe(10);
    expect(result.spendableCents).toBe(100_000);
    expect(result.safeDailyCents).toBe(10_000);
    expect(result.safeWeeklyCents).toBe(70_000);
    expect(result.safeMonthlyCents).toBe(100_000);
    expect(result.runwayDays).toBe(50);
    expect(result.runwayMonths).toBe(1.7);
  });

  it('конверт reserved целиком уходит в резерв', async () => {
    await ensureUser(USER);
    await createAccount(USER, {
      name: 'Piggy',
      currency: 'EUR',
      initialBalanceCents: 50_000,
      envelope: 'reserved',
    });

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.reservedCents).toBe(50_000);
    expect(result.cashReserveCents).toBe(0);
    expect(result.spendableCents).toBe(0);
    expect(result.totalLiquidCents).toBe(50_000);
  });
});

describe('calculateRunway: резерв по обязательствам', () => {
  it('аренда с Cash резервируется на самом Cash, Card остаётся свободным', async () => {
    await ensureUser(USER);
    const cash = await createAccount(USER, {
      name: 'Cash',
      currency: 'EUR',
      initialBalanceCents: 60_000,
    });
    await createAccount(USER, { name: 'Card', currency: 'EUR', initialBalanceCents: 100_000 });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 10,
      accountId: cash.id,
    });

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.reservedCents).toBe(40_000);
    expect(result.cashReserveCents).toBe(40_000);
    expect(result.spendableCents).toBe(120_000);
    expect(result.totalLiquidCents).toBe(160_000);
    expect(result.netLiquidCents).toBe(120_000);
    expect(result.pendingThisMonthCents).toBe(40_000);
    expect(result.pendingDebtHorizonCents).toBe(40_000);
    expect(result.reservedGapCents).toBe(0);
    expect(result.upcomingPayments[0]).toEqual(
      expect.objectContaining({ name: 'Rent', paymentDay: 10, monthlyPaymentCents: 40_000 }),
    );
    expect(result.alreadyPaid).toEqual([]);
  });

  it('оплаченное обязательство не резервируется и попадает в alreadyPaid', async () => {
    await ensureUser(USER);
    const cash = await createAccount(USER, {
      name: 'Cash',
      currency: 'EUR',
      initialBalanceCents: 60_000,
    });
    await createAccount(USER, { name: 'Card', currency: 'EUR', initialBalanceCents: 100_000 });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 10,
      accountId: cash.id,
      paidMonths: ['2026-11'],
    });

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.reservedCents).toBe(0);
    expect(result.cashReserveCents).toBe(0);
    expect(result.spendableCents).toBe(160_000);
    expect(result.pendingThisMonthCents).toBe(0);
    expect(result.pendingDebtHorizonCents).toBe(0);
    expect(result.upcomingPayments).toEqual([]);
    expect(result.alreadyPaid).toEqual(['Rent']);
  });
});

describe('calculateRunway: прожигание', () => {
  it('берёт среднее по окну 30 дней и не опускается ниже 15 €/день', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Wallet', currency: 'EUR', initialBalanceCents: 1_000_000 });
    await createTransaction(USER, {
      kind: 'expense',
      amountCents: 30_000,
      accountName: 'Wallet',
      occurredAt: '2026-10-08T10:00:00.000Z',
    });
    // Вне окна — не должна влиять.
    await createTransaction(USER, {
      kind: 'expense',
      amountCents: 50_000,
      accountName: 'Wallet',
      occurredAt: '2026-09-01T10:00:00.000Z',
    });

    const result = await calculateRunway(USER, { now: NOW });

    // 300 € / 30 дней = 10 € → пол 15 €.
    expect(result.dailyBurnCents).toBe(1500);
  });
});

describe('calculateRunway: валюты', () => {
  it('без курса счёт не даёт ликвидности в EUR', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'USD wallet', currency: 'USD', initialBalanceCents: 20_000 });

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.accounts[0].balanceCents).toBe(20_000);
    expect(result.accounts[0].balanceEurCents).toBe(0);
    expect(result.totalLiquidCents).toBe(0);
    expect(result.spendableCents).toBe(0);
  });

  it('с курсом считает в EUR и выводит в валюте пользователя', async () => {
    await ensureUser(USER);
    await setRates('2026-11-06', { USD: 1.25 }, 'EUR');
    await updateUser(USER, { baseCurrency: 'USD' });
    await createAccount(USER, { name: 'USD wallet', currency: 'USD', initialBalanceCents: 20_000 });

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.accounts[0].balanceEurCents).toBe(16_000); // 200 / 1,25
    expect(result.spendableCents).toBe(16_000);
    expect(result.baseCurrency).toBe('USD');
    expect(result.base.spendableCents).toBe(20_000);
  });

  it('без курса валюты пользователя остаётся EUR', async () => {
    await ensureUser(USER);
    await setRates('2026-11-06', { USD: 1.25 }, 'EUR');
    await updateUser(USER, { baseCurrency: 'GBP' });
    await createAccount(USER, { name: 'Wallet', currency: 'EUR', initialBalanceCents: 10_000 });

    const result = await calculateRunway(USER, { now: NOW });

    expect(result.baseCurrency).toBe('EUR');
    expect(result.base.spendableCents).toBe(10_000);
  });
});

describe('calculateRunway: горизонт', () => {
  it('в последний день месяца планирует на весь следующий месяц', async () => {
    await ensureUser(USER);

    const result = await calculateRunway(USER, { now: new Date('2026-11-30T10:00:00.000Z') });

    expect(result.horizonDays).toBe(31); // декабрь
  });
});

describe('calculateRunway: просрочка и закрытие месяца', () => {
  it('просроченный платёж входит в горизонт, а закрытие месяца складывает платежи с прожиганием', async () => {
    await ensureUser(USER);
    const main = await createAccount(USER, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      amountCents: 40_000,
      currency: 'EUR',
      monthlyPaymentCents: 40_000,
      paymentDay: 5, // 5 ноября < NOW (6 ноября) — просрочен
      accountId: main.id,
    });

    const result = await calculateRunway(USER, { now: NOW, dailyBurnOverrideCents: 2000 });

    // Просрочка не выпадает из горизонта: иначе дыра пряталась.
    expect(result.pendingDebtHorizonCents).toBe(40_000);
    expect(result.reservedGapCents).toBe(0);

    // Закрытие месяца: платежи месяца + прожигание на остаток дней − ликвидность.
    expect(result.daysRemainingInMonth).toBe(25);
    expect(result.monthCloseBurnCents).toBe(50_000); // 2000 × 25
    expect(result.monthCloseGapCents).toBe(-10_000); // 40 000 + 50 000 − 100 000
    expect(result.base.monthCloseGapCents).toBe(-10_000);
  });

  it('оплаченное за месяц в горизонт не попадает', async () => {
    await ensureUser(USER);
    const main = await createAccount(USER, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      amountCents: 40_000,
      currency: 'EUR',
      monthlyPaymentCents: 40_000,
      paymentDay: 5,
      paidMonths: ['2026-11'],
      accountId: main.id,
    });

    const result = await calculateRunway(USER, { now: NOW, dailyBurnOverrideCents: 2000 });

    expect(result.pendingDebtHorizonCents).toBe(0);
    expect(result.alreadyPaid).toContain('Rent');
  });
});

describe('calculateRunway: Волна 2 переопределения из user_prefs', () => {
  it('применяет reserveCents и параметры runway, сохраняя приоритет явных opts', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Main', currency: 'EUR', initialBalanceCents: 100_000 });
    await saveUserPrefs(USER, {
      finance: {
        reserveCents: 20_000, // 200 € резерв
        runway: {
          dailyBurnOverrideCents: 4_000, // 40 €/день
          horizonDays: 10,
        },
      },
    });

    const fromPrefs = await calculateRunway(USER, { now: NOW });
    expect(fromPrefs.reservedCents).toBe(20_000);
    expect(fromPrefs.spendableCents).toBe(80_000);
    expect(fromPrefs.dailyBurnCents).toBe(4_000);
    expect(fromPrefs.horizonDays).toBe(10);

    // Явные opts перекрывают prefs
    const explicitWins = await calculateRunway(USER, {
      now: NOW,
      dailyBurnOverrideCents: 5_000,
      horizonDays: 15,
    });
    expect(explicitWins.dailyBurnCents).toBe(5_000);
    expect(explicitWins.horizonDays).toBe(15);
  });
});
