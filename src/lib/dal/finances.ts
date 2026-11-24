/**
 * DAL: финансы — счета, категории, транзакции, бюджеты, обязательства.
 *
 * Правила слоя (SPEC §2.4, §2.5):
 *  - каждая функция получает `userId` и фильтрует по `user_id` параметром;
 *  - деньги — целые центы, курсы — REAL, json-колонки — TEXT с JSON;
 *  - FK на платформе запрещены, поэтому принадлежность счёта/категории юзеру
 *    проверяет этот модуль до апдейтов;
 *  - никакого хардкода банков/городов/валют конкретного пользователя
 *    (SPEC-ADDENDUM §B): дефолтные счета — данные вызывающего (`ensureAccounts`).
 *
 * Паритет с upstream (Python `finances.py` / `liabilities.py`):
 *  - `fx_rate = round(amount_eur / amount, 6)`;
 *  - перевод — ОДНА строка (`amount > 0`, `to_account_id`, `transfer_group_id`),
 *    счета обязаны быть в одной валюте;
 *  - если валюта транзакции не совпадает с валютой счёта, баланс двигается на
 *    сумму, сконвертированную в валюту СЧЁТА (`amount_eur_cents` при этом
 *    считается от валюты транзакции);
 *  - `payLiability` идемпотентен по месяцу: повторная оплата того же месяца
 *    ничего не меняет и возвращает `alreadyPaid: true`;
 *  - очереди `subscription`/`service` — регулярные платежи, их «остаток» не
 *    уменьшается.
 */

import { db, sql } from 'sdk/db';
import type { Sql } from 'sdk/db';
import { bytesToHex, randomBytes } from '../crypto.js';
import { formatCents } from '../utils.js';
import { BASE_CURRENCY, convert, eurPerUnit, getRates, hasRate, normalizeCurrency } from './fx.js';
import type { RateTable } from './fx.js';
import type {
  AccountEnvelope,
  AccountRow,
  BudgetRow,
  Cents,
  CurrencyCode,
  FinCategoryKind,
  FinCategoryRow,
  IsoDate,
  IsoMonth,
  LiabilityQueue,
  LiabilityRow,
  TransactionKind,
  TransactionRow,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Инфраструктура: транзакции, sql-фрагменты, валидация
// ---------------------------------------------------------------------------

/**
 * Глубина вложенности `withTransaction`. Платформа не даёт вложенных BEGIN,
 * поэтому вложенный вызов просто присоединяется к внешней транзакции.
 */
let transactionDepth = 0;

/**
 * Best-effort транзакция. Вложенные вызовы не открывают новую транзакцию, а
 * выполняются в уже открытой; откат делает только самый внешний уровень.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactionDepth > 0) return fn();

  transactionDepth += 1;
  let inTx = false;
  try {
    try {
      await db.run(sql.raw('BEGIN'));
      inTx = true;
    } catch {
      // Платформа (tgcloud) блокирует явный BEGIN через SQLite authorizer (error 23)
      inTx = false;
    }

    if (!inTx) {
      return await fn();
    }

    try {
      const result = await fn();
      await db.run(sql.raw('COMMIT'));
      return result;
    } catch (error) {
      try {
        await db.run(sql.raw('ROLLBACK'));
      } catch {
        // соединение могло уже откатиться само — исходную ошибку это не меняет
      }
      throw error;
    }
  } finally {
    transactionDepth -= 1;
  }
}

/** Соединяет sql-фрагменты разделителем (обычно `' AND '` или `', '`). */
function joinSql(parts: readonly Sql[], separator: string): Sql {
  const first = parts[0];
  if (!first) throw new Error('finances: cannot join an empty sql list');
  return parts
    .slice(1)
    .reduce<Sql>((acc, part) => sql`${acc}${sql.raw(separator)}${part}`, first);
}

/** Условия → один фрагмент `a AND b AND c`; пустой список → `1 = 1`. */
function andAll(conditions: readonly Sql[]): Sql {
  if (conditions.length === 0) return sql`1 = 1`;
  return joinSql(
    conditions.map((cond) => sql`(${cond})`),
    ' AND ',
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assertUserId(userId: number): number {
  if (typeof userId !== 'number' || !Number.isFinite(userId)) {
    throw new Error('finances: userId is required');
  }
  return userId;
}

/** Деньги — целые центы: нечисло или дробь — ошибка вызывающего. */
function assertCents(value: Cents, label: string): Cents {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`finances.${label}: amount must be a finite number`);
  }
  return Math.round(value);
}

function assertPositiveCents(value: Cents, label: string): Cents {
  const cents = assertCents(value, label);
  if (cents <= 0) throw new Error(`finances.${label}: amount must be positive`);
  return cents;
}

function optionalCents(value: Cents | null | undefined, label: string): Cents | null {
  if (value === null || value === undefined) return null;
  return assertCents(value, label);
}

/** Строка/Date → `YYYY-MM-DD`. */
function isoDay(value: IsoDate | Date | null | undefined, fallback = new Date()): IsoDate {
  if (value === null || value === undefined) return fallback.toISOString().slice(0, 10);
  const raw = value instanceof Date ? value.toISOString() : String(value).trim();
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`finances: invalid date "${String(value)}"`);
  return day;
}

/** Дата/таймштамп → полный ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`). */
function toTimestamp(value: IsoDate | Date | null | undefined, fallback = new Date()): string {
  if (value === null || value === undefined) return fallback.toISOString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('finances: invalid date');
    return value.toISOString();
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`finances: invalid timestamp "${raw}"`);
  return parsed.toISOString();
}

function monthOf(value: IsoDate | Date | null | undefined): IsoMonth {
  return toTimestamp(value).slice(0, 7);
}

/** `YYYY-MM` из колонки-месяца; мусор отбрасывается. */
function normalizeMonth(value: unknown): IsoMonth {
  const raw = String(value ?? '').trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(raw)) throw new Error(`finances: invalid month "${String(value)}"`);
  return raw;
}

/** json-массив оплаченных месяцев → массив валидных `YYYY-MM`. */
function parseMonthList(value: unknown): IsoMonth[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.trim() === '') return [];
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: IsoMonth[] = [];
  for (const item of parsed) {
    const month = String(item ?? '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month) && !out.includes(month)) out.push(month);
  }
  return out;
}

/**
 * Идентификатор группы перевода: uuid v4-подобная строка.
 *
 * Формат прежний, но случайная часть — только из платформенного CSPRNG.
 * Раньше здесь был псевдослучайный генератор плюс process-local счётчик: два
 * изолята с одинаковым `Date.now()` выдавали один и тот же id, и группы
 * склеивались.
 */
function randomHex(length: number): string {
  return bytesToHex(randomBytes(Math.ceil(length / 2))).slice(0, length);
}

