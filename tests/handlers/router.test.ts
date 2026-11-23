/**
 * T14 — маршрутизация апдейтов (`handlers.py`: команды, алиасы, инбокс, швы).
 *
 * Фиксируем поведение, которое легко сломать незаметно: ворота доступа,
 * порядок «онбординг → команда» у нового пользователя, пересланный текст минует
 * команды, швы Т15 (`ingest`/`triage`/`backup`/`consolidation`/`agent`) и
 * встроенные callback-ветки (валюта, бэкап, разбор).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputFile, api, callsOf, db, resetApi, resetDb, sql, sqliteDDL } from '../mocks/sdk';

import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { createNote } from '../../src/lib/dal/notes';
import { createLiability, getLiability } from '../../src/lib/dal/finances';
import { kvGet, liabilityReviewKey } from '../../src/lib/dal/misc';
import { ensureUser, getUser, updateUser } from '../../src/lib/dal/users';
import { monthKey } from '../../src/lib/utils';
import { addItem, buildSkillSpec, getItem, recordFailure } from '../../src/lib/evolution';
import { helpText } from '../../src/lib/summary';

import { MAX_REPLY_CONTEXT_CHARS } from '../../src/lib/agent/constants';
import {
  BACKLOG_EMPTY_TEXT,
  BACKUP_FAILED_TEXT,
  BACKUP_STATUS_TEXT,
  CONSOLIDATE_STATUS_TEXT,
  DASHBOARD_UNAVAILABLE_TEXT,
  INBOX_EMPTY_TEXT,
  INBOX_FOOTER,
  INGEST_UNAVAILABLE_TEXT,
  RESET_TEXT,
  TRIAGE_EMPTY_TEXT,
  TRIAGE_STATUS_TEXT,
  TRIAGE_UNAVAILABLE_TEXT,
  UNKNOWN_COMMAND_TEXT,
  extractReplyContext,
  inboxHeader,
  isForwarded,
  registerCallback,
  resetRouterSeams,
  routeCallback,
  routeMessage,
  sendJsonBackup,
  setAgentRunner,
  setBackupSender,
  setConsolidationRunner,
  setTextIngestHandler,
  setTriageHandler,
  splitLines,
} from '../../src/handlers/router';
import type { IngestContext } from '../../src/handlers/router';
import type { CallbackQuery, Message } from '../../src/handlers/message';
import {
  ACCESS_DENIED_ALERT,
  ACCESS_DENIED_MESSAGE,
} from '../../src/handlers/onboarding';
import {
  getBackupInlineKeyboard,
  getCommandsKeyboard,
  getMainKeyboard,
  getOpenAppInlineKeyboard,
  getTriageInlineKeyboard,
  KEYBOARD_DEBTS,
  OPEN_APP_LABEL,
} from '../../src/handlers/keyboards';

const USER = 501;
const OTHER = 502;
const CHAT = 900;
const WEBAPP = 'https://mini.example.com/app';

/** Обычный ответ сворачивает reply-клавиатуру: `remove_keyboard`, а не `getMainKeyboard()`. */
const REMOVE_KEYBOARD = { remove_keyboard: true };

function msg(text: string | null, extra: Partial<Message> = {}): Message {
  const message: Message = {
    message_id: 11,
    chat: { id: CHAT },
    from: { id: USER, first_name: 'Алекс' },
    ...extra,
  };
  if (text !== null) message.text = text;
  return message;
}

function cb(data: string, extra: Partial<CallbackQuery> = {}): CallbackQuery {
  return {
    id: 'cb-1',
    from: { id: USER, first_name: 'Алекс' },
    data,
    message: { message_id: 77, chat: { id: CHAT } },
    ...extra,
  };
}

const sentTexts = (): string[] =>
  callsOf('sendMessage').map((call) => String(call.params.text ?? ''));

const editedTexts = (): string[] =>
  callsOf('editMessageText').map((call) => String(call.params.text ?? ''));

const answers = (): Array<Record<string, unknown>> =>
  callsOf('answerCallbackQuery').map((call) => call.params);

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  resetRouterSeams();
  vi.unstubAllEnvs();
  vi.stubEnv('APP_ENV', '');
  vi.stubEnv('WEBAPP_URL', '');
  await ensureUser(USER, 'Алекс');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Доступ и онбординг
// ---------------------------------------------------------------------------

describe('routeMessage: доступ', () => {
  it('чужой пользователь получает приватный отказ, клавиатуру и не сохраняется в users', async () => {
    setConfigOverrides({ betaWhitelist: [OTHER], adminIds: [] });
    const STRANGER = 999;
    await routeMessage(msg('привет', { from: { id: STRANGER } }));

    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toBe(ACCESS_DENIED_MESSAGE);
    expect(ACCESS_DENIED_MESSAGE).toBe('⛔ Доступ закрыт (приватный инстанс).');
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toBeUndefined();

    // Не создаёт пользователя в users
    expect(await getUser(STRANGER)).toBeNull();

    // Одобренный пользователь из таблицы users проходит даже если не в whitelist
    await ensureUser(STRANGER, 'Одобренный пользователь');
    await routeMessage(msg('привет', { from: { id: STRANGER } }));
    expect(sentTexts().length).toBeGreaterThan(1);
  });
});

