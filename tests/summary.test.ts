/**
 * `src/lib/summary.ts` — тексты разделов `/summary`, `/balance`, `/debts`,
 * `/tasks`, `/meds` и справка.
 *
 * Тесты фиксируют то, что легко сломать незаметно: округление на выводе,
 * отсечение «нулевых» счетов в быструю сводку, порядок очередей долгов и
 * экранирование пользовательских строк в HTML-блоке.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import {
  DIAGNOSTICS_EMPTY_TEXT,
  balanceSummary,
  debtsSummary,
  diagnosticsReply,
  formatWhole,
  getTopFocusTasks,
  helpText,
  medsSummary,
  quickSummary,
  tasksSummary,
} from '../src/lib/summary';
import { listItems, recordFailure } from '../src/lib/evolution';
import { kvSetJson, patchTurnTrace, startTurnTrace } from '../src/lib/dal/misc';
import { clockHeartbeatKey } from '../src/lib/jobs';
import { createAccount, createLiability, createTransaction } from '../src/lib/dal/finances';
import { createMedication } from '../src/lib/dal/medications';
import { createTask } from '../src/lib/dal/tasks';
import { ensureUser } from '../src/lib/dal/users';
import { setRates } from '../src/lib/dal/fx';
import type { LiabilityQueue } from '../src/types';

const USER = 1;
const NOW = new Date('2026-11-06T10:00:00.000Z');

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

/** Категории задач создаются только системные — «Работа» заводим руками. */
async function insertTaskCategory(userId: number, name: string, position: number): Promise<number> {
  const result = await db.run(sql`
    INSERT INTO task_categories (user_id, name, position, created_at)
    VALUES (${userId}, ${name}, ${position}, ${'2026-11-01T00:00:00.000Z'})
  `);
  return Number(result.lastInsertRowid);
}

describe('quickSummary', () => {
  it('собирает бюджет, счёт и пустые разделы', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Wallet', currency: 'EUR', initialBalanceCents: 100_000 });

    const text = await quickSummary(USER, { now: NOW });

    expect(text).toContain('📊 **Сводка Tokio на 06.11.2026**');
    expect(text).toContain('🪙 **Свободный бюджет:** ~40 €/день (доступно ~1 000 EUR)');
    expect(text).toContain('• **Wallet (EUR):** 1 000 EUR (~1 000€)');
    expect(text).toContain('• Все обязательства на этот месяц уже закрыты! 🎉');
    expect(text).toContain('• На сегодня жёстких дедлайнов нет — работаем спокойно по ресурсу 🌱');
    expect(text).toContain('_Быстрые разделы:_ /balance | /debts | /tasks | /meds');
  });

  it('показывает задачу дня с временем срока', async () => {
    await ensureUser(USER);
    await createTask(USER, { title: 'Позвонить в банк', dueAt: '2026-11-06T09:00:00.000Z' });

    const text = await quickSummary(USER, { now: NOW });

    expect(text).toContain('1. Позвонить в банк (Пт 06.11 в 09:00)');
  });

  it('счета «около нуля» показывает как есть, а не пустотой', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Coin', currency: 'EUR', initialBalanceCents: 20 });

    const text = await quickSummary(USER, { now: NOW });

    expect(text).toContain('🪙 **Свободный бюджет:** ~0 €/день');
    expect(text).toContain('• **Coin (EUR):** 0,00 EUR (~0 €)');
  });
});

