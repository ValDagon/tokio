/**
 * «Проверка списаний»: решение владельца по обязательству за месяц
 * (`applyLiabilityReviewChoice`, `lrev:<id>:<YYYY-MM>:<p|n|d>`).
 *
 * Что здесь закреплено:
 *  - «оплатил» проводит платёж без движения денег по счетам и без транзакции;
 *  - «не оплатил» пишет только решение в `kv`, финансы не трогает;
 *  - двойное нажатие уменьшает долг ровно один раз (первое решение побеждает);
 *  - «удалить» стирает обязательство, но не откатывает прошлые транзакции;
 *  - callback из прошлого месяца и чужая кнопка ничего не меняют.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  createAccount,
  createLiability,
  getAccount,
  getLiability,
  listTransactions,
  payLiability,
} from '../../src/lib/dal/finances';
import { kvGet, liabilityReviewKey } from '../../src/lib/dal/misc';
import { ensureUser, updateUser } from '../../src/lib/dal/users';
import {
  applyLiabilityReviewChoice,
  LIABILITY_REVIEW_STALE_TOAST,
  LIABILITY_REVIEW_TAKEN_TOAST,
} from '../../src/handlers/ingest';

const USER = 100001;
const OTHER = 2002;
const NOW = new Date('2026-11-10T18:00:00.000Z');
const MONTH = '2026-11';

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  await ensureUser(USER, 'Owner');
  await updateUser(USER, { timezone: 'UTC' });
  await ensureUser(OTHER, 'Other');
  await updateUser(OTHER, { timezone: 'UTC' });
});

const CHOICE = (liabilityId: number, action: 'p' | 'n' | 'd', month = MONTH): string =>
  `lrev:${liabilityId}:${month}:${action}`;

/** Кредит на 1200 €, платёж 350 €, привязан к счёту с 1000 €. */
async function seedLoan() {
  const account = await createAccount(USER, {
    name: 'Main',
    currency: 'EUR',
    initialBalanceCents: 100_000,
  });
  const liability = await createLiability(USER, {
    name: 'Кредит',
    queue: 'queue_2',
    amountCents: 120_000,
    monthlyPaymentCents: 35_000,
    paymentDay: 5,
    accountId: account.id,
  });
  return { account, liability };
}

describe('проверка списаний: «оплатил»', () => {
  it('оплатил кредит не трогает счёт и не пишет транзакцию', async () => {
    const { account, liability } = await seedLoan();

    const result = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'p'),
      now: NOW,
    });

    expect(result.alert).not.toBe(true);
    expect(result.toast).toContain('оплачено');

    const updated = await getLiability(USER, liability.id);
    expect(updated?.paidMonths).toEqual([MONTH]);
    expect(updated?.amountCents).toBe(85_000);
    expect(updated?.lastPaymentDate).toBe('2026-11-05');

    // Деньги не двигаются: счёт и журнал транзакций те же.
    expect((await getAccount(USER, account.id))?.currentBalanceCents).toBe(100_000);
    expect(await listTransactions(USER)).toHaveLength(0);

    const stored = await kvGet(liabilityReviewKey(USER, liability.id, MONTH));
    expect(stored).not.toBeNull();
    expect(JSON.parse(String(stored))).toMatchObject({
      decision: 'paid',
      dueAt: '2026-11-05',
    });
  });

  it('два нажатия уменьшают долг один раз', async () => {
    const { liability } = await seedLoan();

    await applyLiabilityReviewChoice({ userId: USER, data: CHOICE(liability.id, 'p'), now: NOW });
    const second = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'p'),
      now: NOW,
    });

    expect(second.toast).toBe(LIABILITY_REVIEW_TAKEN_TOAST);
    const updated = await getLiability(USER, liability.id);
    expect(updated?.paidMonths).toEqual([MONTH]);
    expect(updated?.amountCents).toBe(85_000);
  });

  it('другое действие после «оплатил» финансово ничего не меняет', async () => {
    const { liability } = await seedLoan();

    await applyLiabilityReviewChoice({ userId: USER, data: CHOICE(liability.id, 'p'), now: NOW });
    const other = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'n'),
      now: NOW,
    });

    expect(other.toast).toBe(LIABILITY_REVIEW_TAKEN_TOAST);
    expect((await getLiability(USER, liability.id))?.paidMonths).toEqual([MONTH]);
    expect(JSON.parse(String(await kvGet(liabilityReviewKey(USER, liability.id, MONTH))))).toMatchObject({
      decision: 'paid',
    });
  });
});