describe('routeMessage: онбординг', () => {
  it('новый пользователь и текст: приветствие и вопрос об обучении', async () => {
    await routeMessage(msg('купил хлеб', { from: { id: OTHER, first_name: 'Новый' } }));

    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Как со мной общаться');
    expect(texts[0]).toContain('Пройти короткое знакомство');
    expect(await getUser(OTHER)).not.toBeNull();
  });

  it('новый пользователь /start: приветствие и вопрос об обучении', async () => {
    await routeMessage(msg('/start', { from: { id: OTHER, first_name: 'Новый' } }));

    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('твой личный ассистент');
    expect(texts[1]).toContain('Пройти короткое знакомство');
    const calls = callsOf('sendMessage');
    expect(calls[1]?.params.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🚀 Пройти знакомство', callback_data: 'onboard:step:overview' }],
        [{ text: '⏩ Пропустить', callback_data: 'onboard:skip' }],
      ],
    });
  });

  it('новый пользователь без текста получает приветствие с вопросом об обучении', async () => {
    await routeMessage(msg(null, { from: { id: OTHER, first_name: 'Новый' } }));
    expect(sentTexts()).toHaveLength(2);
    expect(sentTexts()[1]).toContain('Пройти короткое знакомство');
  });

  it('известный пользователь /start: только приветствие', async () => {
    await routeMessage(msg('/start'));
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('твой личный ассистент');
  });
});

// ---------------------------------------------------------------------------
// Инбокс (шов приёма)
// ---------------------------------------------------------------------------

describe('routeMessage: инбокс', () => {
  it('свободный текст без шва — честная заглушка', async () => {
    await routeMessage(msg('  мысль про отпуск  '));
    expect(sentTexts()).toEqual([INGEST_UNAVAILABLE_TEXT]);
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toBeUndefined();
  });

  it('шов получает обрезанный текст, чат и message_id', async () => {
    const seen: IngestContext[] = [];
    setTextIngestHandler(async (ctx) => {
      seen.push(ctx);
    });

    await routeMessage(msg('  мысль про отпуск  '));
    expect(seen).toEqual([
      { userId: USER, chatId: CHAT, text: 'мысль про отпуск', forwarded: false, messageId: 11 },
    ]);
    expect(sentTexts()).toHaveLength(0);
  });

  it('пересланное сообщение минует команды и слова-клавиатуру', async () => {
    const seen: IngestContext[] = [];
    setTextIngestHandler(async (ctx) => {
      seen.push(ctx);
    });

    await routeMessage(msg(`/help`, { forward_origin: { type: 'channel' } }));
    await routeMessage(msg(KEYBOARD_DEBTS, { forward_from: { id: 1 } }));

    expect(seen).toHaveLength(2);
    expect(seen.every((ctx) => ctx.forwarded)).toBe(true);
    expect(sentTexts()).toHaveLength(0);
  });

  it('isForwarded видит любое forward_поле', () => {
    expect(isForwarded(msg('x'))).toBe(false);
    expect(isForwarded(msg('x', { forward_date: 1 }))).toBe(true);
    expect(isForwarded(msg('x', { forward_from_chat: { id: 1 } }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

describe('routeMessage: команды', () => {
  it('/help отдаёт справку с кнопкой повтора обучения и условной поддержкой из overlay', async () => {
    await routeMessage(msg('/help'));
    expect(sentTexts()[0]).toContain('Tokio');
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🚀 Пройти знакомство заново', callback_data: 'onboard:restart' }],
      ],
    });
    expect(helpText()).not.toContain('/diary');
    expect(helpText()).toContain('/skills');
  });

  it('неизвестная слэш-команда — подсказка', async () => {
    await routeMessage(msg('/qwerty'));
    expect(sentTexts()).toEqual([UNKNOWN_COMMAND_TEXT]);
  });

  it('/byok без CSPRNG не сохраняет ключ и сообщает об ошибке', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await routeMessage(msg('/byok AIzaSyTestByokKeyForRouter1234567890'));
      const texts = sentTexts();
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('⚠️ Не удалось безопасно сохранить ключ Gemini API');
      expect(texts[0]).not.toContain('🎉');
      const user = await getUser(USER);
      expect(user?.byok ?? null).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('/byok clear убирает сохранённый ключ', async () => {
    const { sealByok } = await import('../../src/lib/crypto');
    await updateUser(USER, {
      byok: await sealByok(USER, 'AIzaSyTestByokKeyForRouter1234567890', {
        masterKey: 'test-master-key-32-chars-long-aaaa',
      }),
    });
    expect((await getUser(USER))?.byok ?? null).not.toBeNull();

    await routeMessage(msg('/byok clear'));

    expect((await getUser(USER))?.byok ?? null).toBeNull();
    expect(sentTexts().join('\n')).toContain('Персональный ключ удалён');
  });

  it('/byok предупреждает, если сохранённый ключ не читается', async () => {
    const { sealByok } = await import('../../src/lib/crypto');
    await updateUser(USER, {
      byok: await sealByok(USER, 'AIzaSyTestByokKeyForRouter1234567890', {
        masterKey: 'old-master-key-32-chars-long-aaaa',
      }),
    });

    await routeMessage(msg('/byok'));

    const text = sentTexts().join('\n');
    expect(text).toContain('Сохранённый ключ не читается');
    expect(text).toContain('/byok clear');
  });

  it('слэш-алиасы и @botname', async () => {
    await routeMessage(msg('/сводка'));
    await routeMessage(msg('/balance@tokio_bot'));
    await routeMessage(msg('/help?!'));

    const texts = sentTexts();
    expect(texts).toHaveLength(3);
    expect(callsOf('sendChatAction').length).toBeGreaterThanOrEqual(2);
  });

  it('слова-команды и подписи клавиатуры (с хвостовой пунктуацией)', async () => {
    await routeMessage(msg(`${KEYBOARD_DEBTS}?`));
    await routeMessage(msg('долги!'));
    expect(sentTexts()).toHaveLength(2);
  });

  it('/diagnostics и /диагностика показывают журнал сбоев', async () => {
    await recordFailure(USER, { stage: 'stt', media: 'voice', reason: 'transcription_failed' });

    await routeMessage(msg('/diagnostics'));
    await routeMessage(msg('/диагностика'));

    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain('Диагностика');
      expect(text).toContain('stt · voice · transcription_failed');
    }
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getMainKeyboard());
  });

  it('/diagnostics при пустом журнале говорит «сбоев не записано»', async () => {
    await routeMessage(msg('/diagnostics'));

    expect(sentTexts()[0]).toContain('Сбоев не записано');
  });

  it('/new и фразы сброса дают один и тот же текст', async () => {
    await routeMessage(msg('/new'));
    await routeMessage(msg('начни новую сессию!'));
    await routeMessage(msg('начни с чистого листа'));
    for (const text of sentTexts()) expect(text).toContain('Контекст беседы сброшен');
  });

  it('типовая сводка/баланс/долги/задачи оставляют клавиатуру свёрнутой, а /meds возвращает Главный экран', async () => {
    for (const text of ['/status', '/balance', '/debts', '/tasks']) {
      resetApi();
      await routeMessage(msg(text));
      const [call] = callsOf('sendMessage');
      expect(call?.params.reply_markup).toBeUndefined();
    }
    resetApi();
    await routeMessage(msg('/meds'));
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getMainKeyboard());
  });

  it('двухслойное переключение: ⌨️ Команды › и ← Назад', async () => {
    await routeMessage(msg('⌨️ Команды ›'));
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getCommandsKeyboard());

    resetApi();
    await routeMessage(msg('← Назад'));
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getMainKeyboard());
  });

  it('/digest прикладывает кнопку бэкапа', async () => {
    await routeMessage(msg('/digest'));
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getBackupInlineKeyboard());
  });
});

