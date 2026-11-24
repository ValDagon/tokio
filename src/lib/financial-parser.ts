/**
 * Системный финансовый парсер быстрых транзакций (порт Python financial_parser.py).
 *
 * Распознает:
 *  - Расходы:
 *      • «500 кофе», «кофе 500», «15.50 eur обед», «обед 15.50 eur»
 *      • «Запиши -10€ с карты», «-10€ с карты», «- 10 € с карты»
 *      • «-10 eur Карта», «Минус 10 евро с карты»
 *      • «10€ с карты», «Запиши 10€ с карты»
 *      • «Запиши расход 10€ с карты», «Потратил 15€ с банка», «Списали 20$ с крипто»
 *      • «Купил кофе 3 eur», «Кофе 3 евро»
 *  - Доходы:
 *      • «+100€ на карту», «+1000 зарплата»
 *      • «Доход 500$ на крипто», «Пришло 1000 руб на банк», «Запиши доход 100€ на карту»
 *  - Балансы:
 *      • «Баланс карты 50€», «Остаток на карте 50 eur», «Баланс банк 5000 руб»
 *  - Переводы:
 *      • «Переведи 50€ с карты на Наличные», «Перевод 50 EUR Card -> Cash»
 *  - Обмены:
 *      • «Поменял 100 долларов на 92 евро», «обменял 100 usd на 92 eur»
 *      • «exchanged 100 usd for 92 eur»
 *
 * Отсекает:
 *  - Вопросы (содержащие '?')
 *  - Команды создания задач/напоминаний без финансового действия («Напомни купить молоко»)
 *  - Обычный диалог («Привет, как дела?»)
 */

import {
  createAccount,
  createExchange,
  createTransaction,
  ensureCategory,
  findAccountByName,
  findCategoryByName,
  findLiabilityByName,
  payLiability,
  setAccountBalance,
} from './dal/finances.js';
import { getRates } from './dal/fx.js';
import { createNote } from './dal/notes.js';
import { getOverlay } from './overlay.js';
import { loadUserPrefs, type FinancePrefs, type UserPrefs } from './prefs.js';
import { balanceSummary } from './summary.js';
import type { CurrencyCode } from './types.js';
import { formatCents, toCents } from './utils.js';

export type FinancialAction =
  | 'expense'
  | 'income'
  | 'balance'
  | 'transfer'
  | 'liability_pay'
  | 'exchange';

/** Один счёт в составном сообщении о балансах: «50€ наличкой, 100$ на карте». */
export interface BalanceEntry {
  account: string;
  amount: number;
  currency: string;
  /**
   * Точная сумма в целых центах. Когда задана, `amount` для расчёта не
   * используется: фото-снимок приходит уже в центах и не проходит через float.
   */
  amountCents?: number;
}

export interface ParsedFinancialIntent {
  action: FinancialAction;
  type: FinancialAction; // for compatibility with 'expense' | 'income'
  amount: number;
  currency: string;
  category: string;
  description: string;
  item?: string;
  account?: string | null;
  fromAccount?: string | null;
  toAccount?: string | null;
  /** Обмен: сколько списываем (обязательно вместе с `toAmount`). */
  fromAmount?: number;
  /** Обмен: валюта списания (обязательна). */
  fromCurrency?: string;
  /** Обмен: сколько зачисляем (обязательно вместе с `fromAmount`). */
  toAmount?: number;
  /** Обмен: валюта зачисления (обязательна). */
  toCurrency?: string;
  /** Все счета из составного сообщения. Для одиночного баланса — один элемент. */
  balances?: BalanceEntry[];
  rawText?: string;
  liabilityName?: string;
}

/** Счёт, чей остаток реально изменился. Для ответа по фактическим строкам. */
export interface AppliedBalance {
  accountId: number;
  name: string;
  currency: string;
  balanceCents: number;
  prevBalanceCents: number;
}

export interface FinancialExecutionResult {
  replyText: string;
  noteId?: number | null;
  transactionId?: number | null;
  action: FinancialAction;
  accountName: string;
  amount: number;
  currency: string;
  liabilityId?: number;
  month?: string;
  alreadyPaid?: boolean;
  /** Обновлённые счета действия `balance` (в порядке применения). */
  accounts?: AppliedBalance[];
}

/** Опции исполнения: их задаёт вызывающий, а не пользовательский текст. */
export interface ExecuteFinancialIntentOptions {
  /**
   * Не создавать счёт, если его нет. Так фото-скриншот с незнакомым банком не
   * заводит пустой счёт-призрак: несопоставленный остаток уходит в инбокс.
   */
  requireExistingAccount?: boolean;
  /** Писать ли аудиторскую заметку. `false` — только фото: там она не нужна. */
  createAuditNote?: boolean;
  /**
   * Вызывается сразу после записи каждого счёта действия `balance`.
   *
   * Нужно фото-пути: платформа не даёт транзакций, и при отказе на средине
   * списка вызывающий обязан знать, какие ряды уже применились.
   */
  onBalanceApplied?: (applied: AppliedBalance) => void;
}

/**
 * Счёт из снимка не сопоставлен с существующим счётом того же владельца.
 *
 * Отдельный тип, а не `Error` с текстом: фото обязано отличить «не смог
 * сопоставить» (в инбокс) от «не смог записать» (журнал и честный ответ).
 */
export class BalanceAccountUnresolvedError extends Error {
  constructor(
    readonly accountName: string,
    readonly currency: string,
  ) {
    super(`Не удалось сопоставить счёт «${accountName}» (${currency})`);
    this.name = 'BalanceAccountUnresolvedError';
  }
}

/**
 * Валюта, которой бот не знает.
 *
 * Экран банка печатает любой ISO-код. Подставить вместо него евро — соврать о
 * валюте остатка, поэтому отказ несёт исходный код и называет его владельцу.
 */
export class UnsupportedCurrencyError extends Error {
  constructor(readonly code: string) {
    super(`Валюта ${code} пока не поддерживается`);
    this.name = 'UnsupportedCurrencyError';
  }
}

export const CURRENCY_MAP: Record<string, string> = {  eur: 'EUR',
  евро: 'EUR',
  евр: 'EUR',
  '€': 'EUR',
  usd: 'USD',
  доллар: 'USD',
  доллара: 'USD',
  долларов: 'USD',
  долл: 'USD',
  бакс: 'USD',
  баксов: 'USD',
  '$': 'USD',
  usdt: 'USD',
  usdc: 'USD',
  rub: 'RUB',
  руб: 'RUB',
  рубля: 'RUB',
  рублей: 'RUB',
  р: 'RUB',
  '₽': 'RUB',
  kzt: 'KZT',
  тенге: 'KZT',
  тг: 'KZT',
  '₸': 'KZT',
  try: 'TRY',
  лир: 'TRY',
  лиры: 'TRY',
  '₺': 'TRY',
};

