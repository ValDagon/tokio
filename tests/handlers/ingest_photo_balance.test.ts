/**
 * Скриншот остатка — состояние счёта, а не операция и не заметка.
 *
 * Контракт, который проверяется снаружи (база + чат):
 *  1. распознанный остаток обновляет существующий счёт через общий резолвер,
 *     без аудиторской заметки и без «балансовой» транзакции;
 *  2. мультивалютная карта обновляет все свои валюты, а сумма печатается с
 *     символом валюты ПОСЛЕ числа — как в банковском приложении;
 *  3. неоднозначный счёт не угадывается: одна заметка с причиной, состояние
 *     счетов не тронуто;
 *  4. незнакомый банк не заводит счёт-призрак;
 *  5. те же байты не применяются дважды;
 *  6. старый снимок не затирает новый остаток;
 *  7. один плохой ряд в мультивалютном скриншоте не оставляет половинчатой
 *     записи;
 *  8. операции, видные на экране, не проводятся отдельными транзакциями;
 *  9. нефинансовый скриншот по-прежнему уходит в инбокс;
 * 10. обычный чек по-прежнему создаёт ровно один расход.
 *
 * Vision подменён спаем на модуле, Bot API — мок платформы, BEGIN запрещён как
 * на tgcloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../../src/lib/agent/engine.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runAgent: runAgentMock };
});
vi.mock('../../src/lib/agent/engine', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runAgent: runAgentMock };
});

import { api, callsOf, db, resetApi, resetDb, setBeginBlocked, sql, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { resetOverlayOverride, setOverlayOverride, type OverlayOverride } from '../../src/lib/overlay';
import { CUSTOM_INSTRUCTIONS_SLUG } from '../../src/lib/agent/constants';
import { upsertChapter } from '../../src/lib/dal/docs';
import { ensureAccounts, listAccounts, listTransactions } from '../../src/lib/dal/finances';
import { kvGet, kvSetIfAbsent } from '../../src/lib/dal/misc';
import { listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import { dateKey } from '../../src/lib/utils';
import {
  BALANCE_DUPLICATE_TEXT,
  BALANCE_EXPIRED_TEXT,
  BALANCE_STALE_TEXT,
} from '../../src/handlers/ingest';
import type { VisionBalance, VisionResult } from '../../src/lib/vision';
import * as visionModule from '../../src/lib/vision';
import handleUpdate, { type Message } from '../../src/handlers/message';
import handleCallbackQuery from '../../src/handlers/callback_query';

const USER = 424250;
const CHAT = 424250;
const PHOTO_FILE_ID = 'PHOTO-FILE-BALANCE';

const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

const PHOTO = [{ file_id: PHOTO_FILE_ID, width: 800, height: 600 }];

/** Байты картинки: от них считается хэш, поэтому они же — идентификатор снимка. */
const BYTES_A = new Uint8Array([11, 22, 33]);
const BYTES_B = new Uint8Array([44, 55, 66]);

function snapshot(extra: Partial<VisionBalance> = {}): VisionBalance {
  return {
    accountName: 'AlphaBank',
    cardMask: '*1234',
    balanceCents: 391_729,
    currency: 'KZT',
    observedAt: null,
    recentTransactions: [],
    ambiguous: false,
    ...extra,
  };
}

function balanceResult(balances: VisionBalance[]): VisionResult {
  return {
    type: 'balance',
    summary: 'Скриншот AlphaBank',
    textContent: '',
    receipt: null,
    invoice: null,
    balance: balances,
    tasks: [],
    isFallback: false,
    errors: [],
    model: 'gemini-2.5-flash',
    usage: null,
  };
}

