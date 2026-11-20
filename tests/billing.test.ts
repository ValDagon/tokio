/**
 * `src/lib/billing.ts` — прайс, учёт расхода и месячные квоты.
 *
 * Тесты держат два инварианта, ради которых модуль и написан:
 *  - деньги считаются в целых микро-долларах и совпадают с `token_tracker.py`;
 *  - BYOK-трафик не пишется в бухгалтерию продукта и не тратит квоту.
 *
 * Плюс ленивый сброс квоты при смене месяца — его легко сломать незаметно,
 * потому что счётчик живёт в `users`, а не в `llm_usage`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import {
  checkQuota,
  checkSpendLimit,
  DEFAULT_PRICING,
  DEFAULT_USER_SPEND_LIMIT_MICROS,
  estimateCostMicros,
  getMonthUsage,
  getTotalUsage,
  isByokUser,
  priceForModel,
  PRICING_PER_MILLION,
  recordUsage,
  SPEND_LIMIT_EXCEEDED_MESSAGE,
  tokenCount,
} from '../src/lib/billing';
import { addUsage, ensureUser, getUser, setMonthlyQuota, updateUser } from '../src/lib/dal/users';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { monthKey } from '../src/lib/utils';

const USER = 1;
const BYOK_KEY = { ciphertext: 'deadbeef', nonce: '00112233445566778899aabb', tag: '' };

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

/** Строки `llm_usage` пользователя — напрямую, чтобы проверять сам факт записи. */
async function usageRows(userId: number): Promise<Array<Record<string, unknown>>> {
  return db.all(sql`SELECT * FROM llm_usage WHERE user_id = ${userId} ORDER BY id ASC`);
}

/** Принудительно «прошломесячный» счётчик квоты. */
async function setStaleQuota(userId: number, tokens: number): Promise<void> {
  await db.run(sql`
    UPDATE users SET quota_month = ${'1999-01'}, quota_tokens = ${tokens} WHERE id = ${userId}
  `);
}

// ---------------------------------------------------------------------------
// Прайс и арифметика
// ---------------------------------------------------------------------------

describe('priceForModel', () => {
  it('знает модели из таблицы, включая алиасы с провайдером', () => {
    expect(priceForModel('gemini-2.5-flash')).toEqual({
      inputMicrosPerMillion: 75_000,
      outputMicrosPerMillion: 300_000,
    });
    expect(priceForModel('google/gemini-2.5-flash')).toEqual(priceForModel('gemini-2.5-flash'));
    expect(priceForModel('deepseek/deepseek-v4.1-flash')).toEqual({
      inputMicrosPerMillion: 140_000,
      outputMicrosPerMillion: 280_000,
    });
    expect(priceForModel('  gemini-flash-latest  ')).toEqual(priceForModel('gemini-flash-latest'));
  });

  it('неизвестная модель (и пустая строка) считаются по дефолтной ставке', () => {
    expect(priceForModel('some/unknown-model')).toEqual(DEFAULT_PRICING);
    expect(priceForModel('')).toEqual(DEFAULT_PRICING);
    expect(PRICING_PER_MILLION.default).toEqual(DEFAULT_PRICING);
  });
});