const DEFAULT_FALLBACK_RATES: Record<string, number> = {
  EUR: 1,
  USD: 1.08,
  RUB: 100,
  KZT: 500,
  TRY: 35,
};

export function resolveCurr(currStr?: string | null, defaultCurrency = 'EUR'): string {
  if (!currStr) return defaultCurrency.toUpperCase();
  const lower = currStr.toLowerCase().trim();
  return CURRENCY_MAP[lower] ?? defaultCurrency.toUpperCase();
}

/**
 * Строгое разрешение валюты — для сумм, пришедших из снимка экрана.
 *
 * `resolveCurr` мягкий: он обслуживает текстовые шаблоны, где незнакомый код
 * просто не совпадает с регуляркой. Сюда же попадают ISO-коды из Vision, и там
 * подставлять евро нельзя — неизвестный код уходит наверх отказом с исходной
 * валютой, а не превращается в EUR.
 */
export function resolveCurrencyStrict(
  currStr?: string | null,
  defaultCurrency = 'EUR',
): string {
  if (!currStr || !currStr.trim()) return defaultCurrency.toUpperCase();
  const lower = currStr.toLowerCase().trim();
  const known = CURRENCY_MAP[lower];
  if (known) return known;
  throw new UnsupportedCurrencyError(currStr.trim().toUpperCase());
}

const GENERIC_CARD_PATTERNS = ['карт', 'card', 'kartic', 'カード', 'счет', 'счёт'];

/**
 * Распознаёт явное название счёта в тексте по `overlay.manifest.finance`.
 * Возвращает `null`, если счёт не назван — в отличие от `resolveAccountFromContext`,
 * который в этом случае подставляет счёт по валюте из оверлея.
 */
export function matchExplicitAccount(
  accountText: string | null | undefined,
  currency: string,
  options?: { strictBrandOnly?: boolean; userFinancePrefs?: FinancePrefs | null },
): string | null {
  if (!accountText) return null;
  const curr = currency.toUpperCase().trim();
  const t = accountText.toLowerCase();
  const { finance } = getOverlay().manifest;
  const userAliases = options?.userFinancePrefs?.accountAliases ?? [];

  for (const alias of userAliases) {
    const matchedNonGeneric = alias.patterns.some((p) => {
      const lp = p.toLowerCase();
      return !GENERIC_CARD_PATTERNS.includes(lp) && t.includes(lp);
    });
    if (matchedNonGeneric) {
      return alias.account;
    }
  }

  for (const alias of finance.accountAliases) {
    const matchedNonGeneric = alias.patterns.some((p) => {
      const lp = p.toLowerCase();
      return !GENERIC_CARD_PATTERNS.includes(lp) && t.includes(lp);
    });
    if (matchedNonGeneric) {
      return alias.account;
    }
  }

  if (options?.strictBrandOnly) return null;

  for (const alias of userAliases) {
    if (alias.patterns.some((p) => t.includes(p.toLowerCase()))) {
      return alias.account;
    }
  }

  if (GENERIC_CARD_PATTERNS.some((p) => t.includes(p))) {
    return (
      finance.genericCardAccountByCurrency[curr] ??
      options?.userFinancePrefs?.defaultAccountByCurrency?.[curr] ??
      finance.defaultAccountByCurrency[curr] ??
      'Карта'
    );
  }

  for (const alias of finance.accountAliases) {
    if (alias.patterns.some((p) => t.includes(p.toLowerCase()))) {
      return alias.account;
    }
  }

  return null;
}

export function resolveAccountFromContext(
  accountText: string | null | undefined,
  currency: string,
  userFinancePrefs?: FinancePrefs | null,
): string {
  const curr = currency.toUpperCase().trim();
  const explicit = matchExplicitAccount(accountText, curr, { userFinancePrefs });
  if (explicit) return explicit;

  const { finance } = getOverlay().manifest;
  return (
    userFinancePrefs?.defaultAccountByCurrency?.[curr] ??
    finance.defaultAccountByCurrency[curr] ??
    finance.genericCardAccountByCurrency[curr] ??
    'Карта'
  );
}

export function detectCategoryFromText(text: string): string {
  const t = text.toLowerCase();
  if (
    [
      'кофе',
      'обед',
      'ужин',
      'завтрак',
      'еда',
      'ресторан',
      'кафе',
      'бургер',
      'пицца',
      'шаурма',
      'латте',
      'капучино',
      'coffee',
      'lunch',
      'dinner',
      'food',
    ].some((w) => t.includes(w))
  ) {
    return 'Кафе';
  }
  if (
    [
      'такси',
      'метро',
      'автобус',
      'бензин',
      'заправка',
      'каршеринг',
      'проезд',
      'поезд',
      'самолет',
      'авиа',
      'билет',
      'taxi',
      'uber',
      'transport',
    ].some((w) => t.includes(w))
  ) {
    return 'Транспорт';
  }
  if (
    [
      'продукт',
      'супермаркет',
      'магазин',
      'пятерочка',
      'вкусвилл',
      'магнит',
      'перекресток',
      'spar',
      'молоко',
      'хлеб',
      'сыр',
      'мясо',
      'рыба',
      'яйца',
      'market',
      'grocery',
    ].some((w) => t.includes(w))
  ) {
    return 'Супермаркет';
  }
  if (
    [
      'аптек',
      'лекарств',
      'таблетк',
      'витамин',
      'врач',
      'клиник',
      'pharmacy',
    ].some((w) => t.includes(w))
  ) {
    return 'Аптека';
  }
  if (
    [
      'подписк',
      'сервис',
      'chatgpt',
      'vpn',
      'хостинг',
      'subscription',
      'server',
      'cloud',
    ].some((w) => t.includes(w))
  ) {
    return 'Подписки';
  }
  if (
    [
      'покупк',
      'одежд',
      'обувь',
      'wb',
      'wildberries',
      'amazon',
    ].some((w) => t.includes(w))
  ) {
    return 'Покупки';
  }
  if (
    [
      'зарплат',
      'доход',
      'salary',
      'аванс',
      'премия',
    ].some((w) => t.includes(w))
  ) {
    return 'Доходы';
  }
  return 'Разное';
}