/** Экспортирован для теста изолят-безопасности: два инстанса модуля не должны совпасть. */
export function newGroupId(): string {
  const stamp = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-a${randomHex(3)}-${stamp}${randomHex(4)}`;
}

/** Курсы: переданные вызывающим, иначе из БД — но только если реально нужны. */
async function resolveRates(needsFx: boolean, rates?: RateTable): Promise<RateTable> {
  if (rates) return rates;
  return needsFx ? getRates() : {};
}

function needsFxTable(...currencies: readonly CurrencyCode[]): boolean {
  return currencies.some((currency) => normalizeCurrency(currency) !== BASE_CURRENCY);
}

// ---------------------------------------------------------------------------
// Счета
// ---------------------------------------------------------------------------

interface AccountDbRow {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  initial_balance_cents: number;
  current_balance_cents: number;
  envelope: string | null;
  is_active: number | boolean | null;
  created_at: string | null;
}

/** Конверт счёта: всё, что не `reserved` — `spendable` (дефолт схемы). */
function normalizeEnvelope(value: unknown): AccountEnvelope {
  return value === 'reserved' ? 'reserved' : 'spendable';
}

function mapAccount(row: AccountDbRow): AccountRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    currency: row.currency,
    initialBalanceCents: Number(row.initial_balance_cents),
    currentBalanceCents: Number(row.current_balance_cents),
    envelope: normalizeEnvelope(row.envelope),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at ?? null,
  };
}

const ACCOUNT_COLUMNS = sql.raw(
  'id, user_id, name, currency, initial_balance_cents, current_balance_cents, envelope, is_active, created_at',
);

/** Счёт-сид: дефолтные счета задаёт вызывающий, в коде их нет (ADDENDUM §B). */
export interface AccountSeed {
  name: string;
  currency?: CurrencyCode;
  initialBalanceCents?: Cents;
  /** Конверт для расчёта ранвея: свободные деньги или уже распределённые. */
  envelope?: AccountEnvelope;
}

/**
 * Идемпотентно создаёт счета из `seed` (уникальность `user_id+name+currency`) и
 * возвращает ВСЕ счета юзера, включая ранее созданные.
 */
export async function ensureAccounts(
  userId: number,
  seed: readonly AccountSeed[] = [],
): Promise<AccountRow[]> {
  const uid = assertUserId(userId);

  await withTransaction(async () => {
    for (const item of seed) {
      const name = String(item.name ?? '').trim();
      if (!name) throw new Error('finances.ensureAccounts: account name is required');
      const currency = normalizeCurrency(item.currency ?? BASE_CURRENCY);
      const initial = assertCents(item.initialBalanceCents ?? 0, 'ensureAccounts.initialBalanceCents');
      const envelope = normalizeEnvelope(item.envelope);

      await db.run(sql`
        INSERT INTO accounts
          (user_id, name, currency, initial_balance_cents, current_balance_cents, envelope, is_active, created_at)
        VALUES (${uid}, ${name}, ${currency}, ${initial}, ${initial}, ${envelope}, 1, ${nowIso()})
        ON CONFLICT DO NOTHING
      `);
    }
  });

  return listAccounts(uid, { includeInactive: true });
}

export interface ListAccountsOptions {
  includeInactive?: boolean;
}

export async function listAccounts(
  userId: number,
  options: ListAccountsOptions = {},
): Promise<AccountRow[]> {
  const uid = assertUserId(userId);
  const conditions: Sql[] = [sql`user_id = ${uid}`];
  if (!options.includeInactive) conditions.push(sql`is_active = 1`);

  const rows = await db.all<AccountDbRow>(sql`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE ${andAll(conditions)}
    ORDER BY name COLLATE NOCASE ASC, id ASC
  `);
  return rows.map(mapAccount);
}

export async function getAccount(userId: number, accountId: number): Promise<AccountRow | null> {
  const uid = assertUserId(userId);
  const row = await db.get<AccountDbRow>(sql`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE id = ${accountId} AND user_id = ${uid}
    LIMIT 1
  `);
  return row ? mapAccount(row) : null;
}

/** Опции поиска счёта. */
export interface AccountLookupOptions {
  /**
   * Разрешить обратное вхождение: имя счёта внутри запрошенной строки.
   *
   * Нужно только фото: банковский экран печатает «Exchange Card *7732», а счёт
   * называется «Exchange». Для текста и голоса опция выключена — там поведение
   * обязано остаться прежним.
   */
  loose?: boolean;
}

/**
 * Кандидаты поиска счёта в порядке приоритета: точное совпадение с валютой,
 * точное без валюты, «содержит» (как `resolve_account` в upstream), а с
 * `loose` — ещё и имя счёта внутри запрошенной строки.
 *
 * Возвращает все строки первого непустого уровня, а не первую попавшуюся:
 * там, где догадка недопустима (фото), решение принимается по размеру списка.
 */
export async function findAccountCandidates(
  userId: number,
  name: string,
  currency?: CurrencyCode,
  options: AccountLookupOptions = {},
): Promise<AccountRow[]> {
  const uid = assertUserId(userId);
  const needle = String(name ?? '').trim();
  if (!needle) return [];

  const order = sql`ORDER BY is_active DESC, current_balance_cents DESC, id ASC`;

  const withCurrency: Sql[] = [sql`user_id = ${uid}`, sql`lower(name) = lower(${needle})`];
  if (currency) withCurrency.push(sql`currency = ${normalizeCurrency(currency)}`);

  const exact = await db.all<AccountDbRow>(sql`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE ${andAll(withCurrency)}
    ${order}
  `);
  if (exact.length > 0) return exact.map(mapAccount);

  const exactAny = await db.all<AccountDbRow>(sql`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE user_id = ${uid} AND lower(name) = lower(${needle})
    ${order}
  `);
  if (exactAny.length > 0) return exactAny.map(mapAccount);

  const contains = await db.all<AccountDbRow>(sql`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE user_id = ${uid} AND lower(name) LIKE ${`%${needle.toLowerCase()}%`}
    ${order}
  `);
  if (contains.length > 0 || !options.loose) return contains.map(mapAccount);

  // Имя счёта внутри напечатанного заголовка: «Exchange Card *7732» → «Exchange».
  // Короткие имена (< 3 символов) не участвуют: «Bank» ещё осмысленно, «Да» нет.
  const all = await listAccounts(uid);
  const haystack = needle.toLowerCase();
  const loose = all.filter((account) => {
    const accountName = account.name.toLowerCase().trim();
    return accountName.length >= 3 && haystack.includes(accountName);
  });
  if (!currency) return loose;
  const wanted = normalizeCurrency(currency);
  // Сначала совпадение по валюте, дальше — прежний порядок `listAccounts`.
  return [...loose.filter((a) => a.currency.toUpperCase() === wanted), ...loose.filter((a) => a.currency.toUpperCase() !== wanted)];
}

/**
 * Поиск счёта по имени: первый кандидат из `findAccountCandidates`.
 *
 * Обёртка сохраняет прежнее поведение текста и голоса байт-в-байт: точное
 * совпадение (с валютой, если она задана), затем точное без валюты, затем
 * «содержит» — как `resolve_account` в upstream.
 */
export async function findAccountByName(
  userId: number,
  name: string,
  currency?: CurrencyCode,
): Promise<AccountRow | null> {
  const [first] = await findAccountCandidates(userId, name, currency);
  return first ?? null;
}

export interface CreateAccountInput {
  name: string;
  currency?: CurrencyCode;
  initialBalanceCents?: Cents;
  /** Конверт для расчёта ранвея; по умолчанию `spendable`. */
  envelope?: AccountEnvelope;
}

export async function createAccount(userId: number, input: CreateAccountInput): Promise<AccountRow> {
  const uid = assertUserId(userId);
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('finances.createAccount: name is required');
  const currency = normalizeCurrency(input.currency ?? BASE_CURRENCY);
  const initial = assertCents(input.initialBalanceCents ?? 0, 'createAccount.initialBalanceCents');
  const envelope = normalizeEnvelope(input.envelope);
  const createdAt = nowIso();

  const result = await db.run(sql`
    INSERT INTO accounts
      (user_id, name, currency, initial_balance_cents, current_balance_cents, envelope, is_active, created_at)
    VALUES (${uid}, ${name}, ${currency}, ${initial}, ${initial}, ${envelope}, 1, ${createdAt})
  `);

  const created = await getAccount(uid, Number(result.lastInsertRowid));
  if (!created) throw new Error('finances.createAccount: failed to read back the created account');
  return created;
}

export interface UpdateAccountInput {
  name?: string;
  /** Перевод счёта между конвертами ранвея. */
  envelope?: AccountEnvelope;
  isActive?: boolean;
}

export async function updateAccount(
  userId: number,
  accountId: number,
  patch: UpdateAccountInput,
): Promise<AccountRow> {
  const uid = assertUserId(userId);
  const assignments: Sql[] = [];

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('finances.updateAccount: name cannot be empty');
    assignments.push(sql`name = ${name}`);
  }
  if (patch.envelope !== undefined) {
    assignments.push(sql`envelope = ${normalizeEnvelope(patch.envelope)}`);
  }
  if (patch.isActive !== undefined) assignments.push(sql`is_active = ${patch.isActive ? 1 : 0}`);

  if (assignments.length > 0) {
    await db.run(sql`
      UPDATE accounts SET ${joinSql(assignments, ', ')}
      WHERE id = ${accountId} AND user_id = ${uid}
    `);
  }

  const updated = await getAccount(uid, accountId);
  if (!updated) throw new Error(`finances.updateAccount: account ${accountId} not found`);
  return updated;
}

/** Ручная правка остатка (инвентаризация). `initial_balance_cents` не меняется. */
export async function setAccountBalance(
  userId: number,
  accountId: number,
  balanceCents: Cents,
): Promise<AccountRow> {
  const uid = assertUserId(userId);
  const balance = assertCents(balanceCents, 'setAccountBalance.balanceCents');
  if (balance < 0) {
    throw new Error(
      `finances.setAccountBalance: баланс не может быть отрицательным (${formatCents(balance)}); ` +
        'минуса на счетах не бывает',
    );
  }

  await db.run(sql`
    UPDATE accounts SET current_balance_cents = ${balance}
    WHERE id = ${accountId} AND user_id = ${uid}
  `);

  const updated = await getAccount(uid, accountId);
  if (!updated) throw new Error(`finances.setAccountBalance: account ${accountId} not found`);
  return updated;
}

/** Удаляет счёт. Счёт с историей операций удалять нельзя — только деактивировать. */
export async function deleteAccount(userId: number, accountId: number): Promise<boolean> {
  const uid = assertUserId(userId);
  const account = await getAccount(uid, accountId);
  if (!account) return false;

  const used = await db.get<{ c: number }>(sql`
    SELECT COUNT(*) AS c FROM transactions
    WHERE user_id = ${uid} AND (account_id = ${accountId} OR to_account_id = ${accountId})
  `);
  if (used && Number(used.c) > 0) {
    throw new Error(
      `finances.deleteAccount: account "${account.name}" has transactions — deactivate it instead`,
    );
  }

  await db.run(sql`DELETE FROM accounts WHERE id = ${accountId} AND user_id = ${uid}`);
  return true;
}

/**
 * Расчётный счёт той же банковской группы: одно имя, валюта `KZT`.
 *
 * У мультивалютной карты с расчётной валютой KZT банк добирает нехватку в
 * валюте субсчёта с KZT по своему курсу. У одиночных счетов такого механизма
 * нет, поэтому `null` — это «добрать неоткуда». Имена и валюты здесь не
 * хардкодятся: группа определяется данными (`name` + `KZT`).
 */
async function findSettlementAccount(
  userId: number,
  account: AccountRow,
): Promise<AccountRow | null> {
  const uid = assertUserId(userId);
  if (normalizeCurrency(account.currency) === 'KZT') return null;

  const row = await db.get<AccountDbRow>(sql`
    SELECT ${ACCOUNT_COLUMNS} FROM accounts
    WHERE user_id = ${uid}
      AND name = ${account.name}
      AND UPPER(currency) = 'KZT'
      AND is_active = 1
      AND id <> ${account.id}
    ORDER BY id ASC
    LIMIT 1
  `);
  return row ? mapAccount(row) : null;
}

/** Итог списания: что ушло со счёта и сколько добрано с расчётного. */
export interface DebitResult {
  /** Списано со счёта (в его валюте), включая добор. */
  debitedCents: Cents;
  /** Сколько реально ушло с исходного счёта (в его валюте). */
  sourceCents: Cents;
  /** Добрано с расчётного счёта (в его валюте), 0 если хватило своих. */
  settlementCents: Cents;
  /** Счёт, с которого добрали, либо `null`. */
  settlementAccount: AccountRow | null;
  /** Фактические дельты по счетам — для компенсации и записи ног. */
  legs: BalanceLeg[];
  /**
   * Сколько суммы не покрыто ни счётом, ни расчётным счётом (в валюте счёта).
   * Больше нуля только при `allowPartial`: расход записывается целиком, а
   * непокрытая разница помечается отдельной строкой, чтобы баланс не ушёл
   * в минус и отмена вернула ровно то, что реально списали.
   */
  uncoveredCents: Cents;
}

/** Почему списание отклонено: добрать неоткуда или на расчётном счёте пусто. */
export type DebitRefusalReason = 'no_settlement' | 'settlement_short';

export interface InsufficientFundsParams {
  message: string;
  reason: DebitRefusalReason;
  accountName: string;
  currency: string;
  /** Сколько нужно списать (в валюте счёта). */
  requiredCents: Cents;
  /** Сколько лежит на счёте (в валюте счёта). */
  availableCents: Cents;
  settlementAccountName: string | null;
  settlementCurrency: string | null;
  /** Сколько нужно добрать с расчётного счёта (в его валюте). */
  settlementRequiredCents: number;
  /** Сколько лежит на расчётном счёте (в его валюте). */
  settlementAvailableCents: number;
}

/**
 * Отказ списания по инварианту «минуса не бывает».
 *
 * Отдельный класс, а не голый `Error`, потому что отказ — это **ответ по
 * существу**, а не сбой инфраструктуры: вызывающая сторона обязана объяснить
 * его пользователю, а не уйти в fallback. Раньше `smartIngest` ловил любую
 * ошибку финансового fast-path и складывал сообщение в инбокс: трата, которую
 * провести не смогли, превращалась в заметку без единого слова о том, что
 * расход не записан.
 */
export class InsufficientFundsError extends Error {
  readonly reason: DebitRefusalReason;
  readonly accountName: string;
  readonly currency: string;
  readonly requiredCents: Cents;
  readonly availableCents: Cents;
  readonly settlementAccountName: string | null;
  readonly settlementCurrency: string | null;
  readonly settlementRequiredCents: number;
  readonly settlementAvailableCents: number;

  constructor(params: InsufficientFundsParams) {
    super(params.message);
    this.name = 'InsufficientFundsError';
    this.reason = params.reason;
    this.accountName = params.accountName;
    this.currency = params.currency;
    this.requiredCents = params.requiredCents;
    this.availableCents = params.availableCents;
    this.settlementAccountName = params.settlementAccountName;
    this.settlementCurrency = params.settlementCurrency;
    this.settlementRequiredCents = params.settlementRequiredCents;
    this.settlementAvailableCents = params.settlementAvailableCents;
  }
}

/**
 * Проверка по `name`, а не только по `instanceof`: tgcloud грузит модули
 * по отдельности, и один и тот же класс может прийти из другой копии модуля.
 */
export function isInsufficientFundsError(error: unknown): error is InsufficientFundsError {
  return error instanceof Error && error.name === 'InsufficientFundsError';
}

/**
 * Списывает деньги со счёта, **не допуская отрицательного остатка**.
 *
 * Инвариант (правило владельца, 13.11.2026): минуса на счетах не бывает.
 * Если на валютном субсчёте группы не хватает, разница добирается с KZT
 * того же банка по курсу из `fx_rates` (как это делает сам банк). Если
 * расчётного счёта нет или и на нём не хватает — операция отклоняется с
 * понятной ошибкой; молча уйти в минус нельзя.
 *
 * `allowPartial` (правило владельца, 13.11.2026, вечер): расход — это факт,
 * его нельзя терять из-за того, что книга отстала от банка. Тогда списывается
 * всё, что есть, а непокрытая разница возвращается в `uncoveredCents`, чтобы
 * вызывающая сторона записала её отдельной строкой. Перевод и обмен так не
 * умеют: отправить деньги, которых нет, нельзя, и они по-прежнему отказывают.
 */
export async function debitWithSettlement(
  userId: number,
  account: AccountRow,
  centsInAccountCurrency: Cents,
  rates: RateTable,
  options: { allowPartial?: boolean } = {},
): Promise<DebitResult> {
  const uid = assertUserId(userId);
  const amount = assertPositiveCents(centsInAccountCurrency, 'debitWithSettlement.amountCents');
  const balance = Math.max(0, account.currentBalanceCents);
  // Дельты, уже применённые к балансам этим вызовом. Если сбой случится после
  // них, вызывающая сторона о них не узнает: она получит исключение вместо
  // результата и не сможет ничего компенсировать. Поэтому списание откатывает
  // себя само (правило владельца: деньги не должны исчезать из-за полушага).
  const applied: BalanceLeg[] = [];

  try {
    return await applyDebit(
      uid,
      account,
      amount,
      balance,
      rates,
      applied,
      options.allowPartial === true,
    );
  } catch (error) {
    await revertBalanceLegs(uid, applied);
    throw error;
  }
}

/** Тело `debitWithSettlement`: двигает балансы и наполняет книгу `applied`. */
async function applyDebit(
  uid: number,
  account: AccountRow,
  amount: Cents,
  balance: Cents,
  rates: RateTable,
  applied: BalanceLeg[],
  allowPartial: boolean,
): Promise<DebitResult> {
  if (balance >= amount) {
    await applyBalanceDelta(uid, account.id, -amount, applied);
    return {
      debitedCents: amount,
      sourceCents: amount,
      settlementCents: 0,
      settlementAccount: null,
      legs: [{ accountId: account.id, deltaCents: -amount }],
      uncoveredCents: 0,
    };
  }

  const shortfall = amount - balance;
  const settlement = await findSettlementAccount(uid, account);
  if (!settlement) {
    if (allowPartial) {
      // Расход проводим, но только на то, что есть: минуса не бывает, а
      // недостача уходит отдельной строкой и озвучивается в ответе.
      if (balance > 0) await applyBalanceDelta(uid, account.id, -balance, applied);
      return {
        debitedCents: balance,
        sourceCents: balance,
        settlementCents: 0,
        settlementAccount: null,
        legs: [...applied],
        uncoveredCents: amount - balance,
      };
    }
    throw new InsufficientFundsError({
      message:
        `на счёте «${account.name}» (${account.currency}) не хватает денег: ` +
        `нужно ${formatCents(amount)}, есть ${formatCents(balance)}; минуса не бывает, а добрать неоткуда`,
      reason: 'no_settlement',
      accountName: account.name,
      currency: account.currency,
      requiredCents: amount,
      availableCents: balance,
      settlementAccountName: null,
      settlementCurrency: null,
      settlementRequiredCents: 0,
      settlementAvailableCents: 0,
    });
  }

  // Курсы вызывающего могли не загружаться: транзакция в валюте счёта не
  // требует FX, а добор с KZT требует. Поэтому при нехватке курса читаем таблицу.
  const fxRates =
    hasRate(account.currency, rates) && hasRate(settlement.currency, rates)
      ? rates
      : await getRates();
  const settlementCents = convert(shortfall, account.currency, settlement.currency, fxRates);
  const settlementBalance = Math.max(0, settlement.currentBalanceCents);
  if (settlementBalance < settlementCents) {
    if (allowPartial) {
      if (balance > 0) await applyBalanceDelta(uid, account.id, -balance, applied);
      if (settlementBalance > 0) await applyBalanceDelta(uid, settlement.id, -settlementBalance, applied);

      const coveredFromSettlement = convert(
        settlementBalance,
        settlement.currency,
        account.currency,
        fxRates,
      );
      const refreshedPartial = await getAccount(uid, settlement.id);

      return {
        debitedCents: balance + coveredFromSettlement,
        sourceCents: balance,
        settlementCents: settlementBalance,
        settlementAccount: refreshedPartial ?? settlement,
        legs: [...applied],
        uncoveredCents: Math.max(0, amount - balance - coveredFromSettlement),
      };
    }
    throw new InsufficientFundsError({
      message:
        `на счёте «${account.name}» (${account.currency}) не хватает ${formatCents(shortfall)}, ` +
        `а на «${settlement.name}» (${settlement.currency}) только ${formatCents(settlementBalance)} — ` +
        `нужно добрать ${formatCents(settlementCents)}; минуса не бывает`,
      reason: 'settlement_short',
      accountName: account.name,
      currency: account.currency,
      requiredCents: amount,
      availableCents: balance,
      settlementAccountName: settlement.name,
      settlementCurrency: settlement.currency,
      settlementRequiredCents: settlementCents,
      settlementAvailableCents: settlementBalance,
    });
  }

  if (balance > 0) await applyBalanceDelta(uid, account.id, -balance, applied);
  await applyBalanceDelta(uid, settlement.id, -settlementCents, applied);

  const refreshed = await getAccount(uid, settlement.id);

  return {
    debitedCents: amount,
    sourceCents: balance,
    settlementCents,
    settlementAccount: refreshed ?? settlement,
    legs: [...applied],
    uncoveredCents: 0,
  };
}

/** Движение остатка счёта: на сколько и где сдвинули баланс. */
export interface BalanceLeg {
  accountId: number;
  /** Дельта в валюте счёта. */
  deltaCents: Cents;
}

/** Книга компенсации: сюда попадает всё, что уже применено. */
export interface CompensationBook {
  /** Двигает баланс и запоминает дельту для возможного отката. */
  apply(accountId: number, deltaCents: Cents): Promise<AccountRow>;
  /** Принимает дельты, применённые чужим кодом (например, `debitWithSettlement`). */
  adopt(legs: readonly BalanceLeg[]): void;
}

/**
 * Запись, безопасная **без** `BEGIN`.
 *
 * tgcloud блокирует явный `BEGIN` (SQLite authorizer, error 23), поэтому
 * `withTransaction` там вырождается в простой вызов. Единственный способ не
 * оставить полусостояние — сначала двигать балансы и только потом писать
 * строки, а при любом сбое вернуть балансы назад и удалить строки группы.
 *
 * Внутри настоящей транзакции (локальный SQLite) компенсация избыточна, но
 * безвредна: `ROLLBACK` отменяет и её.
 */
export async function withBalanceCompensation<T>(
  userId: number,
  groupId: string,
  run: (book: CompensationBook) => Promise<T>,
): Promise<T> {
  const uid = assertUserId(userId);
  const legs: BalanceLeg[] = [];

  const book: CompensationBook = {
    apply: async (accountId, deltaCents) => {
      const account = await applyBalanceDelta(uid, accountId, deltaCents, legs);
      return account;
    },
    adopt: (applied) => {
      for (const leg of applied) {
        if (leg.deltaCents !== 0) legs.push({ accountId: leg.accountId, deltaCents: leg.deltaCents });
      }
    },
  };

  try {
    return await run(book);
  } catch (error) {
    // Строки — первыми: они ссылаются на счета, балансы которых сейчас вернём.
    try {
      await db.run(sql`
        DELETE FROM transactions
        WHERE user_id = ${uid} AND transfer_group_id = ${groupId}
      `);
    } catch (cleanupError) {
      console.warn('finances: не удалось удалить незавершённую группу', cleanupError);
    }
    await revertBalanceLegs(uid, legs);
    throw error;
  }
}

/** Возвращает применённые дельты в обратном порядке; сбой отката не скрывает причину. */
async function revertBalanceLegs(uid: number, legs: readonly BalanceLeg[]): Promise<void> {
  for (const leg of [...legs].reverse()) {
    try {
      await applyBalanceDelta(uid, leg.accountId, -leg.deltaCents);
    } catch (compensationError) {
      console.warn('finances: не удалось вернуть баланс счёта', leg.accountId, compensationError);
    }
  }
}

/**
 * Двигает остаток счёта на дельту (в валюте счёта) и возвращает свежий счёт.
 *
 * Если передан `applied`, дельта попадает туда сразу после успешного `UPDATE` —
 * до перечитывания счёта. Так сбой чтения после записи тоже компенсируется,
 * а не оставляет деньги списанными без записи.
 */
async function applyBalanceDelta(
  userId: number,
  accountId: number,
  deltaCents: Cents,
  applied?: BalanceLeg[],
): Promise<AccountRow> {
  const uid = assertUserId(userId);
  if (deltaCents !== 0) {
    await db.run(sql`
      UPDATE accounts
      SET current_balance_cents = current_balance_cents + ${deltaCents}
      WHERE id = ${accountId} AND user_id = ${uid}
    `);
    applied?.push({ accountId, deltaCents });
  }
  const account = await getAccount(uid, accountId);
  if (!account) throw new Error(`finances: account ${accountId} not found after balance update`);
  return account;
}

// ---------------------------------------------------------------------------
// Категории финансов
// ---------------------------------------------------------------------------

interface FinCategoryDbRow {
  id: number;
  user_id: number;
  name: string;
  kind: string;
  icon: string | null;
  created_at: string | null;
}

function mapFinCategory(row: FinCategoryDbRow): FinCategoryRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    kind: row.kind as FinCategoryKind,
    icon: row.icon ?? null,
    createdAt: row.created_at ?? null,
  };
}

const FIN_CATEGORY_COLUMNS = sql.raw('id, user_id, name, kind, icon, created_at');

function assertCategoryKind(kind: string): FinCategoryKind {
  if (kind !== 'expense' && kind !== 'income') {
    throw new Error(`finances: invalid category kind "${kind}"`);
  }
  return kind;
}

export async function listCategories(
  userId: number,
  kind?: FinCategoryKind,
): Promise<FinCategoryRow[]> {
  const uid = assertUserId(userId);
  const conditions: Sql[] = [sql`user_id = ${uid}`];
  if (kind) conditions.push(sql`kind = ${assertCategoryKind(kind)}`);

  const rows = await db.all<FinCategoryDbRow>(sql`
    SELECT ${FIN_CATEGORY_COLUMNS} FROM fin_categories
    WHERE ${andAll(conditions)}
    ORDER BY name COLLATE NOCASE ASC, id ASC
  `);
  return rows.map(mapFinCategory);
}

export async function getCategory(
  userId: number,
  categoryId: number,
): Promise<FinCategoryRow | null> {
  const uid = assertUserId(userId);
  const row = await db.get<FinCategoryDbRow>(sql`
    SELECT ${FIN_CATEGORY_COLUMNS} FROM fin_categories
    WHERE id = ${categoryId} AND user_id = ${uid}
    LIMIT 1
  `);
  return row ? mapFinCategory(row) : null;
}

export async function findCategoryByName(
  userId: number,
  name: string,
  kind?: FinCategoryKind,
): Promise<FinCategoryRow | null> {
  const uid = assertUserId(userId);
  const needle = String(name ?? '').trim();
  if (!needle) return null;

  const conditions: Sql[] = [sql`user_id = ${uid}`, sql`lower(name) = lower(${needle})`];
  if (kind) conditions.push(sql`kind = ${assertCategoryKind(kind)}`);

  const row = await db.get<FinCategoryDbRow>(sql`
    SELECT ${FIN_CATEGORY_COLUMNS} FROM fin_categories
    WHERE ${andAll(conditions)}
    ORDER BY id ASC
    LIMIT 1
  `);
  return row ? mapFinCategory(row) : null;
}

export interface CreateCategoryInput {
  name: string;
  kind?: FinCategoryKind;
  icon?: string | null;
}

export async function createCategory(
  userId: number,
  input: CreateCategoryInput,
): Promise<FinCategoryRow> {
  const uid = assertUserId(userId);
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('finances.createCategory: name is required');
  const kind = assertCategoryKind(input.kind ?? 'expense');

  const result = await db.run(sql`
    INSERT INTO fin_categories (user_id, name, kind, icon, created_at)
    VALUES (${uid}, ${name}, ${kind}, ${input.icon ?? null}, ${nowIso()})
  `);

  const created = await getCategory(uid, Number(result.lastInsertRowid));
  if (!created) throw new Error('finances.createCategory: failed to read back the created category');
  return created;
}

/** Get-or-create по `lower(name) + kind` (как `ensure_accounts_and_categories`). */
export async function ensureCategory(
  userId: number,
  name: string,
  kind: FinCategoryKind = 'expense',
  icon?: string | null,
): Promise<FinCategoryRow> {
  const uid = assertUserId(userId);
  const existing = await findCategoryByName(uid, name, kind);
  if (existing) return existing;
  try {
    return await createCategory(uid, { name, kind, icon });
  } catch (error) {
    // гонка двух параллельных вставок: категория могла уже появиться
    const raced = await findCategoryByName(uid, name, kind);
    if (raced) return raced;
    throw error;
  }
}

export interface UpdateCategoryInput {
  name?: string;
  icon?: string | null;
}

export async function updateCategory(
  userId: number,
  categoryId: number,
  patch: UpdateCategoryInput,
): Promise<FinCategoryRow> {
  const uid = assertUserId(userId);
  const assignments: Sql[] = [];

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('finances.updateCategory: name cannot be empty');
    assignments.push(sql`name = ${name}`);
  }
  if (patch.icon !== undefined) assignments.push(sql`icon = ${patch.icon}`);

  if (assignments.length > 0) {
    await db.run(sql`
      UPDATE fin_categories SET ${joinSql(assignments, ', ')}
      WHERE id = ${categoryId} AND user_id = ${uid}
    `);
  }

  const updated = await getCategory(uid, categoryId);
  if (!updated) throw new Error(`finances.updateCategory: category ${categoryId} not found`);
  return updated;
}

/** Считает количество транзакций и бюджетов, использующих финансовую категорию. */
export async function countCategoryUsage(
  userId: number,
  categoryId: number,
): Promise<{ transactions: number; budgets: number }> {
  const uid = assertUserId(userId);
  const row = await db.get<{ tx_count: number; b_count: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM transactions WHERE user_id = ${uid} AND category_id = ${categoryId}) AS tx_count,
      (SELECT COUNT(*) FROM budgets WHERE user_id = ${uid} AND category_id = ${categoryId}) AS b_count
  `);
  return {
    transactions: Number(row?.tx_count ?? 0),
    budgets: Number(row?.b_count ?? 0),
  };
}

