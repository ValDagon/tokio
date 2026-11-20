/**
 * MU-2 — фото и чек сохраняют сырьё и честный результат
 * (`.scratch/major-update/issues/02-photo-receipt-recovery.md`).
 *
 * Контракт, который проверяется снаружи (база + чат):
 *  1. отказ скачивания оставляет одну `raw`-заметку с `file_id`, подписью,
 *     `source_message_id` и нормализованной причиной;
 *  2. `isFallback` и `errors` распознавания видны в metadata заметки и в
 *     ответе пользователю, а не только в консоли;
 *  3. повтор берёт сохранённый `file_id`, а новая неудача обновляет ту же
 *     заметку;
 *  4. повтор — это **только распознавание**: подпись «потратил 100 eur» не
 *     проводится второй раз, даже если чек распознан заново;
 *  5. неопределённый сбой проведения чека проговаривается, распознанная сумма
 *     остаётся в metadata, а кнопки повтора нет — второй чек не оплачивается
 *     автоматически;
 *  6. чужой `noteId` не запускает обработку и не раскрывает содержимое.
 *
 * Движок агента подменён (мок с сохранением остальных экспортов), Vision —
 * спай на модуле, Bot API — мок платформы.
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

import { api, callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { ensureAccounts, listTransactions } from '../../src/lib/dal/finances';
import { createNote, getNote, listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import * as financialParser from '../../src/lib/financial-parser';
import type { NoteRow } from '../../src/lib/types';
import { listFailureAggregates } from '../../src/lib/evolution';
import { buildVisionFallback, type VisionResult } from '../../src/lib/vision';
import * as visionModule from '../../src/lib/vision';
import handleUpdate, { type CallbackQuery, type Message } from '../../src/handlers/message';

const USER = 424244;
const CHAT = 424244;
const PHOTO_FILE_ID = 'PHOTO-FILE-MU2';
const CAPTION = 'чек из супермаркета на кухню';

const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

const PHOTO = [{ file_id: PHOTO_FILE_ID, width: 800, height: 600 }];

/** Распознанный чек: сумма 42,75 — подмена на 4275/100 даёт различимый результат. */
const RECEIPT_RESULT: VisionResult = {
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
};

function photoMessage(extra: Partial<Message> = {}): Message {
  return {
    message_id: 601,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Test' },
    date: 0,
    photo: PHOTO,
    caption: CAPTION,
    ...extra,
  };
}

function callback(data: string, fromId = USER): CallbackQuery {
  return {
    id: 'cb-photo-1',
    from: { id: fromId, first_name: 'Test' },
    data,
    message: {
      message_id: 601,
      chat: { id: CHAT },
      text: '⚠️ Не удалось загрузить фото.',
    },
  };
}

/** Сохранённая причина отказа: единственный контракт для повтора и журнала. */
function recoveryOf(note: NoteRow): Record<string, unknown> {
  const meta = note.metadata as Record<string, unknown>;
  return (meta?.photo_recovery ?? {}) as Record<string, unknown>;
}

/** Кнопка повтора из последнего ответа бота (или `null`, если её нет). */
function retryButton(): { text: string; callback_data: string } | null {
  for (const call of callsOf('sendMessage').slice().reverse()) {
    const markup = call.params.reply_markup as
      | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
      | undefined;
    for (const row of markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data?.startsWith('retry_photo:')) {
          return { text: button.text, callback_data: button.callback_data };
        }
      }
    }
  }
  return null;
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

  await ensureUser(USER, 'Test User');
});

afterEach(() => {
  // Сброс подмены Bot API: свойство живёт на моке между тестами файла.
  delete (api as any).getFileContent;
});