function photoMessage(extra: Partial<Message> = {}): Message {
  return {
    message_id: 701,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Test' },
    date: 1_763_000_000,
    photo: PHOTO,
    ...extra,
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

function answer(bytes: Uint8Array, result: VisionResult, message: Partial<Message> = {}): Promise<void> {
  (api as any).getFileContent = vi.fn().mockResolvedValue(bytes);
  vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(result);
  return handleUpdate(photoMessage(message));
}

/**
 * Нажатие inline-кнопки. Копит только то, что случилось после нажатия: ответ
 * на кнопку — всплывающая строка плюс правка того же сообщения.
 */
async function press(callbackData: string): Promise<void> {
  resetApi();
  await handleCallbackQuery({
    id: 'cb-bal-1',
    from: { id: USER, first_name: 'Test' },
    data: callbackData,
    message: { message_id: 701, chat: { id: CHAT }, text: 'Не смог сопоставить счёт' },
  });
}

const balanceOf = async (currency: string): Promise<number | undefined> => {
  const accounts = await listAccounts(USER);
  return accounts.find((account) => account.currency === currency)?.currentBalanceCents;
};

/**
 * След записи остатка: ровно одна заметка-аудит с суммой, счётом и моментом
 * наблюдения. Остаток остаётся состоянием счёта, но перестаёт быть бесследным.
 */
async function balanceTraceNotes() {
  const notes = await listNotes(USER);
  return notes.filter((note) => note.metadata?.category === 'balance');
}

interface InlineButton {
  text: string;
  callback_data: string;
}

/** Inline-кнопки последнего отправленного сообщения. */
function lastInlineButtons(): InlineButton[] {
  const sent = callsOf('sendMessage').at(-1);
  const markup = sent?.params.reply_markup as
    | { inline_keyboard?: InlineButton[][] }
    | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

const balanceButtons = (): InlineButton[] =>
  lastInlineButtons().filter((button) => button.callback_data.startsWith('bal:'));

/** Inline-кнопки последней правки сообщения (ответ на нажатие). */
function lastEditButtons(): InlineButton[] {
  const edit = callsOf('editMessageText').at(-1);
  const markup = edit?.params.reply_markup as
    | { inline_keyboard?: InlineButton[][] }
    | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

const editText = (): string => String(callsOf('editMessageText').at(-1)?.params.text ?? '');

/** Все inline-кнопки, отправленные за тест: список операций не должен всплыть нигде. */
function allInlineButtonData(): string[] {
  return callsOf('sendMessage').flatMap((call) => {
    const markup = call.params.reply_markup as
      | { inline_keyboard?: InlineButton[][] }
      | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
  });
}


/** Глушит ленивый крон утренней сводки в окне 07:00–11:00 UTC. */
async function markMorningDigestSent(timeZone: string): Promise<void> {
  const day = dateKey(new Date(), timeZone);
  await kvSetIfAbsent(
    `morning_digest:${USER}:${day}`,
    JSON.stringify({ sentAt: new Date().toISOString(), digestDate: day }),
  );
}

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
  setOverlayOverride({
    manifest: {
      finance: {
        accountAliases: [
          { account: 'AlphaBank', patterns: ['alpha', 'альфа'] },
          { account: 'CryptoX', patterns: ['cryptox', 'крипто'] },
          { account: 'CardOne', patterns: ['cardone', 'кардван'] },
          { account: 'Наличные', patterns: ['cash', 'кэш', 'налич'] },
        ],
        defaultAccountByCurrency: { EUR: 'Наличные', USD: 'CryptoX', RUB: 'CardOne', KZT: 'AlphaBank' },
        genericCardAccountByCurrency: { EUR: 'AlphaBank', USD: 'AlphaBank', RUB: 'CardOne', KZT: 'AlphaBank' },
      },
    },
  } as unknown as OverlayOverride);
  vi.restoreAllMocks();
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(SILENT_RUN);
  setBeginBlocked(true);

  const user = await ensureUser(USER, 'Test User');
  await markMorningDigestSent(user.timezone ?? 'Europe/Berlin');
});

afterEach(() => {
  resetOverlayOverride();
  delete (api as any).getFileContent;
});

describe('остаток со скриншота обновляет счёт', () => {
  it('updates existing CryptoX account without note or balance transaction', async () => {
    await ensureAccounts(USER, [
      { name: 'CryptoX', currency: 'USD', initialBalanceCents: 1_000 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ accountName: 'CryptoX', cardMask: '*7732', balanceCents: 12_345, currency: 'USD' }),
      ]),
    );

    const [account] = await listAccounts(USER);
    expect(account?.currentBalanceCents).toBe(12_345);
    // Ровно то, что видит владелец: сумма с символом после числа.
    expect(sentTexts().join('\n')).toContain('✅ Баланс CryptoX *7732 обновлён: <b>123,45 $</b>');
    // Остаток — состояние, а не операция: транзакции нет. Но след записи есть.
    expect(await listTransactions(USER)).toHaveLength(0);
    expect(await balanceTraceNotes()).toHaveLength(1);
  });

  it('updates every AlphaBank currency and prints trailing KZT symbol', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'AlphaBank', currency: 'USD', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 391_729, currency: 'KZT' }),
        snapshot({ balanceCents: 12_345, currency: 'USD' }),
      ]),
    );

    expect(await balanceOf('KZT')).toBe(391_729);
    expect(await balanceOf('USD')).toBe(12_345);

    const reply = sentTexts().join('\n');
    expect(reply).toContain('Балансы обновлены');
    expect(reply).toContain('3 917,29 ₸');
    expect(reply).toContain('123,45 $');
    expect(await balanceTraceNotes()).toHaveLength(1);
  });

  it('ambiguous account creates one explanatory inbox note and writes nothing', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 5_000 },
    ]);

    await answer(BYTES_A, balanceResult([snapshot({ ambiguous: true })]));

    const [account] = await listAccounts(USER);
    expect(account?.currentBalanceCents).toBe(5_000);

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.rawText).toContain('две разные суммы');
    expect(notes[0]?.rawText).toContain('Баланс не изменён');
    expect(sentTexts().join('\n')).toContain('Не смог сопоставить счёт');
  });

  it('unknown account is never auto-created', async () => {
    await answer(BYTES_A, balanceResult([snapshot({ accountName: 'BankTwo', balanceCents: 7_700 })]));

    expect(await listAccounts(USER)).toHaveLength(0);
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.rawText).toContain('нет среди счетов бота');
  });

  it('duplicate bytes are applied once', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(BYTES_A, balanceResult([snapshot()]));
    resetApi();
    await answer(BYTES_A, balanceResult([snapshot()]), { message_id: 702 });

    expect(await balanceOf('KZT')).toBe(391_729);
    expect(sentTexts().join('\n')).toContain(BALANCE_DUPLICATE_TEXT);
    // След остался от первого прохода; повтор его не дублирует.
    expect(await balanceTraceNotes()).toHaveLength(1);
  });

  it('older observedAt cannot overwrite newer balance', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ observedAt: '2026-11-15T10:00:00.000Z' })]),
    );
    resetApi();
    await answer(
      BYTES_B,
      balanceResult([
        snapshot({ balanceCents: 100, observedAt: '2026-11-14T10:00:00.000Z' }),
      ]),
      { message_id: 703 },
    );

    expect(await balanceOf('KZT')).toBe(391_729);
    expect(sentTexts().join('\n')).toContain(BALANCE_STALE_TEXT);
    // Отказ ничего не записал: след остался только у применённого снимка.
    expect(await balanceTraceNotes()).toHaveLength(1);
  });

  it('one stale/ambiguous row rolls back the whole multi-currency screenshot', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'AlphaBank', currency: 'USD', initialBalanceCents: 0 },
    ]);

    // Первый снимок применяет обе валюты и ставит водяные знаки.
    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 391_729, currency: 'KZT', observedAt: '2026-11-15T10:00:00.000Z' }),
        snapshot({ balanceCents: 12_345, currency: 'USD', observedAt: '2026-11-15T10:00:00.000Z' }),
      ]),
    );
    expect(await balanceOf('KZT')).toBe(391_729);
    expect(await balanceOf('USD')).toBe(12_345);

    resetApi();
    // KZT свежее, USD — старее применённого: применяться не должно НИЧЕГО.
    await answer(
      BYTES_B,
      balanceResult([
        snapshot({ balanceCents: 111, currency: 'KZT', observedAt: '2026-11-16T10:00:00.000Z' }),
        snapshot({ balanceCents: 222, currency: 'USD', observedAt: '2026-11-14T10:00:00.000Z' }),
      ]),
      { message_id: 704 },
    );

    expect(await balanceOf('KZT')).toBe(391_729);
    expect(await balanceOf('USD')).toBe(12_345);
    expect(sentTexts().join('\n')).toContain(BALANCE_STALE_TEXT);
  });

  it('a failure on the second currency keeps the first balance and its watermark', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'AlphaBank', currency: 'USD', initialBalanceCents: 0 },
    ]);

    const observedAt = '2026-11-15T10:00:00.000Z';
    const rows = [
      snapshot({ balanceCents: 111_00, currency: 'KZT', observedAt }),
      snapshot({ balanceCents: 222_00, currency: 'USD', observedAt }),
    ];

    // Платформа не даёт BEGIN: второй ряд падает уже после записи первого.
    const finances = await import('../../src/lib/dal/finances');
    const realSetBalance = finances.setAccountBalance;
    let writes = 0;
    const failing = vi
      .spyOn(finances, 'setAccountBalance')
      .mockImplementation(async (...args) => {
        writes += 1;
        if (writes === 2) throw new Error('storage exploded');
        return realSetBalance(...args);
      });

    await answer(BYTES_A, balanceResult(rows));

    const accounts = await listAccounts(USER);
    const kzt = accounts.find((account) => account.currency === 'KZT')!;
    const usd = accounts.find((account) => account.currency === 'USD')!;

    // Применённый ряд сохранил и остаток, и водяной знак.
    expect(kzt.currentBalanceCents).toBe(11_100);
    expect(await kvGet(`vision:balance-observed:${USER}:${kzt.id}`)).toBe(observedAt);
    // Неприменённый ряд не тронут и без водяного знака.
    expect(usd.currentBalanceCents).toBe(0);
    expect(await kvGet(`vision:balance-observed:${USER}:${usd.id}`)).toBeNull();

    // Повтор доносит только недостающий ряд; уже применённый — идемпотентен.
    failing.mockRestore();
    resetApi();
    await answer(BYTES_A, balanceResult(rows), { message_id: 705 });

    expect(await balanceOf('KZT')).toBe(11_100);
    expect(await balanceOf('USD')).toBe(22_200);
    expect(await kvGet(`vision:balance-observed:${USER}:${usd.id}`)).toBe(observedAt);
  });

  it('visible recent transaction is deferred, not booked', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    const item = {
      description: 'Coffee Point',
      amountCents: 717,
      currency: 'KZT',
      occurredAt: '2026-11-15T09:40:00.000Z',
    };

    await answer(BYTES_A, balanceResult([snapshot({ recentTransactions: [item] })]));

    // Остаток записан сразу: операции уже содержатся в нём.
    expect(await balanceOf('KZT')).toBe(391_729);
    // Строки книги нет: экран банка — состояние, а не операция.
    expect(await listTransactions(USER)).toHaveLength(0);
    expect(await balanceTraceNotes()).toHaveLength(1);
    // Подтверждать нечего: списка операций нет ни текстом, ни кнопкой.
    expect(allInlineButtonData().some((data) => data.startsWith('vtx:'))).toBe(false);
    expect(sentTexts().join('\n')).not.toContain('На снимке видны операции');
  });

  it('a zero-amount unknown currency does not block the balance', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    // Пустая полка CNY мультивалютной карты не должна ронять весь снимок.
    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 178_562, currency: 'KZT' }),
        snapshot({ balanceCents: 0, currency: 'CNY' }),
      ]),
    );

    expect(await balanceOf('KZT')).toBe(178_562);
    const reply = sentTexts().join('\n');
    expect(reply).not.toContain('CNY');
    expect(reply).not.toContain('не поддерживается');
    // Пустая полка не попадает ни в ответ, ни в след записи.
    const trace = (await balanceTraceNotes())[0];
    expect(trace?.rawText).not.toContain('CNY');
  });

  it('a non-zero unknown currency is skipped by name, not blocking the balance', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 5_000 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 178_562, currency: 'KZT' }),
        snapshot({ balanceCents: 1_500, currency: 'CNY' }),
      ]),
    );

    // Полку чужой валюты записать некуда (ни счёта, ни курса), но тенговая
    // полка того же экрана не должна из-за неё пропадать: 14.11 отказ по CNY
    // стирал весь снимок мультивалютной карты.
    expect(await balanceOf('KZT')).toBe(178_562);
    const reply = sentTexts().join('\n');
    expect(reply).toContain('CNY');
    expect(reply).toContain('Пропущено');
    expect(reply).toContain('бот не ведёт');
    // Пропуск виден и в следе записи, а не только в чате.
    const trace = (await balanceTraceNotes())[0];
    expect(trace?.rawText).toContain('CNY');
  });

});