/**
 * Удаляет финансовую категорию. По умолчанию бросает, если категория используется;
 * при `options.unlink = true` отвязывает транзакции (`category_id = NULL`) и удаляет бюджеты категории.
 */
export async function deleteCategory(
  userId: number,
  categoryId: number,
  options?: { unlink?: boolean },
): Promise<boolean> {
  const uid = assertUserId(userId);
  const category = await getCategory(uid, categoryId);
  if (!category) return false;

  if (options?.unlink === true) {
    return withTransaction(async () => {
      await db.run(sql`
        UPDATE transactions SET category_id = NULL
        WHERE user_id = ${uid} AND category_id = ${categoryId}
      `);
      await db.run(sql`
        DELETE FROM budgets WHERE user_id = ${uid} AND category_id = ${categoryId}
      `);
      await db.run(sql`DELETE FROM fin_categories WHERE id = ${categoryId} AND user_id = ${uid}`);
      return true;
    });
  }

  const used = await db.get<{ c: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM transactions WHERE user_id = ${uid} AND category_id = ${categoryId})
      + (SELECT COUNT(*) FROM budgets WHERE user_id = ${uid} AND category_id = ${categoryId}) AS c
  `);
  if (used && Number(used.c) > 0) {
    throw new Error(
      `finances.deleteCategory: category "${category.name}" is in use — rename or deactivate it instead`,
    );
  }

  await db.run(sql`DELETE FROM fin_categories WHERE id = ${categoryId} AND user_id = ${uid}`);
  return true;
}

// ---------------------------------------------------------------------------
// Транзакции
// ---------------------------------------------------------------------------

interface TransactionDbRow {
  id: number;
  user_id: number;
  kind: string;
  account_id: number;
  to_account_id: number | null;
  amount_cents: number;
  currency: string;
  fx_rate: number;
  amount_eur_cents: number;
  category_id: number | null;
  description: string | null;
  occurred_at: string;
  transfer_group_id: string | null;
  receipt_file_id: string | null;
  raw_text: string | null;
  created_at: string | null;
}

function mapTransaction(row: TransactionDbRow): TransactionRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    kind: row.kind as TransactionKind,
    accountId: Number(row.account_id),
    toAccountId: row.to_account_id === null ? null : Number(row.to_account_id),
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    fxRate: Number(row.fx_rate),
    amountEurCents: Number(row.amount_eur_cents),
    categoryId: row.category_id === null ? null : Number(row.category_id),
    description: row.description ?? null,
    occurredAt: row.occurred_at,
    transferGroupId: row.transfer_group_id ?? null,
    receiptFileId: row.receipt_file_id ?? null,
    rawText: row.raw_text ?? null,
    createdAt: row.created_at ?? null,
  };
}

const TRANSACTION_COLUMNS = sql.raw(
  'id, user_id, kind, account_id, to_account_id, amount_cents, currency, fx_rate, amount_eur_cents, ' +
    'category_id, description, occurred_at, transfer_group_id, receipt_file_id, raw_text, created_at',
);

/** Полностью разрешённые поля вставки — баланс двигает вызывающий. */
interface TransactionInsert {
  kind: TransactionKind;
  accountId: number;
  toAccountId?: number | null;
  amountCents: Cents;
  currency: CurrencyCode;
  fxRate: number;
  amountEurCents: Cents;
  categoryId?: number | null;
  description?: string | null;
  occurredAt: string;
  transferGroupId?: string | null;
  receiptFileId?: string | null;
  rawText?: string | null;
}

async function insertTransactionRow(
  userId: number,
  values: TransactionInsert,
): Promise<TransactionRow> {
  const uid = assertUserId(userId);
  const result = await db.run(sql`
    INSERT INTO transactions (
      user_id, kind, account_id, to_account_id, amount_cents, currency, fx_rate, amount_eur_cents,
      category_id, description, occurred_at, transfer_group_id, receipt_file_id, raw_text, created_at
    ) VALUES (
      ${uid}, ${values.kind}, ${values.accountId}, ${values.toAccountId ?? null},
      ${values.amountCents}, ${values.currency}, ${values.fxRate}, ${values.amountEurCents},
      ${values.categoryId ?? null}, ${values.description ?? null}, ${values.occurredAt},
      ${values.transferGroupId ?? null}, ${values.receiptFileId ?? null},
      ${values.rawText ?? null}, ${nowIso()}
    )
  `);

  const created = await getTransaction(uid, Number(result.lastInsertRowid));
  if (!created) throw new Error('finances: failed to read back the created transaction');
  return created;
}

export interface CreateTransactionInput {
  kind: TransactionKind;
  amountCents: Cents;
  /** Валюта операции; по умолчанию — валюта счёта. */
  currency?: CurrencyCode;
  accountId?: number;
  accountName?: string;
  toAccountId?: number;
  toAccountName?: string;
  categoryId?: number | null;
  categoryName?: string;
  description?: string | null;
  occurredAt?: IsoDate | Date | null;
  receiptFileId?: string | null;
  rawText?: string | null;
  /** Готовая таблица курсов; без неё курсы берутся из `fx_rates`. */
  rates?: RateTable;
}

async function resolveAccountOrThrow(
  userId: number,
  accountId: number | undefined,
  accountName: string | undefined,
  currency?: CurrencyCode,
): Promise<AccountRow> {
  let account: AccountRow | null = null;
  if (accountId !== undefined) account = await getAccount(userId, accountId);
  else if (accountName) account = await findAccountByName(userId, accountName, currency);

  if (!account) {
    const hint = accountName ? ` "${accountName}"` : accountId !== undefined ? ` #${accountId}` : '';
    throw new Error(`finances: account not found${hint}`);
  }
  return account;
}

