/**
 * Тулза агента `get_runway_forecast` (SPEC §3 T13).
 *
 * Держим инварианты тулзы:
 *  - контент строится из `result.base.*` в валюте пользователя и не содержит
 *    float-мусора (деньги печатаются через formatCents/formatMoney);
 *  - `data.*_cents` — целые числа (ADR-003: на границе DAL только INTEGER cents);
 *  - `daily_burn_override` принимает десятичную строку и валидируется мягко:
 *    кривой аргумент даёт `ok:false`, а не исключение;
 *  - тулза видит только данные своего пользователя.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import { runwayTools } from '../../../src/lib/agent/tools/runway';
import type { Tool, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { createAccount, createLiability } from '../../../src/lib/dal/finances';
import { ensureUser, updateUser } from '../../../src/lib/dal/users';
import { formatMoney } from '../../../src/lib/utils';
import type { IsoMonth, LiabilityQueue } from '../../../src/types';

const USER_A = 1;
const USER_B = 2;

/** Фиксированный момент: 15 марта, 11:00 по Белграду. */
const NOW = new Date('2026-03-15T10:00:00.000Z');

const CTX_A: ToolContext = {
  userId: USER_A,
  timezone: 'Europe/Belgrade',
  baseCurrency: 'EUR',
  now: NOW,
};

function contextFor(userId: number): ToolContext {
  return { ...CTX_A, userId };
}

const forecastTool: Tool = (() => {
  const found = runwayTools.find((tool) => tool.name === 'get_runway_forecast');
  if (!found) throw new Error('get_runway_forecast не зарегистрирована в runwayTools');
  return found;
})();

async function run(args: Record<string, unknown>, ctx: ToolContext = CTX_A): Promise<ToolOutcome> {
  const outcome = await forecastTool.run(args, ctx);
  return typeof outcome === 'string' ? { ok: true, content: outcome } : outcome;
}

interface ForecastData {
  currency: string;
  base_currency: string;
  horizon_days: number;
  total_liquid_cents: number;
  spendable_cents: number;
  reserved_cents: number;
  pending_debt_horizon_cents: number;
  reserved_gap_cents: number;
  daily_burn_cents: number;
  safe_daily_cents: number;
  runway_days: number;
  runway_months: number;
  upcoming_payments: Array<{
    id: number;
    name: string;
    monthly_payment_cents: number;
    currency: string;
    amount_eur_cents: number;
    payment_day: number | null;
  }>;
  already_paid: string[];
}

function dataOf(outcome: ToolOutcome): ForecastData {
  return outcome.data as ForecastData;
}

/** Все суммы в data — целые центы. */
function expectIntegerCents(data: ForecastData): void {
  const values = [
    data.total_liquid_cents,
    data.spendable_cents,
    data.reserved_cents,
    data.pending_debt_horizon_cents,
    data.reserved_gap_cents,
    data.daily_burn_cents,
    data.safe_daily_cents,
  ];
  for (const value of values) {
    expect(Number.isInteger(value)).toBe(true);
  }
  for (const payment of data.upcoming_payments) {
    expect(Number.isInteger(payment.monthly_payment_cents)).toBe(true);
    expect(Number.isInteger(payment.amount_eur_cents)).toBe(true);
  }
}

async function seedUser(userId: number): Promise<void> {
  await ensureUser(userId);
  await updateUser(userId, { timezone: 'Europe/Belgrade' });
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

describe('runway: окружение и базовый сценарий', () => {
  it('печатает runway по сид-прожиганию 20 €/день в валюте пользователя', async () => {
    await seedUser(USER_A);
    await createAccount(USER_A, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 300_000,
    });

    const outcome = await run({});
    expect(outcome.ok).toBe(true);

    const data = dataOf(outcome);
    expect(data.currency).toBe('EUR');
    expect(data.base_currency).toBe('EUR');
    expect(data.horizon_days).toBe(17); // 31 - 15 + 1
    expect(data.spendable_cents).toBe(300_000);
    expect(data.daily_burn_cents).toBe(2000); // сид: нет трат за 30 дней
    expect(data.runway_days).toBe(150); // 3000 € / 20 € в день
    expect(data.runway_months).toBe(5);
    expect(data.safe_daily_cents).toBe(Math.round(300_000 / 17));
    expectIntegerCents(data);

    expect(outcome.content).toContain(formatMoney(300_000, 'EUR'));
    expect(outcome.content).toContain(formatMoney(2000, 'EUR'));
    expect(outcome.content).toContain('150 дн.');
    expect(outcome.content).toContain('~5 мес.');
    // нет float-артефактов вроде 1234.5600000001
    expect(outcome.content).not.toMatch(/\d[,.]\d{3,}/);
  });

  it('daily_burn_override переопределяет прожигание и меняет runway', async () => {
    await seedUser(USER_A);
    await createAccount(USER_A, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 300_000,
    });

    const outcome = await run({ daily_burn_override: '50' });
    expect(outcome.ok).toBe(true);

    const data = dataOf(outcome);
    expect(data.daily_burn_cents).toBe(5000);
    expect(data.runway_days).toBe(60); // 3000 € / 50 € в день
    expect(data.runway_months).toBe(2);
    expectIntegerCents(data);

    expect(outcome.content).toContain(formatMoney(5000, 'EUR'));
    expect(outcome.content).toContain('60 дн.');
  });

  it('принимает дробный расход в десятичной строке без float-утечек', async () => {
    await seedUser(USER_A);
    await createAccount(USER_A, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });

    const outcome = await run({ daily_burn_override: '33,33' });
    expect(outcome.ok).toBe(true);

    const data = dataOf(outcome);
    expect(data.daily_burn_cents).toBe(3333);
    expect(Number.isInteger(data.spendable_cents)).toBe(true);
    expect(outcome.content).toContain(formatMoney(3333, 'EUR'));
    expect(outcome.content).not.toMatch(/\d[,.]\d{3,}/);
  });
});