describe('tokenCount', () => {
  it('отбрасывает мусор, дроби и отрицательные значения', () => {
    expect(tokenCount(undefined)).toBe(0);
    expect(tokenCount(null)).toBe(0);
    expect(tokenCount(Number.NaN)).toBe(0);
    expect(tokenCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(tokenCount(-42)).toBe(0);
    expect(tokenCount(3.9)).toBe(3);
    expect(tokenCount(17)).toBe(17);
  });
});

describe('estimateCostMicros', () => {
  it('1M входных и 1M выходных токенов flash стоят 75 000 и 300 000 µUSD', () => {
    expect(estimateCostMicros('gemini-2.5-flash', 1_000_000, 0)).toBe(75_000);
    expect(estimateCostMicros('gemini-2.5-flash', 0, 1_000_000)).toBe(300_000);
    expect(estimateCostMicros('gemini-2.5-flash', 1_000_000, 1_000_000)).toBe(375_000);
  });

  it('500k + 500k на flash = 187 500 µUSD (пример из token_tracker.py)', () => {
    expect(estimateCostMicros('gemini-3.8-flash', 500_000, 500_000)).toBe(187_500);
    expect(estimateCostMicros('unknown-model', 500_000, 500_000)).toBe(187_500);
  });

  it('округляет до ближайшего микро-доллара', () => {
    // 10 prompt-токенов flash = 0.75 µUSD → 1
    expect(estimateCostMicros('gemini-2.5-flash', 10, 0)).toBe(1);
    // 6 prompt-токенов flash = 0.45 µUSD → 0
    expect(estimateCostMicros('gemini-2.5-flash', 6, 0)).toBe(0);
  });

  it('мусорные токены не ломают формулу', () => {
    expect(estimateCostMicros('gemini-2.5-flash', -1000, Number.NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordUsage
// ---------------------------------------------------------------------------

describe('recordUsage без BYOK', () => {
  it('пишет историю в llm_usage, списывает квоту и возвращает стоимость', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 10_000);

    const record = await recordUsage(USER, {
      model: 'gemini-2.5-flash',
      promptTokens: 1000,
      completionTokens: 500,
      purpose: 'summary',
    });

    expect(record.byok).toBe(false);
    expect(record.charged).toBe(true);
    expect(record.promptTokens).toBe(1000);
    expect(record.completionTokens).toBe(500);
    // 1000 * 75e3 / 1e6 + 500 * 300e3 / 1e6 = 75 + 150 = 225
    expect(record.costMicros).toBe(225);
    expect(record.row).not.toBeNull();
    expect(record.row?.model).toBe('gemini-2.5-flash');
    expect(record.row?.purpose).toBe('summary');
    expect(record.row?.costMicros).toBe(225);

    const user = await getUser(USER);
    expect(user?.quotaTokens).toBe(1500);
    expect(user?.quotaMonth).toBe(monthKey());

    const rows = await usageRows(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('gemini-2.5-flash');
    expect(rows[0]?.prompt_tokens).toBe(1000);
    expect(rows[0]?.cost_micros).toBe(225);
  });

  it('накапливает квоту и сводки за месяц/всё время', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 100_000);

    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 1000, completionTokens: 0 });
    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 0, completionTokens: 1000 });

    const user = await getUser(USER);
    expect(user?.quotaTokens).toBe(2000);

    const month = await getMonthUsage(USER);
    expect(month).toEqual({ promptTokens: 1000, completionTokens: 1000, costMicros: 375, calls: 2 });
    expect(await getTotalUsage(USER)).toEqual(month);
  });

  it('purpose по умолчанию — agent, costMicros можно передать готовым', async () => {
    await ensureUser(USER);

    const record = await recordUsage(USER, {
      model: 'gemini-2.5-flash',
      promptTokens: 10,
      completionTokens: 10,
      costMicros: 1234,
    });

    expect(record.costMicros).toBe(1234);
    expect(record.row?.purpose).toBe('agent');
    expect(record.row?.costMicros).toBe(1234);
  });

  it('мусорный costMicros обрезается до нуля, а не уходит в минус', async () => {
    await ensureUser(USER);
    const record = await recordUsage(USER, { model: 'gemini-2.5-flash', costMicros: -500 });
    expect(record.costMicros).toBe(0);
  });

  it('сброс квоты при смене месяца происходит в addUsage', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 1000);
    await setStaleQuota(USER, 900);

    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 100 });

    const user = await getUser(USER);
    expect(user?.quotaMonth).toBe(monthKey());
    expect(user?.quotaTokens).toBe(100); // старые 900 не прибавились
  });

  it('без строки пользователя пишет историю, но ничего не списывает', async () => {
    const record = await recordUsage(424242, {
      model: 'gemini-2.5-flash',
      promptTokens: 10,
      completionTokens: 5,
    });

    expect(record.row).not.toBeNull();
    expect(record.charged).toBe(false);
    expect(await usageRows(424242)).toHaveLength(1);
  });

  it('пустая модель — ошибка', async () => {
    await expect(recordUsage(USER, { model: '   ', promptTokens: 1 })).rejects.toThrow(/model is required/);
  });
});