// Regex piece for currency symbols and words
// Symbols: € $ ₽ ₸ ₺
// Words: eur, usd, rub, kzt, try, евро, доллар, руб, р, тенге, лир etc.
const CURR_PART =
  '(?:[€$₽₸₺]|eur|евро|евр|usd|долларов|доллара|доллар|долл|баксов|бакс|usdt|usdc|rub|рублей|рубля|руб|р|kzt|тенге|тг|try|лиры|лир)';

/**
 * Глаголы обмена: «поменял», «обменял», «разменял», транслит «obmenyal»/
 * «pomenyal» и английские «exchanged 100 usd for 92 eur».
 */
const EXCHANGE_VERB =
  '(?:обмен(?:ял|яла|яли|ять|яй|яю|яем)?|помен(?:ял|яла|яли|ять|яй|яю|яем)?|размен(?:ял|яла|ять|яй)?|obmen(?:yal|yala|yat|yay)?|pomen(?:yal|yala|yat|yay)?|exchanged|exchange|converted|convert|swapped|swap|changed|change)';

/** Обменный глагол в начале фразы. `\b` после кириллицы не работает. */
const EXCHANGE_CUE = new RegExp(`^(?:я\\s+)?${EXCHANGE_VERB}(?=\\s|$)`, 'i');

function parseNumber(str: string): number {
  return Number.parseFloat(str.replace(',', '.'));
}

/**
 * Слова, которые означают операцию, а не состояние счёта. Если они есть,
 * сообщение обязан разбирать финансовый fast-path расходов/доходов/переводов,
 * а не парсер балансов.
 */
const NON_BALANCE_VERBS =
  /(оплатил|оплатила|погасил|погасила|заплатил|заплатила|потратил|потратила|потрачено|расход|трата|списали|списание|сняли|купил|купила|переведи|перевод|перекинул|пришло|получил|зачислили|доход|зарплат|напомни|задача)/i;

/** Префиксы, после которых идёт перечисление остатков: «у меня», «баланс», «итого». */
const BALANCE_PREFIX =
  /^(?:сейчас\s+у\s+меня|у\s+меня\s+сейчас|у\s+меня|на\s+данный\s+момент|итого|всего|на\s+счетах|на\s+счётах|на\s+счету|на\s+счёту|баланс|остаток)\s*[:\-—]?\s*/i;

const ACCOUNT_WORD = '[a-zA-Zа-яА-ЯёЁ.\\s\\-]+';
/** Жадный `ACCOUNT_WORD` съел бы «Касса на Резерв» целиком — для обмена ленивый. */
const ACCOUNT_WORD_LAZY = '[a-zA-Zа-яА-ЯёЁ.\\s\\-]+?';

interface BalanceSegment {
  entry: BalanceEntry;
  /** true, если счёт назван перед суммой: «наличными 50€». */
  accountFirst: boolean;
}

function parseBalanceSegment(
  segment: string,
  defaultCurrency: string,
  userFinancePrefs?: FinancePrefs | null,
): BalanceSegment | null {
  // «50€ наличкой», «100$ на крипто», «5000 руб карта»
  const amountFirst = segment.match(
    new RegExp(
      `^(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})\\s*(?:на\\s+|в\\s+|со\\s+|с\\s+)?(${ACCOUNT_WORD})$`,
      'i',
    ),
  );
  if (amountFirst) {
    const currency = resolveCurr(amountFirst[2], defaultCurrency);
    const account = matchExplicitAccount(amountFirst[3], currency, { userFinancePrefs });
    if (!account) return null;
    return {
      entry: { account, amount: parseNumber(amountFirst[1]!), currency },
      accountFirst: false,
    };
  }

  // «наличными 50€», «крипто 100$»
  const accountFirst = segment.match(
    new RegExp(
      `^(${ACCOUNT_WORD}?)\\s*[:\\-—]?\\s*(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})$`,
      'i',
    ),
  );
  if (accountFirst) {
    const currency = resolveCurr(accountFirst[3], defaultCurrency);
    const account = matchExplicitAccount(accountFirst[1], currency, { userFinancePrefs });
    if (!account) return null;
    return {
      entry: { account, amount: parseNumber(accountFirst[2]!), currency },
      accountFirst: true,
    };
  }

  return null;
}

/**
 * Снимок остатка в терминах балансового интента.
 *
 * Фото-путь не парсит суммы заново: он отдаёт уже посчитанные целые центы, а
 * этот адаптер собирает из них тот же `ParsedFinancialIntent`, что и текстовый
 * «у меня 50€ наличкой и 100$ на карте». Дальше работает один исполнитель.
 */
export interface BalanceSnapshotSegment {
  /** Имя счёта, уже сопоставленное с существующей строкой в БД. */
  account: string;
  amountCents: number;
  currency: string;
}

export function buildBalanceIntentFromSegments(
  segments: readonly BalanceSnapshotSegment[],
): ParsedFinancialIntent | null {
  if (segments.length === 0) return null;

  const entries: BalanceEntry[] = [];
  for (const segment of segments) {
    if (!Number.isInteger(segment.amountCents) || segment.amountCents < 0) return null;
    // Валюта снимка — строго: незнакомый код не становится евро.
    const currency = resolveCurrencyStrict(segment.currency);
    entries.push({
      account: segment.account,
      amount: segment.amountCents / 100,
      amountCents: segment.amountCents,
      currency,
    });
  }

  const first = entries[0]!;
  const accountsLabel = entries.map((entry) => entry.account).join(', ');
  return {
    action: 'balance',
    type: 'balance',
    amount: first.amount,
    currency: first.currency,
    category: 'Баланс',
    description: entries.length > 1 ? `Балансы: ${accountsLabel}` : `Баланс ${first.account}`,
    account: first.account,
    balances: entries,
  };
}

/**
 * Разбирает сообщения-состояния: «У меня 50€ наличкой и 100$ на карте».
 *
 * Принимается, только если:
 *  - в тексте нет глагола операции (иначе это расход/оплата, не баланс);
 *  - разобрались ВСЕ сегменты перечисления;
 *  - сегментов два и больше, ИЛИ есть маркер состояния («у меня», «баланс»),
 *    ИЛИ счёт назван перед суммой («наличными 50€»).
 *
 * Одиночное «50€ наличкой» намеренно остаётся расходом — так это и читается.
 */
