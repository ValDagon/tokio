/**
 * MU-1 — голос переживает отказ и повторяется кнопкой
 * (`.scratch/major-update/issues/01-voice-recovery.md`).
 *
 * Контракт, который проверяется снаружи (база + чат):
 *  1. каждый из трёх отказов (файл не скачался, пустые байты, пустая
 *     расшифровка) оставляет ровно одну активную `raw`-заметку с `file_id`,
 *     `source_message_id` и нормализованной причиной;
 *  2. рядом с сообщением о сбое есть кнопка `retry_voice:<noteId>`;
 *  3. повтор берёт сохранённый `file_id`, а новая неудача обновляет ту же
 *     заметку (без второй);
 *  4. успешный повтор сохраняет результат и убирает заглушку в корзину;
 *  5. чужой `noteId` не запускает обработку и не раскрывает содержимое.
 *
 * Движок агента подменён (мок с сохранением остальных экспортов), STT —
 * спай на модуле, Bot API — мок платформы.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { createNote, getNote, listNotes } from '../../src/lib/dal/notes';
import { ensureUser } from '../../src/lib/dal/users';
import type { NoteRow } from '../../src/lib/types';
import { listFailureAggregates } from '../../src/lib/evolution';
import * as sttModule from '../../src/lib/stt';
import handleUpdate, { type CallbackQuery, type Message } from '../../src/handlers/message';

const USER = 424242;
const CHAT = 424242;
const VOICE_FILE_ID = 'VOICE-FILE-MU1';

/** Агент промолчал: успешный повтор должен лечь в инбокс заметкой. */
const SILENT_RUN = {
  reply: '',
  mode: 'auto',
  steps: [],
  stopReason: 'empty_reply',
  thread: [],
};

const TRANSCRIPT = 'купить лампу для кухни и абажур';

function voiceMessage(extra: Partial<Message> = {}): Message {
  return {
    message_id: 501,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Test' },
    date: 0,
    voice: { file_id: VOICE_FILE_ID, duration: 7 },
    ...extra,
  };
}

function callback(data: string, fromId = USER): CallbackQuery {
  return {
    id: 'cb-voice-1',
    from: { id: fromId, first_name: 'Test' },
    data,
    message: {
      message_id: 501,
      chat: { id: CHAT },
      text: '⚠️ Не удалось скачать голосовое сообщение.',
    },
  };
}

/** Сохранённая причина отказа: единственный контракт для повтора и журнала. */
function recoveryOf(note: NoteRow): Record<string, unknown> {
  const meta = note.metadata as Record<string, unknown>;
  return (meta?.voice_recovery ?? {}) as Record<string, unknown>;
}

/** Кнопка повтора из последнего ответа бота (или `null`, если её нет). */
function retryButton(): { text: string; callback_data: string } | null {
  for (const call of callsOf('sendMessage').slice().reverse()) {
    const markup = call.params.reply_markup as
      | { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    const button = markup?.inline_keyboard?.[0]?.[0];
    if (button && button.callback_data.startsWith('retry_voice:')) return button;
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

describe('MU-1 — отказ голоса сохраняет входящее', () => {
  it('файл не скачался: raw-заметка с file_id, причиной и кнопкой повтора', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

    await handleUpdate(voiceMessage());

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);

    const [note] = notes;
    expect(note.sourceType).toBe('voice');
    expect(note.fileId).toBe(VOICE_FILE_ID);
    expect(note.sourceMessageId).toBe(501);
    expect(recoveryOf(note)).toMatchObject({
      kind: 'voice_recovery',
      reason: 'download',
      file_id: VOICE_FILE_ID,
      attempts: 1,
    });

    expect(retryButton()?.callback_data).toBe(`retry_voice:${note.id}`);
  });

  it('пустые байты: raw-заметка с причиной empty_bytes, а не молчание', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array());

    await handleUpdate(voiceMessage());

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].fileId).toBe(VOICE_FILE_ID);
    expect(recoveryOf(notes[0])).toMatchObject({ reason: 'empty_bytes', attempts: 1 });
    expect(retryButton()?.callback_data).toBe(`retry_voice:${notes[0].id}`);
  });

  it('пустая расшифровка: аудио сохраняется с причиной empty_transcript', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({ text: '   \n ' } as any);

    await handleUpdate(voiceMessage());

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].fileId).toBe(VOICE_FILE_ID);
    expect(recoveryOf(notes[0])).toMatchObject({ reason: 'empty_transcript', attempts: 1 });
    expect(retryButton()?.callback_data).toBe(`retry_voice:${notes[0].id}`);
  });
});