describe('balanceSummary', () => {
  it('без счетов говорит об этом прямо', async () => {
    await ensureUser(USER);

    const text = await balanceSummary(USER, { now: NOW });

    expect(text).toContain('• Нет активных счетов');
    expect(text).toContain('(свободные наличные)');
  });

  it('разделяет свободный контур, резерв, мелочь и нулевые счета', async () => {
    await ensureUser(USER);
    const wallet = await createAccount(USER, {
      name: 'Wallet',
      currency: 'EUR',
      initialBalanceCents: 100_000,
    });
    await createAccount(USER, { name: 'Coin', currency: 'EUR', initialBalanceCents: 20 });
    await createAccount(USER, { name: 'Empty', currency: 'EUR', initialBalanceCents: 0 });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 10,
      accountId: wallet.id,
    });

    const text = await balanceSummary(USER, { now: NOW });

    expect(text).toContain('~600 EUR (сверх зарезервированных 400 EUR)');
    expect(text).toContain('**Целевой резерв (кредиты, аренда, сервисы):** ~400 EUR');
    expect(text).toContain('• **Wallet (EUR):** 1 000,00 EUR (~1 000,00 €)');
    expect(text).toContain('_Около нуля (< 0,50 €): Coin (0,20 EUR)_');
    expect(text).toContain('_Нулевые счета: Empty (EUR)_');
    expect(text).toContain('**Всего ликвидных средств:** ~1 000,20 EUR');
  });

  it('считает расходы и доходы только за текущий месяц', async () => {
    await ensureUser(USER);
    await createAccount(USER, { name: 'Wallet', currency: 'EUR', initialBalanceCents: 0 });
    await createTransaction(USER, {
      kind: 'income',
      amountCents: 50_000,
      accountName: 'Wallet',
      occurredAt: '2026-11-02T10:00:00.000Z',
    });
    await createTransaction(USER, {
      kind: 'expense',
      amountCents: 10_000,
      accountName: 'Wallet',
      occurredAt: '2026-11-03T10:00:00.000Z',
    });
    await createTransaction(USER, {
      kind: 'expense',
      amountCents: 3000,
      accountName: 'Wallet',
      occurredAt: '2026-10-01T10:00:00.000Z',
    });

    const text = await balanceSummary(USER, { now: NOW });

    expect(text).toContain('**Расходы (за ноябрь):** ~100,00 EUR');
    expect(text).toContain('**Доходы (за ноябрь):** +500,00 EUR');
  });
});

describe('debtsSummary', () => {
  it('без обязательств — короткая строка', async () => {
    await ensureUser(USER);

    expect(await debtsSummary(USER, { now: NOW })).toBe(
      '💳 У вас нет зафиксированных кредитов или обязательств.',
    );
  });

  it('сортирует по очередям и показывает график и оплаченное', async () => {
    await ensureUser(USER);
    // Создаём «задом наперёд»: порядок вывода не должен зависеть от id.
    await createLiability(USER, {
      name: 'Spotify',
      queue: 'queue_2' as LiabilityQueue,
      monthlyPaymentCents: 1000,
      paymentDay: 15,
    });
    await createLiability(USER, {
      name: 'Mortgage',
      queue: 'bank' as unknown as LiabilityQueue,
      amountCents: 100_000,
      monthlyPaymentCents: 40_000,
      paymentDay: 5,
      totalPayments: 25,
      endDate: '2028-11-01',
    });
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 1,
      paidMonths: ['2026-11'],
    });

    const text = await debtsSummary(USER, { now: NOW });

    expect(text).toContain('**К оплате в этом месяце:** ~410,00 EUR');
    expect(text).toContain('**Уже оплачено в этом месяце:** ~400,00 EUR');
    expect(text).toContain('**Общая сумма долгов:** ||~1 000,00 EUR||');
    expect(text).toContain('<blockquote expandable>');
    expect(text).toContain('</blockquote>');
    expect(text).toContain('[✅ Оплачен в этом месяце]');
    expect(text).toContain(
      '• Mortgage: 1 000 EUR (~1 000 €) — 25 плат. по 400 EUR/мес (5-го числа, до 11.2028)',
    );

    // bank → queue_1 → queue_2, несмотря на порядок создания.
    const bankAt = text.indexOf('🏦 <b>Банковские кредиты:</b>');
    const firstAt = text.indexOf('🔴 <b>1-я очередь:</b>');
    const secondAt = text.indexOf('🟡 <b>2-я очередь:</b>');
    expect(bankAt).toBeGreaterThan(-1);
    expect(firstAt).toBeGreaterThan(bankAt);
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it('когда всё оплачено — праздник вместо суммы к оплате', async () => {
    await ensureUser(USER);
    await createLiability(USER, {
      name: 'Rent',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 40_000,
      paymentDay: 1,
      paidMonths: ['2026-11'],
    });

    const text = await debtsSummary(USER, { now: NOW });

    expect(text).toContain('🎉 Все обязательные платежи на этот месяц закрыты!');
  });

  it('считает суммы к оплате и оплаченное в EUR по курсу, а не по номиналу', async () => {
    await ensureUser(USER);
    // Курсы в той же рамке, что и `fx_rates`: единиц валюты за 1 EUR.
    await setRates('2026-11-01', { RUB: 90, USD: 1.08 });

    // Оплачено: 300 EUR + 25 194 RUB (= 279,93 EUR по курсу 90).
    await createLiability(USER, {
      name: 'Аренда',
      queue: 'queue_1' as LiabilityQueue,
      monthlyPaymentCents: 30_000,
      paymentDay: 1,
      paidMonths: ['2026-11'],
    });
    await createLiability(USER, {
      name: 'Bank Loan',
      queue: 'bank' as unknown as LiabilityQueue,
      amountCents: 4_786_860,
      currency: 'RUB',
      monthlyPaymentCents: 2_519_400,
      paymentDay: 7,
      paidMonths: ['2026-11'],
    });

    // К оплате: 200 RUB (= 2,22 EUR) + 20 USD (= 18,52 EUR).
    await createLiability(USER, {
      name: 'CardOne',
      queue: 'queue_2' as LiabilityQueue,
      currency: 'RUB',
      monthlyPaymentCents: 20_000,
      paymentDay: 10,
    });
    await createLiability(USER, {
      name: 'OpenCode',
      queue: 'service' as LiabilityQueue,
      currency: 'USD',
      monthlyPaymentCents: 2_000,
      paymentDay: 25,
    });

    const text = await debtsSummary(USER, { now: NOW });

    // Складывать номиналы нельзя: получилось бы 22 000,00 и 25 394,00 «EUR».
    expect(text).toContain('**К оплате в этом месяце:** ~20,74 EUR');
    expect(text).toContain('**Уже оплачено в этом месяце:** ~579,93 EUR');
    // В самом списке платёж по-прежнему показан в своей валюте.
    expect(text).toContain('CardOne:** 200 RUB');
  });

  it('платёж без живого курса не попадает в сумму EUR, но назван отдельной строкой', async () => {
    await ensureUser(USER);
    await setRates('2026-11-01', { RUB: 90 });

    // KZT есть только на момент заведения строки: в `fx_rates` его нет.
    await createLiability(USER, {
      name: 'iCloud',
      queue: 'subscription' as LiabilityQueue,
      currency: 'KZT',
      monthlyPaymentCents: 149_000,
      paymentDay: 7,
      rates: { RUB: 90, KZT: 500 },
    });
    await createLiability(USER, {
      name: 'CardOne',
      queue: 'queue_2' as LiabilityQueue,
      currency: 'RUB',
      monthlyPaymentCents: 20_000,
      paymentDay: 10,
    });

    const text = await debtsSummary(USER, { now: NOW });

    expect(text).toContain('**К оплате в этом месяце:** ~2,22 EUR');
    expect(text).toContain('_Без курса в EUR (не входит в суммы): iCloud_');
  });
});