// ---------------------------------------------------------------------------
// Бэклог эволюции
// ---------------------------------------------------------------------------

describe('routeMessage: бэклог эволюции', () => {
  it('fast-path записывает идею без модели', async () => {
    await routeMessage(msg('идея: добавить фильтр по счетам'));

    expect(sentTexts()[0]).toContain('Записано в бэклог авто-эволюции');
    expect(sentTexts()[0]).toContain('добавить фильтр по счетам');
    expect(sentTexts()[0]).not.toBe(INGEST_UNAVAILABLE_TEXT);
  });

  it('/backlog: пусто и непусто', async () => {
    await routeMessage(msg('/backlog'));
    expect(sentTexts()[0]).toContain('Бэклог авто-эволюции пуст');

    resetApi();
    await addItem(USER, { rawInput: 'Не работает кнопка', category: 'bug', title: 'Не работает кнопка' });
    await routeMessage(msg('/backlog'));

    // Markdown-шапка уходит через конвейер: `**…**` → `<b>…</b>`.
    expect(sentTexts()[0]).toContain('<b>Бэклог авто-эволюции:</b>');
    expect(sentTexts()[0]).toContain('🐛');
    expect(sentTexts()[0]).toContain('Не работает кнопка');
  });

  it('bare-слово не перехватывает идею', async () => {
    await routeMessage(msg('баг: падает сводка'));
    expect(sentTexts()[0]).toContain('Записано в бэклог');
  });
});

// ---------------------------------------------------------------------------
// Триаж (шов)
// ---------------------------------------------------------------------------

describe('routeMessage: /triage', () => {
  it('без шва при пустом инбоксе — сразу «Инбокс пуст!» без вызова агента', async () => {
    let agentCalls = 0;
    setAgentRunner(async () => {
      agentCalls += 1;
      return 'should not run';
    });
    await routeMessage(msg('/triage'));
    expect(sentTexts()).toEqual([TRIAGE_STATUS_TEXT]);
    expect(editedTexts()[0]).toContain('Инбокс пуст');
    expect(agentCalls).toBe(0);
  });

  it('без шва при наличии сырых заметок — вызывает агента со скиллом inbox-triage', async () => {
    await createNote(USER, 'Позвонить в банк завтра', { column: 'raw' });
    const seenPrompts: string[] = [];
    setAgentRunner(async (ctx) => {
      seenPrompts.push(ctx.text);
      return '**Разобрана 1 заметка** в задачи.';
    });
    await routeMessage(msg('/triage'));

    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain('read_skill("inbox-triage")');
    expect(editedTexts()[0]).toContain('<b>Разобрана 1 заметка</b>');
  });

  it('с пустым инбоксом — «всё разобрано»', async () => {
    setTriageHandler(async () => ({ count: 0, text: 'x' }));
    await routeMessage(msg('/triage'));

    expect(sentTexts()).toEqual([TRIAGE_STATUS_TEXT]);
    expect(editedTexts()[0]).toContain('Инбокс пуст');
  });

  it('с результатом — HTML-отчёт и кнопка дашборда (если URL есть)', async () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    setTriageHandler(async () => ({ count: 2, text: '<b>Разобрано: 2</b>' }));
    await routeMessage(msg('/triage'));

    const [edit] = callsOf('editMessageText');
    expect(edit?.params.text).toBe('<b>Разобрано: 2</b>');
    expect(edit?.params.parse_mode).toBe('HTML');
    expect(edit?.params.reply_markup).toEqual(getOpenAppInlineKeyboard());
  });

  it('null от шва и исключение редактируют статус', async () => {
    setTriageHandler(async () => null);
    await routeMessage(msg('/triage'));
    expect(editedTexts()[0]).toBe(TRIAGE_UNAVAILABLE_TEXT);

    resetApi();
    setTriageHandler(async () => {
      throw new Error('boom');
    });
    await routeMessage(msg('/triage'));
    expect(editedTexts()[0]).toContain('Ошибка при разборе инбокса: boom');
  });
});

