import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, callsOf, db, resetApi, resetDb, sql, sqliteDDL } from '../mocks/sdk';

import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { createMedication, listLogs } from '../../src/lib/dal/medications';
import { createNote, deleteNote, getNote, listNotes } from '../../src/lib/dal/notes';
import { claimPhotoRecovery, claimVoiceRecovery } from '../../src/handlers/ingest';
import { createTask, getTask } from '../../src/lib/dal/tasks';
import { createAccount, createTransaction, getTransaction, listTransactions } from '../../src/lib/dal/finances';
import { ensureUser } from '../../src/lib/dal/users';

import handleCallbackQuery from '../../src/handlers/callback_query';
import {
  routeCallback,
  stripStatusSuffix,
  appendStatusLine,
  extractTaskTitleFromText,
  resolveTaskId,
} from '../../src/handlers/router';
import type { CallbackQuery } from '../../src/handlers/message';

const USER = 100001;
const CHAT = 100001;

function cb(data: string, extra: Partial<CallbackQuery> = {}): CallbackQuery {
  return {
    id: 'cb-test-1',
    from: { id: USER, first_name: 'Алекс' },
    data,
    message: {
      message_id: 101,
      chat: { id: CHAT },
      text: '📌 Задача: Сдать отчёт\nКатегория: #Работа',
    },
    ...extra,
  };
}

const answers = () =>
  callsOf('answerCallbackQuery').map((c) => ({
    id: c.params.callback_query_id,
    text: c.params.text,
    showAlert: c.params.show_alert,
  }));

/** Bot API 10.4: подтверждение нажатия — эфемерное сообщение, либо toast при fallback. */
const confirmed = () => {
  const eph = callsOf('sendMessage').find((c) => c.params.ephemeral_message_parameters !== undefined);
  return { text: (eph?.params.text ?? answers()[0]?.text) as string | undefined };
};

const lastEdit = () => {
  const edits = callsOf('editMessageText');
  return edits[edits.length - 1];
};

