/**
 * Deep module: доставка напоминаний по задачам.
 *
 * Зачем отдельный сервис, а не обработчик `due_jobs`: напоминание должно
 * доехать и тогда, когда задача создана из Mini App (там `due_jobs` никто не
 * ставит), и тогда, когда фича только что выкатилась на базу со старыми
 * `remind_at`. Поэтому «созрело ли» считается запросом к `tasks`, а не записью
 * в очереди.
 *
 * Инварианты:
 *  - ленивый крон: в изоляте нет таймера, поэтому доставка запускается на
 *    каждом касании бота (`handlers/message`) и на `/api/state` из Mini App;
 *  - дублей нет: перед отправкой `claimReminder` атомарно ставит
 *    `reminder_sent = 1`, отправка идёт только после успешного claim;
 *  - неудачная отправка не теряет напоминание: claim снимается, следующий
 *    проход попробует снова;
 *  - протухшее (старше `REMINDER_MAX_AGE_DAYS`) гасится молча — выкатка на
 *    живую базу не должна вываливать в чат пачку старых напоминаний;
 *  - одно напоминание — одно сообщение с кнопками `[✅ Готово] [⏳ +1 час]`,
 *    которые уже умеет `routeCallback` (`task_done:*`, `task_snooze:*`).
 *
 * Второй доставляющий проход — предупреждения о списании по обязательствам
 * (`deliverLiabilityWarnings`). Он живёт здесь, а не в `due_jobs`, потому что
 * `schedule` держит один pending-job на `(user_id, kind)`, а обязательств у
 * человека много. Идемпотентность — метка в `kv` на период
 * `liability_warn:<user_id>:<id>:<YYYY-MM>`, поставленная атомарно до отправки.
 * Новых callback-префиксов фича не заводит: кнопка ведёт в существующий `nav:debts`.
 *
 * Третий проход — напоминания о приёме лекарств (`deliverMedicationReminders`).
 * `due_jobs` для него не годится по той же причине: `schedule` держит один
 * pending-job на `(user_id, kind)`, а приёмов в день бывает несколько. Поэтому
 * «что созрело» — это `listDoses` на сегодня, а идемпотентность — метка в `kv`
 * на дозу `med_remind:<user_id>:<id>:<YYYY-MM-DD>:<HH:MM>`. Кнопки —
 * существующие `med_take:` / `med_skip:` / `med_postpone:`.
 *
 * Вместе со сводкой уходит «Проверка списаний» (`deliverLiabilityReview`):
 * отдельным сообщением, сразу после дайджеста. Это не пятый вид ленивого крона
 * и не новое уведомление в очереди — сводка уже доставляется один раз в сутки,
 * поэтому проверка едет на её проходе и повторяется после ручного `/digest`.
 * Решение владельца живёт в `liability_review:<user>:<id>:<YYYY-MM>`.
 *
 * Четвёртый проход — утренняя сводка (`deliverMorningDigest`). `due_jobs` для
 * неё не нужен: сводка одна в день, поэтому «созрело ли» — это сравнение
 * настенного времени с `users.summary_time` (по умолчанию 07:00) по модулю
 * суток, а идемпотентность — метка в `kv` на сутки начала окна
 * `morning_digest:<user_id>:<YYYY-MM-DD>`.
 */

import { api, BotApiError } from 'sdk';

import {
  DEFAULT_REMINDERS_PER_PASS,
  REMINDER_MAX_AGE_DAYS,
  claimReminder,
  expireStaleReminders,
  listDueReminders,
  releaseReminder,
} from './dal/tasks.js';
import { isRecurringQueue, listLiabilities } from './dal/finances.js';
import { listDoses, type MedicationDose } from './dal/medications.js';
import { kvDelete, kvGet, kvListByPrefix, kvSetIfAbsent, liabilityReviewKey } from './dal/misc.js';
import { getUser } from './dal/users.js';
import {
  buildLiabilityReviewKeyboard,
  buildLiabilityReviewMessage,
  buildMorningDigest,
  liabilityReviewDueDate,
  type LiabilityReviewItem,
} from './digest.js';
import { markdownToTelegramHtml, splitMessageChunks } from './markdown.js';
import {
  addDays,
  dateKey,
  escapeHtml,
  formatDateTime,
  formatMoney,
  parseTimeOfDay,
  toIso,
  zonedParts,
} from './utils.js';
import type { LiabilityRow, TaskRow } from '../types.js';

export interface DeliverRemindersOptions {
  /** Момент доставки; по умолчанию «сейчас». */
  now?: Date | string;
  /** Куда слать; по умолчанию — личный чат пользователя (`user_id`). */
  chatId?: number;
  /** Сколько напоминаний доставить за проход. */
  limit?: number;
}

