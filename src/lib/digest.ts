/**
 * Утренний дайджест.
 *
 * Порт `backend/app/services/digest.py`. Структура сообщения сохранена, но:
 *  - время берётся из `opts.now` и таймзоны пользователя (`users.timezone`) —
 *    дайджест детерминирован и тестируем;
 *  - финансы считает `runway.ts` (ADR-003: целые центы), а не отдельная
 *    эвристика по названиям счетов (ADR-002);
 *  - никаких обращений к файловой системе и сети — только DAL.
 *
 * Тактический план дня из Python-версии (`extract_tactical_plan_for_today` читал
 * MEMORY.md с диска) сознательно не портирован: в изоляте файлов нет, а роль
 * «плана на день» уже закрывает блок «Фокус дня» ниже. Не возвращать.
 */

import { listAccounts, listTransactions } from './dal/finances';
import { listMedications } from './dal/medications';
import { monthUsage } from './dal/misc';
import { listNotes } from './dal/notes';
import { listCategories, listTasks } from './dal/tasks';
import { getUser } from './dal/users';
import { DIGEST_SECTION_IDS, loadUserPrefs, type DigestSectionId, type UserPrefs } from './prefs';
import { calculateRunway } from './runway';
import type { LiabilityRow } from './types';
import {
  dateKey,
  escapeHtml,
  formatCents,
  formatMoney,
  monthKey,
  toCents,
  zonedParts,
} from './utils';

/** Сколько задач показываем в блоке фокуса. */
const FOCUS_LIMIT = 3;

/** Окно «свежей идеи», часов. */
const IDEA_WINDOW_HOURS = 48;

/** Максимальная длина идеи в дайджесте, символов. */
const IDEA_MAX_LENGTH = 110;

/** Обрезка идёт по этому числу символов перед добавлением многоточия. */
const IDEA_CUT_LENGTH = 105;

const TRANSACTION_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 40;

const WEEKDAYS_ACCUSATIVE = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среду',
  'четверг',
  'пятницу',
  'субботу',
];

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** Ранг времени приёма: утро → 1, день → 2, прочее → 3. */
const TIME_RANK: Record<string, number> = {
  '08:00': 1,
  '09:00': 1,
  утро: 1,
  '13:00': 2,
  '14:00': 2,
  день: 2,
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

export interface DigestOptions {
  /** Момент, на который строится дайджест (для тестов и планировщика). */
  now?: Date;
}

type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];
type CategoryRow = Awaited<ReturnType<typeof listCategories>>[number];

function weekdayIndex(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `6 ноября 2026` — день без ведущего нуля. */
function longDate(now: Date, timeZone: string): string {
  const parts = zonedParts(now, timeZone);
  const weekday = WEEKDAYS_ACCUSATIVE[weekdayIndex(parts.year, parts.month, parts.day)];
  const month = MONTHS_GENITIVE[parts.month - 1] ?? String(parts.month);
  return `${weekday}, ${parts.day} ${month} ${parts.year}`;
}

function compareIso(left: string | null, right: string | null): number {
  const a = left ?? '';
  const b = right ?? '';
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function taskCategoryTag(task: TaskRow, categories: Map<number, CategoryRow>): string {
  if (task.categoryId === null) return '';
  const category = categories.get(task.categoryId);
  return category ? ` [${category.name}]` : '';
}

function categoryIndex(categories: readonly CategoryRow[]): Map<number, CategoryRow> {
  const map = new Map<number, CategoryRow>();
  for (const category of categories) map.set(category.id, category);
  return map;
}

function timeRank(time: string): number {
  return TIME_RANK[time] ?? TIME_RANK[time.trim()] ?? 3;
}

function medicationRank(times: readonly string[]): number {
  let rank = 3;
  for (const time of times) rank = Math.min(rank, timeRank(time));
  return rank;
}

/** Сумма расходов с 1-го числа месяца в EUR-центах (по сохранённому эквиваленту). */
async function spentThisMonth(userId: number, now: Date, timeZone: string): Promise<number> {
  const month = monthKey(now, timeZone);
  const from = `${month}-01`;

  let spentCents = 0;
  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const chunk = await listTransactions(userId, {
      from,
      to: dateKey(now, timeZone),
      kind: 'expense',
      limit: TRANSACTION_PAGE_SIZE,
      offset: page * TRANSACTION_PAGE_SIZE,
    });

    for (const row of chunk) spentCents += Math.round(row.amountEurCents);
    if (chunk.length < TRANSACTION_PAGE_SIZE) break;
  }

  return spentCents;
}

/** Необработанные заметки «инбокса» (column = raw, без processed_at). */
async function unprocessedCount(userId: number): Promise<number> {
  let count = 0;
  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const chunk = await listNotes(userId, {
      column: 'raw',
      limit: TRANSACTION_PAGE_SIZE,
      offset: page * TRANSACTION_PAGE_SIZE,
    });
    for (const note of chunk) if (note.processedAt === null) count += 1;
    if (chunk.length < TRANSACTION_PAGE_SIZE) break;
  }
  return count;
}