describe('runway: кривые аргументы', () => {
  it('не-число и отрицательный расход — ok:false без исключения', async () => {
    await expect(run({ daily_burn_override: 'abc' })).resolves.toMatchObject({ ok: false });
    const bad = await run({ daily_burn_override: 'abc' });
    expect(bad.content).toContain('Не понял');

    const negative = await run({ daily_burn_override: '-100' });
    expect(negative.ok).toBe(false);
    expect(negative.content).toContain('больше нуля');

    const zero = await run({ daily_burn_override: '0' });
    expect(zero.ok).toBe(false);
    expect(zero.content).toContain('больше нуля');

    const wrongType = await run({ daily_burn_override: { amount: 10 } });
    expect(wrongType.ok).toBe(false);
  });

  it('пустая строка трактуется как «аргумент не задан»', async () => {
    await seedUser(USER_A);
    await createAccount(USER_A, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 300_000,
    });

    const outcome = await run({ daily_burn_override: '   ' });
    expect(outcome.ok).toBe(true);
    expect(dataOf(outcome).daily_burn_cents).toBe(2000);
  });
});

describe('runway: обязательства и резерв', () => {
  it('показывает предстоящие платежи и считает спендабельным только свободное', async () => {
    await seedUser(USER_A);
    const account = await createAccount(USER_A, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    await createLiability(USER_A, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 20,
      accountId: account.id,
    });

    const outcome = await run({});
    expect(outcome.ok).toBe(true);

    const data = dataOf(outcome);
    expect(data.reserved_cents).toBe(40_000);
    expect(data.spendable_cents).toBe(60_000);
    expect(data.pending_debt_horizon_cents).toBe(40_000);
    expect(data.upcoming_payments).toHaveLength(1);
    expect(data.upcoming_payments[0]).toMatchObject({
      name: 'Rent',
      monthly_payment_cents: 40_000,
      payment_day: 20,
    });
    expectIntegerCents(data);

    expect(outcome.content).toContain('Предстоящие платежи');
    expect(outcome.content).toContain('Rent');
    expect(outcome.content).toContain(formatMoney(60_000, 'EUR'));
  });

  it('оплаченное обязательство не резервируется и попадает в «Уже оплачено»', async () => {
    await seedUser(USER_A);
    await createAccount(USER_A, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    await createLiability(USER_A, {
      name: 'Internet',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 1500,
      paymentDay: 5,
      paidMonths: ['2026-03' as IsoMonth],
    });

    const outcome = await run({});
    expect(outcome.ok).toBe(true);

    const data = dataOf(outcome);
    expect(data.reserved_cents).toBe(0);
    expect(data.spendable_cents).toBe(100_000);
    expect(data.already_paid).toEqual(['Internet']);
    expect(data.upcoming_payments).toEqual([]);

    expect(outcome.content).toContain('Уже оплачено в этом месяце: Internet');
    expect(outcome.content).not.toContain('Предстоящие платежи');
  });
});

describe('runway: изоляция пользователей', () => {
  it('второй пользователь видит только свои деньги', async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);
    await createAccount(USER_A, {
      name: 'A-wallet',
      currency: 'EUR',
      initialBalanceCents: 300_000,
    });
    await createAccount(USER_B, {
      name: 'B-wallet',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });

    const outcome = await run({}, contextFor(USER_B));
    expect(outcome.ok).toBe(true);

    const data = dataOf(outcome);
    expect(data.spendable_cents).toBe(100_000);
    expect(outcome.content).toContain(formatMoney(100_000, 'EUR'));
    expect(outcome.content).not.toContain(formatMoney(300_000, 'EUR'));
  });
});