export interface ReminderDeliveryResult {
  /** Отправлено сообщений. */
  delivered: number;
  /** Погашено молча как протухшее. */
  expired: number;
  /** Отправка не удалась, напоминание вернётся в очередь. */
  failed: number;
  /** ID доставленных задач. */
  taskIds: number[];
}

/** Текст одного напоминания. */
export function buildReminderText(task: TaskRow, timeZone: string): string {
  const lines = ['🔔 <b>Напоминание</b>', '', `<b>${escapeHtml(task.title)}</b>`];
  if (task.dueAt) {
    const due = new Date(task.dueAt);
    if (!Number.isNaN(due.getTime())) {
      lines.push(`<i>Срок: ${formatDateTime(due, timeZone)}</i>`);
    }
  }
  return lines.join('\n');
}

/** Клавиатура напоминания: обе кнопки уже обслуживает `routeCallback`. */
export function buildReminderKeyboard(taskId: number) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Готово', callback_data: `task_done:${taskId}` },
        { text: '⏳ +1 час', callback_data: `task_snooze:${taskId}:60` },
      ],
    ],
  };
}

function resolveNow(now: DeliverRemindersOptions['now']): Date | null {
  if (now === undefined) return new Date();
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Доставляет созревшие напоминания пользователя.
 *
 * Никогда не бросает на ошибке отправки: сбой одного сообщения не должен
 * ломать обработку входящего апдейта. Невалидная дата `now` — тоже тихий
 * выход (детерминированные тесты так не пишут, но рантайм не должен падать).
 */
export async function deliverDueReminders(
  userId: number,
  options: DeliverRemindersOptions = {},
): Promise<ReminderDeliveryResult> {
  const empty: ReminderDeliveryResult = { delivered: 0, expired: 0, failed: 0, taskIds: [] };
  const now = resolveNow(options.now);
  if (!now) return empty;

  const limit = options.limit ?? DEFAULT_REMINDERS_PER_PASS;
  const cutoff = toIso(addDays(now, -REMINDER_MAX_AGE_DAYS));

  // Сначала читаем: протухшее гасим только если оно реально есть. Иначе каждый
  // апдейт делал бы лишний UPDATE на пустом множестве (мультиарендный бот).
  let due = await listDueReminders(userId, now, limit);
  let expired = 0;
  if (due.length > 0 && due[0].remindAt !== null && due[0].remindAt < cutoff) {
    expired = await expireStaleReminders(userId, now);
    due = await listDueReminders(userId, now, limit);
  }
  if (due.length === 0) return { ...empty, expired };

  const chatId = options.chatId ?? userId;
  const timeZone = (await getUser(userId))?.timezone ?? 'Europe/Berlin';

  const result: ReminderDeliveryResult = { delivered: 0, expired, failed: 0, taskIds: [] };

  for (const task of due) {
    if (!(await claimReminder(userId, task.id, now))) continue; // уже забрал другой проход
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: buildReminderText(task, timeZone),
        parse_mode: 'HTML',
        reply_markup: buildReminderKeyboard(task.id),
      });
      result.delivered += 1;
      result.taskIds.push(task.id);
    } catch (err) {
      result.failed += 1;
      // Постоянный отказ (бот заблокирован, чат не найден, битый запрос) не
      // повторяем: иначе каждое касание неделю долбится в тот же 400/403.
      // Claim остаётся выставленным — напоминание не «зависает» в очереди.
      const permanent =
        err instanceof BotApiError && (err.code === 400 || err.code === 403);
      if (!permanent) {
        try {
          await releaseReminder(userId, task.id);
        } catch (releaseErr) {
          // Release упал — напоминание останется claimed. Не роняем остаток пачки.
          console.warn('reminders: release failed', task.id, releaseErr);
        }
      }
      console.warn(
        permanent ? 'reminders: permanent send failure' : 'reminders: send failed',
        task.id,
        err,
      );
    }
  }

  return result;
}

/** Сколько напоминаний максимум уходит за один проход (для документации и тестов). */
export { DEFAULT_REMINDERS_PER_PASS };

// ---------------------------------------------------------------------------
// Предупреждения о списании по обязательствам
// ---------------------------------------------------------------------------

/** За сколько дней до списания предупреждаем. */
export const LIABILITY_WARNING_WINDOW_DAYS = 3;

export interface LiabilityWarningResult {
  /** Отправлено предупреждений. */
  delivered: number;
  /** Период уже предупреждён в этом месяце. */
  skipped: number;
  /** Отправка не удалась, предупреждение вернётся в следующий проход. */
  failed: number;
  /** ID обязательств, по которым ушло предупреждение. */
  liabilityIds: number[];
}