describe('MU-2 — отказ скачивания сохраняет сырьё', () => {
  it('фото не скачалось: raw-заметка с file_id, caption и source_message_id', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

    await handleUpdate(photoMessage());

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);

    const [note] = notes;
    expect(note.sourceType).toBe('photo');
    expect(note.fileId).toBe(PHOTO_FILE_ID);
    expect(note.sourceMessageId).toBe(601);
    expect((note.metadata as Record<string, unknown>).caption).toBe(CAPTION);
    expect(recoveryOf(note)).toMatchObject({
      kind: 'photo_recovery',
      reason: 'download',
      file_id: PHOTO_FILE_ID,
      caption: CAPTION,
      source_message_id: 601,
      attempts: 1,
    });

    expect(sentTexts().join('\n')).toContain('Не удалось загрузить фото');
    expect(retryButton()?.callback_data).toBe(`retry_photo:${note.id}`);
  });

  it('фото без подписи тоже оставляет file_id и причину', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

    await handleUpdate(photoMessage({ caption: undefined }));

    const [note] = await listNotes(USER, { column: 'raw' });
    expect(note.fileId).toBe(PHOTO_FILE_ID);
    expect(recoveryOf(note)).toMatchObject({ reason: 'download', attempts: 1 });
    expect(retryButton()?.callback_data).toBe(`retry_photo:${note.id}`);
  });
});

describe('MU-2 — отказ распознавания проговаривается', () => {
  it('isFallback и errors попадают в metadata и в ответ, повтор предлагается', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      buildVisionFallback(CAPTION, ['vision: all models failed']),
    );

    await handleUpdate(photoMessage());

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    const [note] = notes;

    expect(note.metadata).toMatchObject({
      isFallback: true,
      errors: ['vision: all models failed'],
      caption: CAPTION,
    });
    expect(recoveryOf(note)).toMatchObject({
      reason: 'vision',
      file_id: PHOTO_FILE_ID,
      caption: CAPTION,
      attempts: 1,
    });

    const answer = sentTexts().join('\n');
    expect(answer).toContain('Не удалось распознать');
    expect(answer).toContain('all models failed');
    expect(answer).toContain(CAPTION);
    expect(retryButton()?.callback_data).toBe(`retry_photo:${note.id}`);
  });
});

describe('MU-2 — повтор кнопкой', () => {
  it('новая неудача обновляет ту же заметку и не создаёт вторую', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
    await handleUpdate(photoMessage());

    const [first] = await listNotes(USER, { column: 'raw' });
    expect(first).toBeDefined();

    resetApi();
    const getFileContent = vi.fn().mockRejectedValue(new Error('still down'));
    (api as any).getFileContent = getFileContent;
    await handleUpdate(callback(`retry_photo:${first.id}`));

    expect(getFileContent).toHaveBeenCalledWith(PHOTO_FILE_ID);

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(first.id);
    expect(recoveryOf(notes[0])).toMatchObject({ reason: 'download', attempts: 2 });
    expect((notes[0].metadata as Record<string, unknown>).caption).toBe(CAPTION);
    expect(retryButton()?.callback_data).toBe(`retry_photo:${first.id}`);
  });

  it('повтор только распознаёт: деньги из подписи не проводятся второй раз', async () => {
    await ensureAccounts(USER, [
      { name: 'Main Bank', currency: 'EUR', initialBalanceCents: 50_000 },
    ]);
    const moneyCaption = 'потратил 100 eur с Main Bank';

    const stub = await createNote(USER, '📸 Фото: не распознано — файл не скачался', {
      column: 'raw',
      sourceType: 'photo',
      fileId: PHOTO_FILE_ID,
      sourceMessageId: 601,
      metadata: {
        caption: moneyCaption,
        photo_recovery: {
          kind: 'photo_recovery',
          reason: 'download',
          file_id: PHOTO_FILE_ID,
          caption: moneyCaption,
          source_message_id: 601,
          attempts: 1,
        },
      },
    });

    resetApi();
    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (api as any).getFileContent = getFileContent;
    const analyze = vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(RECEIPT_RESULT);
    const execute = vi.spyOn(financialParser, 'executeFinancialIntent');

    await handleUpdate(callback(`retry_photo:${stub.id}`));

    expect(getFileContent).toHaveBeenCalledWith(PHOTO_FILE_ID);
    expect(analyze).toHaveBeenCalledTimes(1);

    // Главное: повтор не проводит ни подпись, ни распознанный чек.
    expect(execute).not.toHaveBeenCalled();
    expect(await listTransactions(USER)).toHaveLength(0);
    const answer = sentTexts().join('\n');
    expect(answer).not.toContain('Расход зафиксирован');
    expect(answer).toMatch(/не провед/i);

    // Результат сохранён, заглушка ушла в корзину (soft delete).
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].id).not.toBe(stub.id);
    expect(notes[0].rawText).toContain('Edeka');
    expect(await getNote(USER, stub.id)).toBeNull();
    const trashed = await getNote(USER, stub.id, { includeDeleted: true });
    expect(trashed?.deletedAt).toBeTruthy();
  });

  it('двойное нажатие не распознаёт фото дважды', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
    await handleUpdate(photoMessage());

    const [stub] = await listNotes(USER, { column: 'raw' });
    expect(stub).toBeDefined();

    let releaseDownload: (bytes: Uint8Array) => void = () => {};
    const download = new Promise<Uint8Array>((resolve) => {
      releaseDownload = resolve;
    });
    const getFileContent = vi.fn().mockReturnValue(download);
    (api as any).getFileContent = getFileContent;
    const analyze = vi
      .spyOn(visionModule, 'analyzeImageContent')
      .mockResolvedValue({ ...buildVisionFallback(), isFallback: false, summary: 'Скриншот' });

    const first = handleUpdate(callback(`retry_photo:${stub.id}`));
    await vi.waitFor(() => expect(getFileContent).toHaveBeenCalled());

    await handleUpdate(callback(`retry_photo:${stub.id}`));
    expect(String(callsOf('answerCallbackQuery').at(-1)?.params.text)).toContain('Уже обрабатываю');
    expect(getFileContent).toHaveBeenCalledTimes(1);

    releaseDownload(new Uint8Array([1, 2, 3]));
    await first;

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);
  });
});