/**
 * Записывает расход/доход/перевод и двигает балансы.
 * Возвращает созданную строку транзакции (для перевода — одну, с `to_account_id`).
 */
export async function createTransaction(
  userId: number,
  input: CreateTransactionInput,
): Promise<TransactionRow> {
  const uid = assertUserId(userId);
  const { kind } = input;
  if (kind !== 'expense' && kind !== 'income' && kind !== 'transfer') {
    throw new Error(`finances.createTransaction: invalid kind "${String(kind)}"`);
  }
  const amount = assertPositiveCents(input.amountCents, 'createTransaction.amountCents');

  return withTransaction(async () => {
    const account = await resolveAccountOrThrow(uid, input.accountId, input.accountName, input.currency);
    const currency = normalizeCurrency(input.currency ?? account.currency);
    const rates = await resolveRates(
      needsFxTable(currency, account.currency),
      input.rates,
    );

    const amountEurCents = convert(amount, currency, BASE_CURRENCY, rates);
    const fxRate = round(amountEurCents / amount, 6);
    const occurredAt = toTimestamp(input.occurredAt);

    if (kind === 'transfer') {
      let target: AccountRow | null = null;
      if (input.toAccountId !== undefined) target = await getAccount(uid, input.toAccountId);
      else if (input.toAccountName) target = await findAccountByName(uid, input.toAccountName, currency);

      if (!target) {
        throw new Error('finances.createTransaction: transfer target account not found');
      }
      if (target.id === account.id) {
        throw new Error('finances.createTransaction: transfer target must differ from the source');
      }
      if (normalizeCurrency(target.currency) !== currency) {
        throw new Error(
          `finances.createTransaction: transfer requires the same currency (${currency} → ${target.currency})`,
        );
      }

      const transferGroupId = newGroupId();
      const created = await insertTransactionRow(uid, {
        kind: 'transfer',
        accountId: account.id,
        toAccountId: target.id,
        amountCents: amount,
        currency,
        fxRate,
        amountEurCents,
        description: input.description ?? `Transfer to ${target.name}`,
        occurredAt,
        transferGroupId,
        receiptFileId: input.receiptFileId ?? null,
        rawText: input.rawText ?? null,
      });

      const delta = convert(amount, currency, account.currency, rates);
      const credit = convert(amount, currency, target.currency, rates);
      // Источник списывается через тот же страж, что и расход: минуса не бывает,
      // нехватку в валюте субсчёта добирает расчётный счёт (KZT).
      //
      // На tgcloud нет BEGIN (`withTransaction` деградирует в простой вызов),
      // поэтому строка уже в базе, и откат здесь ручной: списание возвращаем,
      // строку снимаем. Иначе отказ оставляет перевод-призрак в отчётах.
      let debit: DebitResult | null = null;
      try {
        debit = await debitWithSettlement(uid, account, delta, rates);
        await applyBalanceDelta(uid, target.id, credit);
      } catch (error) {
        if (debit) await revertBalanceLegs(uid, debit.legs);
        await deleteTransactionRow(uid, created.id);
        throw error;
      }
      return created;
    }

    // expense / income: категория обязательна только если её передали
    let categoryId: number | null = input.categoryId ?? null;
    if (categoryId !== null) {
      const category = await getCategory(uid, categoryId);
      if (!category) throw new Error(`finances.createTransaction: category ${categoryId} not found`);
      if (category.kind !== kind) {
        throw new Error(
          `finances.createTransaction: category "${category.name}" is ${category.kind}, not ${kind}`,
        );
      }
    } else if (input.categoryName && input.categoryName.trim()) {
      const category = await ensureCategory(uid, input.categoryName, kind);
      categoryId = category.id;
    }

    const delta = convert(amount, currency, account.currency, rates);
    const created = await insertTransactionRow(uid, {
      kind,
      accountId: account.id,
      amountCents: amount,
      currency,
      fxRate,
      amountEurCents,
      categoryId,
      description: input.description ?? null,
      occurredAt,
      receiptFileId: input.receiptFileId ?? null,
      rawText: input.rawText ?? null,
    });

    if (kind === 'expense') {
      // Инвариант: минуса на счетах не бывает. Нехватку в валюте субсчёта
      // Расчётный счёт группы добирает нехватку с KZT; у остальных списание отклоняется.
      //
      // Строка уже записана (на tgcloud BEGIN заблокирован), а списание может
      // быть отклонено. Возврат балансов делает `debitWithSettlement` сам, но
      // строку нужно снять здесь: 13.11.2026 четыре отказа по 100 € оставили в
      // книге четыре расхода, которых не было — отчёты показывали 792,05 €
      // вместо 392,05 €.
      let debit;
      try {
        // Расход — факт: проводим его, даже если книга отстала от банка.
        debit = await debitWithSettlement(uid, account, delta, rates, { allowPartial: true });
      } catch (error) {
        await deleteTransactionRow(uid, created.id);
        throw error;
      }

      if (debit.uncoveredCents > 0) {
        // Недокрытие: расход остаётся записью на полную сумму, а реальное
        // движение денег лежит отдельными служебными строками той же группы.
        // Так баланс не уходит в минус, а отмена вернёт ровно списанное.
        const groupId = newGroupId();
        await db.run(sql`
          UPDATE transactions SET transfer_group_id = ${groupId}
          WHERE id = ${created.id} AND user_id = ${uid}
        `);

        const movement: Array<{ accountId: number; cents: Cents; currency: CurrencyCode }> = [];
        if (debit.sourceCents > 0) {
          movement.push({ accountId: account.id, cents: debit.sourceCents, currency: account.currency });
        }
        if (debit.settlementCents > 0 && debit.settlementAccount) {
          movement.push({
            accountId: debit.settlementAccount.id,
            cents: debit.settlementCents,
            currency: debit.settlementAccount.currency,
          });
        }

        for (const leg of movement) {
          // Курс ноги считается отдельно: движения бывают в валюте расчётного
          // счёта (KZT), которой в таблице вызывающего может не быть.
          const legRates = await resolveRates(needsFxTable(leg.currency), input.rates);
          const legEurCents = convert(leg.cents, leg.currency, BASE_CURRENCY, legRates);
          await insertTransactionRow(uid, {
            kind: 'adjustment',
            accountId: leg.accountId,
            amountCents: -leg.cents,
            currency: leg.currency,
            fxRate: round(legEurCents / leg.cents, 6),
            amountEurCents: -legEurCents,
            categoryId: null,
            description: `Списание по расходу без покрытия: ${account.name} (${account.currency})`,
            occurredAt,
            transferGroupId: groupId,
          });
        }

        created.transferGroupId = groupId;
        created.uncoveredCents = debit.uncoveredCents;
      }
    } else {
      await applyBalanceDelta(uid, account.id, delta);
    }
    return created;
  });
}

