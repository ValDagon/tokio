/**
 * Счёт на оплату — обязательство, а не расход.
 *
 * Деньги ещё не ушли: строка появляется в обязательствах, и оплата пойдёт
 * обычным путём. Неполный счёт (нет получателя, суммы или срока) не угадывается
 * и не теряется — он остаётся в инбоксе с причиной. Повтор того же файла не
 * создаёт второе обязательство.
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

import { api, callsOf, resetApi, resetDb, setBeginBlocked, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { listLiabilities, listTransactions } from '../../src/lib/dal/finances';
import { listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import { INVOICE_DUPLICATE_TEXT } from '../../src/handlers/ingest';
import type { VisionInvoice, VisionResult } from '../../src/lib/vision';
import * as visionModule from '../../src/lib/vision';
import handleUpdate, { type Message } from '../../src/handlers/message';

const USER = 424251;
const CHAT = 424251;
const PHOTO_FILE_ID = 'PHOTO-FILE-INVOICE';

const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

const PHOTO = [{ file_id: PHOTO_FILE_ID, width: 800, height: 600 }];

const BYTES_A = new Uint8Array([71, 72, 73]);

function invoiceResult(invoice: VisionInvoice): VisionResult {
  return {
    type: 'invoice',
    summary: 'Счёт на оплату HomeNet',
    textContent: '',
    receipt: null,
    invoice,
    balance: [],
    tasks: [],
    isFallback: false,
    errors: [],
    model: 'gemini-2.5-flash',
    usage: null,
  };
}

function photoMessage(extra: Partial<Message> = {}): Message {
  return {
    message_id: 801,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Test' },
    date: 1_763_000_000,
    photo: PHOTO,
    ...extra,
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
  vi.restoreAllMocks();
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue(SILENT_RUN);
  setBeginBlocked(true);

  await ensureUser(USER, 'Test User');
});

afterEach(() => {
  delete (api as any).getFileContent;
});

describe('счёт на оплату становится обязательством', () => {
  it('valid invoice becomes one liability, not an expense', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      invoiceResult({
        payee: 'HomeNet',
        amountCents: 45_00,
        currency: 'EUR',
        dueDate: '2026-12-01',
      }),
    );

    await handleUpdate(photoMessage());

    const liabilities = await listLiabilities(USER);
    expect(liabilities).toHaveLength(1);
    expect(liabilities[0]).toMatchObject({
      name: 'HomeNet',
      amountCents: 4_500,
      currency: 'EUR',
    });

    // Деньги не ушли: расхода нет.
    expect(await listTransactions(USER)).toHaveLength(0);
    const reply = sentTexts().join('\n');
    expect(reply).toContain('Счёт добавлен в обязательства');
    expect(reply).toContain('45,00 €');
    expect(reply).toContain('2026-12-01');
  });

  it('incomplete invoice goes to inbox with the reason instead of being guessed', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      invoiceResult({ payee: 'HomeNet', amountCents: 45_00, currency: 'EUR', dueDate: null }),
    );

    await handleUpdate(photoMessage());

    expect(await listLiabilities(USER)).toHaveLength(0);
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.rawText).toContain('HomeNet');
    // Причина, а не догадка за владельца.
    expect(sentTexts().join('\n')).toContain('Счёт не разобран');
  });

  it('a zero-amount invoice is explained, not silently treated as incomplete', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      invoiceResult({ payee: 'HomeNet', amountCents: 0, currency: 'EUR', dueDate: '2026-12-01' }),
    );

    await handleUpdate(photoMessage());

    // Ноль в книгу не попадает: ни обязательства, ни расхода.
    expect(await listLiabilities(USER)).toHaveLength(0);
    expect(await listTransactions(USER)).toHaveLength(0);

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);

    // Причина названа: «сумма 0», а не общее «не разобран».
    const reply = sentTexts().join('\n');
    expect(reply).toContain('Сумма 0 — счёт не записан');
    expect(reply).not.toContain('Счёт не разобран');
  });

  it('the same invoice file is not recorded twice', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(BYTES_A);
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      invoiceResult({
        payee: 'HomeNet',
        amountCents: 45_00,
        currency: 'EUR',
        dueDate: '2026-12-01',
      }),
    );

    await handleUpdate(photoMessage());
    resetApi();
    await handleUpdate(photoMessage({ message_id: 802 }));

    expect(await listLiabilities(USER)).toHaveLength(1);
    expect(sentTexts().join('\n')).toContain(INVOICE_DUPLICATE_TEXT);
  });
});
