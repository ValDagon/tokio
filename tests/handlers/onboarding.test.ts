/**
 * T14 — доступ и первый контакт (`WhitelistMiddleware` + `/start`).
 *
 * Фиксируем правила безопасности (fail-closed в production, администратор
 * входит всегда, пустой список вне production открыт), «первый контакт»
 * профиля (имя не перезаписывается), нейтральность текстов (никакой модели
 * и никаких личных данных) и что выбор валюты не пишет в БД мусор.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { ensureUser, getUser, updateUser } from '../../src/lib/dal/users';

import {
  ACCESS_DENIED_ALERT,
  ACCESS_DENIED_MESSAGE,
  ACCESS_UNCONFIGURED_ALERT,
  ACCESS_UNCONFIGURED_MESSAGE,
  BASE_CURRENCIES,
  BASE_CURRENCY_CALLBACK_PREFIX,
  applyMenuButton,
  baseCurrencyKeyboard,
  baseCurrencyPromptText,
  byokInvitationText,
  checkAccess,
  createPresetAccounts,
  createSampleNote,
  createSampleTask,
  ensureUserProfile,
  exitOnboarding,
  getWizardStepContent,
  isProduction,
  MENU_BUTTON_TEXT,
  onboardingIntroText,
  onboardingPromptKeyboard,
  onboardingPromptText,
  parseBaseCurrencyChoice,
  restartOnboarding,
  sendOnboardingIntro,
  sendOnboardingPrompt,
  sendStartGreeting,
  sendWizardStep,
  setBaseCurrency,
  skipOnboarding,
  startWelcomeText,
  stepGeminiText,
} from '../../src/handlers/onboarding';
import {
  resetOverlayOverride,
  setOverlayOverride,
  type OverlayOverride,
} from '../../src/lib/overlay';
import { getMainKeyboard } from '../../src/handlers/keyboards';
import { listAccounts } from '../../src/lib/dal/finances';
import { listNotes } from '../../src/lib/dal/notes';
import { listTasks } from '../../src/lib/dal/tasks';
import { routeCallback } from '../../src/handlers/router';

const USER = 101;
const OTHER = 202;
const ADMIN = 999;
const WEBAPP = 'https://mini.example.com/app';

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetConfigCache();
  vi.unstubAllEnvs();
  vi.stubEnv('APP_ENV', '');
  vi.stubEnv('WEBAPP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Режим запуска
// ---------------------------------------------------------------------------

describe('isProduction', () => {
  it('APP_ENV=production / prod (с пробелами и регистром)', () => {
    vi.stubEnv('APP_ENV', ' Production ');
    expect(isProduction()).toBe(true);
    vi.stubEnv('APP_ENV', 'PROD');
    expect(isProduction()).toBe(true);
  });

  it('NODE_ENV=production учитывается, когда APP_ENV пуст', () => {
    expect(isProduction()).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    // APP_ENV === '' — не nullish, поэтому решает именно он; проверяем паритет:
    expect(isProduction()).toBe(false);

    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'production');
    expect(isProduction()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Доступ
// ---------------------------------------------------------------------------

describe('checkAccess', () => {
  it('пустой список вне production — открыто', async () => {
    await expect(checkAccess(USER, { kind: 'message' })).resolves.toEqual({ allowed: true });
  });

  it('пустой список в production — fail-closed, для callback алертом', async () => {
    vi.stubEnv('APP_ENV', 'production');
    await expect(checkAccess(USER, { kind: 'message' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_UNCONFIGURED_MESSAGE,
    });
    await expect(checkAccess(USER, { kind: 'callback' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_UNCONFIGURED_ALERT,
      alert: true,
    });
  });

  it('непустой список пускает только своих', async () => {
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [] });

    await expect(checkAccess(USER, { kind: 'message' })).resolves.toEqual({ allowed: true });
    await expect(checkAccess(OTHER, { kind: 'message' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_DENIED_MESSAGE,
    });
    await expect(checkAccess(OTHER, { kind: 'callback' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_DENIED_ALERT,
      alert: true,
    });
  });

  it('администратор входит без беты', async () => {
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [ADMIN] });
    await expect(checkAccess(ADMIN, { kind: 'message' })).resolves.toEqual({ allowed: true });
  });

  it('непустой список работает и в production', async () => {
    vi.stubEnv('APP_ENV', 'production');
    setConfigOverrides({ betaWhitelist: [], adminIds: [ADMIN] });
    await expect(checkAccess(ADMIN, { kind: 'callback' })).resolves.toEqual({ allowed: true });
  });

  it('пользователь из таблицы users пускается даже если не в betaWhitelist/adminIds', async () => {
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [] });
    await ensureUser(OTHER, 'Одобренный пользователь');
    await expect(checkAccess(OTHER, { kind: 'message' })).resolves.toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Профиль
// ---------------------------------------------------------------------------

describe('ensureUserProfile', () => {
  it('первый контакт создаёт строку с именем', async () => {
    const { user, isNew } = await ensureUserProfile(USER, 'Алекс');
    expect(isNew).toBe(true);
    expect(user.id).toBe(USER);
    expect(user.name).toBe('Алекс');
    expect(user.baseCurrency).toBe('EUR');
  });

  it('повторный вход не перезаписывает сохранённое имя', async () => {
    await ensureUserProfile(USER, 'Алекс');
    const { user, isNew } = await ensureUserProfile(USER, 'Другое имя');
    expect(isNew).toBe(false);
    expect(user.name).toBe('Алекс');
  });
});

// ---------------------------------------------------------------------------
// Базовая валюта
// ---------------------------------------------------------------------------

describe('базовая валюта', () => {
  it('клавиатура — по три кода в ряд, callback с префиксом', () => {
    const rows = baseCurrencyKeyboard().inline_keyboard;
    expect(rows).toHaveLength(Math.ceil(BASE_CURRENCIES.length / 3));
    expect(rows[0]).toEqual([
      { text: 'EUR', callback_data: `${BASE_CURRENCY_CALLBACK_PREFIX}EUR` },
      { text: 'USD', callback_data: `${BASE_CURRENCY_CALLBACK_PREFIX}USD` },
      { text: 'GBP', callback_data: `${BASE_CURRENCY_CALLBACK_PREFIX}GBP` },
    ]);
    expect(rows.flat()).toHaveLength(BASE_CURRENCIES.length);
  });

  it('parseBaseCurrencyChoice: валидный код нормализуется, остальное — null', () => {
    expect(parseBaseCurrencyChoice(`${BASE_CURRENCY_CALLBACK_PREFIX} eur `)).toBe('EUR');
    expect(parseBaseCurrencyChoice(`${BASE_CURRENCY_CALLBACK_PREFIX}xxx`)).toBeNull();
    expect(parseBaseCurrencyChoice('undo:task:1')).toBeNull();
    expect(parseBaseCurrencyChoice(null)).toBeNull();
    expect(parseBaseCurrencyChoice(undefined)).toBeNull();
  });

  it('setBaseCurrency обновляет существующего пользователя', async () => {
    await ensureUserProfile(USER);
    const updated = await setBaseCurrency(USER, ' rsd ');
    expect(updated?.baseCurrency).toBe('RSD');
    expect((await getUser(USER))?.baseCurrency).toBe('RSD');
  });

  it('setBaseCurrency создаёт отсутствующего пользователя', async () => {
    expect(await getUser(USER)).toBeNull();
    const updated = await setBaseCurrency(USER, 'GBP');
    expect(updated?.baseCurrency).toBe('GBP');
    expect((await getUser(USER))?.baseCurrency).toBe('GBP');
  });

  it('невалидный код — null и никаких записей в БД', async () => {
    await ensureUserProfile(USER);
    expect(await setBaseCurrency(USER, 'XXX')).toBeNull();
    expect((await getUser(USER))?.baseCurrency).toBe('EUR');
    expect(await setBaseCurrency(OTHER, 'BTC')).toBeNull();
    expect(await getUser(OTHER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

describe('тексты онбординга', () => {
  it('приветствие сразу говорит про обычный язык, голос и фото, а не про команды', () => {
    const text = startWelcomeText();
    expect(text).toContain('Tokio');
    expect(text).toMatch(/Голосом/);
    expect(text).toMatch(/Фото/);
    expect(text).not.toContain('/ask <');
    expect(text).not.toContain('/status —');
    expect(text).not.toMatch(/gemini/i);
  });

  it('знакомство объясняет живое общение и не тянет свой ключ в базовый поток', () => {
    const text = onboardingIntroText();
    expect(text).toContain('Мы ещё не знакомы');
    expect(text).not.toContain(byokInvitationText());
    expect(text).not.toMatch(/BYOK/);
    expect(text).not.toMatch(/gemini/i);
  });

  it('упоминание своего ключа — понятная опция без жаргона и синтаксиса команды', () => {
    const text = byokInvitationText();
    expect(text).toMatch(/зашифрован/);
    expect(text).toMatch(/по желанию/i);
    expect(text).not.toMatch(/BYOK/);
    expect(text).not.toMatch(/<[^>]*ключ[^>]*>/i);
  });

  it('ни в одном тексте нет персональных или захардкоженных маркеров инстанса', () => {
    const all = [
      startWelcomeText(),
      onboardingIntroText(),
      byokInvitationText(),
      baseCurrencyPromptText(),
    ].join('\n');
    expect(all).not.toMatch(/app\d{10}\.tgcloud\.ai/);
    expect(all).not.toMatch(/\/Users\/[a-zA-Z0-9._-]+\//);
    expect(all).not.toMatch(/\bF[24]\d\.\d\b/);
    expect(all).not.toMatch(/@gmail\.com/i);
  });
});

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------

describe('отправка онбординга', () => {
  it('sendOnboardingIntro без выбора валюты — один текст и свёрнутая клавиатура', async () => {
    await sendOnboardingIntro(USER);
    const [call] = callsOf('sendMessage');
    expect(call?.params.chat_id).toBe(USER);
    expect(call?.params.text).toContain('Мы ещё не знакомы');
    expect(call?.params.text).not.toContain('Выбери базовую валюту');
    // Сетку разделов показывает только `/start`/`/menu`; интро — обычный ответ.
    expect(call?.params.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('sendOnboardingIntro с валютой — просьба и клавиатура выбора', async () => {
    await sendOnboardingIntro(USER, { withCurrencyPrompt: true });
    const [call] = callsOf('sendMessage');
    expect(call?.params.text).toContain('Мы ещё не знакомы');
    expect(call?.params.text).toContain('Выбери базовую валюту');
    expect(call?.params.reply_markup).toEqual(baseCurrencyKeyboard());
  });
});

describe('кнопка меню', () => {
  it('без WEBAPP_URL ничего не делает', async () => {
    await applyMenuButton(USER);
    expect(callsOf('setChatMenuButton')).toHaveLength(0);
  });

  it('с WEBAPP_URL ставит web_app-кнопку', async () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    await applyMenuButton(USER);
    const [call] = callsOf('setChatMenuButton');
    expect(call?.params).toEqual({
      chat_id: USER,
      menu_button: { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url: WEBAPP } },
    });
  });
});

describe('sendStartGreeting', () => {
  it('без знакомства — только приветствие с основной клавиатурой', async () => {
    await sendStartGreeting(USER);
    const sends = callsOf('sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.params.text).toContain('Привет');
    expect(sends[0]?.params.text).toContain('Голосом');
    expect(sends[0]?.params.reply_markup).toEqual(getMainKeyboard());
  });

  it('с знакомством — приветствие, затем интро с выбором валюты', async () => {
    await sendStartGreeting(USER, { withIntro: true });
    const sends = callsOf('sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.params.text).toContain('Выбери базовую валюту');
    expect(sends[1]?.params.reply_markup).toEqual(baseCurrencyKeyboard());
  });
});

// ---------------------------------------------------------------------------
// Мастер первичной настройки (Onboarding Wizard)
// ---------------------------------------------------------------------------

describe('Мастер первичной настройки (Onboarding Wizard)', () => {
  function cb(data: string, userId = USER, messageId = 777) {
    return {
      id: `cb_${Date.now()}_${Math.random()}`,
      from: { id: userId, first_name: 'Тестер' },
      data,
      message: { message_id: messageId, chat: { id: userId } },
    };
  }

  describe('Экран приветствия и развилка «Обучение / Пропуск»', () => {
    it('sendOnboardingPrompt отправляет вопрос с кнопками «Пройти» и «Пропустить»', async () => {
      await sendOnboardingPrompt(USER);
      const [call] = callsOf('sendMessage');
      expect(call?.params.chat_id).toBe(USER);
      expect(call?.params.text).toContain('Пройти короткое знакомство (2 минуты)');
      expect(call?.params.reply_markup).toEqual(onboardingPromptKeyboard());
    });

    it('onboard:skip переводит пользователя в skipped и выставляет onboarding_completed_at', async () => {
      await ensureUserProfile(USER);
      await routeCallback(cb('onboard:skip'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('skipped');
      expect(user?.onboardingCompletedAt).not.toBeNull();

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Знакомство пропущено');
    });

    it('onboard:exit переводит пользователя в completed', async () => {
      await ensureUserProfile(USER);
      await routeCallback(cb('onboard:exit'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('completed');
      expect(user?.onboardingCompletedAt).not.toBeNull();

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Мастер настройки закрыт');
    });
  });

  describe('Шаги мастера и переходы', () => {
    it('onboard:step:overview запускает шаг 1 с обзором возможностей', async () => {
      await ensureUserProfile(USER);
      await routeCallback(cb('onboard:step:overview'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('overview');

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Шаг 1 из 7: Возможности Tokio');
      expect(edits[0]?.params.text).toContain('Фокус 1+3');
    });

    it('onboard:tz:Europe/Berlin сохраняет часовой пояс и переходит к шагу валюты', async () => {
      await ensureUserProfile(USER);
      await routeCallback(cb('onboard:tz:Europe/Berlin'));

      const user = await getUser(USER);
      expect(user?.timezone).toBe('Europe/Berlin');
      expect(user?.onboardingStep).toBe('currency');

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Шаг 3 из 7: Базовая валюта');
    });

    it('onboard:currency:USD в мастере сохраняет валюту и переходит к шагу счетов', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'currency' });

      await routeCallback(cb('onboard:currency:USD'));

      const user = await getUser(USER);
      expect(user?.baseCurrency).toBe('USD');
      expect(user?.onboardingStep).toBe('accounts');

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Шаг 4 из 7: Стартовые счета');
    });

    it('onboard:preset:cash_card создаёт счета и переходит к шагу практики', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'accounts' });

      await routeCallback(cb('onboard:preset:cash_card'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('practice');

      const accounts = await listAccounts(USER);
      expect(accounts.map((a) => a.name).sort()).toEqual(['Карта', 'Наличные'].sort());

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Шаг 5 из 7: Живая практика');
    });

    it('onboard:preset:full создаёт 3 счета', async () => {
      await ensureUserProfile(OTHER);
      const created = await createPresetAccounts(OTHER, 'full');
      expect(created).toEqual(['Карта', 'Накопительный', 'Крипта']);

      const accounts = await listAccounts(OTHER);
      expect(accounts).toHaveLength(3);
    });

    it('onboard:action:sample_task создаёт задачу и переходит к шагу уведомлений', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'practice' });

      await routeCallback(cb('onboard:action:sample_task'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('notifications');

      const tasks = await listTasks(USER);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toContain('Попробовать Tokio');

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Шаг 6 из 7: Утренний дайджест');
    });

    it('onboard:action:sample_note создаёт заметку в инбокс', async () => {
      await ensureUserProfile(OTHER);
      const msg = await createSampleNote(OTHER);
      expect(msg).toMatch(/первая мысль/i);

      const notes = await listNotes(OTHER);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.rawText).toContain('первая мысль');
    });

    it('onboard:time:08:00 сохраняет время дайджеста и переходит к шагу Gemini-ключа', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'notifications' });

      await routeCallback(cb('onboard:time:08:00'));

      const user = await getUser(USER);
      expect(user?.summaryTime).toBe('08:00');
      expect(user?.onboardingStep).toBe('gemini');

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Шаг 7 из 7: Как я отвечаю');
      expect(edits[0]?.params.text).toContain('$2');
      expect(edits[0]?.params.text).not.toMatch(/BYOK/);
      expect(edits[0]?.params.text).not.toContain('/byok <');
    });

    it('onboard:step:final завершает онбординг и показывает финальный экран', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'gemini' });

      await routeCallback(cb('onboard:step:final'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('completed');
      expect(user?.onboardingCompletedAt).not.toBeNull();

      const edits = callsOf('editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.params.text).toContain('Знакомство завершено! Добро пожаловать');
    });
  });

  describe('Локализация мастера и agent-first фокус', () => {
    const CYRILLIC = /[\u0400-\u04FF]/;
    const STEPS = [
      'overview',
      'timezone',
      'currency',
      'accounts',
      'practice',
      'notifications',
      'gemini',
      'final',
    ] as const;

    afterEach(() => {
      resetOverlayOverride();
    });

    it('мастер на en/sr/ja полностью без кириллицы — и текст, и кнопки', async () => {
      for (const loc of ['en', 'sr', 'ja'] as const) {
        await ensureUser(OTHER, 'Tester');
        await updateUser(OTHER, { language: loc });
        const user = await getUser(OTHER);
        expect(user).not.toBeNull();

        for (const step of STEPS) {
          const { text, keyboard } = getWizardStepContent(step, user!);
          expect(text, `${loc}.${step} text`).not.toMatch(CYRILLIC);
          const labels = keyboard.inline_keyboard.flat().map((b) => b.text).join(' ');
          expect(labels, `${loc}.${step} buttons`).not.toMatch(CYRILLIC);
        }
      }
    });

    it('приветствие и знакомство в 4 локалях тоже без кириллицы вне ru', () => {
      for (const loc of ['en', 'sr', 'ja'] as const) {
        expect(startWelcomeText(loc), `${loc} welcome`).not.toMatch(CYRILLIC);
        expect(onboardingIntroText(loc), `${loc} intro`).not.toMatch(CYRILLIC);
        expect(byokInvitationText(loc), `${loc} key`).not.toMatch(CYRILLIC);
      }
    });

    it('стартовый экран учит обычному языку, а не заучиванию slash-команд', () => {
      for (const loc of ['ru', 'en', 'sr', 'ja'] as const) {
        const text = startWelcomeText(loc);
        expect(text).toMatch(/\/help/);
        expect(text).not.toContain('/status');
        expect(text).not.toContain('/balance');
        expect(text).not.toContain('/tasks');
        expect(text).not.toContain('/ask');
      }
    });

    it('шаг 7 не содержит BYOK-жаргона и синтаксиса команды', () => {
      for (const loc of ['ru', 'en', 'sr', 'ja'] as const) {
        const text = stepGeminiText(loc);
        expect(text).not.toMatch(/BYOK/);
        expect(text).not.toContain('/byok <');
      }
    });

    it('свой ключ упоминается только при включённом byokCommand', () => {
      expect(stepGeminiText('ru')).toMatch(/свой ключ/i);

      setOverlayOverride({ manifest: { features: { byokCommand: false } } } as unknown as OverlayOverride);
      const text = stepGeminiText('ru');
      expect(text).not.toMatch(/свой ключ/i);
      expect(text).not.toContain('/help');
    });

    it('приветственный лимит показывается только при включённом spendLimitEnabled', () => {
      expect(stepGeminiText('ru')).toContain('$2');

      setOverlayOverride({ manifest: { features: { spendLimitEnabled: false } } } as unknown as OverlayOverride);
      expect(stepGeminiText('ru')).not.toContain('$2');
    });

    it('язык из users.language управляет мастером', async () => {
      await ensureUser(OTHER, 'Tester');
      await updateUser(OTHER, { language: 'ja' });
      const user = await getUser(OTHER);
      const { text } = getWizardStepContent('overview', user!);
      expect(text).toContain('ステップ 1 / 7');
    });

    it('стартовые счета создаются на языке пользователя', async () => {
      await ensureUser(OTHER, 'Tester');
      await updateUser(OTHER, { language: 'en' });

      const created = await createPresetAccounts(OTHER, 'full');
      expect(created).toEqual(['Card', 'Savings', 'Crypto']);
      const accounts = await listAccounts(OTHER);
      expect(accounts.map((a) => a.name).sort()).toEqual(['Card', 'Crypto', 'Savings'].sort());
    });
  });

  describe('Прерывание, сохранение в БД и продолжение', () => {
    it('состояние шага в БД сохраняется между сессиями', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'currency' });

      const reloaded = await getUser(USER);
      expect(reloaded?.onboardingStep).toBe('currency');
    });

    it('onboard:restart перезапускает мастер с шага 1', async () => {
      await ensureUserProfile(USER);
      await updateUser(USER, { onboardingStep: 'completed' });

      await routeCallback(cb('onboard:restart'));

      const user = await getUser(USER);
      expect(user?.onboardingStep).toBe('overview');

      const edits = callsOf('editMessageText');
      expect(edits[edits.length - 1]?.params.text).toContain('Шаг 1 из 7: Возможности Tokio');
    });
  });
});
