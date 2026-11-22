import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callsOf, resetApi, resetDb, sqliteDDL } from './mocks/sdk';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';
import { ensureUser, getUser } from '../src/lib/dal/users';
import {
  formatLocaleDate,
  formatLocaleNumber,
  getAllKeyboardLabels,
  normalizeLocale,
  SUPPORTED_LOCALES,
  t,
  tPlural,
  type LocaleCode,
} from '../src/lib/i18n';
import { getMainKeyboard } from '../src/handlers/keyboards';
import { resetRouterSeams, routeCallback, routeMessage } from '../src/handlers/router';
import type { CallbackQuery, Message } from '../src/handlers/message';

function flattenKeys(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out[path] = v;
    } else if (v && typeof v === 'object') {
      flattenKeys(v, path, out);
    }
  }
  return out;
}

function extractPlaceholders(str: string): string[] {
  const matches = [...str.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(matches)].sort();
}

describe('locales parity and hygiene', () => {
  const localesDir = join(__dirname, '..', 'locales');
  const catalogs = Object.fromEntries(
    SUPPORTED_LOCALES.map((loc) => [
      loc,
      flattenKeys(JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf8'))),
    ]),
  ) as Record<LocaleCode, Record<string, string>>;

  it('all 4 locale files have 100% key parity, placeholder parity, and non-empty values', () => {
    const baseKeys = Object.keys(catalogs.ru).sort();
    expect(baseKeys.length).toBeGreaterThan(50);

    for (const loc of SUPPORTED_LOCALES) {
      const keys = Object.keys(catalogs[loc]).sort();
      expect(keys).toEqual(baseKeys);

      for (const key of baseKeys) {
        const val = catalogs[loc][key]!;
        expect(val.trim().length, `${loc}.${key} is empty`).toBeGreaterThan(0);
        expect(
          extractPlaceholders(val),
          `placeholder mismatch in ${loc}.${key}`,
        ).toEqual(extractPlaceholders(catalogs.ru[key]!));
      }
    }
  });

  it('en, sr, and ja catalogs contain zero Cyrillic characters', () => {
    for (const loc of ['en', 'sr', 'ja'] as const) {
      for (const [key, val] of Object.entries(catalogs[loc])) {
        expect(val, `Cyrillic found in ${loc}.${key}`).not.toMatch(/[а-яА-ЯёЁ]/);
      }
    }
  });

  it('onboarding wizard, prompts and callback toasts exist in all 4 locales', () => {
    const required = [
      'onboarding.startGreeting',
      'onboarding.introText',
      'onboarding.introOptionalKey',
      'onboarding.currencyPrompt',
      'onboarding.welcomePrompt',
      'onboarding.btnStart',
      'onboarding.btnSkip',
      'onboarding.btnSkipStep',
      'onboarding.btnExit',
      'onboarding.btnNext',
      'onboarding.stepOverview',
      'onboarding.stepOverviewBody',
      'onboarding.stepTimezone',
      'onboarding.stepTimezoneBody',
      'onboarding.stepCurrency',
      'onboarding.stepCurrencyBody',
      'onboarding.stepAccounts',
      'onboarding.stepAccountsBody',
      'onboarding.stepPractice',
      'onboarding.stepPracticeBody',
      'onboarding.stepNotifications',
      'onboarding.stepNotificationsBody',
      'onboarding.stepGemini',
      'onboarding.stepGeminiBody',
      'onboarding.modelSharedLimit',
      'onboarding.modelOwnKey',
      'onboarding.stepFinal',
      'onboarding.stepFinalBody',
      'onboarding.btnOpenApp',
      'onboarding.btnShowSummary',
      'onboarding.btnHelp',
      'onboarding.btnSampleTask',
      'onboarding.btnSampleNote',
      'onboarding.btnDemoSeed',
      'onboarding.btnPresetCashCard',
      'onboarding.btnPresetFull',
      'onboarding.accountCard',
      'onboarding.accountCash',
      'onboarding.accountSavings',
      'onboarding.accountCrypto',
      'onboarding.sampleTaskTitle',
      'onboarding.sampleNoteText',
      'onboarding.skippedText',
      'onboarding.exitedText',
      'onboarding.toastSkipped',
      'onboarding.toastExited',
      'onboarding.toastRestart',
      'onboarding.toastTimezone',
      'onboarding.toastCurrency',
      'onboarding.toastAccountsCreated',
      'onboarding.toastSampleTask',
      'onboarding.toastSampleNote',
      'onboarding.toastDemoSeed',
      'onboarding.toastDigestTime',
      'onboarding.currencySaved',
      'onboarding.actionResult',
    ];
    for (const loc of SUPPORTED_LOCALES) {
      for (const key of required) {
        expect(catalogs[loc][key], `missing ${loc}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('i18n helpers', () => {
  it('normalizeLocale maps Telegram language codes accurately', () => {
    expect(normalizeLocale('ru-RU')).toBe('ru');
    expect(normalizeLocale('uk')).toBe('ru');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('sr-Latn')).toBe('sr');
    expect(normalizeLocale('hr')).toBe('sr');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('de', 'en')).toBe('en');
    expect(normalizeLocale(null, 'ru')).toBe('ru');
  });

  it('t() translates and interpolates params', () => {
    expect(t('en', 'help.title', { assistantName: 'Tokio' })).toContain('Tokio');
    expect(t('ja', 'lang.updated', { language: '日本語' })).toContain('日本語');
    expect(t('ru', 'missing.key.xyz')).toBe('missing.key.xyz');
  });

  it('tPlural() handles 1, 2, 5, 21 across all 4 locales', () => {
    for (const loc of SUPPORTED_LOCALES) {
      for (const count of [1, 2, 5, 21]) {
        const res = tPlural(loc, 'plural.tasks', count);
        expect(res).toContain(String(count));
        expect(res).not.toContain('plural.tasks');
      }
    }
  });

  it('formatLocaleNumber() and formatLocaleDate() format values per locale', () => {
    expect(formatLocaleNumber('en', 1234.5)).toContain('1,234');
    const date = new Date('2026-11-06T12:00:00Z');
    expect(formatLocaleDate('en', date, 'UTC')).toContain('2026');
    expect(formatLocaleDate('ja', date, 'UTC')).toContain('2026');
  });

  it('getAllKeyboardLabels() returns all unique labels across 4 locales', () => {
    const labels = getAllKeyboardLabels('status');
    expect(labels.length).toBe(4);
    expect(labels).toContain('📊 Сводка');
  });
});

describe('/lang command and multi-locale reply keyboard routing', () => {
  const USER = 100001;
  const CHAT = 100001;

  function msg(text: string): Message {
    return {
      message_id: 1,
      chat: { id: CHAT, type: 'private' },
      from: { id: USER, first_name: 'Tester' },
      date: Math.floor(Date.now() / 1000),
      text,
    };
  }

  function cb(data: string): CallbackQuery {
    return {
      id: 'cb-lang-1',
      from: { id: USER, first_name: 'Tester' },
      data,
      message: { message_id: 1, chat: { id: CHAT } },
    };
  }

  beforeEach(async () => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetApi();
    resetConfigCache();
    resetRouterSeams();
    setConfigOverrides({ betaWhitelist: [USER], adminIds: [USER] });
    await ensureUser(USER, 'Tester');
  });

  afterEach(() => {
    resetConfigCache();
    resetRouterSeams();
  });

  it('/lang shows 4 language buttons and lang:<locale> updates users.language + keyboard', async () => {
    await routeMessage(msg('/lang'));
    const promptCalls = callsOf('sendMessage');
    expect(promptCalls).toHaveLength(1);
    const markup = promptCalls[0]!.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const callbacks = markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toEqual(['lang:ru', 'lang:en', 'lang:sr', 'lang:ja']);

    for (const loc of ['en', 'sr', 'ja'] as const) {
      resetApi();
      await routeCallback(cb(`lang:${loc}`));
      const updated = await getUser(USER);
      expect(updated?.language).toBe(loc);

      const sends = callsOf('sendMessage');
      expect(sends.length).toBeGreaterThanOrEqual(1);
      const firstBtn = getMainKeyboard(loc).keyboard[0]![0]!.text;
      expect(firstBtn).toBe(t(loc, 'keyboards.status'));

      // Reply keyboard button in new locale routes to status handler
      resetApi();
      await routeMessage(msg(firstBtn));
      expect(callsOf('sendMessage').length).toBeGreaterThanOrEqual(1);
    }
  });
});