describe('соседние пути не сломаны', () => {
  it('non-financial screenshot still goes to inbox', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue({
      type: 'general',
      summary: 'Фото кухни',
      textContent: '',
      receipt: null,
      invoice: null,
      balance: [],
      tasks: [],
      isFallback: false,
      errors: [],
      model: 'gemini-2.5-flash',
      usage: null,
    });

    await handleUpdate(photoMessage());

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.sourceType).toBe('photo');
    expect(notes[0]?.rawText).toContain('Фото кухни');
    expect(await listTransactions(USER)).toHaveLength(0);
  });

  it('plain receipt still creates exactly one expense', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'EUR', initialBalanceCents: 50_000 },
    ]);

    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue({
      type: 'receipt',
      summary: 'Чек из супермаркета Edeka',
      textContent: '',
      receipt: {
        merchant: 'Edeka',
        total: 42.75,
        totalCents: 4275,
        currency: 'EUR',
        date: null,
        category: 'Супермаркет',
        items: ['молоко'],
      },
      invoice: null,
      balance: [],
      tasks: [],
      isFallback: false,
      errors: [],
      model: 'gemini-2.5-flash',
      usage: null,
    });

    await handleUpdate(photoMessage());

    const expenses = (await listTransactions(USER)).filter((tx) => tx.kind === 'expense');
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.amountCents).toBe(4275);
    expect(sentTexts().join('\n')).toContain('Чек распознан и записан');
  });
});