/** Ближайшее списание: календарный день в таймзоне пользователя. */
interface UpcomingPayment {
  /** `YYYY-MM-DD` — день списания. */
  dueKey: string;
  /** `YYYY-MM` — период, за который платят. */
  dueMonth: string;
  /** Сколько дней осталось (0 — сегодня). */
  days: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Число дней в месяце (1-based месяц). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `2026-11-13` → `13.11.2026` без участия таймзоны: это календарь, не момент. */
function formatDayKey(key: string): string {
  const [year, month, day] = key.split('-');
  return `${day}.${month}.${year}`;
}

/** «сегодня» / «завтра» / «через 3 дня». */
function relativeDays(days: number): string {
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'завтра';
  if (days < 5) return `через ${days} дня`;
  return `через ${days} дней`;
}

/** Сегодняшний календарь в таймзоне пользователя — считается один раз на проход. */
interface TodayInZone {
  /** `YYYY-MM-DD`. */
  todayKey: string;
  /** Полночь сегодняшнего дня по UTC-шкале — база для разницы в днях. */
  todayUtc: number;
  year: number;
  month: number;
}

function todayInZone(now: Date, timeZone: string): TodayInZone {
  const parts = zonedParts(now, timeZone);
  return {
    todayKey: dateKey(now, timeZone),
    todayUtc: Date.UTC(parts.year, parts.month - 1, parts.day),
    year: parts.year,
    month: parts.month,
  };
}

/**
 * Ближайшее списание по обязательству в таймзоне пользователя.
 *
 * День платежа зажимается по длине месяца (31-е в феврале → 28/29), как в
 * `runway.ts`. Если день в этом месяце уже прошёл — берём следующий месяц.
 */
function nextPayment(
  liability: LiabilityRow,
  today: TodayInZone,
): UpcomingPayment | null {
  const day = liability.paymentDay;
  if (day === null) return null;

  const candidates = [
    { year: today.year, month: today.month },
    today.month === 12
      ? { year: today.year + 1, month: 1 }
      : { year: today.year, month: today.month + 1 },
  ];

  for (const { year, month } of candidates) {
    const clamped = Math.min(day, daysInMonth(year, month));
    const dueKey = `${year}-${pad2(month)}-${pad2(clamped)}`;
    if (dueKey < today.todayKey) continue;
    return {
      dueKey,
      dueMonth: `${year}-${pad2(month)}`,
      days: Math.round((Date.UTC(year, month - 1, clamped) - today.todayUtc) / 86_400_000),
    };
  }
  return null;
}

/** Текст предупреждения о списании. */
export function buildLiabilityWarningText(
  liability: LiabilityRow,
  payment: UpcomingPayment,
): string {
  return [
    '🏦 <b>Скоро списание</b>',
    '',
    `<b>${escapeHtml(liability.name)}</b> — ${formatMoney(
      liability.monthlyPaymentCents,
      liability.currency,
    )}`,
    `<i>${formatDayKey(payment.dueKey)} — ${relativeDays(payment.days)}</i>`,
  ].join('\n');
}

/** Клавиатура предупреждения: существующий `nav:debts`, новых callback-ов нет. */
export function buildLiabilityWarningKeyboard() {
  return {
    inline_keyboard: [[{ text: '📋 Все долги', callback_data: 'nav:debts' }]],
  };
}

/**
 * Доставляет предупреждения о списании по обязательствам.
 *
 * Идемпотентность без миграции: ключ в kv на период
 * `liability_warn:<user_id>:<liability_id>:<YYYY-MM>`. Метка ставится ДО
 * отправки и атомарно (`kvSetIfAbsent` → `ON CONFLICT DO NOTHING`), поэтому два
 * параллельных прохода (вебхук и RPC) не пришлют дубль; неудачная отправка метку
 * снимает. Одно предупреждение на обязательство в месяц — окно в 3 дня не
 * превращается в три сообщения подряд.
 *
 * Метки чистятся `pruneStaleKvLabels`: возраст берётся из `dueAt` в значении,
 * поэтому старый период не живёт в `kv` дольше горизонта хранения.
 */
export async function deliverLiabilityWarnings(
  userId: number,
  options: DeliverRemindersOptions = {},
): Promise<LiabilityWarningResult> {
  const empty: LiabilityWarningResult = { delivered: 0, skipped: 0, failed: 0, liabilityIds: [] };
  const now = resolveNow(options.now);
  if (!now) return empty;

  const timeZone = (await getUser(userId))?.timezone ?? 'Europe/Berlin';
  const liabilities = await listLiabilities(userId, 'active');
  if (liabilities.length === 0) return empty;

  const today = todayInZone(now, timeZone);
  const chatId = options.chatId ?? userId;
  const result: LiabilityWarningResult = { ...empty, liabilityIds: [] };

  for (const liability of liabilities) {
    // Платежи без суммы и без дня списания не о чем предупреждать.
    if (Math.round(liability.monthlyPaymentCents) <= 0) continue;

    const payment = nextPayment(liability, today);
    if (!payment || payment.days > LIABILITY_WARNING_WINDOW_DAYS) continue;

    // Обязательство с истёкшим сроком закрывается само, а не напоминает.
    if (liability.endDate !== null && liability.endDate < payment.dueKey) continue;
    if (liability.paidMonths.includes(payment.dueMonth)) continue;

    // Владелец уже ответил на «Проверку списаний» за этот месяц: его решение
    // сильнее напоминания, повторно спрашивать и предупреждать не о чем.
    // Зависший `pending`-claim не гасит напоминание.
    if (isLiabilityReviewSettled(await kvGet(liabilityReviewKey(userId, liability.id, payment.dueMonth)))) {
      continue;
    }

    const key = `liability_warn:${userId}:${liability.id}:${payment.dueMonth}`;
    const claimed = await kvSetIfAbsent(
      key,
      JSON.stringify({ warnedAt: toIso(now), dueAt: payment.dueKey }),
    );
    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: buildLiabilityWarningText(liability, payment),
        parse_mode: 'HTML',
        reply_markup: buildLiabilityWarningKeyboard(),
      });
      result.delivered += 1;
      result.liabilityIds.push(liability.id);
    } catch (err) {
      result.failed += 1;
      const permanent = err instanceof BotApiError && (err.code === 400 || err.code === 403);
      if (!permanent) {
        try {
          await kvDelete(key);
        } catch (deleteErr) {
          console.warn('reminders: liability warning release failed', liability.id, deleteErr);
        }
      }
      console.warn(
        permanent
          ? 'reminders: permanent liability warning failure'
          : 'reminders: liability warning failed',
        liability.id,
        err,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Проверка списаний по обязательствам
// ---------------------------------------------------------------------------

function isLiabilityReviewSettled(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as { status?: unknown } | null;
    if (parsed !== null && typeof parsed === 'object' && parsed.status === 'pending') {
      return false;
    }
  } catch {
    // Непарсимое непустое значение трактуем как решённое (legacy/мусор не спамит).
  }
  return true;
}

export interface LiabilityReviewResult {
  /** Отправлено сообщений (проверка — одно сообщение на все пункты). */
  delivered: number;
  /** Пункт уже решён или оплачен в этом месяце. */
  skipped: number;
  /** Отправка не удалась; следующий проход попробует снова. */
  failed: number;
  /** ID обязательств, по которым ушла проверка. */
  liabilityIds: number[];
}

/**
 * Второе сообщение после утреннего дайджеста: активные обязательства с уже
 * наступившей датой платежа текущего локального месяца.
 *
 * Отдельно от `deliverLiabilityWarnings`: предупреждение — «скоро списание», а
 * проверка — «списание уже должно было пройти, отметь». Решение владельца живёт
 * в `liability_review:<user_id>:<id>:<YYYY-MM>` и ставится обработчиком кнопки;
 * здесь только читается, поэтому повторный проход не спрашивает решённое.
 * Оплаченный месяц и истёкший срок тоже не показываются.
 *
 * Идемпотентности доставки нет намеренно: пока решение не принято, вопрос
 * уместен каждое утро и после ручного `/digest`. Своего `kv`-маркера на
 * отправку у проверки нет — иначе первое утро съедало бы весь месяц.
 */
export async function deliverLiabilityReview(
  userId: number,
  options: DeliverRemindersOptions = {},
): Promise<LiabilityReviewResult> {
  const empty: LiabilityReviewResult = { delivered: 0, skipped: 0, failed: 0, liabilityIds: [] };
  const now = resolveNow(options.now);
  if (!now) return empty;

  const timeZone = (await getUser(userId))?.timezone ?? 'Europe/Berlin';
  const liabilities = await listLiabilities(userId, 'active');
  if (liabilities.length === 0) return empty;

  const items: LiabilityReviewItem[] = [];
  let skipped = 0;
  for (const liability of liabilities) {
    // Погашенное не-регулярное обязательство (остаток <= 0) не требует проверки.
    if (!isRecurringQueue(liability.queue) && liability.amountCents <= 0) continue;

    const dueKey = liabilityReviewDueDate(liability, now, timeZone);
    if (!dueKey) continue;
    // Истёкшее обязательство закрывается само; оплаченный месяц уже в долге.
    if (liability.endDate !== null && liability.endDate < dueKey) continue;

    const month = dueKey.slice(0, 7);
    if (liability.paidMonths.includes(month)) {
      skipped += 1;
      continue;
    }
    if (isLiabilityReviewSettled(await kvGet(liabilityReviewKey(userId, liability.id, month)))) {
      skipped += 1;
      continue;
    }
    items.push({ liability, month, dueKey });
  }

  if (items.length === 0) return { ...empty, skipped };

  try {
    await api.sendMessage({
      chat_id: options.chatId ?? userId,
      text: buildLiabilityReviewMessage(items),
      parse_mode: 'HTML',
      reply_markup: buildLiabilityReviewKeyboard(items),
    });
  } catch (err) {
    // Метки на отправку нет: снимать нечего, следующий проход попробует снова.
    console.warn('reminders: liability review failed', userId, err);
    return { ...empty, skipped, failed: 1 };
  }

  return {
    delivered: 1,
    skipped,
    failed: 0,
    liabilityIds: items.map((item) => item.liability.id),
  };
}

// ---------------------------------------------------------------------------
// Напоминания о приёме лекарств
// ---------------------------------------------------------------------------

/**
 * Насколько опоздавшую дозу ещё напоминаем, минут. Доза, созревшая раньше, чем
 * `now - 3 часа`, гасится молча: приходить в чат в 23:00 с «пора принять» от
 * 09:00 — это шум, а не забота (и провоцирует двойную дозу).
 */
export const MEDICATION_REMINDER_WINDOW_MINUTES = 180;

/** Сколько доз максимум доставляем за проход. */
export const DEFAULT_MEDICATIONS_PER_PASS = 5;

export interface MedicationReminderResult {
  /** Отправлено сообщений. */
  delivered: number;
  /** Доза уже отмечена или метку забрал параллельный проход. */
  skipped: number;
  /** Отправка не удалась, доза вернётся в следующий проход. */
  failed: number;
  /** ID медикаментов, по которым ушло напоминание (в порядке времени приёма). */
  medicationIds: number[];
}

/** Текст напоминания о приёме. */
export function buildMedicationReminderText(dose: MedicationDose): string {
  const medication = dose.medication;
  const head = medication.dosage
    ? `<b>${escapeHtml(medication.name)}</b> — ${escapeHtml(medication.dosage)}`
    : `<b>${escapeHtml(medication.name)}</b>`;
  const lines = ['💊 <b>Пора принять лекарство</b>', '', head];
  if (medication.instructions) {
    lines.push(`<i>${escapeHtml(medication.instructions)}</i>`);
  }
  lines.push(`<i>По расписанию: ${dose.scheduledTime}</i>`);
  return lines.join('\n');
}

/** Клавиатура дозы: все три callback-а уже обслуживает `routeCallback`. */
export function buildMedicationReminderKeyboard(medicationId: number, scheduledTime: string) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Принял', callback_data: `med_take:${medicationId}:${scheduledTime}` },
        { text: '⏭ Пропустить', callback_data: `med_skip:${medicationId}:${scheduledTime}` },
      ],
      [{ text: '⏳ +15 мин', callback_data: `med_postpone:${medicationId}:${scheduledTime}` }],
    ],
  };
}

