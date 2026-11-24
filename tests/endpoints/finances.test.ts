/**
 * T16 endpoints: финансы.
 *
 * Покрытие REST-эндпоинтов `src/endpoints/finances_*` + `liability_*` +
 * `account_balance_set`:
 *  - авторизация (`requireUserId` → `EndpointError('Unauthorized')`);
 *  - форматы ответов (деньги — float, id — строки, имена из JOIN);
 *  - фильтрация/лимиты, месячная сводка, бюджеты, обязательства и их оплата,
 *    откат последней операции и очистка истории.
 *
 * Данные только самосевные: каждое утверждение опирается на значения,
 * созданные самим тестом. `fx_rates` пуст → EUR-счета конвертируются 1:1.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import {
  createAccount,
  createExchange,
  createLiability,
  createTransaction,
  getAccount,
  setBudget,
} from '../../src/lib/dal/finances';
import financesAccounts from '../../src/endpoints/finances_accounts';
import financesSummary from '../../src/endpoints/finances_summary';
import financesTransactions from '../../src/endpoints/finances_transactions';
import financesBudgetsSet from '../../src/endpoints/finances_budgets_set';
import financesLiabilities from '../../src/endpoints/finances_liabilities';
import liabilityUpdate from '../../src/endpoints/liability_update';
import liabilityPay from '../../src/endpoints/liability_pay';
import financesUndo from '../../src/endpoints/finances_undo';
import financesReset from '../../src/endpoints/finances_reset';
import accountBalanceSet from '../../src/endpoints/account_balance_set';
import { setRates } from '../../src/lib/dal/fx';
import type { LiabilityQueue } from '../../src/lib/types';


const TEST_USER = 777000111;
const mockCtx = { initData: { user: { id: TEST_USER } } };

const UNAUTHORIZED = {
  name: 'EndpointError',
  message: 'Unauthorized',
  parameters: { code: 'UNAUTHORIZED' },
};

/** Текущий месяц по UTC — так же, как его считают эндпоинты (`todayIso()`). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Дата `YYYY-MM-DD` на N дней назад от сегодняшней UTC-даты. */
function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

