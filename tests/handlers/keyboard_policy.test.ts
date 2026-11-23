/**
 * Политика reply-клавиатуры: сетка разделов — только у `/start` и `/menu`,
 * любой обычный ответ её сворачивает.
 *
 * Платформа: отсутствие `reply_markup` клавиатуру НЕ убирает (клиент держит
 * последнюю) — убирает только `remove_keyboard: true`. Поэтому проверяем
 * именно параметр отправки, а не факт «не передали разметку».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOf, resetApi, resetDb, sqliteDDL } from '../mocks/sdk';

import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { resetConfigCache } from '../../src/lib/config';
import { ensureUser } from '../../src/lib/dal/users';
import { resolveReplyMarkup, safeAnswer, safeEdit } from '../../src/handlers/formatting';
import {
  getBackupInlineKeyboard,
  getCommandsKeyboard,
  getMainKeyboard,
} from '../../src/handlers/keyboards';
import { resetRouterSeams, routeMessage } from '../../src/handlers/router';
import type { Message } from '../../src/handlers/message';

const USER = 601;
const CHAT = 901;

const REMOVE_KEYBOARD = { remove_keyboard: true } as const;

function msg(text: string): Message {
  return {
    message_id: 13,
    chat: { id: CHAT },
    from: { id: USER, first_name: 'Алекс' },
    text,
  };
}

const firstSent = (): Record<string, unknown> =>
  (callsOf('sendMessage')[0]?.params ?? {}) as Record<string, unknown>;

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

describe('resolveReplyMarkup', () => {
  it('обычный ответ без разметки не прикладывает remove_keyboard (оставляет ⊞)', () => {
    expect(resolveReplyMarkup(undefined)).toBeNull();
    expect(resolveReplyMarkup(null)).toBeNull();
    expect(resolveReplyMarkup(REMOVE_KEYBOARD)).toEqual(REMOVE_KEYBOARD);
  });

  it('reply-разметка без opt-in опускается, inline проходит как есть', () => {
    expect(resolveReplyMarkup(getMainKeyboard())).toBeNull();
    expect(resolveReplyMarkup(getBackupInlineKeyboard())).toEqual(getBackupInlineKeyboard());
  });

  it('opt-in сохраняет сетку (Главный экран и Команды)', () => {
    expect(resolveReplyMarkup(getMainKeyboard(), { keepReplyKeyboard: true })).toEqual(
      getMainKeyboard(),
    );
    expect(resolveReplyMarkup(getCommandsKeyboard(), { keepReplyKeyboard: true })).toEqual(
      getCommandsKeyboard(),
    );
    expect(resolveReplyMarkup(undefined, { keepReplyKeyboard: true })).toBeNull();
    expect(resolveReplyMarkup(getMainKeyboard(), { collapse: false })).toBeNull();
  });
});

describe('клавиатура в ответах роутера', () => {
  it('ordinary /status reply omits reply_markup so collapsed keyboard stays under ⊞', async () => {
    await routeMessage(msg('/status'));
    expect(firstSent().reply_markup).toBeUndefined();
  });

  it('start and menu keep the Layer 1 main keyboard (2×3)', async () => {
    await routeMessage(msg('/start'));
    expect(firstSent().reply_markup).toEqual(getMainKeyboard());

    resetApi();
    await routeMessage(msg('/menu'));
    const sent = firstSent();
    expect(sent.reply_markup).toEqual(getMainKeyboard());
    const text = String(sent.text ?? '');
    for (const label of ['Новая сессия', 'Скиллы', 'Сводка', 'Диагностика', 'Разобрать', 'Команды']) {
      expect(text).toContain(label);
    }
  });

  it('two-layer switch moves between Main (2×3) and Commands (4×3)', async () => {
    await routeMessage(msg('⌨️ Команды ›'));
    expect(firstSent().reply_markup).toEqual(getCommandsKeyboard());

    resetApi();
    await routeMessage(msg('← Назад'));
    expect(firstSent().reply_markup).toEqual(getMainKeyboard());
  });

  it('inline keyboards are not stripped', async () => {
    await routeMessage(msg('/digest'));
    expect(firstSent().reply_markup).toEqual(getBackupInlineKeyboard());
  });
});

describe('safeAnswer / safeEdit', () => {
  it('safeAnswer не шлёт remove_keyboard по умолчанию', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await safeAnswer(1, 'ok', { send: async (params) => sent.push(params) });
    expect(sent[0]).not.toHaveProperty('reply_markup');
  });

  it('safeEdit передаёт inline-разметку и не шлёт remove_keyboard', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await safeEdit(1, 2, 'ok', {
      replyMarkup: getBackupInlineKeyboard(),
      send: async (params) => sent.push(params),
    });
    expect(sent[0]?.reply_markup).toEqual(getBackupInlineKeyboard());

    const plain: Array<Record<string, unknown>> = [];
    await safeEdit(1, 2, 'ok', { send: async (params) => plain.push(params) });
    expect(plain[0]).not.toHaveProperty('reply_markup');
  });
});