export function parseBalanceDeclaration(
  text: string,
  defaultCurrency = 'EUR',
  userFinancePrefs?: FinancePrefs | null,
): ParsedFinancialIntent | null {
  const textClean = text.trim();
  if (!textClean || textClean.includes('?')) return null;
  if (NON_BALANCE_VERBS.test(textClean)) return null;

  let rest = textClean;
  let hadStateMarker = false;
  const withoutPrefix = rest.replace(BALANCE_PREFIX, '');
  if (withoutPrefix !== rest) {
    hadStateMarker = true;
    rest = withoutPrefix.replace(/^[\s:,\-—]+/, '').trim();
  }
  if (!rest) return null;

  const segments = rest
    .split(/\s*(?:[,;\n]|(?:\s+и\s+)|\s+плюс\s+)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  const parsed: BalanceSegment[] = [];
  for (const segment of segments) {
    const item = parseBalanceSegment(segment, defaultCurrency, userFinancePrefs);
    if (!item) return null;
    parsed.push(item);
  }

  const isSingleAccountFirst = parsed.length === 1 && parsed[0]!.accountFirst;
  if (parsed.length < 2 && !hadStateMarker && !isSingleAccountFirst) return null;

  const entries = parsed.map((item) => item.entry);
  const first = entries[0]!;
  const accountsLabel = entries.map((entry) => entry.account).join(', ');

  return {
    action: 'balance',
    type: 'balance',
    amount: first.amount,
    currency: first.currency,
    category: 'Баланс',
    description: entries.length > 1 ? `Балансы: ${accountsLabel}` : `Баланс ${first.account}`,
    account: first.account,
    balances: entries,
    rawText: textClean,
  };
}

/**
 * Парсит финансовый интент из пользовательского сообщения.
 */
export function parseFinancialIntent(
  text: string,
  defaultCurrency = 'EUR',
  userFinancePrefs?: FinancePrefs | null,
): ParsedFinancialIntent | null {
  const textClean = text.trim();
  if (!textClean) return null;

  // Reject questions
  if (textClean.includes('?')) return null;

  // 0. Состояние счетов: «У меня 50€ наличкой и 100$ на карте».
  // Проверяется до гейта напоминаний и до правил операций: это не операция.
  const balanceDeclaration = parseBalanceDeclaration(textClean, defaultCurrency, userFinancePrefs);
  if (balanceDeclaration) return balanceDeclaration;

  const lowerT = textClean.toLowerCase();

  // Reject reminders and tasks without financial verbs.
  // Границы заданы явно: \b в JS не работает после кириллицы.
  if (
    /^(напомни|задача|у меня|долг|сколько|покажи)(?=\s|$|[,.;:!])/i.test(lowerT) &&
    !/(списали|сняли|расход|баланс|остаток|трата|потратил|оплатил|доход|пришло)/i.test(lowerT)
  ) {
    return null;
  }

  // 0. Liability Payment Fast-Path:
  // e.g. «Я оплатил интернет со счёта», «погасил связь», «погасил связь 25 eur»
  const mLiab = textClean.match(
    new RegExp(
      `^(?:я\\s+)?(?:оплатил|оплатила|погасил|погасила|заплатил|заплатила)\\s+(?!расход\\b)(?!трату\\b)(?!\\d+)(.+?)(?:\\s+(\\d+(?:[.,]\\d{1,2})?)(?:\\s*(${CURR_PART}))?)?(?:\\s+(?:с|со|из|через)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+))?$`,
      'i',
    ),
  );
  if (mLiab) {
    const rawTarget = mLiab[1]?.trim() || '';
    const rawAmount = mLiab[2];
    const rawCurr = mLiab[3];
    const rawAccount = mLiab[4]?.trim() || null;

    const lowerTarget = rawTarget.toLowerCase();
    if (
      rawTarget &&
      !['привет', 'здравствуй', 'здравствуйте', 'номер', 'глава', 'шаг'].includes(lowerTarget)
    ) {
      const amount = rawAmount ? parseNumber(rawAmount) : 0;
      const currency = resolveCurr(rawCurr, defaultCurrency);
      const account = rawAccount
        ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
        : null;
      return {
        action: 'liability_pay',
        type: 'expense',
        amount,
        currency,
        category: 'Обязательства',
        description: rawTarget.charAt(0).toUpperCase() + rawTarget.slice(1),
        item: rawTarget,
        liabilityName: rawTarget,
        account,
        rawText: textClean,
      };
    }
  }

  // С суммой перед целью: «оплатил 50 eur интернет» / «оплатил 25 связь»
  const mLiabAmountFirst = textClean.match(
    new RegExp(
      `^(?:я\\s+)?(?:оплатил|оплатила|погасил|погасила|заплатил|заплатила)\\s+(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?\\s+(?:за\\s+|на\\s+)?(?!расход\\b)(?!трату\\b)(.+?)(?:\\s+(?:с|со|из|через)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+))?$`,
      'i',
    ),
  );
  if (mLiabAmountFirst) {
    const rawAmount = mLiabAmountFirst[1];
    const rawCurr = mLiabAmountFirst[2];
    const rawTarget = mLiabAmountFirst[3]?.trim() || '';
    const rawAccount = mLiabAmountFirst[4]?.trim() || null;

    if (
      rawTarget &&
      !['привет', 'здравствуй', 'здравствуйте', 'номер', 'глава', 'шаг'].includes(rawTarget.toLowerCase())
    ) {
      const amount = parseNumber(rawAmount!);
      const currency = resolveCurr(rawCurr, defaultCurrency);
      const account = rawAccount
        ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
        : null;
      return {
        action: 'liability_pay',
        type: 'expense',
        amount,
        currency,
        category: 'Обязательства',
        description: rawTarget.charAt(0).toUpperCase() + rawTarget.slice(1),
        item: rawTarget,
        liabilityName: rawTarget,
        account,
        rawText: textClean,
      };
    }
  }

  // 1. Balance Set / Update
  // e.g. 'Баланс карты 50€', 'Баланс карты: 50 eur', 'Остаток на карте 50 eur', 'Баланс банк 5000 руб'
  const mBal = textClean.match(
    new RegExp(
      `^(?:баланс|остаток)(?:\\s+(?:на|в|по|счета|счёта))?\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+?)[:\\s]+(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})$`,
      'i',
    ),
  );
  if (mBal) {
    const rawAccount = mBal[1]?.trim() || '';
    const amount = parseNumber(mBal[2]!);
    const currency = resolveCurr(mBal[3], defaultCurrency);
    const account = resolveAccountFromContext(rawAccount, currency, userFinancePrefs);
    return {
      action: 'balance',
      type: 'balance',
      amount,
      currency,
      category: 'Баланс',
      description: `Баланс ${account}`,
      account,
      rawText: textClean,
    };
  }

  // 2. Transfer
  // e.g. 'Переведи 50€ с карты на Наличные', 'Перевод 50 EUR Card -> Cash'
  const mTr = textClean.match(
    new RegExp(
      `^(?:переведи|перевод|перекинул|перебрось)\\s+(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?\\s+(?:с|со|из)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+?)\\s+(?:на|в)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+)$`,
      'i',
    ),
  );
  if (mTr) {
    const amount = parseNumber(mTr[1]!);
    const currency = resolveCurr(mTr[2], defaultCurrency);
    const fromAccount = mTr[3]?.trim();
    const toAccount = mTr[4]?.trim();
    return {
      action: 'transfer',
      type: 'transfer',
      amount,
      currency,
      category: 'Переводы',
      description: `Перевод ${fromAccount} ➔ ${toAccount}`,
      fromAccount,
      toAccount,
      rawText: textClean,
    };
  }

  // 2b. Exchange
  // e.g. 'Поменял 100 долларов на 92 евро', 'обменял 100 usd на 92 eur',
  //      'exchanged 100 usd for 92 eur'
  // Обе валюты и обе суммы обязательны: без второй ноги это не обмен.
  const mExch = textClean.match(
    new RegExp(
      `^(?:я\\s+)?${EXCHANGE_VERB}\\s+(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})\\s*(?:на|na|to|into|for|in|->|→)\\s*(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})(?:\\s+(?:с|со|из|from)\\s+(${ACCOUNT_WORD_LAZY}))?(?:\\s+(?:на|to|в|into)\\s+(${ACCOUNT_WORD_LAZY}))?$`,
      'i',
    ),
  );
  if (mExch) {
    const fromAmount = parseNumber(mExch[1]!);
    const fromCurrency = resolveCurr(mExch[2]!, defaultCurrency);
    const toAmount = parseNumber(mExch[3]!);
    const toCurrency = resolveCurr(mExch[4]!, defaultCurrency);
    const fromAccount = mExch[5]?.trim() || null;
    const toAccount = mExch[6]?.trim() || null;
    return {
      action: 'exchange',
      type: 'exchange',
      amount: fromAmount,
      currency: fromCurrency,
      fromAmount,
      fromCurrency,
      toAmount,
      toCurrency,
      fromAccount,
      toAccount,
      category: 'Обмен',
      description: `Обмен ${fromAmount} ${fromCurrency} → ${toAmount} ${toCurrency}`,
      rawText: textClean,
    };
  }
  if (EXCHANGE_CUE.test(textClean)) return null;

  // 3. Income
  // e.g. '+100€ на карту', '+1000 зарплата', 'Доход 500$ на крипто', 'Пришло 1000 руб на карту'
  const mInc = textClean.match(
    new RegExp(
      `^(?:\\+|плюс\\s+|запиши\\s+доход\\s+|доход\\s+|пришло\\s+|получил\\s+|зачислили\\s+)(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?(?:\\s+(?:на|в|через)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+?))?(?:\\s+(?:от|за)\\s+(.+)|\\s+(.+))?$`,
      'i',
    ),
  );
  if (mInc) {
    const amount = parseNumber(mInc[1]!);
    const currency = resolveCurr(mInc[2], defaultCurrency);
    const rawAccount = mInc[3]?.trim() || null;
    const account = rawAccount
      ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
      : null;
    const item = (mInc[4] || mInc[5] || 'Доход').trim();
    const category = detectCategoryFromText(item) === 'Разное' ? 'Доходы' : detectCategoryFromText(item);
    return {
      action: 'income',
      type: 'income',
      amount,
      currency,
      category,
      description: item.charAt(0).toUpperCase() + item.slice(1),
      item,
      account,
      rawText: textClean,
    };
  }

  // 4. Expense: Explicit minus
  // e.g. 'Запиши -10€ с карты', '-10€ с карты', '- 10 € с карты', '-10 eur карта', 'Минус 10 евро с карты'
  const mExpMinus = textClean.match(
    new RegExp(
      `^(?:запиши\\s+|добавь\\s+|внеси\\s+)?(?:[-–—]|минус\\s+)\\s*(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?(?:\\s+(?:с|со|из|через\\s+)?([a-zA-Zа-яА-ЯёЁ.\\s]+?))?(?:\\s+(?:на|за)\\s+(.+))?$`,
      'i',
    ),
  );
  if (mExpMinus) {
    const amount = parseNumber(mExpMinus[1]!);
    const currency = resolveCurr(mExpMinus[2], defaultCurrency);
    const rawAccount = mExpMinus[3]?.trim() || null;
    const account = rawAccount
      ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
      : null;
    const item = mExpMinus[4]?.trim() || 'Расход';
    const category = detectCategoryFromText(item);
    return {
      action: 'expense',
      type: 'expense',
      amount,
      currency,
      category,
      description: item.charAt(0).toUpperCase() + item.slice(1),
      item,
      account,
      rawText: textClean,
    };
  }

  // 5. Expense: Verb without item
  // e.g. 'Запиши расход 10€ с карты', 'Расход 10€ с карты', 'Потратил 15€ с банка', 'Списали 20$ с крипто'
  const mExpVerb = textClean.match(
    new RegExp(
      `^(?:запиши\\s+расход|запиши\\s+трату|расход|трата|потратил|потрачено|оплатил|оплата|списали|списание|сняли)\\s+(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?(?:\\s+(?:с|со|из|через\\s+)?([a-zA-Zа-яА-ЯёЁ.\\s]+?))?(?:\\s+(?:на|за)\\s+(.+))?$`,
      'i',
    ),
  );
  if (mExpVerb) {
    const amount = parseNumber(mExpVerb[1]!);
    const currency = resolveCurr(mExpVerb[2], defaultCurrency);
    const rawAccount = mExpVerb[3]?.trim() || null;
    const account = rawAccount
      ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
      : null;
    const item = mExpVerb[4]?.trim() || 'Расход';
    const category = detectCategoryFromText(item);
    return {
      action: 'expense',
      type: 'expense',
      amount,
      currency,
      category,
      description: item.charAt(0).toUpperCase() + item.slice(1),
      item,
      account,
      rawText: textClean,
    };
  }

  // 6. Expense: Amount with account preposition
  // e.g. '10€ с карты', 'Запиши 10€ с карты'
  const mExpAcc = textClean.match(
    new RegExp(
      `^(?:запиши\\s+|добавь\\s+|внеси\\s+)?(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})\\s+(?:с|со|из|через)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+?)(?:\\s+(?:на|за)\\s+(.+))?$`,
      'i',
    ),
  );
  if (mExpAcc) {
    const amount = parseNumber(mExpAcc[1]!);
    const currency = resolveCurr(mExpAcc[2], defaultCurrency);
    const rawAccount = mExpAcc[3]?.trim() || null;
    const account = rawAccount
      ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
      : null;
    const item = mExpAcc[4]?.trim() || 'Расход';
    const category = detectCategoryFromText(item);
    return {
      action: 'expense',
      type: 'expense',
      amount,
      currency,
      category,
      description: item.charAt(0).toUpperCase() + item.slice(1),
      item,
      account,
      rawText: textClean,
    };
  }

  // 7. Standard / Shorthand Expense:
  // 7a. Amount + Currency? + Item
  // e.g. '500 кофе', '15.50 eur обед', '500р кофе', '10€ кофе', '3 eur кофе'
  const mExpStd1 = textClean.match(
    new RegExp(
      `^(?:запиши\\s+|добавь\\s+)?(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?(?:\\s+(?:на|за))?\\s+([a-zA-Zа-яА-ЯёЁ\\s\\-]+?)(?:\\s+(?:с|со|из|через)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+))?$`,
      'i',
    ),
  );
  if (mExpStd1) {
    const amount = parseNumber(mExpStd1[1]!);
    const currMatch = mExpStd1[2];
    const item = mExpStd1[3]?.trim() || '';
    const rawAccount = mExpStd1[4]?.trim() || null;

    if (item && !/^(минут|секунд|час|часа|часов|дней|дня|день|год|года|лет)\b/i.test(item)) {
      const currency = resolveCurr(currMatch, defaultCurrency);
      const account = rawAccount
        ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
        : null;
      const category = detectCategoryFromText(item);
      return {
        action: 'expense',
        type: 'expense',
        amount,
        currency,
        category,
        description: item.charAt(0).toUpperCase() + item.slice(1),
        item,
        account,
        rawText: textClean,
      };
    }
  }

  // 7b. Item + Amount + Currency?
  // e.g. 'кофе 500', 'кофе 500р', 'кофе 3 евро', 'обед 15.50 eur', 'купил кофе 3 eur'
  const mExpStd2 = textClean.match(
    new RegExp(
      `^(?:запиши\\s+|добавь\\s+)?(?:купил|оплатил|расход\\s+)?([a-zA-Zа-яА-ЯёЁ\\s\\-]+?)\\s+(\\d+(?:[.,]\\d{1,2})?)\\s*(${CURR_PART})?(?:\\s+(?:с|со|из|через)\\s+([a-zA-Zа-яА-ЯёЁ.\\s]+))?$`,
      'i',
    ),
  );
  if (mExpStd2) {
    const item = mExpStd2[1]?.trim() || '';
    const amount = parseNumber(mExpStd2[2]!);
    const currMatch = mExpStd2[3];
    const rawAccount = mExpStd2[4]?.trim() || null;

    // Filter out commands or conversational words
    if (
      item &&
      !['привет', 'здравствуй', 'здравствуйте', 'номер', 'глава', 'шаг'].includes(item.toLowerCase())
    ) {
      const currency = resolveCurr(currMatch, defaultCurrency);
      const account = rawAccount
        ? resolveAccountFromContext(rawAccount, currency, userFinancePrefs)
        : null;
      const category = detectCategoryFromText(item);
      return {
        action: 'expense',
        type: 'expense',
        amount,
        currency,
        category,
        description: item.charAt(0).toUpperCase() + item.slice(1),
        item,
        account,
        rawText: textClean,
      };
    }
  }

  return null;
}

/**
 * Исполняет распознанный финансовый интент:
 *  - обновляет балансы счетов и создаёт транзакцию в БД;
 *  - создает аудиторскую запись в `notes` с transaction_id;
 *  - формирует сводку балансов и текст подтверждения.
 */
export async function executeFinancialIntent(
  userId: number,
  intent: ParsedFinancialIntent,
  rawText = '',
  options: ExecuteFinancialIntentOptions = {},
): Promise<FinancialExecutionResult> {
  const { action, amount, currency } = intent;
  const currCode = currency.toUpperCase() as CurrencyCode;
  const desc = intent.description || 'Операция';

  // Read rates or provide fallback rates
  const [existingRates, userPrefs] = await Promise.all([
    getRates(),
    loadUserPrefs(userId).catch((): UserPrefs => ({})),
  ]);
  const userFinancePrefs = userPrefs.finance;
  const rates = { ...DEFAULT_FALLBACK_RATES, ...existingRates };

  if (action === 'liability_pay') {
    const targetName = intent.liabilityName || intent.item || intent.description || '';
    const liability = await findLiabilityByName(userId, targetName);

    if (!liability) {
      // Неизвестное обязательство: если сумма указана, проводим как обычный расход
      if (amount && amount > 0) {
        return executeFinancialIntent(
          userId,
          {
            ...intent,
            action: 'expense',
            type: 'expense',
            category: detectCategoryFromText(targetName),
          },
          rawText,
          options,
        );
      }
      // Неизвестное обязательство без суммы: возвращаем null, чтобы smartIngest
      // передал сообщение дальше в агентный шаг и инбокс
      return null as unknown as FinancialExecutionResult;
    }

    const amountCents = amount && amount > 0 ? Math.round(amount * 100) : undefined;
    const accountName = intent.account
      ? resolveAccountFromContext(intent.account, liability.currency, userFinancePrefs)
      : undefined;

    const payRes = await payLiability(userId, {
      liabilityId: liability.id,
      liabilityName: liability.name,
      amountCents,
      accountName,
      deductFromAccount: accountName ? true : undefined,
    });

    if (payRes.alreadyPaid) {
      return {
        replyText: `ℹ️ Обязательство «${liability.name}» уже отмечено оплаченным в этом месяце (${payRes.month}).`,
        action: 'liability_pay',
        accountName: payRes.account?.name || '',
        amount: payRes.amountCents / 100,
        currency: payRes.currency,
        alreadyPaid: true,
        liabilityId: liability.id,
        month: payRes.month,
      };
    }

    const paidAmount = payRes.amountCents / 100;
    const amountStr = `${formatCents(toCents(paidAmount))} ${payRes.currency}`;
    const accountFormatted = intent.account || payRes.account?.name;
    const accountPart = accountFormatted ? ` с ${accountFormatted}` : '';
    const targetDisplay = intent.liabilityName || liability.name;
    const replyText = `✅ ${targetDisplay} оплачен: ${amountStr}${accountPart}`;

    const cleanTxt = `Оплата обязательства ${liability.name}: ${amountStr}${accountPart}`;
    const note = await createNote(userId, rawText || cleanTxt, {
      column: 'raw',
      metadata: {
        category: 'liability',
        action: 'liability_pay',
        liability_id: liability.id,
        liability_name: liability.name,
        month: payRes.month,
        amount: paidAmount,
        currency: payRes.currency,
        account_name: payRes.account?.name || null,
        transaction_id: payRes.transaction?.id || null,
        tags: ['финансы', 'обязательства'],
        status: 'inbox',
      },
    });

    return {
      replyText,
      noteId: note.id,
      transactionId: payRes.transaction?.id || null,
      action: 'liability_pay',
      accountName: payRes.account?.name || '',
      amount: paidAmount,
      currency: payRes.currency,
      liabilityId: liability.id,
      month: payRes.month,
      alreadyPaid: false,
    };
  }

  if (action === 'expense' || action === 'income') {
    const kind = action;
    const accountName = resolveAccountFromContext(
      intent.account || rawText,
      currCode,
      userFinancePrefs,
    );
    const categoryName = intent.category || (kind === 'expense' ? 'Разное' : 'Доходы');

    // 1. Ensure or find account
    let account = await findAccountByName(userId, accountName, currCode);
    if (!account) {
      account = await createAccount(userId, {
        name: accountName,
        currency: currCode,
        initialBalanceCents: 0,
      });
    }

    // 2. Ensure category
    let category = await findCategoryByName(userId, categoryName, kind);
    if (!category) {
      category = await ensureCategory(userId, categoryName, kind);
    }

    // 3. Create transaction
    const amountCents = Math.round(amount * 100);
    const tx = await createTransaction(userId, {
      kind,
      amountCents,
      currency: currCode,
      accountId: account.id,
      categoryId: category.id,
      description: desc,
      rawText: rawText || undefined,
      rates,
    });

    // 4. Create audit note
    const cleanTxt =
      kind === 'expense'
        ? `Расход ${formatCents(toCents(amount))} ${currCode} (${account.name}): ${desc}`
        : `Доход +${formatCents(toCents(amount))} ${currCode} (${account.name}): ${desc}`;

    const note = await createNote(userId, rawText || cleanTxt, {
      column: 'raw',
      metadata: {
        category: kind,
        action: kind,
        amount,
        currency: currCode,
        account_name: account.name,
        transaction_id: tx.id,
        tags: ['финансы', kind === 'expense' ? 'расходы' : 'доходы'],
        status: 'inbox',
      },
    });

    // 5. Get updated balance summary
    const balSummary = await balanceSummary(userId);

    // Недокрытие: расход записан целиком, но остаток счёта его не покрыл.
    // Молчать об этом нельзя — книга разойдётся с банком.
    const uncoveredCents = tx.uncoveredCents ?? 0;
    const uncoveredNote =
      kind === 'expense' && uncoveredCents > 0
        ? `\n⚠️ Остаток счёта не покрыл <b>${formatCents(uncoveredCents)} ${account.currency}</b> — ` +
          `записано как непокрытая разница. Обнови баланс «${account.name}», когда увидишь реальный остаток.`
        : '';

    const replyText =
      kind === 'expense'
        ? `💸 <b>Расход зафиксирован:</b>\n` +
          `• ${desc}: <b>${formatCents(toCents(amount))} ${currCode}</b> (со счёта ${account.name})\n` +
          `• Категория: ${category.name}${uncoveredNote}\n\n` +
          `${balSummary}`
        : `💰 <b>Доход зафиксирован:</b>\n` +
          `• ${desc}: <b>+${formatCents(toCents(amount))} ${currCode}</b> (на счёт ${account.name})\n\n` +
          `${balSummary}`;

    return {
      replyText,
      noteId: note.id,
      transactionId: tx.id,
      action: kind,
      accountName: account.name,
      amount,
      currency: currCode,
    };
  }

  if (action === 'balance') {
    const entries: BalanceEntry[] =
      intent.balances && intent.balances.length > 0
        ? intent.balances
        : [
            {
              account: resolveAccountFromContext(
                intent.account || rawText,
                currCode,
                userFinancePrefs,
              ),
              amount,
              currency: currCode,
            },
          ];

    const applied: Array<{
      accountId: number;
      account: string;
      currency: string;
      prev: number;
      next: number;
      nextCents: number;
      prevCents: number;
    }> = [];

    for (const entry of entries) {
      const entryCurr = entry.currency.toUpperCase() as CurrencyCode;
      let account = await findAccountByName(userId, entry.account, entryCurr);
      if (!account) {
        if (options.requireExistingAccount) {
          throw new BalanceAccountUnresolvedError(entry.account, entryCurr);
        }
        account = await createAccount(userId, {
          name: entry.account,
          currency: entryCurr,
          initialBalanceCents: 0,
        });
      }
      // Строгий режим (фото) не двигает чужую валюту: счёт обязан совпасть.
      if (options.requireExistingAccount && account.currency.toUpperCase() !== entryCurr) {
        throw new BalanceAccountUnresolvedError(entry.account, entryCurr);
      }

      const nextCents = entry.amountCents ?? Math.round(entry.amount * 100);
      if (options.requireExistingAccount && (!Number.isInteger(nextCents) || nextCents < 0)) {
        throw new BalanceAccountUnresolvedError(entry.account, entryCurr);
      }

      const prevBal = account.currentBalanceCents / 100;
      const prevCents = account.currentBalanceCents;
      await setAccountBalance(userId, account.id, nextCents);
      const appliedRow = {
        accountId: account.id,
        account: account.name,
        currency: entryCurr,
        prev: prevBal,
        next: nextCents / 100,
        nextCents,
        prevCents,
      };
      applied.push(appliedRow);
      options.onBalanceApplied?.({
        accountId: appliedRow.accountId,
        name: appliedRow.account,
        currency: appliedRow.currency,
        balanceCents: appliedRow.nextCents,
        prevBalanceCents: appliedRow.prevCents,
      });
    }

    const isMulti = applied.length > 1;
    const [first] = applied;
    if (!first) return null as unknown as FinancialExecutionResult;

    const cleanTxt = isMulti
      ? applied
          .map(
            (item) =>
              `Баланс счёта ${item.account} (${item.currency}): ${formatCents(toCents(item.next))} ${item.currency}`,
          )
          .join('; ')
      : `Баланс счёта ${first.account} (${first.currency}) установлен: ${formatCents(toCents(first.next))} ${first.currency}`;

    const note = options.createAuditNote === false
      ? null
      : await createNote(userId, rawText || cleanTxt, {
          column: 'raw',
          metadata: isMulti
            ? {
                category: 'balance',
                action: 'balance',
                balances: applied.map((item) => ({
                  account_name: item.account,
                  prev_balance: item.prev,
                  amount: item.next,
                  currency: item.currency,
                })),
                tags: ['финансы', 'баланс'],
                status: 'inbox',
              }
            : {
                category: 'balance',
                action: 'balance',
                amount: first.next,
                prev_balance: first.prev,
                currency: first.currency,
                account_name: first.account,
                tags: ['финансы', 'баланс'],
                status: 'inbox',
              },
        });

    const balSummary = await balanceSummary(userId);
    const lines = applied.map(
      (item) =>
        `• ${item.account}: <b>${formatCents(toCents(item.next))} ${item.currency}</b> (было: ${formatCents(toCents(item.prev))} ${item.currency})`,
    );
    const replyText =
      `💳 <b>${isMulti ? 'Балансы обновлены' : 'Баланс счёта обновлён'}:</b>\n` +
      `${lines.join('\n')}\n\n` +
      `${balSummary}`;

    return {
      replyText,
      noteId: note?.id ?? null,
      transactionId: null,
      action: 'balance',
      accountName: applied.map((item) => item.account).join(', '),
      amount: first.next,
      currency: first.currency,
      accounts: applied.map((item) => ({
        accountId: item.accountId,
        name: item.account,
        currency: item.currency,
        balanceCents: item.nextCents,
        prevBalanceCents: item.prevCents,
      })),
    };
  }

  if (action === 'transfer') {
    const fromName = resolveAccountFromContext(intent.fromAccount, currCode, userFinancePrefs);
    const toName = resolveAccountFromContext(intent.toAccount, currCode, userFinancePrefs);

    let fromAcc = await findAccountByName(userId, fromName, currCode);
    if (!fromAcc) {
      fromAcc = await createAccount(userId, {
        name: fromName,
        currency: currCode,
        initialBalanceCents: 0,
      });
    }

    let toAcc = await findAccountByName(userId, toName, currCode);
    if (!toAcc) {
      toAcc = await createAccount(userId, {
        name: toName,
        currency: currCode,
        initialBalanceCents: 0,
      });
    }

    const amountCents = Math.round(amount * 100);
    const tx = await createTransaction(userId, {
      kind: 'transfer',
      amountCents,
      currency: currCode,
      accountId: fromAcc.id,
      toAccountId: toAcc.id,
      description: `Перевод: ${fromAcc.name} ➔ ${toAcc.name}`,
      rawText: rawText || undefined,
      rates,
    });

    const cleanTxt = `Перевод ${formatCents(toCents(amount))} ${currCode}: ${fromAcc.name} ➔ ${toAcc.name}`;
    const note = await createNote(userId, rawText || cleanTxt, {
      column: 'raw',
      metadata: {
        category: 'transfer',
        action: 'transfer',
        amount,
        currency: currCode,
        from_account: fromAcc.name,
        to_account: toAcc.name,
        transaction_id: tx.id,
        tags: ['финансы', 'перевод'],
        status: 'inbox',
      },
    });

    const balSummary = await balanceSummary(userId);
    const replyText =
      `🔄 <b>Перевод зафиксирован:</b>\n` +
      `• Переведено: <b>${formatCents(toCents(amount))} ${currCode}</b>\n` +
      `• Маршрут: ${fromAcc.name} ➔ ${toAcc.name}\n\n` +
      `${balSummary}`;

    return {
      replyText,
      noteId: note.id,
      transactionId: tx.id,
      action: 'transfer',
      accountName: fromAcc.name,
      amount,
      currency: currCode,
    };
  }

  if (action === 'exchange') {
    const fromAmount = intent.fromAmount ?? amount;
    const toAmount = intent.toAmount ?? 0;
    const fromCurrency = (intent.fromCurrency ?? currency).toUpperCase() as CurrencyCode;
    const toCurrency = (intent.toCurrency ?? currency).toUpperCase() as CurrencyCode;

    // Неполный обмен (нет второй ноги) — не записываем ничего и отдаём
    // сообщение агентному шагу.
    if (fromAmount <= 0 || toAmount <= 0) {
      return null as unknown as FinancialExecutionResult;
    }

    const fromName = resolveAccountFromContext(intent.fromAccount, fromCurrency, userFinancePrefs);
    const toName = resolveAccountFromContext(intent.toAccount, toCurrency, userFinancePrefs);

    let fromAcc = await findAccountByName(userId, fromName, fromCurrency);
    if (!fromAcc) {
      fromAcc = await createAccount(userId, {
        name: fromName,
        currency: fromCurrency,
        initialBalanceCents: 0,
      });
    }

    let toAcc = await findAccountByName(userId, toName, toCurrency);
    if (!toAcc) {
      toAcc = await createAccount(userId, {
        name: toName,
        currency: toCurrency,
        initialBalanceCents: 0,
      });
    }

    const exchange = await createExchange(userId, {
      fromAccountId: fromAcc.id,
      fromCents: Math.round(fromAmount * 100),
      fromCurrency,
      toAccountId: toAcc.id,
      toCents: Math.round(toAmount * 100),
      toCurrency,
      rawText: rawText || undefined,
      rates,
    });

    const cleanTxt =
      `Обмен ${formatCents(toCents(fromAmount))} ${fromCurrency} → ${formatCents(toCents(toAmount))} ${toCurrency}: ` +
      `${fromAcc.name} ➔ ${toAcc.name}`;
    const note = await createNote(userId, rawText || cleanTxt, {
      column: 'raw',
      metadata: {
        category: 'exchange',
        action: 'exchange',
        from_amount: fromAmount,
        from_currency: fromCurrency,
        to_amount: toAmount,
        to_currency: toCurrency,
        from_account: fromAcc.name,
        to_account: toAcc.name,
        transaction_id: exchange.out.id,
        transfer_group_id: exchange.groupId,
        tags: ['финансы', 'обмен'],
        status: 'inbox',
      },
    });

    const balSummary = await balanceSummary(userId);
    const replyText =
      `🔄 <b>Обмен зафиксирован:</b>\n` +
      `• ${formatCents(toCents(fromAmount))} ${fromCurrency} → <b>${formatCents(toCents(toAmount))} ${toCurrency}</b>\n` +
      `• ${fromAcc.name} ➔ ${toAcc.name}\n\n` +
      `${balSummary}`;

    return {
      replyText,
      noteId: note.id,
      transactionId: exchange.out.id,
      action: 'exchange',
      accountName: fromAcc.name,
      amount: fromAmount,
      currency: fromCurrency,
    };
  }

  throw new Error(`Неизвестное финансовое действие: ${action}`);
}