describe('MU-1 — повтор кнопкой', () => {
  it('новая неудача обновляет ту же заметку и не создаёт вторую', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
    await handleUpdate(voiceMessage());

    const [first] = await listNotes(USER, { column: 'raw' });
    expect(first).toBeDefined();

    // Второе касание: повтор снова не скачался.
    resetApi();
    const getFileContent = vi.fn().mockRejectedValue(new Error('still down'));
    (api as any).getFileContent = getFileContent;
    await handleUpdate(callback(`retry_voice:${first.id}`));

    expect(getFileContent).toHaveBeenCalledWith(VOICE_FILE_ID);

    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(first.id);
    expect(recoveryOf(notes[0])).toMatchObject({ reason: 'download', attempts: 2 });
    expect(retryButton()?.callback_data).toBe(`retry_voice:${first.id}`);
  });

  it('успешный повтор сохраняет расшифровку и убирает заглушку в корзину', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
    await handleUpdate(voiceMessage());

    const [stub] = await listNotes(USER, { column: 'raw' });
    expect(stub).toBeDefined();

    // Второе касание: файл скачался, речь распознана.
    resetApi();
    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    (api as any).getFileContent = getFileContent;
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({
      text: TRANSCRIPT,
      model: 'gemini-2.5-flash',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as any);

    await handleUpdate(callback(`retry_voice:${stub.id}`));

    expect(getFileContent).toHaveBeenCalledWith(VOICE_FILE_ID);

    // Результат сохранён: расшифровка есть в активной заметке.
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].id).not.toBe(stub.id);
    expect(notes[0].rawText).toContain(TRANSCRIPT);

    // Заглушка ушла в корзину (soft delete), а не исчезла бесследно.
    expect(await getNote(USER, stub.id)).toBeNull();
    const trashed = await getNote(USER, stub.id, { includeDeleted: true });
    expect(trashed?.deletedAt).toBeTruthy();
    expect(sentTexts().join('\n')).toContain(TRANSCRIPT);
  });

  it('двойное нажатие не запускает распознавание дважды', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
    await handleUpdate(voiceMessage());

    const [stub] = await listNotes(USER, { column: 'raw' });
    expect(stub).toBeDefined();

    // Первый повтор «завис» на скачивании: метка захвата уже стоит.
    let releaseDownload: (bytes: Uint8Array) => void = () => {};
    const download = new Promise<Uint8Array>((resolve) => {
      releaseDownload = resolve;
    });
    const getFileContent = vi.fn().mockReturnValue(download);
    (api as any).getFileContent = getFileContent;
    const transcribe = vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({
      text: TRANSCRIPT,
      model: 'gemini-2.5-flash',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as any);

    const first = handleUpdate(callback(`retry_voice:${stub.id}`));
    await vi.waitFor(() => expect(getFileContent).toHaveBeenCalled());

    // Второе нажатие той же кнопки, пока первый повтор ещё идёт.
    await handleUpdate(callback(`retry_voice:${stub.id}`));

    expect(String(callsOf('answerCallbackQuery').at(-1)?.params.text)).toContain('Уже обрабатываю');
    expect(getFileContent).toHaveBeenCalledTimes(1);

    releaseDownload(new Uint8Array([1, 2, 3]));
    await first;

    // Распознавание прошло ровно один раз, результат — один.
    expect(transcribe).toHaveBeenCalledTimes(1);
    const notes = await listNotes(USER, { column: 'raw' });
    expect(notes).toHaveLength(1);
    expect(notes[0].rawText).toContain(TRANSCRIPT);
  });
});