/**
 * Маркетинговое название с экрана банка не совпадает с именем счёта в боте.
 * Порядок разрешения: бренд сужает набор → выученный псевдоним → явное
 * подтверждение владельцем. Деньги никогда не привязываются догадкой.
 */
describe('сопоставление счёта: бренд, псевдоним, подтверждение', () => {
  const MARKETING_NAME = 'Мультивалютная депозитная карта (KZT)';
  const UNKNOWN_NAME = 'Kaspi Gold';

  async function pressBalanceButton(): Promise<void> {
    const [button] = balanceButtons();
    expect(button).toBeDefined();
    await press(button!.callback_data);
  }

  const aliasRows = (): Promise<Array<{ key: string; value: string }>> =>
    db.all<{ key: string; value: string }>(
      sql`SELECT "key", value FROM kv WHERE "key" LIKE ${`vision:balance-alias:${USER}:%`}`,
    );

  it('a marketing product name resolves through the brand prefilter', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: MARKETING_NAME, balanceCents: 391_729 })]),
    );

    expect(await balanceOf('KZT')).toBe(391_729);
    expect(sentTexts().join('\n')).toContain('✅ Баланс AlphaBank *1234 обновлён: <b>3 917,29 ₸</b>');
    expect(await balanceTraceNotes()).toHaveLength(1);
  });

  it('an unknown name offers account buttons instead of a dead-end note', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 5_000 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: UNKNOWN_NAME, balanceCents: 7_700 })]),
    );

    const [account] = await listAccounts(USER);
    expect(account?.currentBalanceCents).toBe(5_000);
    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);

    const buttons = balanceButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text).toContain('AlphaBank');
    expect(buttons[0]!.callback_data.length).toBeLessThanOrEqual(64);
    // Повтор распознавания остаётся доступен.
    expect(
      lastInlineButtons().some((button) => button.callback_data.startsWith('retry_photo:')),
    ).toBe(true);
    expect(await aliasRows()).toHaveLength(0);
  });

  it('pressing the account button applies the balance and remembers the mapping', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: UNKNOWN_NAME, balanceCents: 391_729 })]),
    );
    expect(await balanceOf('KZT')).toBe(0);

    await pressBalanceButton();

    const [account] = await listAccounts(USER);
    expect(account?.currentBalanceCents).toBe(391_729);
    const edits = callsOf('editMessageText');
    expect(String(edits.at(-1)?.params.text)).toContain(
      '✅ Баланс AlphaBank *1234 обновлён: <b>3 917,29 ₸</b>',
    );

    const aliases = await aliasRows();
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.value).toBe(String(account?.id));
  });

  it('the remembered mapping resolves the next identical screenshot without buttons', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: UNKNOWN_NAME, balanceCents: 391_729 })]),
    );
    await pressBalanceButton();

    resetApi();
    await answer(
      BYTES_B,
      balanceResult([snapshot({ accountName: UNKNOWN_NAME, balanceCents: 400_000 })]),
      { message_id: 706 },
    );

    expect(await balanceOf('KZT')).toBe(400_000);
    expect(balanceButtons()).toHaveLength(0);
    expect(sentTexts().join('\n')).toContain(
      '✅ Баланс AlphaBank *1234 обновлён: <b>4 000,00 ₸</b>',
    );
  });

  it('two same-currency candidates are never chosen automatically', async () => {
    await ensureAccounts(USER, [
      { name: 'Terminal Alpha', currency: 'KZT', initialBalanceCents: 1_000 },
      { name: 'Terminal Beta', currency: 'KZT', initialBalanceCents: 2_000 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: 'Terminal', balanceCents: 999_00 })]),
    );

    const balances = (await listAccounts(USER)).map((account) => account.currentBalanceCents);
    expect(balances.sort()).toEqual([1_000, 2_000]);
    expect(balanceButtons()).toHaveLength(2);
    expect(await aliasRows()).toHaveLength(0);
    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);
  });

  it('no cross-currency buttons are offered when the currency has no account', async () => {
    await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'EUR', initialBalanceCents: 1_000 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ accountName: UNKNOWN_NAME, currency: 'KZT', balanceCents: 7_700 }),
      ]),
    );

    // Кнопка чужой валюты — тупик: `sameCurrency` её всё равно отклонит.
    expect(balanceButtons()).toHaveLength(0);
    const reply = sentTexts().join('\n');
    expect(reply).toContain('счетов в KZT нет');
    expect(
      lastInlineButtons().some((button) => button.callback_data.startsWith('retry_photo:')),
    ).toBe(true);
    const [account] = await listAccounts(USER);
    expect(account?.currentBalanceCents).toBe(1_000);
  });

  it('an expired pending snapshot is refused instead of applied', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: UNKNOWN_NAME, balanceCents: 391_729 })]),
    );
    const [button] = balanceButtons();
    expect(button).toBeDefined();

    // Протухание проверяется по `createdAt` внутри значения: у таблицы `kv`
    // нет колонки срока, а схему ради этого не меняем.
    const rows = await db.all<{ key: string; value: string }>(
      sql`SELECT "key", value FROM kv WHERE "key" LIKE ${'vision:balance-pending:%'}`,
    );
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0]!.value) as Record<string, unknown>;
    const stale = { ...stored, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    await db.run(
      sql`UPDATE kv SET value = ${JSON.stringify(stale)} WHERE "key" = ${rows[0]!.key}`,
    );

    await press(button!.callback_data);

    expect(String(callsOf('answerCallbackQuery').at(-1)?.params.text)).toBe(BALANCE_EXPIRED_TEXT);
    expect(await balanceOf('KZT')).toBe(0);
    // Кнопки выбора счёта убраны, причина дописана под разделитель.
    const closing = callsOf('editMessageText').at(-1);
    expect(closing?.params.message_id).toBe(701);
    expect(closing?.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(String(closing?.params.text)).toContain(`━━━━━━━━━━━━━━\n${BALANCE_EXPIRED_TEXT}`);
  });

  it('a token that was never stored closes the card with no choice buttons', async () => {
    await press('bal:no-such-token:7');

    expect(String(callsOf('answerCallbackQuery').at(-1)?.params.text)).toBe(BALANCE_EXPIRED_TEXT);
    const closing = callsOf('editMessageText').at(-1);
    expect(closing?.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(String(closing?.params.text)).toContain('Не смог сопоставить счёт');
    expect(String(closing?.params.text)).toContain(BALANCE_EXPIRED_TEXT);
  });

  it('an unalias tap on an expired snapshot also clears the card', async () => {
    await press('bal:unalias:no-such-token');

    expect(String(callsOf('answerCallbackQuery').at(-1)?.params.text)).toBe(BALANCE_EXPIRED_TEXT);
    expect(callsOf('editMessageText').at(-1)?.params.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('a wrong account choice can be undone and the alias re-learned', async () => {
    await ensureAccounts(USER, [
      { name: 'Terminal Alpha', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'Terminal Beta', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([snapshot({ accountName: UNKNOWN_NAME, balanceCents: 391_729 })]),
    );

    const buttons = balanceButtons();
    expect(buttons).toHaveLength(2);
    const alphaButton = buttons.find((button) => button.text.includes('Terminal Alpha'));
    const betaButton = buttons.find((button) => button.text.includes('Terminal Beta'));
    expect(alphaButton).toBeDefined();
    expect(betaButton).toBeDefined();

    const accounts = await listAccounts(USER);
    const alphaId = accounts.find((account) => account.name === 'Terminal Alpha')!.id;
    const betaId = accounts.find((account) => account.name === 'Terminal Beta')!.id;
    const balanceOfAccount = async (id: number): Promise<number | undefined> =>
      (await listAccounts(USER)).find((account) => account.id === id)?.currentBalanceCents;

    await press(alphaButton!.callback_data);
    expect(await balanceOfAccount(alphaId)).toBe(391_729);
    expect((await aliasRows())[0]?.value).toBe(String(alphaId));

    const unalias = lastEditButtons().find((button) =>
      button.callback_data.startsWith('bal:unalias:'),
    );
    expect(unalias).toBeDefined();
    expect(unalias!.callback_data.length).toBeLessThanOrEqual(64);

    await press(unalias!.callback_data);

    // Связка снята, записанные деньги не тронуты, выбор снова открыт.
    expect(await aliasRows()).toHaveLength(0);
    expect(await balanceOfAccount(alphaId)).toBe(391_729);
    expect(editText()).toContain('не откатывается');
    const reopened = lastEditButtons().filter((button) =>
      button.callback_data.startsWith('bal:'),
    );
    expect(reopened.map((button) => button.callback_data.split(':').at(-1)).sort()).toEqual(
      [alphaId, betaId].map(String).sort(),
    );

    await press(betaButton!.callback_data);

    expect(await balanceOfAccount(betaId)).toBe(391_729);
    // Прежний счёт сохраняет записанное: остаток не обнуляется и не откатывается.
    expect(await balanceOfAccount(alphaId)).toBe(391_729);
    const aliases = await aliasRows();
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.value).toBe(String(betaId));
  });
});


/**
 * Тихие отказы и след записи.
 *
 * Мультивалютная карта AlphaBank печатает полки чужих валют рядом с тенговой:
 * такой снимок раньше мог вернуть ошибку неподдерживаемой валюты и не записать
 * даже KZT, а снимок CardOne мог исчезнуть без ответа и следа.
 */
describe('полки чужих валют и след записи', () => {
  it('полка в неподдерживаемой валюте не отменяет запись поддерживаемых', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 178_562, currency: 'KZT' }),
        // Полка, которую бот записать не может: у неё нет ни счёта, ни курса.
        snapshot({ balanceCents: 500_000, currency: 'CNY' }),
      ]),
    );

    expect(await balanceOf('KZT')).toBe(178_562);
    const reply = sentTexts().join('\n');
    expect(reply).toContain('1 785,62 ₸');
    // Пропуск назван, а не проглочен.
    expect(reply).toContain('CNY');
    expect(reply).toContain('Пропущено');
    expect(reply).toContain('бот не ведёт');
    expect(reply).not.toContain('Баланс не изменён');
  });

  it('нулевые полки CNY и AED не мешают записи и не упоминаются', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 178_562, currency: 'KZT' }),
        snapshot({ balanceCents: 0, currency: 'CNY' }),
        snapshot({ balanceCents: 0, currency: 'AED' }),
      ]),
    );

    expect(await balanceOf('KZT')).toBe(178_562);
    const reply = sentTexts().join('\n');
    expect(reply).not.toContain('CNY');
    expect(reply).not.toContain('AED');
    expect(reply).not.toContain('не поддерживается');
  });

  it('остаток, который не удалось прочитать, не теряется молча', async () => {
    await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 921_759 },
    ]);

    // Модель увидела остаток, но нормализация отбросила все строки: суммы или
    // валюты не было. Раньше такой снимок молча уходил в общий инбокс.
    const rejected = { ...balanceResult([]), balanceRejected: 1 };
    await answer(BYTES_A, rejected);

    const reply = sentTexts().join('\n');
    expect(reply).toContain('остаток');
    expect(reply).toContain('не удалось прочитать');
    // Снимок остаётся повторяемым: заметка с причиной, а не тишина.
    const notes = await listNotes(USER);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.metadata).toMatchObject({ balance_rejected: 1 });
  });

  it('экран остатка без единой строки тоже не молчит', async () => {
    await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 921_759 },
    ]);

    // Модель назвала экран остатком, но строк не вернула вовсе — счётчик потерь
    // тут нулевой, и без отдельной проверки типа такой снимок уходил в инбокс.
    await answer(BYTES_A, balanceResult([]));

    const reply = sentTexts().join('\n');
    expect(reply).toContain('не удалось прочитать');
    expect(reply).not.toContain('сохранено в инбокс');
    expect(await listNotes(USER)).toHaveLength(1);
  });

  it('снимок, из которого взяли текст, не превращается в «остаток не прочитан»', async () => {
    // Модель поставила type='balance', но остатка не дала, зато прочитала текст.
    // Ранний выход «остаток не прочитан» выбросил бы обычный разбор целиком.
    await answer(BYTES_A, {
      ...balanceResult([]),
      textContent: 'Перевод 500 ₸ на карту *1111',
    });

    const reply = sentTexts().join('\n');
    expect(reply).not.toContain('не удалось прочитать');
    const notes = await listNotes(USER);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.rawText).toContain('Перевод 500');
  });

  it('записанный остаток оставляет след: сумма, счёт и время наблюдения', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          balanceCents: 2_737_387,
          currency: 'KZT',
          observedAt: '2026-11-17T11:26:00.000Z',
        }),
      ]),
    );

    expect(await balanceOf('KZT')).toBe(2_737_387);
    const notes = await listNotes(USER);
    expect(notes).toHaveLength(1);
    const trace = notes[0]!;
    expect(trace.rawText).toContain('27 373,87');
    expect(trace.rawText).toContain('AlphaBank');
    expect(trace.rawText).toContain('2026-11-17');
    expect(trace.metadata).toMatchObject({ category: 'balance', currency: 'KZT' });
  });
});

