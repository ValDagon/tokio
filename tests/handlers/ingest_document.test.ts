/**
 * Документ из чата — это не «файл вообще», а два разных пути.
 *
 * Контракт, который проверяется снаружи (база + чат):
 *  1. картинка, присланная документом, идёт тем же путём, что фото: скриншот
 *     банка обновляет остаток счёта, а не ложится заметкой;
 *  2. файл, который декодировать нечем (PDF, архивы), сохраняется в инбокс с
 *     причиной — молча терять вложение нельзя;
 *  3. документ неавторизованного отправителя не доходит до обработчика: файл не
 *     скачивается и vision не вызывается вовсе (fail-closed).
 *
 * Vision подменён спаем на модуле, движок агента — мок, Bot API — мок платформы.
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
import { ensureAccounts, listAccounts, listTransactions } from '../../src/lib/dal/finances';
import { listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import type { VisionBalance, VisionResult } from '../../src/lib/vision';
import * as visionModule from '../../src/lib/vision';
import handleUpdate, { type Message } from '../../src/handlers/message';

const USER = 424260;
const CHAT = 424260;
const DOC_FILE_ID = 'DOCUMENT-FILE-ID';

const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

function documentMessage(
  document: NonNullable<Message['document']>,
  extra: Partial<Message> = {},
): Message {
  return {
    message_id: 801,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Test' },
    date: 1_763_000_000,
    document,
    ...extra,
  };
}

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

describe('документ-картинка идёт фото-путём', () => {
  it('image document goes through the photo pipeline and updates the balance', async () => {
    await ensureAccounts(USER, [
      { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 0 },
    ]);

    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([7, 8, 9]));
    (api as any).getFileContent = getFileContent;
    const analyze = vi
      .spyOn(visionModule, 'analyzeImageContent')
      .mockResolvedValue(balanceResult([snapshot()]));

    await handleUpdate(
      documentMessage({
        file_id: DOC_FILE_ID,
        file_name: 'statement.png',
        mime_type: 'image/png',
        file_size: 12_345,
      }),
    );

    expect(getFileContent).toHaveBeenCalledWith(DOC_FILE_ID);
    expect(analyze).toHaveBeenCalledTimes(1);

    const [account] = await listAccounts(USER);
    expect(account?.currentBalanceCents).toBe(391_729);

    expect(sentTexts().join('\n')).toContain('Баланс AlphaBank *1234 обновлён');
    // Остаток — состояние счёта, а не заметка и не транзакция: в журнал не
    // пишется, но след записи (сумма, счёт, момент наблюдения) остаётся.
    expect(await listTransactions(USER)).toHaveLength(0);
    const notes = await listNotes(USER);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.metadata).toMatchObject({ category: 'balance' });
  });
});

describe('неподдерживаемый документ не теряется', () => {
  it('unsupported document is preserved in the inbox instead of being dropped', async () => {
    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (api as any).getFileContent = getFileContent;
    const analyze = vi.spyOn(visionModule, 'analyzeImageContent');

    await handleUpdate(
      documentMessage(
        {
          file_id: DOC_FILE_ID,
          file_name: 'statement.pdf',
          mime_type: 'application/pdf',
          file_size: 88_000,
        },
        { caption: 'счёт за ноябрь' },
      ),
    );

    // Нераспознаваемый файл не отправляется в vision: модель увидела бы мусор.
    expect(getFileContent).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    const [note] = notes;
    expect(note?.sourceType).toBe('document');
    expect(note?.fileId).toBe(DOC_FILE_ID);
    expect(note?.sourceMessageId).toBe(801);
    expect(note?.rawText).toContain('statement.pdf');
    expect(note?.rawText).toContain('счёт за ноябрь');
    expect(note?.metadata).toMatchObject({
      kind: 'document_unsupported',
      mime_type: 'application/pdf',
      file_name: 'statement.pdf',
      caption: 'счёт за ноябрь',
    });

    expect(sentTexts().join('\n')).toContain('Документ сохранён в инбокс');
    expect(await listTransactions(USER)).toHaveLength(0);
  });
});

describe('чужой документ не доходит до обработчика', () => {
  it("unauthorized sender's document never reaches the handler", async () => {
    const STRANGER = 999222444;

    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (api as any).getFileContent = getFileContent;
    const analyze = vi.spyOn(visionModule, 'analyzeImageContent');

    await handleUpdate({
      message_id: 802,
      chat: { id: STRANGER, type: 'private' },
      from: { id: STRANGER, first_name: 'Stranger' },
      date: 1_763_000_000,
      caption: 'баланс',
      document: {
        file_id: DOC_FILE_ID,
        file_name: 'statement.png',
        mime_type: 'image/png',
        file_size: 12_345,
      },
    });

    // Fail-closed: ни скачивания, ни распознавания, ни заметки.
    expect(getFileContent).not.toHaveBeenCalled();
    expect(callsOf('getFileContent')).toHaveLength(0);
    expect(analyze).not.toHaveBeenCalled();
    expect(await listNotes(STRANGER)).toHaveLength(0);
    expect(await listAccounts(STRANGER)).toHaveLength(0);
    expect(sentTexts().join('\n')).toContain('Доступ закрыт');
  });
});