describe('recordUsage для BYOK', () => {
  it('не пишет llm_usage, не трогает квоту и помечает charged=false', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 10_000);
    await updateUser(USER, { byok: BYOK_KEY });

    expect(await isByokUser(USER)).toBe(true);

    const record = await recordUsage(USER, {
      model: 'gemini-2.5-flash',
      promptTokens: 1000,
      completionTokens: 500,
    });

    expect(record.byok).toBe(true);
    expect(record.charged).toBe(false);
    expect(record.row).toBeNull();
    // стоимость посчитана для отчётности, но не записана
    expect(record.costMicros).toBe(225);

    expect(await usageRows(USER)).toHaveLength(0);
    const user = await getUser(USER);
    expect(user?.quotaTokens).toBe(0);
    expect(await getTotalUsage(USER)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      costMicros: 0,
      calls: 0,
    });
  });

  it('явный byok: true перебивает отсутствие ключа у пользователя', async () => {
    await ensureUser(USER);
    const record = await recordUsage(USER, { model: 'gemini-2.5-flash', byok: true });
    expect(record.byok).toBe(true);
    expect(record.row).toBeNull();
    expect(await usageRows(USER)).toHaveLength(0);
  });

  it('isByokUser: нет строки или пустой byok → false', async () => {
    expect(await isByokUser(USER)).toBe(false);
    await ensureUser(USER);
    expect(await isByokUser(USER)).toBe(false);
    await updateUser(USER, { byok: BYOK_KEY });
    expect(await isByokUser(USER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Квоты
// ---------------------------------------------------------------------------

describe('checkQuota', () => {
  it('нет пользователя — ошибка, квоту не с чем сверять', async () => {
    await expect(checkQuota(USER)).rejects.toThrow(/not found/);
  });

  it('quota_limit = 0 — безлимит (дефолт DDL)', async () => {
    await ensureUser(USER);

    const status = await checkQuota(USER);
    expect(status).toMatchObject({
      allowed: true,
      byok: false,
      limit: 0,
      used: 0,
      remaining: null,
      reason: 'unlimited',
      month: monthKey(),
    });
  });

  it('укладывается в лимит: ok, remaining считается от использованного', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 5000);

    const status = await checkQuota(USER);
    expect(status.allowed).toBe(true);
    expect(status.reason).toBe('ok');
    expect(status.limit).toBe(5000);
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(5000);
  });

  it('планируемый вызов сверх остатка — exhausted', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 5000);
    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 1500 });

    const fits = await checkQuota(USER, 3500); // ровно в лимит
    expect(fits.allowed).toBe(true);
    expect(fits.reason).toBe('ok');
    expect(fits.used).toBe(1500);
    expect(fits.remaining).toBe(3500);

    const over = await checkQuota(USER, 3501);
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('exhausted');
    expect(over.used).toBe(1500);
    expect(over.remaining).toBe(3500); // остаток не «сгорает» от проверки
  });

  it('исчерпанная квота без плана тоже exhausted', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 1000);
    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 1000, completionTokens: 200 });

    const status = await checkQuota(USER);
    expect(status.allowed).toBe(false);
    expect(status.reason).toBe('exhausted');
    expect(status.used).toBe(1200);
    expect(status.remaining).toBe(0);
  });

  it('BYOK — безлимит по определению, remaining: null', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 1);
    await updateUser(USER, { byok: BYOK_KEY });

    const status = await checkQuota(USER, 1_000_000);
    expect(status.allowed).toBe(true);
    expect(status.byok).toBe(true);
    expect(status.reason).toBe('byok');
    expect(status.remaining).toBeNull();
    expect(status.limit).toBe(1);
  });

  it('счётчик прошлого месяца считается нулём (ленивый сброс)', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 1000);
    await setStaleQuota(USER, 900);

    const status = await checkQuota(USER);
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(1000);
    expect(status.allowed).toBe(true);
    expect(status.reason).toBe('ok');
  });

  it('отрицательный план игнорируется', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 100);
    const status = await checkQuota(USER, -50);
    expect(status.allowed).toBe(true);
    expect(status.used).toBe(0);
  });
});