/** Свежая идея за последние 48 часов (самая новая). */
async function latestIdea(userId: number, now: Date): Promise<string | null> {
  const cutoff = now.getTime() - IDEA_WINDOW_HOURS * 3_600_000;
  const notes = await listNotes(userId, { column: 'idea', limit: 50 });

  for (const note of notes) {
    if (!note.createdAt) continue;
    const createdAt = new Date(note.createdAt).getTime();
    if (Number.isNaN(createdAt) || createdAt < cutoff) continue;

    const text = (note.cleanText ?? '').trim() || note.rawText.trim();
    if (!text) continue;
    return shorten(text);
  }
  return null;
}

/** Обрезка по границе слова с зачисткой хвостовой пунктуации. */
function shorten(text: string): string {
  if (text.length <= IDEA_MAX_LENGTH) return text;

  let cut = text.slice(0, IDEA_CUT_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 40) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s.,!?:;]+$/u, '');
  return `${cut}…`;
}

export async function buildMorningDigest(userId: number, opts: DigestOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const [user, prefs] = await Promise.all([
    getUser(userId),
    loadUserPrefs(userId).catch((): UserPrefs => ({})),
  ]);
  const timeZone = user?.timezone ?? 'UTC';
  const today = dateKey(now, timeZone);

  const enabledSections = new Set<DigestSectionId>(
    prefs.proactive?.jobs?.morning_digest?.sections ?? DIGEST_SECTION_IDS,
  );
  const focusLimit = prefs.adhd?.focusLimit ?? FOCUS_LIMIT;

  const hasFocus = enabledSections.has('focus');
  const hasMeds = enabledSections.has('medications');
  const hasFinance = enabledSections.has('finance');
  const hasInbox = enabledSections.has('inbox');
  const hasTelemetry = enabledSections.has('telemetry');
  const hasCoaching = enabledSections.has('coaching');

  const [tasks, categories, medications, runway, spentCents, inboxCount, idea, usage] =
    await Promise.all([
      hasFocus ? listTasks(userId, { status: 'todo', limit: 500 }) : Promise.resolve([]),
      hasFocus ? listCategories(userId) : Promise.resolve([]),
      hasMeds ? listMedications(userId) : Promise.resolve([]),
      hasFinance ? calculateRunway(userId, { now }) : Promise.resolve(null),
      hasFinance ? spentThisMonth(userId, now, timeZone) : Promise.resolve(0),
      hasInbox ? unprocessedCount(userId) : Promise.resolve(0),
      hasInbox ? latestIdea(userId, now) : Promise.resolve(null),
      hasTelemetry ? monthUsage(userId) : Promise.resolve({ calls: 0, promptTokens: 0, completionTokens: 0, costMicros: 0 }),
    ]);

  const categoriesById = categoryIndex(categories);
  const lines: string[] = [];

  // --- заголовок -----------------------------------------------------------
  lines.push(`☀️ **Доброе утро! Сводка на ${longDate(now, timeZone)}**`);

  // --- фокус дня -----------------------------------------------------------
  if (hasFocus) {
    lines.push('');
    lines.push('🎯 **Фокус дня (максимум 2 сферы):**');

    const dueToday = tasks
      .filter((task) => task.dueAt !== null && dateKey(new Date(task.dueAt), timeZone) === today)
      .sort((a, b) => compareIso(a.createdAt, b.createdAt))
      .slice(0, focusLimit);

    if (dueToday.length > 0) {
      for (const task of dueToday) {
        lines.push(`• ${task.title}${taskCategoryTag(task, categoriesById)}`);
      }
    } else {
      // Fallback: корневые задачи со сроком сегодня/просроченным/без срока.
      const todayTs = `${today}T00:00:00.000Z`;
      const fallback = tasks
        .filter((task) => task.parentId === null)
        .map((task) => {
          const dueKey = task.dueAt ? dateKey(new Date(task.dueAt), timeZone) : null;
          const bucket = dueKey === null ? 1 : dueKey === today ? 0 : dueKey < today ? 0 : 2;
          return { task, bucket };
        })
        .filter((entry) => entry.bucket <= 1 || entry.task.dueAt !== null)
        .filter((entry) => {
          // Только «сегодня и раньше, либо без срока» — будущее в фокус не берём.
          if (entry.task.dueAt === null) return true;
          return dateKey(new Date(entry.task.dueAt), timeZone) <= today;
        })
        .sort((a, b) => {
          if (a.bucket !== b.bucket) return a.bucket - b.bucket;
          const dueDiff = compareIso(a.task.dueAt ?? todayTs, b.task.dueAt ?? todayTs);
          if (dueDiff !== 0) return dueDiff;
          return compareIso(a.task.createdAt, b.task.createdAt);
        })
        .slice(0, focusLimit);

      if (fallback.length > 0) {
        for (const entry of fallback) {
          lines.push(`• ${entry.task.title}${taskCategoryTag(entry.task, categoriesById)}`);
        }
      } else {
        lines.push('• Все приоритетные задачи закрыты! Свободный день или восстановление ресурса.');
      }
    }

    const overdueCount = tasks.filter(
      (task) => task.parentId === null && task.dueAt !== null && dateKey(new Date(task.dueAt), timeZone) < today,
    ).length;

    if (overdueCount > 0) {
      lines.push(
        `_⚠️ Отложенных дел в бэклоге: ||${overdueCount} шт.|| (разберём, когда будет ресурс)_`,
      );
    }
  }

  // --- препараты -----------------------------------------------------------
  if (hasMeds && medications.length > 0) {
    const scheduled = [...medications]
      .map((medication) => ({
        medication,
        times: medication.times.filter((time) => time.trim() !== ''),
      }))
      .sort((a, b) => {
        const rankDiff = medicationRank(a.times) - medicationRank(b.times);
        if (rankDiff !== 0) return rankDiff;
        return a.medication.name.localeCompare(b.medication.name, 'ru');
      });

    lines.push('');
    lines.push('💊 **Препараты и витамины сегодня:**');
    for (const entry of scheduled) {
      const { medication, times } = entry;
      const when = times.length > 0 ? times.join(', ') : '«по графику»';
      const instructions = medication.instructions ? ` — _${medication.instructions}_` : '';
      lines.push(`• **${medication.name}** (${medication.dosage}) в ${when}${instructions}`);
    }
  }

  // --- финансы -------------------------------------------------------------
  if (hasFinance && runway) {
    lines.push('');
    lines.push('💰 **Финансы:**');

    if (runway.accounts.length > 0) {
      lines.push(
        `• 🪙 **Можно тратить:** ~${Math.round(runway.safeDailyCents / 100)} €/день ` +
          `(свободно ${Math.round(runway.spendableCents / 100)} € на ${runway.horizonDays} дн.)`,
      );
      lines.push(
        `• 🔒 **Уже распределено** (кредиты, аренда, подписки): ` +
          `${Math.round(runway.reservedCents / 100)} € — это не бюджет`,
      );

      if (runway.reservedGapCents < 0) {
        lines.push(
          `• 🧭 Под платежи ближайших ${runway.horizonDays} дн. не хватает ` +
            `~${Math.round(Math.abs(runway.reservedGapCents) / 100)} € — обсудим в диалоге`,
        );
      }

      const nearest = runway.upcomingPayments[0];
      if (nearest) {
        lines.push(
          `• 💳 **Ближайший платёж:** ${escapeHtml(nearest.name)} — ` +
            `${formatCents(nearest.monthlyPaymentCents).replace(/,00$/, '')} ${nearest.currency}` +
            (nearest.paymentDay !== null ? ` (${nearest.paymentDay}-е число)` : ''),
        );
      }
    }

    lines.push(`• 📊 **Расходы с 1-го числа:** ~${formatCents(spentCents)} €`);
  }

  // --- инбокс и идеи -------------------------------------------------------
  if (hasInbox) {
    lines.push('');
    lines.push('📥 **Инбокс и идеи:**');
    if (inboxCount === 0) {
      lines.push('• 📦 Инбокс чист и разобран ✅');
    } else {
      lines.push(`• 📦 В инбоксе: **${inboxCount}** необработанных заметок / чеков (разберём здесь)`);
    }
    if (idea) {
      lines.push(`• 💡 *Идея в копилке:* ${idea}`);
    }
  }

  // --- телеметрия ----------------------------------------------------------
  if (hasTelemetry && usage.calls > 0) {
    const cost = usage.costMicros / 1_000_000;
    lines.push('');
    lines.push('<blockquote expandable>');
    lines.push('📊 <b>Телеметрия месяца</b>');
    lines.push(
      `Вызовов: ${usage.calls} · токены: ${usage.promptTokens} in / ${usage.completionTokens} out · ` +
        `расход: $${formatCents(toCents(cost))}`,
    );
    lines.push('</blockquote>');
  }

  // --- коуч ----------------------------------------------------------------
  if (hasCoaching) {
    lines.push('');
    lines.push(
      '🌱 _Сегодня держим моно-фокус на 2 сферах без распыления. ' +
        'Если ресурса мало — начни с ультра-микрошага на 5 минут._ 🌱',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Проверка списаний по обязательствам
// ---------------------------------------------------------------------------

/** Пункт проверки: обязательство и его платёж текущего локального месяца. */
export interface LiabilityReviewItem {
  liability: LiabilityRow;
  /** `YYYY-MM` — период, за который платим. */
  month: string;
  /** `YYYY-MM-DD` — календарный день платежа в этом месяце. */
  dueKey: string;
}

/** Действие кнопки: `p` — оплатил, `n` — не оплатил, `d` — удалить. */
export type LiabilityReviewAction = 'p' | 'n' | 'd';

export interface LiabilityReviewCallback {
  liabilityId: number;
  month: string;
  action: LiabilityReviewAction;
}

/** Структурный тип клавиатуры: `lib/` не может импортировать `handlers/`. */
export interface LiabilityReviewKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Число дней в месяце (1-based месяц). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `2026-11-13` → `13.11.2026` без участия таймзоны: это календарь, не момент. */
function formatReviewDay(key: string): string {
  const [year, month, day] = key.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * Дата платежа текущего локального месяца, если она уже наступила.
 *
 * День платежа зажимается по длине месяца (31-е в феврале → 28/29), как в
 * `runway.ts` и `reminders.ts`. Будущий платёж в проверку не попадает: спрашивать
 * «прошёл ли платёж» заранее бессмысленно. Обязательство без дня платежа не
 * проверяется — даты у него нет.
 */
export function liabilityReviewDueDate(
  liability: LiabilityRow,
  now: Date,
  timeZone: string,
): string | null {
  const day = liability.paymentDay;
  if (day === null) return null;

  const parts = zonedParts(now, timeZone);
  const clamped = Math.min(day, daysInMonth(parts.year, parts.month));
  const dueKey = `${parts.year}-${pad2(parts.month)}-${pad2(clamped)}`;
  return dueKey <= dateKey(now, timeZone) ? dueKey : null;
}

/**
 * Текст отдельного сообщения «Проверка списаний».
 *
 * Пункты нумерованы: кнопки короткие (иконка + номер), поэтому три кнопки на
 * строку не растягивают клавиатуру, а связь с пунктом остаётся однозначной.
 */
export function buildLiabilityReviewMessage(items: readonly LiabilityReviewItem[]): string {
  const lines = ['🔍 <b>Проверка списаний</b>', '', 'Что уже прошло в этом месяце?'];
  items.forEach((item, index) => {
    const amount =
      item.liability.monthlyPaymentCents > 0
        ? item.liability.monthlyPaymentCents
        : item.liability.amountCents;
    lines.push(
      `${index + 1}. <b>${escapeHtml(item.liability.name)}</b> — ` +
        `${formatMoney(amount, item.liability.currency)} · ${formatReviewDay(item.dueKey)}`,
    );
  });
  lines.push('');
  lines.push('✅ оплатил · ❌ не оплатил · 🗑 удалить');
  lines.push('<i>Первый ответ за месяц фиксируется; повторы ничего не меняют.</i>');
  return lines.join('\n');
}

/** `lrev:<liabilityId>:<YYYY-MM>:<p|n|d>`. */
export function buildLiabilityReviewCallbackData(
  liabilityId: number,
  month: string,
  action: LiabilityReviewAction,
): string {
  return `lrev:${liabilityId}:${month}:${action}`;
}

/** Три кнопки на пункт; порядок строк совпадает с нумерацией в тексте. */
export function buildLiabilityReviewKeyboard(
  items: readonly LiabilityReviewItem[],
): LiabilityReviewKeyboard {
  return {
    inline_keyboard: items.map((item, index) => {
      const number = String(index + 1);
      return [
        {
          text: `✅ ${number}`,
          callback_data: buildLiabilityReviewCallbackData(item.liability.id, item.month, 'p'),
        },
        {
          text: `❌ ${number}`,
          callback_data: buildLiabilityReviewCallbackData(item.liability.id, item.month, 'n'),
        },
        {
          text: `🗑 ${number}`,
          callback_data: buildLiabilityReviewCallbackData(item.liability.id, item.month, 'd'),
        },
      ];
    }),
  };
}

const REVIEW_ACTIONS: readonly LiabilityReviewAction[] = ['p', 'n', 'd'];

/**
 * Разбор callback-а проверки. Битая строка (чужая, обрезанная, несуществующий
 * месяц или действие) → `null`: обработчик не должен угадывать.
 */
export function parseLiabilityReviewCallback(data: string): LiabilityReviewCallback | null {
  if (!data.startsWith('lrev:')) return null;
  const parts = data.split(':');
  if (parts.length !== 4) return null;

  const [, rawId = '', month = '', rawAction = ''] = parts;
  if (!/^\d{1,15}$/.test(rawId)) return null;
  const liabilityId = Number(rawId);
  if (!Number.isInteger(liabilityId) || liabilityId <= 0) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  if (!REVIEW_ACTIONS.includes(rawAction as LiabilityReviewAction)) return null;

  return { liabilityId, month, action: rawAction as LiabilityReviewAction };
}

export interface UpdateLiabilityReviewCardParams {
  /** Текст карточки, как его вернул Telegram (без HTML-тегов). */
  originalText: string;
  /** Текущая inline-клавиатура карточки. */
  replyMarkup?: {
    inline_keyboard?: Array<
      Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>
    >;
  };
  liabilityId: number;
  decision: 'paid' | 'unpaid' | 'deleted';
  /** Имя обязательства — запасной источник, если номера пункта не нашлось. */
  liabilityName?: string;
}

export interface UpdatedLiabilityReviewCard {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

const REVIEW_STATUS_DIVIDER = '━━━━━━━━━━━━━━';
const REVIEW_STATUS_PREFIX = '(?:✅|❌|🗑️?)';
const REVIEW_LEGEND_FOOTER =
  /\n\n✅ оплатил · ❌ не оплатил · 🗑️? удалить(?:\n(?:<i>)?Первый ответ за месяц фиксируется; повторы ничего не меняют\.(?:<\/i>)?)?\s*$/u;

const REVIEW_DECISION_VIEW: Record<
  UpdateLiabilityReviewCardParams['decision'],
  { emoji: string; verb: string; fallback: string }
> = {
  paid: { emoji: '✅', verb: 'оплачено', fallback: '✅ Отмечено: оплачено' },
  unpaid: { emoji: '❌', verb: 'не оплачено', fallback: '❌ Отмечено: не оплачено' },
  deleted: { emoji: '🗑️', verb: 'удалено', fallback: '🗑️ Обязательство удалено' },
};

/**
 * Живое обновление карточки «Проверка списаний» после решения по одному пункту.
 *
 * Чистая функция: решённая строка кнопок исчезает, под разделителем копится
 * список итогов по пунктам (по номерам), а когда пунктов не осталось, легенда
 * кнопок убирается из тела. Остальные пункты остаются нажимаемыми.
 */
export function updateLiabilityReviewCard(
  params: UpdateLiabilityReviewCardParams,
): UpdatedLiabilityReviewCard {
  const rawRows = params.replyMarkup?.inline_keyboard ?? [];
  const prefix = `lrev:${params.liabilityId}:`;
  const isTarget = (btn: { callback_data?: string }): boolean =>
    btn.callback_data?.startsWith(prefix) === true;

  let itemNumber: string | undefined;
  for (const row of rawRows) {
    if (!row.some(isTarget)) continue;
    for (const btn of row) {
      const found = /(\d+)\s*$/.exec(btn.text);
      if (found?.[1]) {
        itemNumber = found[1];
        break;
      }
    }
    if (itemNumber) break;
  }

  let remainingRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const row of rawRows) {
    if (row.some(isTarget)) continue;
    const buttons: Array<{ text: string; callback_data: string }> = [];
    for (const btn of row) {
      if (typeof btn.callback_data === 'string') {
        buttons.push({ text: btn.text, callback_data: btn.callback_data });
      }
    }
    if (buttons.length > 0) remainingRows.push(buttons);
  }

  const dividerMatch = /\n\n━{4,}\n/.exec(params.originalText);
  let bodyPart = (
    dividerMatch ? params.originalText.slice(0, dividerMatch.index) : params.originalText
  ).trimEnd();
  const existingStatusLines = dividerMatch
    ? params.originalText
        .slice(dividerMatch.index + dividerMatch[0].length)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : [];

  const numberToName = new Map<string, string>();
  for (const found of bodyPart.matchAll(/^(\d+)\.\s+(.+?)\s+—\s+/gm)) {
    const number = found[1];
    const name = found[2]?.replace(/<\/?b>/g, '').trim();
    if (number && name) numberToName.set(number, name);
  }

  const wantedName = params.liabilityName?.trim();
  if (!itemNumber) {
    if (wantedName) {
      for (const [number, name] of numberToName) {
        if (name === wantedName) {
          itemNumber = number;
          break;
        }
      }
    }
    if (!itemNumber && numberToName.size === 1) {
      itemNumber = [...numberToName.keys()][0];
    }
  }

  const displayName =
    (itemNumber ? numberToName.get(itemNumber) : undefined) ?? (wantedName || undefined);

  const view = REVIEW_DECISION_VIEW[params.decision];
  const statusLine =
    itemNumber && displayName
      ? `${view.emoji} ${itemNumber}. ${displayName} — ${view.verb}`
      : displayName
        ? `${view.emoji} ${displayName} — ${view.verb}`
        : itemNumber
          ? `${view.emoji} Пункт ${itemNumber} — ${view.verb}`
          : view.fallback;

  const sameItem = itemNumber
    ? new RegExp(`^${REVIEW_STATUS_PREFIX}\\s+${itemNumber}\\.\\s+`, 'u')
    : null;
  const statusLines = existingStatusLines.filter(
    (line) => line !== statusLine && !(sameItem && sameItem.test(line)),
  );
  statusLines.push(statusLine);

  const numberOf = (line: string): number | null => {
    const found = new RegExp(`^${REVIEW_STATUS_PREFIX}\\s+(\\d+)\\.`, 'u').exec(line);
    return found?.[1] ? Number(found[1]) : null;
  };
  const numbered = statusLines
    .filter((line) => numberOf(line) !== null)
    .sort((a, b) => (numberOf(a) ?? 0) - (numberOf(b) ?? 0));
  const unnumbered = statusLines.filter((line) => numberOf(line) === null);
  const orderedLines = [...numbered, ...unnumbered];

  const unresolvedLeft =
    rawRows.length > 0 ? remainingRows.length > 0 : numberToName.size > orderedLines.length;
  if (!unresolvedLeft) {
    bodyPart = bodyPart.replace(REVIEW_LEGEND_FOOTER, '').trimEnd();
    remainingRows = [];
  }

  const text = bodyPart
    ? `${bodyPart}\n\n${REVIEW_STATUS_DIVIDER}\n${orderedLines.join('\n')}`
    : orderedLines.join('\n');
  return { text, replyMarkup: { inline_keyboard: remainingRows } };
}

/** Псевдоним для планировщика: утренний дайджест. */
export const morningDigest = buildMorningDigest;

/** Экспорт вспомогательных символов для тестов и переиспользования. */
export { longDate, shorten, pad2 as digestPad2 };