export interface CreateExchangeInput {
  fromAccountId?: number;
  fromAccountName?: string;
  fromCents: Cents;
  fromCurrency?: CurrencyCode;
  toAccountId?: number;
  toAccountName?: string;
  toCents: Cents;
  toCurrency?: CurrencyCode;
  occurredAt?: IsoDate | Date | null;
  description?: string | null;
  rawText?: string | null;
  /** Готовая таблица курсов; без неё курсы берутся из `fx_rates`. */
  rates?: RateTable;
}

/**
 * Пометка технической ноги добора с расчётного счёта. Нужна потребителям
 * группы: в отмене и в истории основной парой считаются только исходящая и
 * входящая ноги, а не строки добора.
 */
export const EXCHANGE_TOPUP_SUFFIX = ' (добор)';

export interface CreateExchangeResult {
  out: TransactionRow;
  in: TransactionRow;
  groupId: string;
}

/**
 * Записывает обмен как **две** строки `kind='exchange'` с общим `transfer_group_id`:
 * исходящую (`amount_cents` отрицательный) и входящую (положительный).
 *
 * Знак — единственный маркер направления, который понимает существующая отмена
 * группы (`-amountCents` возвращает ровно противоположное). Источник списывается
 * через `debitWithSettlement`, поэтому обмен подчиняется инварианту «минуса не
 * бывает» и добирает нехватку с KZT так же, как расход.
 */
export async function createExchange(
  userId: number,
  input: CreateExchangeInput,
): Promise<CreateExchangeResult> {
  const uid = assertUserId(userId);
  const fromCents = assertPositiveCents(input.fromCents, 'createExchange.fromCents');
  const toCents = assertPositiveCents(input.toCents, 'createExchange.toCents');

  return withTransaction(async () => {
    const from = await resolveAccountOrThrow(
      uid,
      input.fromAccountId,
      input.fromAccountName,
      input.fromCurrency,
    );
    const to = await resolveAccountOrThrow(
      uid,
      input.toAccountId,
      input.toAccountName,
      input.toCurrency,
    );
    if (from.id === to.id) {
      throw new Error('finances.createExchange: source and target accounts must differ');
    }

    const fromCurrency = normalizeCurrency(input.fromCurrency ?? from.currency);
    const toCurrency = normalizeCurrency(input.toCurrency ?? to.currency);
    const rates = await resolveRates(
      needsFxTable(fromCurrency, toCurrency, from.currency, to.currency),
      input.rates,
    );
    const occurredAt = toTimestamp(input.occurredAt);
    const groupId = newGroupId();
    const description = input.description ?? `Exchange ${from.name} → ${to.name}`;

    // Сумма в валюте счёта-источника: именно её списывает `debitWithSettlement`.
    const outCents = convert(fromCents, fromCurrency, from.currency, rates);
    const outEurCents = convert(fromCents, fromCurrency, BASE_CURRENCY, rates);
    const inCents = convert(toCents, toCurrency, to.currency, rates);
    const inEurCents = convert(toCents, toCurrency, BASE_CURRENCY, rates);

    // Порядок важен: сначала все операции по балансам, и только потом строки.
    // На tgcloud нет BEGIN (error 23), поэтому сбой компенсируется вручную.
    return withBalanceCompensation(uid, groupId, async (book) => {
      const debit = await debitWithSettlement(uid, from, outCents, rates);
      book.adopt(debit.legs);
      await book.apply(to.id, inCents);

      // Добор с расчётного счёта (KZT) — это отдельный обмен, поэтому он тоже
      // пишется в группу: тогда `revertGroup` вернёт каждый счёт до копейки.
      const fundedFromSettlement = debit.settlementCents > 0 && debit.settlementAccount !== null;
      const topUpCents = debit.debitedCents - debit.sourceCents;

      const out = await insertTransactionRow(uid, {
        kind: 'exchange',
        accountId: from.id,
        toAccountId: to.id,
        amountCents: -outCents,
        currency: from.currency,
        fxRate: round(outEurCents / outCents, 6),
        amountEurCents: -outEurCents,
        description,
        occurredAt,
        transferGroupId: groupId,
        rawText: input.rawText ?? null,
      });

      if (fundedFromSettlement && debit.settlementAccount && topUpCents > 0) {
        const settlement = debit.settlementAccount;
        const topUpEurCents = convert(topUpCents, from.currency, BASE_CURRENCY, rates);
        const settlementEurCents = convert(
          debit.settlementCents,
          settlement.currency,
          BASE_CURRENCY,
          rates,
        );
        // Возврат добора на счёт-источник: доля исходящей ноги, оплаченная не им.
        await insertTransactionRow(uid, {
          kind: 'exchange',
          accountId: from.id,
          toAccountId: settlement.id,
          amountCents: topUpCents,
          currency: from.currency,
          fxRate: round(topUpEurCents / topUpCents, 6),
          amountEurCents: topUpEurCents,
          description: `${description}${EXCHANGE_TOPUP_SUFFIX}`,
          occurredAt,
          transferGroupId: groupId,
          rawText: input.rawText ?? null,
        });
        // Списание добора с расчётного счёта.
        await insertTransactionRow(uid, {
          kind: 'exchange',
          accountId: settlement.id,
          toAccountId: from.id,
          amountCents: -debit.settlementCents,
          currency: settlement.currency,
          fxRate: round(settlementEurCents / debit.settlementCents, 6),
          amountEurCents: -settlementEurCents,
          description: `${description}${EXCHANGE_TOPUP_SUFFIX}`,
          occurredAt,
          transferGroupId: groupId,
          rawText: input.rawText ?? null,
        });
      }

      const inRow = await insertTransactionRow(uid, {
        kind: 'exchange',
        accountId: to.id,
        toAccountId: from.id,
        amountCents: inCents,
        currency: to.currency,
        fxRate: round(inEurCents / inCents, 6),
        amountEurCents: inEurCents,
        description,
        occurredAt,
        transferGroupId: groupId,
        rawText: input.rawText ?? null,
      });

      return { out, in: inRow, groupId };
    });
  });
}

export async function getTransaction(
  userId: number,
  transactionId: number,
): Promise<TransactionRow | null> {
  const uid = assertUserId(userId);
  const row = await db.get<TransactionDbRow>(sql`
    SELECT ${TRANSACTION_COLUMNS} FROM transactions
    WHERE id = ${transactionId} AND user_id = ${uid}
    LIMIT 1
  `);
  return row ? mapTransaction(row) : null;
}

export interface TransactionFilter {
  /** Нижняя граница по `occurred_at` (включительно). */
  from?: IsoDate | Date | null;
  /** Верхняя граница по `occurred_at` (включительно, до конца дня). */
  to?: IsoDate | Date | null;
  kind?: TransactionKind;
  categoryId?: number;
  accountId?: number;
  limit?: number;
  offset?: number;
}

export async function listTransactions(
  userId: number,
  filter: TransactionFilter = {},
): Promise<TransactionRow[]> {
  const uid = assertUserId(userId);
  const conditions: Sql[] = [sql`user_id = ${uid}`];

  if (filter.from) conditions.push(sql`occurred_at >= ${toTimestamp(filter.from)}`);
  if (filter.to) {
    const until = `${toTimestamp(filter.to).slice(0, 10)}T23:59:59.999Z`;
    conditions.push(sql`occurred_at <= ${until}`);
  }
  if (filter.kind) conditions.push(sql`kind = ${filter.kind}`);
  if (filter.categoryId !== undefined) conditions.push(sql`category_id = ${filter.categoryId}`);
  if (filter.accountId !== undefined) {
    conditions.push(sql`(account_id = ${filter.accountId} OR to_account_id = ${filter.accountId})`);
  }

  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);

  const rows = await db.all<TransactionDbRow>(sql`
    SELECT ${TRANSACTION_COLUMNS} FROM transactions
    WHERE ${andAll(conditions)}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map(mapTransaction);
}

export interface UndoOptions {
  accountId?: number;
  accountName?: string;
}

/**
 * Последняя операция по `created_at`/`id` — та же выборка, что отменяет
 * `undoLastTransaction`. Компенсация недокрытия (`adjustment`) — служебная
 * строка: последняя операция для владельца — сам расход, поэтому вместо неё
 * возвращаем строку расхода из той же группы. Иначе и отмена, и правка
 * предлагали бы служебную запись.
 */
async function selectLastTransaction(
  uid: number,
  accountFilterId: number | null,
): Promise<TransactionRow | null> {
  const conditions: Sql[] = [sql`user_id = ${uid}`];
  if (accountFilterId !== null) {
    conditions.push(sql`(account_id = ${accountFilterId} OR to_account_id = ${accountFilterId})`);
  }

  const row = await db.get<TransactionDbRow>(sql`
    SELECT ${TRANSACTION_COLUMNS} FROM transactions
    WHERE ${andAll(conditions)}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  if (!row) return null;

  const transaction = mapTransaction(row);
  if (transaction.kind === 'adjustment' && transaction.transferGroupId) {
    const group = await getTransactionGroup(uid, transaction.transferGroupId);
    const expense = group.find((candidate) => candidate.kind === 'expense');
    if (expense) return expense;
  }
  return transaction;
}

/**
 * Операцию, которую отменит `undoLastTransaction`, без самой отмены: вызывающий
 * успевает прочитать группу (обмен), пока строки ещё на месте.
 */
export async function findLastTransaction(
  userId: number,
  options: { accountId?: number } = {},
): Promise<TransactionRow | null> {
  const uid = assertUserId(userId);
  return selectLastTransaction(uid, options.accountId ?? null);
}

/** Все строки одной группы (`transfer_group_id`), в порядке вставки. */
export async function getTransactionGroup(
  userId: number,
  groupId: string,
): Promise<TransactionRow[]> {
  const uid = assertUserId(userId);
  const rows = await db.all<TransactionDbRow>(sql`
    SELECT ${TRANSACTION_COLUMNS} FROM transactions
    WHERE user_id = ${uid} AND transfer_group_id = ${groupId}
    ORDER BY id ASC
  `);
  return rows.map(mapTransaction);
}

/**
 * Отменяет последнюю операцию (по желанию — по конкретному счёту) и возвращает
 * балансы как было. Возвращает удалённую строку или `null`, если отменять нечего.
 */
