/**
 * DAL `src/lib/dal/finances.ts` — счета, категории, транзакции, бюджеты,
 * обязательства.
 *
 * Главный инвариант слоя (SPEC §2.4, §4): каждая юзерская функция получает
 * `userId` и видит ТОЛЬКО его данные. Поэтому почти в каждой группе таблиц есть
 * проверка «юзер Б не видит/не может править данные юзера А».
 *
 * `fx_rates` — единственная глобальная таблица финансов, её изоляция не нужна
 * (см. tests/dal/fx.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import type { LiabilityQueue } from '../../src/types';
import {
  createAccount,
  createCategory,
  createExchange,
  createLiability,
  createTransaction,
  debitWithSettlement,
  deleteAccount,
  deleteBudget,
  deleteCategory,
  deleteLiability,
  deleteTransaction,
  ensureAccounts,
  ensureCategory,
  findAccountByName,
  findCategoryByName,
  findLiabilityByName,
  fxRateFor,
  getAccount,
  getBudget,
  getCategory,
  getLiability,
  getTransaction,
  LiabilityNotFoundError,
  listAccounts,
  listBudgets,
  listCategories,
  listLiabilities,
  listTransactions,
  newGroupId,
  payLiability,
  resetTransactions,
  setAccountBalance,
  setBudget,
  toBaseCents,
  undoLastTransaction,
  updateAccount,
  updateCategory,
  updateLiability,
  withBalanceCompensation,
  withTransaction,
} from '../../src/lib/dal/finances';
import { setRates } from '../../src/lib/dal/fx';

const USER_A = 1;
const USER_B = 2;

/** В `LiabilityQueue` нет `subscription`/`service`, но DAL их понимает (паритет с upstream). */
const recurring = (queue: string): LiabilityQueue => queue as unknown as LiabilityQueue;

async function seedAccounts(userId: number, initialBalanceCents = 100_000) {
  await ensureAccounts(userId, [
    { name: 'Main', currency: 'EUR', initialBalanceCents },
    { name: 'Cash', currency: 'EUR', initialBalanceCents: 0 },
  ]);
  const main = await findAccountByName(userId, 'Main');
  const cash = await findAccountByName(userId, 'Cash');
  if (!main || !cash) throw new Error('seedAccounts: accounts were not created');
  return { main, cash };
}

async function balanceOf(userId: number, accountId: number): Promise<number> {
  const account = await getAccount(userId, accountId);
  if (!account) throw new Error('balanceOf: account not found');
  return account.currentBalanceCents;
}

/**
 * Воспроизводит tgcloud: явный `BEGIN` запрещён (SQLite authorizer, error 23),
 * поэтому `withTransaction` вырождается в простой вызов и всё держится на
 * компенсации. Возвращает функцию восстановления.
 */
function blockBegin(): () => void {
  const original = db.run;
  const spy = vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
    const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
    if (text.trim().toUpperCase() === 'BEGIN') {
      throw new Error('not authorized (code 23)');
    }
    return original.call(db, query as never, params);
  });
  return () => spy.mockRestore();
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

// ---------------------------------------------------------------------------
// Инфраструктура
// ---------------------------------------------------------------------------

