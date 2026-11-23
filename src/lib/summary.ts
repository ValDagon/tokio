/**
 * Текстовые сводки: `/summary` (быстрая), `/balance`, `/debts`, `/tasks`,
 * `/meds` и справка `/help`.
 *
 * Порт `backend/app/services/summary.py`. Формат строк сохранён, но:
 *  - нейтральность (ADR-002): в коде нет имён счетов, банков и городов —
 *    всё приходит из БД; «конверт» счёта берётся из `accounts.envelope`;
 *  - деньги (ADR-003): целые центы, float-арифметики нет, округление
 *    выполняется ровно один раз — при выводе конкретного поля;
 *  - время: «сегодня» и «месяц» считаются в таймзоне пользователя
 *    (`users.timezone`), а не сервера.
 *
 * Модуль только читает данные через DAL и собирает строки — никаких побочных
 * эффектов, чтобы сводки можно было свободно переиспользовать в боте и в
 * mini app.
 */

import { BASE_CURRENCY, type RateTable, convert, getRates, hasRate, toEurCents } from './dal/fx';
import { listAccounts, listLiabilities, listTransactions } from './dal/finances';
import { listDoses } from './dal/medications';
import { kvGetJson, readLastModelFailure, readTurnTrace, type TurnTrace } from './dal/misc';
import {
  CLOCK_STALL_AFTER_MINUTES,
  clockHeartbeatKey,
  type ClockHeartbeat,
} from './jobs';
import { listCategories, listTasks } from './dal/tasks';
import { getUser } from './dal/users';
import { listFailureAggregates, type FailureAggregate } from './evolution';
import { t, type LocaleCode } from './i18n';
import { getAssistantName, getOverlay } from './overlay';
import { calculateRunway } from './runway';
import {
  addDays,
  dateKey,
  escapeHtml,
  formatCents,
  formatDate,
  formatDateTime,
  monthKey,
  zonedParts,
} from './utils';

/** «Около нуля» — всё, что меньше 0,50 €, в быстрых списках не показываем. */
const DUST_THRESHOLD_CENTS = 50;

/** Сколько задач показываем в фокусе дня в быстрой сводке. */
const QUICK_FOCUS_LIMIT = 2;

/** Горизонт «дальних» задач в списке `/tasks`, дней. */
const DISTANT_HORIZON_DAYS = 14;

/** Сентинел «срок очень далеко» — сравниваем ISO-строки лексикографически. */
const FAR_FUTURE_ISO = '9999-12-31T23:59:59.999Z';

/** Порядок очередей в `/debts` (не зависит от сортировки DAL). */
const QUEUE_RANK: Record<string, number> = {
  bank: 0,
  queue_1: 1,
  queue_2: 2,
  queue_3: 3,
  investors: 4,
  service: 5,
  subscription: 6,
};

/** Очереди, которые считаются «долгом» (в сумму долга входят только они). */
const DEBT_QUEUES = new Set(['bank', 'queue_1', 'queue_2', 'queue_3', 'investors']);

const QUEUE_TITLES: Record<string, string> = {
  bank: '🏦 <b>Банковские кредиты:</b>',
  queue_1: '🔴 <b>1-я очередь:</b>',
  queue_2: '🟡 <b>2-я очередь:</b>',
  queue_3: '⚪️ <b>3-я очередь:</b>',
  investors: '💼 <b>Инвесторы:</b>',
};

const MONTHS_NOMINATIVE = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const TRANSACTION_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 40;

// ---------------------------------------------------------------------------
// Типы строк берём из DAL, чтобы не дублировать описания руками.
// ---------------------------------------------------------------------------

type AccountRow = Awaited<ReturnType<typeof listAccounts>>[number];
type LiabilityRow = Awaited<ReturnType<typeof listLiabilities>>[number];
type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];
type CategoryRow = Awaited<ReturnType<typeof listCategories>>[number];

export interface SummaryOptions {
  /** Момент, относительно которого считаем «сегодня» (для тестов). */
  now?: Date;
  /** Язык сводки (если не задан — берётся из `users.language` / оверлея). */
  locale?: LocaleCode;
}

// ---------------------------------------------------------------------------
// Мелкие помощники форматирования
// ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0');

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Центы → целые единицы с группировкой (`{:,.0f}` из upstream).
 * Округление одно — здесь, на выводе.
 */
export function formatWhole(cents: number): string {
  return groupDigits(Math.round(cents / 100));
}

/** Компактный баланс: от 1000 — целые, иначе два знака (`format_compact_balance`). */
function formatCompactBalance(cents: number, currency: string): string {
  const units = cents / 100;
  if (Math.abs(units) >= 1000) return `${groupDigits(Math.round(units))} ${currency}`;
  return `${formatCents(cents)} ${currency}`;
}

/** Компактный EUR: от 100 € — без пробела перед символом (`format_compact_eur`). */
function formatCompactEur(eurCents: number): string {
  const rounded = Math.round(eurCents / 100);
  return rounded >= 100 ? `~${groupDigits(rounded)}€` : `~${rounded} €`;
}

/** ` (Пн 06.11 в 09:30)` — время в таймзоне пользователя. */
function formatTaskDue(dueAt: string, timeZone: string): string {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return '';
  const parts = zonedParts(date, timeZone);
  const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  return ` (${weekday} ${pad2(parts.day)}.${pad2(parts.month)} в ${pad2(parts.hour)}:${pad2(parts.minute)})`;
}

