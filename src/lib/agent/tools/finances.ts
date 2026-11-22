/**
 * Тулзы агента: деньги и обязательства (SPEC §3 T13, паритет с
 * `backend/app/agent/tools/finances.py`).
 *
 * ADR-003: на границе DAL деньги — только INTEGER cents. Суммы в аргументах
 * тулз приходят десятичной строкой (паритет с upstream float-UX) и парсятся
 * через parseAmountToCents; в content/data — cents (int) или formatCents.
 *
 * Отличия от upstream (задокументированы осознанно):
 *  - нет дефолтных счетов и дефолтного счёта-банка (ADR-002): счёт берётся из
 *    данных пользователя, а не из захардкоженного имени;
 *  - transfer — одна строка транзакции (свойство DAL), а не две;
 *  - exchange — две строки `kind='exchange'` с общим `transfer_group_id`
 *    (см. docs/design-exchange.md), источник списывается как расход;
 *  - resolve_account упрощён до 3 шагов вместо 4 upstream.
 */

import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import {
  LiabilityNotFoundError,
  createAccount,
  createExchange,
  createLiability,
  createTransaction,
  deleteAccount,
  deleteLiability,
  deleteTransaction,
  findAccountByName,
  findAccountCandidates,
  findLastTransaction,
  findLiabilityByName,
  getTransactionGroup,
  listAccounts,
  listBudgets,
  listCategories,
  listLiabilities,
  listTransactions,
  payLiability,
  resetTransactions,
  setAccountBalance,
  setBudget,
  toBaseCents,
  undoLastTransaction,
  updateAccount,
  updateLiability,
  withTransaction,
  EXCHANGE_TOPUP_SUFFIX,
} from '../../dal/finances';
import {
  getLatestRate,
  getRate,
  getRates,
  hasRate,
  convert,
  rateOf,
  roundUpToNextNinetyNine,
  normalizeCurrency,
  normalizeDate,
  setRates,
  BASE_CURRENCY,
} from '../../dal/fx';
import { calculateRunway } from '../../runway';
import type {
  AccountEnvelope,
  AccountRow,
  LiabilityQueue,
  LiabilityRow,
  TransactionKind,
  TransactionRow,
} from '../../../types';
import { formatCents, formatMoney, monthKey, parseAmountToCents } from '../../utils';

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

/** Максимальный возраст курса, который ещё считается живым (дни). */
const MAX_FX_AGE_DAYS = 7;

interface LiveRateTable {
  rates: Record<string, number>;
  /** Дата, к которой относится курс (`YYYY-MM-DD`). */
  date: string;
  /** Курс не за сегодняшний день — дата названа пользователю явно. */
  stale: boolean;
}

/** Сколько дней между двумя датами `YYYY-MM-DD`. */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.abs(Math.round((to - from) / 86_400_000));
}

/**
 * Курс на дату конвертации: сегодняшняя строка `fx_rates`, иначе самый свежий.
 * Курс старше `MAX_FX_AGE_DAYS` считается неживым — конвертация не выполняется,
 * чтобы не считать деньги по протухшему курсу. `null` — курсов нет вовсе.
 */
async function loadLiveRateTable(ctx: ToolContext): Promise<LiveRateTable | ToolOutcome> {
  const today = normalizeDate(ctx.now);
  const todayRow = await getRate(today);
  if (todayRow) return { rates: todayRow.rates, date: todayRow.date, stale: false };

  const latest = await getLatestRate();
  if (!latest) {
    return fail(
      'Курсов валют ещё нет — конвертацию не считаю. Заведи курс за сегодня и повтори.',
    );
  }
  const age = daysBetween(latest.date, today);
  if (age > MAX_FX_AGE_DAYS) {
    return fail(
      `Курс для конвертации устарел: последний за ${latest.date}, это ${age} дн. назад. ` +
        'Нужен курс на сегодня — обнови его и повтори обмен.',
    );
  }
  return { rates: latest.rates, date: latest.date, stale: true };
}

function isRateFailure(value: LiveRateTable | ToolOutcome): value is ToolOutcome {
  return 'ok' in value && 'content' in value;
}

/** Строка для описания операции: по какому курсу считали и с каким округлением. */
function exchangeRateNote(fromCurrency: string, toCurrency: string, table: LiveRateTable): string {
  let ratio: number | null = null;
  try {
    ratio = rateOf(toCurrency, table.rates) / rateOf(fromCurrency, table.rates);
  } catch {
    ratio = null;
  }
  const rateText =
    ratio === null
      ? 'курс из таблицы'
      : (ratio >= 0.001 ? ratio.toFixed(4) : ratio.toFixed(8))
          .replace(/0+$/, '')
          .replace(/\.$/, '');
  return `Обмен по курсу на ${table.date} (1 ${fromCurrency} = ${rateText} ${toCurrency}), округление вверх до ,99`;
}

/**
 * Вопрос-подтверждение, когда операция забирает с счёта-источника весь остаток
 * (или больше — тогда нехватку добирает расчётный счёт).
 */