describe('finances: withTransaction', () => {
  it('откатывает изменения при ошибке', async () => {
    await expect(
      withTransaction(async () => {
        await createAccount(USER_A, { name: 'Temp' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await findAccountByName(USER_A, 'Temp')).toBeNull();
  });

  it('вложенный вызов присоединяется к внешней транзакции', async () => {
    const result = await withTransaction(async () => {
      await ensureAccounts(USER_A, [{ name: 'Main', initialBalanceCents: 500 }]);
      return withTransaction(async () => findAccountByName(USER_A, 'Main'));
    });
    expect(result?.currentBalanceCents).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Счета
// ---------------------------------------------------------------------------

describe('finances: счета', () => {
  it('ensureAccounts идемпотентен и возвращает все счета юзера', async () => {
    const first = await ensureAccounts(USER_A, [
      { name: 'Main', currency: 'EUR', initialBalanceCents: 100_000 },
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      userId: USER_A,
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 100_000,
      currentBalanceCents: 100_000,
      isActive: true,
    });

    const second = await ensureAccounts(USER_A, [{ name: 'Main' }, { name: 'Cash' }]);
    expect(second.map((row) => row.name)).toEqual(['Cash', 'Main']);
    // повторный сид не сбрасывает и не дублирует остаток
    expect(second.find((row) => row.name === 'Main')?.currentBalanceCents).toBe(100_000);
    expect(second.every((row) => row.userId === USER_A)).toBe(true);

    // конверт по умолчанию — spendable (свободные деньги)
    expect(second.every((row) => row.envelope === 'spendable')).toBe(true);
  });

  it('конверт счёта (envelope) создаётся и переключается per-user', async () => {
    await ensureAccounts(USER_A, [
      { name: 'Main', envelope: 'spendable' },
      { name: 'Reserve', envelope: 'reserved', initialBalanceCents: 50_000 },
    ]);

    const main = await findAccountByName(USER_A, 'Main');
    const reserve = await findAccountByName(USER_A, 'Reserve');
    expect(main?.envelope).toBe('spendable');
    expect(reserve?.envelope).toBe('reserved');

    // createAccount: envelope опционален, мусор нормализуется в spendable
    const created = await createAccount(USER_A, { name: 'Savings', envelope: 'reserved' });
    expect(created.envelope).toBe('reserved');

    // updateAccount переводит счёт между конвертами, чужому юзеру нельзя
    const moved = await updateAccount(USER_A, created.id, { envelope: 'spendable' });
    expect(moved.envelope).toBe('spendable');
    await expect(updateAccount(USER_B, created.id, { envelope: 'reserved' })).rejects.toThrow(
      /not found/,
    );
  });

  it('счета одного юзера не видны другому', async () => {
    const { main, cash } = await seedAccounts(USER_A);
    const foreign = await createAccount(USER_B, { name: 'Main', initialBalanceCents: 7_000 });

    expect(foreign.userId).toBe(USER_B);
    expect(await getAccount(USER_B, main.id)).toBeNull();
    expect(await getAccount(USER_A, foreign.id)).toBeNull();

    // одинаковые имена у разных юзеров разрешены, поиск не протекает
    expect((await findAccountByName(USER_A, 'Main'))?.id).toBe(main.id);
    expect((await findAccountByName(USER_B, 'Main'))?.id).toBe(foreign.id);

    // порядок — по имени (COLLATE NOCASE): Cash раньше Main
    expect((await listAccounts(USER_A)).map((row) => row.id)).toEqual([cash.id, main.id]);
    expect((await listAccounts(USER_B)).map((row) => row.id)).toEqual([foreign.id]);
  });

  it('findAccountByName ищет по точному имени, валюте и подстроке', async () => {
    const { main } = await seedAccounts(USER_A);
    const usd = await createAccount(USER_A, { name: 'Main', currency: 'USD' });

    // с указанием валюты — точное совпадение нужной валюты
    expect((await findAccountByName(USER_A, 'main', 'USD'))?.id).toBe(usd.id);
    // без валюты — сначала точное имя (любая валюта), порядок стабилен
    expect((await findAccountByName(USER_A, 'MAIN'))?.name).toBe('Main');
    // подстрока
    expect((await findAccountByName(USER_A, 'csh'))?.id).not.toBe(main.id);
    expect(await findAccountByName(USER_A, 'nowhere')).toBeNull();
    expect(await findAccountByName(USER_A, '   ')).toBeNull();
  });

  it('updateAccount и setAccountBalance правят только свой счёт', async () => {
    const { cash } = await seedAccounts(USER_A);

    const renamed = await updateAccount(USER_A, cash.id, { name: 'Wallet', isActive: false });
    expect(renamed.name).toBe('Wallet');
    expect(renamed.isActive).toBe(false);
    expect((await listAccounts(USER_A)).map((row) => row.name)).toEqual(['Main']);
    expect((await listAccounts(USER_A, { includeInactive: true })).map((row) => row.name)).toEqual([
      'Main',
      'Wallet',
    ]);

    const updated = await setAccountBalance(USER_A, cash.id, 4_200);
    expect(updated.currentBalanceCents).toBe(4_200);
    expect(updated.initialBalanceCents).toBe(0);

    await expect(updateAccount(USER_B, cash.id, { name: 'Hacked' })).rejects.toThrow(/not found/);
    await expect(setAccountBalance(USER_B, cash.id, 0)).rejects.toThrow(/not found/);
    expect((await getAccount(USER_A, cash.id))?.name).toBe('Wallet');
  });

  it('deleteAccount удаляет пустой счёт, но не счёт с историей и не чужой', async () => {
    const { main, cash } = await seedAccounts(USER_A);

    expect(await deleteAccount(USER_B, main.id)).toBe(false);
    expect(await getAccount(USER_A, main.id)).not.toBeNull();

    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 1_000,
      accountId: main.id,
    });
    await expect(deleteAccount(USER_A, main.id)).rejects.toThrow(/has transactions/);

    expect(await deleteAccount(USER_A, cash.id)).toBe(true);
    expect(await getAccount(USER_A, cash.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Категории
// ---------------------------------------------------------------------------

describe('finances: категории финансов', () => {
  it('ensureCategory — get-or-create по имени и виду', async () => {
    const food = await ensureCategory(USER_A, 'Food');
    const again = await ensureCategory(USER_A, '  food  ');
    expect(again.id).toBe(food.id);
    expect(food.kind).toBe('expense');

    // тот же текст, другой вид — другая категория
    const income = await ensureCategory(USER_A, 'Food', 'income');
    expect(income.id).not.toBe(food.id);
    expect(income.kind).toBe('income');

    expect(await listCategories(USER_A)).toHaveLength(2);
    expect(await listCategories(USER_A, 'income')).toHaveLength(1);
    expect((await findCategoryByName(USER_A, 'FOOD', 'expense'))?.id).toBe(food.id);
  });

  it('категории изолированы по юзеру', async () => {
    const mine = await createCategory(USER_A, { name: 'Rent', icon: '🏠' });
    const foreign = await createCategory(USER_B, { name: 'Rent' });

    expect(mine.id).not.toBe(foreign.id);
    expect(await getCategory(USER_B, mine.id)).toBeNull();
    expect((await listCategories(USER_B)).map((row) => row.id)).toEqual([foreign.id]);

    await expect(updateCategory(USER_B, mine.id, { name: 'Hacked' })).rejects.toThrow(/not found/);
    expect((await getCategory(USER_A, mine.id))?.name).toBe('Rent');

    expect(await deleteCategory(USER_B, mine.id)).toBe(false);
  });

  it('deleteCategory не удаляет используемую категорию', async () => {
    const { main } = await seedAccounts(USER_A);
    const used = await createCategory(USER_A, { name: 'Groceries' });
    const free = await createCategory(USER_A, { name: 'Temporary' });
    const budgeted = await createCategory(USER_A, { name: 'Budgeted' });

    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 500,
      accountId: main.id,
      categoryId: used.id,
    });
    await setBudget(USER_A, {
      month: '2026-11',
      categoryId: budgeted.id,
      limitAmountEurCents: 20_000,
    });

    await expect(deleteCategory(USER_A, used.id)).rejects.toThrow(/is in use/);
    await expect(deleteCategory(USER_A, budgeted.id)).rejects.toThrow(/is in use/);
    expect(await deleteCategory(USER_A, free.id)).toBe(true);
  });

  it('createCategory не принимает пустое имя и кривой вид', async () => {
    await expect(createCategory(USER_A, { name: '  ' })).rejects.toThrow(/name is required/);
    await expect(
      createCategory(USER_A, { name: 'X', kind: 'both' as unknown as 'expense' }),
    ).rejects.toThrow(/invalid category kind/);
  });
});

// ---------------------------------------------------------------------------
// Транзакции
// ---------------------------------------------------------------------------

describe('finances: транзакции', () => {
  it('расход и доход двигают баланс, undoLastTransaction откатывает', async () => {
    const { main } = await seedAccounts(USER_A);

    const expense = await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 2_500,
      accountId: main.id,
      description: 'Coffee',
    });
    expect(expense).toMatchObject({
      userId: USER_A,
      kind: 'expense',
      accountId: main.id,
      amountCents: 2_500,
      currency: 'EUR',
      amountEurCents: 2_500,
      description: 'Coffee',
    });
    expect(await balanceOf(USER_A, main.id)).toBe(97_500);

    const income = await createTransaction(USER_A, {
      kind: 'income',
      amountCents: 5_000,
      accountName: 'main',
    });
    expect(await balanceOf(USER_A, main.id)).toBe(102_500);

    expect((await undoLastTransaction(USER_A))?.id).toBe(income.id);
    expect(await balanceOf(USER_A, main.id)).toBe(97_500);

    expect((await undoLastTransaction(USER_A))?.id).toBe(expense.id);
    expect(await balanceOf(USER_A, main.id)).toBe(100_000);

    expect(await undoLastTransaction(USER_A)).toBeNull();
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('undoing a legacy snapshot row does not credit the balance', async () => {
    const { main } = await seedAccounts(USER_A);

    // Строка короткого окна фичи со снимка: сумма уже была в остатке банка,
    // поэтому отмена не должна вернуть её на счёт.
    const legacy = await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 2_500,
      accountId: main.id,
      description: 'Coffee',
      rawText: 'vision-balance-expense:legacy-hash',
    });
    const balanceBefore = await balanceOf(USER_A, main.id);

    expect((await undoLastTransaction(USER_A))?.id).toBe(legacy.id);
    expect(await getTransaction(USER_A, legacy.id)).toBeNull();
    expect(await balanceOf(USER_A, main.id)).toBe(balanceBefore);
  });

  it('категория по имени создаётся на лету, вид проверяется', async () => {
    const { main } = await seedAccounts(USER_A);
    const tx = await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 1_000,
      accountId: main.id,
      categoryName: 'Coffee',
    });
    const category = await getCategory(USER_A, tx.categoryId ?? 0);
    expect(category).toMatchObject({ name: 'Coffee', kind: 'expense' });

    await expect(
      createTransaction(USER_A, {
        kind: 'income',
        amountCents: 1_000,
        accountId: main.id,
        categoryId: category?.id,
      }),
    ).rejects.toThrow(/is expense, not income/);

    await expect(
      createTransaction(USER_A, { kind: 'expense', amountCents: 0, accountId: main.id }),
    ).rejects.toThrow(/must be positive/);

    await expect(
      createTransaction(USER_A, {
        kind: 'expense',
        amountCents: 100,
        accountId: main.id,
        categoryId: 999,
      }),
    ).rejects.toThrow(/category 999 not found/);

    await expect(
      createTransaction(USER_A, { kind: 'expense', amountCents: 100, accountName: 'Nowhere' }),
    ).rejects.toThrow(/account not found/);
  });

  it('валюта операции конвертируется в EUR и в валюту счёта', async () => {
    const { main } = await seedAccounts(USER_A);
    const rates = { USD: 1.08 };

    const tx = await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 10_000,
      currency: 'USD',
      accountId: main.id,
      rates,
    });

    expect(tx.currency).toBe('USD');
    expect(tx.amountEurCents).toBe(9_259); // 10000 / 1.08
    expect(tx.fxRate).toBeCloseTo(0.9259, 6);
    // счёт в EUR — списание в валюте счёта
    expect(await balanceOf(USER_A, main.id)).toBe(90_741);

    // без курса — ошибка, а не тихая подстановка 1.0
    await expect(
      createTransaction(USER_A, {
        kind: 'expense',
        amountCents: 100,
        currency: 'USD',
        accountId: main.id,
      }),
    ).rejects.toThrow(/no rate for USD/);
  });

  it('перевод — одна строка, балансы двух счетов, undo возвращает всё', async () => {
    const { main, cash } = await seedAccounts(USER_A);

    const transfer = await createTransaction(USER_A, {
      kind: 'transfer',
      amountCents: 30_000,
      accountId: main.id,
      toAccountId: cash.id,
    });

    expect(transfer.kind).toBe('transfer');
    expect(transfer.toAccountId).toBe(cash.id);
    expect(transfer.transferGroupId).toBeTruthy();
    expect(transfer.amountCents).toBe(30_000);
    expect(transfer.description).toBe('Transfer to Cash');
    expect(await listTransactions(USER_A)).toHaveLength(1);
    expect(await balanceOf(USER_A, main.id)).toBe(70_000);
    expect(await balanceOf(USER_A, cash.id)).toBe(30_000);

    await undoLastTransaction(USER_A);
    expect(await balanceOf(USER_A, main.id)).toBe(100_000);
    expect(await balanceOf(USER_A, cash.id)).toBe(0);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('перевод требует разные счета в одной валюте', async () => {
    const { main } = await seedAccounts(USER_A);
    const usd = await createAccount(USER_A, { name: 'Dollars', currency: 'USD' });

    await expect(
      createTransaction(USER_A, {
        kind: 'transfer',
        amountCents: 100,
        accountId: main.id,
        toAccountId: main.id,
      }),
    ).rejects.toThrow(/must differ/);

    await expect(
      createTransaction(USER_A, {
        kind: 'transfer',
        amountCents: 100,
        accountId: main.id,
        toAccountId: usd.id,
      }),
    ).rejects.toThrow(/same currency/);

    await expect(
      createTransaction(USER_A, {
        kind: 'transfer',
        amountCents: 100,
        accountId: main.id,
        toAccountName: 'Nowhere',
      }),
    ).rejects.toThrow(/target account not found/);
  });

  it('транзакции изолированы по юзеру', async () => {
    const { main } = await seedAccounts(USER_A);
    const { main: foreignMain } = await seedAccounts(USER_B);

    const mine = await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 1_500,
      accountId: main.id,
      description: 'Books',
    });
    await createTransaction(USER_B, {
      kind: 'expense',
      amountCents: 900,
      accountId: foreignMain.id,
      description: 'Foreign',
    });

    expect(await getTransaction(USER_B, mine.id)).toBeNull();
    expect((await getTransaction(USER_A, mine.id))?.description).toBe('Books');

    const theirs = await listTransactions(USER_B);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].description).toBe('Foreign');
    expect(theirs.every((row) => row.userId === USER_B)).toBe(true);

    // undo юзера Б не трогает историю юзера А
    expect(await undoLastTransaction(USER_B)).not.toBeNull();
    expect(await getTransaction(USER_A, mine.id)).not.toBeNull();

    // каждая запись в БД принадлежит своему юзеру
    expect((await listTransactions(USER_A)).every((row) => row.userId === USER_A)).toBe(true);
  });

  it('listTransactions фильтрует по виду, датам, категории, счёту и лимиту', async () => {
    const { main, cash } = await seedAccounts(USER_A);
    const food = await createCategory(USER_A, { name: 'Food' });

    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 100,
      accountId: main.id,
      categoryId: food.id,
      occurredAt: '2026-11-01',
    });
    await createTransaction(USER_A, {
      kind: 'income',
      amountCents: 200,
      accountId: cash.id,
      occurredAt: '2026-11-15',
    });
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 300,
      accountId: main.id,
      occurredAt: '2026-12-01',
    });

    expect(await listTransactions(USER_A)).toHaveLength(3);
    expect(await listTransactions(USER_A, { kind: 'expense' })).toHaveLength(2);
    expect(await listTransactions(USER_A, { kind: 'income' })).toHaveLength(1);
    expect(await listTransactions(USER_A, { categoryId: food.id })).toHaveLength(1);
    expect(await listTransactions(USER_A, { accountId: cash.id })).toHaveLength(1);

    const november = await listTransactions(USER_A, { from: '2026-11-01', to: '2026-11-15' });
    expect(november).toHaveLength(2);
    expect(november[0].amountCents).toBe(200); // новые сверху

    expect(await listTransactions(USER_A, { from: '2026-11-16' })).toHaveLength(1);
    expect(await listTransactions(USER_A, { to: '2026-11-14' })).toHaveLength(1);

    const limited = await listTransactions(USER_A, { limit: 1, offset: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].amountCents).toBe(200);
  });

  it('resetTransactions чистит историю, балансы не трогает', async () => {
    const { main } = await seedAccounts(USER_A);
    await createTransaction(USER_A, { kind: 'expense', amountCents: 1_000, accountId: main.id });
    await createTransaction(USER_A, { kind: 'income', amountCents: 500, accountId: main.id });

    expect(await resetTransactions(USER_A)).toBe(2);
    expect(await listTransactions(USER_A)).toHaveLength(0);
    expect(await balanceOf(USER_A, main.id)).toBe(99_500);
    expect(await resetTransactions(USER_A)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Бюджеты
// ---------------------------------------------------------------------------

describe('finances: бюджеты', () => {
  it('setBudget — upsert по user+категория+месяц', async () => {
    const first = await setBudget(USER_A, {
      month: '2026-11',
      categoryName: 'Food',
      limitAmountEurCents: 30_000,
    });
    expect(first).toMatchObject({ userId: USER_A, month: '2026-11', limitAmountEurCents: 30_000 });

    const second = await setBudget(USER_A, {
      month: '2026-11',
      categoryName: ' food ',
      limitAmountEurCents: 45_000,
    });
    expect(second.id).toBe(first.id);
    expect(second.categoryId).toBe(first.categoryId);
    expect(second.limitAmountEurCents).toBe(45_000);
    expect(await listBudgets(USER_A, '2026-11')).toHaveLength(1);

    const december = await setBudget(USER_A, {
      month: '2026-12',
      categoryId: first.categoryId,
      limitAmountEurCents: 10_000,
    });
    expect(december.id).not.toBe(first.id);
    expect(await listBudgets(USER_A)).toHaveLength(2);
  });

  it('бюджеты изолированы и не смешиваются с чужими категориями', async () => {
    const mine = await setBudget(USER_A, {
      month: '2026-11',
      categoryName: 'Food',
      limitAmountEurCents: 30_000,
    });

    expect(await getBudget(USER_B, { month: '2026-11', categoryId: mine.categoryId })).toBeNull();
    expect(await listBudgets(USER_B)).toHaveLength(0);
    expect(await deleteBudget(USER_B, mine.id)).toBe(false);
    expect(await getBudget(USER_A, { month: '2026-11', categoryId: mine.categoryId })).not.toBeNull();

    expect(await deleteBudget(USER_A, mine.id)).toBe(true);
    expect(await listBudgets(USER_A)).toHaveLength(0);
  });

  it('бюджет только для расходной категории', async () => {
    const salary = await createCategory(USER_A, { name: 'Salary', kind: 'income' });
    await expect(
      setBudget(USER_A, { month: '2026-11', categoryId: salary.id, limitAmountEurCents: 1_000 }),
    ).rejects.toThrow(/for expense categories/);

    await expect(
      setBudget(USER_A, { month: '2026-11', limitAmountEurCents: 1_000 }),
    ).rejects.toThrow(/categoryId or categoryName is required/);
  });
});

// ---------------------------------------------------------------------------
// Обязательства
// ---------------------------------------------------------------------------

describe('finances: обязательства', () => {
  it('listLiabilities сортирует по очередям и фильтрует по статусу', async () => {
    await createLiability(USER_A, { name: 'Third', queue: 'queue_3', amountCents: 1_000 });
    await createLiability(USER_A, {
      name: 'Netflix',
      queue: recurring('subscription'),
      amountCents: 1_200,
      monthlyPaymentCents: 1_200,
      paymentDay: 5,
    });
    await createLiability(USER_A, { name: 'First', queue: 'queue_1', amountCents: 2_000, paymentDay: 20 });
    await createLiability(USER_A, { name: 'Cloud', queue: recurring('service'), amountCents: 500 });
    await createLiability(USER_A, { name: 'Closed', amountCents: 900, isActive: false });

    expect((await listLiabilities(USER_A)).map((row) => row.name)).toEqual([
      'Netflix',
      'Cloud',
      'First',
      'Third',
    ]);
    expect((await listLiabilities(USER_A, 'closed')).map((row) => row.name)).toEqual(['Closed']);
    expect(await listLiabilities(USER_A, 'all')).toHaveLength(5);
  });

  it('обязательства изолированы по юзеру', async () => {
    const mine = await createLiability(USER_A, { name: 'Loan', amountCents: 100_000 });
    const foreign = await createLiability(USER_B, { name: 'Loan', amountCents: 5_000 });

    expect(await getLiability(USER_B, mine.id)).toBeNull();
    expect((await getLiability(USER_A, mine.id))?.id).toBe(mine.id);
    expect((await listLiabilities(USER_B)).map((row) => row.id)).toEqual([foreign.id]);

    await expect(updateLiability(USER_B, mine.id, { notes: 'hack' })).rejects.toThrow(/not found/);
    expect(await deleteLiability(USER_B, mine.id)).toBe(false);
    expect(await getLiability(USER_A, mine.id)).not.toBeNull();

    await expect(
      payLiability(USER_B, { liabilityId: mine.id, paymentDate: '2026-11-10' }),
    ).rejects.toBeInstanceOf(LiabilityNotFoundError);

    // и счёт юзера А нельзя привязать к обязательству юзера Б
    const { main } = await seedAccounts(USER_A);
    await expect(
      createLiability(USER_B, { name: 'Foreign account', accountId: main.id }),
    ).rejects.toThrow(/account .* not found/);
  });

  it('findLiabilityByName ищет по точному имени и подстроке среди активных', async () => {
    await createLiability(USER_A, { name: 'Car loan', amountCents: 100_000 });
    await createLiability(USER_A, { name: 'Netflix', queue: recurring('subscription'), amountCents: 1_200 });
    await createLiability(USER_A, { name: 'Car lease', amountCents: 900, isActive: false });

    expect((await findLiabilityByName(USER_A, 'netflix'))?.name).toBe('Netflix');
    expect((await findLiabilityByName(USER_A, 'car'))?.name).toBe('Car loan');
    expect((await findLiabilityByName(USER_A, 'gym'))?.name ?? null).toBeNull();
  });

  it('createLiability считает EUR-эквивалент и валидирует поля', async () => {
    const created = await createLiability(USER_A, {
      name: 'USD loan',
      amountCents: 10_000,
      currency: 'USD',
      monthlyPaymentCents: 1_000,
      paymentDay: 15,
      totalPayments: 12,
      rates: { USD: 1.08 },
    });

    expect(created).toMatchObject({
      userId: USER_A,
      name: 'USD loan',
      queue: 'queue_1',
      currency: 'USD',
      amountCents: 10_000,
      amountEurCents: 9_259,
      monthlyPaymentCents: 1_000,
      paymentDay: 15,
      totalPayments: 12,
      isActive: true,
      paidMonths: [],
      accountId: null,
    });

    await expect(createLiability(USER_A, { name: '  ' })).rejects.toThrow(/name is required/);
    await expect(createLiability(USER_A, { name: 'Bad day', paymentDay: 32 })).rejects.toThrow(
      /payment day must be 1\.\.31/,
    );
    await expect(createLiability(USER_A, { name: 'Bad total', totalPayments: -1 })).rejects.toThrow(
      /total payments must be >= 0/,
    );
  });

  it('updateLiability пересчитывает EUR-эквивалент, deleteLiability удаляет', async () => {
    const created = await createLiability(USER_A, {
      name: 'Loan',
      amountCents: 10_000,
      currency: 'USD',
      rates: { USD: 1.08 },
    });

    const updated = await updateLiability(USER_A, created.id, {
      amountCents: 20_000,
      notes: 'refinanced',
      rates: { USD: 1.08 },
    });
    expect(updated.amountCents).toBe(20_000);
    expect(updated.amountEurCents).toBe(18_519); // 20000 / 1.08
    expect(updated.notes).toBe('refinanced');

    expect(await deleteLiability(USER_A, created.id)).toBe(true);
    expect(await getLiability(USER_A, created.id)).toBeNull();
  });

  it('payLiability: остаток, оплаченные месяцы, списание и идемпотентность', async () => {
    const { main } = await seedAccounts(USER_A);
    const liability = await createLiability(USER_A, {
      name: 'Loan',
      queue: 'queue_2',
      amountCents: 120_000,
      monthlyPaymentCents: 10_000,
      paymentDay: 10,
      totalPayments: 12,
      accountId: main.id,
    });

    const paid = await payLiability(USER_A, {
      liabilityId: liability.id,
      paymentDate: '2026-11-10',
      deductFromAccount: true,
    });

    expect(paid.alreadyPaid).toBe(false);
    expect(paid.month).toBe('2026-11');
    expect(paid.paymentDate).toBe('2026-11-10');
    expect(paid.amountCents).toBe(10_000);
    expect(paid.currency).toBe('EUR');
    expect(paid.fxRate).toBe(1);

    expect(paid.liability).toMatchObject({
      amountCents: 110_000,
      amountEurCents: 110_000,
      totalPayments: 11,
      lastPaymentDate: '2026-11-10',
      paidMonths: ['2026-11'],
    });

    expect(paid.deducted).toBe(true);
    expect(paid.deductedCents).toBe(10_000);
    expect(paid.account?.id).toBe(main.id);
    expect(await balanceOf(USER_A, main.id)).toBe(90_000);

    expect(paid.transaction).toMatchObject({
      kind: 'expense',
      amountCents: 10_000,
      currency: 'EUR',
      description: 'Liability payment: Loan',
      occurredAt: '2026-11-10T00:00:00.000Z',
    });

    // повторный платёж в том же месяце ничего не меняет
    const repeat = await payLiability(USER_A, {
      liabilityName: 'loan',
      paymentDate: '2026-11-20',
      deductFromAccount: true,
    });
    expect(repeat.alreadyPaid).toBe(true);
    expect(repeat.transaction).toBeNull();
    expect(repeat.deducted).toBe(false);
    expect(await balanceOf(USER_A, main.id)).toBe(90_000);
    expect((await getLiability(USER_A, liability.id))?.paidMonths).toEqual(['2026-11']);
    expect((await getLiability(USER_A, liability.id))?.amountCents).toBe(110_000);

    // следующий месяц — снова платёж
    const next = await payLiability(USER_A, {
      liabilityId: liability.id,
      paymentDate: '2026-12-10',
      deductFromAccount: true,
    });
    expect(next.alreadyPaid).toBe(false);
    expect(next.liability.paidMonths).toEqual(['2026-11', '2026-12']);
    expect(next.liability.amountCents).toBe(100_000);
    expect(await balanceOf(USER_A, main.id)).toBe(80_000);
    expect(await listTransactions(USER_A, { kind: 'expense' })).toHaveLength(2);
  });

  it('payLiability: подписка сохраняет остаток, списание в валюте счёта', async () => {
    const { main } = await seedAccounts(USER_A);
    const subscription = await createLiability(USER_A, {
      name: 'Cloud',
      queue: recurring('subscription'),
      amountCents: 5_000,
      monthlyPaymentCents: 500,
    });

    const paid = await payLiability(USER_A, {
      liabilityId: subscription.id,
      paymentDate: '2026-11-01',
      deductFromAccount: true,
      accountId: main.id,
    });
    expect(paid.liability.amountCents).toBe(5_000);
    expect(paid.liability.amountEurCents).toBe(5_000);
    expect(paid.liability.totalPayments).toBeNull();
    expect(await balanceOf(USER_A, main.id)).toBe(99_500);

    // обязательство в USD, счёт в EUR: списание конвертируется, в описании видно сумму в валюте счёта
    const usd = await createLiability(USER_A, {
      name: 'USD loan',
      amountCents: 120_000,
      currency: 'USD',
      monthlyPaymentCents: 10_000,
      accountId: main.id,
      rates: { USD: 1.08 },
    });
    const usdPaid = await payLiability(USER_A, {
      liabilityId: usd.id,
      paymentDate: '2026-11-05',
      deductFromAccount: true,
      rates: { USD: 1.08 },
    });

    expect(usdPaid.currency).toBe('USD');
    expect(usdPaid.amountEurCents).toBe(9_259);
    expect(usdPaid.fxRate).toBeCloseTo(0.9259, 6);
    expect(usdPaid.deductedCents).toBe(9_259);
    expect(await balanceOf(USER_A, main.id)).toBe(99_500 - 9_259);
    expect(usdPaid.transaction?.description).toBe('Liability payment: USD loan [deducted 92,59 EUR]');
    expect(usdPaid.liability.amountCents).toBe(110_000);
    expect(usdPaid.liability.amountEurCents).toBe(101_852); // 110000 / 1.08
  });

  it('payLiability без deductFromAccount не трогает счёт и транзакции', async () => {
    const { main } = await seedAccounts(USER_A);
    const liability = await createLiability(USER_A, {
      name: 'Кредит',
      queue: 'queue_2',
      amountCents: 120_000,
      monthlyPaymentCents: 35_000,
      paymentDay: 5,
      accountId: main.id,
    });

    const paid = await payLiability(USER_A, {
      liabilityId: liability.id,
      paymentDate: '2026-11-05',
      deductFromAccount: false,
    });

    expect(paid.alreadyPaid).toBe(false);
    expect(paid.deducted).toBe(false);
    expect(paid.transaction).toBeNull();
    expect(paid.liability.paidMonths).toEqual(['2026-11']);
    expect(paid.liability.amountCents).toBe(85_000);
    // Счёт привязан, но «оплатил» из проверки списаний деньги не двигает.
    expect(await balanceOf(USER_A, main.id)).toBe(100_000);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('payLiability без счёта ничего не списывает', async () => {
    const liability = await createLiability(USER_A, {
      name: 'No account',
      amountCents: 10_000,
      monthlyPaymentCents: 1_000,
    });

    const paid = await payLiability(USER_A, {
      liabilityId: liability.id,
      paymentDate: '2026-11-11',
      deductFromAccount: true,
    });
    expect(paid.deducted).toBe(false);
    expect(paid.account).toBeNull();
    expect(paid.transaction).toBeNull();
    expect(paid.liability.paidMonths).toEqual(['2026-11']);
    expect(await listTransactions(USER_A)).toHaveLength(0);

    await expect(
      payLiability(USER_A, { liabilityName: 'does-not-exist', paymentDate: '2026-11-11' }),
    ).rejects.toBeInstanceOf(LiabilityNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Обмен: две строки kind='exchange' с общим group_id (docs/design-exchange.md)
// ---------------------------------------------------------------------------

describe('finances: обмен', () => {
  async function seedExchangeAccounts(userId = USER_A) {
    const eur = await createAccount(userId, {
      name: 'Main',
      currency: 'EUR',
      initialBalanceCents: 50_000,
    });
    const usd = await createAccount(userId, { name: 'Usd', currency: 'USD' });
    return { eur, usd };
  }

  it('пишет две строки kind=exchange с общим group_id и знаками −/+', async () => {
    const { eur, usd } = await seedExchangeAccounts();

    const result = await createExchange(USER_A, {
      fromAccountId: eur.id,
      fromCents: 10_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 10_800,
      toCurrency: 'USD',
      occurredAt: '2026-03-10T12:00:00Z',
      rates: { USD: 1.08 },
    });

    expect(result.groupId).toBeTruthy();
    // out вставляется первой — стабильный порядок id
    expect(result.out.id).toBeLessThan(result.in.id);

    expect(result.out).toMatchObject({
      kind: 'exchange',
      accountId: eur.id,
      toAccountId: usd.id,
      amountCents: -10_000,
      currency: 'EUR',
      amountEurCents: -10_000,
      transferGroupId: result.groupId,
    });
    expect(result.in).toMatchObject({
      kind: 'exchange',
      accountId: usd.id,
      toAccountId: eur.id,
      amountCents: 10_800,
      currency: 'USD',
      amountEurCents: 10_000,
      transferGroupId: result.groupId,
    });
    // fx_rate каждой ноги — |amountEur| / |amount|
    expect(result.out.fxRate).toBeCloseTo(1, 6);
    expect(result.in.fxRate).toBeCloseTo(10_000 / 10_800, 6);

    const rows = await listTransactions(USER_A, { kind: 'exchange' });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.transferGroupId))).toEqual(new Set([result.groupId]));
    // сумма по группе в EUR ≈ 0 (спред), а не фиктивный расход
    expect(rows.reduce((sum, row) => sum + row.amountEurCents, 0)).toBe(0);
  });

  it('двигает балансы: источник −fromCents, получатель +toCents', async () => {
    const { eur, usd } = await seedExchangeAccounts();

    await createExchange(USER_A, {
      fromAccountId: eur.id,
      fromCents: 10_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 10_800,
      toCurrency: 'USD',
      rates: { USD: 1.08 },
    });

    expect(await balanceOf(USER_A, eur.id)).toBe(40_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(10_800);
  });

  it('отмена по любой ноге возвращает оба баланса и удаляет обе строки', async () => {
    const { eur, usd } = await seedExchangeAccounts();
    const input = {
      fromAccountId: eur.id,
      fromCents: 10_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 10_800,
      toCurrency: 'USD',
      rates: { USD: 1.08 },
    };

    const first = await createExchange(USER_A, input);
    const removed = await deleteTransaction(USER_A, first.out.id);
    expect(removed?.id).toBe(first.out.id);
    expect(await balanceOf(USER_A, eur.id)).toBe(50_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
    expect(await listTransactions(USER_A)).toHaveLength(0);
    // повторная отмена — null, балансы не двигаются
    expect(await deleteTransaction(USER_A, first.out.id)).toBeNull();
    expect(await balanceOf(USER_A, eur.id)).toBe(50_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);

    // то же самое по входящей ноге
    const second = await createExchange(USER_A, input);
    expect((await deleteTransaction(USER_A, second.in.id))?.id).toBe(second.in.id);
    expect(await balanceOf(USER_A, eur.id)).toBe(50_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('undoLastTransaction сразу после обмена отменяет обмен, а не прошлый расход', async () => {
    const { main } = await seedAccounts(USER_A);
    await createTransaction(USER_A, {
      kind: 'expense',
      amountCents: 1_000,
      accountId: main.id,
      categoryName: 'Еда',
    });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });

    await createExchange(USER_A, {
      fromAccountId: main.id,
      fromCents: 5_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 5_400,
      toCurrency: 'USD',
      rates: { USD: 1.08 },
    });

    const removed = await undoLastTransaction(USER_A);
    expect(removed?.kind).toBe('exchange');
    expect(await balanceOf(USER_A, main.id)).toBe(99_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
    // расход остался — отменён был именно обмен
    const left = await listTransactions(USER_A);
    expect(left).toHaveLength(1);
    expect(left[0].kind).toBe('expense');
  });

  it('со счёта без денег добирает с KZT и падает без расчётного счёта', async () => {
    await setRates('2026-11-13', { KZT: 500, USD: 1.08 });
    const bank = 'Multi Bank';
    const kzt = await createAccount(USER_A, {
      name: bank,
      currency: 'KZT',
      initialBalanceCents: 1_000_000,
    });
    const sub = await createAccount(USER_A, { name: bank, currency: 'EUR' });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });
    const rates = { KZT: 500, USD: 1.08 };

    await createExchange(USER_A, {
      fromAccountId: sub.id,
      fromCents: 1_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 1_080,
      toCurrency: 'USD',
      rates,
    });

    // 10 EUR с нулевого субсчёта = 5 000 KZT с расчётного
    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(500_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(1_080);
    // Четыре ноги: исходящая, добор на субсчёт, списание добора с KZT, входящая.
    // Без ног добора `revertGroup` не смог бы вернуть KZT (review, дефект A).
    expect(await listTransactions(USER_A)).toHaveLength(4);

    // без расчётного счёта той же группы — отказ и ни следа в истории/балансах
    const solo = await createAccount(USER_A, { name: 'Solo', currency: 'EUR' });
    await expect(
      createExchange(USER_A, {
        fromAccountId: solo.id,
        fromCents: 1_000,
        fromCurrency: 'EUR',
        toAccountId: usd.id,
        toCents: 1_080,
        toCurrency: 'USD',
        rates,
      }),
    ).rejects.toThrow(/не хватает денег/);

    expect(await balanceOf(USER_A, solo.id)).toBe(0);
    expect(await balanceOf(USER_A, usd.id)).toBe(1_080);
    expect(await listTransactions(USER_A)).toHaveLength(4);
  });

  it('отмена обмена с добором возвращает оба счёта до копейки', async () => {
    await setRates('2026-11-13', { KZT: 500, USD: 1.08 });
    const bank = 'Split Bank';
    const kzt = await createAccount(USER_A, {
      name: bank,
      currency: 'KZT',
      initialBalanceCents: 1_000_000,
    });
    const sub = await createAccount(USER_A, {
      name: bank,
      currency: 'EUR',
      initialBalanceCents: 300,
    });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });
    const rates = { KZT: 500, USD: 1.08 };

    // 10 EUR: 3 EUR со субсчёта, 7 EUR (3 500 KZT) добираются с расчётного.
    const exchange = await createExchange(USER_A, {
      fromAccountId: sub.id,
      fromCents: 1_000,
      fromCurrency: 'EUR',
      toAccountId: usd.id,
      toCents: 1_080,
      toCurrency: 'USD',
      rates,
    });
    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(650_000);

    await deleteTransaction(USER_A, exchange.out.id);

    // Дефект A из ревью: раньше субсчёт получал +1000 EUR, а KZT оставался в минусе.
    expect(await balanceOf(USER_A, sub.id)).toBe(300);
    expect(await balanceOf(USER_A, kzt.id)).toBe(1_000_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('без BEGIN: сбой без расчётного счёта не оставляет ни строк, ни сдвигов', async () => {
    await setRates('2026-11-13', { KZT: 500, USD: 1.08 });
    const solo = await createAccount(USER_A, { name: 'Solo', currency: 'EUR' });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });

    const restore = blockBegin();
    try {
      await expect(
        createExchange(USER_A, {
          fromAccountId: solo.id,
          fromCents: 1_000,
          fromCurrency: 'EUR',
          toAccountId: usd.id,
          toCents: 1_080,
          toCurrency: 'USD',
          rates: { KZT: 500, USD: 1.08 },
        }),
      ).rejects.toThrow(/не хватает денег/);
    } finally {
      restore();
    }

    // Дефект B: раньше исходящая нога вставлялась до списания и оставалась сиротой.
    expect(await listTransactions(USER_A)).toHaveLength(0);
    expect(await balanceOf(USER_A, solo.id)).toBe(0);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
  });

  it('без BEGIN: успешный обмен и его отмена точны', async () => {
    await setRates('2026-11-13', { KZT: 500, USD: 1.08 });
    const bank = 'NoTx Bank';
    const kzt = await createAccount(USER_A, {
      name: bank,
      currency: 'KZT',
      initialBalanceCents: 1_000_000,
    });
    const sub = await createAccount(USER_A, { name: bank, currency: 'EUR' });
    const usd = await createAccount(USER_A, { name: 'Usd', currency: 'USD' });

    const restore = blockBegin();
    let exchange: Awaited<ReturnType<typeof createExchange>>;
    try {
      exchange = await createExchange(USER_A, {
        fromAccountId: sub.id,
        fromCents: 1_000,
        fromCurrency: 'EUR',
        toAccountId: usd.id,
        toCents: 1_080,
        toCurrency: 'USD',
        rates: { KZT: 500, USD: 1.08 },
      });
    } finally {
      restore();
    }

    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(500_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(1_080);

    await deleteTransaction(USER_A, exchange.out.id);
    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(1_000_000);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
  });

  it('без BEGIN: сбой после списания возвращает балансы и убирает строки', async () => {
    const { eur, usd } = await seedExchangeAccounts();
    const before = await balanceOf(USER_A, eur.id);

    const original = db.run;
    const failInsert = vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
      if (text.trim().toUpperCase() === 'BEGIN') {
        throw new Error('not authorized (code 23)');
      }
      if (text.includes('INSERT INTO transactions')) {
        throw new Error('disk I/O error');
      }
      return original.call(db, query as never, params);
    });
    try {
      await expect(
        createExchange(USER_A, {
          fromAccountId: eur.id,
          fromCents: 10_000,
          fromCurrency: 'EUR',
          toAccountId: usd.id,
          toCents: 10_800,
          toCurrency: 'USD',
          rates: { USD: 1.08 },
        }),
      ).rejects.toThrow(/disk I\/O/);
    } finally {
      failInsert.mockRestore();
    }

    expect(await balanceOf(USER_A, eur.id)).toBe(before);
    expect(await balanceOf(USER_A, usd.id)).toBe(0);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('общий хелпер компенсации откатывает и баланс, и строки операции', async () => {
    const { eur } = await seedExchangeAccounts();
    const before = await balanceOf(USER_A, eur.id);
    const groupId = newGroupId();

    const restore = blockBegin();
    try {
      // Форма расхода: списание прошло, запись строки — нет.
      await expect(
        withBalanceCompensation(USER_A, groupId, async (book) => {
          await book.apply(eur.id, -1_000);
          throw new Error('write failed');
        }),
      ).rejects.toThrow(/write failed/);
    } finally {
      restore();
    }

    expect(await balanceOf(USER_A, eur.id)).toBe(before);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('требует разные счета и положительные суммы', async () => {
    const { eur } = await seedExchangeAccounts();
    await expect(
      createExchange(USER_A, {
        fromAccountId: eur.id,
        fromCents: 100,
        toAccountId: eur.id,
        toCents: 100,
      }),
    ).rejects.toThrow(/must differ/);

    await expect(
      createExchange(USER_A, {
        fromAccountId: eur.id,
        fromCents: 0,
        toAccountId: eur.id,
        toCents: 100,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Инвариант владельца (13.11.2026): минуса на счетах не бывает
// ---------------------------------------------------------------------------

describe('finances: минуса на счетах не бывает', () => {
  /** Группа с расчётной валютой KZT: один банк, субсчёт в валюте + KZT. */
  async function seedGroup(userId: number, currency: string, kztCents: number, balanceCents: number) {
    const group = 'Multi Bank';
    const kzt = await createAccount(userId, {
      name: group,
      currency: 'KZT',
      initialBalanceCents: kztCents,
    });
    const sub = await createAccount(userId, {
      name: group,
      currency,
      initialBalanceCents: balanceCents,
    });
    return { kzt, sub };
  }

  it('нехватку в валюте субсчёта добирает с KZT того же банка по курсу', async () => {
    // 500 KZT за 1 EUR: расход 10 EUR при нуле на EUR-субсчёте = 5 000 KZT.
    await setRates('2026-11-13', { KZT: 500 });
    const { kzt, sub } = await seedGroup(USER_A, 'EUR', 1_000_000, 0);

    await createTransaction(USER_A, {
      kind: 'expense',
      accountId: sub.id,
      amountCents: 1_000,
      currency: 'EUR',
    });

    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(500_000);
  });

  it('добирает только нехватку, остаток субсчёта не трогает', async () => {
    await setRates('2026-11-13', { KZT: 500 });
    const { kzt, sub } = await seedGroup(USER_A, 'EUR', 1_000_000, 400);

    // Расход 10 EUR: 4 EUR своих + 6 EUR (3 000 KZT) с расчётного.
    await createTransaction(USER_A, {
      kind: 'expense',
      accountId: sub.id,
      amountCents: 1_000,
      currency: 'EUR',
    });

    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(700_000);
  });

  it('без расчётного счёта расход всё равно пишется, а минуса нет', async () => {
    const { main, cash } = await seedAccounts(USER_A, 1_000);

    const tx = await createTransaction(USER_A, {
      kind: 'expense',
      accountId: cash.id,
      amountCents: 2_000,
      currency: 'EUR',
    });

    // Расход — факт: строка на полную сумму, баланс обнулён, разница помечена.
    expect(tx.amountCents).toBe(2_000);
    expect(tx.uncoveredCents).toBe(2_000);
    expect(await balanceOf(USER_A, cash.id)).toBe(0);
    // Соседний счёт не тронут: добрать неоткуда — так и написано.
    expect(await balanceOf(USER_A, main.id)).toBe(1_000);
  });

  it('нехватка и на расчётном счёте: списывает всё, остаток помечает', async () => {
    await setRates('2026-11-13', { KZT: 500 });
    const { kzt, sub } = await seedGroup(USER_A, 'EUR', 1_000, 0);

    const tx = await createTransaction(USER_A, {
      kind: 'expense',
      accountId: sub.id,
      amountCents: 1_000,
      currency: 'EUR',
    });

    expect(tx.uncoveredCents).toBeGreaterThan(0);
    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(0);
  });

  it('отмена недокрытого расхода возвращает ровно списанное, а не номинал', async () => {
    // Остаток намеренно не половина номинала: при 10 из 20 списанное и
    // непокрытая разница совпадают, и перепутанные местами величины не видны.
    const { main } = await seedAccounts(USER_A, 1_500);

    // 20 EUR при 15 EUR на счёте: списывается 15, остальное — непокрытая разница.
    const tx = await createTransaction(USER_A, {
      kind: 'expense',
      accountId: main.id,
      amountCents: 2_000,
      currency: 'EUR',
    });
    expect(tx.uncoveredCents).toBe(500);
    expect(await balanceOf(USER_A, main.id)).toBe(0);

    // «Отменить» берёт последнюю строку группы — компенсацию (adjustment), а не
    // сам расход. Откат обязан вернуть 15 EUR и не уводить счёт в минус.
    const undone = await undoLastTransaction(USER_A);
    expect(undone).not.toBeNull();
    // Наружу отдаётся сам расход с номиналом, а непокрытая разница — отдельным
    // полем: тексты отмены считают возврат как 20 − 5, а не как 20.
    expect(undone?.kind).toBe('expense');
    expect(undone?.amountCents).toBe(2_000);
    expect(undone?.uncoveredCents).toBe(500);
    expect(await balanceOf(USER_A, main.id)).toBe(1_500);
    expect(await listTransactions(USER_A)).toHaveLength(0);
  });

  it('отмена добора с KZT считает возврат в валюте номинала, а не суммой ног', async () => {
    await setRates('2026-11-13', { KZT: 500 });
    // 4 EUR на субсчёте и 10 000 KZT на расчётном (20 EUR по курсу 500).
    const { kzt, sub } = await seedGroup(USER_A, 'EUR', 1_000_000, 400);

    // Расход 30 EUR: 4 EUR своих + 20 EUR с расчётного, 6 EUR не покрыто.
    const tx = await createTransaction(USER_A, {
      kind: 'expense',
      accountId: sub.id,
      amountCents: 3_000,
      currency: 'EUR',
    });
    expect(tx.uncoveredCents).toBe(600);
    expect(await balanceOf(USER_A, sub.id)).toBe(0);
    expect(await balanceOf(USER_A, kzt.id)).toBe(0);

    const undone = await undoLastTransaction(USER_A);

    // Ноги компенсации в двух валютах: если сложить их как числа, «непокрытая
    // разница» выйдет больше номинала, а возврат — отрицательным.
    expect(undone?.amountCents).toBe(3_000);
    expect(undone?.uncoveredCents).toBe(600);
    expect(await balanceOf(USER_A, sub.id)).toBe(400);
    expect(await balanceOf(USER_A, kzt.id)).toBe(1_000_000);
  });

  it('перевод тоже не уводит источник в минус', async () => {
    const { cash } = await seedAccounts(USER_A, 1_000);
    const other = await createAccount(USER_A, { name: 'Pocket', currency: 'EUR' });

    await expect(
      createTransaction(USER_A, {
        kind: 'transfer',
        accountId: cash.id,
        toAccountId: other.id,
        amountCents: 2_000,
        currency: 'EUR',
      }),
    ).rejects.toThrow(/не хватает денег/);

    expect(await balanceOf(USER_A, other.id)).toBe(0);
  });

  it('инвентаризация не принимает отрицательный баланс', async () => {
    const { main } = await seedAccounts(USER_A);

    await expect(setAccountBalance(USER_A, main.id, -1)).rejects.toThrow(
      /не может быть отрицательным/,
    );
    expect(await balanceOf(USER_A, main.id)).toBe(100_000);
  });

  // Review №4: добор — это две записи в accounts, а BEGIN на tgcloud нет.
  // Если вторая падает, первая не должна остаться списанной.
  it('сбой второго списания (добор с KZT) откатывает первое', async () => {
    await setRates('2026-11-13', { KZT: 500 });
    const { kzt, sub } = await seedGroup(USER_A, 'EUR', 1_000_000, 400);

    const original = db.run;
    let balanceUpdates = 0;
    const failSecond = vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
      if (text.includes('UPDATE accounts')) {
        balanceUpdates += 1;
        if (balanceUpdates === 2) throw new Error('disk I/O error');
      }
      return original.call(db, query as never, params);
    });

    try {
      await expect(
        debitWithSettlement(USER_A, sub, 1_000, { KZT: 500 }),
      ).rejects.toThrow(/disk I\/O/);
    } finally {
      failSecond.mockRestore();
    }

    // 1) списание остатка субсчёта, 2) упавшее списание KZT, 3) его откат.
    expect(balanceUpdates).toBe(3);
    expect(await balanceOf(USER_A, sub.id)).toBe(400);
    expect(await balanceOf(USER_A, kzt.id)).toBe(1_000_000);
  });

  it('сбой чтения сразу после списания тоже возвращает баланс', async () => {
    const { main } = await seedAccounts(USER_A, 10_000);

    const originalRun = db.run;
    const originalGet = db.get;
    let debited = false;
    let failed = false;
    const onRun = vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
      if (text.includes('UPDATE accounts')) debited = true;
      return originalRun.call(db, query as never, params);
    });
    const failRead = vi.spyOn(db, 'get').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
      if (debited && !failed && text.includes('FROM accounts')) {
        failed = true;
        throw new Error('connection reset');
      }
      return originalGet.call(db, query as never, params);
    });

    try {
      await expect(debitWithSettlement(USER_A, main, 1_000, {})).rejects.toThrow(
        /connection reset/,
      );
    } finally {
      failRead.mockRestore();
      onRun.mockRestore();
    }

    expect(await balanceOf(USER_A, main.id)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Утилиты курсов
// ---------------------------------------------------------------------------

describe('finances: утилиты курсов', () => {
  it('toBaseCents и fxRateFor согласованы с fx.convert', () => {
    expect(toBaseCents(10_000, 'USD', { USD: 1.08 })).toBe(9_259);
    expect(toBaseCents(10_000, 'EUR', {})).toBe(10_000);
    expect(fxRateFor('USD', { USD: 1.08 })).toBeCloseTo(0.925926, 6);
    expect(fxRateFor('EUR', {})).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Идентификаторы групп (RNG1). Раньше это был Math.random с process-local
// счётчиком: два изолята с одинаковыми часами выдавали ОДИН id, и группы
// переводов склеивались в отчётах.
// ---------------------------------------------------------------------------

describe('finances: идентификатор группы переводов', () => {
  it('совпадает с прежним uuid-подобным форматом', async () => {
    const mod = await import('../../src/lib/dal/finances');
    expect(mod.newGroupId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{16}$/,
    );
  });

  it('два изолята с одними часами не выдают одинаковых id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    vi.resetModules();
    const isolateA = await import('../../src/lib/dal/finances');
    vi.resetModules();
    const isolateB = await import('../../src/lib/dal/finances');

    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(isolateA.newGroupId());
      ids.add(isolateB.newGroupId());
    }
    expect(ids.size).toBe(100);
  });
});