// ---------------------------------------------------------------------------
// Бэкап
// ---------------------------------------------------------------------------

describe('routeMessage: /backup', () => {
  it('успех: статус удаляется', async () => {
    setBackupSender(async () => true);
    await routeMessage(msg('/backup'));

    expect(callsOf('sendChatAction')[0]?.params).toEqual({
      chat_id: CHAT,
      action: 'upload_document',
    });
    expect(sentTexts()).toEqual([BACKUP_STATUS_TEXT]);
    // sendChatAction — вызов №1, статус — №2: мок нумерует message_id по числу вызовов.
    expect(callsOf('deleteMessage')[0]?.params).toEqual({ chat_id: CHAT, message_id: 2 });
  });

  it('false: статус превращается в ошибку', async () => {
    setBackupSender(async () => false);
    await routeMessage(msg('/backup'));

    expect(editedTexts()[0]).toBe(BACKUP_FAILED_TEXT);
    expect(callsOf('deleteMessage')).toHaveLength(0);
  });

  it('исключение: текст ошибки', async () => {
    setBackupSender(async () => {
      throw new Error('disk');
    });
    await routeMessage(msg('/backup'));
    expect(editedTexts()[0]).toContain('Ошибка при создании бэкапа: disk');
  });

  it('встроенный бэкап отправляет JSON-документ', async () => {
    expect(await sendJsonBackup(USER, CHAT)).toBe(true);

    const [doc] = callsOf('sendDocument');
    expect(doc?.params.chat_id).toBe(CHAT);
    expect(doc?.params.parse_mode).toBe('Markdown');
    expect(String(doc?.params.caption)).toContain('Внеочередной бэкап данных');
    expect(doc?.params.document).toBeInstanceOf(InputFile);
  });
});

// ---------------------------------------------------------------------------
// Консолидация и агент
// ---------------------------------------------------------------------------

describe('routeMessage: /consolidate и /ask', () => {
  it('/consolidate: статус, затем ✨-ответ', async () => {
    setConsolidationRunner(async () => ({ message: 'Готово' }));
    await routeMessage(msg('/consolidate'));

    expect(sentTexts()).toEqual([CONSOLIDATE_STATUS_TEXT]);
    expect(editedTexts()[0]).toContain('✨ Готово');
  });

  it('/consolidate: ошибка', async () => {
    setConsolidationRunner(async () => {
      throw new Error('nope');
    });
    await routeMessage(msg('/consolidate'));
    expect(editedTexts()[0]).toContain('Ошибка при консолидации: nope');
  });

  it('/ask без вопроса — подсказка', async () => {
    await routeMessage(msg('/ask'));
    // Текст уходит через markdown-конвейер: `/ask …` превращается в <code>.
    const text = sentTexts()[0] ?? '';
    expect(text).toContain('Напиши вопрос после команды, например:');
    expect(text).toContain('<code>/ask почему вырос расход за прошлую неделю?</code>');
    expect(text).not.toBe(INGEST_UNAVAILABLE_TEXT);
  });

  it('/ask с вопросом идёт в агента', async () => {
    const seen: string[] = [];
    setAgentRunner(async (ctx) => {
      seen.push(ctx.text);
      return 'Ответ агента';
    });

    await routeMessage(msg('/ask  что по деньгам? '));
    expect(seen).toEqual(['что по деньгам?']);
    expect(sentTexts()[0]).toBe('Ответ агента');
  });

  it('/ask: ошибка агента', async () => {
    setAgentRunner(async () => {
      throw new Error('timeout');
    });
    await routeMessage(msg('/ask вопрос'));
    expect(sentTexts()[0]).toContain('Ошибка агента: timeout');
  });

  it('extractReplyContext: приоритет у quote.text, фолбэк на reply_to_message text/caption и обрезка по лимиту', () => {
    expect(extractReplyContext(msg('текст'))).toBeUndefined();

    expect(
      extractReplyContext(
        msg('Давай обсудим.', {
          quote: { text: 'Под платежи ближайших 12 дн. не хватает ~93 €' },
          reply_to_message: { message_id: 5, text: 'Длинная сводка...' },
        }),
      ),
    ).toBe('Под платежи ближайших 12 дн. не хватает ~93 €');

    expect(
      extractReplyContext(
        msg('Ок', {
          reply_to_message: { message_id: 5, caption: 'Подпись к скрину' },
        }),
      ),
    ).toBe('Подпись к скрину');

    const long = 'А'.repeat(MAX_REPLY_CONTEXT_CHARS + 120);
    const clipped = extractReplyContext(msg('Ок', { quote: { text: long } }));
    expect(clipped?.length).toBe(MAX_REPLY_CONTEXT_CHARS);
    expect(clipped?.endsWith('…')).toBe(true);
  });

  it('quote/reply_to_message прокидываются в ingest и /ask', async () => {
    const seenIngest: IngestContext[] = [];
    setTextIngestHandler(async (ctx) => {
      seenIngest.push(ctx);
    });

    await routeMessage(
      msg('Давай обсудим.', {
        quote: { text: 'Под платежи ближайших 12 дн. не хватает ~93 €' },
        reply_to_message: { message_id: 10, text: 'Доброе утро...' },
      }),
    );

    expect(seenIngest).toHaveLength(1);
    expect(seenIngest[0]).toMatchObject({
      text: 'Давай обсудим.',
      replyContext: 'Под платежи ближайших 12 дн. не хватает ~93 €',
    });

    const seenAsk: string[] = [];
    setAgentRunner(async (ctx) => {
      seenAsk.push(ctx.text);
      return 'Разберём.';
    });

    await routeMessage(
      msg('/ask что отложить?', {
        reply_to_message: { message_id: 10, text: 'GeForce NOW — 19,99 USD (20-е число)' },
      }),
    );

    expect(seenAsk).toHaveLength(1);
    expect(seenAsk[0]).toContain('GeForce NOW — 19,99 USD (20-е число)');
    expect(seenAsk[0]).toContain('что отложить?');
  });
});

