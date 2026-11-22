/**
 * Системные тесты швов (TDD):
 *  1. Регистрация нового пользователя: приветствие + «Пройти обучение или пропустить?».
 *  2. Пропуск онбординга (флаг skipped, мгновенный доступ к боту).
 *  3. Пошаговое прохождение всех шагов (overview -> timezone -> currency -> accounts -> practice -> notifications -> gemini -> final).
 *  4. Прерывание и продолжение (сохранение в SQLite).
 *  5. Перезапуск обучения из команды /help и условная поддержка из overlay.
 *  6. Лимит расхода $2.00 USD на пользователя общего ключа.
 *  7. Исключения из лимита: админ (adminIds), пользователь с BYOK-ключом, spendLimitEnabled: false.
 *  8. Системный аудит векторов ввода при исчерпании лимита (текст, голос, фото, /ask, /byok).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOf, resetApi, resetDb, sqliteDDL } from './mocks/sdk';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { ensureUser, getUser } from '../src/lib/dal/users';
import { listAccounts } from '../src/lib/dal/finances';
import { listNotes } from '../src/lib/dal/notes';
import { listTasks } from '../src/lib/dal/tasks';
import {
  checkSpendLimit,
  DEFAULT_USER_SPEND_LIMIT_MICROS,
  recordUsage,
  SPEND_LIMIT_EXCEEDED_MESSAGE,
} from '../src/lib/billing';
import { resetOverlayOverride, setOverlayOverride, type OverlayOverride } from '../src/lib/overlay';
import { resetRouterSeams, routeCallback, routeMessage, setTextIngestHandler } from '../src/handlers/router';
import { smartIngest } from '../src/handlers/ingest';
import type { Message } from '../src/handlers/message';

const USER_ID = 2001;
const ADMIN_ID = 9001;
const BYOK_USER_ID = 3001;

function msg(text: string | null, overrides: Partial<Message> = {}): Message {
  const fromId = (overrides.from?.id as number) ?? USER_ID;
  return {
    message_id: 100,
    chat: { id: fromId },
    from: { id: fromId, first_name: 'Тестер' },
    date: Math.floor(Date.now() / 1000),
    ...(text !== null ? { text } : {}),
    ...overrides,
  };
}

function cb(data: string, userId = USER_ID, messageId = 100) {
  return {
    id: `cb_${Date.now()}_${Math.random()}`,
    from: { id: userId, first_name: 'Тестер' },
    data,
    message: { message_id: messageId, chat: { id: userId } },
  };
}

function sentTexts(): string[] {
  return callsOf('sendMessage').map((c) => String(c.params.text ?? ''));
}

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetRouterSeams();
  resetConfigCache();
  setConfigOverrides({ betaWhitelist: [], adminIds: [] });
  setTextIngestHandler(smartIngest);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. Старт и первичная регистрация
// ---------------------------------------------------------------------------

describe('1. Регистрация нового пользователя', () => {
  it('при первом старте бот отправляет приветствие и вопрос «Пройти обучение или пропустить?»', async () => {
    await routeMessage(msg('/start', { from: { id: 7001, first_name: 'Алиса' } }));

    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('твой личный ассистент');
    expect(texts[1]).toContain('Пройти короткое знакомство (2 минуты)');

    const calls = callsOf('sendMessage');
    expect(calls[1]?.params.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🚀 Пройти знакомство', callback_data: 'onboard:step:overview' }],
        [{ text: '⏩ Пропустить', callback_data: 'onboard:skip' }],
      ],
    });

    const user = await getUser(7001);
    expect(user).not.toBeNull();
    expect(user?.onboardingStep).toBe('new');
  });

  it('нажатие кнопки «Пропустить» ставит флаг skipped, бот сразу готов к работе', async () => {
    await routeMessage(msg('/start', { from: { id: 7002, first_name: 'Боб' } }));
    await routeCallback(cb('onboard:skip', 7002));

    const user = await getUser(7002);
    expect(user?.onboardingStep).toBe('skipped');
    expect(user?.onboardingCompletedAt).not.toBeNull();

    const edits = callsOf('editMessageText');
    expect(edits[0]?.params.text).toContain('Знакомство пропущено. Tokio готов к работе!');

    // Последующие сообщения работают сразу без перехвата мастером
    callsOf('sendMessage').length = 0;
    await routeMessage(msg('простая мысль', { from: { id: 7002 } }));
    expect(sentTexts()[0]).not.toContain('Пройти знакомство');
  });
});

// ---------------------------------------------------------------------------
// 2. Пошаговое прохождение мастера онбординга
// ---------------------------------------------------------------------------

describe('2. Пошаговое прохождение всех шагов мастера', () => {
  it('проходит все 7 шагов до финального экрана с сохранением каждого шага в БД', async () => {
    const ID = 7003;
    await routeMessage(msg('/start', { from: { id: ID } }));

    // Шаг 1: Overview
    await routeCallback(cb('onboard:step:overview', ID));
    expect((await getUser(ID))?.onboardingStep).toBe('overview');
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 1 из 7: Возможности Tokio');

    // Шаг 2: Выбор часового пояса
    await routeCallback(cb('onboard:tz:Europe/Berlin', ID));
    expect((await getUser(ID))?.timezone).toBe('Europe/Berlin');
    expect((await getUser(ID))?.onboardingStep).toBe('currency');
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 3 из 7: Базовая валюта');

    // Шаг 3: Выбор базовой валюты
    await routeCallback(cb('onboard:currency:EUR', ID));
    expect((await getUser(ID))?.baseCurrency).toBe('EUR');
    expect((await getUser(ID))?.onboardingStep).toBe('accounts');
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 4 из 7: Стартовые счета');

    // Шаг 4: Выбор стартовых счетов (пресет Наличные + Карта)
    await routeCallback(cb('onboard:preset:cash_card', ID));
    expect((await getUser(ID))?.onboardingStep).toBe('practice');
    const accs = await listAccounts(ID);
    expect(accs.map((a) => a.name).sort()).toEqual(['Карта', 'Наличные'].sort());
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 5 из 7: Живая практика');

    // Шаг 5: Создание тестовой задачи
    await routeCallback(cb('onboard:action:sample_task', ID));
    expect((await getUser(ID))?.onboardingStep).toBe('notifications');
    const tasks = await listTasks(ID);
    expect(tasks).toHaveLength(1);
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 6 из 7: Утренний дайджест');

    // Шаг 6: Время утреннего дайджеста
    await routeCallback(cb('onboard:time:08:00', ID));
    expect((await getUser(ID))?.summaryTime).toBe('08:00');
    expect((await getUser(ID))?.onboardingStep).toBe('gemini');
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 7 из 7: Как я отвечаю');

    // Шаг 7 -> Финал
    await routeCallback(cb('onboard:step:final', ID));
    const finalUser = await getUser(ID);
    expect(finalUser?.onboardingStep).toBe('completed');
    expect(finalUser?.onboardingCompletedAt).not.toBeNull();
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Знакомство завершено! Добро пожаловать в Tokio!');
  });

  it('кнопка выхода закрывает мастер и сохраняет completed', async () => {
    const ID = 7004;
    await routeMessage(msg('/start', { from: { id: ID } }));
    await routeCallback(cb('onboard:step:overview', ID));
    await routeCallback(cb('onboard:exit', ID));

    const user = await getUser(ID);
    expect(user?.onboardingStep).toBe('completed');
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Мастер настройки закрыт');
  });
});

// ---------------------------------------------------------------------------
// 3. Прерывание, сохранение в БД и перезапуск из Помощи
// ---------------------------------------------------------------------------

describe('3. Прерывание и перезапуск из /help', () => {
  it('при прерывании состояние сохраняется в SQLite', async () => {
    const ID = 7005;
    await routeMessage(msg('/start', { from: { id: ID } }));
    await routeCallback(cb('onboard:step:overview', ID));
    await routeCallback(cb('onboard:tz:Asia/Dubai', ID));

    const user = await getUser(ID);
    expect(user?.timezone).toBe('Asia/Dubai');
    expect(user?.onboardingStep).toBe('currency');
  });

  it('команда /help содержит инлайн-кнопку повторного обучения и поддержку только при заданном supportContact', async () => {
    await ensureUser(USER_ID);
    await routeMessage(msg('/help'));

    const texts = sentTexts();
    expect(texts[0]).toContain('/byok');

    const calls = callsOf('sendMessage');
    expect(calls[0]?.params.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🚀 Пройти знакомство заново', callback_data: 'onboard:restart' }],
      ],
    });

    resetApi();
    setOverlayOverride({ manifest: { brand: { supportContact: '@support_demo' } } } as unknown as OverlayOverride);
    try {
      await routeMessage(msg('/help'));
      expect(sentTexts()[0]).toContain('@support_demo');
      expect(callsOf('sendMessage')[0]?.params.reply_markup).toEqual({
        inline_keyboard: [
          [{ text: '🚀 Пройти знакомство заново', callback_data: 'onboard:restart' }],
          [{ text: '💬 Написать разработчику (@support_demo)', url: 'https://t.me/support_demo' }],
        ],
      });
    } finally {
      resetOverlayOverride();
    }
  });

  it('onboard:restart заново переводит пользователя на шаг overview', async () => {
    await ensureUser(USER_ID);
    await routeCallback(cb('onboard:restart', USER_ID));

    const user = await getUser(USER_ID);
    expect(user?.onboardingStep).toBe('overview');

    const sends = callsOf('sendMessage');
    expect(callsOf('editMessageText').pop()?.params.text).toContain('Шаг 1 из 7: Возможности Tokio');
  });
});

// ---------------------------------------------------------------------------
// 4. Лимит расхода $2.00 и исключения (Owner / Admin / BYOK)
// ---------------------------------------------------------------------------

describe('4. Лимит расхода 2 USD и исключения', () => {
  it('пользователь с расходом < $2.00 имеет allowed: true', async () => {
    await ensureUser(USER_ID);
    await recordUsage(USER_ID, { model: 'gemini-2.5-flash', costMicros: 1_000_000 });

    const status = await checkSpendLimit(USER_ID);
    expect(status.allowed).toBe(true);
    expect(status.remainingMicros).toBe(1_000_000);
  });

  it('пользователь с расходом >= $2.00 имеет allowed: false', async () => {
    await ensureUser(USER_ID);
    await recordUsage(USER_ID, { model: 'gemini-2.5-flash', costMicros: DEFAULT_USER_SPEND_LIMIT_MICROS });

    const status = await checkSpendLimit(USER_ID);
    expect(status.allowed).toBe(false);
    expect(status.reason).toBe('exhausted');
  });

  it('при spendLimitEnabled: false лимит отключён даже при большом расходе', async () => {
    setOverlayOverride({ manifest: { features: { spendLimitEnabled: false } } } as unknown as OverlayOverride);
    try {
      await ensureUser(USER_ID);
      await recordUsage(USER_ID, { model: 'gemini-2.5-flash', costMicros: 50_000_000 });

      const status = await checkSpendLimit(USER_ID);
      expect(status.allowed).toBe(true);
      expect(status.reason).toBe('disabled');
    } finally {
      resetOverlayOverride();
    }
  });

  it('админ из adminIds свободен от лимита', async () => {
    setConfigOverrides({ betaWhitelist: [], adminIds: [ADMIN_ID] });
    await ensureUser(ADMIN_ID);
    await recordUsage(ADMIN_ID, { model: 'gemini-2.5-flash', costMicros: 50_000_000 });

    const status = await checkSpendLimit(ADMIN_ID);
    expect(status.allowed).toBe(true);
    expect(status.isOwnerOrAdmin).toBe(true);
    expect(status.reason).toBe('admin');
  });

  it('пользователь с BYOK-ключом свободен от лимита', async () => {
    await ensureUser(BYOK_USER_ID);
    await recordUsage(BYOK_USER_ID, { model: 'gemini-2.5-flash', costMicros: 50_000_000 });

    // Подключаем ключ через /byok
    await routeMessage(
      msg('/byok AQ.TestDummyKeyForByokSanityCheck1234567890abcdef', {
        from: { id: BYOK_USER_ID },
      }),
    );

    const status = await checkSpendLimit(BYOK_USER_ID);
    expect(status.allowed).toBe(true);
    expect(status.hasByok).toBe(true);
    expect(status.reason).toBe('byok');
  });
});

// ---------------------------------------------------------------------------
// 5. Системный аудит векторов ввода при исчерпании лимита
// ---------------------------------------------------------------------------

describe('5. Системный аудит векторов ввода при исчерпании лимита', () => {
  beforeEach(async () => {
    await ensureUser(USER_ID);
    // Доводим расход до исчерпания лимита
    await recordUsage(USER_ID, { model: 'gemini-2.5-flash', costMicros: DEFAULT_USER_SPEND_LIMIT_MICROS });
  });

  it('текстовое сообщение: сохраняется напрямую в заметки без сбоя и выдаёт предупреждение о лимите', async () => {
    await routeMessage(msg('заметка после исчерпания лимита'));

    const notes = await listNotes(USER_ID);
    expect(notes.some((n) => n.rawText.includes('заметка после исчерпания лимита'))).toBe(true);

    const texts = sentTexts();
    expect(texts[0]).toContain('Лимит бесплатного использования ($2.00) исчерпан');
  });

  it('голосовое сообщение: выдаёт понятное сообщение о лимите без исключений', async () => {
    await routeMessage(
      msg(null, {
        voice: { file_id: 'voice_123', duration: 10 },
      }),
    );

    const texts = sentTexts();
    expect(texts[0]).toContain('Лимит бесплатного использования ($2.00) исчерпан');
  });

  it('фото: сохраняется как #photo в заметки без Vision и выдаёт предупреждение', async () => {
    await routeMessage(
      msg(null, {
        photo: [{ file_id: 'photo_123', width: 800, height: 600 }],
        caption: 'чек из магазина',
      }),
    );

    const notes = await listNotes(USER_ID);
    expect(notes.some((n) => n.rawText.includes('#photo'))).toBe(true);

    const texts = sentTexts();
    expect(texts[0]).toContain('Лимит бесплатного использования ($2.00) исчерпан');
  });

  it('команда /ask: выдаёт понятное сообщение о лимите с предложением BYOK', async () => {
    await routeMessage(msg('/ask как дела?'));

    const texts = sentTexts();
    expect(texts[0]).toContain('Лимит бесплатного использования ($2.00) исчерпан');
    expect(texts[0]).toContain('/byok');
  });

  it('команда /byok сохраняет ключ и сразу восстанавливает доступ к AI', async () => {
    callsOf('sendMessage').length = 0;

    await routeMessage(
      msg('/byok AQ.TestDummyKeyForByokSanityCheck1234567890abcdef', { from: { id: USER_ID } }),
    );

    const texts = sentTexts();
    expect(texts[0]).toContain('Ключ Google Gemini API успешно сохранён и зашифрован');

    const limit = await checkSpendLimit(USER_ID);
    expect(limit.allowed).toBe(true);
    expect(limit.hasByok).toBe(true);
  });
});