/**
 * Доставляет созревшие дозы пользователя.
 *
 * Созрело = запись в журнале ещё `pending`, препарат ежедневный (`daily`),
 * время приёма уже наступило (в таймзоне пользователя) и опоздание не больше
 * `MEDICATION_REMINDER_WINDOW_MINUTES`. Окно считается в настенных минутах и
 * поэтому переходит через полночь: доза 23:30 при касании в 00:30 ещё созрела,
 * хотя календарный день уже сменился.
 *
 * `weekly` и `as_needed` не напоминают: в схеме нет дня недели, и «еженедельный»
 * препарат, напоминаемый ежедневно, — это медицински неверное сообщение.
 *
 * Идемпотентность без миграции: `med_remind:<user_id>:<id>:<YYYY-MM-DD>:<HH:MM>`
 * в `kv` через `kvSetIfAbsent` — метка ставится ДО отправки и атомарно, поэтому
 * вебхук и RPC не пришлют дубль. Неудачная отправка метку снимает, постоянный
 * отказ 400/403 — оставляет (как у задач и обязательств).
 *
 * `limit` ограничивает число ОТПРАВОК за проход, а не кандидатов: иначе уже
 * помеченные дозы каждый проход занимали бы первые слоты и более поздние дозы
 * не доехали бы никогда.
 *
 * Ограничение: доза, чьё окно закрылось до первого касания бота, не приходит
 * вовсе. В изоляте нет таймера — это цена ленивого крона, а не баг.
 */