// ---------------------------------------------------------------------------
// Инбокс (чтение) и дашборд
// ---------------------------------------------------------------------------

describe('routeMessage: /inbox', () => {
  it('пусто — HTML-сообщение', async () => {
    await routeMessage(msg('/inbox'));
    expect(sentTexts()[0]).toBe(INBOX_EMPTY_TEXT);
    expect(callsOf('sendMessage')[0]?.params.parse_mode).toBe('HTML');
  });

  it('заметки: однострочная, многострочная и разобранная', async () => {
    await createNote(USER, 'Купить хлеб');
    const multi = await createNote(USER, 'План поездки\nВторой пункт');
    await createNote(USER, 'Уже разобрано');

    await db.run(sql`UPDATE notes SET processed_at = '2026-11-01T00:00:00Z' WHERE raw_text = 'Уже разобрано'`);

    await routeMessage(msg('/inbox'));

    const text = sentTexts()[0] ?? '';
    expect(text).toContain(inboxHeader(2));
    expect(inboxHeader(2)).not.toContain('в IDE');
    expect(text).toContain('1. 📝 <b>План поездки</b> (всего 2 строк):');
    expect(text).toContain('<blockquote expandable>План поездки\nВторой пункт</blockquote>');
    expect(text).toContain('2. 📝 Купить хлеб');
    expect(text).not.toContain('Уже разобрано');
    expect(text).toContain(INBOX_FOOTER);
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getTriageInlineKeyboard());
    expect(multi.processedAt).toBeNull();
  });
});

describe('routeMessage: открыть дашборд', () => {
  it('без WEBAPP_URL — честное «не подключён»', async () => {
    await routeMessage(msg(OPEN_APP_LABEL));
    expect(sentTexts()).toEqual([DASHBOARD_UNAVAILABLE_TEXT]);
  });

  it('с WEBAPP_URL — кнопка запуска Mini App', async () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    await routeMessage(msg(`${OPEN_APP_LABEL}!`));

    expect(sentTexts()[0]).toBe('Открываю дашборд 👇');
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual(getOpenAppInlineKeyboard());
  });
});

// ---------------------------------------------------------------------------
// Callback-запросы
// ---------------------------------------------------------------------------

