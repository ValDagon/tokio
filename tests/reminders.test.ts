/**
 * Доставка напоминаний (`src/lib/reminders.ts` + DAL-запросы в `dal/tasks.ts`).
 *
 * Что здесь закреплено:
 *  - созревшее напоминание уходит один раз и помечается `reminder_sent = 1`;
 *  - повторный проход не дублирует сообщение;
 *  - будущие, выполненные, отменённые и удалённые задачи не напоминают;
 *  - чужие задачи не попадают в чужой чат (скоуп по `user_id`);
 *  - протухшее (старше недели) гасится молча — выкатка не спамит архивом;
 *  - неудачная отправка снимает claim, и следующий проход пробует снова;
 *  - лимит прохода не теряет напоминания: остаток доезжает следующим заходом.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { api, BotApiError, callsOf, db, resetApi, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { createTask, getTask, updateTask } from '../src/lib/dal/tasks';
import { createLiability, getLiability } from '../src/lib/dal/finances';
import { createMedication, skipMedication, takeMedication } from '../src/lib/dal/medications';
import { ensureUser, updateUser } from '../src/lib/dal/users';
import {
  deliverDueReminders,
  deliverLiabilityReview,
  deliverLiabilityWarnings,
  deliverMedicationReminders,
  buildReminderText,
  buildReminderKeyboard,
  buildMedicationReminderText,
  buildMedicationReminderKeyboard,
  MEDICATION_REMINDER_WINDOW_MINUTES,
  deliverMorningDigest,
  MORNING_DIGEST_WINDOW_MINUTES,
  pruneStaleKvLabels,
} from '../src/lib/reminders';
import { kvDelete, kvGet, kvSet, liabilityReviewKey } from '../src/lib/dal/misc';
import { routineRunKey, saveUserPrefs } from '../src/lib/prefs';
import {
  applyLiabilityReviewChoice,
  LIABILITY_REVIEW_FAILED_TOAST,
  LIABILITY_REVIEW_TAKEN_TOAST,
} from '../src/handlers/ingest';
import type { LiabilityQueue } from '../src/lib/types';
import { timeKey, zonedParts } from '../src/lib/utils';
import handleUpdate from '../src/handlers/message';

const USER = 100001;
const OTHER = 2002;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-10T18:00:00.000Z');

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  await ensureUser(USER, 'Owner');
  await ensureUser(OTHER, 'Other');
});

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

const sent = () => callsOf('sendMessage');

/** Утренняя сводка владельцу в заданный момент UTC (профиль — `UTC`). */
const digestAt = (nowIso: string) => deliverMorningDigest(USER, { now: new Date(nowIso) });