export async function deliverMedicationReminders(
  userId: number,
  options: DeliverRemindersOptions = {},
): Promise<MedicationReminderResult> {
  const empty: MedicationReminderResult = { delivered: 0, skipped: 0, failed: 0, medicationIds: [] };
  const now = resolveNow(options.now);
  if (!now) return empty;

  const timeZone = (await getUser(userId))?.timezone ?? 'Europe/Berlin';
  const todayKey = dateKey(now, timeZone);
  const parts = zonedParts(now, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const limit = options.limit ?? DEFAULT_MEDICATIONS_PER_PASS;

  // Вчерашний журнал нужен только когда окно перекрывает полночь — иначе это
  // лишний SELECT на каждом касании бота.
  const dayKeys =
    nowMinutes < MEDICATION_REMINDER_WINDOW_MINUTES
      ? [dateKey(addDays(now, -1), timeZone), todayKey]
      : [todayKey];
  const perDay = await Promise.all(dayKeys.map((day) => listDoses(userId, day)));

  const due: Array<{ dose: MedicationDose; dayKey: string }> = [];
  perDay.forEach((doses, index) => {
    const dayKey = dayKeys[index];
    const fromYesterday = dayKey !== todayKey;
    for (const dose of doses) {
      if (dose.status !== 'pending') continue;
      // Ежедневные напоминают; `weekly` (нет дня недели) и `as_needed` — нет.
      if (dose.medication.frequency !== 'daily') continue;
      const scheduled = parseTimeOfDay(dose.scheduledTime);
      if (scheduled === null) continue;
      const late = nowMinutes - scheduled + (fromYesterday ? 1440 : 0);
      if (late < 0 || late > MEDICATION_REMINDER_WINDOW_MINUTES) continue;
      due.push({ dose, dayKey });
    }
  });

  if (due.length === 0) return empty;

  const chatId = options.chatId ?? userId;
  const result: MedicationReminderResult = { ...empty, medicationIds: [] };

  for (const { dose, dayKey } of due) {
    if (result.delivered >= limit) break;
    const key = `med_remind:${userId}:${dose.medication.id}:${dayKey}:${dose.scheduledTime}`;
    const claimed = await kvSetIfAbsent(
      key,
      JSON.stringify({ remindedAt: toIso(now), date: dayKey }),
    );
    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    try {
      await api.sendMessage({
        chat_id: chatId,
        text: buildMedicationReminderText(dose),
        parse_mode: 'HTML',
        reply_markup: buildMedicationReminderKeyboard(dose.medication.id, dose.scheduledTime),
      });
      result.delivered += 1;
      result.medicationIds.push(dose.medication.id);
    } catch (err) {
      result.failed += 1;
      const permanent = err instanceof BotApiError && (err.code === 400 || err.code === 403);
      if (!permanent) {
        try {
          await kvDelete(key);
        } catch (deleteErr) {
          console.warn('reminders: medication reminder release failed', dose.medication.id, deleteErr);
        }
      }
      console.warn(
        permanent
          ? 'reminders: permanent medication reminder failure'
          : 'reminders: medication reminder failed',
        dose.medication.id,
        err,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Утренняя сводка
// ---------------------------------------------------------------------------

/** 07:00 — время сводки по умолчанию (`users.summary_time`), в настенных минутах. */
const DEFAULT_SUMMARY_MINUTES = 7 * 60;

/** Сутки в настенных минутах: окна напоминаний считаются по модулю суток. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Сколько минут после `summary_time` сводка ещё актуальна (12 часов: 07:00 → до 19:00).
 *
 * «Доброе утро» в 22:00 — не забота, а шум и укор за поздний старт дня
 * (MEMORY §1, антитревожный интерфейс). Сводка — якорь утра, а не отчёт о
 * сутках: пропущенный день восстанавливается `/digest` или в Mini App, поэтому
 * закрытое окно честнее retroactive-пуша. Тот же принцип, что у
 * `MEDICATION_REMINDER_WINDOW_MINUTES`.
 */
export const MORNING_DIGEST_WINDOW_MINUTES = 720;

/**
 * Кнопка под сводкой: паритет с `getBackupInlineKeyboard` (`handlers/keyboards.ts`).
 * Продублирована одной строкой осознанно — `handlers/` не выкладывается отдельным
 * модулем, и `lib/` не может импортировать оттуда в рантайме (см. `build.mjs`).
 */
const BACKUP_INLINE_KEYBOARD = {
  inline_keyboard: [[{ text: '📥 Скачать бэкап .json', callback_data: 'backup:download' }]],
};

export interface MorningDigestResult {
  /** Хотя бы один кусок ушёл; частичный сбой даёт `delivered: 1` вместе с `failed: 1`. */
  delivered: number;
  /** Сегодня уже уходила: метка стоит. */
  skipped: number;
  /** Отправка не удалась; следующий проход попробует снова. */
  failed: number;
}

/**
 * Доставляет утреннюю сводку, если она созрела и ещё не уходила сегодня.
 *
 * Созрело = настенное время пользователя попало в окно
 * `[summary_time, summary_time + MORNING_DIGEST_WINDOW_MINUTES]`, где
 * `summary_time` — `users.summary_time` (по умолчанию 07:00, мусор в профиле
 * трактуется как 07:00). Сводка одна в день, поэтому `due_jobs` не нужен:
 * идемпотентность — метка в `kv` `morning_digest:<user_id>:<YYYY-MM-DD>`,
 * поставленная атомарно ДО отправки. Ключ привязан к пользователю: `kv` —
 * общая таблица без `user_id`.
 *
 * Текст собирает `buildMorningDigest` (`lib/digest.ts`) — пуш и `/digest`
 * показывают одно и то же. В Telegram он уходит той же Markdown→HTML
 * конверсией и той же нарезкой длинного текста, что и `/digest`, поэтому
 * разметка совпадает; клавиатура — существующий `backup:download`, новых
 * callback-префиксов нет.
 *
 * Дешёвая проверка метки стоит ДО сборки сводки: иначе каждое касание внутри
 * окна пересобирало бы её (десятки запросов к БД), чтобы найти готовый ключ.
 * `options.limit` не используется: сводка одна в день.
 *
 * Окно считается по модулю суток и поэтому **переходит через полночь**: при
 * `summary_time` 22:00 сводка созревает и в 00:30, как дозы лекарств.
 *
 * Сутки сводки — не календарные, а сутки её начала: хвост после полуночи
 * принадлежит вчерашнему `summary_time`, и метка у него та же. Иначе одна ночь
 * давала бы два дайджеста с разными ключами.
 */
export async function deliverMorningDigest(
  userId: number,
  options: DeliverRemindersOptions = {},
): Promise<MorningDigestResult> {
  const empty: MorningDigestResult = { delivered: 0, skipped: 0, failed: 0 };
  const now = resolveNow(options.now);
  if (!now) return empty;

  const user = await getUser(userId);
  // Нет строки — пользователь не прошёл гейт (в личной редакции чужой id
  // отклоняется до `ensureUser`). Сводку ему не шлём: иначе заблокированный
  // получает «всё закрыто, инбокс чист» в обход fail-closed гейта.
  if (!user) return empty;

  const timeZone = user.timezone ?? 'Europe/Berlin';
  const summaryMinutes = parseTimeOfDay(user.summaryTime ?? '') ?? DEFAULT_SUMMARY_MINUTES;
  const parts = zonedParts(now, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;

  // Минуты с `summary_time` по настенным часам, по модулю суток: окно
  // переходит через полночь, и 22:00 + 720 минут = 10:00 следующих суток.
  const sinceSummary =
    nowMinutes >= summaryMinutes
      ? nowMinutes - summaryMinutes
      : nowMinutes + MINUTES_PER_DAY - summaryMinutes;

  // Ещё рано или уже поздно: сегодня сводка не нужна, и это не ошибка.
  if (sinceSummary > MORNING_DIGEST_WINDOW_MINUTES) return empty;

  // Сутки сводки — сутки её начала, а не календарные: касание в 00:30 по окну
  // 22:00 принадлежит вчерашнему дню, и ключ у него вчерашний. Иначе ночь
  // родила бы два дайджеста — в 23:30 и в 00:30.
  const summaryDay = nowMinutes < summaryMinutes ? addDays(now, -1) : now;
  const dayKey = dateKey(summaryDay, timeZone);
  const key = `morning_digest:${userId}:${dayKey}`;
  if ((await kvGet(key)) !== null) return { ...empty, skipped: 1 };

  const text = markdownToTelegramHtml(await buildMorningDigest(userId, { now }));
  const claimed = await kvSetIfAbsent(
    key,
    JSON.stringify({ sentAt: toIso(now), digestDate: dayKey }),
  );
  // Метку мог забрать параллельный проход (вебхук и RPC одновременно).
  if (!claimed) return { ...empty, skipped: 1 };

  const chatId = options.chatId ?? userId;
  // Сводка не ограничена по длине (препараты, финансы, идея), а Telegram рвёт
  // сообщение на 4096 символах: режем тем же конвейером, что `/digest`. Кнопка
  // уходит только под последним чанком, как в `safeSendMessage`.
  const chunks = splitMessageChunks(text);
  let sentChunks = 0;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await api.sendMessage({
        chat_id: chatId,
        text: chunks[index] as string,
        parse_mode: 'HTML',
        ...(index === chunks.length - 1 ? { reply_markup: BACKUP_INLINE_KEYBOARD } : {}),
      });
      sentChunks += 1;
    }
    // «Проверка списаний» — отдельным сообщением после сводки. Её сбой не
    // отменяет уже доставленный дайджест и не снимает суточную метку: сводку
    // владелец получает всегда, а проверку доберёт следующий проход.
    try {
      await deliverLiabilityReview(userId, { now, chatId });
    } catch (err) {
      console.warn('reminders: liability review after digest failed', userId, err);
    }
    return { delivered: 1, skipped: 0, failed: 0 };
  } catch (err) {
    const permanent = err instanceof BotApiError && (err.code === 400 || err.code === 403);
    // Хотя бы один чанк уже ушёл: снимать суточную метку нельзя, иначе
    // следующий проход пришлёт первые чанки повторно. Недостающее владелец
    // дозабирает через `/digest`, который не трогает метку.
    if (!permanent && sentChunks === 0) {
      try {
        await kvDelete(key);
      } catch (deleteErr) {
        console.warn('reminders: morning digest release failed', userId, deleteErr);
      }
    }
    console.warn(
      permanent ? 'reminders: permanent morning digest failure' : 'reminders: morning digest failed',
      userId,
      err,
    );
    return { delivered: sentChunks > 0 ? 1 : 0, skipped: 0, failed: 1 };
  }
}

// ---------------------------------------------------------------------------
// Обслуживание хранилища: чистка протухших меток идемпотентности
// ---------------------------------------------------------------------------

/** Сколько суток метка напоминания живёт в `kv` после своей даты. */
export const KV_LABEL_RETENTION_DAYS = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Виды меток и поле значения, по которому считается их возраст.
 *
 * Ключи всех четырёх видов одноразовые: месяц обязательства, день дозы и сутки
 * сводки не повторяются, поэтому удаление старой метки не может привести к
 * повторной отправке. Решение по обязательству — тоже месячное: после чистки
 * старый месяц не вернётся (он уже прошёл), а метка нужна только как защита от
 * повтора и как память «я уже ответил». Значение — единственный источник
 * возраста: `updated_at` обновляется upsert-ом и о возрасте метки ничего не
 * говорит.
 */
const KV_LABEL_SOURCES: ReadonlyArray<{ prefix: string; dateFields: readonly string[] }> = [
  { prefix: 'liability_warn:', dateFields: ['dueAt', 'warnedAt'] },
  { prefix: 'liability_review:', dateFields: ['dueAt', 'decidedAt'] },
  { prefix: 'med_remind:', dateFields: ['date', 'remindedAt'] },
  { prefix: 'morning_digest:', dateFields: ['digestDate', 'sentAt'] },
];

export interface KvLabelPruneOptions {
  /** Точка отсчёта горизонта; по умолчанию «сейчас». */
  now?: Date;
  /** Горизонт хранения в сутках; по умолчанию `KV_LABEL_RETENTION_DAYS`. */
  retentionDays?: number;
}

export interface KvLabelPruneResult {
  /** Сколько меток просмотрено. */
  scanned: number;
  /** Сколько удалено как протухшие. */
  deleted: number;
  /** Сколько оставлено: свежие или удалённые параллельным проходом. */
  kept: number;
  /** Сколько пропущено: значение отсутствует, битое или без разборчивой даты. */
  skipped: number;
}

/** `YYYY-MM-DD` или ISO-таймстамп → миллисекунды UTC; мусор → `null`. */
function parseLabelMoment(value: string): number | null {
  const text = value.trim();
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dayMatch) {
    const [, year, month, day] = dayMatch;
    const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
    if (!Number.isFinite(ms)) return null;
    // `Date.UTC` переносит 2026-13-45 в следующий год, а это битая дата.
    return new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** Возраст метки по её JSON-значению; неразборчивое значение → `null`. */
function labelMoment(raw: string, dateFields: readonly string[]): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of dateFields) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const ms = parseLabelMoment(value);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * Удаляет протухшие метки идемпотентности напоминаний.
 *
 * Метки `liability_warn:`, `liability_review:`, `med_remind:` и `morning_digest:` одноразовые и без
 * чистки копятся вечно (~300 строк в год на личную базу). Возраст берётся из
 * значения (`dueAt` / `date` / `digestDate`), а не из `updated_at`, поэтому
 * метка, переписанная сегодня, не считается свежей. Метка без значения,
 * с битым JSON или без разборчивой даты **не удаляется**: неизвестный возраст
 * трактуется как «не старый», а не как «мусор». Чистка идемпотентна: повторный
 * проход в тех же сутках удалять уже нечего.
 */
export async function pruneStaleKvLabels(
  options: KvLabelPruneOptions = {},
): Promise<KvLabelPruneResult> {
  const now = options.now ?? new Date();
  const retentionDays = Math.max(0, Math.trunc(options.retentionDays ?? KV_LABEL_RETENTION_DAYS));
  // Горизонт — от начала текущих суток UTC: возраст меток задаётся днём, и
  // иначе метка на самой границе умирала бы на 9 часов раньше срока.
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const horizonMs = todayMs - retentionDays * DAY_MS;
  const result: KvLabelPruneResult = { scanned: 0, deleted: 0, kept: 0, skipped: 0 };

  for (const source of KV_LABEL_SOURCES) {
    const rows = await kvListByPrefix(source.prefix);
    for (const row of rows) {
      result.scanned += 1;
      const moment = labelMoment(row.value, source.dateFields);
      if (moment === null) {
        result.skipped += 1;
        continue;
      }
      // Горизонт включительный: ровно на границе метка ещё живёт.
      if (moment >= horizonMs) {
        result.kept += 1;
        continue;
      }
      try {
        if (await kvDelete(row.key)) result.deleted += 1;
        else result.kept += 1;
      } catch (err) {
        console.warn('reminders: stale kv label prune failed', row.key, err);
        result.skipped += 1;
      }
    }
  }

  return result;
}