export async function undoLastTransaction(
  userId: number,
  options: UndoOptions = {},
): Promise<TransactionRow | null> {
  const uid = assertUserId(userId);

  let accountFilterId: number | null = null;
  if (options.accountId !== undefined) {
    accountFilterId = options.accountId;
  } else if (options.accountName) {
    const account = await findAccountByName(uid, options.accountName);
    if (!account) return null;
    accountFilterId = account.id;
  }

  return withTransaction(async () => {
    const transaction = await selectLastTransaction(uid, accountFilterId);
    if (!transaction) return null;

    return revertTransactionRecord(uid, transaction);
  });
}

/**
 * Откатывает конкретную транзакцию по id и возвращает балансы счетов.
 */
export async function deleteTransaction(
  userId: number,
  transactionId: number,
): Promise<TransactionRow | null> {
  const uid = assertUserId(userId);
  return withTransaction(async () => {
    const row = await db.get<TransactionDbRow>(sql`
      SELECT ${TRANSACTION_COLUMNS} FROM transactions
      WHERE id = ${transactionId} AND user_id = ${uid}
      LIMIT 1
    `);
    if (!row) return null;

    const transaction = mapTransaction(row);
    return revertTransactionRecord(uid, transaction);
  });
}

/**
 * Снимает строку неудавшейся операции, не трогая балансы.
 *
 * Балансы уже вернул `debitWithSettlement`; здесь нужен только откат самой
 * записи, иначе отказ оставляет в книге расход, которого не было.
 */
async function deleteTransactionRow(uid: number, transactionId: number): Promise<void> {
  await db.run(sql`
    DELETE FROM transactions
    WHERE user_id = ${uid} AND id = ${transactionId}
  `);
}

/**
 * Возвращает балансы всех счетов группы и удаляет все её строки.
 * Сумма каждой строки уже в валюте её счёта, поэтому `-amountCents` — точный возврат.
 */
async function revertGroup(uid: number, groupId: string): Promise<void> {
  const rows = (
    await db.all<TransactionDbRow>(sql`
      SELECT ${TRANSACTION_COLUMNS} FROM transactions
      WHERE user_id = ${uid} AND transfer_group_id = ${groupId}
    `)
  ).map(mapTransaction);

  for (const row of rows) {
    await applyBalanceDelta(uid, row.accountId, -row.amountCents);
  }

  await db.run(sql`
    DELETE FROM transactions
    WHERE user_id = ${uid} AND transfer_group_id = ${groupId}
  `);
}

/**
 * Откат расхода с недокрытием: возвращает ровно те движения, которые были,
 * и убирает группу. Строка самого расхода — запись о трате, а не движение
 * денег, поэтому балансы по ней не двигаются.
 *
 * Возвращает непокрытую разницу (номинал минус всё, что вернулось на счета):
 * вызывающий называет её в ответе, иначе текст отмены показывал бы номинал.
 * Ноги компенсации могут быть в разных валютах (добор с KZT), поэтому каждая
 * переводится в валюту номинала перед сложением. Если курса нет, сумма
 * остаётся неизвестной (`undefined`): откат обязан пройти, а врать числом
 * в ответе нельзя.
 */
async function revertExpenseGroup(uid: number, groupId: string): Promise<Cents | undefined> {
  const rows = (
    await db.all<TransactionDbRow>(sql`
      SELECT ${TRANSACTION_COLUMNS} FROM transactions
      WHERE user_id = ${uid} AND transfer_group_id = ${groupId}
    `)
  ).map(mapTransaction);

  const expense = rows.find((row) => row.kind === 'expense');
  const nominalCents = expense?.amountCents ?? 0;
  const nominalCurrency = expense?.currency ?? rows[0]?.currency ?? BASE_CURRENCY;
  const rates = await resolveRates(
    needsFxTable(nominalCurrency, ...rows.map((row) => row.currency)),
  );

  let returnedCents: Cents = 0;
  let computable = true;
  for (const row of rows) {
    if (row.kind !== 'adjustment') continue;
    if (normalizeCurrency(row.currency) === normalizeCurrency(nominalCurrency)) {
      returnedCents += Math.abs(row.amountCents);
    } else if (hasRate(row.currency, rates) && hasRate(nominalCurrency, rates)) {
      returnedCents += convert(Math.abs(row.amountCents), row.currency, nominalCurrency, rates);
    } else {
      computable = false;
    }
    await applyBalanceDelta(uid, row.accountId, -row.amountCents);
  }

  await db.run(sql`
    DELETE FROM transactions
    WHERE user_id = ${uid} AND transfer_group_id = ${groupId}
  `);
  return computable ? Math.max(0, nominalCents - returnedCents) : undefined;
}

/**
 * Откат обязательства при удалении расхода: возвращает месяц в unpaid и
 * восстанавливает остаток. Вынесено из `revertTransactionRecord`, потому что
 * теперь вызывается из двух веток (обычная строка и группа с недокрытием).
 */
async function rollbackLiabilityMonth(uid: number, transaction: TransactionRow): Promise<void> {
  const liabMatch = transaction.description?.match(/^Liability payment:\s*(.+?)(?:\s*\[.*\])?$/);
  if (!liabMatch) return;
  const liabName = liabMatch[1].trim();
  const liability = await findLiabilityByName(uid, liabName);
  if (!liability) return;

  const month = transaction.occurredAt.slice(0, 7);
  const newPaidMonths = liability.paidMonths.filter((m) => m !== month);
  const newTotalPayments = liability.totalPayments !== null ? liability.totalPayments + 1 : null;
  const isRecurring = isRecurringQueue(liability.queue);
  let newAmountCents = liability.amountCents;
  let newAmountEurCents = liability.amountEurCents;
  if (!isRecurring) {
    newAmountCents = liability.amountCents + transaction.amountCents;
    const rates = await resolveRates(needsFxTable(liability.currency));
    newAmountEurCents = convert(newAmountCents, liability.currency, BASE_CURRENCY, rates);
  }
  await db.run(sql`
    UPDATE liabilities SET
      paid_months = ${JSON.stringify(newPaidMonths)},
      amount_cents = ${newAmountCents},
      amount_eur_cents = ${newAmountEurCents},
      total_payments = ${newTotalPayments},
      updated_at = ${nowIso()}
    WHERE id = ${liability.id} AND user_id = ${uid}
  `);
}

async function revertTransactionRecord(
  uid: number,
  transaction: TransactionRow,
): Promise<TransactionRow> {
  const reverseRates = await resolveRates(
    needsFxTable(transaction.currency),
    undefined,
  );
  // для счёта операция записана в его валюте, поэтому возврат — без конвертации
  const revertAmount = convert(
    transaction.amountCents,
    transaction.currency,
    transaction.currency,
    reverseRates,
  );

  if (transaction.kind === 'expense') {
    // Строка, записанная коротким окном фичи подтверждения операций со снимка
    // (выкачена и откатена): её сумма уже была внутри остатка банка, поэтому
    // отмена удаляет строку, но не возвращает деньги на счёт — иначе баланс
    // вырос бы на сумму, которой на счёте никогда не списывалось.
    if (transaction.rawText?.startsWith('vision-balance-expense:')) {
      await db.run(sql`DELETE FROM transactions WHERE id = ${transaction.id} AND user_id = ${uid}`);
      await rollbackLiabilityMonth(uid, transaction);
      return transaction;
    }

    // Расход с непокрытой разницей живёт в группе вместе с компенсирующей
    // строкой: баланс вернётся ровно на то, что реально списали.
    if (transaction.transferGroupId) {
      const uncoveredCents = await revertExpenseGroup(uid, transaction.transferGroupId);
      await rollbackLiabilityMonth(uid, transaction);
      return uncoveredCents === undefined ? transaction : { ...transaction, uncoveredCents };
    }

    await applyBalanceDelta(uid, transaction.accountId, revertAmount);
    await db.run(sql`DELETE FROM transactions WHERE id = ${transaction.id} AND user_id = ${uid}`);

    await rollbackLiabilityMonth(uid, transaction);
    return transaction;
  }

  if (transaction.kind === 'income') {
    await applyBalanceDelta(uid, transaction.accountId, -revertAmount);
    await db.run(sql`DELETE FROM transactions WHERE id = ${transaction.id} AND user_id = ${uid}`);
    return transaction;
  }

  // Расход с недокрытием: последней строкой группы лежит компенсация
  // (`adjustment`), а не сам расход, поэтому `undoLastTransaction` выбирает
  // именно её. Без этой ветки строка проваливается в ветку переноса, и
  // `revertGroup` разворачивает номинальную сумму расхода как движение денег:
  // счёт уходит в минус на величину непокрытой разницы.
  if (transaction.kind === 'adjustment' && transaction.transferGroupId) {
    const group = await getTransactionGroup(uid, transaction.transferGroupId);
    const expense = group.find((row) => row.kind === 'expense') ?? transaction;
    const uncoveredCents = await revertExpenseGroup(uid, transaction.transferGroupId);
    await rollbackLiabilityMonth(uid, expense);
    return uncoveredCents === undefined ? expense : { ...expense, uncoveredCents };
  }

  // exchange — две ноги с общим group_id и знаком в amount_cents; откат —
  // возврат каждой ноги, а не пересчёт по одной сумме.
  if (transaction.kind === 'exchange' && transaction.transferGroupId) {
    await revertGroup(uid, transaction.transferGroupId);
    return transaction;
  }

  // transfer
  if (transaction.transferGroupId) {
    const paired = (
      await db.all<TransactionDbRow>(sql`
        SELECT ${TRANSACTION_COLUMNS} FROM transactions
        WHERE user_id = ${uid} AND transfer_group_id = ${transaction.transferGroupId}
      `)
    ).map(mapTransaction);

    const singleRow = paired.length === 1 ? paired[0] : undefined;
    // Однострочная форма (наш DAL): amount > 0 и задан to_account_id —
    // откат зеркален записи, суммы считаются в валюте каждого счёта.
    if (singleRow && singleRow.toAccountId !== null && singleRow.amountCents > 0) {
      const source = await getAccount(uid, singleRow.accountId);
      const target = await getAccount(uid, singleRow.toAccountId);
      const transferRates = await resolveRates(
        needsFxTable(singleRow.currency, source?.currency ?? singleRow.currency),
        undefined,
      );
      const debit = convert(
        singleRow.amountCents,
        singleRow.currency,
        source?.currency ?? singleRow.currency,
        transferRates,
      );
      const credit = convert(
        singleRow.amountCents,
        singleRow.currency,
        target?.currency ?? singleRow.currency,
        transferRates,
      );
      await applyBalanceDelta(uid, singleRow.accountId, debit);
      await applyBalanceDelta(uid, singleRow.toAccountId, -credit);
    } else {
      // legacy-форма: парные строки со знаком — вычитание signed amount
      // возвращает баланс каждому счёту (та же логика, что у обмена).
      await revertGroup(uid, transaction.transferGroupId);
      return transaction;
    }

    await db.run(sql`
      DELETE FROM transactions
      WHERE user_id = ${uid} AND transfer_group_id = ${transaction.transferGroupId}
    `);
    return transaction;
  }

  await applyBalanceDelta(uid, transaction.accountId, transaction.amountCents);
  if (transaction.toAccountId !== null) {
    await applyBalanceDelta(uid, transaction.toAccountId, -transaction.amountCents);
  }
  await db.run(sql`DELETE FROM transactions WHERE id = ${transaction.id} AND user_id = ${uid}`);
  return transaction;
}

/**
 * Полная очистка истории операций пользователя (балансы счетов сохраняются).
 * Возвращает количество удалённых строк.
 */
export async function resetTransactions(userId: number): Promise<number> {
  const uid = assertUserId(userId);
  const result = await db.run(sql`DELETE FROM transactions WHERE user_id = ${uid}`);
  return result.rowsAffected;
}

// ---------------------------------------------------------------------------
// Бюджеты
// ---------------------------------------------------------------------------

interface BudgetDbRow {
  id: number;
  user_id: number;
  category_id: number;
  month: string;
  limit_amount_eur_cents: number;
  created_at: string | null;
}

function mapBudget(row: BudgetDbRow): BudgetRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    categoryId: Number(row.category_id),
    month: row.month,
    limitAmountEurCents: Number(row.limit_amount_eur_cents),
    createdAt: row.created_at ?? null,
  };
}