describe('Systemic Callback Buttons Visual Feedback & Execution', () => {
  beforeEach(async () => {
    resetApi();
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetConfigCache();
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
    await ensureUser(USER, 'Алекс');
  });

  afterEach(() => {
    resetConfigCache();
  });

  describe('stripStatusSuffix and appendStatusLine helpers', () => {
    it('strips retry / failure / expired / info status lines too', () => {
      for (const line of ['🔁 Повторное распознавание запущено…', '❌ Ошибка', '⌛ Устарело', 'ℹ️ Повтор недоступен.']) {
        expect(stripStatusSuffix(`Тело\n\n━━━━━━━━━━━━━━\n${line}`)).toBe('Тело');
        expect(appendStatusLine(`Тело\n\n━━━━━━━━━━━━━━\n${line}`, '✅ Готово')).toBe(
          'Тело\n\n━━━━━━━━━━━━━━\n✅ Готово',
        );
      }
    });

    it('strips existing status suffix cleanly', () => {
      const orig = '⏰ Напоминание!\n📌 Купить хлеб';
      const withStatus = `${orig}\n\n━━━━━━━━━━━━━━\n⏳ Перенесено: +1 час (до 14:00)`;
      expect(stripStatusSuffix(withStatus)).toBe(orig);

      const withSimpleStatus = `${orig}\n\n⏳ Перенесено: +1 час`;
      expect(stripStatusSuffix(withSimpleStatus)).toBe(orig);

      const withDone = `${orig}\n\n━━━━━━━━━━━━━━\n✅ Выполнено!`;
      expect(stripStatusSuffix(withDone)).toBe(orig);
    });

    it('appends status line with visual separator', () => {
      const orig = '⏰ Напоминание!\n📌 Купить хлеб';
      const res = appendStatusLine(orig, '✅ Выполнено!');
      expect(res).toBe(`${orig}\n\n━━━━━━━━━━━━━━\n✅ Выполнено!`);
    });
  });

  describe('task_snooze callbacks', () => {
    it('snoozes task for +1 day (1440 mins), updates DB, preserves text, keeps action buttons', async () => {
      const task = await createTask(USER, {
        title: 'Сдать отчёт',
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
      });

      const query = cb(`task_snooze:${task.id}:1440`, {
        message: {
          message_id: 101,
          chat: { id: CHAT },
          text: '⏰ Напоминание!\n📌 Сдать отчёт',
        },
      });

      await handleCallbackQuery(query);

      // 1. Toast answer
      const [ans] = [confirmed()];
      expect(ans?.text).toContain('⏳ Перенесено: +1 день (до ');

      // 2. Message edited: preserved original text + status
      const edit = lastEdit();
      expect(edit?.params.text).toContain('⏰ Напоминание!\n📌 Сдать отчёт');
      expect(edit?.params.text).toContain('⏳ Перенесено: +1 день (до ');

      // 3. Buttons remain active ([✅ Выполнено], [⏳ +1 час], [⏳ +1 день])
      const kb = edit?.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(kb.inline_keyboard[0][0].text).toBe('✅ Выполнено');
      expect(kb.inline_keyboard[0][0].callback_data).toBe(`task_done:${task.id}`);
      expect(kb.inline_keyboard[1][0].text).toBe('⏳ +1 час');
      expect(kb.inline_keyboard[1][1].text).toBe('⏳ +1 день');

      // 4. DB updated
      const updated = await getTask(USER, task.id);
      expect(updated?.remindAt).toBeTruthy();
    });

    it('snoozes task for +1 hour (60 mins) and re-snoozing strips previous status cleanly', async () => {
      const task = await createTask(USER, { title: 'Позвонить врачу' });

      // First snooze: +1 hour
      await handleCallbackQuery(
        cb(`task_snooze:${task.id}:60`, {
          message: {
            message_id: 102,
            chat: { id: CHAT },
            text: '⏰ Напоминание!\n📌 Позвонить врачу',
          },
        }),
      );

      let edit = lastEdit();
      expect(edit?.params.text).toContain('⏳ Перенесено: +1 час (до ');
      expect(edit?.params.text).toContain('📌 Позвонить врачу');

      // Second snooze: user clicks +1 hour again on already snoozed message
      await handleCallbackQuery(
        cb(`task_snooze:${task.id}:60`, {
          message: {
            message_id: 102,
            chat: { id: CHAT },
            text: String(edit?.params.text),
          },
        }),
      );

      edit = lastEdit();
      // Should not have duplicated separator or duplicated status lines
      const count = (String(edit?.params.text).match(/━━━━━━━━━━━━━━/g) || []).length;
      expect(count).toBe(1);
      expect(edit?.params.text).toContain('📌 Позвонить врачу');
    });

    it('handles colon-delimited task:snooze format gracefully', async () => {
      const task = await createTask(USER, { title: 'Купить молоко' });
      await handleCallbackQuery(cb(`task:snooze:${task.id}:60`));

      const [ans] = [confirmed()];
      expect(ans?.text).toContain('⏳ Перенесено: +1 час');
    });

    it('resolves UUID task reminder by extracting title from originalText and snoozes task in DB', async () => {
      const task = await createTask(USER, {
        title: 'Воскресное собрание 🧂🍞',
        dueAt: '2026-11-08T10:00:00.000Z',
      });
      const origText = '⏰ *Напоминание!*\n\n📌 *Воскресное собрание 🧂🍞*\n📁 Категория: #Хобби';
      const uuid = 'cf2a452f-2be5-4e7f-8012-2143ccd09c54';

      await handleCallbackQuery(
        cb(`task_snooze:${uuid}:1440`, {
          message: {
            message_id: 110,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      const [ans] = [confirmed()];
      expect(ans?.text).toContain('⏳ Перенесено: +1 день');

      const edit = lastEdit();
      expect(edit?.params.text).toContain('Воскресное собрание 🧂🍞');
      expect(edit?.params.text).toContain('⏳ Перенесено: +1 день');

      // Task in SQLite was updated
      const updated = await getTask(USER, task.id);
      expect(updated?.remindAt).toBeTruthy();

      // Keyboard buttons are upgraded to resolved numeric ID
      const kb = edit?.params.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(kb.inline_keyboard[0][0].callback_data).toBe(`task_done:${task.id}`);
      expect(kb.inline_keyboard[1][0].callback_data).toBe(`task_snooze:${task.id}:60`);
      expect(kb.inline_keyboard[1][1].callback_data).toBe(`task_snooze:${task.id}:1440`);
    });
  });

  describe('task_done callbacks', () => {
    it('completes task in DB, appends status and clears keyboard', async () => {
      const task = await createTask(USER, { title: 'Сделать уборку' });
      const query = cb(`task_done:${task.id}`, {
        message: {
          message_id: 103,
          chat: { id: CHAT },
          text: '⏰ Напоминание!\n📌 Сделать уборку',
        },
      });

      await handleCallbackQuery(query);

      expect(confirmed().text).toBe('✅ Задача выполнена!');
      const edit = lastEdit();
      expect(edit?.params.text).toContain('📌 Сделать уборку');
      expect(edit?.params.text).toContain('✅ Выполнено!');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });

      const updated = await getTask(USER, task.id);
      expect(updated?.status).toBe('done');
    });

    it('resolves UUID task reminder by extracting title from originalText and marks done in DB', async () => {
      const task = await createTask(USER, { title: 'Воскресное собрание 🧂🍞' });
      const origText = '⏰ *Напоминание!*\n\n📌 *Воскресное собрание 🧂🍞*\n📁 Категория: #Хобби';
      const uuid = 'cf2a452f-2be5-4e7f-8012-2143ccd09c54';

      await handleCallbackQuery(
        cb(`task_done:${uuid}`, {
          message: {
            message_id: 111,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      expect(confirmed().text).toBe('✅ Задача выполнена!');
      const edit = lastEdit();
      expect(edit?.params.text).toContain('Воскресное собрание 🧂🍞');
      expect(edit?.params.text).toContain('✅ Выполнено!');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });

      const updated = await getTask(USER, task.id);
      expect(updated?.status).toBe('done');
    });

    it('extractTaskTitleFromText parses titles correctly across various formats', () => {
      expect(
        extractTaskTitleFromText(
          '⏰ *Напоминание!*\n\n📌 *Воскресное собрание 🧂🍞*\n📁 Категория: #Хобби',
        ),
      ).toBe('Воскресное собрание 🧂🍞');
      expect(extractTaskTitleFromText('📌 Воскресное собрание')).toBe('Воскресное собрание');
      expect(extractTaskTitleFromText('⏰ Напоминание!\n📌 Купить хлеб')).toBe('Купить хлеб');
      expect(extractTaskTitleFromText('Без булавки')).toBeNull();
    });
  });

  describe('medication callbacks', () => {
    it('marks medication taken with both med_take and med:take', async () => {
      const med = await createMedication(USER, {
        name: 'Витамин D3',
        dosage: '2000 IU',
        times: ['09:00'],
      });

      // 1. colon format med:take
      await handleCallbackQuery(
        cb(`med:take:${med.id}:09:00`, {
          message: {
            message_id: 201,
            chat: { id: CHAT },
            text: '💊 Напоминание: Витамин D3 (2000 IU)',
          },
        }),
      );

      expect(confirmed().text).toBe('💊 Приём отмечен');
      let edit = lastEdit();
      expect(edit?.params.text).toContain('Витамин D3');
      expect(edit?.params.text).toContain('✅ Приём отмечен (09:00)');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });

      const logs = await listLogs(USER);
      expect(logs.some((l) => l.status === 'taken')).toBe(true);

      // 2. underscore format med_take
      resetApi();
      await handleCallbackQuery(
        cb(`med_take:${med.id}:09:00`, {
          message: {
            message_id: 202,
            chat: { id: CHAT },
            text: '💊 Напоминание: Витамин D3 (2000 IU)',
          },
        }),
      );
      expect(confirmed().text).toBe('💊 Приём отмечен');
    });

    it('marks medication skipped with med:skip and med_skip', async () => {
      const med = await createMedication(USER, {
        name: 'Магний',
        dosage: '400 мг',
        times: ['21:00'],
      });

      await handleCallbackQuery(
        cb(`med:skip:${med.id}:21:00`, {
          message: {
            message_id: 203,
            chat: { id: CHAT },
            text: '💊 Напоминание: Магний (400 мг)',
          },
        }),
      );

      expect(confirmed().text).toBe('⏭️ Приём пропущен');
      const edit = lastEdit();
      expect(edit?.params.text).toContain('Магний');
      expect(edit?.params.text).toContain('⏭️ Приём пропущен (21:00)');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('postpones medication for 15 mins, updates message and keeps take/skip buttons', async () => {
      const med = await createMedication(USER, {
        name: 'Омега-3',
        dosage: '1000 мг',
        times: ['12:00'],
      });

      await handleCallbackQuery(
        cb(`med:postpone:${med.id}:12:00`, {
          message: {
            message_id: 204,
            chat: { id: CHAT },
            text: '💊 Напоминание: Омега-3 (1000 мг)',
          },
        }),
      );

      expect(confirmed().text).toBe('⏳ Отложено на 15 мин');
      expect(answers()[0]?.showAlert).toBeFalsy();

      const edit = lastEdit();
      expect(edit?.params.text).toContain('Омега-3');
      expect(edit?.params.text).toContain('⏳ Отложено на 15 мин (до ');

      const kb = edit?.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(kb.inline_keyboard[0][0].text).toBe('✅ Принял');
      expect(kb.inline_keyboard[0][0].callback_data).toBe(`med:take:${med.id}:12:00`);
      expect(kb.inline_keyboard[0][1].text).toBe('⏭ Пропустить');
      expect(kb.inline_keyboard[0][1].callback_data).toBe(`med:skip:${med.id}:12:00`);
    });
  });

  describe('undo callbacks preserving original text', () => {
    it('undo transaction preserves original transaction text', async () => {
      const acc = await createAccount(USER, { name: 'Cash', currency: 'EUR', initialBalanceCents: 10_000 });
      const tx = await createTransaction(USER, {
        kind: 'expense',
        accountId: acc.id,
        amountCents: 2550,
        currency: 'EUR',
        description: 'Обед в кафе',
      });

      const origText = '💸 Расход зафиксирован:\n• Обед в кафе: 25.50 EUR';
      await handleCallbackQuery(
        cb(`undo_tx:${tx.id}`, {
          message: {
            message_id: 301,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      expect(answers()[0]?.text).toBe('🗑️ Запись отменена');
      const edit = lastEdit();
      expect(edit?.params.text).toContain(origText);
      expect(edit?.params.text).toContain('🗑️ Запись отменена и удалена.');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('undo note preserves original note text', async () => {
      const note = await createNote(USER, 'Идея для проекта Tokyo');
      const origText = '📦 Сохранено в инбокс:\n📝 Идея для проекта Tokyo';

      await handleCallbackQuery(
        cb(`undo_note:${note.id}`, {
          message: {
            message_id: 302,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      expect(confirmed().text).toBe('🗑️ Заметка удалена');
      const edit = lastEdit();
      expect(edit?.params.text).toContain(origText);
      expect(edit?.params.text).toContain('🗑️ Заметка отменена и удалена.');
    });

    it('undo task preserves original task text', async () => {
      const task = await createTask(USER, { title: 'Сдать налоговую декларацию' });
      const origText = '🎯 Создана задача:\n• Сдать налоговую декларацию';

      await handleCallbackQuery(
        cb(`undo_task:${task.id}`, {
          message: {
            message_id: 303,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      expect(confirmed().text).toBe('🗑️ Задача удалена');
      const edit = lastEdit();
      expect(edit?.params.text).toContain(origText);
      expect(edit?.params.text).toContain('🗑️ Задача отменена и удалена.');
    });
  });

  describe('inbox triage callbacks', () => {
    it('inbox_to_task converts note to task, archives note, preserves text and offers undo button', async () => {
      const note = await createNote(USER, 'Купить подарок маме');
      const origText = '📥 Инбокс:\nКупить подарок маме';

      await handleCallbackQuery(
        cb(`inbox_to_task:${note.id}`, {
          message: {
            message_id: 401,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      expect(confirmed().text).toBe('🎯 Создана задача');
      const edit = lastEdit();
      expect(edit?.params.text).toContain(origText);
      expect(edit?.params.text).toContain('🎯 Превращено в задачу #');

      // Note is deleted
      const updatedNote = await getNote(USER, note.id);
      expect(updatedNote).toBeNull();

      // Undo button is available
      const kb = edit?.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(kb.inline_keyboard[0][0].text).toBe('🗑️ Отменить');
      expect(kb.inline_keyboard[0][0].callback_data).toContain('undo_task:');
    });

    it('inbox_to_inbox keeps note in inbox and clears buttons', async () => {
      const origText = '📥 Заметка для инбокса';
      await handleCallbackQuery(
        cb('inbox_to_inbox:99', {
          message: {
            message_id: 402,
            chat: { id: CHAT },
            text: origText,
          },
        }),
      );

      expect(confirmed().text).toBe('📥 Сохранено во входящих');
      const edit = lastEdit();
      expect(edit?.params.text).toContain(origText);
      expect(edit?.params.text).toContain('📥 Оставлено во входящих');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });
  });

  describe('dashboard callbacks', () => {
    it('dash_done completes task and answers with confirmation', async () => {
      const task = await createTask(USER, { title: 'Быстрая задача' });
      await handleCallbackQuery(
        cb(`dash_done:status:${task.id}`, {
          message: {
            message_id: 501,
            chat: { id: CHAT },
            text: '📊 Дашборд',
          },
        }),
      );

      expect(confirmed().text).toBe('✅ Задача выполнена!');
      const updated = await getTask(USER, task.id);
      expect(updated?.status).toBe('done');
    });

    it('nav switches dashboard tab', async () => {
      await handleCallbackQuery(
        cb('nav:balance', {
          message: {
            message_id: 502,
            chat: { id: CHAT },
            text: '📊 Дашборд',
          },
        }),
      );

      const edit = lastEdit();
      expect(edit?.params.message_id).toBe(502);
      expect(edit?.params.text).toBeTruthy();
    });
  });

  describe('Access control fail-closed', () => {
    it('rejects stranger user without executing callback or mutating database', async () => {
      const STRANGER = 999888777;
      const task = await createTask(USER, { title: 'Приватная задача' });

      await handleCallbackQuery({
        id: 'cb-stranger',
        from: { id: STRANGER, first_name: 'Чужой' },
        data: `task_done:${task.id}`,
        message: {
          message_id: 601,
          chat: { id: CHAT },
          text: '📌 Приватная задача',
        },
      });

      // Answer was an alert refusal
      const ans = answers()[0];
      expect(ans?.text).toContain('Доступ');
      expect(ans?.showAlert).toBe(true);

      // Task is NOT completed
      const untouched = await getTask(USER, task.id);
      expect(untouched?.status).toBe('todo');

      // Message was NOT edited
      expect(callsOf('editMessageText')).toHaveLength(0);
    });
  });

  /**
   * MU-1: `retry_voice:<noteId>` — префиксный callback повтора распознавания.
   * Роутер владеет и префиксом, и проверкой владельца заметки.
   */
  describe('retry_voice callbacks (MU-1)', () => {
    /** Аварийная заметка голоса: файл и причина сохранены при первом отказе. */
    async function voiceRecoveryNote(userId = USER) {
      return createNote(userId, '🎙 Голосовое: не расшифровано — файл не скачался', {
        column: 'raw',
        sourceType: 'voice',
        fileId: 'VOICE-CB-1',
        sourceMessageId: 42,
        metadata: {
          voice_recovery: {
            kind: 'voice_recovery',
            reason: 'download',
            file_id: 'VOICE-CB-1',
            source_message_id: 42,
            attempts: 1,
          },
        },
      });
    }

    afterEach(() => {
      // Сброс подмены Bot API: свойство живёт на моке между тестами файла.
      delete (api as any).getFileContent;
    });

    it('префикс retry_voice: доходит до повтора и берёт сохранённый file_id', async () => {
      const note = await voiceRecoveryNote();
      const getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
      (api as any).getFileContent = getFileContent;

      await handleCallbackQuery(cb(`retry_voice:${note.id}`));

      // Повтор использует сохранённый файл, а не пересылку голосового.
      expect(getFileContent).toHaveBeenCalledWith('VOICE-CB-1');
      expect(confirmed().text).toContain('Повторяю');

      // Новая неудача обновила ту же заметку, а не создала вторую.
      const notes = await listNotes(USER, { column: 'raw' });
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(note.id);
    });

    it('retry_voice: запуск повтора убирает кнопку и дописывает статус', async () => {
      const note = await voiceRecoveryNote();
      (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

      await handleCallbackQuery(cb(`retry_voice:${note.id}`, { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      const first = callsOf('editMessageText')[0];
      expect(first?.params.message_id).toBe(701);
      expect(String(first?.params.text)).toContain('━━━━━━━━━━━━━━\n🔁 Повторное распознавание запущено…');
      expect(first?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('retry_voice: записи уже нет — кнопка убрана, статус «уже выполнено»', async () => {
      const note = await voiceRecoveryNote();
      await deleteNote(USER, note.id);
      const getFileContent = vi.fn();
      (api as any).getFileContent = getFileContent;

      await handleCallbackQuery(cb(`retry_voice:${note.id}`, { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      expect(answers()[0]?.showAlert).toBe(true);
      expect(getFileContent).not.toHaveBeenCalled();
      const edit = lastEdit();
      expect(String(edit?.params.text)).toContain('━━━━━━━━━━━━━━\n✅ Распознавание уже выполнено.');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('retry_voice: повтор уже идёт (свежий claim) — кнопка не трогается', async () => {
      const note = await voiceRecoveryNote();
      (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
      await claimVoiceRecovery(USER, note.id);

      await handleCallbackQuery(cb(`retry_voice:${note.id}`, { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      expect(answers()[0]?.showAlert).toBe(true);
      expect(callsOf('editMessageText')).toHaveLength(0);
    });

    it('access gate: посторонний не запускает повтор чужого голосового', async () => {
      const STRANGER = 999888777;
      const note = await voiceRecoveryNote();
      const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      (api as any).getFileContent = getFileContent;

      await handleCallbackQuery({
        ...cb(`retry_voice:${note.id}`, {
          message: { message_id: 602, chat: { id: CHAT }, text: '⚠️ Голосовое' },
        }),
        id: 'cb-stranger-voice',
        from: { id: STRANGER, first_name: 'Чужой' },
      });

      const ans = answers()[0];
      expect(ans?.text).toContain('Доступ');
      expect(ans?.showAlert).toBe(true);
      expect(getFileContent).not.toHaveBeenCalled();

      // Заметка владельца не тронута.
      const untouched = await getNote(USER, note.id);
      expect(untouched?.deletedAt).toBeNull();
    });
  });

  /**
   * MU-2: `retry_photo:<noteId>` — префиксный callback повтора распознавания
   * фото. Роутер владеет префиксом, проверкой владельца и — главное — запретом
   * повтора после возможной финансовой записи.
   */
  describe('retry_photo callbacks (MU-2)', () => {
    /** Аварийная заметка фото: файл, подпись и причина сохранены при отказе. */
    async function photoRecoveryNote(userId = USER) {
      return createNote(userId, '📸 Фото: не распознано — файл не скачался', {
        column: 'raw',
        sourceType: 'photo',
        fileId: 'PHOTO-CB-1',
        sourceMessageId: 43,
        metadata: {
          caption: 'чек из аптеки',
          photo_recovery: {
            kind: 'photo_recovery',
            reason: 'download',
            file_id: 'PHOTO-CB-1',
            caption: 'чек из аптеки',
            source_message_id: 43,
            attempts: 1,
          },
        },
      });
    }

    afterEach(() => {
      delete (api as any).getFileContent;
    });

    it('префикс retry_photo: доходит до повтора и берёт сохранённый file_id', async () => {
      const note = await photoRecoveryNote();
      const getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
      (api as any).getFileContent = getFileContent;

      await handleCallbackQuery(cb(`retry_photo:${note.id}`));

      expect(getFileContent).toHaveBeenCalledWith('PHOTO-CB-1');
      expect(confirmed().text).toContain('Повторяю');

      const notes = await listNotes(USER, { column: 'raw' });
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(note.id);
    });

    it('retry_photo: запуск повтора убирает кнопку и дописывает статус', async () => {
      const note = await photoRecoveryNote();
      (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));

      await handleCallbackQuery(cb(`retry_photo:${note.id}`, { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      const first = callsOf('editMessageText')[0];
      expect(first?.params.message_id).toBe(701);
      expect(String(first?.params.text)).toContain('━━━━━━━━━━━━━━\n🔁 Повторное распознавание запущено…');
      expect(first?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('retry_photo: записи нет — кнопка убрана, «Повтор недоступен»', async () => {
      const getFileContent = vi.fn();
      (api as any).getFileContent = getFileContent;

      await handleCallbackQuery(cb('retry_photo:99999', { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      expect(answers()[0]?.showAlert).toBe(true);
      expect(getFileContent).not.toHaveBeenCalled();
      const edit = lastEdit();
      expect(String(edit?.params.text)).toContain('━━━━━━━━━━━━━━\nℹ️ Повтор недоступен.');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('retry_photo: отказ проведения чека — кнопка убрана, повтор недоступен', async () => {
      const note = await createNote(USER, 'Чек: Аптека · 12,30 EUR', {
        column: 'raw',
        sourceType: 'photo',
        fileId: 'PHOTO-CB-3',
        metadata: { receipt_failure: { kind: 'receipt_failure', reason: 'unknown' } },
      });

      await handleCallbackQuery(cb(`retry_photo:${note.id}`, { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      expect(String(lastEdit()?.params.text)).toContain('ℹ️ Повтор недоступен.');
      expect(lastEdit()?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('retry_photo: повтор уже идёт (свежий claim) — кнопка не трогается', async () => {
      const note = await photoRecoveryNote();
      (api as any).getFileContent = vi.fn().mockRejectedValue(new Error('network down'));
      await claimPhotoRecovery(USER, note.id);

      await handleCallbackQuery(cb(`retry_photo:${note.id}`, { message: { message_id: 701, chat: { id: CHAT }, text: '⚠️ Сбой\n\n[🔁 Повторить]' } }));

      expect(answers()[0]?.showAlert).toBe(true);
      expect(callsOf('editMessageText')).toHaveLength(0);
    });

    it('access gate: посторонний не запускает повтор чужого фото', async () => {
      const STRANGER = 999888777;
      const note = await photoRecoveryNote();
      const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      (api as any).getFileContent = getFileContent;

      await handleCallbackQuery({
        ...cb(`retry_photo:${note.id}`, {
          message: { message_id: 603, chat: { id: CHAT }, text: '⚠️ Фото' },
        }),
        id: 'cb-stranger-photo',
        from: { id: STRANGER, first_name: 'Чужой' },
      });

      const ans = answers()[0];
      expect(ans?.text).toContain('Доступ');
      expect(ans?.showAlert).toBe(true);
      expect(getFileContent).not.toHaveBeenCalled();

      const untouched = await getNote(USER, note.id);
      expect(untouched?.deletedAt).toBeNull();
    });

    it('запрет финансового повтора: заметка с отказом проведения чека не оживает', async () => {
      // Стадия уже после `executeFinancialIntent`: результат неизвестен, поэтому
      // повтор не должен ни скачивать файл, ни проводить операцию снова.
      const note = await createNote(USER, 'Чек: Аптека · 12,30 EUR', {
        column: 'raw',
        sourceType: 'photo',
        fileId: 'PHOTO-CB-2',
        metadata: {
          receipt_failure: {
            kind: 'receipt_failure',
            reason: 'unknown',
            total: 12.3,
            currency: 'EUR',
            merchant: 'Аптека',
          },
        },
      });
      const getFileContent = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      (api as any).getFileContent = getFileContent;
      const before = await listTransactions(USER);

      await handleCallbackQuery(cb(`retry_photo:${note.id}`));

      expect(getFileContent).not.toHaveBeenCalled();
      expect(answers()[0]?.showAlert).toBe(true);
      expect(await listTransactions(USER)).toHaveLength(before.length);
      expect((await getNote(USER, note.id))?.deletedAt).toBeNull();
    });
  });
});