describe('проверка списаний: «не оплатил»', () => {
  it('пишет только KV и не трогает финансы', async () => {
    const { account, liability } = await seedLoan();

    const result = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'n'),
      now: NOW,
    });

    expect(result.toast).toContain('не оплачено');

    const stored = await kvGet(liabilityReviewKey(USER, liability.id, MONTH));
    expect(JSON.parse(String(stored))).toMatchObject({
      decision: 'unpaid',
      dueAt: '2026-11-05',
    });

    const untouched = await getLiability(USER, liability.id);
    expect(untouched?.paidMonths).toEqual([]);
    expect(untouched?.amountCents).toBe(120_000);
    expect((await getAccount(USER, account.id))?.currentBalanceCents).toBe(100_000);
    expect(await listTransactions(USER)).toHaveLength(0);
  });
});

describe('проверка списаний: «удалить»', () => {
  it('стирает обязательство и не откатывает прошлые транзакции', async () => {
    const { account, liability } = await seedLoan();
    const previous = await payLiability(USER, {
      liabilityId: liability.id,
      paymentDate: '2026-10-05',
      deductFromAccount: true,
    });
    expect(previous.transaction).not.toBeNull();
    expect(await listTransactions(USER)).toHaveLength(1);

    const result = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'd'),
      now: NOW,
    });

    expect(result.toast).toContain('удалено');
    expect(await getLiability(USER, liability.id)).toBeNull();
    // Прошлый платёж остаётся в журнале, баланс не восстанавливается.
    expect(await listTransactions(USER)).toHaveLength(1);
    expect((await getAccount(USER, account.id))?.currentBalanceCents).toBe(65_000);
  });
});

describe('проверка списаний: отказы без записей', () => {
  it('callback из прошлого месяца ничего не меняет', async () => {
    const { liability } = await seedLoan();

    const result = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'p', '2026-10'),
      now: NOW,
    });

    expect(result.toast).toBe(LIABILITY_REVIEW_STALE_TOAST);
    expect(await kvGet(liabilityReviewKey(USER, liability.id, '2026-10'))).toBeNull();
    expect((await getLiability(USER, liability.id))?.paidMonths).toEqual([]);
    expect(callsOf('sendMessage')).toHaveLength(0);
  });

  it('будущий месяц тоже не принимается', async () => {
    const { liability } = await seedLoan();

    const result = await applyLiabilityReviewChoice({
      userId: USER,
      data: CHOICE(liability.id, 'p', '2026-12'),
      now: NOW,
    });

    expect(result.toast).toBe(LIABILITY_REVIEW_STALE_TOAST);
    expect(await kvGet(liabilityReviewKey(USER, liability.id, '2026-12'))).toBeNull();
    expect((await getLiability(USER, liability.id))?.paidMonths).toEqual([]);
  });

  it('чужое обязательство не находится и не пишет решение', async () => {
    const { liability } = await seedLoan();

    const result = await applyLiabilityReviewChoice({
      userId: OTHER,
      data: CHOICE(liability.id, 'p'),
      now: NOW,
    });

    expect(result.alert).toBe(true);
    expect(await kvGet(liabilityReviewKey(OTHER, liability.id, MONTH))).toBeNull();
    expect((await getLiability(USER, liability.id))?.paidMonths).toEqual([]);
  });

  it('битая кнопка → отказ', async () => {
    const result = await applyLiabilityReviewChoice({
      userId: USER,
      data: 'lrev:42:2026-11:x',
      now: NOW,
    });

    expect(result.alert).toBe(true);
  });
});