const BUDGET_COLUMNS = sql.raw('id, user_id, category_id, month, limit_amount_eur_cents, created_at');

export interface SetBudgetInput {
  /** Месяц `YYYY-MM`; по умолчанию — текущий. */
  month?: IsoMonth;
  categoryId?: number;
  categoryName?: string;
  icon?: string | null;
  limitAmountEurCents: Cents;
}

/** Лимит бюджета на месяц: get-or-create категории + upsert по `user+category+month`. */
export async function setBudget(userId: number, input: SetBudgetInput): Promise<BudgetRow> {
  const uid = assertUserId(userId);
  const month = normalizeMonth(input.month ?? monthOf(undefined));
  const limit = assertCents(input.limitAmountEurCents, 'setBudget.limitAmountEurCents');
  if (input.categoryId === undefined && !String(input.categoryName ?? '').trim()) {
    throw new Error('finances.setBudget: categoryId or categoryName is required');
  }

  return withTransaction(async () => {
    let categoryId: number;
    if (input.categoryId !== undefined) {
      const category = await getCategory(uid, input.categoryId);
      if (!category) throw new Error(`finances.setBudget: category ${input.categoryId} not found`);
      if (category.kind !== 'expense') {
        throw new Error(`finances.setBudget: budgets are for expense categories, "${category.name}" is ${category.kind}`);
      }
      categoryId = category.id;
    } else {
      const category = await ensureCategory(uid, String(input.categoryName), 'expense', input.icon);
      categoryId = category.id;
    }

    await db.run(sql`
      INSERT INTO budgets (user_id, category_id, month, limit_amount_eur_cents, created_at)
      VALUES (${uid}, ${categoryId}, ${month}, ${limit}, ${nowIso()})
      ON CONFLICT (user_id, category_id, month) DO UPDATE SET
        limit_amount_eur_cents = excluded.limit_amount_eur_cents
    `);

    const saved = await getBudget(uid, { month, categoryId });
    if (!saved) throw new Error('finances.setBudget: failed to read back the saved budget');
    return saved;
  });
}

export interface BudgetKey {
  month: IsoMonth;
  categoryId: number;
}

export async function getBudget(userId: number, key: BudgetKey): Promise<BudgetRow | null> {
  const uid = assertUserId(userId);
  const row = await db.get<BudgetDbRow>(sql`
    SELECT ${BUDGET_COLUMNS} FROM budgets
    WHERE user_id = ${uid} AND category_id = ${key.categoryId} AND month = ${normalizeMonth(key.month)}
    LIMIT 1
  `);
  return row ? mapBudget(row) : null;
}

export async function listBudgets(userId: number, month?: IsoMonth): Promise<BudgetRow[]> {
  const uid = assertUserId(userId);
  const conditions: Sql[] = [sql`user_id = ${uid}`];
  if (month) conditions.push(sql`month = ${normalizeMonth(month)}`);

  const rows = await db.all<BudgetDbRow>(sql`
    SELECT ${BUDGET_COLUMNS} FROM budgets
    WHERE ${andAll(conditions)}
    ORDER BY month DESC, category_id ASC
  `);
  return rows.map(mapBudget);
}

export async function deleteBudget(userId: number, budgetId: number): Promise<boolean> {
  const uid = assertUserId(userId);
  const result = await db.run(sql`DELETE FROM budgets WHERE id = ${budgetId} AND user_id = ${uid}`);
  return result.rowsAffected > 0;
}

// ---------------------------------------------------------------------------
// Обязательства
// ---------------------------------------------------------------------------

interface LiabilityDbRow {
  id: number;
  user_id: number;
  name: string;
  queue: string;
  amount_cents: number;
  currency: string;
  amount_eur_cents: number;
  monthly_payment_cents: number;
  payment_day: number | null;
  total_payments: number | null;
  end_date: string | null;
  notes: string | null;
  is_active: number | boolean | null;
  paid_months: string | null;
  last_payment_date: string | null;
  account_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

function mapLiability(row: LiabilityDbRow): LiabilityRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    queue: row.queue as LiabilityQueue,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    amountEurCents: Number(row.amount_eur_cents),
    monthlyPaymentCents: Number(row.monthly_payment_cents),
    paymentDay: row.payment_day === null ? null : Number(row.payment_day),
    totalPayments: row.total_payments === null ? null : Number(row.total_payments),
    endDate: row.end_date ?? null,
    notes: row.notes ?? null,
    isActive: Boolean(row.is_active),
    paidMonths: parseMonthList(row.paid_months),
    lastPaymentDate: row.last_payment_date ?? null,
    accountId: row.account_id === null ? null : Number(row.account_id),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

const LIABILITY_COLUMNS = sql.raw(
  'id, user_id, name, queue, amount_cents, currency, amount_eur_cents, monthly_payment_cents, ' +
    'payment_day, total_payments, end_date, notes, is_active, paid_months, last_payment_date, ' +
    'account_id, created_at, updated_at',
);

/** Порядок очередей: регулярные платежи раньше кредитных очередей. */
const LIABILITY_QUEUE_ORDER = sql.raw(
  "CASE queue WHEN 'subscription' THEN 0 WHEN 'service' THEN 1 WHEN 'queue_1' THEN 2 " +
    "WHEN 'queue_2' THEN 3 WHEN 'queue_3' THEN 4 WHEN 'queue_4' THEN 5 ELSE 9 END",
);

export type LiabilityStatus = 'active' | 'closed' | 'all';

export class LiabilityNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiabilityNotFoundError';
  }
}

export async function listLiabilities(
  userId: number,
  status: LiabilityStatus = 'active',
): Promise<LiabilityRow[]> {
  const uid = assertUserId(userId);
  const conditions: Sql[] = [sql`user_id = ${uid}`];
  if (status === 'active') conditions.push(sql`is_active = 1`);
  else if (status === 'closed') conditions.push(sql`is_active = 0`);

  const rows = await db.all<LiabilityDbRow>(sql`
    SELECT ${LIABILITY_COLUMNS} FROM liabilities
    WHERE ${andAll(conditions)}
    ORDER BY ${LIABILITY_QUEUE_ORDER}, payment_day IS NULL, payment_day ASC, id ASC
  `);
  return rows.map(mapLiability);
}

export async function getLiability(userId: number, liabilityId: number): Promise<LiabilityRow | null> {
  const uid = assertUserId(userId);
  const row = await db.get<LiabilityDbRow>(sql`
    SELECT ${LIABILITY_COLUMNS} FROM liabilities
    WHERE id = ${liabilityId} AND user_id = ${uid}
    LIMIT 1
  `);
  return row ? mapLiability(row) : null;
}

/** Нечёткий поиск активного обязательства по имени (как в upstream). */
export async function findLiabilityByName(userId: number, name: string): Promise<LiabilityRow | null> {
  const uid = assertUserId(userId);
  const needle = String(name ?? '').trim().toLowerCase();
  if (!needle) return null;

  const active = await listLiabilities(uid, 'active');
  const exact = active.find((item) => item.name.toLowerCase() === needle);
  if (exact) return exact;

  const contains = active.find(
    (item) => item.name.toLowerCase().includes(needle) || needle.includes(item.name.toLowerCase()),
  );
  return contains ?? null;
}

export interface LiabilityInput {
  name: string;
  queue?: LiabilityQueue;
  amountCents?: Cents;
  currency?: CurrencyCode;
  amountEurCents?: Cents;
  monthlyPaymentCents?: Cents;
  paymentDay?: number | null;
  totalPayments?: number | null;
  endDate?: IsoDate | string | null;
  notes?: string | null;
  isActive?: boolean;
  paidMonths?: readonly IsoMonth[];
  lastPaymentDate?: IsoDate | string | null;
  accountId?: number | null;
  rates?: RateTable;
}

/**
 * Регулярные платежи (upstream-очереди `subscription`/`service`) — вне
 * `LiabilityQueue`, но DAL их понимает: остаток у них не уменьшается.
 */
const RECURRING_QUEUES: readonly string[] = ['subscription', 'service'];

export function isRecurringQueue(queue: LiabilityQueue): boolean {
  return RECURRING_QUEUES.includes(queue);
}

function assertPaymentDay(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const day = Math.trunc(value);
  if (!Number.isFinite(day) || day < 1 || day > 31) {
    throw new Error(`finances: payment day must be 1..31, got ${String(value)}`);
  }
  return day;
}

function assertTotalPayments(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const total = Math.trunc(value);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`finances: total payments must be >= 0, got ${String(value)}`);
  }
  return total;
}

async function assertAccountOwnership(
  userId: number,
  accountId: number | null | undefined,
): Promise<number | null> {
  if (accountId === null || accountId === undefined) return null;
  const account = await getAccount(userId, accountId);
  if (!account) throw new Error(`finances: account ${accountId} not found`);
  return account.id;
}

export async function createLiability(
  userId: number,
  input: LiabilityInput,
): Promise<LiabilityRow> {
  const uid = assertUserId(userId);
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('finances.createLiability: name is required');

  const currency = normalizeCurrency(input.currency ?? BASE_CURRENCY);
  const amountCents = assertCents(input.amountCents ?? 0, 'createLiability.amountCents');
  const monthlyPaymentCents = assertCents(
    input.monthlyPaymentCents ?? 0,
    'createLiability.monthlyPaymentCents',
  );
  const accountId = await assertAccountOwnership(uid, input.accountId);

  const amountEurCents =
    input.amountEurCents !== undefined
      ? assertCents(input.amountEurCents, 'createLiability.amountEurCents')
      : convert(
          amountCents,
          currency,
          BASE_CURRENCY,
          await resolveRates(needsFxTable(currency), input.rates),
        );

  const paidMonths = (input.paidMonths ?? []).map(normalizeMonth);
  const paymentDay = assertPaymentDay(input.paymentDay);
  const totalPayments = assertTotalPayments(input.totalPayments);
  const endDate = input.endDate ? isoDay(input.endDate) : null;
  const lastPaymentDate = input.lastPaymentDate ? isoDay(input.lastPaymentDate) : null;
  const timestamp = nowIso();

  const result = await db.run(sql`
    INSERT INTO liabilities (
      user_id, name, queue, amount_cents, currency, amount_eur_cents, monthly_payment_cents,
      payment_day, total_payments, end_date, notes, is_active, paid_months, last_payment_date,
      account_id, created_at, updated_at
    ) VALUES (
      ${uid}, ${name}, ${input.queue ?? 'queue_1'}, ${amountCents}, ${currency}, ${amountEurCents},
      ${monthlyPaymentCents}, ${paymentDay}, ${totalPayments}, ${endDate}, ${input.notes ?? null},
      ${input.isActive === false ? 0 : 1}, ${JSON.stringify(paidMonths)}, ${lastPaymentDate},
      ${accountId}, ${timestamp}, ${timestamp}
    )
  `);

  const created = await getLiability(uid, Number(result.lastInsertRowid));
  if (!created) throw new Error('finances.createLiability: failed to read back the created liability');
  return created;
}

export interface UpdateLiabilityInput extends Partial<Omit<LiabilityInput, 'name' | 'rates'>> {
  name?: string;
  /** Пересчитать `amount_eur_cents` из `amount_cents` по актуальному курсу. */
  rates?: RateTable;
}