describe('tasksSummary', () => {
  it('без задач — свободный день', async () => {
    await ensureUser(USER);

    expect(await tasksSummary(USER, { now: NOW })).toBe(
      '🎯 Все задачи выполнены! Свободный день или время для отдыха 🌱',
    );
  });

  it('микро-фокус считает открытые шаги', async () => {
    await ensureUser(USER);
    const parent = await createTask(USER, {
      title: 'Созвон',
      dueAt: '2026-11-06T09:00:00.000Z',
    });
    await createTask(USER, { title: 'Подготовить вопросы', parentId: parent.id });

    const text = await tasksSummary(USER, { now: NOW });

    expect(text).toContain('🔥 **Микро-фокус дня:**');
    expect(text).toContain('1. Созвон (Пт 06.11 в 09:00) _(1 шагов)_');
  });

  it('группирует бэклог по категориям и выносит дальний горизонт', async () => {
    await ensureUser(USER);
    const workId = await insertTaskCategory(USER, 'Работа', 0);
    await createTask(USER, { title: 'Спринт', categoryId: workId });
    await createTask(USER, { title: 'Позвонить' });
    await createTask(USER, { title: '<b>Память</b>', dueAt: '2026-12-30T10:00:00.000Z' });

    const text = await tasksSummary(USER, { now: NOW });

    expect(text).toContain('📁 <b>Работа:</b>');
    expect(text).toContain('📁 <b>Общее:</b>');
    expect(text).toContain('• &lt;b&gt;Память&lt;/b&gt;');
    expect(text).toContain('🗓 <b>Дальний горизонт и памятные даты (1 шт.):</b>');
    expect(text).toContain('_Чтобы закрыть задачу, напиши или наговори «выполнил [название]»._');
  });
});

