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
} from '../../src/handlers/onboarding';
import { getMainKeyboard } from '../../src/handlers/keyboards';
import {
  resetOverlayOverride,
  setOverlayOverride,
  type OverlayOverride,
} from '../../src/lib/overlay';
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
  resetOverlayOverride();
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

  it('publicOpenAccess: true открывает вход, даже когда списки пусты в production', async () => {
    vi.stubEnv('APP_ENV', 'production');
    setConfigOverrides({ betaWhitelist: [], adminIds: [] });
    setOverlayOverride({
      manifest: { features: { publicOpenAccess: true } },
    } as unknown as OverlayOverride);

    await expect(checkAccess(OTHER, { kind: 'message' })).resolves.toEqual({ allowed: true });
    await expect(checkAccess(OTHER, { kind: 'callback' })).resolves.toEqual({ allowed: true });
  });

  it('publicOpenAccess: true пускает неизвестного при непустом списке', async () => {
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [ADMIN] });
    setOverlayOverride({
      manifest: { features: { publicOpenAccess: true } },
    } as unknown as OverlayOverride);

    await expect(checkAccess(OTHER, { kind: 'message' })).resolves.toEqual({ allowed: true });
  });

  it('publicOpenAccess: false не ослабляет закрытый режим личного бота', async () => {
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [ADMIN] });
    setOverlayOverride({
      manifest: { features: { publicOpenAccess: false } },
    } as unknown as OverlayOverride);

    await expect(checkAccess(OTHER, { kind: 'message' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_DENIED_MESSAGE,
    });
  });

  it('отсутствие флага — это закрытый режим, а не открытый', async () => {
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [] });
    setOverlayOverride({
      manifest: { features: { publicOpenAccess: undefined } },
    } as unknown as OverlayOverride);

    await expect(checkAccess(OTHER, { kind: 'message' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_DENIED_MESSAGE,
    });
  });

  it('открытый режим нельзя включить переменной окружения', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PUBLIC_OPEN_ACCESS', 'true');
    setConfigOverrides({ betaWhitelist: [], adminIds: [] });

    await expect(checkAccess(USER, { kind: 'message' })).resolves.toEqual({
      allowed: false,
      reply: ACCESS_UNCONFIGURED_MESSAGE,
    });
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
  it('приветствие называет бота Tokio и не упоминает модель', () => {
    const text = startWelcomeText();
    expect(text).toContain('Tokio');
    expect(text).toContain('/ask <вопрос>');
    expect(text).not.toMatch(/gemini/i);
  });

  it('знакомство содержит BYOK-приглашение и не упоминает модель', () => {
    const text = onboardingIntroText();
    expect(text).toContain(byokInvitationText());
    expect(text).not.toMatch(/gemini/i);
  });

  it('BYOK: ключ опционален и хранится зашифрованным', () => {
    const text = byokInvitationText();
    expect(text).toMatch(/зашифрован/);
    expect(text).toMatch(/общ/i);
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
    expect(sends[0]?.params.text).toContain('Как со мной общаться');
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
      expect(call?.params.text).toContain('Пройти обучение (2 минуты) или сразу приступить к работе?');
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
      expect(edits[0]?.params.text).toContain('Обучение пропущено');
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
      expect(edits[0]?.params.text).toContain('СДВГ-фокус');
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
      expect(msg).toContain('первая мысль');

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
      expect(edits[0]?.params.text).toContain('Шаг 7 из 7: ИИ-модель и Gemini-ключ');
      expect(edits[0]?.params.text).toContain('$2.00');
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
      expect(edits[0]?.params.text).toContain('Настройка завершена! Добро пожаловать');
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

      const sends = callsOf('sendMessage');
      expect(sends[sends.length - 1]?.params.text).toContain('Шаг 1 из 7: Возможности Tokio');
    });
  });
});