describe('MU-1 — чужой noteId не запускает обработку', () => {
  it('callback с чужой заметкой отказывает и не раскрывает содержимое', async () => {
    const STRANGER = 999111222;
    await ensureUser(STRANGER, 'Stranger');

    const foreign = await createNote(STRANGER, '🎙 Голосовое: не расшифровано', {
      column: 'raw',
      sourceType: 'voice',
      fileId: 'FOREIGN-FILE-ID',
      sourceMessageId: 777,
      metadata: {
        voice_recovery: {
          kind: 'voice_recovery',
          reason: 'download',
          file_id: 'FOREIGN-FILE-ID',
          attempts: 1,
        },
      },
    });

    resetApi();
    const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9]));
    (api as any).getFileContent = getFileContent;

    await handleUpdate(callback(`retry_voice:${foreign.id}`));

    // Обработка не запускалась: файл даже не запрашивался.
    expect(getFileContent).not.toHaveBeenCalled();
    expect(callsOf('getFileContent')).toHaveLength(0);

    // Отказ виден пользователю алертом.
    const answers = callsOf('answerCallbackQuery');
    expect(answers[0]?.params.show_alert).toBe(true);

    // Содержимое чужой заметки не раскрыто ни в одном сообщении.
    expect(sentTexts().join('\n')).not.toContain('не расшифровано');

    // Чужая заметка не тронута.
    const stillThere = await getNote(STRANGER, foreign.id);
    expect(stillThere?.deletedAt).toBeNull();
    expect(await listNotes(STRANGER, { column: 'raw' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MU-3B — отказ голоса оставляет нормализованную сигнатуру в журнале
// ---------------------------------------------------------------------------

describe('MU-3B — сигнатура отказа голоса', () => {
  it('файл не скачался: один кластер download_failed, а не текст ошибки', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

    await handleUpdate(voiceMessage());

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates.map((item) => [item.signature, item.count])).toEqual([
      ['ingest|voice|download_failed|-', 1],
    ]);
    // Текст ошибки живёт в detail одного кластера, а не в его имени.
    expect(aggregates[0]?.detail).toBe('network down');

    // Входящее при этом всё равно сохранено: журнал не заменяет recovery.
    expect(await listNotes(USER, { column: 'raw' })).toHaveLength(1);
  });

  it('пустые байты — отдельный кластер empty_bytes', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array());

    await handleUpdate(voiceMessage());

    expect((await listFailureAggregates(USER)).map((item) => item.signature)).toEqual([
      'ingest|voice|empty_bytes|-',
    ]);
  });

  it('упавший STT и пустая расшифровка — разные кластеры', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue(null);

    await handleUpdate(voiceMessage({ message_id: 601 }));
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({ text: '   ' } as any);
    await handleUpdate(voiceMessage({ message_id: 602 }));

    const bySignature = new Map(
      (await listFailureAggregates(USER)).map((item) => [item.signature, item.count]),
    );
    expect(bySignature.get('ingest|voice|transcription_failed|-')).toBe(1);
    expect(bySignature.get('ingest|voice|empty_transcription|-')).toBe(1);
  });

  it('повторный отказ того же класса увеличивает тот же счётчик', async () => {
    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('still down'));
    await handleUpdate(voiceMessage({ message_id: 611 }));
    const [stub] = await listNotes(USER, { column: 'raw' });

    (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('down again'));
    await handleUpdate(callback(`retry_voice:${stub.id}`));

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({
      signature: 'ingest|voice|download_failed|-',
      count: 2,
    });
  });

  it('успешный повтор снимает recovery ровно с того кластера', async () => {
    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue(null);
    await handleUpdate(voiceMessage({ message_id: 621 }));

    const [stub] = await listNotes(USER, { column: 'raw' });
    expect((await listFailureAggregates(USER))[0]?.recoveredAt).toBeNull();

    (api as any).getFileContent = vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6]));
    vi.spyOn(sttModule, 'tryTranscribe').mockResolvedValue({ text: TRANSCRIPT } as any);
    await handleUpdate(callback(`retry_voice:${stub.id}`));

    const aggregates = await listFailureAggregates(USER);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.signature).toBe('ingest|voice|transcription_failed|-');
    expect(aggregates[0]?.count).toBe(1);
    expect(aggregates[0]?.recoveredAt).toBeTruthy();
  });
});