describe('MU-2 — неопределённый сбой проведения чека', () => {
  it('проговаривает отказ, сохраняет сумму в metadata и не даёт кнопки повтора', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(RECEIPT_RESULT);
    vi.spyOn(financialParser, 'executeFinancialIntent').mockRejectedValue(
      new Error('db timeout после записи'),
    );

    await handleUpdate(photoMessage());

    const answer = sentTexts().join('\n');
    expect(answer).toMatch(/42[,.]75/);
    expect(answer).toContain('EUR');
    expect(answer).not.toContain('Расход зафиксирован');
    expect(answer).toMatch(/не провед|не удалось/i);

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].metadata).toMatchObject({
      receipt_failure: { total: 42.75, currency: 'EUR', merchant: 'Edeka' },
    });
    expect(notes[0].rawText).toContain('Edeka');

    // Стадия уже после возможной финансовой записи — повтора нет.
    expect(retryButton()).toBeNull();
    expect(recoveryOf(notes[0])).toEqual({});
  });

  it('callback повтора на такой заметке не скачивает и не проводит заново', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(RECEIPT_RESULT);
    const execute = vi
      .spyOn(financialParser, 'executeFinancialIntent')
      .mockRejectedValueOnce(new Error('db timeout после записи'));

    await handleUpdate(photoMessage());
    const [note] = await listNotes(USER, { column: 'raw' });
    expect(note).toBeDefined();

    resetApi();
    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (api as any).getFileContent = getFileContent;
    execute.mockClear();

    await handleUpdate(callback(`retry_photo:${note.id}`));

    expect(getFileContent).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await listTransactions(USER)).toHaveLength(0);

    const answers = callsOf('answerCallbackQuery');
    expect(answers[0]?.params.show_alert).toBe(true);
    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);
  });
});

describe('MU-2 — неизвестный сбой подписи не повторяет деньги через чек', () => {
  it('проведение не повторяется: одна попытка, чек не записан, сумма названа', async () => {
    await ensureAccounts(USER, [
      { name: 'Main Bank', currency: 'EUR', initialBalanceCents: 50_000 },
    ]);
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(RECEIPT_RESULT);
    const execute = vi
      .spyOn(financialParser, 'executeFinancialIntent')
      .mockRejectedValueOnce(new Error('db timeout после записи'));

    await handleUpdate(photoMessage({ caption: 'потратил 100 eur с Main Bank' }));

    // Вторая денежная попытка не делалась: ни агент, ни распознанный чек.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(await listTransactions(USER)).toHaveLength(0);

    const answer = sentTexts().join('\n');
    expect(answer).toContain('Не удалось подтвердить запись');
    expect(answer).toMatch(/100[,.]00/);
    expect(answer).toContain('не проведён');

    // Сырьё сохранено, причина лежит в metadata, повтора нет.
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].metadata).toMatchObject({
      finance_unconfirmed: { stage: 'caption', amount: 100 },
    });
    expect(recoveryOf(notes[0])).toEqual({});
    expect(retryButton()).toBeNull();
  });
});

