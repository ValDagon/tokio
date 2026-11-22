/**
 * Меню команд Telegram (`setMyCommands`) живёт в коде, а не в BotFather.
 *
 * Контракт:
 *  1. список собирается из тех же первичных имён, что и маршрутизация
 *     (`SLASH_COMMANDS`), без алиасов и без кириллицы — Telegram принимает
 *     только латиницу;
 *  2. опубликованные описания есть во всех четырёх локалях (`locales/*.json`);
 *  3. `setMyCommands` вызывается один раз на версию списка (`kv`-гард), без
 *     таймеров: повторный проход по тому же списку не делает ни одного вызова;
 *  4. сбой Bot API не роняет ход: `/start` продолжает отвечать, гард остаётся
 *     открытым и следующее касание повторяет публикацию.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { createTableStatements } from '../../src/db/ddl';
import { TABLES } from '../../src/db/tables';
import { resetConfigCache, setConfigOverrides } from '../../src/lib/config';
import { kvGet, kvSet } from '../../src/lib/dal/misc';
import { ensureUser } from '../../src/lib/dal/users';
import { SUPPORTED_LOCALES, t } from '../../src/lib/i18n';
import {
  COMMAND_MENU_KV_KEY,
  botMenuCommands,
  commandMenuByLocale,
  commandMenuVersion,
  primaryCommandNames,
  resetRouterSeams,
  syncCommandMenu,
} from '../../src/handlers/router';
import handleUpdate, { type Message } from '../../src/handlers/message';

const USER = 880501;
const CHAT = 880501;

/** Что лежало в меню личного бота 22.11.2026 (разовый облачный зонд). */
const PROBE_MENU = [
  'menu',
  'status',
  'balance',
  'debts',
  'tasks',
  'meds',
  'digest',
  'inbox',
  'triage',
  'diagnostics',
  'skills',
  'backlog',
  'lang',
  'byok',
  'backup',
  'consolidate',
  'new',
  'help',
];

/** Порядок объявления в `SLASH_COMMANDS`: он же порядок меню. */
const DECLARED_ORDER = [
  'menu',
  'backup',
  'status',
  'balance',
  'debts',
  'tasks',
  'meds',
  'digest',
  'help',
  'consolidate',
  'diagnostics',
  'new',
  'backlog',
  'inbox',
  'triage',
  'byok',
  'lang',
  'skills',
];

function message(text: string): Message {
  return {
    message_id: 31,
    chat: { id: CHAT, type: 'private' },
    from: { id: USER, first_name: 'Tester' },
    date: 0,
    text,
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
  resetRouterSeams();
  await ensureUser(USER, 'Tester');
});

afterEach(() => {
  delete (api as Record<string, unknown>).setMyCommands;
  resetRouterSeams();
  resetConfigCache();
});

describe('меню команд: список', () => {
  it('собирается из первичных имён SLASH_COMMANDS без алиасов и без /start', () => {
    const names = primaryCommandNames();

    expect(names).toEqual(DECLARED_ORDER);
    // Тот же набор, что стоял в меню после разового зонда 22.11.2026.
    expect([...names].sort()).toEqual([...PROBE_MENU].sort());
    expect(new Set(names).size).toBe(names.length);

    // Telegram принимает только латиницу, цифры и `_`.
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(names).not.toContain('start');

    // Алиасы, которые ведут на те же обработчики, в меню не попадают.
    for (const alias of ['summary', 'export', 'todo', 'language', 'commands', 'fin', 'reset']) {
      expect(names).not.toContain(alias);
    }
  });

  it('описания есть во всех четырёх локалях и укладываются в лимиты Bot API', () => {
    const menu = commandMenuByLocale();

    expect(Object.keys(menu).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    for (const locale of SUPPORTED_LOCALES) {
      const commands = menu[locale];
      expect(commands.map((entry) => entry.command)).toEqual(DECLARED_ORDER);
      for (const entry of commands) {
        // `t()` возвращает сам ключ, если строки нет, — это и есть проверка.
        expect(entry.description).not.toBe(`commands.${entry.command}`);
        expect(entry.description.trim().length).toBeGreaterThanOrEqual(3);
        expect(entry.description.length).toBeLessThanOrEqual(256);
      }
    }

    // Локаль реально влияет на описание: ru и en не совпадают.
    expect(botMenuCommands('ru')[0]!.description).toBe(t('ru', 'commands.menu'));
    expect(botMenuCommands('ru')[0]!.description).not.toBe(botMenuCommands('en')[0]!.description);
  });

  it('версия списка меняется от правки описания', () => {
    const menu = commandMenuByLocale();
    expect(commandMenuVersion(menu)).toBe(commandMenuVersion(commandMenuByLocale()));

    const edited = structuredClone(menu);
    edited.ru[0]!.description = 'Другое описание';
    expect(commandMenuVersion(edited)).not.toBe(commandMenuVersion(menu));
  });
});

describe('меню команд: гард версии', () => {
  it('первый проход публикует все четыре локали и запоминает версию', async () => {
    await syncCommandMenu();

    const calls = callsOf('setMyCommands');
    expect(calls.map((call) => call.params.language_code)).toEqual([...SUPPORTED_LOCALES]);
    expect(calls[0]!.params.commands).toEqual(botMenuCommands('ru'));
    expect(calls[0]!.params).not.toHaveProperty('scope');

    const version = commandMenuVersion(commandMenuByLocale());
    expect(await kvGet(COMMAND_MENU_KV_KEY)).toBe(version);
  });

  it('гард сработал — второго вызова setMyCommands нет', async () => {
    await syncCommandMenu();
    expect(callsOf('setMyCommands')).toHaveLength(SUPPORTED_LOCALES.length);

    resetApi();
    await syncCommandMenu();
    expect(callsOf('setMyCommands')).toHaveLength(0);
  });

  it('чужая версия в kv (новый список после правки локалей) публикуется заново', async () => {
    await kvSet(COMMAND_MENU_KV_KEY, 'deadbeef');

    await syncCommandMenu();

    expect(callsOf('setMyCommands')).toHaveLength(SUPPORTED_LOCALES.length);
    expect(await kvGet(COMMAND_MENU_KV_KEY)).toBe(commandMenuVersion(commandMenuByLocale()));
  });
});

describe('меню команд: сбой Bot API', () => {
  it('syncCommandMenu не бросает, гард остаётся открытым и лечится следующим проходом', async () => {
    (api as Record<string, unknown>).setMyCommands = async () => {
      throw new Error('Bot API is down');
    };

    await expect(syncCommandMenu()).resolves.toBeUndefined();
    expect(await kvGet(COMMAND_MENU_KV_KEY)).toBeNull();

    // API ожил — публикация повторяется, потому что версия не записана.
    delete (api as Record<string, unknown>).setMyCommands;
    await syncCommandMenu();
    expect(callsOf('setMyCommands')).toHaveLength(SUPPORTED_LOCALES.length);
    expect(await kvGet(COMMAND_MENU_KV_KEY)).toBe(commandMenuVersion(commandMenuByLocale()));
  });

  it('/start отвечает, даже когда setMyCommands падает', async () => {
    (api as Record<string, unknown>).setMyCommands = async () => {
      throw new Error('Bot API is down');
    };

    await expect(handleUpdate(message('/start'))).resolves.toBeUndefined();

    const texts = sentTexts();
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((text) => text.includes('твой личный ассистент'))).toBe(true);
    expect(await kvGet(COMMAND_MENU_KV_KEY)).toBeNull();
  });
});