function monthLabel(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return MONTHS_NOMINATIVE[index] ?? month;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface MonthWindow {
  /** `YYYY-MM` в таймзоне пользователя. */
  month: string;
  /** `YYYY-MM-01` — граница для выборки транзакций. */
  from: string;
  /** `YYYY-MM-DD` последнего дня месяца. */
  to: string;
}

function monthWindow(now: Date, timeZone: string): MonthWindow {
  const month = monthKey(now, timeZone);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return {
    month,
    from: `${month}-01`,
    to: `${month}-${pad2(lastDayOfMonth(year, monthNumber))}`,
  };
}

async function userTimezone(userId: number): Promise<string> {
  const user = await getUser(userId);
  return user?.timezone ?? 'UTC';
}

/** Баланс счёта в EUR-центах; без курса — 0 (и счёт виден как «около нуля»). */
function accountEurCents(account: AccountRow, rates: RateTable): number {
  const cents = Math.round(account.currentBalanceCents);
  if (account.currency.toUpperCase() === BASE_CURRENCY) return cents;
  if (!hasRate(account.currency, rates)) return 0;
  try {
    return convert(cents, account.currency, BASE_CURRENCY, rates);
  } catch {
    return 0;
  }
}

/**
 * Суммы по месяцу. `amountEurCents` хранится в самой строке транзакции —
 * складываем сохранённый EUR-эквивалент, а не пересчитываем по курсу.
 */
async function monthTotals(
  userId: number,
  window: MonthWindow,
): Promise<{ spentCents: number; incomeCents: number }> {
  let spentCents = 0;
  let incomeCents = 0;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const chunk = await listTransactions(userId, {
      from: window.from,
      to: window.to,
      limit: TRANSACTION_PAGE_SIZE,
      offset: page * TRANSACTION_PAGE_SIZE,
    });

    for (const row of chunk) {
      if (row.kind === 'expense') spentCents += Math.round(row.amountEurCents);
      else if (row.kind === 'income') incomeCents += Math.round(row.amountEurCents);
    }

    if (chunk.length < TRANSACTION_PAGE_SIZE) break;
  }

  return { spentCents, incomeCents };
}

/** Оплачено ли обязательство в месяце `YYYY-MM` (`paid_months` — массив ISO-месяцев). */
function isPaidInMonth(liability: LiabilityRow, month: string): boolean {
  return liability.paidMonths.includes(month);
}

function categoryIndex(categories: readonly CategoryRow[]): Map<number, CategoryRow> {
  const map = new Map<number, CategoryRow>();
  for (const category of categories) map.set(category.id, category);
  return map;
}