describe('medsSummary', () => {
  it('без препаратов — короткая строка', async () => {
    await ensureUser(USER);

    expect(await medsSummary(USER, { now: NOW })).toBe(
      '💊 В вашей аптечке пока нет активных препаратов.',
    );
  });

  it('печатает расписание с дозировкой и статусом', async () => {
    await ensureUser(USER);
    await createMedication(USER, { name: 'Магний', dosage: '400 мг', times: ['08:00'] });

    const text = await medsSummary(USER, { now: NOW });

    expect(text).toContain('💊 **Расписание лекарств на 06.11.2026**');
    expect(text).toContain('• ⏳ **Магний** (400 мг) — 08:00 (ожидает)');
  });
});

describe('getTopFocusTasks', () => {
  it('отдаёт задачи со сроком сегодня и их категорию', async () => {
    await ensureUser(USER);
    const workId = await insertTaskCategory(USER, 'Работа', 0);
    const task = await createTask(USER, {
      title: 'Созвон',
      categoryId: workId,
      dueAt: '2026-11-06T09:00:00.000Z',
    });
    await createTask(USER, { title: 'Завтра', dueAt: '2026-11-07T09:00:00.000Z' });

    const focus = await getTopFocusTasks(USER, 1, { now: NOW });

    expect(focus).toEqual([{ id: task.id, title: 'Созвон', category: 'Работа' }]);
  });
});

