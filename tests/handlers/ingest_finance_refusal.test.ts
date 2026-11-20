/**
 * Деньги, которых по книге нет.
 *
 * Правило владельца (13.11.2026): расход — это факт, терять его нельзя.
 * Если остаток счёта не покрывает сумму, расход всё равно записывается
 * целиком, баланс не уходит в минус, а непокрытая разница помечается в ответе
 * и отдельными служебными строками. Перевод и обмен по-прежнему отказывают:
 * отправить деньги, которых нет, нельзя.
 *
 * Регрессия 13.11.2026: «потратил 100 eur с AlphaBank» при 4,60 € на
 * субсчёте уходило в инбокс заметкой, а отказ оставлял в книге призрачный
 * расход. Тесты идут с запрещённым BEGIN, как на tgcloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../../src/lib/agent/engine.js', () => ({ runAgent: runAgentMock }));
vi.mock('../../src/lib/agent/engine', () => ({ runAgent: runAgentMock }));

import { api, callsOf, resetApi, resetDb, setBeginBlocked, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache } from '../../src/lib/config';
import { resetOverlayOverride, setOverlayOverride, type OverlayOverride } from '../../src/lib/overlay';
import { ensureAccounts, findAccountByName, InsufficientFundsError, listTransactions } from '../../src/lib/dal/finances';
import { listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import * as financialParser from '../../src/lib/financial-parser';
import { parseFinancialIntent } from '../../src/lib/financial-parser';
import * as visionModule from '../../src/lib/vision';
import { handlePhotoMessage, smartIngest } from '../../src/handlers/ingest';

const USER = 424243;
const CHAT = 424243;

const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

const sentTexts = (): string[] => callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  setOverlayOverride({
    manifest: {
      finance: {
        accountAliases: [
          { account: 'AlphaBank', patterns: ['alpha bank', 'alpha', 'альфа'] },
          { account: 'WalletX', patterns: ['walletx', 'wallet'] },
        ],
        defaultAccountByCurrency: { EUR: 'AlphaBank', KZT: 'AlphaBank', USD: 'WalletX' },
        genericCardAccountByCurrency: { EUR: 'AlphaBank', KZT: 'AlphaBank', USD: 'WalletX' },
      },
    },
  } as unknown as OverlayOverride);
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(SILENT_RUN);

  await ensureUser(USER, 'Test User');
  // Ровно как в реальном чате на скриншоте: на EUR-субсчёте почти пусто,
  // на KZT не хватает на добор.
  await ensureAccounts(USER, [
    { name: 'AlphaBank', currency: 'EUR', initialBalanceCents: 460 },
    { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 2986387 },
  ]);

  // tgcloud: BEGIN заблокирован, откат только ручной.
  setBeginBlocked(true);
});

afterEach(() => {
  resetOverlayOverride();
});

describe('расход больше остатка: пишем и помечаем недокрытие', () => {
  it('фиксирует расход целиком, не уводит баланс в минус и говорит о разнице', async () => {
    await smartIngest({
      userId: USER,
      chatId: CHAT,
      text: 'потратил 100 eur с AlphaBank',
      forwarded: false,
    });

    const answer = sentTexts().join('\n');
    expect(answer).toContain('Расход зафиксирован');
    expect(answer).toContain('непокрытая разница');
    expect(answer).not.toContain('инбокс');

    const eur = await findAccountByName(USER, 'AlphaBank', 'EUR');
    const kzt = await findAccountByName(USER, 'AlphaBank', 'KZT');
    expect(eur?.currentBalanceCents).toBe(0);
    expect(kzt?.currentBalanceCents).toBe(0);

    const txs = await listTransactions(USER);
    const expense = txs.filter((tx) => tx.kind === 'expense');
    expect(expense).toHaveLength(1);
    expect(expense[0]?.amountCents).toBe(10000);
    expect(txs.some((tx) => tx.kind === 'adjustment')).toBe(true);
  });

  it('подпись к фото проводит тот же расход', async () => {
    await handlePhotoMessage(USER, CHAT, [{ file_id: 'file-1', width: 100, height: 100 }], 'потратил 100 eur с AlphaBank');

    expect(sentTexts().join('\n')).toContain('Расход зафиксирован');
    expect(runAgentMock).not.toHaveBeenCalled();
    // Одна аудиторская заметка от самого расхода — и ни одной «из инбокса».
    expect(await listNotes(USER)).toHaveLength(1);
  });
});

describe('чек распознан, но списание отклонено: сумма и причина остаются', () => {
  afterEach(() => {
    delete (api as any).getFileContent;
    vi.restoreAllMocks();
  });

  it('говорит об отказе, хранит сумму в metadata и не предлагает повтор', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue({
      type: 'receipt',
      summary: 'Чек из аптеки',
      textContent: '',
      receipt: {
        merchant: 'Аптека',
        total: 12.3,
        totalCents: 1230,
        currency: 'EUR',
        date: null,
        category: 'Аптека',
        items: [],
      },
      invoice: null,
      balance: [],
      tasks: [],
      isFallback: false,
      errors: [],
      model: 'gemini-2.5-flash',
      usage: null,
    });
    vi.spyOn(financialParser, 'executeFinancialIntent').mockRejectedValue(
      new InsufficientFundsError({
        message: 'на счёте «Аптека» (EUR) не хватает денег: нужно 12,30 €, есть 4,60 €',
        reason: 'no_settlement',
        accountName: 'Аптека',
        currency: 'EUR',
        requiredCents: 1230,
        availableCents: 460,
        settlementAccountName: null,
        settlementCurrency: null,
        settlementRequiredCents: 0,
        settlementAvailableCents: 0,
      }),
    );

    await handlePhotoMessage(USER, CHAT, [{ file_id: 'file-1', width: 100, height: 100 }]);

    const answer = sentTexts().join('\n');
    expect(answer).toContain('Расход не проведён');
    expect(answer).not.toContain('Расход зафиксирован');

    // Распознанная сумма не вычитывается из текста заметки, а лежит в metadata.
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].metadata).toMatchObject({
      receipt_failure: { reason: 'insufficient_funds', total: 12.3, currency: 'EUR' },
    });

    // Стадия после возможной финансовой записи: повтора нет.
    const markup = callsOf('sendMessage').at(-1)?.params.reply_markup as
      | { inline_keyboard: Array<Array<{ callback_data?: string }>> }
      | undefined;
    const buttons = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(buttons.some((data) => data?.startsWith('retry_photo:'))).toBe(false);
  });
});

describe('перевод больше остатка: отказ без следов', () => {
  it('объясняет отказ и не оставляет ни строк, ни заметок', async () => {
    const text = 'переведи 100 eur с AlphaBank на WalletX';
    expect(parseFinancialIntent(text)?.action).toBe('transfer');

    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    const answer = sentTexts().join('\n');
    expect(answer).toContain('Перевод не проведён');
    expect(await listTransactions(USER)).toHaveLength(0);
    expect(await listNotes(USER)).toHaveLength(0);
    // Сначала сообщение уходит в runAgent; здесь мок отдал empty_reply, поэтому
    // сработал офлайн-фоллбэк финансового парсера.
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});

describe('агентный шаг: отказ финансового инструмента', () => {
  const REFUSED_RUN = {
    reply: 'Перевод не записан: на AlphaBank (EUR) 4,60 €, а нужно 100,00 €.',
    mode: 'action',
    steps: [
      {
        index: 0,
        thought: null,
        action: { name: 'add_transfer', args: {} },
        observation: 'Не удалось записать перевод: на счёте «AlphaBank» (EUR) не хватает денег',
        ok: false,
      },
    ],
    stopReason: 'final',
    thread: [],
  };

  it('отдаёт объяснение агента, а не складывает текст в инбокс', async () => {
    const text = 'оплати подписку с AlphaBank';
    expect(parseFinancialIntent(text)).toBeNull();

    runAgentMock.mockResolvedValue(REFUSED_RUN);
    await smartIngest({ userId: USER, chatId: CHAT, text, forwarded: false });

    expect(sentTexts().join('\n')).toContain('Перевод не записан');
    expect(await listNotes(USER)).toHaveLength(0);
  });
});