describe('VIS-ZERO1 / VIS-RUB1 / VIS-CARD1: контекст и безопасная маршрутизация', () => {
  it('передаёт активные accounts и 07_custom_instructions в analyzeImageContent', async () => {
    await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 921_759 },
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 2_737_387 },
    ]);
    await upsertChapter(USER, {
      slug: CUSTOM_INSTRUCTIONS_SLUG,
      title: 'Инструкции',
      content: 'Карта *1234 — это AlphaBank.',
    });

    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    const spy = vi
      .spyOn(visionModule, 'analyzeImageContent')
      .mockResolvedValue(balanceResult([snapshot({ balanceCents: 2_800_000, currency: 'KZT' })]));

    await handleUpdate(photoMessage());

    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]?.[1];
    expect(opts?.accounts).toHaveLength(2);
    expect(opts?.accounts?.map((a) => a.name)).toEqual(
      expect.arrayContaining(['CardOne', 'AlphaBank']),
    );
    expect(opts?.customInstructions).toContain('Карта *1234 — это AlphaBank.');
  });

  it('VIS-ZERO1: нулевые полки на мультивалютной карте не затирают положительные KZT/TRY (с shelfKind и без)', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 2_737_387 },
      { name: 'AlphaBank', currency: 'TRY', initialBalanceCents: 26 },
      { name: 'AlphaBank', currency: 'EUR', initialBalanceCents: 5_000 },
    ]);

    // Случай 1: модель пометила пустые полки как inactive_zero_shelf
    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ balanceCents: 0, currency: 'KZT', shelfKind: 'inactive_zero_shelf' }),
        snapshot({ balanceCents: 0, currency: 'TRY', shelfKind: 'inactive_zero_shelf' }),
        snapshot({ balanceCents: 10_000, currency: 'EUR' }),
      ]),
    );

    expect(await balanceOf('EUR')).toBe(10_000);
    expect(await balanceOf('KZT')).toBe(2_737_387);
    expect(await balanceOf('TRY')).toBe(26);

    // Случай 2: модель прислала 0 без shelfKind на мультивалютном экране
    resetApi();
    await answer(
      BYTES_B,
      balanceResult([
        snapshot({ balanceCents: 0, currency: 'KZT' }),
        snapshot({ balanceCents: 0, currency: 'TRY' }),
        snapshot({ balanceCents: 15_000, currency: 'EUR' }),
      ]),
      { message_id: 710 },
    );

    expect(await balanceOf('EUR')).toBe(15_000);
    expect(await balanceOf('KZT')).toBe(2_737_387);
    expect(await balanceOf('TRY')).toBe(26);
  });

  it('VIS-ZERO1: одиночный снимок 0 против положительного счёта требует 1-tap подтверждения', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 2_737_387 },
    ]);

    await answer(BYTES_A, balanceResult([snapshot({ balanceCents: 0, currency: 'KZT' })]));

    expect(await balanceOf('KZT')).toBe(2_737_387);
    const buttons = balanceButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.text).toContain('AlphaBank');

    await press(buttons[0]!.callback_data);
    expect(await balanceOf('KZT')).toBe(0);
  });

  it('VIS-RUB1 (Case A): явный accountId обновляет AlphaBank RUB и не трогает CardOne', async () => {
    const accounts = await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 921_759 },
      { name: 'AlphaBank', currency: 'RUB', initialBalanceCents: 0 },
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 2_737_387 },
    ]);
    const cardOne = accounts.find((a) => a.name === 'CardOne')!;
    const alphaRub = accounts.find((a) => a.name === 'AlphaBank' && a.currency === 'RUB')!;

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          accountName: 'Карта',
          cardMask: '*1234',
          balanceCents: 50_000,
          currency: 'RUB',
          accountId: alphaRub.id,
        }),
      ]),
    );

    const after = await listAccounts(USER);
    expect(after.find((a) => a.id === alphaRub.id)?.currentBalanceCents).toBe(50_000);
    expect(after.find((a) => a.id === cardOne.id)?.currentBalanceCents).toBe(921_759);
  });

  it('VIS-RUB1 (Case B): Карта *1234 RUB на экране AlphaBank идёт в AlphaBank RUB, а не в CardOne', async () => {
    const accounts = await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 921_759 },
      { name: 'AlphaBank', currency: 'RUB', initialBalanceCents: 0 },
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 2_737_387 },
    ]);
    const cardOne = accounts.find((a) => a.name === 'CardOne')!;
    const alphaRub = accounts.find((a) => a.name === 'AlphaBank' && a.currency === 'RUB')!;
    const alphaKzt = accounts.find((a) => a.name === 'AlphaBank' && a.currency === 'KZT')!;

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ accountName: 'AlphaBank', balanceCents: 3_000_000, currency: 'KZT' }),
        snapshot({ accountName: 'Карта', cardMask: '*1234', balanceCents: 42_000, currency: 'RUB' }),
      ]),
    );

    const after = await listAccounts(USER);
    expect(after.find((a) => a.id === alphaKzt.id)?.currentBalanceCents).toBe(3_000_000);
    expect(after.find((a) => a.id === alphaRub.id)?.currentBalanceCents).toBe(42_000);
    expect(after.find((a) => a.id === cardOne.id)?.currentBalanceCents).toBe(921_759);
  });

  it('VIS-CARD1: 0 RUB основной счёт + 15 362,02 ₽ накопительный применяет 1_536_202 к CardOne', async () => {
    const [cardOne] = await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          accountName: 'Основной счёт',
          cardMask: '*1935',
          balanceCents: 0,
          currency: 'RUB',
          shelfKind: 'inactive_zero_shelf',
        }),
        snapshot({
          accountName: 'Накопительный счёт',
          cardMask: null,
          balanceCents: 1_536_202,
          currency: 'RUB',
          accountId: cardOne!.id,
        }),
      ]),
    );

    const after = await listAccounts(USER);
    expect(after[0]?.currentBalanceCents).toBe(1_536_202);
    expect(sentTexts().join('\n')).toContain('15 362,02 ₽');

    // Когда обе полки без shelfKind резолвятся в CardOne, дедупликация оставляет > 0 без ambiguous.
    resetApi();
    await answer(
      BYTES_B,
      balanceResult([
        snapshot({ accountName: 'CardOne', cardMask: '*1935', balanceCents: 0, currency: 'RUB' }),
        snapshot({ accountName: 'CardOne Накопительный', cardMask: null, balanceCents: 1_900_000, currency: 'RUB' }),
      ]),
      { message_id: 711 },
    );
    expect((await listAccounts(USER))[0]?.currentBalanceCents).toBe(1_900_000);
  });

  it('VIS-CARD1: при пропуске [0] и ошибке на [1] заголовок и кнопка указывают на [1], а не [0]', async () => {
    await ensureAccounts(USER, [
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 0 },
      { name: 'AlphaBank', currency: 'RUB', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          accountName: 'Пустая полка',
          cardMask: '*0000',
          balanceCents: 0,
          currency: 'RUB',
          shelfKind: 'inactive_zero_shelf',
        }),
        snapshot({
          accountName: 'Накопительный счёт',
          cardMask: null,
          balanceCents: 1_536_202,
          currency: 'RUB',
        }),
      ]),
    );

    const reply = sentTexts().join('\n');
    expect(reply).toContain('Не смог сопоставить счёт: Накопительный счёт (RUB)');
    expect(reply).not.toContain('Пустая полка');
    expect(balanceButtons()).toHaveLength(2);
  });

  it('VIS-CARD1: при частичном совпадении [0] валидный и [1] нераспознанный, [0] применяется, а prompt и кнопка относятся к [1]', async () => {
    const accounts = await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 0 },
    ]);
    const cardOne = accounts.find((a) => a.name === 'CardOne')!;
    const alphaKzt = accounts.find((a) => a.name === 'AlphaBank')!;

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ accountName: 'AlphaBank', balanceCents: 250_000, currency: 'KZT' }),
        snapshot({
          accountName: 'Накопительный счёт',
          cardMask: null,
          balanceCents: 1_536_202,
          currency: 'RUB',
        }),
      ]),
    );

    // [0] уже применён
    expect((await listAccounts(USER)).find((a) => a.id === alphaKzt.id)?.currentBalanceCents).toBe(
      250_000,
    );
    expect((await listAccounts(USER)).find((a) => a.id === cardOne.id)?.currentBalanceCents).toBe(0);

    // Заголовок ошибки и кнопка указывают именно на [1] ("Накопительный счёт (RUB)"), НЕ на AlphaBank!
    const allReplies = sentTexts().join('\n');
    expect(allReplies).toContain('✅ Баланс AlphaBank *1234 обновлён');
    expect(allReplies).toContain('Не смог сопоставить счёт: Накопительный счёт (RUB)');
    expect(allReplies).not.toContain('Не смог сопоставить счёт: AlphaBank');

    const buttons = balanceButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.text).toContain('CardOne');

    // Нажатие кнопки применяет ТОЛЬКО [1] (CardOne), и не падает как duplicate!
    await press(buttons[0]!.callback_data);
    expect((await listAccounts(USER)).find((a) => a.id === cardOne.id)?.currentBalanceCents).toBe(
      1_536_202,
    );
    expect((await listAccounts(USER)).find((a) => a.id === alphaKzt.id)?.currentBalanceCents).toBe(
      250_000,
    );
    expect(editText()).toContain('15 362,02 ₽');
  });

  it('не-брендовый счёт на полке [0] (Terminal Alpha KZT) не даёт screenBankHint для общей полки «Карта» (RUB)', async () => {
    const accounts = await ensureAccounts(USER, [
      { name: 'Terminal Alpha', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'Terminal Alpha', currency: 'RUB', initialBalanceCents: 10_000 },
      { name: 'Sibling Bank', currency: 'RUB', initialBalanceCents: 20_000 },
    ]);
    const alphaKzt = accounts.find((a) => a.name === 'Terminal Alpha' && a.currency === 'KZT')!;
    const alphaRub = accounts.find((a) => a.name === 'Terminal Alpha' && a.currency === 'RUB')!;
    const siblingRub = accounts.find((a) => a.name === 'Sibling Bank' && a.currency === 'RUB')!;

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          accountName: 'Terminal Alpha',
          cardMask: null,
          balanceCents: 100_000,
          currency: 'KZT',
          accountId: alphaKzt.id,
        }),
        snapshot({
          accountName: 'Карта',
          cardMask: null,
          balanceCents: 50_000,
          currency: 'RUB',
        }),
      ]),
    );

    const after = await listAccounts(USER);
    expect(after.find((a) => a.id === alphaKzt.id)?.currentBalanceCents).toBe(100_000);
    // Ни Terminal Alpha (RUB), ни Sibling Bank (RUB) не должны авто-примениться по ложному хинту.
    expect(after.find((a) => a.id === alphaRub.id)?.currentBalanceCents).toBe(10_000);
    expect(after.find((a) => a.id === siblingRub.id)?.currentBalanceCents).toBe(20_000);
    expect(sentTexts().join('\n')).toContain('Не смог сопоставить счёт: Карта (RUB)');
    expect(balanceButtons()).toHaveLength(2);
  });

  it('отказ при allowReapply (follow-up applyBalanceChoice) сохраняет claimKey исходного скриншота', async () => {
    const accounts = await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
      { name: 'CardOne', currency: 'RUB', initialBalanceCents: 10_000 },
    ]);
    const alphaKzt = accounts.find((a) => a.name === 'AlphaBank')!;
    const cardOneRub = accounts.find((a) => a.name === 'CardOne')!;

    // Снимок A: [0] применяется сразу, [1] уходит в partial pending с observedAt = 14.11.
    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          accountName: 'AlphaBank',
          balanceCents: 250_000,
          currency: 'KZT',
          observedAt: '2026-11-15T10:00:00.000Z',
        }),
        snapshot({
          accountName: 'Накопительный счёт',
          cardMask: null,
          balanceCents: 1_536_202,
          currency: 'RUB',
          observedAt: '2026-11-14T10:00:00.000Z',
        }),
      ]),
    );

    const [choiceBtn] = balanceButtons();
    expect(choiceBtn).toBeDefined();
    // В частичном pending нет сломанной кнопки retry_photo:.
    expect(lastInlineButtons().some((b) => b.callback_data.startsWith('retry_photo:'))).toBe(false);

    // Более свежий снимок B обновляет CardOne (16.11) — теперь подтверждение A устарело.
    resetApi();
    await answer(
      BYTES_B,
      balanceResult([
        snapshot({
          accountName: 'CardOne',
          cardMask: null,
          balanceCents: 2_000_000,
          currency: 'RUB',
          observedAt: '2026-11-16T10:00:00.000Z',
        }),
      ]),
      { message_id: 712 },
    );

    // Нажатие кнопки на старом partial pending падает как stale в catch(applyBalanceSnapshot).
    await press(choiceBtn!.callback_data);
    expect(String(callsOf('answerCallbackQuery').at(-1)?.params.text)).toBe(BALANCE_STALE_TEXT);
    // Устаревший выбор не оставляет кнопок: нажатие вело бы в тот же отказ.
    const staleEdit = callsOf('editMessageText').at(-1);
    expect(staleEdit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(String(staleEdit?.params.text)).toContain(BALANCE_STALE_TEXT);

    // Повторная отправка исходного снимка A всё равно обязана видеть claimKey и отвечать duplicate!
    resetApi();
    await answer(
      BYTES_A,
      balanceResult([
        snapshot({
          accountName: 'AlphaBank',
          balanceCents: 250_000,
          currency: 'KZT',
          observedAt: '2026-11-15T10:00:00.000Z',
        }),
      ]),
      { message_id: 713 },
    );
    expect(sentTexts().join('\n')).toContain(BALANCE_DUPLICATE_TEXT);
    const finalAccounts = await listAccounts(USER);
    expect(finalAccounts.find((a) => a.id === alphaKzt.id)?.currentBalanceCents).toBe(250_000);
    expect(finalAccounts.find((a) => a.id === cardOneRub.id)?.currentBalanceCents).toBe(2_000_000);
  });

  it('частичное применение без кандидатов (choices.length === 0) не рисует сломанную кнопку Повторить и отмечает лишние несопоставленные строки', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    await answer(
      BYTES_A,
      balanceResult([
        snapshot({ accountName: 'AlphaBank', balanceCents: 250_000, currency: 'KZT' }),
        snapshot({ accountName: 'Карта RUB', cardMask: null, balanceCents: 50_000, currency: 'RUB' }),
        snapshot({ accountName: 'Карта EUR', cardMask: null, balanceCents: 10_000, currency: 'EUR' }),
      ]),
    );

    expect(await balanceOf('KZT')).toBe(250_000);
    const reply = sentTexts().join('\n');
    expect(reply).toContain('Не смог сопоставить счёт: Карта RUB (RUB)');
    expect(reply).toContain('Ещё несопоставленных строк на снимке: 1.');
    expect(allInlineButtonData().some((data) => data.startsWith('retry_photo:'))).toBe(false);
  });
});