describe('согласованность счётчика и истории', () => {
  it('квота в users и сумма llm_usage растут одинаково', async () => {
    await ensureUser(USER);
    await setMonthlyQuota(USER, 10_000);

    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 120, completionTokens: 30 });
    await recordUsage(USER, { model: 'gemini-2.5-flash', promptTokens: 80, completionTokens: 20 });

    const user = await getUser(USER);
    const totals = await getTotalUsage(USER);
    expect(user?.quotaTokens).toBe(totals.promptTokens + totals.completionTokens);
    expect(totals.promptTokens).toBe(200);
    expect(totals.completionTokens).toBe(50);
    expect(totals.calls).toBe(2);
  });

  it('addUsage отдельно обновляет только квоту, история не появляется', async () => {
    await ensureUser(USER);
    await addUsage(USER, 400);

    const user = await getUser(USER);
    expect(user?.quotaTokens).toBe(400);
    expect(await usageRows(USER)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Лимит 2 USD на общий ключ и исключения (Owner / Admin / BYOK)
// ---------------------------------------------------------------------------

describe('checkSpendLimit', () => {
  beforeEach(() => {
    resetConfigCache();
    setConfigOverrides({ adminIds: [999] });
  });

  it('пользователь без трат — доступ разрешён', async () => {
    await ensureUser(USER);
    const status = await checkSpendLimit(USER);
    expect(status.allowed).toBe(true);
    expect(status.totalCostMicros).toBe(0);
    expect(status.remainingMicros).toBe(DEFAULT_USER_SPEND_LIMIT_MICROS);
    expect(status.reason).toBe('ok');
    expect(status.isOwnerOrAdmin).toBe(false);
    expect(status.hasByok).toBe(false);
  });

  it('пользователь потратил меньше 2 USD — доступ разрешён', async () => {
    await ensureUser(USER);
    await recordUsage(USER, { model: 'gemini-2.5-flash', costMicros: 500_000 });

    const status = await checkSpendLimit(USER);
    expect(status.allowed).toBe(true);
    expect(status.totalCostMicros).toBe(500_000);
    expect(status.remainingMicros).toBe(1_500_000);
    expect(status.reason).toBe('ok');
  });

  it('пользователь потратил 2 USD или больше — доступ заблокирован', async () => {
    await ensureUser(USER);
    await recordUsage(USER, { model: 'gemini-2.5-flash', costMicros: DEFAULT_USER_SPEND_LIMIT_MICROS });

    const status = await checkSpendLimit(USER);
    expect(status.allowed).toBe(false);
    expect(status.totalCostMicros).toBe(DEFAULT_USER_SPEND_LIMIT_MICROS);
    expect(status.remainingMicros).toBe(0);
    expect(status.reason).toBe('exhausted');
  });

  it('администратор из config.adminIds свободен от лимита даже при $100 расхода', async () => {
    const ADMIN = 100001;
    setConfigOverrides({ adminIds: [ADMIN] });
    await ensureUser(ADMIN);
    await recordUsage(ADMIN, { model: 'gemini-2.5-flash', costMicros: 100_000_000 });

    const status = await checkSpendLimit(ADMIN);
    expect(status.allowed).toBe(true);
    expect(status.isOwnerOrAdmin).toBe(true);
    expect(status.reason).toBe('admin');
    expect(status.remainingMicros).toBeNull();
  });

  it('администратор из adminIds свободен от лимита', async () => {
    const ADMIN_USER = 999;
    await ensureUser(ADMIN_USER);
    await recordUsage(ADMIN_USER, { model: 'gemini-2.5-flash', costMicros: 10_000_000 });

    const status = await checkSpendLimit(ADMIN_USER);
    expect(status.allowed).toBe(true);
    expect(status.isOwnerOrAdmin).toBe(true);
    expect(status.reason).toBe('admin');
    expect(status.remainingMicros).toBeNull();
  });

  it('пользователь со своим BYOK-ключом свободен от лимита продукта', async () => {
    await ensureUser(USER);
    await updateUser(USER, { byok: BYOK_KEY });
    await recordUsage(USER, { model: 'gemini-2.5-flash', costMicros: 50_000_000 });

    const status = await checkSpendLimit(USER);
    expect(status.allowed).toBe(true);
    expect(status.hasByok).toBe(true);
    expect(status.reason).toBe('byok');
    expect(status.remainingMicros).toBeNull();
  });

  it('BYOK чужого провайдера не освобождает от лимита на ключ продукта', async () => {
    await ensureUser(USER);
    await updateUser(USER, { byok: BYOK_KEY, modelProvider: 'gemini' });
    // Траты по продуктовому ключу (byok:false) — BYOK-вызовы в llm_usage не пишутся.
    await recordUsage(USER, {
      model: 'gemini-2.5-flash',
      costMicros: DEFAULT_USER_SPEND_LIMIT_MICROS,
      byok: false,
    });

    const gemini = await checkSpendLimit(USER, 'gemini');
    expect(gemini.allowed).toBe(true);
    expect(gemini.reason).toBe('byok');

    const anthropic = await checkSpendLimit(USER, 'anthropic');
    expect(anthropic.allowed).toBe(false);
    expect(anthropic.hasByok).toBe(false);
    expect(anthropic.reason).toBe('exhausted');
  });
});