function compareIso(a: string | null, b: string | null): number {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function byDueThenCreated(a: TaskRow, b: TaskRow): number {
  const dueDiff = compareIso(a.dueAt ?? FAR_FUTURE_ISO, b.dueAt ?? FAR_FUTURE_ISO);
  if (dueDiff !== 0) return dueDiff;
  return compareIso(a.createdAt, b.createdAt);
}

/** Дочерние (не удалённые) todo-шаги задачи — для подписи «(N шагов)». */
async function openStepsCount(userId: number, taskId: number): Promise<number> {
  const children = await listTasks(userId, { status: 'todo', parentId: taskId, limit: 100 });
  return children.length;
}

// ---------------------------------------------------------------------------
// Ответ при недоступной модели
// ---------------------------------------------------------------------------

/**
 * Причина отказа словами провайдера.
 *
 * Число статуса говорит «что-то не так», но не говорит «что». OpenAI-совместимые
 * шлюзы и Gemini кладут объяснение в `error.message` — оно и есть ответ.
 * Markdown-разметку вычищаем: текст отказа уходит в сообщение с `**`-заголовком.
 */
function providerFailureText(
  failure: { providerBody?: string | null; detail?: string | null } | null,
): string {
  const strip = (value: string): string =>
    value
      .replace(/\s+/g, ' ')
      .replace(/[*_`\[\]<>]/g, '')
      .trim();

  const raw = typeof failure?.providerBody === 'string' ? failure.providerBody : '';
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === 'string' && message.trim()) return strip(message).slice(0, 160);
    } catch {
      // тело не JSON — показываем как есть
    }
    return strip(raw).slice(0, 160);
  }

  const detail = typeof failure?.detail === 'string' ? failure.detail : '';
  // detail = «provider: model answered 400: <смысл>» — берём только смысл,
  // иначе «провайдер ответил 400:» дублирует «answered 400:».
  const substance = detail.replace(/^.*\banswered\s+\d+\s*:\s*/s, '');
  return strip(substance).slice(0, 160);
}

/**
 * Причина последнего отказа модели — из `kv`, куда её пишет движок.
 * Нужна, чтобы вместо «попробуйте позже» сказать, что именно случилось.
 * Отказ читается по пользователю (`readLastModelFailure`): в публичном ядре
 * глобальный ключ показывал бы отказ чужого аккаунта, поэтому он остался
 * только фолбэком на час после выката.
 */
async function llmFailureReason(userId: number): Promise<string> {
  const failure = await readLastModelFailure(userId);
  if (!failure) return 'нет ответа от провайдера';
  const status = Number(failure.status ?? 0);
  if (status === 429) return 'провайдер упёрся в лимит запросов';
  if (status === 0) return 'провайдер не ответил (сеть или ключ)';
  if (status >= 500) return 'сбой на стороне провайдера';
  const reason = providerFailureText(failure);
  return reason ? `провайдер ответил ${status}: ${reason}` : `провайдер ответил ${status}`;
}

/**
 * Ответ на вопрос, когда модель недоступна. Детерминированные разделы всё
 * равно работают: деньги, задачи и аптечка считаются из SQLite, модель для
 * них не нужна. Заглушка «не удалось получить ответ» остаётся только там, где
 * без модели действительно нечего сказать.
 */export async function modelOutageReply(
  userId: number,
  text: string,
  opts: SummaryOptions = {},
): Promise<string> {
  const lower = text.toLowerCase();
  const head = `⚠️ **Модель сейчас недоступна** — ${await llmFailureReason(userId)}.`;

  const wantsMoney =
    /(деньг|денег|потрат|трат|расход|баланс|долг|кредит|счёт|счет|плат[её]ж|бюджет)/.test(lower);
  if (wantsMoney) return `${head}\nВот что я знаю без неё:\n\n${await quickSummary(userId, opts)}`;

  const wantsTasks = /(задач|дел[оа]|план|напомин)/.test(lower);
  if (wantsTasks) return `${head}\nВот что я знаю без неё:\n\n${await tasksSummary(userId, opts)}`;

  const wantsMeds = /(лек|таблет|доз|аптеч)/.test(lower);
  if (wantsMeds) return `${head}\nВот что я знаю без неё:\n\n${await medsSummary(userId, opts)}`;

  return `${head}\nБез неё работают быстрые разделы: /summary, /debts, /tasks, /meds.`;
}

// ---------------------------------------------------------------------------
// Диагностика: что сломалось и сколько раз
// ---------------------------------------------------------------------------

/** Пустой журнал — это ответ, а не пустой экран. Русский текст остаётся экспортом для совместимости. */
export const DIAGNOSTICS_EMPTY_TEXT = '📊 <b>Диагностика</b>\n\nСбоев не записано — журнал пуст.';

/** Сколько кластеров максимум: одна строка на кластер. */
const DIAGNOSTICS_CLUSTER_LIMIT = 10;

/** Жёсткий потолок строк — диагностика не должна быть простынёй. */
const DIAGNOSTICS_MAX_LINES = 20;

/** Сколько имён тулз показываем: остальное — счётчиком, а не простынёй. */
const DIAGNOSTICS_TOOL_LIMIT = 6;

function diagnosticsStamp(at: string | null, timeZone: string, locale: LocaleCode): string {
  if (!at) return t(locale, 'diagnostics.timeUnknown');
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return t(locale, 'diagnostics.timeUnknown');
  return formatDateTime(new Date(parsed), timeZone);
}

/** Причина дедлайна как токен: идентификатор для форензики, а не проза. */
export type TurnDeadlineCauseToken = 'budget' | 'tools-skipped';

/** Судьба живой строки «⏳ …» как токен. */
export type TurnIndicatorToken = 'none' | 'shown' | 'unavailable';

/**
 * Крошка хода после проверки формы.
 *
 * `kv` отдаёт JSON строкой, поэтому любое поле может прийти числом, объектом,
 * массивом мусора или отсутствовать. Разбор обязан это пережить: раньше число
 * в `stopReason`/`stage` давало `TypeError` внутри `escapeHtml` и роняло ответ
 * `/diagnostics` целиком. Токены стадий, причин дедлайна и индикатора остаются
 * идентификаторами — их читают и локализованная строка диагностики, и
 * инструмент агента `read_turn_log`, который пересказывает крошку модели.
 */
export interface TurnTraceView {
  startedAt: string;
  updatedAt: string;
  stage: string;
  modelCalls: number;
  models: string[];
  tools: string[];
  deadlineAt: string | null;
  deadlineCause: TurnDeadlineCauseToken | null;
  indicator: TurnIndicatorToken;
  stopReason: string | null;
}

/** Поле из `kv` как текст: `42` → `'42'`, объект → `'[object Object]'`, пусто → `''`. */
function traceText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Непустой текст поля или `null` — для меток времени и причины остановки. */
function traceMaybeText(value: unknown): string | null {
  const text = traceText(value).trim();
  return text ? text : null;
}

/**
 * Проверенная форма крошки; `null` — записи нет. Единственное место, где
 * сырые поля из `kv` превращаются в значения: `/diagnostics` и инструмент
 * агента читают один и тот же разбор, поэтому битая запись не может дать
 * разные ответы в двух местах.
 */
export function turnTraceView(trace: TurnTrace | null): TurnTraceView | null {
  if (!trace) return null;
  return {
    startedAt: traceText(trace.startedAt),
    updatedAt: traceText(trace.updatedAt),
    stage: traceText(trace.stage),
    modelCalls: Math.max(0, Math.trunc(Number(trace.modelCalls)) || 0),
    models: Array.isArray(trace.models) ? trace.models.filter((model) => typeof model === 'string') : [],
    tools: Array.isArray(trace.tools) ? trace.tools.filter((name) => typeof name === 'string') : [],
    deadlineAt: traceMaybeText(trace.deadlineAt),
    deadlineCause:
      trace.deadlineCause === 'budget' || trace.deadlineCause === 'tools-skipped'
        ? trace.deadlineCause
        : null,
    indicator:
      trace.indicator === 'shown' || trace.indicator === 'unavailable' ? trace.indicator : 'none',
    stopReason: traceMaybeText(trace.stopReason),
  };
}

/**
 * Строка крошки хода: сколько ходов было, сколько упёрлось в дедлайн, до какой
 * стадии дошёл последний, что стало с индикатором и какие тулзы он звал. Нужна,
 * чтобы отличать «дедлайн по бюджету» от «дедлайн после отказа основной модели»,
 * видеть судьбу строки «⏳ …» и имя инструмента, на котором всё встало; поэтому
 * пишется и в пустой журнал.
 *
 * Обрамление локализовано, токены стадий и причин (`model-start`, `budget`) —
 * нет: это идентификаторы для форензики, а не проза.
 */
function turnTraceLine(
  traceRaw: Awaited<ReturnType<typeof readTurnTrace>>['trace'],
  stats: Awaited<ReturnType<typeof readTurnTrace>>['stats'],
  timeZone: string,
  locale: LocaleCode,
): string | null {
  // Форму значения проверяем в `turnTraceView`: крошка приходит из `kv` строкой
  // JSON, а битая форма не должна ломать разбор всего `/diagnostics`.
  const trace = turnTraceView(traceRaw);
  if (!trace && !stats) return null;
  const parts: string[] = [];
  if (stats && (stats.turns > 0 || stats.deadlineTurns > 0)) {
    parts.push(t(locale, 'diagnostics.turns', { count: stats.turns }));
    parts.push(t(locale, 'diagnostics.deadlineTurns', { count: stats.deadlineTurns }));
  }
  if (trace) {
    const cause =
      trace.deadlineCause === 'tools-skipped'
        ? t(locale, 'diagnostics.causeToolsSkipped')
        : trace.deadlineCause === 'budget'
          ? t(locale, 'diagnostics.causeBudget')
          : null;
    const indicator =
      trace.indicator === 'shown'
        ? t(locale, 'diagnostics.indicatorShown')
        : trace.indicator === 'unavailable'
          ? t(locale, 'diagnostics.indicatorUnavailable')
          : t(locale, 'diagnostics.indicatorNone');
    const shownTools = trace.tools
      .slice(0, DIAGNOSTICS_TOOL_LIMIT)
      .map((name) => escapeHtml(name));
    const toolsText =
      trace.tools.length > shownTools.length
        ? `${shownTools.join(', ')}, ${t(locale, 'diagnostics.toolsMore', {
            count: trace.tools.length - shownTools.length,
          })}`
        : shownTools.join(', ');
    const details = [
      // Стадия приходит из `kv` строкой JSON: битая запись может положить сюда
      // число или объект, поэтому текст уже приведён к строке в `turnTraceView`,
      // а `escapeHtml` остаётся на месте — значение уходит в HTML-ответ.
      t(locale, 'diagnostics.stage', { stage: escapeHtml(trace.stage) }),
      ...(cause ? [t(locale, 'diagnostics.deadline', { cause })] : []),
      t(locale, 'diagnostics.indicator', { state: indicator }),
      ...(trace.models.length > 0
        ? [
            t(locale, 'diagnostics.models', {
              models: trace.models.map((model) => escapeHtml(model)).join(', '),
            }),
          ]
        : []),
      ...(shownTools.length > 0 ? [t(locale, 'diagnostics.tools', { tools: toolsText })] : []),
      // Причина остановки тоже приходит из `kv`: битая запись может положить
      // сюда число или объект, и `replace` внутри `escapeHtml` упал бы с
      // `TypeError` — текст уже приведён к строке в `turnTraceView`.
      ...(trace.stopReason
        ? [t(locale, 'diagnostics.stop', { reason: escapeHtml(trace.stopReason) })]
        : []),
    ];
    parts.push(`${diagnosticsStamp(trace.updatedAt, timeZone, locale)} · ${details.join(' · ')}`);
  }
  return parts.length > 0 ? t(locale, 'diagnostics.turnsLine', { line: parts.join(' · ') }) : null;
}

/** Один кластер одной строкой: код, сколько раз, когда, восстановлен ли. */
function failureLine(item: FailureAggregate, timeZone: string, locale: LocaleCode): string {
  const code = item.signature
    .split('|')
    .filter((part) => part !== '-' && part !== 'none')
    .join(' · ');
  const recovered = item.recoveredAt ? t(locale, 'diagnostics.recovered') : '';
  const task = item.evolutionItemId ? t(locale, 'diagnostics.taskRef', { id: item.evolutionItemId }) : '';
  const line = t(locale, 'diagnostics.failureLine', {
    code: escapeHtml(code),
    count: item.count,
    at: diagnosticsStamp(item.lastAt, timeZone, locale),
  });
  return `${line}${recovered}${task}`;
}

/**
 * `📊 Диагностика`: последний отказ модели и кластеры из нормализованного
 * журнала. Строк не больше двадцати, кластеров — не больше десяти: владельцу
 * нужен короткий список «что сломалось», а не весь журнал.
 *
 * Пустой журнал не маскируется: команда честно говорит «сбоев не записано».
 * Язык берётся из профиля владельца — ответ не должен быть русским при
 * `language='en'`.
 */
export async function diagnosticsReply(
  userId: number,
  options: { limit?: number; now?: Date } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.trunc(options.limit ?? DIAGNOSTICS_CLUSTER_LIMIT));
  const [clusters, lastFailure, user] = await Promise.all([
    listFailureAggregates(userId, { limit }),
    readLastModelFailure(userId),
    getUser(userId),
  ]);
  const timeZone = user?.timezone ?? 'UTC';
  const locale: LocaleCode = user?.language ?? 'ru';
  const { trace: turnTrace, stats: turnStats } = await readTurnTrace(userId);
  const turnLine = turnTraceLine(turnTrace, turnStats, timeZone, locale);

  if (clusters.length === 0 && !lastFailure) {
    // Пустой журнал не пустой экран: крошка хода показывает, чем живёт агент.
    const empty = t(locale, 'diagnostics.empty');
    const lines = turnLine ? [empty, '', turnLine] : [empty];
    return lines.slice(0, DIAGNOSTICS_MAX_LINES).join('\n');
  }

  const lines: string[] = [t(locale, 'diagnostics.title'), ''];

  if (lastFailure) {
    const status = Number(lastFailure.status ?? 0);
    const reason =
      status === 429
        ? t(locale, 'diagnostics.reasonRateLimit')
        : status === 0
          ? t(locale, 'diagnostics.reasonNoProvider')
          : status >= 500
            ? t(locale, 'diagnostics.reasonProviderFailure')
            : t(locale, 'diagnostics.reasonStatus', { status });
    const at = diagnosticsStamp(lastFailure.at ?? null, timeZone, locale);
    lines.push(t(locale, 'diagnostics.lastFailure', { reason: escapeHtml(reason), at }));
    const providerText = providerFailureText(lastFailure);
    if (providerText) lines.push(t(locale, 'diagnostics.failureText', { text: escapeHtml(providerText) }));
  }

  if (clusters.length > 0) {
    if (lastFailure) lines.push('');
    lines.push(t(locale, 'diagnostics.clustersHeader', { count: clusters.length }));
    for (const cluster of clusters) lines.push(failureLine(cluster, timeZone, locale));
  }

  if (turnLine) {
    lines.push('');
    lines.push(turnLine);
  }

  const clock = await kvGetJson<ClockHeartbeat | null>(clockHeartbeatKey(userId), null);
  lines.push('');
  if (!clock || clock.lastExternalAttemptAt === null) {
    lines.push(t(locale, 'diagnostics.clockNone'));
  } else {
    const attempted = diagnosticsStamp(clock.lastExternalAttemptAt, timeZone, locale);
    const succeeded = clock.lastExternalSuccessAt
      ? diagnosticsStamp(clock.lastExternalSuccessAt, timeZone, locale)
      : t(locale, 'diagnostics.clockNever');
    lines.push(t(locale, 'diagnostics.clockLast', { attempted, succeeded }));
    // Фактический такт проговаривается всегда: иначе редкий тик читается как
    // поломка. GitHub отдаёт лишь часть запусков `*/15` (2–6 в сутки), поэтому
    // «молчание» в несколько часов — норма, а не остановка расписания.
    lines.push(t(locale, 'diagnostics.clockCadence'));
    const successMs = clock.lastExternalSuccessAt ? Date.parse(clock.lastExternalSuccessAt) : NaN;
    const ageMinutes = Number.isFinite(successMs)
      ? Math.floor((now.getTime() - successMs) / 60_000)
      : null;
    if (ageMinutes === null) {
      lines.push(t(locale, 'diagnostics.clockNoSuccess'));
    } else if (ageMinutes >= CLOCK_STALL_AFTER_MINUTES) {
      lines.push(t(locale, 'diagnostics.clockStalled'));
    }
    if (clock.kinds.morning_digest === 'failed') {
      lines.push(t(locale, 'diagnostics.morningDigestFailed'));
    }
  }

  lines.push('', t(locale, 'diagnostics.footnote'));

  return lines.slice(0, DIAGNOSTICS_MAX_LINES).join('\n');
}

// ---------------------------------------------------------------------------
// Быстрая сводка
// ---------------------------------------------------------------------------

export async function quickSummary(userId: number, opts: SummaryOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const timeZone = await userTimezone(userId);
  const window = monthWindow(now, timeZone);
  const today = dateKey(now, timeZone);

  const [user, accounts, rates, runway, totals, liabilities, tasks, doses, categories] = await Promise.all([
    getUser(userId),
    listAccounts(userId),
    getRates(),
    calculateRunway(userId, { now }),
    monthTotals(userId, window),
    listLiabilities(userId, 'active'),
    listTasks(userId, { status: 'todo', limit: 200 }),
    listDoses(userId, today),
    listCategories(userId),
  ]);

  const locale = opts.locale ?? user?.language ?? getOverlay().manifest.defaultLocale;
  const assistantName = getAssistantName(locale);
  const lines: string[] = [];

  lines.push(`📊 **Сводка ${assistantName} на ${formatDate(now, timeZone)}**`);
  lines.push(
    `🪙 **Свободный бюджет:** ~${formatWhole(runway.safeDailyCents)} €/день` +
      ` (доступно ~${formatWhole(runway.spendableCents)} EUR)`,
  );
  lines.push('💰 **Текущие счета:**');

  const balances = accounts.map((account) => ({ account, eurCents: accountEurCents(account, rates) }));
  const significant = balances.filter((entry) => entry.eurCents >= DUST_THRESHOLD_CENTS);

  if (significant.length > 0) {
    for (const entry of significant) {
      lines.push(
        `• **${entry.account.name} (${entry.account.currency}):** ` +
          `${formatCompactBalance(entry.account.currentBalanceCents, entry.account.currency)} ` +
          `(${formatCompactEur(entry.eurCents)})`,
      );
    }
  } else if (accounts.length > 0) {
    // Все счета около нуля — показываем их как есть, чтобы пользователь видел
    // полный список, а не пустоту.
    for (const account of accounts) {
      lines.push(`• **${account.name} (${account.currency}):** ${formatCents(0)} ${account.currency} (~0 €)`);
    }
  } else {
    lines.push('• Нет активных счетов');
  }

  const totalEurCents = balances.reduce((total, entry) => total + entry.eurCents, 0);

  lines.push('');
  lines.push(
    `**Общий баланс:** ~${formatCents(totalEurCents)} EUR` +
      ` · **Траты за месяц:** ~${formatCents(totals.spentCents)} EUR`,
  );

  lines.push('');
  lines.push(`💳 **Обязательства (${monthLabel(window.month)}):**`);
  const upcoming = liabilities
    .filter(
      (liability) =>
        Math.round(liability.monthlyPaymentCents) > 0 &&
        liability.paymentDay !== null &&
        !isPaidInMonth(liability, window.month),
    )
    .sort((a, b) => (a.paymentDay ?? 99) - (b.paymentDay ?? 99) || a.name.localeCompare(b.name, 'ru'));

  for (const liability of upcoming.slice(0, 3)) {
    lines.push(
      `• ⏳ **${liability.name}:** ${formatWhole(liability.monthlyPaymentCents)} ${liability.currency}` +
        ` (${liability.paymentDay}-го числа)`,
    );
  }
  if (upcoming.length > 3) {
    lines.push(`_...и ещё ${upcoming.length - 3} плат. в этом месяце (/debts)_`);
  }
  if (upcoming.length === 0) {
    lines.push('• Все обязательства на этот месяц уже закрыты! 🎉');
  }

  lines.push('');
  lines.push('🎯 **Фокус задач на сегодня:**');
  const categoriesById = categoryIndex(categories);
  const focus = tasks
    .filter(
      (task) =>
        task.parentId === null && task.dueAt !== null && dateKey(new Date(task.dueAt), timeZone) === today,
    )
    .sort(byDueThenCreated)
    .slice(0, QUICK_FOCUS_LIMIT);

  if (focus.length === 0) {
    lines.push('• На сегодня жёстких дедлайнов нет — работаем спокойно по ресурсу 🌱');
  } else {
    focus.forEach((task, index) => {
      const category = task.categoryId !== null ? categoriesById.get(task.categoryId) : undefined;
      const catTag = category ? ' `[' + category.name + ']`' : '';
      const due = task.dueAt ? formatTaskDue(task.dueAt, timeZone) : '';
      lines.push(`${index + 1}. ${task.title}${due}${catTag}`);
    });
  }

  if (doses.length > 0) {
    lines.push('');
    lines.push('💊 **Препараты:**');
    for (const dose of doses) {
      const icon = dose.status === 'taken' ? '✅' : dose.status === 'skipped' ? '⏭' : '⏳';
      const statusText =
        dose.status === 'taken' ? 'принято' : dose.status === 'skipped' ? 'пропущено' : 'ожидает';
      lines.push(
        `• ${icon} ${dose.medication.name} (${dose.medication.dosage}) в ${dose.scheduledTime} (${statusText})`,
      );
    }
  }

  lines.push('');
  lines.push('_Быстрые разделы:_ /balance | /debts | /tasks | /meds');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Балансы
// ---------------------------------------------------------------------------

export async function balanceSummary(userId: number, opts: SummaryOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const timeZone = await userTimezone(userId);
  const window = monthWindow(now, timeZone);

  const [accounts, rates, runway, totals] = await Promise.all([
    listAccounts(userId),
    getRates(),
    calculateRunway(userId, { now }),
    monthTotals(userId, window),
  ]);

  const lines: string[] = [];
  const cashLabel =
    runway.cashReserveCents > 0
      ? `(сверх зарезервированных ${formatWhole(runway.cashReserveCents)} EUR)`
      : '(свободные наличные)';

  lines.push('💰 **Балансы по счетам**');
  lines.push(`🟢 **Свободный контур (на жизнь):** ~${formatWhole(runway.spendableCents)} EUR ${cashLabel}`);
  lines.push(
    `🔒 **Целевой резерв (кредиты, аренда, сервисы):** ~${formatWhole(runway.reservedCents)} EUR`,
  );
  lines.push('');

  const balances = accounts.map((account) => ({ account, eurCents: accountEurCents(account, rates) }));
  const significant = balances.filter((entry) => entry.eurCents >= DUST_THRESHOLD_CENTS);

  if (significant.length > 0) {
    for (const entry of significant) {
      lines.push(
        `• **${entry.account.name} (${entry.account.currency}):** ` +
          `${formatCents(entry.account.currentBalanceCents)} ${entry.account.currency}` +
          ` (~${formatCents(entry.eurCents)} €)`,
      );
    }

    const micro = balances.filter(
      (entry) => entry.eurCents < DUST_THRESHOLD_CENTS && Math.round(entry.account.currentBalanceCents) > 0,
    );
    const zeros = balances.filter(
      (entry) => entry.eurCents < DUST_THRESHOLD_CENTS && Math.round(entry.account.currentBalanceCents) <= 0,
    );

    if (micro.length > 0) {
      const names = micro
        .map(
          (entry) =>
            `${entry.account.name} (${formatCents(entry.account.currentBalanceCents)} ${entry.account.currency})`,
        )
        .join(', ');
      lines.push(`_Около нуля (< 0,50 €): ${names}_`);
    }
    if (zeros.length > 0) {
      const names = zeros.map((entry) => `${entry.account.name} (${entry.account.currency})`).join(', ');
      lines.push(`_Нулевые счета: ${names}_`);
    }
  } else if (accounts.length > 0) {
    for (const account of accounts) {
      lines.push(`• **${account.name} (${account.currency}):** ${formatCents(0)} ${account.currency} (~0,00 €)`);
    }
  } else {
    lines.push('• Нет активных счетов');
  }

  const totalEurCents = balances.reduce((total, entry) => total + entry.eurCents, 0);

  lines.push('');
  lines.push(`**Всего ликвидных средств:** ~${formatCents(totalEurCents)} EUR`);
  lines.push(`**Расходы (за ${monthLabel(window.month)}):** ~${formatCents(totals.spentCents)} EUR`);
  if (totals.incomeCents > 0) {
    lines.push(`**Доходы (за ${monthLabel(window.month)}):** +${formatCents(totals.incomeCents)} EUR`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Долги и обязательства
// ---------------------------------------------------------------------------

function liabilitySortRank(liability: LiabilityRow): number {
  return QUEUE_RANK[String(liability.queue)] ?? 7;
}

function debtRow(liability: LiabilityRow, month: string): string {
  const name = escapeHtml(liability.name);
  const currency = liability.currency;
  const monthly = Math.round(liability.monthlyPaymentCents);
  const day = liability.paymentDay;
  const amount = Math.round(liability.amountCents);
  const paid = isPaidInMonth(liability, month);
  const tag = paid ? ' [✅ Оплачен в этом месяце]' : '';

  if (amount > 0 && monthly > 0 && liability.endDate) {
    const totalPayments =
      liability.totalPayments ?? (monthly > 0 ? Math.ceil(amount / monthly) : 0);
    const until = liability.endDate.slice(0, 7).split('-');
    const untilLabel = until.length === 2 ? `${until[1]}.${until[0]}` : liability.endDate;
    return (
      `• ${name}: ${formatWhole(amount)} ${currency}` +
      ` (~${formatWhole(liability.amountEurCents)} €) — ${totalPayments} плат.` +
      ` по ${formatWhole(monthly)} ${currency}/мес (${day}-го числа, до ${untilLabel})${tag}`
    );
  }

  if (monthly > 0) {
    const dayPart = day !== null ? `, ${day}-го числа` : '';
    return `• ${name}: (платёж ${formatWhole(monthly)} ${currency}/мес${dayPart})${tag}`;
  }

  const amountPart = amount > 0 ? `${formatWhole(amount)} ${currency}` : 'без суммы';
  return `• ${name}: ${amountPart}${tag}`;
}

export async function debtsSummary(userId: number, opts: SummaryOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const timeZone = await userTimezone(userId);
  const month = monthKey(now, timeZone);

  const liabilities = await listLiabilities(userId, 'active');
  if (liabilities.length === 0) {
    return '💳 У вас нет зафиксированных кредитов или обязательств.';
  }

  // Платежи хранятся в валюте обязательства, а итог печатается в EUR: без
  // живого курса RUB/KZT/USD складывались бы как евро (HANDOFF §7.17).
  const rates = await getRates();

  // Локальный порядок очередей: bank → queue_1..3 → investors → service →
  // subscription → прочее. Внутри очереди — по дню платежа (пустые в конце).
  const ordered = [...liabilities].sort((a, b) => {
    const rankDiff = liabilitySortRank(a) - liabilitySortRank(b);
    if (rankDiff !== 0) return rankDiff;
    const queueDiff = String(a.queue).localeCompare(String(b.queue));
    if (queueDiff !== 0) return queueDiff;
    if (a.paymentDay !== b.paymentDay) {
      if (a.paymentDay === null) return 1;
      if (b.paymentDay === null) return -1;
      return a.paymentDay - b.paymentDay;
    }
    return a.name.localeCompare(b.name, 'ru');
  });

  const unpaidItems: string[] = [];
  const paidItems: { day: number; name: string; monthly: number; currency: string; eur: number }[] = [];
  const noRateItems: string[] = [];
  let pendingEurCents = 0;

  for (const liability of ordered) {
    const monthly = Math.round(liability.monthlyPaymentCents);
    if (monthly <= 0) continue;

    // `null` — курса нет: такой платёж не попадает в суммы, но остаётся в
    // списках со своей валютой и называется отдельной строкой.
    const monthlyEur = toEurCents(monthly, liability.currency, rates);
    if (monthlyEur === null) noRateItems.push(liability.name);

    if (isPaidInMonth(liability, month)) {
      paidItems.push({
        day: liability.paymentDay ?? 99,
        name: liability.name,
        monthly,
        currency: liability.currency,
        eur: monthlyEur ?? 0,
      });
      continue;
    }

    pendingEurCents += monthlyEur ?? 0;
    const dayPart = liability.paymentDay !== null ? ` (${liability.paymentDay}-го числа)` : '';
    unpaidItems.push(
      `• ⏳ **${escapeHtml(liability.name)}:** ${formatWhole(monthly)} ${liability.currency}${dayPart} — Ожидает`,
    );
  }

  let totalDebtEurCents = 0;
  for (const liability of ordered) {
    if (!DEBT_QUEUES.has(String(liability.queue))) continue;
    totalDebtEurCents += Math.round(liability.amountEurCents);
  }

  const lines: string[] = [];
  lines.push('💳 **Кредиты, долги и обязательства**');
  lines.push('');

  if (pendingEurCents > 0) {
    lines.push(`**К оплате в этом месяце:** ~${formatCents(pendingEurCents)} EUR`);
  } else {
    lines.push('🎉 Все обязательные платежи на этот месяц закрыты!');
  }

  if (paidItems.length > 0) {
    const paidTotal = paidItems.reduce((total, item) => total + item.eur, 0);
    lines.push(`**Уже оплачено в этом месяце:** ~${formatCents(paidTotal)} EUR`);
  }

  lines.push(`**Общая сумма долгов:** ||~${formatCents(totalDebtEurCents)} EUR||`);
  if (noRateItems.length > 0) {
    const names = noRateItems.map((name) => escapeHtml(name)).join(', ');
    lines.push(`_Без курса в EUR (не входит в суммы): ${names}_`);
  }
  lines.push('');

  if (paidItems.length > 0) {
    paidItems.sort((a, b) => a.day - b.day || a.name.localeCompare(b.name, 'ru'));
    const names = paidItems
      .map((item) => `${escapeHtml(item.name)} (${formatWhole(item.monthly)} ${item.currency})`)
      .join(', ');
    const paidTotal = paidItems.reduce((total, item) => total + item.eur, 0);
    lines.push(`• _✅ Оплачено в этом месяце (~${formatCents(paidTotal)} EUR): ${names}_`);
  }

  lines.push('📅 **График платежей на месяц:**');
  if (unpaidItems.length > 0) lines.push(...unpaidItems);
  lines.push('');

  // Развёрнутый блок по очередям — html, иначе Telegram не соберёт expandable.
  const htmlLines: string[] = ['<blockquote expandable>'];
  let previousQueue: string | null = null;
  for (const liability of ordered) {
    const queue = String(liability.queue);
    if (queue !== previousQueue) {
      if (previousQueue !== null) htmlLines.push('');
      htmlLines.push(QUEUE_TITLES[queue] ?? `<b>${escapeHtml(queue)}:</b>`);
      previousQueue = queue;
    }
    htmlLines.push(debtRow(liability, month));
  }
  htmlLines.push('</blockquote>');
  lines.push(htmlLines.join('\n'));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Задачи
// ---------------------------------------------------------------------------

interface TaskGroup {
  key: string;
  name: string;
  position: number;
  minDue: string | null;
  tasks: TaskRow[];
}

export async function tasksSummary(userId: number, opts: SummaryOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const timeZone = await userTimezone(userId);
  const today = dateKey(now, timeZone);
  const distantLimit = dateKey(addDays(now, DISTANT_HORIZON_DAYS), timeZone);

  const [tasks, categories] = await Promise.all([
    listTasks(userId, { status: 'todo', limit: 500 }),
    listCategories(userId),
  ]);

  const roots = tasks.filter((task) => task.parentId === null);
  if (roots.length === 0) {
    return '🎯 Все задачи выполнены! Свободный день или время для отдыха 🌱';
  }

  const categoriesById = categoryIndex(categories);
  const categoryPosition = (task: TaskRow): number => {
    const category = task.categoryId !== null ? categoriesById.get(task.categoryId) : undefined;
    return category ? category.position : 999;
  };

  const focus = roots
    .filter((task) => task.dueAt !== null && dateKey(new Date(task.dueAt), timeZone) <= today)
    .sort(byDueThenCreated)
    .slice(0, 3);

  const backlog = [...roots].sort(byDueThenCreated);
  const isDistant = (task: TaskRow): boolean =>
    task.dueAt !== null && dateKey(new Date(task.dueAt), timeZone) > distantLimit;

  const distant = backlog.filter(isDistant);
  const near = backlog.filter((task) => !isDistant(task));

  const lines: string[] = [];
  lines.push('🎯 **Актуальные задачи**');
  lines.push('');

  // --- микро-фокус дня -----------------------------------------------------
  lines.push('🔥 **Микро-фокус дня:**');
  if (focus.length === 0) {
    lines.push('• На сегодня привязанных ко времени задач нет — двигаемся спокойно по ресурсу 🌱');
    lines.push('');
  } else {
    for (let index = 0; index < focus.length; index += 1) {
      const task = focus[index];
      const steps = await openStepsCount(userId, task.id);
      const due = task.dueAt ? formatTaskDue(task.dueAt, timeZone) : '';
      const sub = steps > 0 ? ` _(${steps} шагов)_` : '';
      lines.push(`${index + 1}. ${task.title}${due}${sub}`);
    }
    lines.push('');
    lines.push('_💡 Трудно начать? Сделай 2-минутный микро-шаг по первой задаче без давления._');
    lines.push('');
  }

  // --- группировка бэклога по категориям ------------------------------------
  const groups = new Map<string, TaskGroup>();
  for (const task of near) {
    const key = task.categoryId !== null ? String(task.categoryId) : '__none__';
    const category = task.categoryId !== null ? categoriesById.get(task.categoryId) : undefined;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: category ? category.name : 'Общее',
        position: categoryPosition(task),
        minDue: null,
        tasks: [],
      };
      groups.set(key, group);
    }
    if (task.dueAt && (group.minDue === null || task.dueAt < group.minDue)) group.minDue = task.dueAt;
    group.tasks.push(task);
  }

  const orderedGroups = [...groups.values()].sort((a, b) => {
    if (a.minDue !== null && b.minDue !== null && a.minDue !== b.minDue) {
      return a.minDue < b.minDue ? -1 : 1;
    }
    if (a.minDue === null && b.minDue !== null) return 1;
    if (a.minDue !== null && b.minDue === null) return -1;
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name, 'ru');
  });

  for (const group of orderedGroups) {
    lines.push(`📁 <b>${escapeHtml(group.name)}:</b>`);
    group.tasks.sort(byDueThenCreated);
    for (const task of group.tasks) {
      const due = task.dueAt ? formatTaskDue(task.dueAt, timeZone) : '';
      lines.push(`• ${escapeHtml(task.title)}${due}`);
    }
  }

  if (distant.length > 0) {
    lines.push('');
    lines.push('<blockquote expandable>');
    lines.push(`🗓 <b>Дальний горизонт и памятные даты (${distant.length} шт.):</b>`);
    for (const task of distant) {
      const due = task.dueAt ? formatTaskDue(task.dueAt, timeZone) : '';
      lines.push(`• ${escapeHtml(task.title)}${due}`);
    }
    lines.push('</blockquote>');
  }

  lines.push('');
  lines.push('_Чтобы закрыть задачу, напиши или наговори «выполнил [название]»._');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Лекарства
// ---------------------------------------------------------------------------

export async function medsSummary(userId: number, opts: SummaryOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const timeZone = await userTimezone(userId);
  const today = dateKey(now, timeZone);

  const doses = await listDoses(userId, today);
  if (doses.length === 0) {
    return '💊 В вашей аптечке пока нет активных препаратов.';
  }

  const lines: string[] = [];
  lines.push(`💊 **Расписание лекарств на ${formatDate(now, timeZone)}**`);
  lines.push('');

  for (const dose of doses) {
    const medication = dose.medication;
    const instructions = medication.instructions ? `, _${medication.instructions}_` : '';
    const head = `**${medication.name}** (${medication.dosage}${instructions})`;

    if (dose.status === 'taken') {
      const takenAt = dose.takenAt ? zonedParts(new Date(dose.takenAt), timeZone) : null;
      const timePart = takenAt ? ` в ${pad2(takenAt.hour)}:${pad2(takenAt.minute)}` : '';
      lines.push(`• ✅ ${head} — ${dose.scheduledTime} (принято${timePart})`);
    } else if (dose.status === 'skipped') {
      lines.push(`• ⏭ ${head} — ${dose.scheduledTime} (пропущено)`);
    } else {
      lines.push(`• ⏳ ${head} — ${dose.scheduledTime} (ожидает)`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Фокус задач (для дайджеста и внешних потребителей)
// ---------------------------------------------------------------------------

export interface TopFocusTask {
  id: number;
  title: string;
  category: string | null;
}

export async function getTopFocusTasks(
  userId: number,
  limit = 2,
  opts: SummaryOptions = {},
): Promise<TopFocusTask[]> {
  const now = opts.now ?? new Date();
  const timeZone = await userTimezone(userId);
  const today = dateKey(now, timeZone);

  const [tasks, categories] = await Promise.all([
    listTasks(userId, { status: 'todo', limit: 200 }),
    listCategories(userId),
  ]);
  const categoriesById = categoryIndex(categories);

  return tasks
    .filter(
      (task) =>
        task.parentId === null && task.dueAt !== null && dateKey(new Date(task.dueAt), timeZone) === today,
    )
    .sort(byDueThenCreated)
    .slice(0, Math.max(0, limit))
    .map((task) => {
      const category = task.categoryId !== null ? categoriesById.get(task.categoryId) : undefined;
      return { id: task.id, title: task.title, category: category ? category.name : null };
    });
}

// ---------------------------------------------------------------------------
// Справка
// ---------------------------------------------------------------------------

/**
 * Текст `/help`. Список команд повторяет набор быстрых разделов upstream-бота;
 * сам роутинг команд подключается в T16.
 */
export function helpText(locale: LocaleCode = 'ru'): string {
  const overlay = getOverlay();
  const assistantName = getAssistantName(locale);
  const supportContact = overlay.manifest.brand.supportContact.trim();

  const lines: string[] = [
    t(locale, 'help.title', { assistantName }),
    '',
    t(locale, 'help.quickSections'),
    t(locale, 'help.cmdSummary'),
    t(locale, 'help.cmdStatus'),
    t(locale, 'help.cmdBalance'),
    t(locale, 'help.cmdDebts'),
    t(locale, 'help.cmdTasks'),
    t(locale, 'help.cmdMeds'),
    t(locale, 'help.cmdInbox'),
    t(locale, 'help.cmdDigest'),
    t(locale, 'help.cmdDiagnostics'),
    t(locale, 'help.cmdSkills'),
    t(locale, 'help.cmdLearn'),
  ];

  if (overlay.manifest.features.byokCommand) {
    lines.push(t(locale, 'help.cmdByok'));
  }
  lines.push(t(locale, 'help.cmdLang'));
  lines.push(t(locale, 'help.cmdHelp'));

  lines.push(
    '',
    t(locale, 'help.skillsNote'),
    '',
    t(locale, 'help.naturalHeader'),
    t(locale, 'help.naturalEx1'),
    t(locale, 'help.naturalEx2'),
    t(locale, 'help.naturalEx3'),
    t(locale, 'help.naturalEx4'),
    t(locale, 'help.voiceHint'),
  );

  if (supportContact) {
    lines.push('', t(locale, 'help.supportLine', { supportContact }));
  }

  return lines.join('\n');
}
