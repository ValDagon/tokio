import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  callsOf,
  db,
  resetApi,
  resetDb,
  sqliteDDL,
} from './mocks/sdk';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { resetOverlayOverride, setOverlayOverride, type OverlayOverride } from '../src/lib/overlay';
import { kvSetIfAbsent } from '../src/lib/dal/misc';
import { ensureUser } from '../src/lib/dal/users';
import { dateKey, addDays, monthKey } from '../src/lib/utils';
import {
  createAccount,
  createLiability,
  getAccount,
  getLiability,
  listTransactions,
} from '../src/lib/dal/finances';
import { listNotes } from '../src/lib/dal/notes';
import handleUpdate, {
  type CallbackQuery,
  type Message,
} from '../src/handlers/message';
import * as sttModule from '../src/lib/stt';
import * as visionModule from '../src/lib/vision';

const USER = 100001;
const CHAT = 100001;

function msg(text?: string, extra: Partial<Message> = {}): Message {
  return {
    message_id: 100,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Алекс' },
    date: Math.floor(Date.now() / 1000),
    text,
    ...extra,
  };
}

function cb(data: string, messageText = 'Message'): CallbackQuery {
  return {
    id: 'cb-test-1',
    from: { id: USER, first_name: 'Алекс' },
    data,
    message: {
      message_id: 100,
      chat: { id: CHAT },
      text: messageText,
    },
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((c) => String(c.params.text ?? ''));

const lastMarkup = () => {
  const calls = callsOf('sendMessage');
  return calls[calls.length - 1]?.params.reply_markup as {
    inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
  } | undefined;
};

describe('Autonomous Liability Payment Seams (TDD)', () => {
  let mainBankAccId: number;
  let интернетLiabId: number;

  /**
   * Глушит ленивый крон утренней сводки (`deliverMorningDigest` в
   * `handleUpdate`). Сводка созревает в окне `[summary_time, summary_time + 4ч]`
   * (по умолчанию 07:00–11:00) по таймзоне пользователя, поэтому без метки
   * утренний прогон добавляет лишний `sendMessage` — последним сообщением и
   * последней клавиатурой становится сводка, а не ответ по обязательству.
   * Метка — та же, что прод ставит после отправки
   * (`morning_digest:<user_id>:<YYYY-MM-DD>`), и читается до сборки сводки.
   */
  async function markMorningDigestSent(timeZone: string): Promise<void> {
    const day = dateKey(new Date(), timeZone);
    await kvSetIfAbsent(
      `morning_digest:${USER}:${day}`,
      JSON.stringify({ sentAt: new Date().toISOString(), digestDate: day }),
    );
  }

  beforeEach(async () => {
    resetApi();
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetConfigCache();
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
    setOverlayOverride({
      manifest: {
        finance: {
          accountAliases: [{ account: 'AlphaBank', patterns: ['alpha', 'альфа'] }],
        },
      },
    } as unknown as OverlayOverride);
    const user = await ensureUser(USER, 'Алекс');
    await markMorningDigestSent(user.timezone ?? 'Europe/Berlin');

    // Счёт AlphaBank с балансом 100 EUR (10000 cents)
    const acc = await createAccount(USER, {
      name: 'AlphaBank',
      currency: 'EUR',
      initialBalanceCents: 10000,
    });
    mainBankAccId = acc.id;

    // Обязательство интернет: ежемесячный платёж 25 EUR (2500 cents)
    const liab = await createLiability(USER, {
      name: 'интернет',
      queue: 'queue_1',
      amountCents: 2500,
      monthlyPaymentCents: 2500,
      currency: 'EUR',
      paymentDay: 15,
      accountId: mainBankAccId,
    });
    интернетLiabId = liab.id;

    // Предупреждение о списании (`deliverLiabilityWarnings`, окно 3 дня до
    // `payment_day`) — тот же ленивый крон в `handleUpdate` и такая же помеха:
    // его текст и кнопка `nav:debts` перебивают ответ по обязательству.
    // Ставим ту же метку идемпотентности, что прод
    // (`liability_warn:<user_id>:<id>:<YYYY-MM>`), на текущий и следующий месяц:
    // `nextPayment` берёт только их.
    const now = new Date();
    const userTimeZone = user.timezone ?? 'Europe/Berlin';
    for (const month of [
      monthKey(now, userTimeZone),
      monthKey(addDays(now, 31), userTimeZone),
    ]) {
      await kvSetIfAbsent(
        `liability_warn:${USER}:${интернетLiabId}:${month}`,
        JSON.stringify({ warnedAt: now.toISOString(), dueAt: month }),
      );
    }
  });

  afterEach(() => {
    resetOverlayOverride();
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it('«Я оплатил интернет с Alpha» без суммы: списывает с Alpha, отмечает интернет и даёт кнопку отмены', async () => {
    await handleUpdate(msg('Я оплатил интернет с Alpha'));

    const texts = sentTexts();
    expect(texts.length).toBeGreaterThan(0);
    const reply = texts[texts.length - 1];

    // Ответ должен содержать подтверждение с целью, суммой и счётом
    expect(reply).toMatch(/✅.*интернет.*оплачен.*25,00\s*EUR.*Alpha/i);

    // Должна быть кнопка [🗑️ Отменить]
    const markup = lastMarkup();
    expect(markup?.inline_keyboard).toBeDefined();
    const undoBtn = markup?.inline_keyboard?.[0]?.[0];
    expect(undoBtn?.text).toBe('🗑️ Отменить');

    // Обязательство в БД должно получить текущий месяц в paid_months
    const updatedLiab = await getLiability(USER, интернетLiabId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(updatedLiab?.paidMonths).toContain(currentMonth);

    // Баланс счёта AlphaBank уменьшился на 25 EUR (10000 - 2500 = 7500)
    const updatedAcc = await getAccount(USER, mainBankAccId);
    expect(updatedAcc?.currentBalanceCents).toBe(7500);

    // Создана расходная транзакция
    const txs = await listTransactions(USER);
    expect(txs.length).toBe(1);
    expect(txs[0].amountCents).toBe(2500);
  });

  it('«погасил интернет» без суммы и без счёта: отмечает оплату интернет', async () => {
    await handleUpdate(msg('погасил интернет'));

    const texts = sentTexts();
    expect(texts.length).toBeGreaterThan(0);
    const reply = texts[texts.length - 1];

    expect(reply).toMatch(/✅.*интернет.*оплачен.*25,00\s*EUR/i);

    const markup = lastMarkup();
    expect(markup?.inline_keyboard?.[0]?.[0]?.text).toBe('🗑️ Отменить');

    const updatedLiab = await getLiability(USER, интернетLiabId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(updatedLiab?.paidMonths).toContain(currentMonth);
  });

  it('«оплатил интернет 50 eur с Alpha» с явной суммой: использует указанную сумму', async () => {
    await handleUpdate(msg('оплатил интернет 50 eur с Alpha'));

    const texts = sentTexts();
    const reply = texts[texts.length - 1];

    expect(reply).toMatch(/✅.*интернет.*оплачен.*50,00\s*EUR.*Alpha/i);

    const updatedAcc = await getAccount(USER, mainBankAccId);
    expect(updatedAcc?.currentBalanceCents).toBe(5000); // 10000 - 5000 = 5000

    const updatedLiab = await getLiability(USER, интернетLiabId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(updatedLiab?.paidMonths).toContain(currentMonth);
  });

  it('неизвестное обязательство «оплатил неизвестный_сервис с Alpha»: падает в инбокс без списаний', async () => {
    await handleUpdate(msg('оплатил неизвестный_сервис с Alpha'));

    const texts = sentTexts();
    const reply = texts[texts.length - 1];

    // Ответ должен быть про сохранение в инбокс, а не про оплату обязательства
    expect(reply).not.toMatch(/✅.*неизвестный_сервис.*оплачен/i);
    expect(reply).toMatch(/инбокс/i);

    // Никакие обязательства не затронуты
    const liab = await getLiability(USER, интернетLiabId);
    expect(liab?.paidMonths).toHaveLength(0);

    // Баланс счёта не тронут
    const acc = await getAccount(USER, mainBankAccId);
    expect(acc?.currentBalanceCents).toBe(10000);

    // Заметка сохранена в инбоксе
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].rawText).toContain('неизвестный_сервис');
  });

  it('голос с транскриптом «Я оплатил интернет с Alpha»: ведёт себя идентично тексту', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({
      text: 'Я оплатил интернет с Alpha',
      model: 'gemini-2.5-flash',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    } as any);

    await handleUpdate(msg(undefined, {
      voice: { file_id: 'voice_123', duration: 2 },
    }));

    const texts = sentTexts();
    const reply = texts[texts.length - 1];

    expect(reply).toMatch(/✅.*интернет.*оплачен.*25,00\s*EUR.*Alpha/i);

    const updatedLiab = await getLiability(USER, интернетLiabId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(updatedLiab?.paidMonths).toContain(currentMonth);

    const updatedAcc = await getAccount(USER, mainBankAccId);
    expect(updatedAcc?.currentBalanceCents).toBe(7500);
  });

  it('фото с подписью «Я оплатил интернет с Alpha»: ведёт себя идентично тексту', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    // Если vision вызывается при фоллбэке — мокаем его
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue({
      type: 'note',
      summary: 'Скриншот экрана',
      textContent: 'Я оплатил интернет с Alpha',
      receipt: null,
      invoice: null,
      balance: [],
      tasks: [],
      isFallback: false,
      errors: [],
      model: 'gemini-2.5-flash',
      usage: null,
    });

    await handleUpdate(msg(undefined, {
      photo: [{ file_id: 'photo_123', width: 800, height: 600 }],
      caption: 'Я оплатил интернет с Alpha',
    }));

    const texts = sentTexts();
    const reply = texts[texts.length - 1];

    expect(reply).toMatch(/✅.*интернет.*оплачен.*25,00\s*EUR.*Alpha/i);

    const updatedLiab = await getLiability(USER, интернетLiabId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(updatedLiab?.paidMonths).toContain(currentMonth);

    const updatedAcc = await getAccount(USER, mainBankAccId);
    expect(updatedAcc?.currentBalanceCents).toBe(7500);
  });

  it('откат через кнопку «🗑️ Отменить»: восстанавливает баланс и удаляет месяц из paid_months', async () => {
    // 1. Оплачиваем
    await handleUpdate(msg('Я оплатил интернет с Alpha'));

    const markup = lastMarkup();
    const cbData = markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(cbData).toBeDefined();

    // 2. Нажимаем кнопку отмены
    await handleUpdate(cb(cbData!, '✅ интернет оплачен: 25.00 EUR с Alpha'));

    // Обязательство вернулось в исходное состояние (paid_months пуст)
    const revertedLiab = await getLiability(USER, интернетLiabId);
    expect(revertedLiab?.paidMonths).toHaveLength(0);

    // Баланс счёта восстановился (10000 cents)
    const revertedAcc = await getAccount(USER, mainBankAccId);
    expect(revertedAcc?.currentBalanceCents).toBe(10000);

    // Транзакция удалена
    const txs = await listTransactions(USER);
    expect(txs).toHaveLength(0);
  });
});
