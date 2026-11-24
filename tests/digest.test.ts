/**
 * `src/lib/digest.ts` — утренний дайджест.
 *
 * Тесты держат то, что легко сломать при переносе: состав и порядок блоков,
 * фокус дня с фолбэком на «без срока», сортировку препаратов по времени,
 * финансы из `runway.ts` (включая отрицательный разрыв), свежесть идеи и
 * телеметрию месяца.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import {
  buildLiabilityReviewCallbackData,
  buildLiabilityReviewKeyboard,
  buildLiabilityReviewMessage,
  buildMorningDigest,
  liabilityReviewDueDate,
  morningDigest,
  parseLiabilityReviewCallback,
  shorten,
  updateLiabilityReviewCard,
  type LiabilityReviewItem,
} from '../src/lib/digest';
import { createAccount, createLiability, createTransaction } from '../src/lib/dal/finances';
import { createMedication } from '../src/lib/dal/medications';
import { createNote } from '../src/lib/dal/notes';
import { createTask } from '../src/lib/dal/tasks';
import { recordUsage } from '../src/lib/dal/misc';
import { ensureUser } from '../src/lib/dal/users';
import { markdownToTelegramHtml } from '../src/lib/markdown';
import { saveUserPrefs } from '../src/lib/prefs';
import type { LiabilityQueue } from '../src/types';

const USER = 1;
const NOW = new Date('2026-11-06T06:00:00.000Z');

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

async function insertTaskCategory(userId: number, name: string, position: number): Promise<number> {
  const result = await db.run(sql`
    INSERT INTO task_categories (user_id, name, position, created_at)
    VALUES (${userId}, ${name}, ${position}, ${'2026-11-01T00:00:00.000Z'})
  `);
  return Number(result.lastInsertRowid);
}

describe('buildMorningDigest: пустой пользователь', () => {
  it('печатает заголовок, пустой фокус, финансы и инбокс без лишних блоков', async () => {
    await ensureUser(USER);

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('☀️ **Доброе утро! Сводка на пятницу, 6 ноября 2026**');
    expect(text).toContain('🎯 **Фокус дня (максимум 2 сферы):**');
    expect(text).toContain('• Все приоритетные задачи закрыты! Свободный день или восстановление ресурса.');
    expect(text).toContain('💰 **Финансы:**');
    expect(text).toContain('• 📊 **Расходы с 1-го числа:** ~0,00 €');
    expect(text).toContain('📥 **Инбокс и идеи:**');
    expect(text).toContain('• 📦 Инбокс чист и разобран ✅');
    expect(text).toContain(
      '🌱 _Сегодня держим моно-фокус на 2 сферах без распыления. ' +
        'Если ресурса мало — начни с ультра-микрошага на 5 минут._ 🌱',
    );

    // Нет препаратов и нет расхода — нет и блоков.
    expect(text).not.toContain('💊');
    expect(text).not.toContain('Телеметрия месяца');
  });
});

describe('buildMorningDigest: фокус дня', () => {
  it('ставит задачу со сроком сегодня с меткой категории и считает просрочку', async () => {
    await ensureUser(USER);
    const workId = await insertTaskCategory(USER, 'Работа', 0);
    await createTask(USER, {
      title: 'Созвон',
      categoryId: workId,
      dueAt: '2026-11-06T09:00:00.000Z',
    });
    await createTask(USER, { title: 'Отчёт', dueAt: '2026-11-05T09:00:00.000Z' });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('• Созвон [Работа]');
    expect(text).toContain(
      '_⚠️ Отложенных дел в бэклоге: ||1 шт.|| (разберём, когда будет ресурс)_',
    );
    // Интеграция с рендерером: внешние `_` не протекают вокруг `<tg-spoiler>`.
    const html = markdownToTelegramHtml(text);
    expect(html).toContain(
      '<i>⚠️ Отложенных дел в бэклоге: <tg-spoiler>1 шт.</tg-spoiler> (разберём, когда будет ресурс)</i>',
    );
    expect(html).not.toContain('_⚠️');
    // Просроченная задача в фокус не попадает.
    expect(text).not.toContain('• Отчёт');
  });

  it('без задач на сегодня берёт задачу без срока', async () => {
    await ensureUser(USER);
    await createTask(USER, { title: 'Разобрать полку' });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('• Разобрать полку');
    expect(text).not.toContain('Все приоритетные задачи закрыты');
  });

  it('не подмешивает тактический план дня и печатает фокус один раз', async () => {
    await ensureUser(USER);
    await createTask(USER, { title: 'Проверить фокус', dueAt: '2026-11-06T09:00:00.000Z' });
    await createTask(USER, {
      title: 'Встреча с врачом',
      itemType: 'event',
      dueAt: '2026-11-06T12:00:00.000Z',
    });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text.match(/🎯/g) ?? []).toHaveLength(1);
    expect(text.match(/Фокус дня/g) ?? []).toHaveLength(1);
    expect(text).not.toContain('Тактический');
    expect(text.match(/Проверить фокус/g) ?? []).toHaveLength(1);
  });
});

describe('buildMorningDigest: препараты', () => {
  it('сортирует по времени приёма, а не по алфавиту', async () => {
    await ensureUser(USER);
    await createMedication(USER, { name: 'Магний', dosage: '400 мг', times: ['20:00'] });
    await createMedication(USER, { name: 'Омега', dosage: '1000 мг', times: ['09:00'] });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('💊 **Препараты и витамины сегодня:**');
    expect(text).toContain('• **Омега** (1000 мг) в 09:00');
    expect(text).toContain('• **Магний** (400 мг) в 20:00');
    expect(text.indexOf('• **Омега**')).toBeLessThan(text.indexOf('• **Магний**'));
  });
});

describe('buildMorningDigest: финансы', () => {
  it('делит деньги на «можно тратить» и зарезервированное под платёж', async () => {
    await ensureUser(USER);
    const wallet = await createAccount(USER, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 10,
      accountId: wallet.id,
    });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('• 🪙 **Можно тратить:** ~24 €/день (свободно 600 € на 25 дн.)');
    expect(text).toContain(
      '• 🔒 **Уже распределено** (кредиты, аренда, подписки): 400 € — это не бюджет',
    );
    expect(text).toContain('• 💳 **Ближайший платёж:** Rent — 400 EUR (10-е число)');
  });

  it('предупреждает, когда денег под платежи горизонта не хватает', async () => {
    await ensureUser(USER);
    const wallet = await createAccount(USER, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 10_000,
    });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 10,
      accountId: wallet.id,
    });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('• 🧭 Под платежи ближайших 25 дн. не хватает ~300 € — обсудим в диалоге');
  });

  it('суммирует расходы с 1-го числа', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Wallet', currency: 'EUR', initialBalanceCents: 100_000 });
    await createTransaction(USER, {
      kind: 'expense',
      amountCents: 12_345,
      accountName: 'Wallet',
      occurredAt: '2026-11-06T05:00:00.000Z',
    });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('• 📊 **Расходы с 1-го числа:** ~123,45 €');
  });
});

describe('buildMorningDigest: инбокс и идеи', () => {
  it('считает необработанные заметки и показывает свежую идею', async () => {
    await ensureUser(USER);
    await createNote(USER, 'чек', { column: 'raw' });
    await createNote(USER, 'Купить лампу', { column: 'idea' });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain(
      '• 📦 В инбоксе: **1** необработанных заметок / чеков (разберём здесь)',
    );
    expect(text).toContain('• 💡 *Идея в копилке:* Купить лампу');
  });

  it('не показывает идеи старше окна 48 часов', async () => {
    await ensureUser(USER);
    const old = await createNote(USER, 'Старая идея', { column: 'idea' });
    await db.run(sql`
      UPDATE notes SET created_at = ${'2026-10-01T10:00:00.000Z'} WHERE id = ${old.id}
    `);

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).not.toContain('Идея в копилке');
  });
});

describe('buildMorningDigest: телеметрия', () => {
  it('печатает расход месяца в раскрывающемся блоке', async () => {
    await ensureUser(USER);
    await recordUsage(USER, {
      model: 'glm',
      promptTokens: 1000,
      completionTokens: 500,
      costMicros: 123_456,
    });

    const text = await buildMorningDigest(USER, { now: NOW });

    expect(text).toContain('<blockquote expandable>');
    expect(text).toContain('📊 <b>Телеметрия месяца</b>');
    expect(text).toContain('Вызовов: 1 · токены: 1000 in / 500 out · расход: $0,12');
    expect(text).toContain('</blockquote>');
  });
});

describe('проверка списаний: дата платежа', () => {
  it('возвращает наступившую дату текущего локального месяца', async () => {
    await ensureUser(USER);
    const liability = await createLiability(USER, {
      name: 'Кредит',
      monthlyPaymentCents: 35_000,
      paymentDay: 5,
    });

    expect(liabilityReviewDueDate(liability, NOW, 'UTC')).toBe('2026-11-05');
  });

  it('будущий платёж, отсутствующий день и чужой месяц → null', async () => {
    await ensureUser(USER);
    const future = await createLiability(USER, { name: 'Позже', paymentDay: 20 });
    const noDay = await createLiability(USER, { name: 'Без дня', paymentDay: null });

    expect(liabilityReviewDueDate(future, NOW, 'UTC')).toBeNull();
    expect(liabilityReviewDueDate(noDay, NOW, 'UTC')).toBeNull();
    expect(liabilityReviewDueDate(future, new Date('2026-11-25T12:00:00.000Z'), 'UTC')).toBe(
      '2026-11-20',
    );
  });

  it('зажимает 31-е по длине месяца', async () => {
    await ensureUser(USER);
    const liability = await createLiability(USER, { name: 'Подписка', paymentDay: 31 });

    expect(liabilityReviewDueDate(liability, new Date('2026-02-28T12:00:00.000Z'), 'UTC')).toBe(
      '2026-02-28',
    );
    expect(liabilityReviewDueDate(liability, new Date('2026-02-27T12:00:00.000Z'), 'UTC')).toBeNull();
  });

  it('считает месяц по таймзоне пользователя, а не по UTC', async () => {
    await ensureUser(USER);
    const liability = await createLiability(USER, { name: 'На границе', paymentDay: 1 });

    // 31.10 23:30 UTC = 01.11 00:30 в Берлине: ноябрь уже наступил.
    const boundary = new Date('2026-10-31T23:30:00.000Z');

    expect(liabilityReviewDueDate(liability, boundary, 'Europe/Berlin')).toBe('2026-11-01');
    expect(liabilityReviewDueDate(liability, boundary, 'UTC')).toBe('2026-10-01');
  });
});

describe('проверка списаний: сообщение и кнопки', () => {
  it('нумерует пункты и ставит три кнопки на каждый', async () => {
    await ensureUser(USER);
    const loan = await createLiability(USER, {
      name: 'Кредит',
      monthlyPaymentCents: 35_000,
      paymentDay: 5,
    });
    const rent = await createLiability(USER, {
      name: 'Аренда',
      monthlyPaymentCents: 45_000,
      paymentDay: 3,
    });
    const items: LiabilityReviewItem[] = [
      { liability: loan, month: '2026-11', dueKey: '2026-11-05' },
      { liability: rent, month: '2026-11', dueKey: '2026-11-03' },
    ];

    const text = buildLiabilityReviewMessage(items);
    const keyboard = buildLiabilityReviewKeyboard(items);

    expect(text).toContain('Проверка списаний');
    expect(text).toContain('1. <b>Кредит</b> — €350,00 · 05.11.2026');
    expect(text).toContain('2. <b>Аренда</b> — €450,00 · 03.11.2026');
    expect(keyboard.inline_keyboard).toHaveLength(2);
    expect(keyboard.inline_keyboard[0].map((button) => button.callback_data)).toEqual([
      `lrev:${loan.id}:2026-11:p`,
      `lrev:${loan.id}:2026-11:n`,
      `lrev:${loan.id}:2026-11:d`,
    ]);
    expect(keyboard.inline_keyboard[1].every((button) => button.callback_data.includes(`lrev:${rent.id}:`))).toBe(true);
  });

  it('экранирует HTML в названии обязательства', async () => {
    await ensureUser(USER);
    const liability = await createLiability(USER, { name: 'Кредит <b>ипотека</b>', paymentDay: 5 });

    const text = buildLiabilityReviewMessage([
      { liability, month: '2026-11', dueKey: '2026-11-05' },
    ]);

    expect(text).toContain('&lt;b&gt;ипотека&lt;/b&gt;');
    expect(text).not.toContain('<b>ипотека</b>');
  });
});

describe('проверка списаний: разбор callback', () => {
  it('разбирает корректный callback', () => {
    expect(parseLiabilityReviewCallback('lrev:42:2026-11:p')).toEqual({
      liabilityId: 42,
      month: '2026-11',
      action: 'p',
    });
    expect(parseLiabilityReviewCallback('lrev:7:2026-01:d')?.action).toBe('d');
  });

  it('битые строки → null и не угадывает', () => {
    for (const data of [
      '',
      'lrev',
      'lrev:42:2026-11',
      'lrev:0:2026-11:p',
      'lrev:-3:2026-11:p',
      'lrev:x:2026-11:p',
      'lrev:42:2026-13:p',
      'lrev:42:202611:p',
      'lrev:42:2026-11:x',
      'lrev:42:2026-11:p:extra',
      'other:42:2026-11:p',
    ]) {
      expect(parseLiabilityReviewCallback(data), data).toBeNull();
    }
  });

  it('build и parse — обратная пара', () => {
    const data = buildLiabilityReviewCallbackData(42, '2026-11', 'n');
    expect(data).toBe('lrev:42:2026-11:n');
    expect(parseLiabilityReviewCallback(data)).toEqual({
      liabilityId: 42,
      month: '2026-11',
      action: 'n',
    });
  });
});

describe('проверка списаний: живое обновление карточки', () => {
  const DIVIDER = '━━━━━━━━━━━━━━';
  // Текст карточки в том виде, в каком его возвращает Telegram: без тегов.
  const CARD_TEXT = [
    '🔍 Проверка списаний',
    '',
    'Что уже прошло в этом месяце?',
    '1. Кредит — 350,00 € · 1 числа',
    '2. Аренда — 900,00 € · 5 числа',
    '3. Интернет — 25,00 € · 10 числа',
    '',
    '✅ оплатил · ❌ не оплатил · 🗑 удалить',
    'Первый ответ за месяц фиксируется; повторы ничего не меняют.',
  ].join('\n');
  const IDS = { 1: 11, 2: 22, 3: 33 } as const;
  const row = (n: 1 | 2 | 3) => [
    { text: `✅ ${n}`, callback_data: `lrev:${IDS[n]}:2026-11:p` },
    { text: `❌ ${n}`, callback_data: `lrev:${IDS[n]}:2026-11:n` },
    { text: `🗑 ${n}`, callback_data: `lrev:${IDS[n]}:2026-11:d` },
  ];
  const FULL_KEYBOARD = { inline_keyboard: [row(1), row(2), row(3)] };
  const rowsOf = (card: { replyMarkup: { inline_keyboard: Array<Array<{ text: string }>> } }) =>
    card.replyMarkup.inline_keyboard.map((r) => r[0]?.text);

  it('первый пункт: строка кнопок уходит, итог под разделителем, легенда остаётся', () => {
    const card = updateLiabilityReviewCard({
      originalText: CARD_TEXT,
      replyMarkup: FULL_KEYBOARD,
      liabilityId: 11,
      decision: 'paid',
    });

    expect(rowsOf(card)).toEqual(['✅ 2', '✅ 3']);
    expect(card.text).toBe(`${CARD_TEXT}\n\n${DIVIDER}\n✅ 1. Кредит — оплачено`);
  });

  it('три пункта по очереди: итоги копятся по номерам, легенда уходит в конце', () => {
    let text = CARD_TEXT;
    let markup = FULL_KEYBOARD as Parameters<typeof updateLiabilityReviewCard>[0]['replyMarkup'];

    const step = (liabilityId: number, decision: 'paid' | 'unpaid' | 'deleted') => {
      const next = updateLiabilityReviewCard({ originalText: text, replyMarkup: markup, liabilityId, decision });
      text = next.text;
      markup = next.replyMarkup;
      return next;
    };

    // Порядок решений не совпадает с нумерацией.
    const afterSecond = step(22, 'unpaid');
    expect(rowsOf(afterSecond)).toEqual(['✅ 1', '✅ 3']);
    expect(afterSecond.text.endsWith(`${DIVIDER}\n❌ 2. Аренда — не оплачено`)).toBe(true);

    const afterThird = step(33, 'deleted');
    expect(afterThird.text.endsWith(`${DIVIDER}\n❌ 2. Аренда — не оплачено\n🗑️ 3. Интернет — удалено`)).toBe(true);

    const last = step(11, 'paid');
    expect(last.replyMarkup).toEqual({ inline_keyboard: [] });
    expect(last.text.endsWith(
      `${DIVIDER}\n✅ 1. Кредит — оплачено\n❌ 2. Аренда — не оплачено\n🗑️ 3. Интернет — удалено`,
    )).toBe(true);
    expect(last.text).not.toContain('оплатил · ❌ не оплатил');
    expect(last.text).not.toContain('Первый ответ за месяц');
    expect(last.text).toContain('3. Интернет — 25,00 € · 10 числа');
  });

  it('повтор по тому же пункту идемпотентен', () => {
    const first = updateLiabilityReviewCard({
      originalText: CARD_TEXT,
      replyMarkup: FULL_KEYBOARD,
      liabilityId: 11,
      decision: 'paid',
    });
    const again = updateLiabilityReviewCard({
      originalText: first.text,
      replyMarkup: first.replyMarkup,
      liabilityId: 11,
      decision: 'paid',
      liabilityName: 'Кредит',
    });

    expect(again).toEqual(first);
  });

  it('повтор с другим решением заменяет строку пункта, а не дублирует', () => {
    const first = updateLiabilityReviewCard({
      originalText: CARD_TEXT,
      replyMarkup: FULL_KEYBOARD,
      liabilityId: 11,
      decision: 'paid',
    });
    const other = updateLiabilityReviewCard({
      originalText: first.text,
      replyMarkup: first.replyMarkup,
      liabilityId: 11,
      decision: 'unpaid',
      liabilityName: 'Кредит',
    });

    expect(other.text.match(/Кредит — /g)).toHaveLength(2); // тело + одна строка итога
    expect(other.text.endsWith('❌ 1. Кредит — не оплачено')).toBe(true);
    expect(other.text).not.toContain('✅ 1. Кредит');
  });

  it('карточка без клавиатуры: пункт определяется по имени, легенда остаётся, пока есть нерешённые', () => {
    const card = updateLiabilityReviewCard({
      originalText: CARD_TEXT,
      liabilityId: 22,
      decision: 'deleted',
      liabilityName: 'Аренда',
    });

    expect(card.replyMarkup).toEqual({ inline_keyboard: [] });
    expect(card.text.endsWith(`${DIVIDER}\n🗑️ 2. Аренда — удалено`)).toBe(true);
    expect(card.text).toContain('оплатил · ❌ не оплатил');
  });

  it('единственный пункт без номера в кнопках: берёт его из тела', () => {
    const single = [
      '🔍 Проверка списаний',
      '',
      'Что уже прошло в этом месяце?',
      '1. Кредит — 350,00 € · 1 числа',
      '',
      '✅ оплатил · ❌ не оплатил · 🗑 удалить',
      'Первый ответ за месяц фиксируется; повторы ничего не меняют.',
    ].join('\n');
    const card = updateLiabilityReviewCard({
      originalText: single,
      replyMarkup: { inline_keyboard: [[{ text: 'Оплатил', callback_data: 'lrev:11:2026-11:p' }]] },
      liabilityId: 11,
      decision: 'paid',
    });

    expect(card.text).toBe(
      `🔍 Проверка списаний\n\nЧто уже прошло в этом месяце?\n1. Кредит — 350,00 € · 1 числа\n\n${DIVIDER}\n✅ 1. Кредит — оплачено`,
    );
    expect(card.replyMarkup.inline_keyboard).toEqual([]);
  });

  it('чужие кнопки без callback_data сохраняются только с callback_data', () => {
    const card = updateLiabilityReviewCard({
      originalText: CARD_TEXT,
      replyMarkup: {
        inline_keyboard: [row(1), [{ text: 'Открыть', url: 'https://example.com' }], row(2)],
      },
      liabilityId: 11,
      decision: 'paid',
    });

    expect(card.replyMarkup.inline_keyboard).toEqual([row(2)]);
  });

  it('без имени и номера — общая строка', () => {
    const card = updateLiabilityReviewCard({
      originalText: 'Что-то',
      liabilityId: 99,
      decision: 'unpaid',
    });

    expect(card.text).toBe(`Что-то\n\n${DIVIDER}\n❌ Отмечено: не оплачено`);
  });
});

describe('shorten / morningDigest', () => {
  it('короткий текст не трогает', () => {
    expect(shorten('Короткая идея')).toBe('Короткая идея');
  });

  it('обрезает длинный текст и ставит многоточие', () => {
    const shortened = shorten('a'.repeat(200));

    expect(shortened.endsWith('…')).toBe(true);
    expect(shortened.slice(0, -1).length).toBe(105);
  });

  it('планировщик получает тот же дайджест', async () => {
    await ensureUser(USER);

    expect(await morningDigest(USER, { now: NOW })).toBe(
      await buildMorningDigest(USER, { now: NOW }),
    );
  });

  it('Волна 2: фильтрует секции дайджеста и применяет adhd.focusLimit', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Main', currency: 'EUR', initialBalanceCents: 100_000 });
    await createMedication(USER, { name: 'D3', dosage: '2000 IU', times: ['08:00'] });
    for (let i = 1; i <= 4; i += 1) {
      await createTask(USER, { title: `Фокус-${i}`, dueAt: NOW.toISOString() });
    }

    await saveUserPrefs(USER, {
      adhd: { focusLimit: 4 },
      proactive: {
        jobs: {
          morning_digest: { sections: ['focus', 'medications'] },
        },
      },
    });

    const filtered = await buildMorningDigest(USER, { now: NOW });
    expect(filtered).toContain('Фокус-4');
    expect(filtered).toContain('Препараты');
    expect(filtered).not.toContain('Финансы');
    expect(filtered).not.toContain('Инбокс');
    expect(filtered).not.toContain('микрошага');
  });
});