describe('helpText / formatWhole', () => {
  it('справка перечисляет быстрые разделы', () => {
    const text = helpText();

    expect(text).toContain('/summary');
    expect(text).toContain('/diary');
    expect(text).toContain('Tokio');
  });

  it('formatWhole округляет до целых единиц', () => {
    expect(formatWhole(40_000)).toBe('400');
    expect(formatWhole(1)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// MU-4 — диагностика
// ---------------------------------------------------------------------------

describe('diagnosticsReply', () => {
  it('пустой журнал честно говорит «сбоев не записано»', async () => {
    await ensureUser(USER);

    const text = await diagnosticsReply(USER);

    expect(text).toContain('Диагностика');
    expect(text).toContain('Сбоев не записано');
    expect(text).not.toContain('Кластеры');
  });

  it('показывает крошку хода даже при пустом журнале', async () => {
    await ensureUser(USER);
    await db.run(sql`
      UPDATE users SET timezone = 'UTC' WHERE id = ${USER}
    `);
    await startTurnTrace(USER);
    await patchTurnTrace(USER, {
      stage: 'send',
      modelStarted: true,
      model: 'gemini-3.8-flash',
      deadline: 'budget',
      stopReason: 'step_limit',
    });

    const text = await diagnosticsReply(USER);

    // Пустой журнал не маскирует крошку: видно, что ход был и на чём встал.
    expect(text).toContain('Сбоев не записано');
    expect(text).toContain('⏱ <b>Ходы:</b>');
    expect(text).toContain('с дедлайном 1');
    expect(text).toContain('дедлайн: бюджет');
    expect(text).toContain('модели gemini-3.8-flash');
    expect(text).toContain('индикатор не открывался');
  });

  it('показывает кластеры с количеством и временем, а не сырые тексты', async () => {
    await ensureUser(USER);
    await db.run(sql`
      UPDATE users SET timezone = 'UTC' WHERE id = ${USER}
    `);

    await recordFailure(USER, {
      stage: 'stt',
      media: 'voice',
      reason: 'transcription_failed',
      detail: 'provider timeout',
    });
    await recordFailure(USER, {
      stage: 'stt',
      media: 'voice',
      reason: 'transcription_failed',
      detail: 'provider timeout again',
    });
    await recordFailure(USER, { stage: 'ingest', media: 'photo', reason: 'download_failed' });

    const text = await diagnosticsReply(USER);

    expect(text).toContain('stt · voice · transcription_failed');
    expect(text).toContain('×2');
    expect(text).toContain('ingest · photo · download_failed');
    expect(text).toContain('Кластеры сбоев</b> (2)');
    // detail в диагностику не попадает: он в журнале, а не в ответе.
    expect(text).not.toContain('provider timeout');
  });

  it('объединяет старый ключ последнего отказа модели с журналом', async () => {
    await ensureUser(USER);
    await kvSetJson('llm_last_failure', {
      status: 429,
      at: '2026-11-14T12:41:00.000Z',
      detail: 'quota exceeded',
    });
    await recordFailure(USER, { stage: 'agent', reason: 'llm_error', detail: 'quota' });

    const text = await diagnosticsReply(USER);

    expect(text).toContain('Последний отказ модели: лимит запросов');
    expect(text).toContain('agent · llm_error');
    // Текст отказа провайдера теперь виден: раньше он терялся за числом статуса.
    expect(text).toContain('quota exceeded');
    expect(text).toContain('Текст отказа');
    expect(text.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('называет причину отказа словами провайдера, а не только числом', async () => {
    await ensureUser(USER);
    await kvSetJson('llm_last_failure', {
      status: 400,
      at: '2026-11-14T12:41:00.000Z',
      detail: 'gemini: model-a answered 400',
      providerBody: '{"error":{"message":"Function call is missing a name"}}',
    });

    const text = await diagnosticsReply(USER);

    expect(text).toContain('Последний отказ модели: ответ 400');
    expect(text).toContain('Function call is missing a name');
  });

  it('старая запись без тела отказа не дублирует статус', async () => {
    await ensureUser(USER);
    await kvSetJson('llm_last_failure', {
      status: 400,
      at: '2026-11-14T12:41:00.000Z',
      detail: 'gemini: model-a answered 400: Function call is missing a name',
    });

    const text = await diagnosticsReply(USER);

    expect(text).toContain('Function call is missing a name');
    expect(text).not.toContain('answered 400');
  });

  it('показывает номер задачи самодиагностики у кластера на пороге', async () => {
    await ensureUser(USER);
    for (let i = 0; i < 3; i += 1) {
      await recordFailure(USER, { stage: 'agent', media: 'voice', reason: 'step_limit' });
    }

    const [item] = await listItems(USER);
    const text = await diagnosticsReply(USER);

    expect(item).toBeTruthy();
    expect(text).toContain(`задача #${item?.id}`);
    expect(text).toContain('agent · voice · step_limit');
  });

  it('не длиннее двадцати строк даже при полном журнале', async () => {
    await ensureUser(USER);
    for (let i = 0; i < 30; i += 1) {
      await recordFailure(USER, {
        stage: 'agent',
        reason: 'tool_error',
        tool: `tool_${i}`,
      });
    }
    await kvSetJson('llm_last_failure', { status: 503, at: '2026-11-14T12:41:00.000Z' });

    const text = await diagnosticsReply(USER);

    expect(text.split('\n').length).toBeLessThanOrEqual(20);
    expect(text).toContain('Кластеры сбоев</b> (10)');
  });

  // MU-14 — heartbeat: отличать «событий не было» от «будильник молчит».

  const CLOCK_NOW = new Date('2026-11-15T12:00:00.000Z');

  async function seedJournalLine(): Promise<void> {
    await ensureUser(USER);
    await recordFailure(USER, { stage: 'agent', reason: 'llm_error' });
  }

  async function writeClockHeartbeat(
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await kvSetJson(clockHeartbeatKey(USER), {
      lastTouchAt: null,
      lastExternalAttemptAt: '2026-11-15T11:50:00.000Z',
      lastExternalSuccessAt: '2026-11-15T11:50:00.000Z',
      source: 'external',
      delivered: 0,
      failed: 0,
      kinds: {
        task_reminder: 'skipped',
        liability_warning: 'skipped',
        medication_reminder: 'skipped',
        morning_digest: 'skipped',
      },
      ...overrides,
    });
  }

  it('диагностика: будильник ещё не звонил', async () => {
    await seedJournalLine();

    const text = await diagnosticsReply(USER, { now: CLOCK_NOW });

    expect(text).toContain('тиков ещё не было');
  });

  it('диагностика: 44 минуты — работают, 45 и 46 — молчат', async () => {
    await seedJournalLine();

    for (const [minutes, warns] of [
      [44, false],
      [45, true],
      [46, true],
    ] as const) {
      const at = new Date(CLOCK_NOW.getTime() - minutes * 60_000).toISOString();
      await writeClockHeartbeat({ lastExternalAttemptAt: at, lastExternalSuccessAt: at });

      const text = await diagnosticsReply(USER, { now: CLOCK_NOW });

      expect(text.includes('Внешние часы молчат')).toBe(warns);
    }
  });

  it('диагностика: оборванная сводка называет /digest', async () => {
    await seedJournalLine();
    await writeClockHeartbeat({
      kinds: {
        task_reminder: 'skipped',
        liability_warning: 'skipped',
        medication_reminder: 'skipped',
        morning_digest: 'failed',
      },
    });

    const text = await diagnosticsReply(USER, { now: CLOCK_NOW });

    expect(text).toContain('оборвана');
    expect(text).toContain('/digest');
  });
});