describe('T16 endpoints: finances', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('без initData финансы отвечают Unauthorized', async () => {
    const unauthenticated = [
      () => financesAccounts({}, undefined),
      () => financesReset({}, undefined),
    ];

    for (const call of unauthenticated) {
      await expect(call()).rejects.toMatchObject(UNAUTHORIZED);
    }
  });

  it('finances_accounts отдаёт активные счета с балансом в EUR', async () => {
    await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 150000,
    });

    const accounts = await financesAccounts({}, mockCtx);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      id: expect.any(String),
      name: 'Основной',
      currency: 'EUR',
      current_balance: 1500,
      balance_eur: 1500,
      is_active: true,
    });
    expect(Number(accounts[0].id)).toBeGreaterThan(0);
  });

  it('finances_summary считает нетто-капитал, траты, доходы и категории за месяц', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 150000,
    });

    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 5000,
      accountId: account.id,
      categoryName: 'Продукты',
      description: 'Пятёрочка',
      occurredAt: daysAgoIso(0),
    });
    await createTransaction(TEST_USER, {
      kind: 'income',
      amountCents: 20000,
      accountId: account.id,
      categoryName: 'Зарплата',
      description: 'Аванс',
      occurredAt: daysAgoIso(0),
    });
    await setBudget(TEST_USER, {
      categoryName: 'Продукты',
      month: currentMonth(),
      limitAmountEurCents: 10000,
    });

    const summary = await financesSummary({}, mockCtx);

    expect(summary.month).toBe(currentMonth());
    expect(summary.total_spent_eur).toBe(50);
    expect(summary.total_income_eur).toBe(200);
    // 150000 - 5000 + 20000 = 165000 центов
    expect(summary.total_net_worth_eur).toBe(1650);

    expect(Array.isArray(summary.categories)).toBe(true);
    expect(summary.categories).toHaveLength(1);
    expect(summary.categories[0]).toEqual({
      category_id: expect.any(String),
      category_name: 'Продукты',
      spent_eur: 50,
      limit_eur: 100,
      percent_used: 50,
    });

    for (const value of [
      summary.total_net_worth_eur,
      summary.total_spent_eur,
      summary.total_income_eur,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(summary.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('finances_summary считает total_budgeted_eur / total_budgeted_spent_eur и показывает категории с 0 трат', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 100000,
    });
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 6000,
      accountId: account.id,
      categoryName: 'Продукты',
      occurredAt: daysAgoIso(0),
    });
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 3000,
      accountId: account.id,
      categoryName: 'Безлимит',
      occurredAt: daysAgoIso(0),
    });
    await setBudget(TEST_USER, {
      categoryName: 'Продукты',
      month: currentMonth(),
      limitAmountEurCents: 10000,
    });
    await setBudget(TEST_USER, {
      categoryName: 'Аренда',
      month: currentMonth(),
      limitAmountEurCents: 50000,
    });

    const summary = await financesSummary({}, mockCtx);
    expect(summary.total_spent_eur).toBe(90);
    expect(summary.total_budgeted_eur).toBe(600);
    expect(summary.total_budgeted_spent_eur).toBe(60);

    const rent = summary.categories.find((c) => c.category_name === 'Аренда');
    expect(rent).toBeDefined();
    expect(rent).toMatchObject({
      category_name: 'Аренда',
      spent_eur: 0,
      limit_eur: 500,
      percent_used: 0,
    });
  });

  it('finances_transactions отдаёт операции с именами и соблюдает limit', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 100000,
    });

    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 2500,
      accountId: account.id,
      categoryName: 'Кафе',
      description: 'Кофе',
      occurredAt: daysAgoIso(0),
    });
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 1000,
      accountId: account.id,
      categoryName: 'Кафе',
      description: 'Чай',
      occurredAt: daysAgoIso(1),
    });
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 700,
      accountId: account.id,
      categoryName: 'Кафе',
      description: 'Круассан',
      occurredAt: daysAgoIso(2),
    });

    const all = await financesTransactions({}, mockCtx);
    expect(all).toHaveLength(3);

    const latest = all[0];
    expect(latest).toEqual({
      id: expect.any(String),
      occurred_at: `${daysAgoIso(0)}T00:00:00.000Z`,
      kind: 'expense',
      amount: 25,
      currency: 'EUR',
      amount_eur: 25,
      fx_rate: 1,
      account_name: 'Основной',
      to_account_name: null,
      category_name: 'Кафе',
      description: 'Кофе',
      transfer_group_id: null,
    });

    const limited = await financesTransactions({ limit: 2 }, mockCtx);
    expect(limited).toHaveLength(2);
    expect(limited.map((item) => item.description)).toEqual(['Кофе', 'Чай']);

    await expect(financesTransactions({ limit: 1.5 }, mockCtx)).rejects.toMatchObject({
      message: 'limit must be an integer',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('finances_transactions отдаёт общий transfer_group_id ног обмена', async () => {
    const eur = await createAccount(TEST_USER, {
      name: 'Евро',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    const usd = await createAccount(TEST_USER, { name: 'Доллар', currency: 'USD' });

    const exchange = await createExchange(TEST_USER, {
      fromAccountId: eur.id,
      fromCents: 10_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 10_800,
      toCurrency: 'USD',
      rates: { USD: 1.08 },
    });

    const rows = await financesTransactions({}, mockCtx);
    const legs = rows.filter((row) => row.kind === 'exchange');
    expect(legs.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-100, 108]);
    expect(legs.map((row) => row.transfer_group_id)).toEqual([
      exchange.groupId,
      exchange.groupId,
    ]);
    // Mini App группирует по этому полю: вне обмена оно всегда null.
    expect(rows.filter((row) => row.kind !== 'exchange').every((row) => row.transfer_group_id === null)).toBe(true);
  });

  it('finances_budgets_set сохраняет лимит категории на текущий месяц', async () => {
    const response = await financesBudgetsSet(
      { category_name: 'Продукты', limit_amount_eur: 120.5 },
      mockCtx,
    );

    expect(response).toEqual({
      status: 'ok',
      month: currentMonth(),
      limit_amount_eur: 120.5,
    });
  });

  it('finances_liabilities отдаёт обязательство с признаком оплаты и счётом', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 150000,
    });
    const liability = await createLiability(TEST_USER, {
      name: 'Кредит',
      queue: 'queue_1',
      amountCents: 200000,
      monthlyPaymentCents: 20000,
      paymentDay: 5,
      notes: 'банк',
      accountId: account.id,
    });

    const liabilities = await financesLiabilities({}, mockCtx);

    expect(liabilities).toHaveLength(1);
    expect(liabilities[0]).toEqual({
      id: String(liability.id),
      name: 'Кредит',
      queue: 'queue_1',
      amount: 2000,
      currency: 'EUR',
      amount_eur: 2000,
      monthly_payment: 200,
      monthly_payment_eur: 200,
      payment_day: 5,
      total_payments: null,
      end_date: null,
      notes: 'банк',
      is_active: true,
      paid_months: [],
      is_paid_this_month: false,
      last_payment_date: null,
      account_id: String(account.id),
      account_name: 'Основной',
    });
    expect(typeof liabilities[0].is_paid_this_month).toBe('boolean');
  });

  it('liability_update: 404 для чужого id и патч notes для своего', async () => {
    const liability = await createLiability(TEST_USER, {
      name: 'Кредит',
      queue: 'queue_1',
      amountCents: 200000,
      monthlyPaymentCents: 20000,
    });

    await expect(liabilityUpdate({ id: 999999, notes: 'x' }, mockCtx)).rejects.toMatchObject({
      message: 'Обязательство не найдено',
      parameters: { code: 'NOT_FOUND' },
    });

    const updated = await liabilityUpdate({ id: liability.id, notes: 'x' }, mockCtx);
    expect(updated.id).toBe(String(liability.id));
    expect(updated.name).toBe('Кредит');
    expect(updated.notes).toBe('x');
    expect(updated.is_active).toBe(true);
  });

  it('liability_pay: частичная и полная оплата уменьшают остаток', async () => {
    const liability = await createLiability(TEST_USER, {
      name: 'Кредит',
      queue: 'queue_1',
      amountCents: 100000,
      monthlyPaymentCents: 10000,
    });

    const partial = await liabilityPay({ id: liability.id, amount: 400 }, mockCtx);
    expect(partial.status).toBe('ok');
    expect(partial.message).toContain('Кредит');
    expect(typeof partial.new_amount).toBe('number');
    expect(partial.new_amount).toBe(600);
    expect(partial.paid_months).toContain(currentMonth());

    // Остаток добиваем платежом за другой месяц (в текущем оплата идемпотентна).
    const rest = await liabilityPay(
      { id: liability.id, amount: 600, payment_date: '2020-01-15' },
      mockCtx,
    );
    expect(rest.status).toBe('ok');
    expect(rest.new_amount).toBe(0);
    expect(rest.paid_months).toEqual([currentMonth(), '2020-01']);
  });

  it('finances_undo и finances_reset отвечают ok и очищают историю', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 100000,
    });
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 2500,
      accountId: account.id,
      categoryName: 'Кафе',
      description: 'Кофе',
    });

    const undone = await financesUndo({}, mockCtx);
    expect(undone.status).toBe('ok');
    expect(typeof undone.message).toBe('string');
    expect(undone.message).toContain('Кофе');
    await expect(financesTransactions({}, mockCtx)).resolves.toHaveLength(0);

    const reset = await financesReset({}, mockCtx);
    expect(reset).toEqual({ status: 'ok', message: 'Финансовая история очищена' });
  });

  it('finances_undo при недокрытии называет возврат, а не номинал', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 1_500,
    });
    // 20 EUR при 15 EUR на счёте: списывается 15, остальное — непокрытая разница.
    await createTransaction(TEST_USER, {
      kind: 'expense',
      amountCents: 2_000,
      accountId: account.id,
      description: 'Кофе',
    });

    const undone = await financesUndo({}, mockCtx);

    expect(undone.status).toBe('ok');
    expect(undone.message).toContain('расход 20,00 EUR');
    expect(undone.message).toContain('на счёт вернулось 15,00 EUR');
    // Второй строкой баланс — новое состояние счёта, а не номинал.
    expect(undone.message).toContain('15,00 EUR.');
    expect((await getAccount(TEST_USER, account.id))?.currentBalanceCents).toBe(1_500);
  });

  it('finances_undo отменяет обмен целиком и называет обе ноги', async () => {
    await setRates('2020-01-01', { USD: 1.08 });
    const eur = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 100000,
    });
    const usd = await createAccount(TEST_USER, { name: 'Доллары', currency: 'USD' });
    await createExchange(TEST_USER, {
      fromAccountId: eur.id,
      fromCents: 10000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 10800,
      toCurrency: 'USD',
    });

    const undone = await financesUndo({}, mockCtx);

    expect(undone.status).toBe('ok');
    expect(undone.message).toContain('Обмен');
    expect(undone.message).toContain('100,00 EUR');
    expect(undone.message).toContain('108,00 USD');
    await expect(financesTransactions({}, mockCtx)).resolves.toHaveLength(0);
    expect((await getAccount(TEST_USER, eur.id))?.currentBalanceCents).toBe(100000);
    expect((await getAccount(TEST_USER, usd.id))?.currentBalanceCents).toBe(0);
  });

  it('finances_undo при доборе с KZT называет обмен, а не техническую ногу', async () => {
    await setRates('2020-01-01', { KZT: 500, USD: 1.08 });
    const kzt = await createAccount(TEST_USER, {
      name: 'Банк',
      currency: 'KZT',
      initialBalanceCents: 1_000_000,
    });
    const eur = await createAccount(TEST_USER, { name: 'Банк', currency: 'EUR' });
    const usd = await createAccount(TEST_USER, { name: 'Доллары', currency: 'USD' });
    await createExchange(TEST_USER, {
      fromAccountId: eur.id,
      fromCents: 1_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 1_080,
      toCurrency: 'USD',
    });

    const undone = await financesUndo({}, mockCtx);

    expect(undone.status).toBe('ok');
    expect(undone.message).toContain('10,00 EUR');
    expect(undone.message).toContain('10,80 USD');
    expect((await getAccount(TEST_USER, kzt.id))?.currentBalanceCents).toBe(1_000_000);
    await expect(financesTransactions({}, mockCtx)).resolves.toHaveLength(0);
  });

  it('account_balance_set меняет остаток счёта и эхом отдаёт сумму', async () => {
    const account = await createAccount(TEST_USER, {
      name: 'Основной',
      currency: 'EUR',
      initialBalanceCents: 150000,
    });

    const response = await accountBalanceSet(
      { account_id: String(account.id), balance: 777.77 },
      mockCtx,
    );
    expect(response).toEqual({ status: 'ok', balance: 777.77 });

    const accounts = await financesAccounts({}, mockCtx);
    expect(accounts[0].current_balance).toBe(777.77);
    expect(accounts[0].balance_eur).toBe(777.77);
  });
});

describe('finances_liabilities: amount_eur по живому курсу', () => {
  it('следует за курсом на момент чтения, а не за сохранённым значением', async () => {
    await setRates('2026-03-15', { USD: 1.1 });
    const liability = await createLiability(TEST_USER, {
      name: 'VPS',
      currency: 'USD',
      amountCents: 2000,
      monthlyPaymentCents: 2000,
      paymentDay: 10,
      queue: 'subscription' as unknown as LiabilityQueue,
    });

    const before = await financesLiabilities({}, mockCtx);
    const first = before.find((item) => item.id === String(liability.id));
    expect(first?.amount_eur).toBe(18.18); // 20 $ / 1.1
    expect(first?.monthly_payment_eur).toBe(18.18);

    // Курс изменился, строку в БД никто не трогал.
    await setRates('2026-03-16', { USD: 1.25 });

    const after = await financesLiabilities({}, mockCtx);
    const second = after.find((item) => item.id === String(liability.id));
    expect(second?.amount_eur).toBe(16); // 20 $ / 1.25
    expect(second?.monthly_payment_eur).toBe(16);
  });
});
