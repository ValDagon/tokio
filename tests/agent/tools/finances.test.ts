/**
 * Тулзы агента `src/lib/agent/tools/finances.ts` — контракт для модели:
 * `run` не бросает, ошибки приходят как `{ok:false}`, деньги в `data` — целые
 * центы, изоляция между пользователями сохраняется.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../../mocks/sdk';
import { TABLES } from '../../../src/db/tables';
import { createTableStatements } from '../../../src/db/ddl';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../../../src/lib/agent/registry';
import { financeTools } from '../../../src/lib/agent/tools/finances';
import {
  createAccount,
  createExchange,
  createLiability,
  createTransaction,
  getAccount,
  getLiability,
  listAccounts,
  listLiabilities,
  listTransactions,
} from '../../../src/lib/dal/finances';
import { buildMorningDigest } from '../../../src/lib/digest';
import { calculateRunway } from '../../../src/lib/runway';
import { quickSummary } from '../../../src/lib/summary';
import { setRates } from '../../../src/lib/dal/fx';
import type { LiabilityQueue } from '../../../src/types';

const USER_A = 1;
const USER_B = 2;

const NOW = new Date('2026-03-15T10:00:00Z');

function makeCtx(userId: number): ToolContext {
  return { userId, timezone: 'Europe/Belgrade', baseCurrency: 'EUR', now: NOW };
}

const ctxA = makeCtx(USER_A);
const ctxB = makeCtx(USER_B);

function tool(name: string): Tool {
  const found = financeTools.find((item) => item.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function run(name: string, args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const result = await tool(name).run(args, ctx);
  return typeof result === 'string' ? { ok: true, content: result } : result;
}

async function balanceOf(userId: number, accountId: number): Promise<number> {
  const account = await getAccount(userId, accountId);
  if (!account) throw new Error('balanceOf: account not found');
  return account.currentBalanceCents;
}

async function seedAccounts(userId = USER_A, initialBalanceCents = 100_000) {
  const main = await createAccount(userId, {
    name: 'Main',
    currency: 'EUR',
    initialBalanceCents,
  });
  const cash = await createAccount(userId, { name: 'Cash', currency: 'EUR' });
  return { main, cash };
}

const recurring = (queue: string): LiabilityQueue => queue as unknown as LiabilityQueue;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

// ---------------------------------------------------------------------------
// Контракт модуля
// ---------------------------------------------------------------------------

describe('financeTools: состав', () => {
  it('экспортирует 23 тулзы с уникальными именами', () => {
    expect(financeTools).toHaveLength(23);
    const names = financeTools.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'add_expense',
        'add_income',
        'add_transfer',
        'add_exchange',
        'set_budget',
        'query_spending',
        'can_i_afford',
        'get_fin_balances',
        'set_account_balance',
        'reset_finance_history',
        'undo_last_transaction',
        'edit_last_transaction',
        'adjust_account_balance',
        'mark_liability_paid',
        'link_liability_account',
        'get_liabilities',
        'add_liability',
        'update_liability',
        'delete_liability',
        'update_account',
        'delete_account',
        'list_transactions',
        'delete_transaction',
      ]),
    );
  });

  it('у каждой тулзы есть русское описание и JSON-схема объекта', () => {
    for (const item of financeTools) {
      expect(item.description.length).toBeGreaterThan(10);
      expect(item.schema).toBeTruthy();
      expect((item.schema as Record<string, unknown>).type).toBe('object');
    }
  });
});

// ---------------------------------------------------------------------------
// add_expense / add_income
// ---------------------------------------------------------------------------

describe('add_expense', () => {
  it('записывает расход и уменьшает баланс', async () => {
    const { main } = await seedAccounts();

    const outcome = await run(
      'add_expense',
      {
        amount: '12,50',
        account_name: 'Main',
        category_name: 'Еда',
        description: 'обед',
      },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Записал расход');
    expect(outcome.content).toContain('12,50');
    expect(outcome.content).toContain('Еда');
    expect(outcome.content).toContain('Main');
    expect(outcome.content).toContain('обед');

    const data = outcome.data as Record<string, unknown>;
    expect(data.amount_cents).toBe(1250);
    expect(Number.isInteger(data.amount_cents as number)).toBe(true);
    expect(await balanceOf(USER_A, main.id)).toBe(100_000 - 1250);
  });

  it('без счёта берёт активный счёт пользователя', async () => {
    await seedAccounts();
    const outcome = await run('add_expense', { amount: '5' }, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toMatch(/со счёта «(Main|Cash)»/);
  });

  it('на кривые аргументы отвечает ok:false и не бросает', async () => {
    await seedAccounts();

    await expect(run('add_expense', { amount: 'abc' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });
    await expect(run('add_expense', { amount: '-5' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });
    await expect(run('add_expense', {}, ctxA)).resolves.toMatchObject({ ok: false });
    await expect(run('add_expense', { amount: '0' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });

    const tx = await listTransactions(USER_A, { limit: 10 });
    expect(tx).toHaveLength(0);
  });

  it('не виден другому пользователю', async () => {
    await seedAccounts(USER_A);
    await seedAccounts(USER_B);

    await run('add_expense', { amount: '10', account_name: 'Main' }, ctxA);

    expect(await listTransactions(USER_A, { limit: 10 })).toHaveLength(1);
    expect(await listTransactions(USER_B, { limit: 10 })).toHaveLength(0);
  });
});

describe('add_income', () => {
  it('записывает доход и увеличивает баланс', async () => {
    const { main } = await seedAccounts(USER_A, 10_000);

    const outcome = await run(
      'add_income',
      { amount: '1 000', account_name: 'Main', category_name: 'Зарплата' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Записал доход');
    expect(outcome.content).toContain('1 000,00');
    const data = outcome.data as Record<string, unknown>;
    expect(data.amount_cents).toBe(100_000);
    expect(Number.isInteger(data.amount_cents as number)).toBe(true);
    expect(await balanceOf(USER_A, main.id)).toBe(110_000);
  });

  it('на нечисловую сумму отвечает ok:false', async () => {
    await seedAccounts();
    await expect(run('add_income', { amount: 'много' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });
  });
});

// ---------------------------------------------------------------------------
// add_transfer / add_exchange
// ---------------------------------------------------------------------------

describe('add_transfer', () => {
  it('переводит между счетами одной строкой', async () => {
    const { main, cash } = await seedAccounts();

    const outcome = await run(
      'add_transfer',
      { amount: '300', from_account: 'Main', to_account: 'Cash' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Перевёл');
    expect(await balanceOf(USER_A, main.id)).toBe(100_000 - 30_000);
    expect(await balanceOf(USER_A, cash.id)).toBe(30_000);
    expect(await listTransactions(USER_A, { limit: 10 })).toHaveLength(1);
  });

  it('отказывает при переводе на тот же счёт', async () => {
    await seedAccounts();
    const outcome = await run(
      'add_transfer',
      { amount: '10', from_account: 'Main', to_account: 'Main' },
      ctxA,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content.length).toBeGreaterThan(0);
  });

  it('требует оба счёта', async () => {
    await seedAccounts();
    await expect(
      run('add_transfer', { amount: '10', from_account: 'Main' }, ctxA),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('add_exchange', () => {
  it('меняет валюту, корректируя балансы счетов', async () => {
    await setRates('2026-03-01', { USD: 1.08 });
    const eur = await createAccount(USER_A, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 50_000,
    });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });

    const outcome = await run(
      'add_exchange',
      {
        from_account: 'Main',
        from_amount: '100',
        from_currency: 'EUR',
        to_account: 'Usd',
        to_amount: '108',
        to_currency: 'USD',
      },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Обменял');
    expect(outcome.content).not.toContain('не в истории транзакций');
    expect(await balanceOf(USER_A, eur.id)).toBe(50_000 - 10_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(10_800);

    // обмен виден в истории двумя ногами одной группы
    const rows = await listTransactions(USER_A, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'exchange')).toBe(true);
    const data = outcome.data as Record<string, unknown>;
    expect(data.transaction_id).toBe(rows[1].id);
    expect(data.group_id).toBeTruthy();
    expect(rows[0].transferGroupId).toBe(data.group_id);
    expect(data.from_currency).toBe('EUR');
    expect(data.to_currency).toBe('USD');
  });

  it('на отсутствующие аргументы отвечает ok:false', async () => {
    await seedAccounts();
    await expect(
      run('add_exchange', { from_account: 'Main', from_amount: '100' }, ctxA),
    ).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Инвариант: kind='exchange' не попадает в расходы
// ---------------------------------------------------------------------------

describe('обмен не попадает в расходы', () => {
  it('spentThisMonth, runway, query_spending и summary не меняются после обмена', async () => {
    await setRates('2026-03-01', { USD: 1.08 });
    const { main } = await seedAccounts();
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 1_000,
      accountId: main.id,
      categoryName: 'Еда',
      occurredAt: '2026-03-03T12:00:00Z',
    });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });

    const runwayBefore = await calculateRunway(USER_A, { now: NOW });
    const summaryBefore = await quickSummary(USER_A, { now: NOW });
    const digestBefore = await buildMorningDigest(USER_A, { now: NOW });
    const spendingBefore = await run('query_spending', {}, ctxA);

    // 100 EUR ↔ 108 USD по курсу 1.08: ликвидность в EUR не меняется
    await createExchange(USER_A, {
      fromAccountId: main.id,
      fromCents: 10_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 10_800,
      toCurrency: 'USD',
      occurredAt: NOW,
    });

    const runwayAfter = await calculateRunway(USER_A, { now: NOW });
    expect(runwayAfter.dailyBurnCents).toBe(runwayBefore.dailyBurnCents);
    expect(runwayAfter.monthCloseBurnCents).toBe(runwayBefore.monthCloseBurnCents);
    expect(runwayAfter.spendableCents).toBe(runwayBefore.spendableCents);

    // digest считает spentThisMonth
    expect(await buildMorningDigest(USER_A, { now: NOW })).toBe(digestBefore);
    // summary считает расходы/доходы месяца (строки счетов двигаются самим обменом)
    const spentLine = (text: string): string =>
      text.split('\n').find((line) => line.includes('Траты за месяц')) ?? '';
    expect(spentLine(await quickSummary(USER_A, { now: NOW }))).toBe(spentLine(summaryBefore));
    expect(spentLine(summaryBefore)).toContain('10,00 EUR');
    // query_spending фильтрует kind='expense' в SQL
    expect((await run('query_spending', {}, ctxA)).data).toEqual(spendingBefore.data);
  });
});

// ---------------------------------------------------------------------------
// set_budget / query_spending
// ---------------------------------------------------------------------------

describe('set_budget', () => {
  it('ставит лимит на текущий месяц', async () => {
    const outcome = await run(
      'set_budget',
      { category_name: 'Еда', limit_amount_eur: '300' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Еда');
    expect(outcome.content).toContain('300,00');
    expect(outcome.content).toContain('2026-03');
    const data = outcome.data as Record<string, unknown>;
    expect(data.month).toBe('2026-03');
    expect(data.limit_cents).toBe(30_000);
  });

  it('без категории — ok:false', async () => {
    await expect(run('set_budget', { limit_amount_eur: '100' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('query_spending', () => {
  it('собирает расходы месяца по категориям и сравнивает с бюджетом', async () => {
    const { main } = await seedAccounts();
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 5_000,
      accountId: main.id,
      categoryName: 'Еда',
      occurredAt: '2026-03-03T12:00:00Z',
    });
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 2_500,
      accountId: main.id,
      categoryName: 'Еда',
      occurredAt: '2026-03-04T12:00:00Z',
    });
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 1_000,
      accountId: main.id,
      categoryName: 'Транспорт',
      occurredAt: '2026-03-05T12:00:00Z',
    });
    // Прошлый месяц — не должен попасть в отчёт.
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 9_999,
      accountId: main.id,
      categoryName: 'Еда',
      occurredAt: '2026-02-20T12:00:00Z',
    });
    await run('set_budget', { category_name: 'Еда', limit_amount_eur: '100' }, ctxA);

    const outcome = await run('query_spending', {}, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Расходы за 2026-03');
    expect(outcome.content).toContain('Еда');
    expect(outcome.content).toContain('75,00');
    expect(outcome.content).toContain('Транспорт');

    const data = outcome.data as {
      month: string;
      total_cents: number;
      categories: Array<{ name: string; spent_cents: number; budget_cents: number | null }>;
    };
    expect(data.month).toBe('2026-03');
    expect(data.total_cents).toBe(8_500);
    expect(Number.isInteger(data.total_cents)).toBe(true);
    const food = data.categories.find((item) => item.name === 'Еда');
    expect(food).toBeDefined();
    expect(food?.spent_cents).toBe(7_500);
    expect(food?.budget_cents).toBe(10_000);
    for (const item of data.categories) {
      expect(Number.isInteger(item.spent_cents)).toBe(true);
    }
    expect(outcome.content).not.toMatch(/\d+\.\d{4,}/);
  });

  it('без расходов отвечает вежливо', async () => {
    await seedAccounts();
    const outcome = await run('query_spending', {}, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('расходов пока не зафиксировано');
  });

  it('не показывает расходы другого пользователя', async () => {
    const a = await seedAccounts(USER_A);
    await seedAccounts(USER_B);
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 4_200,
      accountId: a.main.id,
      categoryName: 'Еда',
      occurredAt: '2026-03-06T12:00:00Z',
    });

    const outcomeB = await run('query_spending', {}, ctxB);
    expect(outcomeB.content).toContain('расходов пока не зафиксировано');
  });
});

// ---------------------------------------------------------------------------
// get_fin_balances / set_account_balance
// ---------------------------------------------------------------------------

describe('get_fin_balances', () => {
  it('показывает балансы и итог в EUR', async () => {
    await seedAccounts(USER_A, 123_456);

    const outcome = await run('get_fin_balances', {}, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Main');
    expect(outcome.content).toContain('Cash');
    expect(outcome.content).toContain('1 234,56');
    const data = outcome.data as { total_eur_cents: number; accounts: unknown[] };
    expect(data.accounts).toHaveLength(2);
    expect(data.total_eur_cents).toBe(123_456);
    expect(Number.isInteger(data.total_eur_cents)).toBe(true);
  });

  it('без счетов отвечает «Пока нет ни одного счёта.»', async () => {
    const outcome = await run('get_fin_balances', {}, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Пока нет ни одного счёта');
  });

  it('не показывает счета другого пользователя', async () => {
    await seedAccounts(USER_A);
    const outcomeB = await run('get_fin_balances', {}, ctxB);
    expect(outcomeB.content).toContain('Пока нет ни одного счёта');
  });
});

describe('set_account_balance', () => {
  it('ставит точный баланс существующего счёта', async () => {
    const { main } = await seedAccounts();
    const outcome = await run(
      'set_account_balance',
      { account_name: 'Main', new_balance: '1 250,50' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Main');
    expect(await balanceOf(USER_A, main.id)).toBe(125_050);
    const data = outcome.data as Record<string, unknown>;
    expect(data.balance_cents).toBe(125_050);
    expect(data.created).toBe(false);
  });

  it('создаёт счёт, если его ещё нет', async () => {
    const outcome = await run(
      'set_account_balance',
      { account_name: 'Savings', currency: 'EUR', new_balance: '900' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Savings');
    const data = outcome.data as Record<string, unknown>;
    expect(data.created).toBe(true);
    expect(await balanceOf(USER_A, data.account_id as number)).toBe(90_000);
  });

  it('без обязательных аргументов — ok:false', async () => {
    await expect(run('set_account_balance', { account_name: 'Main' }, ctxA)).resolves.toMatchObject(
      { ok: false },
    );
    await expect(run('set_account_balance', { new_balance: '10' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });
  });
});

// ---------------------------------------------------------------------------
// reset_finance_history / undo_last_transaction
// ---------------------------------------------------------------------------

describe('reset_finance_history', () => {
  it('без confirm только предупреждает', async () => {
    const { main } = await seedAccounts();
    await run('add_expense', { amount: '10', account_name: 'Main' }, ctxA);

    const outcome = await run('reset_finance_history', {}, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('confirm=true');
    expect(await listTransactions(USER_A, { limit: 10 })).toHaveLength(1);
    expect(await balanceOf(USER_A, main.id)).toBe(100_000 - 1_000);
  });

  it('с confirm удаляет историю и сохраняет балансы', async () => {
    const { main } = await seedAccounts();
    await run('add_expense', { amount: '10', account_name: 'Main' }, ctxA);
    const before = await balanceOf(USER_A, main.id);

    const outcome = await run('reset_finance_history', { confirm: true }, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Удалено транзакций: 1');
    expect(await listTransactions(USER_A, { limit: 10 })).toHaveLength(0);
    expect(await balanceOf(USER_A, main.id)).toBe(before);
  });
});

describe('undo_last_transaction', () => {
  it('отменяет последнюю транзакцию и возвращает баланс', async () => {
    const { main } = await seedAccounts();
    await run('add_expense', { amount: '30', account_name: 'Main' }, ctxA);

    const outcome = await run('undo_last_transaction', {}, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Отменил последнюю транзакцию');
    expect(await balanceOf(USER_A, main.id)).toBe(100_000);
    expect(await listTransactions(USER_A, { limit: 10 })).toHaveLength(0);
  });

  it('при недокрытии называет возврат, а не номинал', async () => {
    const { main } = await seedAccounts(USER_A, 1_500);
    await run('add_expense', { amount: '20', account_name: 'Main', description: 'Кофе' }, ctxA);
    expect(await balanceOf(USER_A, main.id)).toBe(0);

    const outcome = await run('undo_last_transaction', {}, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Кофе (расход) — 20,00 EUR');
    expect(outcome.content).toContain('на счёт вернулось 15,00 EUR');
    expect(await balanceOf(USER_A, main.id)).toBe(1_500);
    const data = outcome.data as Record<string, unknown>;
    expect(data.amount_cents).toBe(2_000);
    expect(data.uncovered_cents).toBe(500);
    expect(data.returned_cents).toBe(1_500);
  });

  it('когда отменять нечего — ok:true с текстом', async () => {
    const outcome = await run('undo_last_transaction', {}, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Нет транзакций для отмены');
  });

  it('обмен отменяет целиком и называет обе ноги', async () => {
    await setRates('2026-03-01', { USD: 1.08 });
    const eur = await createAccount(USER_A, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 50_000,
    });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });
    await run(
      'add_exchange',
      {
        from_account: 'Main',
        from_amount: '100',
        from_currency: 'EUR',
        to_account: 'Usd',
        to_amount: '108',
        to_currency: 'USD',
      },
      ctxA,
    );

    const outcome = await run('undo_last_transaction', {}, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('100,00 EUR → 108,00 USD');
    expect(outcome.content).toContain('отменён, балансы восстановлены');
    expect(await balanceOf(USER_A, eur.id)).toBe(50_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
    expect(await listTransactions(USER_A, { limit: 10 })).toHaveLength(0);
    const data = outcome.data as Record<string, unknown>;
    expect(data.kind).toBe('exchange');
    expect(data.group_id).toBeTruthy();
    expect(data.from_cents).toBe(10_000);
    expect(data.to_cents).toBe(10_800);
  });
});

// ---------------------------------------------------------------------------
// edit_last_transaction
// ---------------------------------------------------------------------------

describe('edit_last_transaction', () => {
  it('меняет сумму и описание последней транзакции', async () => {
    const { main } = await seedAccounts();
    await run(
      'add_expense',
      { amount: '10', account_name: 'Main', category_name: 'Еда', description: 'старое' },
      ctxA,
    );

    const outcome = await run(
      'edit_last_transaction',
      { amount: '20', description: 'новое' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Изменил последнюю транзакцию');
    expect(outcome.content).toContain('новое');
    expect(await balanceOf(USER_A, main.id)).toBe(100_000 - 2_000);

    const [last] = await listTransactions(USER_A, { limit: 1 });
    expect(last?.amountCents).toBe(2_000);
    expect(last?.description).toBe('новое');
    const data = outcome.data as Record<string, unknown>;
    expect(data.amount_cents).toBe(2_000);
    expect(Number.isInteger(data.new_transaction_id as number)).toBe(true);
  });

  it('после недокрытия правит сам расход, а не служебную компенсацию', async () => {
    const { main } = await seedAccounts(USER_A, 1_000);
    // 20 EUR при 10 EUR на счёте: в группе есть служебная строка `adjustment`.
    await run(
      'add_expense',
      { amount: '20', account_name: 'Main', category_name: 'Кафе', description: 'Кофе' },
      ctxA,
    );
    expect(await balanceOf(USER_A, main.id)).toBe(0);

    const outcome = await run('edit_last_transaction', { amount: '5' }, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Кофе');
    const rows = await listTransactions(USER_A, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('expense');
    expect(rows[0]?.amountCents).toBe(500);
    expect(rows[0]?.categoryId).not.toBeNull();
    // Вернули 10, списали 5.
    expect(await balanceOf(USER_A, main.id)).toBe(500);
    const data = outcome.data as Record<string, unknown>;
    expect(Number.isInteger(data.replaced_transaction_id as number)).toBe(true);
  });

  it('без транзакций — ok:false', async () => {
    await seedAccounts();
    await expect(run('edit_last_transaction', { amount: '5' }, ctxA)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('переводы не редактирует', async () => {
    await seedAccounts();
    await run('add_transfer', { amount: '5', from_account: 'Main', to_account: 'Cash' }, ctxA);

    const outcome = await run('edit_last_transaction', { amount: '7' }, ctxA);
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Редактирование переводов не поддерживается');
  });

  it('обмены не редактирует и историю не меняет', async () => {
    await setRates('2026-03-01', { USD: 1.08 });
    const eur = await createAccount(USER_A, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 50_000,
    });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });
    await run(
      'add_exchange',
      {
        from_account: 'Main',
        from_amount: '100',
        from_currency: 'EUR',
        to_account: 'Usd',
        to_amount: '108',
        to_currency: 'USD',
      },
      ctxA,
    );
    const before = await listTransactions(USER_A, { limit: 10 });

    const outcome = await run('edit_last_transaction', { amount: '7' }, ctxA);

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Редактирование обменов не поддерживается');
    expect(await listTransactions(USER_A, { limit: 10 })).toEqual(before);
    expect(await balanceOf(USER_A, eur.id)).toBe(40_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(10_800);
  });
});

// ---------------------------------------------------------------------------
// adjust_account_balance
// ---------------------------------------------------------------------------

describe('adjust_account_balance', () => {
  it('сдвигает баланс на дельту со знаком', async () => {
    const { main } = await seedAccounts();

    const outcome = await run(
      'adjust_account_balance',
      { account_name: 'Main', delta: '-25,50' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('-25,50');
    expect(await balanceOf(USER_A, main.id)).toBe(100_000 - 2_550);
    const data = outcome.data as Record<string, unknown>;
    expect(data.delta_cents).toBe(-2_550);
    expect(Number.isInteger(data.delta_cents as number)).toBe(true);
  });

  it('неизвестный счёт — ok:false со списком', async () => {
    await seedAccounts();
    const outcome = await run(
      'adjust_account_balance',
      { account_name: 'Нет такого', delta: '10' },
      ctxA,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Main');
  });

  it('кривая дельта — ok:false', async () => {
    await seedAccounts();
    await expect(
      run('adjust_account_balance', { account_name: 'Main', delta: 'abc' }, ctxA),
    ).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// mark_liability_paid / link_liability_account / get_liabilities
// ---------------------------------------------------------------------------

async function seedLiability(userId = USER_A, name = 'Loan') {
  return createLiability(userId, {
    name,
    currency: 'EUR',
    amountCents: 50_000,
    monthlyPaymentCents: 10_000,
    paymentDay: 10,
  });
}

describe('mark_liability_paid', () => {
  it('отмечает платёж за месяц', async () => {
    await seedLiability();

    const outcome = await run('mark_liability_paid', { liability_name: 'Loan' }, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Отметил оплату');
    expect(outcome.content).toContain('Loan');
    const data = outcome.data as Record<string, unknown>;
    expect(data.amount_cents).toBe(10_000);
    expect(Number.isInteger(data.amount_cents as number)).toBe(true);
    expect(data.already_paid).toBeUndefined();
  });

  it('не платит дважды в одном месяце', async () => {
    await seedLiability();
    await run('mark_liability_paid', { liability_name: 'Loan' }, ctxA);

    const outcome = await run('mark_liability_paid', { liability_name: 'Loan' }, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('уже отмечен оплаченным');
  });

  it('списывает со счёта при deduct_from_account', async () => {
    await seedLiability();
    const { main } = await seedAccounts();
    await run('link_liability_account', { liability_name: 'Loan', account_name: 'Main' }, ctxA);

    const outcome = await run(
      'mark_liability_paid',
      { liability_name: 'Loan', deduct_from_account: true, account_name: 'Main' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(await balanceOf(USER_A, main.id)).toBe(100_000 - 10_000);
  });

  it('неизвестное обязательство — ok:false', async () => {
    const outcome = await run('mark_liability_paid', { liability_name: 'Нет такого' }, ctxA);
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('не найдено');
  });
});

describe('link_liability_account', () => {
  it('привязывает обязательство к счёту', async () => {
    const liability = await seedLiability();
    const { main } = await seedAccounts();

    const outcome = await run(
      'link_liability_account',
      { liability_name: 'Loan', account_name: 'Main' },
      ctxA,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Loan');
    expect(outcome.content).toContain('Main');
    const data = outcome.data as Record<string, unknown>;
    expect(data.liability_id).toBe(liability.id);
    expect(data.account_id).toBe(main.id);
  });

  it('неизвестный счёт — ok:false со списком счетов', async () => {
    await seedLiability();
    await seedAccounts();
    const outcome = await run(
      'link_liability_account',
      { liability_name: 'Loan', account_name: 'Нет такого' },
      ctxA,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Main');
  });
});

describe('get_liabilities', () => {
  it('группирует обязательства по нейтральным очередям', async () => {
    await createLiability(USER_A, {
      name: 'Music',
      queue: recurring('subscription'),
      currency: 'EUR',
      amountCents: 999,
      monthlyPaymentCents: 999,
    });
    await seedLiability(USER_A, 'Loan');

    const outcome = await run('get_liabilities', {}, ctxA);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Ваши обязательства и долги');
    expect(outcome.content).toContain('Подписки');
    expect(outcome.content).toContain('Очередь 1');
    expect(outcome.content).toContain('Music');
    expect(outcome.content).toContain('Loan');
    const data = outcome.data as {
      liabilities: Array<{ monthly_payment_cents: number }>;
    };
    expect(data.liabilities).toHaveLength(2);
    for (const item of data.liabilities) {
      expect(Number.isInteger(item.monthly_payment_cents)).toBe(true);
    }
  });

  it('без обязательств — ok:true с поздравлением', async () => {
    const outcome = await run('get_liabilities', {}, ctxA);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('Активных обязательств нет');
  });

  it('не показывает обязательства другого пользователя', async () => {
    await seedLiability(USER_A, 'Loan');
    const outcomeB = await run('get_liabilities', {}, ctxB);
    expect(outcomeB.content).toContain('Активных обязательств нет');
  });
});

// ---------------------------------------------------------------------------
// can_i_afford
// ---------------------------------------------------------------------------

describe('can_i_afford: вердикт по свободным деньгам', () => {
  it('danger, caution и safe на одном и том же балансе', async () => {
    await seedAccounts(USER_A, 100_000); // 100 € свободных, сид прожига 20 €/день

    const danger = await run('can_i_afford', { amount: '1100' }, ctxA);
    expect(danger.ok).toBe(true);
    expect((danger.data as { verdict: string }).verdict).toBe('danger');
    expect(danger.content).toContain('Недоступно');

    const caution = await run('can_i_afford', { amount: '960' }, ctxA);
    expect(caution.ok).toBe(true);
    expect((caution.data as { verdict: string }).verdict).toBe('caution');

    const safe = await run('can_i_afford', { amount: '500', item_name: 'Продукты' }, ctxA);
    expect(safe.ok).toBe(true);
    expect((safe.data as { verdict: string }).verdict).toBe('safe');
    expect(safe.content).toContain('Продукты');
  });

  it('считает в валюте покупки и не трогает балансы', async () => {
    const { main } = await seedAccounts(USER_A, 100_000);
    await setRates('2026-03-15', { USD: 1.1 });

    const result = await run('can_i_afford', { amount: '10', currency: 'USD' }, ctxA);

    expect(result.ok).toBe(true);
    expect((result.data as { currency: string }).currency).toBe('USD');
    expect(await balanceOf(USER_A, main.id)).toBe(100_000);
  });

  it('отказывает на пустой и отрицательной сумме', async () => {
    await seedAccounts(USER_A, 100_000);

    expect((await run('can_i_afford', {}, ctxA)).ok).toBe(false);
    expect((await run('can_i_afford', { amount: '0' }, ctxA)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// add_liability / update_liability / delete_liability
// ---------------------------------------------------------------------------

describe('CRUD обязательств: add_liability / update_liability / delete_liability', () => {
  it('add_liability создаёт подписку и привязывает счёт', async () => {
    const { main } = await seedAccounts();
    await setRates('2026-03-15', { USD: 1.1 });
    const res = await run(
      'add_liability',
      {
        name: 'Sail Research',
        monthly_payment: '20',
        currency: 'USD',
        payment_day: 25,
        account_name: 'Main',
        notes: 'AI Research',
      },
      ctxA,
    );

    expect(res.ok).toBe(true);
    expect(res.content).toContain('Sail Research');
    const data = res.data as { liability_id: number; queue: string; monthly_payment_cents: number };
    expect(data.queue).toBe('subscription');
    expect(data.monthly_payment_cents).toBe(2000);

    const saved = await getLiability(USER_A, data.liability_id);
    expect(saved?.accountId).toBe(main.id);
    expect(saved?.paymentDay).toBe(25);
  });

  it('update_liability обновляет параметры, включая сброс payment_day и паузу', async () => {
    await setRates('2026-03-15', { USD: 1.1 });
    const created = await createLiability(USER_A, {
      name: 'GeForce NOW',
      queue: recurring('subscription'),
      amountCents: 2000,
      monthlyPaymentCents: 2000,
      currency: 'USD',
      paymentDay: 20,
    });

    const updated = await run(
      'update_liability',
      {
        liability_name: 'GeForce',
        monthly_payment: '10',
        payment_day: 0,
        is_active: false,
      },
      ctxA,
    );

    expect(updated.ok).toBe(true);
    const row = await getLiability(USER_A, created.id);
    expect(row?.monthlyPaymentCents).toBe(1000);
    expect(row?.paymentDay).toBeNull();
    expect(row?.isActive).toBe(false);
  });

  it('delete_liability удаляет обязательство и изолирован между пользователями', async () => {
    await setRates('2026-03-15', { USD: 1.1 });
    const sail = await createLiability(USER_A, {
      name: 'Sail Research',
      queue: recurring('subscription'),
      amountCents: 2000,
      monthlyPaymentCents: 2000,
      currency: 'USD',
      paymentDay: 25,
    });

    const foreignAttempt = await run('delete_liability', { liability_name: 'Sail Research' }, ctxB);
    expect(foreignAttempt.ok).toBe(false);
    expect(await getLiability(USER_A, sail.id)).not.toBeNull();

    const deleted = await run('delete_liability', { liability_name: 'Sail Research' }, ctxA);
    expect(deleted.ok).toBe(true);
    expect(deleted.content).toContain('Sail Research');
    expect(await getLiability(USER_A, sail.id)).toBeNull();
    expect(await listLiabilities(USER_A, 'all')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// update_account / delete_account
// ---------------------------------------------------------------------------

describe('управление счетами: update_account / delete_account', () => {
  it('update_account меняет имя, конверт и активность с проверкой валюты при дублях', async () => {
    const eur = await createAccount(USER_A, { name: 'Card', currency: 'EUR', initialBalanceCents: 5000 });
    await createAccount(USER_A, { name: 'Card', currency: 'USD', initialBalanceCents: 2000 });

    const ambiguous = await run('update_account', { account_name: 'Card', envelope: 'reserved' }, ctxA);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.content).toContain('currency');

    const updated = await run(
      'update_account',
      { account_name: 'Card', currency: 'EUR', new_name: 'Card Main', envelope: 'reserved', is_active: false },
      ctxA,
    );
    expect(updated.ok).toBe(true);

    const row = await getAccount(USER_A, eur.id);
    expect(row?.name).toBe('Card Main');
    expect(row?.envelope).toBe('reserved');
    expect(row?.isActive).toBe(false);
  });

  it('delete_account удаляет пустой счёт и отказывает для счёта с транзакциями', async () => {
    const { main, cash } = await seedAccounts();
    await createTransaction(USER_A, { kind: 'expense', accountId: main.id, amountCents: 500 });

    const blocked = await run('delete_account', { account_name: 'Main' }, ctxA);
    expect(blocked.ok).toBe(false);
    expect(blocked.content).toContain('история операций');

    const deleted = await run('delete_account', { account_name: 'Cash' }, ctxA);
    expect(deleted.ok).toBe(true);
    expect(await getAccount(USER_A, cash.id)).toBeNull();
    expect(await listAccounts(USER_A, { includeInactive: true })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// list_transactions / delete_transaction
// ---------------------------------------------------------------------------

describe('операции: list_transactions / delete_transaction', () => {
  it('list_transactions показывает операции, а delete_transaction откатывает нужную и восстанавливает баланс', async () => {
    const { main } = await seedAccounts(USER_A, 10_000);
    const tx1 = await createTransaction(USER_A, {
      kind: 'expense',
      accountId: main.id,
      amountCents: 1500,
      description: 'Кофе',
    });
    await createTransaction(USER_A, {
      kind: 'expense',
      accountId: main.id,
      amountCents: 2500,
      description: 'Такси',
    });

    const list = await run('list_transactions', { limit: 10 }, ctxA);
    expect(list.ok).toBe(true);
    expect(list.content).toContain('Кофе');
    expect(list.content).toContain('Такси');
    expect((list.data as { count: number }).count).toBe(2);

    const removed = await run('delete_transaction', { transaction_id: tx1.id }, ctxA);
    expect(removed.ok).toBe(true);
    expect(removed.content).toContain('Кофе');
    expect(await balanceOf(USER_A, main.id)).toBe(7500);
    expect(await listTransactions(USER_A)).toHaveLength(1);

    const removedByQuery = await run('delete_transaction', { query: 'Такси' }, ctxA);
    expect(removedByQuery.ok).toBe(true);
    expect(await balanceOf(USER_A, main.id)).toBe(10_000);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });
});