export async function updateLiability(
  userId: number,
  liabilityId: number,
  patch: UpdateLiabilityInput,
): Promise<LiabilityRow> {
  const uid = assertUserId(userId);
  const current = await getLiability(uid, liabilityId);
  if (!current) throw new Error(`finances.updateLiability: liability ${liabilityId} not found`);

  const assignments: Sql[] = [];

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('finances.updateLiability: name cannot be empty');
    assignments.push(sql`name = ${name}`);
  }
  if (patch.queue !== undefined) assignments.push(sql`queue = ${patch.queue}`);
  if (patch.currency !== undefined) {
    assignments.push(sql`currency = ${normalizeCurrency(patch.currency)}`);
  }
  if (patch.amountCents !== undefined) {
    assignments.push(sql`amount_cents = ${assertCents(patch.amountCents, 'updateLiability.amountCents')}`);
  }
  if (patch.monthlyPaymentCents !== undefined) {
    assignments.push(
      sql`monthly_payment_cents = ${assertCents(patch.monthlyPaymentCents, 'updateLiability.monthlyPaymentCents')}`,
    );
  }
  if (patch.amountEurCents !== undefined) {
    assignments.push(
      sql`amount_eur_cents = ${assertCents(patch.amountEurCents, 'updateLiability.amountEurCents')}`,
    );
  } else if (patch.amountCents !== undefined || patch.currency !== undefined) {
    // сумма изменилась — пересчитываем EUR-эквивалент, иначе он устарел
    const amountCents = patch.amountCents ?? current.amountCents;
    const currency = normalizeCurrency(patch.currency ?? current.currency);
    const rates = await resolveRates(needsFxTable(currency), patch.rates);
    assignments.push(
      sql`amount_eur_cents = ${convert(amountCents, currency, BASE_CURRENCY, rates)}`,
    );
  }
  if (patch.paymentDay !== undefined) {
    assignments.push(sql`payment_day = ${assertPaymentDay(patch.paymentDay)}`);
  }
  if (patch.totalPayments !== undefined) {
    assignments.push(sql`total_payments = ${assertTotalPayments(patch.totalPayments)}`);
  }
  if (patch.endDate !== undefined) {
    assignments.push(sql`end_date = ${patch.endDate ? isoDay(patch.endDate) : null}`);
  }
  if (patch.notes !== undefined) assignments.push(sql`notes = ${patch.notes}`);
  if (patch.isActive !== undefined) assignments.push(sql`is_active = ${patch.isActive ? 1 : 0}`);
  if (patch.paidMonths !== undefined) {
    assignments.push(sql`paid_months = ${JSON.stringify(patch.paidMonths.map(normalizeMonth))}`);
  }
  if (patch.lastPaymentDate !== undefined) {
    assignments.push(
      sql`last_payment_date = ${patch.lastPaymentDate ? isoDay(patch.lastPaymentDate) : null}`,
    );
  }
  if (patch.accountId !== undefined) {
    assignments.push(sql`account_id = ${await assertAccountOwnership(uid, patch.accountId)}`);
  }

  if (assignments.length === 0) return current;

  assignments.push(sql`updated_at = ${nowIso()}`);

  await db.run(sql`
    UPDATE liabilities SET ${joinSql(assignments, ', ')}
    WHERE id = ${liabilityId} AND user_id = ${uid}
  `);

  const updated = await getLiability(uid, liabilityId);
  if (!updated) throw new Error(`finances.updateLiability: liability ${liabilityId} not found`);
  return updated;
}

/** Удаляет обязательство (историю платежей это не откатывает). */
export async function deleteLiability(userId: number, liabilityId: number): Promise<boolean> {
  const uid = assertUserId(userId);
  const result = await db.run(sql`
    DELETE FROM liabilities WHERE id = ${liabilityId} AND user_id = ${uid}
  `);
  return result.rowsAffected > 0;
}

export interface PayLiabilityInput {
  liabilityId?: number;
  liabilityName?: string;
  /** Сумма платежа в валюте обязательства; по умолчанию — месячный платёж (или остаток). */
  amountCents?: Cents;
  accountId?: number;
  accountName?: string;
  /** Списать ли платёж с баланса счёта и записать расход. */
  deductFromAccount?: boolean;
  /** Дата платежа; по умолчанию — сегодня. */
  paymentDate?: IsoDate | Date | null;
  rates?: RateTable;
}

export interface LiabilityPaymentResult {
  liability: LiabilityRow;
  alreadyPaid: boolean;
  month: IsoMonth;
  paymentDate: IsoDate;
  amountCents: Cents;
  currency: CurrencyCode;
  amountEurCents: Cents;
  fxRate: number;
  deducted: boolean;
  account: AccountRow | null;
  deductedCents: Cents;
  transaction: TransactionRow | null;
}

async function resolveLiability(
  userId: number,
  input: PayLiabilityInput,
): Promise<LiabilityRow> {
  if (input.liabilityId !== undefined) {
    const liability = await getLiability(userId, input.liabilityId);
    if (!liability || !liability.isActive) {
      throw new LiabilityNotFoundError(`finances.payLiability: liability ${input.liabilityId} not found`);
    }
    return liability;
  }
  if (input.liabilityName) {
    const liability = await findLiabilityByName(userId, input.liabilityName);
    if (!liability) {
      throw new LiabilityNotFoundError(
        `finances.payLiability: liability "${input.liabilityName}" not found`,
      );
    }
    return liability;
  }
  throw new Error('finances.payLiability: liabilityId or liabilityName is required');
}

async function resolvePayAccount(
  userId: number,
  liability: LiabilityRow,
  input: PayLiabilityInput,
): Promise<AccountRow | null> {
  if (input.accountId !== undefined) return getAccount(userId, input.accountId);
  if (input.accountName) return findAccountByName(userId, input.accountName, liability.currency);
  if (liability.accountId !== null) return getAccount(userId, liability.accountId);
  return null;
}

/**
 * Платёж по обязательству (паритет с `pay_liability` upstream):
 *  - месяц считается по дате платежа; повторный платёж в том же месяце —
 *    `alreadyPaid: true` и никаких изменений;
 *  - `total_payments` уменьшается на 1 (если он задан и > 0);
 *  - у `subscription`/`service` остаток (`amount_cents`) не меняется;
 *  - при `deductFromAccount` списывается баланс счёта (в его валюте) и пишется
 *    expense-транзакция в валюте обязательства.
 */
export async function payLiability(
  userId: number,
  input: PayLiabilityInput = {},
): Promise<LiabilityPaymentResult> {
  const uid = assertUserId(userId);

  return withTransaction(async () => {
    const liability = await resolveLiability(uid, input);
    const paymentDate = isoDay(input.paymentDate);
    const month = paymentDate.slice(0, 7);
    const currency = normalizeCurrency(liability.currency);

    const defaultAmount =
      liability.monthlyPaymentCents > 0 ? liability.monthlyPaymentCents : liability.amountCents;
    const amountCents = assertPositiveCents(input.amountCents ?? defaultAmount, 'payLiability.amountCents');

    const rates = await resolveRates(needsFxTable(currency), input.rates);
    const amountEurCents = convert(amountCents, currency, BASE_CURRENCY, rates);
    const fxRate = amountCents > 0 ? round(amountEurCents / amountCents, 6) : 1;

    if (liability.paidMonths.includes(month)) {
      return {
        liability,
        alreadyPaid: true,
        month,
        paymentDate,
        amountCents,
        currency,
        amountEurCents,
        fxRate,
        deducted: false,
        account: null,
        deductedCents: 0,
        transaction: null,
      };
    }

    const paidMonths = [...liability.paidMonths, month];
    const totalPayments =
      liability.totalPayments !== null && liability.totalPayments > 0
        ? Math.max(0, liability.totalPayments - 1)
        : liability.totalPayments;

    const isRecurring = isRecurringQueue(liability.queue);
    let remainingCents = liability.amountCents;
    let remainingEurCents = liability.amountEurCents;
    if (!isRecurring) {
      remainingCents = Math.max(0, liability.amountCents - amountCents);
      remainingEurCents = convert(remainingCents, currency, BASE_CURRENCY, rates);
    }

    let account: AccountRow | null = null;
    let deductedCents = 0;
    let transaction: TransactionRow | null = null;

    if (input.deductFromAccount) {
      account = await resolvePayAccount(uid, liability, input);
      if (account) {
        deductedCents = convert(amountCents, currency, account.currency, rates);
        await debitWithSettlement(uid, account, deductedCents, rates);

        let description = `Liability payment: ${liability.name}`;
        if (normalizeCurrency(account.currency) !== currency) {
          description += ` [deducted ${formatCents(deductedCents)} ${account.currency}]`;
        }

        transaction = await insertTransactionRow(uid, {
          kind: 'expense',
          accountId: account.id,
          amountCents,
          currency,
          fxRate,
          amountEurCents,
          description,
          occurredAt: `${paymentDate}T00:00:00.000Z`,
        });
      }
    }

    await db.run(sql`
      UPDATE liabilities SET
        paid_months = ${JSON.stringify(paidMonths)},
        last_payment_date = ${paymentDate},
        amount_cents = ${remainingCents},
        amount_eur_cents = ${remainingEurCents},
        total_payments = ${totalPayments},
        updated_at = ${nowIso()}
      WHERE id = ${liability.id} AND user_id = ${uid}
    `);

    const updated = await getLiability(uid, liability.id);
    if (!updated) throw new Error('finances.payLiability: failed to read back the liability');

    return {
      liability: updated,
      alreadyPaid: false,
      month,
      paymentDate,
      amountCents,
      currency,
      amountEurCents,
      fxRate,
      deducted: account !== null,
      account,
      deductedCents,
      transaction,
    };
  });
}

export interface RollbackLiabilityPaymentInput {
  liabilityId: number;
  month: string;
  transactionId?: number;
}

/**
 * Откат платежа по обязательству:
 *  - удаляет месяц из paid_months;
 *  - восстанавливает total_payments (+1) и amount_cents (если не recurring);
 *  - если была транзакция — откатывает её (возвращая баланс счёта).
 */
export async function rollbackLiabilityPayment(
  userId: number,
  input: RollbackLiabilityPaymentInput,
): Promise<{ liability: LiabilityRow; transactionDeleted: boolean }> {
  const uid = assertUserId(userId);
  return withTransaction(async () => {
    const liability = await getLiability(uid, input.liabilityId);
    if (!liability) {
      throw new LiabilityNotFoundError(
        `finances.rollbackLiabilityPayment: liability ${input.liabilityId} not found`,
      );
    }

    let transactionDeleted = false;
    let revertedAmountCents = 0;

    if (input.transactionId && input.transactionId > 0) {
      const tx = await deleteTransaction(uid, input.transactionId);
      if (tx) {
        transactionDeleted = true;
        revertedAmountCents = tx.amountCents;
      }
    }

    // Повторно читаем liability, т.к. deleteTransaction мог уже почистить paid_months
    const freshLiability = (await getLiability(uid, input.liabilityId)) ?? liability;
    const newPaidMonths = freshLiability.paidMonths.filter((m) => m !== input.month);
    const newTotalPayments =
      freshLiability.totalPayments !== null && freshLiability.paidMonths.includes(input.month)
        ? freshLiability.totalPayments + 1
        : freshLiability.totalPayments;

    const isRecurring = isRecurringQueue(freshLiability.queue);
    let newAmountCents = freshLiability.amountCents;
    let newAmountEurCents = freshLiability.amountEurCents;
    if (!isRecurring && revertedAmountCents > 0 && freshLiability.paidMonths.includes(input.month)) {
      newAmountCents = freshLiability.amountCents + revertedAmountCents;
      const rates = await resolveRates(needsFxTable(freshLiability.currency));
      newAmountEurCents = convert(newAmountCents, freshLiability.currency, BASE_CURRENCY, rates);
    }

    await db.run(sql`
      UPDATE liabilities SET
        paid_months = ${JSON.stringify(newPaidMonths)},
        amount_cents = ${newAmountCents},
        amount_eur_cents = ${newAmountEurCents},
        total_payments = ${newTotalPayments},
        updated_at = ${nowIso()}
      WHERE id = ${freshLiability.id} AND user_id = ${uid}
    `);

    const updated = await getLiability(uid, freshLiability.id);
    if (!updated) {
      throw new Error('finances.rollbackLiabilityPayment: failed to read back liability');
    }
    return { liability: updated, transactionDeleted };
  });
}

/** Пересчёт «сколько это в базовой валюте» для произвольной суммы (без записи). */
export function toBaseCents(
  amountCents: Cents,
  currency: CurrencyCode,
  rates: RateTable,
): Cents {
  return convert(amountCents, currency, BASE_CURRENCY, rates);
}

/** Множитель `amount → amount_eur` для валюты транзакции (см. `fx.eurPerUnit`). */
export function fxRateFor(currency: CurrencyCode, rates: RateTable): number {
  return round(eurPerUnit(currency, rates), 6);
}