describe('routeCallback', () => {
  it('выбор валюты: пишет в профиль, гасит клавиатуру', async () => {
    await routeCallback(cb('onboard:currency:USD'));

    expect(answers()[0]?.text).toBe('✅ Базовая валюта: USD');
    const [edit] = callsOf('editMessageText');
    expect(edit?.params.message_id).toBe(77);
    expect(String(edit?.params.text)).toContain('USD');
    expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect((await getUser(USER))?.baseCurrency).toBe('USD');
  });

  it('невалидный код валюты: только пустой ответ', async () => {
    await routeCallback(cb('onboard:currency:XXX'));
    expect(answers()).toEqual([{ callback_query_id: 'cb-1' }]);
    expect(callsOf('editMessageText')).toHaveLength(0);
  });

  it('отказ в доступе приходит алертом', async () => {
    setConfigOverrides({ betaWhitelist: [OTHER], adminIds: [] });
    const STRANGER = 999;
    await routeCallback(cb('backup:download', { from: { id: STRANGER } }));

    expect(answers()[0]).toEqual({
      callback_query_id: 'cb-1',
      text: ACCESS_DENIED_ALERT,
      show_alert: true,
    });
  });

  it('callback без сообщения получает пустой ответ', async () => {
    await routeCallback(cb('backup:download', { message: undefined }));
    expect(answers()).toEqual([{ callback_query_id: 'cb-1' }]);
  });

  it('бэкап по кнопке: успех и провал', async () => {
    setBackupSender(async () => true);
    await routeCallback(cb('backup:download'));
    expect(answers()[0]?.text).toBe('📦 Отправляю файл бэкапа...');
    expect(answers()[0]?.show_alert).toBeUndefined();

    resetApi();
    setBackupSender(async () => false);
    await routeCallback(cb('backup:download'));
    expect(answers()[0]?.text).toBe('📦 Отправляю файл бэкапа...');
    expect(answers()[1]).toEqual({
      callback_query_id: 'cb-1',
      text: BACKUP_FAILED_TEXT,
      show_alert: true,
    });
  });

  it('бэкап по кнопке: исключение алертом', async () => {
    setBackupSender(async () => {
      throw new Error('nope');
    });
    await routeCallback(cb('backup:download'));
    expect(answers()[1]?.text).toBe('Ошибка бэкапа: nope');
    expect(answers()[1]?.show_alert).toBe(true);
  });

  it('разбор по кнопке: дефолтный пустой инбокс, явный null шва и результат', async () => {
    // Без шва и с пустым инбоксом: сразу обновляет сообщение, не тратя токены.
    await routeCallback(cb('triage:inbox'));
    expect(editedTexts()[0]).toContain('Инбокс пуст');

    resetApi();
    setTriageHandler(async () => null);
    await routeCallback(cb('triage:inbox'));
    expect(answers()).toEqual([
      {
        callback_query_id: 'cb-1',
        text: TRIAGE_UNAVAILABLE_TEXT,
        show_alert: true,
      },
    ]);

    resetApi();
    setTriageHandler(async () => ({ count: 0, text: 'x' }));
    await routeCallback(cb('triage:inbox'));
    expect(editedTexts()[0]).toContain('Инбокс пуст');
    // Пустой разбор не оставляет кнопку «Разобрать»; без WEBAPP_URL — пустая клавиатура.
    expect(callsOf('editMessageText')[0]?.params.reply_markup).toEqual({ inline_keyboard: [] });

    resetApi();
    setTriageHandler(async () => ({ count: 3, text: '<b>Разобрано: 3</b>' }));
    await routeCallback(cb('triage:inbox'));
    expect(answers()[0]?.text).toBe('🧠 Запускаю разбор...');
    expect(editedTexts()[0]).toBe('<b>Разобрано: 3</b>');
  });

  it('разбор по кнопке: пустой инбокс заменяет кнопку входом в приложение', async () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    setTriageHandler(async () => ({ count: 0, text: 'x' }));

    await routeCallback(cb('triage:inbox'));

    expect(callsOf('editMessageText')[0]?.params.reply_markup).toEqual(getOpenAppInlineKeyboard());
    expect(getOpenAppInlineKeyboard()).not.toBeNull();
  });

  it('зарегистрированный обработчик получает полный контекст', async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerCallback('undo:task:7', async (ctx) => {
      seen.push(ctx as unknown as Record<string, unknown>);
    });

    await routeCallback(cb('undo:task:7'));
    expect(seen).toEqual([
      { userId: USER, chatId: CHAT, messageId: 77, data: 'undo:task:7', firstName: 'Алекс' },
    ]);
  });

  it('префиксный обработчик получает всё с этим префиксом', async () => {
    const seen: string[] = [];
    registerCallback('nav:', async (ctx) => {
      seen.push(ctx.data);
    });

    await routeCallback(cb('nav:tasks'));
    expect(seen).toEqual(['nav:tasks']);
  });

  it('неизвестные данные — пустой ответ', async () => {
    await routeCallback(cb('unknown:action:1'));
    expect(answers()).toEqual([{ callback_query_id: 'cb-1' }]);
  });

  it('проверка списаний: lrev ведёт в решение, а не в пустой ответ', async () => {
    await updateUser(USER, { timezone: 'UTC' });
    const liability = await createLiability(USER, {
      name: 'Кредит',
      amountCents: 120_000,
      monthlyPaymentCents: 35_000,
      paymentDay: 1,
    });
    const month = monthKey(new Date(), 'UTC');

    await routeCallback(cb(`lrev:${liability.id}:${month}:p`));

    expect((await getLiability(USER, liability.id))?.paidMonths).toEqual([month]);
    expect(JSON.parse(String(await kvGet(liabilityReviewKey(USER, liability.id, month))))).toMatchObject({
      decision: 'paid',
    });
    expect(String(answers()[0]?.text)).toContain('оплачено');
  });

  describe('проверка списаний: карточка обновляется по пункту', () => {
    const DIVIDER = '━━━━━━━━━━━━━━';

    /** Три обязательства с платежом в текущем месяце и карточка в виде, как её видит Telegram. */
    async function setupCard() {
      await updateUser(USER, { timezone: 'UTC' });
      const month = monthKey(new Date(), 'UTC');
      const names = ['Кредит', 'Аренда', 'Интернет'];
      const liabilities = [];
      for (const name of names) {
        liabilities.push(
          await createLiability(USER, {
            name,
            amountCents: 120_000,
            monthlyPaymentCents: 35_000,
            paymentDay: 1,
          }),
        );
      }
      const text = [
        '🔍 Проверка списаний',
        '',
        'Что уже прошло в этом месяце?',
        ...names.map((name, index) => `${index + 1}. ${name} — 350,00 € · 1 числа`),
        '',
        '✅ оплатил · ❌ не оплатил · 🗑 удалить',
        'Первый ответ за месяц фиксируется; повторы ничего не меняют.',
      ].join('\n');
      const keyboardRows = liabilities.map((liability, index) => {
        const n = index + 1;
        return [
          { text: `✅ ${n}`, callback_data: `lrev:${liability.id}:${month}:p` },
          { text: `❌ ${n}`, callback_data: `lrev:${liability.id}:${month}:n` },
          { text: `🗑 ${n}`, callback_data: `lrev:${liability.id}:${month}:d` },
        ];
      });
      const tap = (id: number, action: 'p' | 'n' | 'd', cardText: string, rows: typeof keyboardRows) =>
        routeCallback(
          cb(`lrev:${id}:${month}:${action}`, {
            message: {
              message_id: 77,
              chat: { id: CHAT },
              text: cardText,
              reply_markup: { inline_keyboard: rows },
            },
          }),
        );
      return { month, liabilities, text, keyboardRows, tap };
    }

    const lastEdit = () => {
      const edits = callsOf('editMessageText');
      return edits[edits.length - 1];
    };
    const rowLabels = (markup: unknown): string[] =>
      ((markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard).map(
        (row) => row[0]?.text ?? '',
      );

    it('решение по пункту убирает только его строку и дописывает итог', async () => {
      const { liabilities, text, keyboardRows, tap } = await setupCard();

      await tap(liabilities[1]!.id, 'p', text, keyboardRows);

      const edit = lastEdit();
      expect(edit?.params.message_id).toBe(77);
      expect(String(edit?.params.text)).toContain(`${DIVIDER}\n✅ 2. Аренда — оплачено`);
      expect(String(edit?.params.text)).toContain('оплатил · ❌ не оплатил');
      expect(rowLabels(edit?.params.reply_markup)).toEqual(['✅ 1', '✅ 3']);
      expect(String(answers()[0]?.text)).toContain('оплачено');
    });

    it('последнее решение убирает легенду и клавиатуру', async () => {
      const { liabilities, text, keyboardRows, tap } = await setupCard();

      await tap(liabilities[0]!.id, 'p', text, keyboardRows);
      const [, ...afterFirst] = keyboardRows;
      const firstText = String(lastEdit()?.params.text);
      await tap(liabilities[1]!.id, 'n', firstText, afterFirst);
      const [, ...afterSecond] = afterFirst;
      const secondText = String(lastEdit()?.params.text);
      await tap(liabilities[2]!.id, 'd', secondText, afterSecond);

      const edit = lastEdit();
      expect(String(edit?.params.text)).toContain(
        `${DIVIDER}\n✅ 1. Кредит — оплачено\n❌ 2. Аренда — не оплачено\n🗑️ 3. Интернет — удалено`,
      );
      expect(String(edit?.params.text)).not.toContain('Первый ответ за месяц');
      expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
    });

    it('повтор по уже решённому пункту: тост «принято» и зависшая строка кнопок убрана', async () => {
      const { liabilities, text, keyboardRows, tap } = await setupCard();
      await tap(liabilities[1]!.id, 'p', text, keyboardRows);
      resetApi();

      // Старое сообщение у клиента ещё с полным набором кнопок; нажали другое действие.
      await tap(liabilities[1]!.id, 'd', text, keyboardRows);

      expect(String(answers()[0]?.text)).toContain('уже принято');
      const edit = lastEdit();
      // Показывается первое (победившее) решение, а не повторное нажатие.
      expect(String(edit?.params.text)).toContain(`${DIVIDER}\n✅ 2. Аренда — оплачено`);
      expect(String(edit?.params.text)).not.toContain('🗑️ 2.');
      expect(rowLabels(edit?.params.reply_markup)).toEqual(['✅ 1', '✅ 3']);
      expect((await getLiability(USER, liabilities[1]!.id))?.isActive).toBe(true);
    });

    it('удаление: итог «удалено», а повтор по удалённому обязательству чистит строку', async () => {
      const { liabilities, text, keyboardRows, tap } = await setupCard();
      await tap(liabilities[2]!.id, 'd', text, keyboardRows);
      expect(String(lastEdit()?.params.text)).toContain('🗑️ 3. Интернет — удалено');
      resetApi();

      await tap(liabilities[2]!.id, 'p', text, keyboardRows);

      expect(answers()[0]?.show_alert).toBe(true);
      expect(String(lastEdit()?.params.text)).toContain('🗑️ 3. Интернет — удалено');
      expect(rowLabels(lastEdit()?.params.reply_markup)).toEqual(['✅ 1', '✅ 2']);
    });

    it('прошлый месяц карточку не правит', async () => {
      const { liabilities, text, keyboardRows } = await setupCard();

      await routeCallback(
        cb(`lrev:${liabilities[0]!.id}:2000-01:p`, {
          message: {
            message_id: 77,
            chat: { id: CHAT },
            text,
            reply_markup: { inline_keyboard: keyboardRows },
          },
        }),
      );

      expect(String(answers()[0]?.text)).toContain('не текущий месяц');
      expect(callsOf('editMessageText')).toHaveLength(0);
    });

    it('сбой правки сообщения не роняет обработчик: решение уже записано', async () => {
      const { month, liabilities, text, keyboardRows, tap } = await setupCard();
      const original = api.editMessageText;
      (api as any).editMessageText = async () => {
        throw new Error('telegram down');
      };
      try {
        await expect(tap(liabilities[0]!.id, 'p', text, keyboardRows)).resolves.toBeUndefined();
      } finally {
        (api as any).editMessageText = original;
      }

      expect((await getLiability(USER, liabilities[0]!.id))?.paidMonths).toEqual([month]);
    });
  });

  it('проверка списаний: прошлый месяц даёт тост без записей', async () => {
    await routeCallback(cb('lrev:7:2000-01:p'));

    expect(String(answers()[0]?.text)).toContain('не текущий месяц');
    expect(await kvGet(liabilityReviewKey(USER, 7, '2000-01'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------

describe('splitLines', () => {
  it('делит как Python str.splitlines()', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\r\nc')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a\n')).toEqual(['a', '']);
  });
});

// ---------------------------------------------------------------------------
// /skills (MU-6…MU-9)
// ---------------------------------------------------------------------------

const SKILL_TEXT = [
  '## When to Use',
  'Когда агент повторяет вызов инструмента с неверными аргументами.',
  '',
  '## Procedure',
  '1. Прочитай описание инструмента.',
  '2. Проверь обязательные поля.',
  '',
  '## Pitfalls',
  '- Не повторять тот же вызов без изменений.',
  '',
  '## Verification',
  '- Вызов вернул данные.',
].join('\n');

async function seedSkill(version = 1): Promise<number> {
  const item = await addItem(USER, {
    rawInput: 'Сигнатура: agent|none|tool_error|search_notes',
    title: `Скилл: agent-tool-error-search-notes v${version}`,
    category: 'skill',
    spec: buildSkillSpec({
      key: 'agent-tool-error-search-notes',
      version,
      originFailure: 'agent|none|tool_error|search_notes',
      supersedes: null,
      body: SKILL_TEXT,
    }),
  });
  return item.id;
}

describe('routeMessage: /skills', () => {
  it('пустой список показывает встроенные .md-скиллы, стиль и подсказку про SQLite-процедуры', async () => {
    await routeMessage(msg('/skills'));
    const text = sentTexts()[0] ?? '';
    expect(text).toContain('Скиллы и поведение');
    expect(text).toContain('inbox-triage');
    expect(text).toContain('daily-focus');
    expect(text).toContain('черновиков и активных процедур пока нет');
    expect(callsOf('sendMessage')[0]?.params.reply_markup).toBeUndefined();
  });

  it('список печатает номер, версию, статус, числа с оговоркой и inline-кнопки для pending', async () => {
    const id = await seedSkill();
    await routeMessage(msg('/skills'));

    const text = sentTexts()[0] ?? '';
    expect(text).toContain(`#${id}`);
    expect(text).toContain('agent-tool-error-search-notes');
    expect(text).toContain('v1');
    expect(text).toContain('ожидает решения');
    expect(text).toContain('применений: 0, просмотров: 0');
    expect(text).toContain('совместную встречаемость');
    expect(text).not.toMatch(/качеств|улучшил/i);

    const markup = callsOf('sendMessage')[0]?.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    expect(markup.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
      `skills:show:${id}`,
      `skills:activate:${id}`,
      `skills:reject:${id}`,
    ]);
  });

  it('/skills show печатает полный текст и растит только счётчик просмотров', async () => {
    const id = await seedSkill();
    await routeMessage(msg(`/skills show ${id}`));
    await routeMessage(msg(`/skills show ${id}`));

    const [first, second] = sentTexts();
    expect(first).toContain('When to Use');
    expect(first).toContain('Verification');
    expect(first).toContain('Не повторять тот же вызов без изменений');
    expect(second).toContain('просмотров: 2');
    // Просмотр — не применение.
    expect(second).toContain('применений: 0');
  });

  it('/skills activate включает скилл и говорит про следующий прогон', async () => {
    const id = await seedSkill();
    await routeMessage(msg(`/skills activate ${id}`));

    expect(sentTexts()[0]).toContain('Включено');
    expect(sentTexts()[0]).toContain('agent-tool-error-search-notes');
    expect(sentTexts()[0]).toContain('следующего прогона');

    await routeMessage(msg('/skills'));
    expect(sentTexts()[1]).toContain('включён');
  });

  it('/skills reject отключает черновик', async () => {
    const id = await seedSkill();
    await routeMessage(msg(`/skills reject ${id}`));

    expect(sentTexts()[0]).toContain('отклонён');
    await routeMessage(msg('/skills'));
    expect(sentTexts()[1]).toContain('отклонён');
  });

  it('inline-колбэки skills:show / skills:activate / skills:reject / skills:home работают без ручного ввода ID', async () => {
    const id = await seedSkill();

    await routeCallback(cb(`skills:show:${id}`));
    expect(editedTexts()[0]).toContain('When to Use');
    const detailMarkup = callsOf('editMessageText')[0]?.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    expect(detailMarkup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      `skills:activate:${id}`,
      `skills:reject:${id}`,
      'skills:home',
    ]);

    resetApi();
    await routeCallback(cb(`skills:activate:${id}`, {
      message: {
        message_id: 77,
        chat: { id: CHAT },
        text: 'card',
        reply_markup: { inline_keyboard: [[{ text: 'back', callback_data: 'skills:home' }]] },
      },
    }));
    expect((await getItem(USER, id))?.status).toBe('active');
    expect(editedTexts()[0]).toContain('включён');

    resetApi();
    await routeCallback(cb('skills:home'));
    expect(editedTexts()[0]).toContain('Скиллы и поведение');

    resetApi();
    await routeCallback(cb(`skills:reject:${id}`, {
      message: {
        message_id: 77,
        chat: { id: CHAT },
        text: 'draft created',
      },
    }));
    expect((await getItem(USER, id))?.status).toBe('rejected');
    expect(editedTexts()[0]).toContain(`🚫 Скилл #${id} отклонён.`);
  });

  it('чужая строка и неизвестная подкоманда не включают ничего', async () => {
    await routeMessage(msg('/skills activate 999'));
    expect(sentTexts()[0]).toContain('не найден');

    resetApi();
    await routeMessage(msg('/skills qwerty'));
    expect(sentTexts()[0]).toContain('Как пользоваться скиллами');
  });

  it('справка объясняет, что включение только явное', async () => {
    const help = helpText();
    expect(help).toContain('/skills');
    expect(help).toContain('/skills activate');
    expect(help).toContain('только явно');
  });
});