describe('MU-2 — чужой noteId не запускает обработку', () => {
  it('callback с чужой заметкой отказывает и не раскрывает содержимое', async () => {
    const STRANGER = 999111333;
    await ensureUser(STRANGER, 'Stranger');

    const foreign = await createNote(STRANGER, '📸 Фото: не распознано — файл не скачался', {
      column: 'raw',
      sourceType: 'photo',
      fileId: 'FOREIGN-PHOTO-ID',
      sourceMessageId: 777,
      metadata: {
        photo_recovery: {
          kind: 'photo_recovery',
          reason: 'download',
          file_id: 'FOREIGN-PHOTO-ID',
          caption: 'чужая подпись',
          source_message_id: 777,
          attempts: 1,
        },
      },
    });

    resetApi();
    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9]));
    (api as any).getFileContent = getFileContent;

    await handleUpdate(callback(`retry_photo:${foreign.id}`));

    expect(getFileContent).not.toHaveBeenCalled();
    expect(callsOf('getFileContent')).toHaveLength(0);

    const answers = callsOf('answerCallbackQuery');
    expect(answers[0]?.params.show_alert).toBe(true);
    expect(sentTexts().join('\n')).not.toContain('чужая подпись');

    const stillThere = await getNote(STRANGER, foreign.id);
    expect(stillThere?.deletedAt).toBeNull();
    expect(await listNotes(STRANGER, { column: 'raw' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MU-3B — отказ фото оставляет нормализованную сигнатуру в журнале
// ---------------------------------------------------------------------------

describe('MU-3B — сигнатура отказа фото', () => {
  it('фото не скачалось: один кластер download_failed с media photo', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

    await handleUpdate(photoMessage());

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates.map((item) => [item.signature, item.count])).toEqual([
      ['ingest|photo|download_failed|-', 1],
    ]);
    expect(aggregates[0]?.detail).toBe('network down');
    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);
  });

  it('Vision вернул fallback: кластер vision_failed, подпись не утекает в detail', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      buildVisionFallback(CAPTION, ['vision: all models failed']),
    );

    await handleUpdate(photoMessage());

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate?.signature).toBe('ingest|photo|vision_failed|-');
    expect(aggregate?.count).toBe(1);
    expect(aggregate?.detail).toBe('vision: all models failed');
    expect(aggregate?.detail).not.toContain(CAPTION);
  });

  it('повторный отказ того же класса увеличивает счётчик, а не плодит кластеры', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
    await handleUpdate(photoMessage({ message_id: 611 }));
    const [stub] = await listNotes(USER, { column: 'raw' });

    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('down again'));
    await handleUpdate(callback(`retry_photo:${stub.id}`));

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({ signature: 'ingest|photo|download_failed|-', count: 2 });
  });

  it('успешный повтор снимает recovery с кластера распознавания', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue(
      buildVisionFallback(CAPTION, ['vision: all models failed']),
    );
    await handleUpdate(photoMessage({ message_id: 621 }));
    const [stub] = await listNotes(USER, { column: 'raw' });
    expect((await listFailureAggregates(USER))[0]?.recoveredAt).toBeNull();

    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6]));
    vi.spyOn(visionModule, 'analyzeImageContent').mockResolvedValue({
      ...buildVisionFallback(CAPTION),
      isFallback: false,
      summary: 'Фото кухни',
    });
    await handleUpdate(callback(`retry_photo:${stub.id}`));

    const [aggregate] = await listFailureAggregates(USER);
    expect(aggregate?.signature).toBe('ingest|photo|vision_failed|-');
    expect(aggregate?.count).toBe(1);
    expect(aggregate?.recoveredAt).toBeTruthy();
  });
});