describe('reminders: доставка', () => {
  it('доставляет созревшее напоминание один раз и ставит флаг', async () => {
    const task = await createTask(USER, { title: 'Позвонить в банк', remindAt: iso(-5 * 60_000) });

    const result = await deliverDueReminders(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(result.taskIds).toEqual([task.id]);
    expect(sent()).toHaveLength(1);

    const [message] = sent();
    expect(message.params.chat_id).toBe(USER);
    expect(String(message.params.text)).toContain('Позвонить в банк');
    expect(message.params.parse_mode).toBe('HTML');
    const keyboard = message.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const data = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain(`task_done:${task.id}`);
    expect(data).toContain(`task_snooze:${task.id}:60`);

    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);
  });

  it('повторный проход не отправляет то же напоминание дважды', async () => {
    await createTask(USER, { title: 'Выпить таблетку', remindAt: iso(-60_000) });

    await deliverDueReminders(USER, { now: NOW });
    const second = await deliverDueReminders(USER, { now: NOW });

    expect(second.delivered).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it('будущие напоминания ждут своего срока', async () => {
    await createTask(USER, { title: 'Завтра', remindAt: iso(HOUR) });

    const result = await deliverDueReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('выполненные, отменённые и удалённые задачи не напоминают', async () => {
    const done = await createTask(USER, { title: 'Сделано', remindAt: iso(-HOUR) });
    const cancelled = await createTask(USER, { title: 'Отменено', remindAt: iso(-HOUR) });
    const removed = await createTask(USER, { title: 'Удалено', remindAt: iso(-HOUR) });

    await db.run(sql`UPDATE tasks SET status = 'done' WHERE id = ${done.id}`);
    await db.run(sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${cancelled.id}`);
    await db.run(sql`UPDATE tasks SET deleted_at = ${iso(0)} WHERE id = ${removed.id}`);

    const result = await deliverDueReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('скоупит доставку по user_id', async () => {
    await createTask(USER, { title: 'Своё', remindAt: iso(-HOUR) });
    await createTask(OTHER, { title: 'Чужое', remindAt: iso(-HOUR) });

    const result = await deliverDueReminders(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(String(sent()[0].params.text)).toContain('Своё');
    expect(String(sent()[0].params.text)).not.toContain('Чужое');
  });

  it('гасит протухшее старше недели без отправки', async () => {
    const stale = await createTask(USER, { title: 'Древнее', remindAt: iso(-8 * DAY) });
    const fresh = await createTask(USER, { title: 'Свежее', remindAt: iso(-HOUR) });

    const result = await deliverDueReminders(USER, { now: NOW });

    expect(result.expired).toBe(1);
    expect(result.delivered).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(String(sent()[0].params.text)).toContain('Свежее');
    expect((await getTask(USER, stale.id))?.reminderSent).toBe(true);
    expect((await getTask(USER, fresh.id))?.reminderSent).toBe(true);
  });

  it('уважает лимит прохода и не теряет остаток', async () => {
    for (let i = 0; i < 4; i += 1) {
      await createTask(USER, { title: `Задача ${i}`, remindAt: iso(-(10 - i) * 60_000) });
    }

    const first = await deliverDueReminders(USER, { now: NOW, limit: 2 });
    expect(first.delivered).toBe(2);
    expect(sent()).toHaveLength(2);

    const second = await deliverDueReminders(USER, { now: NOW, limit: 2 });
    expect(second.delivered).toBe(2);
    expect(sent()).toHaveLength(4);
  });

  it('неудачная отправка снимает claim и повторяется в следующий проход', async () => {
    const task = await createTask(USER, { title: 'Хрупкое', remindAt: iso(-60_000) });

    // `api` — Proxy, поэтому `vi.spyOn` не находит свойство: подменяем явно.
    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValueOnce(new Error('telegram is down')),
      configurable: true,
    });

    const failed = await deliverDueReminders(USER, { now: NOW });
    expect(failed.delivered).toBe(0);
    expect(failed.failed).toBe(1);
    expect((await getTask(USER, task.id))?.reminderSent).toBe(false);

    delete (api as Record<string, unknown>).sendMessage;

    const retried = await deliverDueReminders(USER, { now: NOW });
    expect(retried.delivered).toBe(1);
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);
  });

  it('постоянный отказ (403 «бот заблокирован») не повторяется', async () => {
    const task = await createTask(USER, { title: 'Заблокировано', remindAt: iso(-60_000) });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValue(new BotApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user')),
      configurable: true,
    });

    const failed = await deliverDueReminders(USER, { now: NOW });
    expect(failed.delivered).toBe(0);
    expect(failed.failed).toBe(1);
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);

    delete (api as Record<string, unknown>).sendMessage;

    const retried = await deliverDueReminders(USER, { now: NOW });
    expect(retried.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('задача в работе тоже напоминает', async () => {
    await createTask(USER, { title: 'В процессе', status: 'in_progress', remindAt: iso(-HOUR) });

    const result = await deliverDueReminders(USER, { now: NOW });

    expect(result.delivered).toBe(1);
  });
});

describe('reminders: перенос и повторная доставка', () => {
  it('снуз переоткрывает напоминание и доставляет его ровно один раз', async () => {
    const task = await createTask(USER, { title: 'Отложенное', remindAt: iso(-HOUR) });
    await deliverDueReminders(USER, { now: NOW });
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);

    // Кнопка «⏳ +1 час» переносит remindAt в будущее и сбрасывает флаг.
    await updateTask(USER, task.id, { remindAt: iso(HOUR) });
    expect((await getTask(USER, task.id))?.reminderSent).toBe(false);

    expect((await deliverDueReminders(USER, { now: NOW })).delivered).toBe(0);

    const later = new Date(NOW.getTime() + 2 * HOUR);
    expect((await deliverDueReminders(USER, { now: later })).delivered).toBe(1);
    expect((await deliverDueReminders(USER, { now: later })).delivered).toBe(0);
    expect(sent()).toHaveLength(2);
  });

  it('PATCH с тем же remind_at не переоткрывает доставленное напоминание', async () => {
    const remindAt = iso(-HOUR);
    const task = await createTask(USER, { title: 'Без изменений', remindAt });
    await deliverDueReminders(USER, { now: NOW });
    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);

    await updateTask(USER, task.id, { remindAt, title: 'Без изменений (правка)' });

    expect((await getTask(USER, task.id))?.reminderSent).toBe(true);
    expect((await deliverDueReminders(USER, { now: NOW })).delivered).toBe(0);
  });
});

describe('reminders: касание бота', () => {
  it('обычное сообщение в бота доставляет созревшее напоминание', async () => {
    await createTask(USER, {
      title: 'Проверить почту',
      remindAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await handleUpdate({
      message_id: 1,
      chat: { id: USER },
      from: { id: USER, first_name: 'Owner' },
      text: '/help',
    });

    const texts = sent().map((call) => String(call.params?.text ?? ''));
    expect(texts.some((text) => text.includes('Проверить почту'))).toBe(true);
  });

  it('касание бота доставляет предупреждение о списании', async () => {
    const due = new Date(Date.now() + 3 * 86_400_000);
    await createLiability(USER, {
      name: 'Аренда квартиры',
      paymentDay: zonedParts(due, 'UTC').day,
      monthlyPaymentCents: 45000,
    });

    await handleUpdate({
      message_id: 2,
      chat: { id: USER },
      from: { id: USER, first_name: 'Owner' },
      text: '/help',
    });

    const texts = sent().map((call) => String(call.params?.text ?? ''));
    expect(texts.some((text) => text.includes('Аренда квартиры'))).toBe(true);
  });
});

describe('reminders: обязательства', () => {
  it('предупреждает за 3 дня до списания ровно один раз', async () => {
    await createLiability(USER, {
      name: 'Аренда',
      queue: 'queue_1',
      amountEurCents: 45000,
      monthlyPaymentCents: 45000,
      paymentDay: 13,
    });

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(sent()).toHaveLength(1);

    const message = sent()[0];
    expect(message.params.chat_id).toBe(USER);
    expect(String(message.params.text)).toContain('Аренда');
    expect(String(message.params.text)).toContain('€450,00');
    expect(String(message.params.text)).toContain('13.11.2026');
    expect(message.params.parse_mode).toBe('HTML');

    const keyboard = message.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toContain('nav:debts');

    // Второй проход в тот же день молчит: одно предупреждение на период.
    expect((await deliverLiabilityWarnings(USER, { now: NOW })).delivered).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it('молчит, если месяц уже оплачен', async () => {
    await createLiability(USER, {
      name: 'Интернет',
      paymentDay: 12,
      monthlyPaymentCents: 3000,
      paidMonths: ['2026-11'],
    });

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('не предупреждает за 4 дня и не вспоминает прошедший день', async () => {
    await createLiability(USER, { name: 'Раннее', paymentDay: 14, monthlyPaymentCents: 1000 });
    await createLiability(USER, { name: 'Прошедшее', paymentDay: 5, monthlyPaymentCents: 1000 });

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('пропускает закрытые, без дня списания и с нулевым платежом', async () => {
    await createLiability(USER, { name: 'Закрытое', paymentDay: 12, monthlyPaymentCents: 1000, isActive: false });
    await createLiability(USER, { name: 'Без дня', paymentDay: null, monthlyPaymentCents: 1000 });
    await createLiability(USER, { name: 'Ноль', paymentDay: 12, monthlyPaymentCents: 0 });

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('зажимает 31-е по длине месяца', async () => {
    await createLiability(USER, { name: 'Подписка', paymentDay: 31, monthlyPaymentCents: 990 });

    const result = await deliverLiabilityWarnings(USER, {
      now: new Date('2026-02-25T10:00:00.000Z'),
    });

    expect(result.delivered).toBe(1);
    expect(String(sent()[0].params.text)).toContain('28.02.2026');
  });

  it('скоупит предупреждения по user_id', async () => {
    await createLiability(USER, { name: 'Своё', paymentDay: 12, monthlyPaymentCents: 1000 });
    await createLiability(OTHER, { name: 'Чужое', paymentDay: 12, monthlyPaymentCents: 1000 });

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(String(sent()[0].params.text)).toContain('Своё');
    expect(String(sent()[0].params.text)).not.toContain('Чужое');
  });

  it('неудачная отправка снимает метку и повторяется в следующий проход', async () => {
    await createLiability(USER, { name: 'Хрупкое', paymentDay: 12, monthlyPaymentCents: 1000 });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValueOnce(new Error('telegram is down')),
      configurable: true,
    });

    const failed = await deliverLiabilityWarnings(USER, { now: NOW });
    expect(failed.failed).toBe(1);
    expect(failed.delivered).toBe(0);

    delete (api as Record<string, unknown>).sendMessage;

    const retried = await deliverLiabilityWarnings(USER, { now: NOW });
    expect(retried.delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('постоянный отказ (403) не ретраится на следующем проходе', async () => {
    await createLiability(USER, { name: 'Заблокировано', paymentDay: 12, monthlyPaymentCents: 1000 });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValue(new BotApiError('sendMessage', 403, 'Forbidden')),
      configurable: true,
    });

    expect((await deliverLiabilityWarnings(USER, { now: NOW })).failed).toBe(1);

    delete (api as Record<string, unknown>).sendMessage;

    expect((await deliverLiabilityWarnings(USER, { now: NOW })).delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('молчит, если срок обязательства истёк раньше списания', async () => {
    await createLiability(USER, {
      name: 'Последний платёж',
      paymentDay: 12,
      monthlyPaymentCents: 1000,
      endDate: '2026-11-11',
    });

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('переходит через год: декабрь → январь', async () => {
    await createLiability(USER, { name: 'Новый год', paymentDay: 2, monthlyPaymentCents: 1000 });

    const result = await deliverLiabilityWarnings(USER, {
      now: new Date('2026-12-30T10:00:00.000Z'),
    });

    expect(result.delivered).toBe(1);
    expect(String(sent()[0].params.text)).toContain('02.01.2027');
  });

  it('считает день по таймзоне пользователя, а не по UTC', async () => {
    await updateUser(USER, { timezone: 'Europe/Berlin' });
    await createLiability(USER, { name: 'На границе суток', paymentDay: 13, monthlyPaymentCents: 1000 });

    // 23:30 UTC 9 ноября = 00:30 10 ноября в Берлине → до 13-го ровно 3 дня.
    const atBerlinMidnight = new Date('2026-11-09T23:30:00.000Z');
    expect((await deliverLiabilityWarnings(USER, { now: atBerlinMidnight })).delivered).toBe(1);

    // В UTC это ещё 9 ноября → 4 дня, окно не открыто.
    await updateUser(USER, { timezone: 'UTC' });
    await createLiability(USER, { name: 'UTC-копия', paymentDay: 13, monthlyPaymentCents: 1000 });
    const second = await deliverLiabilityWarnings(USER, { now: atBerlinMidnight });
    expect(second.delivered).toBe(0);
    expect(sent()).toHaveLength(1);
  });
});

describe('reminders: проверка списаний', () => {
  it('уходит отдельным сообщением после утреннего дайджеста', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '07:00' });
    await createLiability(USER, {
      name: 'Кредит',
      amountCents: 120_000,
      monthlyPaymentCents: 35_000,
      paymentDay: 5,
    });

    const result = await deliverMorningDigest(USER, {
      now: new Date('2026-11-10T07:05:00.000Z'),
    });

    expect(result.delivered).toBe(1);
    const texts = sent().map((call) => String(call.params.text ?? ''));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Доброе утро');
    expect(texts[0]).not.toContain('Проверка списаний');
    expect(texts[1]).toContain('Проверка списаний');
    expect(texts[1]).toContain('Кредит');
    expect(texts[1]).toContain('05.11.2026');
  });

  it('ставит три кнопки на каждый пункт', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    const liability = await createLiability(USER, {
      name: 'Аренда',
      queue: 'service' as LiabilityQueue,
      monthlyPaymentCents: 45_000,
      paymentDay: 5,
    });

    const result = await deliverLiabilityReview(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(result.liabilityIds).toEqual([liability.id]);
    const keyboard = sent()[0].params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    expect(keyboard.inline_keyboard.flat().map((button) => button.callback_data)).toEqual([
      `lrev:${liability.id}:2026-11:p`,
      `lrev:${liability.id}:2026-11:n`,
      `lrev:${liability.id}:2026-11:d`,
    ]);
  });

  it('молчит про оплаченный месяц и уже принятое решение', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    const paid = await createLiability(USER, {
      name: 'Оплачено',
      amountCents: 10_000,
      monthlyPaymentCents: 10_000,
      paymentDay: 5,
      paidMonths: ['2026-11'],
    });
    const decided = await createLiability(USER, {
      name: 'Решено',
      amountCents: 10_000,
      monthlyPaymentCents: 10_000,
      paymentDay: 5,
    });
    await kvSet(
      liabilityReviewKey(USER, decided.id, '2026-11'),
      JSON.stringify({ decision: 'unpaid', decidedAt: iso(0), dueAt: '2026-11-05' }),
    );

    const result = await deliverLiabilityReview(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(result.skipped).toBe(2);
    expect(sent()).toHaveLength(0);
    expect(result.liabilityIds).not.toContain(paid.id);
  });

  it('не спрашивает про будущий платёж, истёкший срок и закрытое обязательство', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    await createLiability(USER, { name: 'Будущее', paymentDay: 20, monthlyPaymentCents: 1_000 });
    await createLiability(USER, {
      name: 'Истекло',
      paymentDay: 5,
      monthlyPaymentCents: 1_000,
      endDate: '2026-11-04',
    });
    await createLiability(USER, {
      name: 'Закрыто',
      paymentDay: 5,
      monthlyPaymentCents: 1_000,
      isActive: false,
    });

    expect((await deliverLiabilityReview(USER, { now: NOW })).delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('скоупит проверку по user_id', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    await updateUser(OTHER, { timezone: 'UTC' });
    await createLiability(USER, {
      name: 'Своё',
      paymentDay: 5,
      amountCents: 10_000,
      monthlyPaymentCents: 1_000,
    });
    await createLiability(OTHER, {
      name: 'Чужое',
      paymentDay: 5,
      amountCents: 10_000,
      monthlyPaymentCents: 1_000,
    });

    await deliverLiabilityReview(USER, { now: NOW });

    expect(String(sent()[0].params.text)).toContain('Своё');
    expect(String(sent()[0].params.text)).not.toContain('Чужое');
  });

  it('предупреждение о списании молчит, если решение уже принято', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    const liability = await createLiability(USER, {
      name: 'Интернет',
      paymentDay: 12,
      monthlyPaymentCents: 3_000,
    });
    await kvSet(
      liabilityReviewKey(USER, liability.id, '2026-11'),
      JSON.stringify({ decision: 'paid', decidedAt: iso(0), dueAt: '2026-11-12' }),
    );

    const result = await deliverLiabilityWarnings(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('LREV-ZERO1: пропускает не-регулярное обязательство с нулевым остатком, но доставляет регулярное и с положительным остатком', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    const zeroDebt = await createLiability(USER, {
      name: 'Погашенный кредит',
      queue: 'queue_1',
      amountCents: 0,
      monthlyPaymentCents: 35_000,
      paymentDay: 5,
    });

    const first = await deliverLiabilityReview(USER, { now: NOW });
    expect(first.delivered).toBe(0);
    expect(first.liabilityIds).toEqual([]);
    expect(sent()).toHaveLength(0);

    const recurring = await createLiability(USER, {
      name: 'Подписка',
      queue: 'subscription' as LiabilityQueue,
      amountCents: 0,
      monthlyPaymentCents: 1_500,
      paymentDay: 5,
    });
    const activeLoan = await createLiability(USER, {
      name: 'Ипотека',
      queue: 'queue_2',
      amountCents: 500_000,
      monthlyPaymentCents: 50_000,
      paymentDay: 5,
    });

    const second = await deliverLiabilityReview(USER, { now: NOW });
    expect(second.delivered).toBe(1);
    expect(second.liabilityIds).toEqual([recurring.id, activeLoan.id]);
    expect(second.liabilityIds).not.toContain(zeroDebt.id);
    const text = String(sent()[0].params.text);
    expect(text).toContain('Подписка');
    expect(text).toContain('Ипотека');
    expect(text).not.toContain('Погашенный кредит');
  });

  it('LREV-CLAIM1: при сбое payLiability и kvDelete оставляет pending-claim, не скрывает месяц в deliverLiabilityReview и восстанавливается при повторе', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    const loan = await createLiability(USER, {
      name: 'Кредит',
      queue: 'queue_2',
      amountCents: 120_000,
      monthlyPaymentCents: 35_000,
      paymentDay: 5,
    });
    const key = liabilityReviewKey(USER, loan.id, '2026-11');

    const originalRun = db.run;
    const failSpy = vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
      if (text.includes('UPDATE liabilities')) {
        throw new Error('liabilities write failed');
      }
      if (text.includes('DELETE FROM kv')) {
        throw new Error('kv delete failed');
      }
      return originalRun.call(db, query as never, params);
    });

    let failedResult;
    try {
      failedResult = await applyLiabilityReviewChoice({
        userId: USER,
        data: `lrev:${loan.id}:2026-11:p`,
        now: NOW,
      });
    } finally {
      failSpy.mockRestore();
    }

    expect(failedResult).toEqual({ toast: LIABILITY_REVIEW_FAILED_TOAST, alert: true });
    const strandedRaw = await kvGet(key);
    expect(strandedRaw).not.toBeNull();
    expect(JSON.parse(String(strandedRaw))).toMatchObject({
      decision: 'paid',
      status: 'pending',
    });

    const reviewWhilePending = await deliverLiabilityReview(USER, { now: NOW });
    expect(reviewWhilePending.delivered).toBe(1);
    expect(reviewWhilePending.liabilityIds).toEqual([loan.id]);

    const retried = await applyLiabilityReviewChoice({
      userId: USER,
      data: `lrev:${loan.id}:2026-11:p`,
      now: NOW,
    });
    expect(retried.alert).not.toBe(true);
    expect(retried.toast).toContain('оплачено');

    const finalizedRaw = await kvGet(key);
    expect(JSON.parse(String(finalizedRaw))).toMatchObject({
      decision: 'paid',
      status: 'done',
    });
    const updatedLoan = await getLiability(USER, loan.id);
    expect(updatedLoan?.paidMonths).toEqual(['2026-11']);
    expect(updatedLoan?.amountCents).toBe(85_000);

    const afterDone = await applyLiabilityReviewChoice({
      userId: USER,
      data: `lrev:${loan.id}:2026-11:p`,
      now: NOW,
    });
    expect(afterDone).toEqual({ toast: LIABILITY_REVIEW_TAKEN_TOAST });
  });

  it('LREV-CLAIM1: done-claim, legacy-запись без status и конкурентный in-flight вызов возвращают LIABILITY_REVIEW_TAKEN_TOAST', async () => {
    await updateUser(USER, { timezone: 'UTC' });

    const doneLoan = await createLiability(USER, {
      name: 'Закрыто',
      queue: 'queue_1',
      amountCents: 100_000,
      monthlyPaymentCents: 10_000,
      paymentDay: 5,
    });
    await kvSet(
      liabilityReviewKey(USER, doneLoan.id, '2026-11'),
      JSON.stringify({
        decision: 'unpaid',
        decidedAt: iso(0),
        dueAt: '2026-11-05',
        status: 'done',
      }),
    );
    expect(
      await applyLiabilityReviewChoice({
        userId: USER,
        data: `lrev:${doneLoan.id}:2026-11:p`,
        now: NOW,
      }),
    ).toEqual({ toast: LIABILITY_REVIEW_TAKEN_TOAST });

    const legacyLoan = await createLiability(USER, {
      name: 'Легаси',
      queue: 'queue_1',
      amountCents: 100_000,
      monthlyPaymentCents: 10_000,
      paymentDay: 5,
    });
    await kvSet(
      liabilityReviewKey(USER, legacyLoan.id, '2026-11'),
      JSON.stringify({
        decision: 'unpaid',
        decidedAt: iso(0),
        dueAt: '2026-11-05',
      }),
    );
    expect(
      await applyLiabilityReviewChoice({
        userId: USER,
        data: `lrev:${legacyLoan.id}:2026-11:p`,
        now: NOW,
      }),
    ).toEqual({ toast: LIABILITY_REVIEW_TAKEN_TOAST });
    const legacyReview = await deliverLiabilityReview(USER, { now: NOW });
    expect(legacyReview.delivered).toBe(0);
    expect(legacyReview.skipped).toBe(2);

    const raceLoan = await createLiability(USER, {
      name: 'Гонка',
      queue: 'queue_2',
      amountCents: 100_000,
      monthlyPaymentCents: 20_000,
      paymentDay: 5,
    });

    let releasePay!: () => void;
    const payGate = new Promise<void>((resolve) => {
      releasePay = resolve;
    });
    let notifyEnteredPay!: () => void;
    const enteredPay = new Promise<void>((resolve) => {
      notifyEnteredPay = resolve;
    });

    const originalRun = db.run;
    const holdSpy = vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      const text = typeof query === 'string' ? query : ((query as { text?: string }).text ?? '');
      if (text.includes('UPDATE liabilities')) {
        notifyEnteredPay();
        await payGate;
      }
      return originalRun.call(db, query as never, params);
    });

    try {
      const firstPromise = applyLiabilityReviewChoice({
        userId: USER,
        data: `lrev:${raceLoan.id}:2026-11:p`,
        now: NOW,
      });
      await enteredPay;

      const concurrent = await applyLiabilityReviewChoice({
        userId: USER,
        data: `lrev:${raceLoan.id}:2026-11:p`,
        now: NOW,
      });
      expect(concurrent).toEqual({ toast: LIABILITY_REVIEW_TAKEN_TOAST });

      releasePay();
      const firstResult = await firstPromise;
      expect(firstResult.alert).not.toBe(true);
      expect(firstResult.toast).toContain('оплачено');
      expect(
        JSON.parse(String(await kvGet(liabilityReviewKey(USER, raceLoan.id, '2026-11')))),
      ).toMatchObject({
        decision: 'paid',
        status: 'done',
      });
    } finally {
      releasePay();
      holdSpy.mockRestore();
    }
  });
});

describe('reminders: сообщение', () => {
  it('экранирует HTML в заголовке задачи', async () => {
    const task = await createTask(USER, { title: 'Купить <b>хлеб</b> & молоко' });

    const text = buildReminderText(task, 'Europe/Berlin');

    expect(text).toContain('&lt;b&gt;хлеб&lt;/b&gt; &amp; молоко');
    expect(text).not.toContain('<b>хлеб</b>');
  });

  it('клавиатура ведёт на существующие callback-и задачи', () => {
    const keyboard = buildReminderKeyboard(42);
    expect(keyboard.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      'task_done:42',
      'task_snooze:42:60',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Напоминания о лекарствах (§7.6)
// ---------------------------------------------------------------------------

/** Сегодняшняя дата NOW в UTC — база для явного `date` в логах. */
const TODAY = '2026-11-10';

/** Текст всех отправленных сообщений за тест. */
const texts = (): string[] => sent().map((call) => String(call.params?.text ?? ''));

describe('reminders: лекарства', () => {
  it('доставляет созревшую дозу один раз', async () => {
    // NOW = 18:00 UTC, доза на 17:45 — опоздание 15 минут, внутри окна.
    const medication = await createMedication(USER, {
      name: 'Магний',
      dosage: '1 таб.',
      times: ['17:45'],
    });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.medicationIds).toEqual([medication.id]);
    expect(sent()).toHaveLength(1);

    const [message] = sent();
    expect(message.params.chat_id).toBe(USER);
    expect(String(message.params.text)).toContain('Магний');
    expect(String(message.params.text)).toContain('17:45');
    expect(message.params.parse_mode).toBe('HTML');

    const keyboard = message.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const data = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain(`med_take:${medication.id}:17:45`);
    expect(data).toContain(`med_skip:${medication.id}:17:45`);
    expect(data).toContain(`med_postpone:${medication.id}:17:45`);

    // Второй проход молчит: метка уже стоит.
    expect((await deliverMedicationReminders(USER, { now: NOW })).delivered).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it('будущая доза ждёт своего срока', async () => {
    await createMedication(USER, { name: 'Вечерний', times: ['20:00'] });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('опоздавшую дозу за окном гасит молча', async () => {
    // 09:00 при 18:00 — опоздание 9 часов, напоминать поздно.
    await createMedication(USER, { name: 'Утренний', times: ['09:00'] });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('границу окна считает включительно', async () => {
    const late = MEDICATION_REMINDER_WINDOW_MINUTES;
    const inside = new Date(NOW.getTime() - late * 60_000); // ровно на границе
    const outside = new Date(NOW.getTime() - (late + 1) * 60_000);

    const insideTime = `${String(inside.getUTCHours()).padStart(2, '0')}:${String(
      inside.getUTCMinutes(),
    ).padStart(2, '0')}`;
    const outsideTime = `${String(outside.getUTCHours()).padStart(2, '0')}:${String(
      outside.getUTCMinutes(),
    ).padStart(2, '0')}`;

    await createMedication(USER, { name: 'На границе', times: [insideTime] });
    await createMedication(USER, { name: 'За границей', times: [outsideTime] });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(texts()[0]).toContain('На границе');
    expect(texts().some((text) => text.includes('За границей'))).toBe(false);
  });

  it('несколько приёмов в день — отдельные сообщения и отдельные метки', async () => {
    // Обе дозы внутри окна: 16:00 (опоздание 2 ч) и 17:00 (1 ч).
    const medication = await createMedication(USER, {
      name: 'Курс антибиотика',
      times: ['16:00', '17:00'],
    });

    const first = await deliverMedicationReminders(USER, { now: NOW });

    expect(first.delivered).toBe(2);
    expect(first.medicationIds).toEqual([medication.id, medication.id]);
    expect(sent()).toHaveLength(2);

    // Третья доза того же препарата в тот же день всё ещё не задета.
    const later = new Date(NOW.getTime() + 60 * 60_000); // 19:00
    await createMedication(USER, { name: 'Ночной', times: ['19:00'] });

    expect((await deliverMedicationReminders(USER, { now: later })).delivered).toBe(1);
    expect(sent()).toHaveLength(3);
  });

  it('уже отмеченный приём не напоминает', async () => {
    const taken = await createMedication(USER, { name: 'Принятый', times: ['17:30'] });
    const skipped = await createMedication(USER, { name: 'Пропущенный', times: ['17:30'] });
    const pending = await createMedication(USER, { name: 'Ожидающий', times: ['17:30'] });

    await takeMedication(USER, taken.id, '17:30', TODAY);
    await skipMedication(USER, skipped.id, '17:30', TODAY);

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(result.medicationIds).toEqual([pending.id]);
    expect(sent()).toHaveLength(1);
    expect(texts()[0]).toContain('Ожидающий');
  });

  it('препарат «по требованию» не напоминает', async () => {
    await createMedication(USER, {
      name: 'Обезболивающее',
      times: ['17:30'],
      frequency: 'as_needed',
    });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('еженедельный препарат не напоминает ежедневно', async () => {
    // В схеме нет дня недели: «weekly» напоминать каждый день — врать про приём.
    await createMedication(USER, {
      name: 'Метотрексат',
      times: ['17:30'],
      frequency: 'weekly',
    });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('окно переходит через полночь: вечерняя доза напоминает ночью', async () => {
    // Доза 23:30, касание в 00:30 следующего дня — опоздание 60 минут.
    await createMedication(USER, { name: 'Ночной', times: ['23:30'] });

    const afterMidnight = new Date('2026-11-11T00:30:00.000Z');
    const result = await deliverMedicationReminders(USER, { now: afterMidnight });

    expect(result.delivered).toBe(1);
    expect(String(sent()[0].params.text)).toContain('23:30');

    // Метка привязана к дате дозы, поэтому повтор ночью молчит.
    expect(
      (await deliverMedicationReminders(USER, { now: afterMidnight })).delivered,
    ).toBe(0);
  });

  it('лимит считает отправки и не голодает более поздние дозы', async () => {
    for (let i = 0; i < 3; i += 1) {
      await createMedication(USER, { name: `Курс ${i}`, times: ['17:00', '17:30'] });
    }

    // Три прохода по 2 отправки доставляют все 6 доз: уже помеченные не занимают слоты.
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await deliverMedicationReminders(USER, { now: NOW, limit: 2 })).delivered).toBe(2);
    }

    expect(sent()).toHaveLength(6);
    expect((await deliverMedicationReminders(USER, { now: NOW, limit: 2 })).delivered).toBe(0);
  });

  it('скоупит напоминания по user_id', async () => {
    await createMedication(OTHER, { name: 'Чужое', times: ['17:30'] });

    const result = await deliverMedicationReminders(USER, { now: NOW });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('считает время приёма в таймзоне пользователя', async () => {
    await updateUser(USER, { timezone: 'Europe/Berlin' });
    await createMedication(USER, { name: 'Утренний', times: ['09:00'] });

    // 08:15 UTC = 09:15 в Берлине: доза созрела 15 минут назад.
    const result = await deliverMedicationReminders(USER, {
      now: new Date('2026-11-10T08:15:00.000Z'),
    });

    expect(result.delivered).toBe(1);
  });

  it('в UTC та же доза ещё впереди', async () => {
    await createMedication(USER, { name: 'Утренний', times: ['09:00'] });

    // Тот же момент, но пользователь живёт в UTC: 08:15, доза только через 45 минут.
    const result = await deliverMedicationReminders(USER, {
      now: new Date('2026-11-10T08:15:00.000Z'),
    });

    expect(result.delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('неудачная отправка снимает метку и повторяется в следующий проход', async () => {
    await createMedication(USER, { name: 'Хрупкое', times: ['17:45'] });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValueOnce(new Error('telegram is down')),
      configurable: true,
    });

    const failed = await deliverMedicationReminders(USER, { now: NOW });
    expect(failed.delivered).toBe(0);
    expect(failed.failed).toBe(1);

    delete (api as Record<string, unknown>).sendMessage;

    const retried = await deliverMedicationReminders(USER, { now: NOW });
    expect(retried.delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('постоянный отказ (403 «бот заблокирован») не повторяется', async () => {
    await createMedication(USER, { name: 'Заблокировано', times: ['17:45'] });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValue(
        new BotApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user'),
      ),
      configurable: true,
    });

    expect((await deliverMedicationReminders(USER, { now: NOW })).failed).toBe(1);

    delete (api as Record<string, unknown>).sendMessage;

    expect((await deliverMedicationReminders(USER, { now: NOW })).delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('касание бота доставляет напоминание о лекарстве', async () => {
    // Доза на две минуты назад: касание бота происходит через несколько секунд,
    // и переход минуты (или суток) не должен ломать тест.
    const time = timeKey(new Date(Date.now() - 120_000), 'UTC');
    await createMedication(USER, { name: 'Послеобеденный', times: [time] });

    await handleUpdate({
      message_id: 3,
      chat: { id: USER },
      from: { id: USER, first_name: 'Owner' },
      text: '/help',
    });

    expect(texts().some((text) => text.includes('Послеобеденный'))).toBe(true);
  });
});

describe('reminders: сообщение о лекарстве', () => {
  it('экранирует HTML и показывает дозировку с расписанием', async () => {
    const medication = await createMedication(USER, {
      name: 'Витамин <b>D</b> & омега',
      dosage: '2 капли',
      times: ['09:00'],
    });

    const text = buildMedicationReminderText({
      medication,
      scheduledTime: '09:00',
      status: 'pending',
      takenAt: null,
    });

    expect(text).toContain('&lt;b&gt;D&lt;/b&gt; &amp; омега');
    expect(text).not.toContain('<b>D</b>');
    expect(text).toContain('2 капли');
    expect(text).toContain('09:00');
  });

  it('клавиатура ведёт на существующие callback-и аптечки', () => {
    const keyboard = buildMedicationReminderKeyboard(7, '09:00');
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      'med_take:7:09:00',
      'med_skip:7:09:00',
      'med_postpone:7:09:00',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Утренняя сводка (§7.6)
// ---------------------------------------------------------------------------

describe('reminders: утренняя сводка', () => {
  it('созревает после summary_time и приходит один раз в день', async () => {
    await updateUser(USER, { summaryTime: '17:30' });

    const result = await deliverMorningDigest(USER, { now: NOW });

    expect(result).toEqual({ delivered: 1, skipped: 0, failed: 0 });
    expect(sent()).toHaveLength(1);

    const [message] = sent();
    expect(message.params.chat_id).toBe(USER);
    const text = String(message.params.text);
    expect(text).toContain('Доброе утро');
    expect(text).toContain('10 ноября 2026');
    expect(message.params.parse_mode).toBe('HTML');

    const keyboard = message.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toContain(
      'backup:download',
    );

    // Второй проход в тот же день молчит: метка уже стоит.
    const second = await deliverMorningDigest(USER, { now: NOW });
    expect(second).toEqual({ delivered: 0, skipped: 1, failed: 0 });
    expect(sent()).toHaveLength(1);
  });

  it('до summary_time молчит', async () => {
    await updateUser(USER, { summaryTime: '18:30' });

    const result = await deliverMorningDigest(USER, { now: NOW });

    expect(result).toEqual({ delivered: 0, skipped: 0, failed: 0 });
    expect(sent()).toHaveLength(0);
  });

  it('без настройки приходит в 07:00 по профилю', async () => {
    const result = await deliverMorningDigest(USER, {
      now: new Date('2026-11-10T07:05:00.000Z'),
    });

    expect(result.delivered).toBe(1);
  });

  it('через 6 часов (+360 мин) сводка ещё доезжает (догоняет троттлинг GitHub Actions)', async () => {
    await updateUser(USER, { summaryTime: '12:00' });

    // 18:00 - 12:00 = 360 минут, 12-часовое окно (720 мин) ещё открыто.
    const result = await deliverMorningDigest(USER, { now: NOW });

    expect(result.delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('границу окна (720 мин) считает включительно, на 721-й минуте закрывает', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '07:00' });
    await updateUser(OTHER, { timezone: 'UTC', summaryTime: '07:00' });

    const summaryStart = new Date('2026-11-10T07:00:00.000Z');
    const boundary = new Date(summaryStart.getTime() + MORNING_DIGEST_WINDOW_MINUTES * 60_000);
    const justAfter = new Date(boundary.getTime() + 60_000);

    expect(MORNING_DIGEST_WINDOW_MINUTES).toBe(720);
    expect((await deliverMorningDigest(USER, { now: boundary })).delivered).toBe(1);
    expect((await deliverMorningDigest(OTHER, { now: justAfter })).delivered).toBe(0);
  });

  it('на следующий день приходит снова', async () => {
    await updateUser(USER, { summaryTime: '07:30' });

    const day1 = new Date('2026-11-10T08:00:00.000Z');
    const day2 = new Date('2026-11-11T08:00:00.000Z');

    expect((await deliverMorningDigest(USER, { now: day1 })).delivered).toBe(1);
    expect((await deliverMorningDigest(USER, { now: day2 })).delivered).toBe(1);
    expect(sent()).toHaveLength(2);
  });

  it('окно переходит через полночь: 22:00 созревает и после полуночи', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    // 21:59 — за минуту до окна, ещё рано.
    expect((await digestAt('2026-11-10T21:59:00.000Z')).delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('в 22:00 сводка созревает (начало окна включительно)', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    expect((await digestAt('2026-11-10T22:00:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('в 23:59 сводка всё ещё созрела', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    expect((await digestAt('2026-11-10T23:59:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('в 00:30 хвост окна 22:00 ещё доезжает', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    expect((await digestAt('2026-11-11T00:30:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('в 09:59 хвост окна 22:00 ещё доезжает', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    expect((await digestAt('2026-11-11T09:59:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('в 10:00 (ровно 720 минут) окно 22:00 ещё открыто включительно', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    expect((await digestAt('2026-11-11T10:00:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('в 10:01 окно 22:00 уже закрыто', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    // 22:00 + 720 минут = 10:00: следующая минута уже вне окна.
    expect((await digestAt('2026-11-11T10:01:00.000Z')).delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('обычное утро 07:00 не сдвинулось: до 07:00 молчит, в 07:00 приходит', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '07:00' });

    expect((await digestAt('2026-11-10T06:59:00.000Z')).delivered).toBe(0);
    expect((await digestAt('2026-11-10T07:00:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('одна ночь — одна сводка: хвост после полуночи считает вчерашние сутки', async () => {
    await updateUser(USER, { timezone: 'UTC', summaryTime: '22:00' });

    // Вечером сводка ушла под меткой 10 ноября.
    expect((await digestAt('2026-11-10T23:30:00.000Z')).delivered).toBe(1);
    // Тот же хвост окна после полуночи — уже помечен, дубля нет.
    expect(await digestAt('2026-11-11T00:30:00.000Z')).toEqual({
      delivered: 0,
      skipped: 1,
      failed: 0,
    });
    expect(sent()).toHaveLength(1);

    // Следующий вечер — новые сутки сводки, снова одна сводка.
    expect((await digestAt('2026-11-11T23:30:00.000Z')).delivered).toBe(1);
    expect(sent()).toHaveLength(2);
  });

  it('скоупит метку по user_id', async () => {
    await updateUser(USER, { summaryTime: '17:30' });
    await updateUser(OTHER, { summaryTime: '17:30' });

    expect((await deliverMorningDigest(USER, { now: NOW })).delivered).toBe(1);
    expect((await deliverMorningDigest(OTHER, { now: NOW })).delivered).toBe(1);

    expect(sent()).toHaveLength(2);
    expect(sent()[1].params.chat_id).toBe(OTHER);
  });

  it('считает summary_time в таймзоне пользователя', async () => {
    await updateUser(USER, { timezone: 'Europe/Berlin', summaryTime: '18:00' });
    await updateUser(OTHER, { timezone: 'UTC', summaryTime: '18:00' });

    // 17:10 UTC = 18:10 в Берлине: созрела 10 минут назад. В UTC — ещё рано.
    const at = new Date('2026-11-10T17:10:00.000Z');

    expect((await deliverMorningDigest(USER, { now: at })).delivered).toBe(1);
    expect((await deliverMorningDigest(OTHER, { now: at })).delivered).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it('мусор в summary_time трактуется как 07:00', async () => {
    await updateUser(USER, { summaryTime: 'кривое' });

    const result = await deliverMorningDigest(USER, {
      now: new Date('2026-11-10T07:10:00.000Z'),
    });

    expect(result.delivered).toBe(1);
  });

  it('неудачная отправка снимает метку и повторяется в следующий проход', async () => {
    await updateUser(USER, { summaryTime: '17:30' });

    Object.defineProperty(api, 'sendMessage', {
      value: vi.fn().mockRejectedValueOnce(new Error('telegram is down')),
      configurable: true,
    });

    const failed = await deliverMorningDigest(USER, { now: NOW });
    expect(failed).toEqual({ delivered: 0, skipped: 0, failed: 1 });

    delete (api as Record<string, unknown>).sendMessage;

    expect((await deliverMorningDigest(USER, { now: NOW })).delivered).toBe(1);
    expect(sent()).toHaveLength(1);
  });

  it('постоянный отказ (403 «бот заблокирован») не повторяется', async () => {
    await updateUser(USER, { summaryTime: '17:30' });

    Object.defineProperty(api, 'sendMessage', {
      value: vi
        .fn()
        .mockRejectedValue(
          new BotApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user'),
        ),
      configurable: true,
    });

    expect((await deliverMorningDigest(USER, { now: NOW })).failed).toBe(1);

    delete (api as Record<string, unknown>).sendMessage;

    expect((await deliverMorningDigest(USER, { now: NOW })).delivered).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('пользователю без строки в users не шлёт ничего', async () => {
    // Чужой id отклоняется гейтом доступа до `ensureUser`: сводка не должна
    // обходить fail-closed гейт и присылать «всё закрыто, инбокс чист».
    const result = await deliverMorningDigest(999_999, {
      now: new Date('2026-11-10T07:10:00.000Z'),
    });

    expect(result).toEqual({ delivered: 0, skipped: 0, failed: 0 });
    expect(sent()).toHaveLength(0);
  });

  it('режет длинную сводку на чанки, кнопка — только под последним', async () => {
    await updateUser(USER, { summaryTime: '17:30' });
    for (let i = 0; i < 40; i += 1) {
      await createMedication(USER, {
        name: `Препарат ${i} очень длинное название для проверки нарезки`,
        dosage: '1 таблетка',
        instructions: 'принимать после еды, запивая водой',
        times: ['09:00'],
      });
    }

    const result = await deliverMorningDigest(USER, { now: NOW });

    expect(result).toEqual({ delivered: 1, skipped: 0, failed: 0 });
    expect(sent().length).toBeGreaterThan(1);
    for (const call of sent()) expect(call.params.chat_id).toBe(USER);
    expect(sent()[0].params.reply_markup).toBeUndefined();

    const last = sent()[sent().length - 1];
    const keyboard = last.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toContain(
      'backup:download',
    );
  });

  it('ошибка второго чанка не повторяет первый: суточная метка остаётся, остаток — через /digest', async () => {
    await updateUser(USER, { summaryTime: '17:30' });
    for (let i = 0; i < 40; i += 1) {
      await createMedication(USER, {
        name: `Препарат ${i} очень длинное название для проверки нарезки`,
        dosage: '1 таблетка',
        instructions: 'принимать после еды, запивая водой',
        times: ['09:00'],
      });
    }

    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 1 })
      .mockRejectedValueOnce(new Error('telegram is down'));
    Object.defineProperty(api, 'sendMessage', { value: sendMessage, configurable: true });

    const first = await deliverMorningDigest(USER, { now: NOW });
    expect(first).toEqual({ delivered: 1, skipped: 0, failed: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const second = await deliverMorningDigest(USER, { now: NOW });
    expect(second.skipped).toBe(1);
    expect(second.failed).toBe(0);
    // Первый чанк не ушёл повторно: попыток столько же, сколько до второго прохода.
    expect(sendMessage).toHaveBeenCalledTimes(2);

    delete (api as Record<string, unknown>).sendMessage;
  });

  it('ошибка до первого чанка по-прежнему разрешает retry', async () => {
    await updateUser(USER, { summaryTime: '17:30' });
    for (let i = 0; i < 40; i += 1) {
      await createMedication(USER, {
        name: `Препарат ${i} очень длинное название для проверки нарезки`,
        dosage: '1 таблетка',
        instructions: 'принимать после еды, запивая водой',
        times: ['09:00'],
      });
    }

    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('telegram is down'))
      .mockResolvedValue({ message_id: 9 });
    Object.defineProperty(api, 'sendMessage', { value: sendMessage, configurable: true });

    const first = await deliverMorningDigest(USER, { now: NOW });
    expect(first).toEqual({ delivered: 0, skipped: 0, failed: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    delete (api as Record<string, unknown>).sendMessage;

    expect((await deliverMorningDigest(USER, { now: NOW })).delivered).toBe(1);
    expect(sent().length).toBeGreaterThan(0);
  });

  it('касание бота доставляет утреннюю сводку', async () => {
    // summary_time на две минуты назад: касание через несколько секунд не
    // должно зависеть от перехода минуты.
    const summaryTime = timeKey(new Date(Date.now() - 120_000), 'UTC');
    await updateUser(USER, { summaryTime });

    await handleUpdate({
      message_id: 4,
      chat: { id: USER },
      from: { id: USER, first_name: 'Owner' },
      text: '/help',
    });

    expect(texts().some((text) => text.includes('Доброе утро'))).toBe(true);
  });
});

describe('Волна 2: quietHours, настройки 5 проактивных джоб и чистка routine_run', () => {
  it('quietHours откладывают дайджест/лекарства/предупреждения, но НЕ глушат явные напоминания о задачах и /digest (ignoreQuietHours)', async () => {
    const quietMoment = new Date('2026-11-24T23:30:00.000Z');
    await updateUser(USER, { timezone: 'UTC', summaryTime: '23:00' });
    await saveUserPrefs(USER, {
      proactive: {
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
      },
    });
    await createTask(USER, {
      title: 'Явное ночное напоминание',
      remindAt: new Date(quietMoment.getTime() - 60_000).toISOString(),
    });
    await createMedication(USER, { name: 'Мелатонин', dosage: '3 мг', times: ['23:00'] });

    const digestSkipped = await deliverMorningDigest(USER, { now: quietMoment });
    expect(digestSkipped.skipped).toBe(1);
    expect(digestSkipped.delivered).toBe(0);

    const medsSkipped = await deliverMedicationReminders(USER, { now: quietMoment });
    expect(medsSkipped.skipped).toBe(1);
    expect(medsSkipped.delivered).toBe(0);

    // Явное разовое напоминание о задаче пробивает quietHours
    const taskRes = await deliverDueReminders(USER, { now: quietMoment });
    expect(taskRes.delivered).toBe(1);

    // Ручной /digest c ignoreQuietHours тоже доставляет
    const forcedDigest = await deliverMorningDigest(USER, { now: quietMoment, ignoreQuietHours: true });
    expect(forcedDigest.delivered).toBe(1);
  });

  it('уважает enabled/windowMinutes/daysBefore и чистит протухшие routine_run:', async () => {
    const baseNow = new Date('2026-11-10T10:00:00.000Z');
    await updateUser(USER, { timezone: 'UTC', summaryTime: '09:00' });
    await createMedication(USER, { name: 'Омега', dosage: '1 г', times: ['08:00'] }); // 120 мин назад
    await createLiability(USER, {
      name: 'Кредит',
      queue: 'bank' as LiabilityQueue,
      amountCents: 100_000,
      currency: 'EUR',
      monthlyPaymentCents: 10_000,
      paymentDay: 15, // через 5 дней
    });

    await saveUserPrefs(USER, {
      proactive: {
        jobs: {
          morning_digest: { enabled: false },
          liability_warning: { enabled: true, daysBefore: 7 },
          medication_reminder: { enabled: true, windowMinutes: 60 }, // опоздание 120 > 60 -> не шлём
        },
      },
    });

    const dig = await deliverMorningDigest(USER, { now: baseNow });
    expect(dig.skipped).toBe(1);
    const meds = await deliverMedicationReminders(USER, { now: baseNow });
    expect(meds.delivered).toBe(0);
    const lw = await deliverLiabilityWarnings(USER, { now: baseNow });
    expect(lw.delivered).toBe(1);

    // Тест чистки routine_run: в pruneStaleKvLabels
    const oldKey = routineRunKey(USER, 'old_r', '2026-09-01');
    const freshKey = routineRunKey(USER, 'fresh_r', '2026-11-09');
    await kvSet(oldKey, JSON.stringify({ triggerDate: '2026-09-01', ranAt: '2026-09-01T10:00:00.000Z' }));
    await kvSet(freshKey, JSON.stringify({ triggerDate: '2026-11-09', ranAt: '2026-11-09T10:00:00.000Z' }));

    const pruneRes = await pruneStaleKvLabels({ now: baseNow });
    expect(pruneRes.deleted).toBe(1);
    expect(await kvGet(oldKey)).toBeNull();
    expect(await kvGet(freshKey)).not.toBeNull();
    await kvDelete(freshKey);
  });
});