function drainConfirmation(account: AccountRow, amountCents: number): ToolOutcome {
  const atZero = account.currentBalanceCents <= 0;
  const what = atZero
    ? `На счёте «${account.name}» (${account.currency}) сейчас ${formatMoney(
        account.currentBalanceCents,
        account.currency,
      )}: сумма пойдёт с расчётного субсчёта и опустошит его.`
    : `Операция опустошит счёт «${account.name}» (${account.currency}) до нуля: сейчас на нём ` +
      `${formatMoney(account.currentBalanceCents, account.currency)}, списывается ` +
      `${formatMoney(amountCents, account.currency)}.`;
  return fail(
    `${what} Спроси у пользователя одной короткой строкой, действительно ли переводить ВСЁ; ` +
      'после явного «да» повтори вызов с confirm: true.',
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Необязательная непустая строка из аргументов. */
function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/** Обязательная непустая строка; `null` — не задана. */
function requiredString(args: ToolArgs, key: string): string | null {
  return stringArg(args, key) ?? null;
}

/** Сумма из аргументов: `null` — не разобрать (пустая строка/мусор/не число). */
function centsArg(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  try {
    return parseAmountToCents(value);
  } catch {
    return null;
  }
}

/** Необязательная сумма: `undefined` — не задана, `null` — кривая. */
function optionalCents(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return centsArg(value);
}

/** Необязательное целое: `undefined` — не задано, `null` — не разобрать. */
function intArg(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Необязательное булево: `undefined` — не задано, `null` — не разобрать. */
function booleanArg(value: unknown): boolean | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (!lower) return undefined;
    if (lower === 'true' || lower === '1' || lower === 'да') return true;
    if (lower === 'false' || lower === '0' || lower === 'нет') return false;
  }
  return null;
}

const VALID_LIABILITY_QUEUES: readonly string[] = [
  'subscription',
  'service',
  'bank',
  'queue_1',
  'queue_2',
  'queue_3',
  'queue_4',
  'investors',
];

const VALID_ACCOUNT_ENVELOPES: readonly AccountEnvelope[] = ['spendable', 'reserved'];

const VALID_TX_KINDS: readonly TransactionKind[] = ['expense', 'income', 'transfer', 'exchange'];

async function findLiabilityAnyStatus(userId: number, name: string): Promise<LiabilityRow | null> {
  const active = await findLiabilityByName(userId, name);
  if (active) return active;

  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const all = await listLiabilities(userId, 'all');
  const exact = all.find((item) => item.name.toLowerCase() === needle);
  if (exact) return exact;
  return (
    all.find(
      (item) => item.name.toLowerCase().includes(needle) || needle.includes(item.name.toLowerCase()),
    ) ?? null
  );
}

async function resolveSingleAccountForManagement(
  ctx: ToolContext,
  name: string,
  currency?: string,
): Promise<{ account: AccountRow } | ToolOutcome> {
  const candidates = await findAccountCandidates(ctx.userId, name, currency);
  if (candidates.length === 0) {
    const accounts = await listAccounts(ctx.userId, { includeInactive: true });
    return fail(`Счёт «${name}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
  }

  if (currency) {
    const wanted = currency.toUpperCase();
    const matched = candidates.find((account) => account.currency.toUpperCase() === wanted);
    if (!matched) {
      const currencies = candidates.map((account) => account.currency).join(', ');
      return fail(
        `Счёт «${name}» в валюте ${wanted} не найден. Доступные валюты для этого счёта: ${currencies}.`,
      );
    }
    return { account: matched };
  }

  if (candidates.length > 1) {
    const list = candidates.map((account) => `${account.name} (${account.currency})`).join(', ');
    return fail(`Найдено несколько счетов: ${list}. Уточните currency.`);
  }

  return { account: candidates[0]! };
}

type AccountResolution = { account: AccountRow } | { error: string };

/**
 * resolve_account (упрощение против upstream 4-шагового):
 *  1) имя задано → findAccountByName; не найден — создаём счёт с этим именем;
 *  2) имя не задано → первый активный spendable-счёт;
 *  3) иначе первый активный; счетов нет — ошибка.
 */
async function resolveAccount(
  ctx: ToolContext,
  name?: string,
  currency?: string,
): Promise<AccountResolution> {
  if (name) {
    const found = await findAccountByName(ctx.userId, name, currency);
    if (found) return { account: found };
    const created = await createAccount(ctx.userId, {
      name,
      ...(currency ? { currency } : {}),
    });
    return { account: created };
  }

  const accounts = await listAccounts(ctx.userId);
  const spendable = accounts.filter((account) => account.envelope === 'spendable');
  // Минуса не бывает, поэтому по умолчанию берём счёт, на котором есть деньги:
  // `listAccounts` сортирует по имени, и «Cash» без баланса иначе перехватывал
  // бы расход у «Main» с деньгами.
  const funded = spendable.reduce<AccountRow | null>(
    (best, account) =>
      account.currentBalanceCents > 0 &&
      (best === null || account.currentBalanceCents > best.currentBalanceCents)
        ? account
        : best,
    null,
  );
  if (funded) return { account: funded };
  const first = spendable[0] ?? accounts[0];
  if (first) return { account: first };

  return { error: 'Пока нет ни одного счёта — создайте счёт или укажите его имя.' };
}

function accountOrFail(resolution: AccountResolution): { account: AccountRow } | ToolOutcome {
  if ('error' in resolution) return fail(resolution.error);
  return { account: resolution.account };
}

function isOutcome(value: { account: AccountRow } | ToolOutcome): value is ToolOutcome {
  return 'ok' in value && 'content' in value;
}

function transactionLabel(tx: TransactionRow): string {
  const kind =
    tx.kind === 'expense'
      ? 'расход'
      : tx.kind === 'income'
        ? 'доход'
        : tx.kind === 'exchange'
          ? 'обмен'
          : 'перевод';
  return tx.description ? `${tx.description} (${kind})` : kind;
}

function joinAccounts(accounts: readonly AccountRow[]): string {
  return accounts.map((account) => `«${account.name}»`).join(', ') || '—';
}

function joinLiabilities(liabilities: readonly LiabilityRow[]): string {
  return liabilities.map((item) => `«${item.name}»`).join(', ') || '—';
}

// ---------------------------------------------------------------------------
// add_expense / add_income
// ---------------------------------------------------------------------------

/** Записать расход: сумма, валюта, счёт и категория. */
async function addExpense(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const amountCents = centsArg(args.amount);
  if (amountCents === null) {
    return fail(
      `Не понял сумму «${String(args.amount)}» — передайте число, например 12 или "12,50".`,
    );
  }
  if (amountCents <= 0) return fail('Сумма расхода должна быть больше нуля.');

  const currency = stringArg(args, 'currency');
  const accountName = stringArg(args, 'account_name');
  const categoryName = stringArg(args, 'category_name') ?? 'Разное';
  const description = stringArg(args, 'description');

  try {
    const resolution = accountOrFail(await resolveAccount(ctx, accountName, currency));
    if (isOutcome(resolution)) return resolution;
    const account = resolution.account;

    const tx = await createTransaction(ctx.userId, {
      kind: 'expense',
      amountCents,
      accountId: account.id,
      categoryName,
      ...(currency ? { currency } : {}),
      ...(description ? { description } : {}),
      occurredAt: ctx.now,
    });

    const note = description ? `. Комментарий: ${description}` : '';
    // Расход проведён целиком, но остаток счёта его не покрыл: молчать нельзя,
    // иначе книга разойдётся с банком без единого признака.
    const uncovered = tx.uncoveredCents ?? 0;
    const uncoveredNote =
      uncovered > 0
        ? `. Остаток счёта не покрыл ${formatCents(uncovered)} ${account.currency}: записано как ` +
          `непокрытая разница, обнови баланс «${account.name}»`
        : '';
    return {
      ok: true,
      content:
        `Записал расход: ${formatCents(tx.amountCents)} ${tx.currency} ` +
        `на «${categoryName}» со счёта «${account.name}»${note}${uncoveredNote}`,
      data: {
        transaction_id: tx.id,
        amount_cents: tx.amountCents,
        amount_eur_cents: tx.amountEurCents,
        currency: tx.currency,
        account_id: account.id,
        account_name: account.name,
        category: categoryName,
      },
    };
  } catch (error) {
    return fail(`Не удалось записать расход: ${errorText(error)}`);
  }
}

/** Записать доход: сумма, валюта, счёт и (опционально) категория. */
async function addIncome(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const amountCents = centsArg(args.amount);
  if (amountCents === null) {
    return fail(
      `Не понял сумму «${String(args.amount)}» — передайте число, например 1000 или "1 000,00".`,
    );
  }
  if (amountCents <= 0) return fail('Сумма дохода должна быть больше нуля.');

  const currency = stringArg(args, 'currency');
  const accountName = stringArg(args, 'account_name');
  const categoryName = stringArg(args, 'category_name');
  const description = stringArg(args, 'description');

  try {
    const resolution = accountOrFail(await resolveAccount(ctx, accountName, currency));
    if (isOutcome(resolution)) return resolution;
    const account = resolution.account;

    const tx = await createTransaction(ctx.userId, {
      kind: 'income',
      amountCents,
      accountId: account.id,
      ...(currency ? { currency } : {}),
      ...(categoryName ? { categoryName } : {}),
      ...(description ? { description } : {}),
      occurredAt: ctx.now,
    });

    const note = description ? `. Комментарий: ${description}` : '';
    return {
      ok: true,
      content:
        `Записал доход: ${formatCents(tx.amountCents)} ${tx.currency} ` +
        `на счёт «${account.name}»${note}`,
      data: {
        transaction_id: tx.id,
        amount_cents: tx.amountCents,
        amount_eur_cents: tx.amountEurCents,
        currency: tx.currency,
        account_id: account.id,
        account_name: account.name,
        category: categoryName ?? null,
      },
    };
  } catch (error) {
    return fail(`Не удалось записать доход: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// add_transfer
// ---------------------------------------------------------------------------

/** Перевести деньги между своими счетами. */
async function addTransfer(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const amountCents = centsArg(args.amount);
  if (amountCents === null) {
    return fail(
      `Не понял сумму «${String(args.amount)}» — передайте число, например 100 или "100,00".`,
    );
  }
  if (amountCents <= 0) return fail('Сумма перевода должна быть больше нуля.');

  const fromName = requiredString(args, 'from_account');
  const toName = requiredString(args, 'to_account');
  if (!fromName || !toName) {
    return fail('Укажите оба счёта: from_account (откуда) и to_account (куда).');
  }

  const currency = stringArg(args, 'currency');
  const description = stringArg(args, 'description');

  try {
    const fromResolution = accountOrFail(await resolveAccount(ctx, fromName, currency));
    if (isOutcome(fromResolution)) return fromResolution;
    const from = fromResolution.account;

    // Подтверждение — до резолва получателя: отказ не должен создавать счёт.
    if (amountCents >= from.currentBalanceCents && args.confirm !== true) {
      return drainConfirmation(from, amountCents);
    }

    const toResolution = accountOrFail(await resolveAccount(ctx, toName, currency));
    if (isOutcome(toResolution)) return toResolution;
    const to = toResolution.account;

    if (from.currency !== to.currency) {
      return fail(
        `Перевод возможен только в одной валюте: «${from.name}» (${from.currency}) и ` +
          `«${to.name}» (${to.currency}). Для обмена валют используй add_exchange.`,
      );
    }
    if (currency && normalizeCurrency(currency) !== from.currency) {
      return fail(
        `Валюта перевода не совпадает с валютой счёта «${from.name}» (${from.currency}). ` +
          'Молча пересчитывать в другую валюту нельзя.',
      );
    }

    const tx = await createTransaction(ctx.userId, {
      kind: 'transfer',
      amountCents,
      accountId: from.id,
      toAccountId: to.id,
      ...(currency ? { currency } : {}),
      ...(description ? { description } : {}),
      occurredAt: ctx.now,
    });

    return {
      ok: true,
      content:
        `Перевёл ${formatCents(tx.amountCents)} ${tx.currency} ` +
        `с «${from.name}» на «${to.name}»`,
      data: {
        transaction_id: tx.id,
        amount_cents: tx.amountCents,
        currency: tx.currency,
        from_account_id: from.id,
        to_account_id: to.id,
      },
    };
  } catch (error) {
    return fail(`Не удалось выполнить перевод: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// add_exchange
// ---------------------------------------------------------------------------

/**
 * Обмен валюты: две строки `kind='exchange'` с общим `transfer_group_id`
 * (исходящая с минусом, входящая с плюсом). Источник списывается через
 * `debitWithSettlement`, поэтому обмен добирает нехватку со связанного счёта как расход.
 *
 * `to_amount` необязателен: без него сумма зачисления считается по живому курсу
 * `fx_rates` на дату операции и округляется вверх до `x,99` (решение владельца
 * 22.11.2026). Курс старше недели не используется.
 */
async function addExchange(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const fromAmountCents = centsArg(args.from_amount);
  if (fromAmountCents === null) {
    return fail(
      `Не понял сумму списания «${String(args.from_amount)}» — передайте число, например 100.`,
    );
  }
  if (fromAmountCents <= 0) return fail('Сумма обмена должна быть больше нуля.');

  const explicitToCents = optionalCents(args.to_amount);
  if (explicitToCents === null) {
    return fail(
      `Не понял сумму зачисления «${String(args.to_amount)}» — передайте число или не указывайте её совсем, тогда посчитаю по курсу.`,
    );
  }

  const fromName = requiredString(args, 'from_account');
  const toName = requiredString(args, 'to_account');
  const fromCurrency = requiredString(args, 'from_currency')?.toUpperCase();
  const toCurrency = requiredString(args, 'to_currency')?.toUpperCase();
  if (!fromName || !toName || !fromCurrency || !toCurrency) {
    return fail(
      'Для обмена нужны from_account, from_amount, from_currency и to_account, to_currency. ' +
        'to_amount можно не указывать — посчитаю по курсу.',
    );
  }

  try {
    const fromResolution = accountOrFail(await resolveAccount(ctx, fromName, fromCurrency));
    if (isOutcome(fromResolution)) return fromResolution;
    const from = fromResolution.account;

    // Подтверждение — до резолва получателя и до расчёта курса: отказ не должен
    // создавать счёт получателя и не должен трогать валютные курсы.
    if (fromAmountCents >= from.currentBalanceCents && args.confirm !== true) {
      return drainConfirmation(from, fromAmountCents);
    }

    const toResolution = accountOrFail(await resolveAccount(ctx, toName, toCurrency));
    if (isOutcome(toResolution)) return toResolution;
    const to = toResolution.account;

    // Валюта счёта обязана совпасть с запрошенной: иначе `createExchange`
    // молча сконвертирует ещё раз, и округлённая сумма развернётся обратно.
    if (normalizeCurrency(fromCurrency) !== from.currency || normalizeCurrency(toCurrency) !== to.currency) {
      return fail(
        `Валюта счёта не совпадает с запрошенной: «${from.name}» (${from.currency}), ` +
          `«${to.name}» (${to.currency}). Укажи валюты этих счетов или другие счета — ` +
          'молча пересчитывать в другую валюту нельзя.',
      );
    }

    let toAmountCents = explicitToCents;
    let rateTable: LiveRateTable | null = null;
    const sameCurrency = normalizeCurrency(fromCurrency) === normalizeCurrency(toCurrency);
    if (toAmountCents === undefined) {
      if (sameCurrency) {
        // Обмен внутри одной валюты — не конвертация: курс не нужен и
        // округление вверх не применяется (решение владельца 22.11.2026).
        toAmountCents = fromAmountCents;
      } else {
        const loaded = await loadLiveRateTable(ctx);
        if (isRateFailure(loaded)) return loaded;
        rateTable = loaded;
        try {
          toAmountCents = roundUpToNextNinetyNine(
            convert(fromAmountCents, fromCurrency, toCurrency, rateTable.rates),
          );
        } catch (error) {
          return fail(
            `Нет курса для конвертации ${fromCurrency} → ${toCurrency}: ${errorText(error)}. ` +
              'Заведи курс за сегодня через set_fx_rate или укажи to_amount явно.',
          );
        }
      }
    }

    if (toAmountCents <= 0) return fail('Суммы обмена должны быть больше нуля.');

    const userDescription = stringArg(args, 'description');
    const description = rateTable
      ? [userDescription, exchangeRateNote(fromCurrency, toCurrency, rateTable)]
          .filter(Boolean)
          .join(' · ')
      : userDescription;

    const result = await createExchange(ctx.userId, {
      fromAccountId: from.id,
      fromCents: fromAmountCents,
      fromCurrency,
      toAccountId: to.id,
      toCents: toAmountCents,
      toCurrency,
      ...(rateTable ? { rates: rateTable.rates } : {}),
      ...(description ? { description } : {}),
      occurredAt: ctx.now,
    });

    const rateLine = rateTable ? ` ${exchangeRateNote(fromCurrency, toCurrency, rateTable)}.` : '';

    return {
      ok: true,
      content:
        `Обменял ${formatCents(fromAmountCents)} ${fromCurrency} → ` +
        `${formatCents(toAmountCents)} ${toCurrency}.${rateLine} ` +
        `Балансы счетов «${from.name}» и «${to.name}» обновлены.`,
      data: {
        transaction_id: result.out.id,
        group_id: result.groupId,
        from_account_id: from.id,
        from_account_name: from.name,
        from_cents: fromAmountCents,
        from_currency: fromCurrency,
        to_account_id: to.id,
        to_account_name: to.name,
        to_cents: toAmountCents,
        to_currency: toCurrency,
        ...(rateTable ? { rate_date: rateTable.date, rate_stale: rateTable.stale } : {}),
      },
    };
  } catch (error) {
    return fail(`Не удалось выполнить обмен: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// set_budget
// ---------------------------------------------------------------------------

/** Установить месячный лимит бюджета по категории (EUR). */
async function setBudgetTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const categoryName = requiredString(args, 'category_name');
  if (!categoryName) return fail('Укажите категорию бюджета: category_name.');

  const limitCents = centsArg(args.limit_amount_eur);
  if (limitCents === null) {
    return fail(
      `Не понял лимит «${String(args.limit_amount_eur)}» — передайте сумму в EUR, например 300.`,
    );
  }
  if (limitCents <= 0) return fail('Лимит бюджета должен быть больше нуля.');

  try {
    const month = monthKey(ctx.now, ctx.timezone);
    const budget = await setBudget(ctx.userId, {
      month,
      categoryName,
      limitAmountEurCents: limitCents,
    });
    return {
      ok: true,
      content:
        `Установил бюджет на ${month}: «${categoryName}» — ${formatCents(budget.limitAmountEurCents)} €`,
      data: {
        budget_id: budget.id,
        month: budget.month,
        category_id: budget.categoryId,
        limit_cents: budget.limitAmountEurCents,
      },
    };
  } catch (error) {
    return fail(`Не удалось установить бюджет: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// query_spending
// ---------------------------------------------------------------------------

const TRANSACTION_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 40;

interface SpendingBucket {
  categoryId: number | null;
  name: string;
  spentCents: number;
  budgetCents: number | null;
}

/** Расходы текущего месяца по категориям в сравнении с бюджетами. */
async function querySpending(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const month = monthKey(ctx.now, ctx.timezone);
    const budgets = await listBudgets(ctx.userId, month);
    const budgetByCategory = new Map<number, number>();
    for (const budget of budgets) {
      budgetByCategory.set(budget.categoryId, budget.limitAmountEurCents);
    }

    const categories = await listCategories(ctx.userId);
    const categoryNames = new Map<number, string>();
    for (const category of categories) categoryNames.set(category.id, category.name);

    // Начало месяца в контексте пользователя: `YYYY-MM-01T00:00:00`.
    const from = `${month}-01T00:00:00`;
    const transactions: TransactionRow[] = [];
    for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
      const batch = await listTransactions(ctx.userId, {
        from,
        to: ctx.now,
        kind: 'expense',
        limit: TRANSACTION_PAGE_SIZE,
        offset: page * TRANSACTION_PAGE_SIZE,
      });
      transactions.push(...batch);
      if (batch.length < TRANSACTION_PAGE_SIZE) break;
    }

    const buckets = new Map<number, SpendingBucket>();
    let totalCents = 0;
    for (const tx of transactions) {
      const key = tx.categoryId ?? -1;
      const existing = buckets.get(key);
      if (existing) {
        existing.spentCents += tx.amountEurCents;
      } else {
        const categoryId = tx.categoryId;
        buckets.set(key, {
          categoryId,
          name: categoryId === null ? 'Без категории' : (categoryNames.get(categoryId) ?? 'Без категории'),
          spentCents: tx.amountEurCents,
          budgetCents: categoryId === null ? null : (budgetByCategory.get(categoryId) ?? null),
        });
      }
      totalCents += tx.amountEurCents;
    }

    const items = [...buckets.values()].sort((a, b) => b.spentCents - a.spentCents);

    if (items.length === 0) {
      return {
        ok: true,
        content: `В текущем месяце (${month}) расходов пока не зафиксировано.`,
        data: { month, total_cents: 0, categories: [] },
      };
    }

    const lines = [`📊 Расходы за ${month}:`];
    for (const item of items) {
      if (item.budgetCents === null) {
        lines.push(`• ${item.name}: ${formatCents(item.spentCents)} € (бюджет —)`);
      } else {
        lines.push(
          `• ${item.name}: ${formatCents(item.spentCents)} € ` +
            `(бюджет ${formatCents(item.budgetCents)} €, ` +
            `остаток ${formatCents(item.budgetCents - item.spentCents)} €)`,
        );
      }
    }
    lines.push(`Итого: ${formatCents(totalCents)} €`);

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        month,
        total_cents: totalCents,
        categories: items.map((item) => ({
          name: item.name,
          spent_cents: item.spentCents,
          budget_cents: item.budgetCents,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось собрать расходы: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// get_fin_balances
// ---------------------------------------------------------------------------

/** Текущие балансы всех счетов и суммарно в EUR. */
async function getBalances(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const accounts = await listAccounts(ctx.userId, { includeInactive: true });
    if (accounts.length === 0) {
      return {
        ok: true,
        content: 'Пока нет ни одного счёта.',
        data: { accounts: [], total_eur_cents: 0 },
      };
    }

    const rates = await getRates();
    const lines = ['💰 Балансы счетов:'];
    let totalEurCents = 0;
    const skipped: string[] = [];

    for (const account of accounts) {
      lines.push(
        `• ${account.name} (${account.currency}): ${formatMoney(
          account.currentBalanceCents,
          account.currency,
        )}`,
      );
      try {
        totalEurCents += toBaseCents(account.currentBalanceCents, account.currency, rates);
      } catch {
        skipped.push(account.name);
      }
    }

    lines.push(`Итого в EUR: ${formatCents(totalEurCents)} €`);
    if (skipped.length > 0) {
      lines.push(`Без курса (не учтено в итоге): ${skipped.join(', ')}`);
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          currency: account.currency,
          balance_cents: account.currentBalanceCents,
        })),
        total_eur_cents: totalEurCents,
        skipped,
      },
    };
  } catch (error) {
    return fail(`Не удалось получить балансы: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// get_fx_rates
// ---------------------------------------------------------------------------

/** Живые курсы валют: дата, база и сколько единиц валюты за 1 базовую. */
async function getFxRates(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const latest = await getLatestRate();
    if (!latest) {
      return fail(
        'Курсов валют ещё нет. Обмен считать не по чему — заведи курс за сегодня и повтори.',
      );
    }
    const entries = Object.entries(latest.rates).sort(([a], [b]) => a.localeCompare(b));
    const lines = [`Курсы на ${latest.date} (база ${latest.base}), 1 ${latest.base} =`];
    for (const [code, rate] of entries) {
      lines.push(`• ${rate} ${code}`);
    }
    const age = daysBetween(latest.date, normalizeDate(ctx.now));
    if (age > MAX_FX_AGE_DAYS) {
      lines.push(`⚠️ Курс устарел: это ${age} дн. назад, для обмена нужен курс на сегодня.`);
    }
    return {
      ok: true,
      content: lines.join('\n'),
      data: { date: latest.date, base: latest.base, rates: { ...latest.rates }, age_days: age },
    };
  } catch (error) {
    return fail(`Не удалось прочитать курсы: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// set_fx_rate
// ---------------------------------------------------------------------------

/**
 * Задать живой курс валюты на сегодня: сколько единиц валюты за 1 EUR.
 *
 * Единственный способ поддерживать `fx_rates` в рантайме (фонового поставщика
 * курсов нет), поэтому конвертация опирается на курс, который владелец назвал
 * сам. Существующая строка за сегодня дополняется, а не перезаписывается.
 */
async function setFxRate(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const code = stringArg(args, 'code')?.toUpperCase();
  if (!code) return fail('Укажи код валюты, например USD.');

  const perEur = Number(String(args.per_eur ?? '').replace(',', '.'));
  if (!Number.isFinite(perEur) || perEur <= 0) {
    return fail(
      'Курс должен быть положительным числом: сколько единиц валюты за 1 EUR, например 0.92.',
    );
  }

  try {
    const today = normalizeDate(ctx.now);
    const existing = await getRate(today);
    const normalized = normalizeCurrency(code);
    const rates = { ...(existing?.rates ?? {}), [normalized]: perEur };
    const saved = await setRates(today, rates);
    return {
      ok: true,
      content: `Курс на ${saved.date} сохранён: 1 ${BASE_CURRENCY} = ${perEur} ${normalized}.`,
      data: {
        date: saved.date,
        base: saved.base,
        code: normalized,
        per_eur: perEur,
      },
    };
  } catch (error) {
    return fail(`Не удалось сохранить курс: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// set_account_balance
// ---------------------------------------------------------------------------

/** Установить точный баланс счёта (создать счёт, если его ещё нет). */
async function setAccountBalanceTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const name = requiredString(args, 'account_name');
  if (!name) return fail('Укажите счёт: account_name.');

  const currency = stringArg(args, 'currency')?.toUpperCase();
  const newBalanceCents = centsArg(args.new_balance);
  if (newBalanceCents === null) {
    return fail(
      `Не понял баланс «${String(args.new_balance)}» — передайте сумму, например 350.`,
    );
  }

  try {
    const existing = await findAccountByName(ctx.userId, name, currency);
    if (existing) {
      if (
        existing.currentBalanceCents > 0 &&
        newBalanceCents === 0 &&
        args.confirm !== true
      ) {
        return drainConfirmation(existing, existing.currentBalanceCents);
      }
      const updated = await setAccountBalance(ctx.userId, existing.id, newBalanceCents);
      return {
        ok: true,
        content:
          `Баланс счёта «${updated.name}» (${updated.currency}) установлен: ` +
          `${formatCents(updated.currentBalanceCents)} ${updated.currency}.`,
        data: { account_id: updated.id, balance_cents: updated.currentBalanceCents, created: false },
      };
    }

    const created = await createAccount(ctx.userId, {
      name,
      ...(currency ? { currency } : {}),
      initialBalanceCents: newBalanceCents,
    });
    return {
      ok: true,
      content:
        `Баланс счёта «${created.name}» (${created.currency}) установлен: ` +
        `${formatCents(created.currentBalanceCents)} ${created.currency}.`,
      data: { account_id: created.id, balance_cents: created.currentBalanceCents, created: true },
    };
  } catch (error) {
    return fail(`Не удалось установить баланс: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// reset_finance_history
// ---------------------------------------------------------------------------

/** Стереть всю историю транзакций (балансы счетов сохраняются). */
async function resetFinanceHistory(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  if (args.confirm !== true) {
    return {
      ok: true,
      content:
        'Это удалит ВСЮ историю транзакций (балансы счетов сохранятся). ' +
        'Если уверены — вызовите reset_finance_history с confirm=true.',
      data: { confirm: false },
    };
  }

  try {
    const deleted = await resetTransactions(ctx.userId);
    return {
      ok: true,
      content: `Удалено транзакций: ${deleted}. Балансы счетов сохранены.`,
      data: { confirm: true, deleted },
    };
  } catch (error) {
    return fail(`Не удалось очистить историю: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// undo_last_transaction
// ---------------------------------------------------------------------------

/** Отменить последнюю транзакцию (опционально — по конкретному счёту). */
async function undoLastTransactionTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const accountName = stringArg(args, 'account_name');

  try {
    let accountId: number | undefined;
    if (accountName) {
      const account = await findAccountByName(ctx.userId, accountName);
      if (!account) {
        const accounts = await listAccounts(ctx.userId, { includeInactive: true });
        return fail(`Счёт «${accountName}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
      }
      accountId = account.id;
    }

    // Группу обмена читаем до отката: после него строк уже нет.
    const last = await findLastTransaction(ctx.userId, {
      ...(accountId !== undefined ? { accountId } : {}),
    });
    const exchangeLegs =
      last?.kind === 'exchange' && last.transferGroupId
        ? await getTransactionGroup(ctx.userId, last.transferGroupId)
        : [];

    const removed = await undoLastTransaction(ctx.userId, {
      ...(accountId !== undefined ? { accountId } : {}),
    });
    if (!removed) {
      return {
        ok: true,
        content: 'Нет транзакций для отмены.',
        data: { transaction_id: null },
      };
    }

    if (removed.kind === 'exchange' && removed.transferGroupId) {
      // Ноги добора с расчётного счёта — технические: в сообщении об отмене
      // показываем только исходящую и входящую.
      const legs = exchangeLegs.filter(
        (leg) => !(leg.description ?? '').endsWith(EXCHANGE_TOPUP_SUFFIX),
      );
      const outLeg = legs.find((leg) => leg.amountCents < 0);
      const inLeg = legs.find((leg) => leg.amountCents > 0);
      if (outLeg && inLeg) {
        return {
          ok: true,
          content:
            `Обмен ${formatCents(Math.abs(outLeg.amountCents))} ${outLeg.currency} → ` +
            `${formatCents(inLeg.amountCents)} ${inLeg.currency} отменён, балансы восстановлены.`,
          data: {
            transaction_id: removed.id,
            kind: removed.kind,
            group_id: removed.transferGroupId,
            out_transaction_id: outLeg.id,
            in_transaction_id: inLeg.id,
            from_cents: Math.abs(outLeg.amountCents),
            from_currency: outLeg.currency,
            to_cents: inLeg.amountCents,
            to_currency: inLeg.currency,
          },
        };
      }
    }

    const uncoveredCents = removed.uncoveredCents ?? 0;
    const returnedCents = removed.amountCents - uncoveredCents;
    return {
      ok: true,
      content:
        `Отменил последнюю транзакцию: ${transactionLabel(removed)} — ${formatCents(
          removed.amountCents,
        )} ${removed.currency}` +
        (uncoveredCents > 0
          ? ` (на счёт вернулось ${formatCents(returnedCents)} ${removed.currency})`
          : '') +
        '.',
      data: {
        transaction_id: removed.id,
        kind: removed.kind,
        amount_cents: removed.amountCents,
        currency: removed.currency,
        ...(uncoveredCents > 0
          ? { uncovered_cents: uncoveredCents, returned_cents: returnedCents }
          : {}),
      },
    };
  } catch (error) {
    return fail(`Не удалось отменить транзакцию: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// edit_last_transaction
// ---------------------------------------------------------------------------

/**
 * Исправить последнюю транзакцию: внутри DAL-транзакции отменяем её и создаём
 * новую с объединёнными полями. Переводы не редактируем (§8.3).
 */
async function editLastTransaction(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const accountName = stringArg(args, 'account_name');
  const categoryName = stringArg(args, 'category_name');
  const currency = stringArg(args, 'currency')?.toUpperCase();
  const description = stringArg(args, 'description');

  const amountRaw = args.amount;
  const amountCents =
    amountRaw === undefined || amountRaw === null || amountRaw === '' ? undefined : centsArg(amountRaw);
  if (amountCents === null) {
    return fail(`Не понял сумму «${String(amountRaw)}» — передайте число, например 15 или "15,50".`);
  }
  if (amountCents !== undefined && amountCents <= 0) {
    return fail('Новая сумма должна быть больше нуля.');
  }

  try {
    let accountId: number | undefined;
    if (accountName) {
      const account = await findAccountByName(ctx.userId, accountName);
      if (!account) {
        const accounts = await listAccounts(ctx.userId, { includeInactive: true });
        return fail(`Счёт «${accountName}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
      }
      accountId = account.id;
    }

    // Тот же выбор, что у отмены: служебная компенсация недокрытия не может
    // оказаться «последней транзакцией» — правится сам расход.
    const last = await findLastTransaction(ctx.userId, {
      ...(accountId !== undefined ? { accountId } : {}),
    });
    if (!last) return fail('Нет транзакций для редактирования.');
    if (last.kind === 'adjustment') {
      return fail(
        'Последняя строка — служебная компенсация недокрытия, а не операция. Отмените расход (undo_last_transaction) и запишите заново.',
      );
    }
    if (last.kind === 'transfer') {
      return fail(
        'Редактирование переводов не поддерживается. Отмените его (undo_last_transaction) и создайте заново.',
      );
    }
    if (last.kind === 'exchange') {
      return fail(
        'Редактирование обменов не поддерживается. Отмените его (undo_last_transaction) и создайте заново.',
      );
    }

    const nextAmountCents = amountCents ?? last.amountCents;
    const nextCurrency = currency ?? last.currency;
    const nextDescription = description ?? last.description;
    const nextCategoryName = categoryName;

    const created = await withTransaction(async () => {
      await undoLastTransaction(ctx.userId, { accountId: last.accountId });
      return createTransaction(ctx.userId, {
        kind: last.kind,
        amountCents: nextAmountCents,
        currency: nextCurrency,
        accountId: last.accountId,
        ...(nextCategoryName
          ? { categoryName: nextCategoryName }
          : last.categoryId !== null
            ? { categoryId: last.categoryId }
            : {}),
        ...(nextDescription !== null ? { description: nextDescription } : {}),
        occurredAt: last.occurredAt,
      });
    });

    return {
      ok: true,
      content: `Изменил последнюю транзакцию: ${transactionLabel(created)} — ${formatCents(
        created.amountCents,
      )} ${created.currency}.`,
      data: {
        new_transaction_id: created.id,
        replaced_transaction_id: last.id,
        amount_cents: created.amountCents,
        currency: created.currency,
      },
    };
  } catch (error) {
    return fail(`Не удалось изменить транзакцию: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// adjust_account_balance
// ---------------------------------------------------------------------------

/** Сдвинуть баланс счёта на дельту (может быть отрицательной). */
async function adjustAccountBalance(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const name = requiredString(args, 'account_name');
  if (!name) return fail('Укажите счёт: account_name.');

  const currency = stringArg(args, 'currency')?.toUpperCase();
  const deltaCents = centsArg(args.delta);
  if (deltaCents === null) {
    return fail(
      `Не понял дельту «${String(args.delta)}» — передайте сумму, например -25 или "12,50".`,
    );
  }
  if (deltaCents === 0) return fail('Дельта равна нулю — баланс не изменится.');

  try {
    const account = await findAccountByName(ctx.userId, name, currency);
    if (!account) {
      const accounts = await listAccounts(ctx.userId, { includeInactive: true });
      return fail(`Счёт «${name}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
    }

    const newBalanceCents = account.currentBalanceCents + deltaCents;
    if (newBalanceCents === 0 && account.currentBalanceCents > 0 && args.confirm !== true) {
      return drainConfirmation(account, Math.abs(deltaCents));
    }
    const updated = await setAccountBalance(ctx.userId, account.id, newBalanceCents);

    return {
      ok: true,
      content:
        `Скорректировал баланс «${updated.name}»: ` +
        `${formatCents(deltaCents, { withSign: true })} ${updated.currency} → ` +
        `теперь ${formatMoney(updated.currentBalanceCents, updated.currency)}.`,
      data: {
        account_id: updated.id,
        delta_cents: deltaCents,
        balance_cents: updated.currentBalanceCents,
      },
    };
  } catch (error) {
    return fail(`Не удалось скорректировать баланс: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// mark_liability_paid
// ---------------------------------------------------------------------------

/** Отметить платёж по обязательству за текущий месяц. */
async function markLiabilityPaid(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const liabilityName = requiredString(args, 'liability_name');
  if (!liabilityName) return fail('Укажите обязательство: liability_name.');

  const amountCents = optionalCents(args.amount);
  if (amountCents === null) {
    return fail(`Не понял сумму «${String(args.amount)}» — передайте число или не передавайте.`);
  }
  if (amountCents !== undefined && amountCents <= 0) {
    return fail('Сумма платежа должна быть больше нуля.');
  }

  const accountName = stringArg(args, 'account_name');
  const paymentDate = stringArg(args, 'payment_date');
  if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    return fail('Дата платежа должна быть в формате YYYY-MM-DD.');
  }

  const deductRaw = args.deduct_from_account;
  const deductFromAccount = typeof deductRaw === 'boolean' ? deductRaw : undefined;

  try {
    const result = await payLiability(ctx.userId, {
      liabilityName,
      ...(amountCents !== undefined ? { amountCents } : {}),
      ...(accountName ? { accountName } : {}),
      ...(deductFromAccount !== undefined ? { deductFromAccount } : {}),
      ...(paymentDate ? { paymentDate } : {}),
    });

    if (result.alreadyPaid) {
      return {
        ok: true,
        content: `«${result.liability.name}» уже отмечен оплаченным в этом месяце.`,
        data: { liability_id: result.liability.id, already_paid: true, month: result.month },
      };
    }

    const deducted =
      result.deducted && result.account
        ? ` Списано со счёта «${result.account.name}»: ` +
          `${formatCents(result.deductedCents)} ${result.account.currency}.`
        : '';

    return {
      ok: true,
      content:
        `✅ Отметил оплату: «${result.liability.name}» — ` +
        `${formatCents(result.amountCents)} ${result.currency} (${result.month}).${deducted}`,
      data: {
        liability_id: result.liability.id,
        amount_cents: result.amountCents,
        amount_eur_cents: result.amountEurCents,
        currency: result.currency,
        deducted: result.deducted,
        deducted_cents: result.deductedCents,
        account_id: result.account?.id ?? null,
        month: result.month,
        payment_date: result.paymentDate,
        transaction_id: result.transaction?.id ?? null,
      },
    };
  } catch (error) {
    if (error instanceof LiabilityNotFoundError) {
      const active = await listLiabilities(ctx.userId, 'active').catch(() => []);
      return fail(
        `Обязательство «${liabilityName}» не найдено. Активные обязательства: ${joinLiabilities(active)}.`,
      );
    }
    return fail(`Не удалось отметить платёж: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// link_liability_account
// ---------------------------------------------------------------------------

/** Привязать обязательство к счёту, с которого оно оплачивается. */
async function linkLiabilityAccount(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const liabilityName = requiredString(args, 'liability_name');
  const accountName = requiredString(args, 'account_name');
  if (!liabilityName || !accountName) {
    return fail('Укажите обязательство (liability_name) и счёт (account_name).');
  }

  try {
    const liability = await findLiabilityByName(ctx.userId, liabilityName);
    if (!liability) {
      const active = await listLiabilities(ctx.userId, 'active');
      return fail(
        `Обязательство «${liabilityName}» не найдено. Активные обязательства: ${joinLiabilities(active)}.`,
      );
    }

    const account = await findAccountByName(ctx.userId, accountName);
    if (!account) {
      const accounts = await listAccounts(ctx.userId, { includeInactive: true });
      return fail(`Счёт «${accountName}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
    }

    const updated = await updateLiability(ctx.userId, liability.id, { accountId: account.id });
    return {
      ok: true,
      content: `Привязал «${updated.name}» к счёту «${account.name}».`,
      data: { liability_id: updated.id, account_id: account.id },
    };
  } catch (error) {
    return fail(`Не удалось привязать счёт: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// get_liabilities
// ---------------------------------------------------------------------------

const QUEUE_LABELS: Readonly<Record<string, string>> = {
  subscription: 'Подписки',
  service: 'Услуги',
  queue_1: 'Очередь 1',
  queue_2: 'Очередь 2',
  queue_3: 'Очередь 3',
  queue_4: 'Очередь 4',
};

const QUEUE_ORDER: readonly string[] = [
  'subscription',
  'service',
  'queue_1',
  'queue_2',
  'queue_3',
  'queue_4',
];

/** Список активных обязательств и долгов с группировкой по очередям. */
async function getLiabilities(_args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const liabilities = await listLiabilities(ctx.userId, 'active');
    if (liabilities.length === 0) {
      return {
        ok: true,
        content: 'Активных обязательств нет. 🎉',
        data: { liabilities: [] },
      };
    }

    const accounts = await listAccounts(ctx.userId, { includeInactive: true });
    const accountNames = new Map<number, string>();
    for (const account of accounts) accountNames.set(account.id, account.name);

    const month = monthKey(ctx.now, ctx.timezone);
    const groups = new Map<string, LiabilityRow[]>();
    for (const item of liabilities) {
      const queue = String(item.queue);
      const bucket = groups.get(queue);
      if (bucket) bucket.push(item);
      else groups.set(queue, [item]);
    }

    const knownQueues = QUEUE_ORDER.filter((queue) => groups.has(queue));
    const otherQueues = [...groups.keys()].filter((queue) => !QUEUE_ORDER.includes(queue)).sort();

    const lines = ['📋 Ваши обязательства и долги:'];
    for (const queue of [...knownQueues, ...otherQueues]) {
      const items = groups.get(queue) ?? [];
      lines.push('');
      lines.push(`${QUEUE_LABELS[queue] ?? queue}:`);
      for (const item of items) {
        const monthlyCents =
          item.monthlyPaymentCents > 0 ? item.monthlyPaymentCents : item.amountCents;
        const payInfo =
          item.paymentDay !== null ? ` (оплатить до ${item.paymentDay} числа)` : '';
        const accountName = item.accountId !== null ? accountNames.get(item.accountId) : undefined;
        const accInfo = accountName ? ` [счёт: ${accountName}]` : '';
        const paidThisMonth =
          item.lastPaymentDate !== null && item.lastPaymentDate.slice(0, 7) === month;
        const paidMark = paidThisMonth ? ' [✅ Оплачен в этом месяце]' : '';
        lines.push(
          `• ${item.name}: ${formatCents(monthlyCents)} ${item.currency} ` +
            `до ${item.endDate ?? '—'}${payInfo}${accInfo}${paidMark}`,
        );
      }
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        liabilities: liabilities.map((item) => ({
          id: item.id,
          name: item.name,
          queue: String(item.queue),
          monthly_payment_cents:
            item.monthlyPaymentCents > 0 ? item.monthlyPaymentCents : item.amountCents,
          currency: item.currency,
          payment_day: item.paymentDay,
          end_date: item.endDate,
          account_id: item.accountId,
          paid_this_month:
            item.lastPaymentDate !== null && item.lastPaymentDate.slice(0, 7) === month,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось получить обязательства: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// can_i_afford
// ---------------------------------------------------------------------------

/**
 * «Могу ли я себе это позволить» — порт `check_affordability`
 * (`backend/app/services/financial_intelligence.py:19`).
 *
 * Считает от свободных денег и защищённый резерв не расходует: в TS-боте это
 * `spendableCents` из runway (деньги минус резерв под платежи счетов).
 * Вердикт: danger — сумма больше свободного; caution — влезает, но остаётся
 * меньше 50 €, запас меньше 7 дней или безопасный чек меньше 10 €/день.
 */
async function canAfford(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const amountCents = centsArg(args.amount);
  if (amountCents === null) {
    return fail(
      `Не понял сумму «${String(args.amount)}» — передайте число, например 100 или "100,00".`,
    );
  }
  if (amountCents <= 0) return fail('Сумма должна быть больше нуля.');

  const currency = (stringArg(args, 'currency') ?? 'EUR').toUpperCase();
  const itemName = stringArg(args, 'item_name') ?? '';

  try {
    const rates = await getRates();
    if (!hasRate(currency, rates)) {
      return fail(`Нет курса для ${currency} — не могу пересчитать сумму в EUR.`);
    }
    const amountEurCents = convert(amountCents, currency, BASE_CURRENCY, rates);

    const runway = await calculateRunway(ctx.userId, { now: ctx.now });

    const spendableBefore = runway.spendableCents;
    const spendableAfter = spendableBefore - amountEurCents;

    let runwayAfter = 0;
    let safeDailyAfter = 0;
    if (spendableAfter > 0) {
      runwayAfter =
        runway.dailyBurnCents > 0 ? Math.floor(spendableAfter / runway.dailyBurnCents) : 999;
      safeDailyAfter = Math.round(spendableAfter / Math.max(1, runway.horizonDays));
    }

    const reasons: string[] = [];
    let verdict: 'danger' | 'caution' | 'safe';

    if (amountEurCents > spendableBefore) {
      verdict = 'danger';
      const deficit = spendableBefore - amountEurCents;
      reasons.push(
        `Сумма ${formatCents(amountEurCents)} € больше свободных ${formatCents(spendableBefore)} € (не хватает ${formatCents(Math.abs(deficit))} €).`,
      );
      reasons.push(
        `Защищённый резерв ${formatCents(runway.reservedCents)} € зарезервирован под платежи и не расходуется.`,
      );
    } else if (runwayAfter < 7 || safeDailyAfter < 1000 || spendableAfter < 5000) {
      verdict = 'caution';
      if (spendableAfter < 5000) {
        reasons.push(`Свободных останется ${formatCents(spendableAfter)} € (порог 50.00 €).`);
      }
      if (runwayAfter < 7) reasons.push(`Запас дней снизится до ${runwayAfter} дн. (порог 7).`);
      if (safeDailyAfter < 1000) {
        reasons.push(
          `Безопасный чек в день снизится до ${formatCents(safeDailyAfter)} € (порог 10.00 €).`,
        );
      }
    } else {
      verdict = 'safe';
      reasons.push('Покупка укладывается в свободные деньги.');
    }

    const badge =
      verdict === 'danger' ? '🔴 Недоступно' : verdict === 'caution' ? '🟡 Осторожно' : '🟢 Доступно';

    const header = itemName ? ` «${itemName}»` : '';
    const amountText =
      currency === BASE_CURRENCY
        ? `${formatCents(amountCents)} ${currency}`
        : `${formatCents(amountCents)} ${currency} (~${formatCents(amountEurCents)} €)`;

    const lines = [
      `Доступность покупки${header}:`,
      `• Стоимость: ${amountText}`,
      `• Вердикт: ${badge}`,
      ...reasons.map((reason) => `• ${reason}`),
      '',
      'Влияние:',
      `• Свободные деньги: ${formatCents(spendableBefore)} € → ${formatCents(spendableAfter)} €`,
      `• Запас дней: ${runway.runwayDays} → ${runwayAfter}`,
      `• Безопасный чек в день: ${formatCents(runway.safeDailyCents)} € → ${formatCents(safeDailyAfter)} €`,
      `• Закрытие месяца сейчас: ${formatCents(runway.monthCloseGapCents)} € (плюс — не закрывается)`,
    ];

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        verdict,
        amount_cents: Math.round(amountCents),
        currency,
        amount_eur_cents: Math.round(amountEurCents),
        spendable_before_cents: Math.round(spendableBefore),
        spendable_after_cents: Math.round(spendableAfter),
        runway_before_days: Math.trunc(runway.runwayDays),
        runway_after_days: runwayAfter,
        safe_daily_before_cents: Math.round(runway.safeDailyCents),
        safe_daily_after_cents: safeDailyAfter,
        reserved_cents: Math.round(runway.reservedCents),
        daily_burn_cents: Math.round(runway.dailyBurnCents),
        month_close_gap_cents: Math.round(runway.monthCloseGapCents),
      },
    };
  } catch (error) {
    return fail(`Не удалось проверить доступность: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// add_liability / update_liability / delete_liability
// ---------------------------------------------------------------------------

/** Добавить новое обязательство, подписку, регулярный платёж, кредит или долг. */
async function addLiabilityTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const name = requiredString(args, 'name');
  if (!name) return fail('Укажите название обязательства или подписки (name).');

  const amountCents = optionalCents(args.amount);
  if (amountCents === null) {
    return fail(`Не понял сумму «${String(args.amount)}» — передайте число, например "20" или "19,99".`);
  }
  const monthlyCents = optionalCents(args.monthly_payment);
  if (monthlyCents === null) {
    return fail(
      `Не понял ежемесячный платёж «${String(args.monthly_payment)}» — передайте число, например "15,50".`,
    );
  }
  if (amountCents === undefined && monthlyCents === undefined) {
    return fail('Укажите сумму (amount) или ежемесячный платёж (monthly_payment).');
  }
  if ((amountCents !== undefined && amountCents < 0) || (monthlyCents !== undefined && monthlyCents < 0)) {
    return fail('Сумма обязательства не может быть отрицательной.');
  }

  const currency = (stringArg(args, 'currency') ?? ctx.baseCurrency).toUpperCase();
  const queueRaw = stringArg(args, 'queue')?.toLowerCase();
  if (queueRaw && !VALID_LIABILITY_QUEUES.includes(queueRaw)) {
    return fail(
      `Неизвестная очередь «${queueRaw}». Допустимые: ${VALID_LIABILITY_QUEUES.join(', ')}.`,
    );
  }

  const paymentDay = intArg(args.payment_day);
  if (paymentDay === null || (paymentDay !== undefined && (paymentDay < 1 || paymentDay > 31))) {
    return fail('payment_day должен быть целым числом от 1 до 31.');
  }

  const totalPayments = intArg(args.total_payments);
  if (totalPayments === null || (totalPayments !== undefined && totalPayments < 0)) {
    return fail('total_payments должен быть целым числом ≥ 0.');
  }

  const endDate = stringArg(args, 'end_date');
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return fail('end_date должна быть в формате YYYY-MM-DD.');
  }

  const queue =
    queueRaw ??
    ((monthlyCents !== undefined || paymentDay !== undefined) && totalPayments === undefined
      ? 'subscription'
      : 'queue_1');
  const notes = stringArg(args, 'notes');
  const accountName = stringArg(args, 'account_name');

  try {
    let accountId: number | undefined;
    let resolvedAccountName: string | null = null;
    if (accountName) {
      const account = await findAccountByName(ctx.userId, accountName, currency);
      if (!account) {
        const accounts = await listAccounts(ctx.userId, { includeInactive: true });
        return fail(`Счёт «${accountName}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
      }
      accountId = account.id;
      resolvedAccountName = account.name;
    }

    const effectiveAmountCents = amountCents ?? monthlyCents ?? 0;
    const isRecurring = queue === 'subscription' || queue === 'service';
    const effectiveMonthlyCents = monthlyCents ?? (isRecurring ? effectiveAmountCents : 0);

    const created = await createLiability(ctx.userId, {
      name,
      queue: queue as LiabilityQueue,
      amountCents: effectiveAmountCents,
      currency,
      monthlyPaymentCents: effectiveMonthlyCents,
      ...(paymentDay !== undefined ? { paymentDay } : {}),
      ...(totalPayments !== undefined ? { totalPayments } : {}),
      ...(endDate ? { endDate } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
      ...(notes ? { notes } : {}),
    });

    const displayCents =
      created.monthlyPaymentCents > 0 ? created.monthlyPaymentCents : created.amountCents;
    const daySuffix = created.paymentDay !== null ? `, ${created.paymentDay}-е число` : '';
    const accountSuffix = resolvedAccountName ? ` [счёт: ${resolvedAccountName}]` : '';
    return {
      ok: true,
      content:
        `✅ Добавил обязательство «${created.name}» (${QUEUE_LABELS[String(created.queue)] ?? String(created.queue)}): ` +
        `${formatCents(displayCents)} ${created.currency}${daySuffix}${accountSuffix}.`,
      data: {
        liability_id: created.id,
        name: created.name,
        queue: String(created.queue),
        amount_cents: created.amountCents,
        monthly_payment_cents: created.monthlyPaymentCents,
        currency: created.currency,
        payment_day: created.paymentDay,
        account_id: created.accountId,
      },
    };
  } catch (error) {
    return fail(`Не удалось добавить обязательство: ${errorText(error)}`);
  }
}

/** Обновить параметры обязательства, подписки или долга. */
async function updateLiabilityTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const liabilityName = requiredString(args, 'liability_name');
  if (!liabilityName) return fail('Укажите обязательство: liability_name.');

  const newName = stringArg(args, 'new_name');
  const currency = stringArg(args, 'currency')?.toUpperCase();
  const amountCents = optionalCents(args.amount);
  if (amountCents === null) {
    return fail(`Не понял сумму «${String(args.amount)}» — передайте число.`);
  }
  if (amountCents !== undefined && amountCents < 0) {
    return fail('Сумма обязательства не может быть отрицательной.');
  }

  const monthlyCents = optionalCents(args.monthly_payment);
  if (monthlyCents === null) {
    return fail(`Не понял ежемесячный платёж «${String(args.monthly_payment)}» — передайте число.`);
  }
  if (monthlyCents !== undefined && monthlyCents < 0) {
    return fail('Ежемесячный платёж не может быть отрицательным.');
  }

  const queueRaw = stringArg(args, 'queue')?.toLowerCase();
  if (queueRaw && !VALID_LIABILITY_QUEUES.includes(queueRaw)) {
    return fail(
      `Неизвестная очередь «${queueRaw}». Допустимые: ${VALID_LIABILITY_QUEUES.join(', ')}.`,
    );
  }

  let paymentDay: number | null | undefined;
  if (args.payment_day === null || args.payment_day === 0 || args.payment_day === '0') {
    paymentDay = null;
  } else {
    const parsedDay = intArg(args.payment_day);
    if (parsedDay === null || (parsedDay !== undefined && (parsedDay < 1 || parsedDay > 31))) {
      return fail('payment_day должен быть от 1 до 31 (или 0 для сброса).');
    }
    paymentDay = parsedDay;
  }

  const totalPayments = intArg(args.total_payments);
  if (totalPayments === null || (totalPayments !== undefined && totalPayments < 0)) {
    return fail('total_payments должен быть целым числом ≥ 0.');
  }

  let endDate: string | null | undefined;
  if (args.end_date === null) {
    endDate = null;
  } else if (typeof args.end_date === 'string') {
    const raw = args.end_date.trim();
    if (raw === '' || raw.toLowerCase() === 'none') {
      endDate = null;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return fail('end_date должна быть в формате YYYY-MM-DD (или "none" для очистки).');
    } else {
      endDate = raw;
    }
  }

  const isActive = booleanArg(args.is_active);
  if (isActive === null) {
    return fail('is_active должен быть true или false.');
  }

  try {
    const existing = await findLiabilityAnyStatus(ctx.userId, liabilityName);
    if (!existing) {
      const active = await listLiabilities(ctx.userId, 'active');
      return fail(
        `Обязательство «${liabilityName}» не найдено. Активные обязательства: ${joinLiabilities(active)}.`,
      );
    }

    const patch: Parameters<typeof updateLiability>[2] = {};
    const changes: string[] = [];

    if (newName) {
      patch.name = newName;
      changes.push(`название: «${newName}»`);
    }
    if (queueRaw) {
      patch.queue = queueRaw as LiabilityQueue;
      changes.push(`очередь: ${QUEUE_LABELS[queueRaw] ?? queueRaw}`);
    }
    if (currency) {
      patch.currency = currency;
      changes.push(`валюта: ${currency}`);
    }
    if (amountCents !== undefined) {
      patch.amountCents = amountCents;
      changes.push(`сумма: ${formatCents(amountCents)} ${currency ?? existing.currency}`);
    }
    if (monthlyCents !== undefined) {
      patch.monthlyPaymentCents = monthlyCents;
      changes.push(`платёж/мес: ${formatCents(monthlyCents)} ${currency ?? existing.currency}`);
    }
    if (paymentDay !== undefined) {
      patch.paymentDay = paymentDay;
      changes.push(paymentDay === null ? 'день платежа сброшен' : `день платежа: ${paymentDay}`);
    }
    if (totalPayments !== undefined) {
      patch.totalPayments = totalPayments;
      changes.push(`осталось платежей: ${totalPayments}`);
    }
    if (endDate !== undefined) {
      patch.endDate = endDate;
      changes.push(endDate === null ? 'дата окончания сброшена' : `до ${endDate}`);
    }
    if (args.notes !== undefined) {
      const notes = args.notes === null ? null : String(args.notes).trim() || null;
      patch.notes = notes;
      changes.push(`заметка: ${notes ?? '—'}`);
    }
    if (isActive !== undefined) {
      patch.isActive = isActive;
      changes.push(isActive ? 'активно' : 'приостановлено/закрыто');
    }
    if (args.account_name !== undefined) {
      const rawAcc = args.account_name === null ? '' : String(args.account_name).trim();
      if (!rawAcc || rawAcc.toLowerCase() === 'none') {
        patch.accountId = null;
        changes.push('счёт отвязан');
      } else {
        const account = await findAccountByName(ctx.userId, rawAcc, currency ?? existing.currency);
        if (!account) {
          const accounts = await listAccounts(ctx.userId, { includeInactive: true });
          return fail(`Счёт «${rawAcc}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
        }
        patch.accountId = account.id;
        changes.push(`счёт: «${account.name}»`);
      }
    }

    if (changes.length === 0) {
      return fail(`Для обязательства «${existing.name}» не указано ни одного изменения.`);
    }

    const updated = await updateLiability(ctx.userId, existing.id, patch);
    return {
      ok: true,
      content: `✅ Обновил обязательство «${updated.name}» (${changes.join(', ')}).`,
      data: {
        liability_id: updated.id,
        name: updated.name,
        queue: String(updated.queue),
        amount_cents: updated.amountCents,
        monthly_payment_cents: updated.monthlyPaymentCents,
        currency: updated.currency,
        payment_day: updated.paymentDay,
        is_active: updated.isActive,
        changes,
      },
    };
  } catch (error) {
    return fail(`Не удалось обновить обязательство: ${errorText(error)}`);
  }
}

/** Удалить обязательство, подписку или долг из базы данных. */
async function deleteLiabilityTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const liabilityName = requiredString(args, 'liability_name');
  if (!liabilityName) return fail('Укажите обязательство для удаления: liability_name.');

  try {
    const existing = await findLiabilityAnyStatus(ctx.userId, liabilityName);
    if (!existing) {
      const active = await listLiabilities(ctx.userId, 'active');
      return fail(
        `Обязательство «${liabilityName}» не найдено. Активные обязательства: ${joinLiabilities(active)}.`,
      );
    }

    const deleted = await deleteLiability(ctx.userId, existing.id);
    if (!deleted) {
      return fail(`Не удалось удалить обязательство «${existing.name}».`);
    }

    const displayCents =
      existing.monthlyPaymentCents > 0 ? existing.monthlyPaymentCents : existing.amountCents;
    return {
      ok: true,
      content: `🗑️ Удалил обязательство «${existing.name}» (${formatCents(displayCents)} ${existing.currency}).`,
      data: {
        liability_id: existing.id,
        name: existing.name,
        queue: String(existing.queue),
        deleted: true,
      },
    };
  } catch (error) {
    return fail(`Не удалось удалить обязательство: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// update_account / delete_account
// ---------------------------------------------------------------------------

/** Обновить параметры счёта: имя, конверт (spendable/reserved) или активность. */
async function updateAccountTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const accountName = requiredString(args, 'account_name');
  if (!accountName) return fail('Укажите счёт: account_name.');

  const currency = stringArg(args, 'currency')?.toUpperCase();
  const newName = stringArg(args, 'new_name');
  const envelopeRaw = stringArg(args, 'envelope')?.toLowerCase();
  if (envelopeRaw && !VALID_ACCOUNT_ENVELOPES.includes(envelopeRaw as AccountEnvelope)) {
    return fail('envelope должен быть "spendable" (свободные) или "reserved" (резерв).');
  }
  const isActive = booleanArg(args.is_active);
  if (isActive === null) {
    return fail('is_active должен быть true или false.');
  }

  try {
    const resolution = await resolveSingleAccountForManagement(ctx, accountName, currency);
    if (isOutcome(resolution)) return resolution;
    const account = resolution.account;

    const patch: Parameters<typeof updateAccount>[2] = {};
    const changes: string[] = [];

    if (newName) {
      patch.name = newName;
      changes.push(`имя: «${newName}»`);
    }
    if (envelopeRaw) {
      patch.envelope = envelopeRaw as AccountEnvelope;
      changes.push(`конверт: ${envelopeRaw}`);
    }
    if (isActive !== undefined) {
      patch.isActive = isActive;
      changes.push(isActive ? 'активен' : 'деактивирован');
    }

    if (changes.length === 0) {
      return fail(`Для счёта «${account.name}» (${account.currency}) не указано изменений.`);
    }

    const updated = await updateAccount(ctx.userId, account.id, patch);
    return {
      ok: true,
      content: `✅ Обновил счёт «${updated.name}» (${updated.currency}): ${changes.join(', ')}.`,
      data: {
        account_id: updated.id,
        name: updated.name,
        currency: updated.currency,
        envelope: updated.envelope,
        is_active: updated.isActive,
        changes,
      },
    };
  } catch (error) {
    return fail(`Не удалось обновить счёт: ${errorText(error)}`);
  }
}

/** Удалить счёт без истории операций. */
async function deleteAccountTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const accountName = requiredString(args, 'account_name');
  if (!accountName) return fail('Укажите счёт для удаления: account_name.');

  const currency = stringArg(args, 'currency')?.toUpperCase();

  try {
    const resolution = await resolveSingleAccountForManagement(ctx, accountName, currency);
    if (isOutcome(resolution)) return resolution;
    const account = resolution.account;

    const deleted = await deleteAccount(ctx.userId, account.id);
    if (!deleted) {
      return fail(`Не удалось удалить счёт «${account.name}» (${account.currency}).`);
    }

    return {
      ok: true,
      content: `🗑️ Удалил счёт «${account.name}» (${account.currency}).`,
      data: {
        account_id: account.id,
        name: account.name,
        currency: account.currency,
        deleted: true,
      },
    };
  } catch (error) {
    const detail = errorText(error);
    if (detail.includes('has transactions')) {
      return fail(
        `Счёт «${accountName}» нельзя удалить, потому что по нему есть история операций. Его можно скрыть через update_account (is_active=false).`,
      );
    }
    return fail(`Не удалось удалить счёт: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// list_transactions / delete_transaction
// ---------------------------------------------------------------------------

/** Показать последние финансовые операции пользователя. */
async function listTransactionsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const accountName = stringArg(args, 'account_name');
  const kindRaw = stringArg(args, 'kind')?.toLowerCase();
  if (kindRaw && !VALID_TX_KINDS.includes(kindRaw as TransactionKind)) {
    return fail(`kind должен быть одним из: ${VALID_TX_KINDS.join(', ')}.`);
  }

  const limitArg = intArg(args.limit);
  if (limitArg === null || (limitArg !== undefined && limitArg <= 0)) {
    return fail('limit должен быть положительным целым числом.');
  }
  const limit = Math.min(100, limitArg ?? 20);

  try {
    const accounts = await listAccounts(ctx.userId, { includeInactive: true });
    const accountNames = new Map<number, string>();
    for (const acc of accounts) accountNames.set(acc.id, acc.name);

    let accountId: number | undefined;
    if (accountName) {
      const account = await findAccountByName(ctx.userId, accountName);
      if (!account) {
        return fail(`Счёт «${accountName}» не найден. Доступные счета: ${joinAccounts(accounts)}.`);
      }
      accountId = account.id;
    }

    const txs = await listTransactions(ctx.userId, {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(kindRaw ? { kind: kindRaw as TransactionKind } : {}),
      limit,
    });

    if (txs.length === 0) {
      return {
        ok: true,
        content: 'Финансовых операций пока нет.',
        data: { count: 0, transactions: [] },
      };
    }

    const lines = [`💳 Последние операции (${txs.length}):`];
    for (const tx of txs) {
      const acc = accountNames.get(tx.accountId) ?? `#${tx.accountId}`;
      const desc = tx.description ? ` — ${tx.description}` : '';
      lines.push(
        `• [#${tx.id}] ${tx.occurredAt.slice(0, 10)} | ${tx.kind} | ${formatCents(tx.amountCents)} ${tx.currency} | ${acc}${desc}`,
      );
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        count: txs.length,
        transactions: txs.map((tx) => ({
          id: tx.id,
          kind: tx.kind,
          amount_cents: tx.amountCents,
          currency: tx.currency,
          account_id: tx.accountId,
          account_name: accountNames.get(tx.accountId) ?? null,
          description: tx.description,
          occurred_at: tx.occurredAt,
        })),
      },
    };
  } catch (error) {
    return fail(`Не удалось получить операции: ${errorText(error)}`);
  }
}

/** Удалить и откатить финансовую операцию по id или описанию. */
async function deleteTransactionTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const txIdArg = intArg(args.transaction_id);
  if (txIdArg === null || (txIdArg !== undefined && txIdArg <= 0)) {
    return fail('transaction_id должен быть положительным целым числом.');
  }

  const query = stringArg(args, 'query');
  if (txIdArg === undefined && !query) {
    return fail('Укажите transaction_id (id операции из list_transactions) или query (описание).');
  }

  try {
    let targetId = txIdArg;
    if (targetId === undefined && query) {
      const recent = await listTransactions(ctx.userId, { limit: 50 });
      const needle = query.toLowerCase();
      const matched = recent.find((tx) =>
        `${tx.description ?? ''} ${tx.rawText ?? ''}`.toLowerCase().includes(needle),
      );
      if (!matched) {
        return fail(`Не нашёл недавнюю транзакцию по запросу «${query}».`);
      }
      targetId = matched.id;
    }

    const removed = await deleteTransaction(ctx.userId, targetId!);
    if (!removed) {
      return fail(`Транзакция #${String(targetId)} не найдена.`);
    }

    return {
      ok: true,
      content:
        `🗑️ Удалил транзакцию #${removed.id}: ${transactionLabel(removed)} — ` +
        `${formatCents(Math.abs(removed.amountCents))} ${removed.currency}, балансы пересчитаны.`,
      data: {
        transaction_id: removed.id,
        kind: removed.kind,
        amount_cents: removed.amountCents,
        currency: removed.currency,
        deleted: true,
      },
    };
  } catch (error) {
    return fail(`Не удалось удалить транзакцию: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

export const financeTools: Tool[] = [
  {
    name: 'add_expense',
    effect: { kind: 'create' },
    description:
      'Записать расход: сумма, валюта, счёт и категория. Если счёт не указан — берётся основной.',
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Сумма расхода, например "12,50".' },
        currency: { type: 'string', description: 'Валюта (по умолчанию — валюта счёта).' },
        account_name: { type: 'string', description: 'Название счёта списания.' },
        category_name: {
          type: 'string',
          description: 'Категория расхода (по умолчанию «Разное»).',
        },
        description: { type: 'string', description: 'Комментарий к расходу.' },
      },
      required: ['amount'],
    },
    run: addExpense,
  },
  {
    name: 'add_income',
    effect: { kind: 'create' },
    description: 'Записать доход: сумма, валюта, счёт и (опционально) категория.',
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Сумма дохода, например "1000".' },
        currency: { type: 'string', description: 'Валюта (по умолчанию — валюта счёта).' },
        account_name: { type: 'string', description: 'Название счёта зачисления.' },
        category_name: { type: 'string', description: 'Категория дохода.' },
        description: { type: 'string', description: 'Комментарий к доходу.' },
      },
      required: ['amount'],
    },
    run: addIncome,
  },
  {
    name: 'add_transfer',
    effect: { kind: 'create' },
    description: 'Перевести деньги между своими счетами (в одной валюте).',
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Сумма перевода.' },
        from_account: { type: 'string', description: 'Счёт, откуда переводим.' },
        to_account: { type: 'string', description: 'Счёт, куда переводим.' },
        currency: { type: 'string', description: 'Валюта перевода.' },
        description: { type: 'string', description: 'Комментарий к переводу.' },
        confirm: {
          type: 'boolean',
          description:
            'Подтверждение, если перевод опустошает счёт-источник. Спрашивай у пользователя; true — только после явного «да».',
        },
      },
      required: ['amount', 'from_account', 'to_account'],
    },
    run: addTransfer,
  },
  {
    name: 'add_exchange',
    effect: { kind: 'create' },
    description:
      'Обменять валюту между счетами: списать сумму в одной валюте и зачислить в другой. ' +
      'Если to_amount не указан, сумма зачисления считается по живому курсу и округляется вверх до ,99.',
    schema: {
      type: 'object',
      properties: {
        from_account: { type: 'string', description: 'Счёт-источник.' },
        from_amount: { type: 'string', description: 'Сколько списать.' },
        from_currency: { type: 'string', description: 'Валюта списания.' },
        to_account: { type: 'string', description: 'Счёт-получатель.' },
        to_amount: {
          type: 'string',
          description:
            'Сколько зачислить. Не указывай, если нужен расчёт по курсу: сумма посчитается сама и округлится вверх до ,99.',
        },
        to_currency: { type: 'string', description: 'Валюта зачисления.' },
        confirm: {
          type: 'boolean',
          description:
            'Подтверждение, если обмен опустошает счёт-источник. Спрашивай у пользователя; true — только после явного «да».',
        },
      },
      required: ['from_account', 'from_amount', 'from_currency', 'to_account', 'to_currency'],
    },
    run: addExchange,
  },
  {
    name: 'set_budget',
    effect: { kind: 'mutate' },
    description: 'Установить месячный лимит бюджета по категории расходов (в EUR).',
    schema: {
      type: 'object',
      properties: {
        category_name: { type: 'string', description: 'Категория расходов.' },
        limit_amount_eur: { type: 'string', description: 'Лимит на месяц в EUR.' },
      },
      required: ['category_name', 'limit_amount_eur'],
    },
    run: setBudgetTool,
  },
  {
    name: 'query_spending',
    effect: { kind: 'read' },
    description:
      'Показать расходы текущего месяца по категориям в сравнении с установленными бюджетами.',
    schema: { type: 'object', properties: {} },
    run: querySpending,
  },
  {
    name: 'can_i_afford',
    effect: { kind: 'read' },
    description:
      'Проверить, доступна ли покупка из свободных денег, не расходуя защищённый резерв под платежи. ' +
      'Возвращает вердикт (доступно / осторожно / недоступно) и влияние на запас дней.',
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Стоимость покупки.' },
        currency: { type: 'string', description: 'Валюта покупки, по умолчанию EUR.' },
        item_name: { type: 'string', description: 'Название товара или услуги.' },
      },
      required: ['amount'],
    },
    run: canAfford,
  },
  {
    name: 'get_fin_balances',
    effect: { kind: 'read' },
    description: 'Показать текущие балансы всех счетов и итог в EUR.',
    schema: { type: 'object', properties: {} },
    run: getBalances,
  },
  {
    name: 'get_fx_rates',
    effect: { kind: 'read' },
    description:
      'Показать живые курсы валют (дата, база, сколько единиц валюты за 1 базовую). Нужны для конвертации, чтобы не выдумывать курс.',
    schema: { type: 'object', properties: {} },
    run: getFxRates,
  },
  {
    name: 'set_fx_rate',
    effect: { kind: 'mutate' },
    description:
      'Сохранить живой курс валюты на сегодня: сколько единиц валюты за 1 EUR. Нужен, когда для обмена нет курса на дату операции.',
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код валюты, например USD.' },
        per_eur: {
          type: 'string',
          description: 'Сколько единиц валюты за 1 EUR, например 0.92 (база — EUR).',
        },
      },
      required: ['code', 'per_eur'],
    },
    run: setFxRate,
  },
  {
    name: 'set_account_balance',
    effect: { kind: 'mutate' },
    description: 'Установить точный баланс счёта (если счёта нет — создать его).',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Название счёта.' },
        currency: { type: 'string', description: 'Валюта счёта.' },
        new_balance: { type: 'string', description: 'Новый баланс, например "350,00".' },
        confirm: {
          type: 'boolean',
          description:
            'Подтверждение, если новый баланс — ноль при ненулевом текущем. Спрашивай у пользователя; true — только после явного «да».',
        },
      },
      required: ['account_name', 'new_balance'],
    },
    run: setAccountBalanceTool,
  },
  {
    name: 'reset_finance_history',
    effect: { kind: 'destroy', bulk: true },
    description:
      'Удалить всю историю транзакций. Требует подтверждения confirm=true; балансы счетов сохраняются.',
    schema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Подтверждение удаления истории.' },
      },
    },
    run: resetFinanceHistory,
  },
  {
    name: 'undo_last_transaction',
    // Корректировка-откат, а не уничтожение: строка операции удаляется, но балансы
    // возвращаются к состоянию до операции — защищаемый инвариант восстановлен, а сама
    // запись воспроизводима из raw-текста. Поэтому это `mutate`, а не `destroy`.
    effect: { kind: 'mutate' },
    description: 'Отменить последнюю транзакцию (по желанию — только по конкретному счёту).',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Счёт, по которому отменяем операцию.' },
      },
    },
    run: undoLastTransactionTool,
  },
  {
    name: 'edit_last_transaction',
    effect: { kind: 'mutate' },
    description:
      'Исправить последнюю транзакцию: сумму, валюту, категорию или описание. Переводы не редактируются.',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Счёт, к которому относится транзакция.' },
        category_name: { type: 'string', description: 'Новая категория.' },
        amount: { type: 'string', description: 'Новая сумма.' },
        currency: { type: 'string', description: 'Новая валюта.' },
        description: { type: 'string', description: 'Новое описание.' },
      },
    },
    run: editLastTransaction,
  },
  {
    name: 'adjust_account_balance',
    effect: { kind: 'mutate' },
    description: 'Скорректировать баланс счёта на дельту (положительную или отрицательную).',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Название счёта.' },
        currency: { type: 'string', description: 'Валюта счёта.' },
        delta: { type: 'string', description: 'Изменение баланса, например "-25,00".' },
        confirm: {
          type: 'boolean',
          description:
            'Подтверждение, если корректировка приводит баланс к нулю. Спрашивай у пользователя; true — только после явного «да».',
        },
      },
      required: ['account_name', 'delta'],
    },
    run: adjustAccountBalance,
  },
  {
    name: 'mark_liability_paid',
    effect: { kind: 'create' },
    description: 'Отметить платёж по обязательству за текущий месяц (по желанию — со списанием со счёта).',
    schema: {
      type: 'object',
      properties: {
        liability_name: { type: 'string', description: 'Название обязательства.' },
        amount: { type: 'string', description: 'Сумма платежа (по умолчанию — месячный платёж).' },
        account_name: { type: 'string', description: 'Счёт для списания.' },
        deduct_from_account: {
          type: 'boolean',
          description: 'Списать ли платёж с баланса счёта.',
        },
        payment_date: { type: 'string', description: 'Дата платежа YYYY-MM-DD.' },
      },
      required: ['liability_name'],
    },
    run: markLiabilityPaid,
  },
  {
    name: 'link_liability_account',
    effect: { kind: 'mutate' },
    description: 'Привязать обязательство к счёту, с которого оно оплачивается.',
    schema: {
      type: 'object',
      properties: {
        liability_name: { type: 'string', description: 'Название обязательства.' },
        account_name: { type: 'string', description: 'Название счёта.' },
      },
      required: ['liability_name', 'account_name'],
    },
    run: linkLiabilityAccount,
  },
  {
    name: 'get_liabilities',
    effect: { kind: 'read' },
    description:
      'Показать активные обязательства и долги с группировкой по очередям, сроками и статусом оплаты.',
    schema: { type: 'object', properties: {} },
    run: getLiabilities,
  },
  {
    name: 'add_liability',
    effect: { kind: 'create' },
    description:
      'Добавить новое обязательство, подписку, регулярный платёж, кредит или долг.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название обязательства, подписки или кредитора.' },
        amount: { type: 'string', description: 'Общая сумма долга или стоимость платежа.' },
        monthly_payment: { type: 'string', description: 'Ежемесячный платёж (для подписок и кредитов).' },
        currency: { type: 'string', description: 'Валюта (EUR, USD, RUB, KZT, TRY); по умолчанию базовая.' },
        queue: {
          type: 'string',
          description:
            'Очередь: subscription, service, bank, queue_1, queue_2, queue_3, queue_4, investors.',
        },
        payment_day: { type: 'integer', description: 'День списания в месяце (1–31).' },
        total_payments: { type: 'integer', description: 'Общее количество оставшихся платежей.' },
        end_date: { type: 'string', description: 'Дата окончания в формате YYYY-MM-DD.' },
        account_name: { type: 'string', description: 'Счёт для списания.' },
        notes: { type: 'string', description: 'Комментарий или условия.' },
      },
      required: ['name'],
    },
    run: addLiabilityTool,
  },
  {
    name: 'update_liability',
    effect: { kind: 'mutate' },
    description:
      'Обновить параметры существующего обязательства, подписки или долга (сумму, платёж, день, счёт, активность).',
    schema: {
      type: 'object',
      properties: {
        liability_name: { type: 'string', description: 'Текущее название обязательства.' },
        new_name: { type: 'string', description: 'Новое название.' },
        amount: { type: 'string', description: 'Новая общая сумма.' },
        monthly_payment: { type: 'string', description: 'Новый ежемесячный платёж.' },
        currency: { type: 'string', description: 'Новая валюта.' },
        queue: { type: 'string', description: 'Новая очередь.' },
        payment_day: { type: 'integer', description: 'Новый день платежа (1–31 или 0 для сброса).' },
        total_payments: { type: 'integer', description: 'Новое число платежей.' },
        end_date: { type: 'string', description: 'Новая дата окончания YYYY-MM-DD или "none".' },
        account_name: { type: 'string', description: 'Название счёта или "none" для отвязки.' },
        notes: { type: 'string', description: 'Новый комментарий.' },
        is_active: { type: 'boolean', description: 'true — активно, false — закрыто/пауза.' },
      },
      required: ['liability_name'],
    },
    run: updateLiabilityTool,
  },
  {
    name: 'delete_liability',
    effect: { kind: 'destroy' },
    description: 'Удалить обязательство, подписку или долг из базы (если отказался или закрыто).',
    schema: {
      type: 'object',
      properties: {
        liability_name: { type: 'string', description: 'Название обязательства или подписки.' },
      },
      required: ['liability_name'],
    },
    run: deleteLiabilityTool,
  },
  {
    name: 'update_account',
    effect: { kind: 'mutate' },
    description: 'Изменить настройки счёта: переименовать, поменять конверт (spendable/reserved) или скрыть.',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Текущее название счёта.' },
        currency: { type: 'string', description: 'Валюта субсчёта (если у банка несколько валют).' },
        new_name: { type: 'string', description: 'Новое название счёта.' },
        envelope: { type: 'string', description: 'Конверт: spendable (свободные) или reserved (резерв).' },
        is_active: { type: 'boolean', description: 'true — активен, false — скрыт.' },
      },
      required: ['account_name'],
    },
    run: updateAccountTool,
  },
  {
    name: 'delete_account',
    effect: { kind: 'destroy' },
    description: 'Удалить счёт без истории транзакций (если счёт не использовался).',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Название счёта.' },
        currency: { type: 'string', description: 'Валюта субсчёта (если у банка несколько валют).' },
      },
      required: ['account_name'],
    },
    run: deleteAccountTool,
  },
  {
    name: 'list_transactions',
    effect: { kind: 'read' },
    description: 'Показать последние финансовые операции с их id, датами, суммами и счетами.',
    schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Фильтр по названию счёта.' },
        kind: { type: 'string', description: 'Тип: expense, income, transfer, exchange.' },
        limit: { type: 'integer', description: 'Сколько операций показать (по умолчанию 20, макс. 100).' },
      },
    },
    run: listTransactionsTool,
  },
  {
    name: 'delete_transaction',
    // Корректировка-откат, а не уничтожение: строка операции удаляется, но балансы
    // возвращаются к состоянию до операции — денежный инвариант восстановлен. Тот же
    // класс, что у `undo_last_transaction`, поэтому `mutate`, а не `destroy`.
    effect: { kind: 'mutate' },
    description: 'Удалить и откатить финансовую операцию по её id или описанию, вернув балансы.',
    schema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'integer', description: 'Числовой id операции (из list_transactions).' },
        query: { type: 'string', description: 'Фрагмент описания недавней операции, если id не указан.' },
      },
    },
    run: deleteTransactionTool,
  },
];
