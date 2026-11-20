/**
 * T14 — порт `legacy/backend/app/bot/keyboards.py` (ADP-002-совместимый).
 *
 * Фиксируем то, что легко сломать незаметно: адрес Mini App берётся ТОЛЬКО из
 * `WEBAPP_URL` (никаких хардкод-доменов и http), форму основной клавиатуры,
 * усечение заголовков фокус-задач (28 символов, без `trimEnd` — паритет),
 * активный раздел в дашборде и порядок строк (`triage` до навигации,
 * `🚀 Открыть` только при наличии URL).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAgentDeepLinkKeyboard,
  buildOpenAppButton,
  buildUndoWithAppKeyboard,
  getActionKeyboard,
  getBackupInlineKeyboard,
  getDashboardInlineKeyboard,
  getInboxItemKeyboard,
  getMainKeyboard,
  getOpenAppInlineKeyboard,
  getTriageInlineKeyboard,
  KEYBOARD_BALANCE,
  KEYBOARD_DEBTS,
  KEYBOARD_DIGEST,
  KEYBOARD_HELP,
  KEYBOARD_INBOX,
  KEYBOARD_MEDS,
  KEYBOARD_STATUS,
  KEYBOARD_TASKS,
  OPEN_APP_LABEL,
  resolveAgentStartAppParam,
  webAppDeepLinkUrl,
  webAppUrl,
} from '../../src/handlers/keyboards';

const WEBAPP = 'https://mini.example.com/app';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('WEBAPP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('webAppUrl', () => {
  it('без WEBAPP_URL — null', () => {
    expect(webAppUrl()).toBeNull();
  });

  it('https-адрес обрезается по краям', () => {
    vi.stubEnv('WEBAPP_URL', `  ${WEBAPP}  `);
    expect(webAppUrl()).toBe(WEBAPP);
  });

  it('http и мусор не считаются адресом Mini App', () => {
    vi.stubEnv('WEBAPP_URL', 'http://mini.example.com');
    expect(webAppUrl()).toBeNull();
    vi.stubEnv('WEBAPP_URL', 'mini.example.com');
    expect(webAppUrl()).toBeNull();
  });
});

describe('getMainKeyboard', () => {
  it('4×2 быстрые разделы: не persistent, сворачивается после одного нажатия', () => {
    const markup = getMainKeyboard();
    expect(markup.keyboard).toEqual([
      [{ text: KEYBOARD_STATUS }, { text: KEYBOARD_BALANCE }],
      [{ text: KEYBOARD_DEBTS }, { text: KEYBOARD_TASKS }],
      [{ text: KEYBOARD_MEDS }, { text: KEYBOARD_DIGEST }],
      [{ text: KEYBOARD_INBOX }, { text: KEYBOARD_HELP }],
    ]);
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.one_time_keyboard).toBe(true);
    // `is_persistent` держал сетку на экране постоянно — владелец попросил
    // сворачивать её, поэтому флага больше нет.
    expect(markup).not.toHaveProperty('is_persistent');
    expect(markup.input_field_placeholder).toBe(
      'Надиктуй мысль, расход, идею или нажми сводку 📥',
    );
  });
});

describe('getOpenAppInlineKeyboard', () => {
  it('без URL кнопки нет', () => {
    expect(getOpenAppInlineKeyboard()).toBeNull();
  });

  it('с URL — одна web_app-кнопка', () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    expect(getOpenAppInlineKeyboard()).toEqual({
      inline_keyboard: [[{ text: OPEN_APP_LABEL, web_app: { url: WEBAPP } }]],
    });
  });
});

describe('getActionKeyboard', () => {
  it('отмена и изменение ссылаются на запись', () => {
    expect(getActionKeyboard('task', '17')).toEqual({
      inline_keyboard: [
        [
          { text: '↩️ Отменить', callback_data: 'undo:task:17' },
          { text: '✏️ Изменить', callback_data: 'edit:task:17' },
        ],
      ],
    });
  });
});

describe('getDashboardInlineKeyboard', () => {
  it('минимум: две строки навигации и обновление активного раздела', () => {
    const markup = getDashboardInlineKeyboard();
    expect(markup.inline_keyboard).toEqual([
      [
        { text: `• ${KEYBOARD_STATUS} •`, callback_data: 'nav:status' },
        { text: KEYBOARD_BALANCE, callback_data: 'nav:balance' },
        { text: KEYBOARD_DEBTS, callback_data: 'nav:debts' },
      ],
      [
        { text: KEYBOARD_TASKS, callback_data: 'nav:tasks' },
        { text: KEYBOARD_INBOX, callback_data: 'nav:inbox' },
        { text: KEYBOARD_DIGEST, callback_data: 'nav:digest' },
      ],
      [{ text: '🔄 Обновить', callback_data: 'nav:status' }],
    ]);
  });

  it('активный раздел помечается и попадает в «Обновить»', () => {
    const rows = getDashboardInlineKeyboard({ activeTab: 'balance' }).inline_keyboard;
    expect(rows[0]?.[1]).toEqual({ text: `• ${KEYBOARD_BALANCE} •`, callback_data: 'nav:balance' });
    expect(rows[0]?.[0]).toEqual({ text: KEYBOARD_STATUS, callback_data: 'nav:status' });
    expect(rows.at(-1)?.at(-1)).toEqual({ text: '🔄 Обновить', callback_data: 'nav:balance' });
  });

  it('не больше трёх фокус-задач; длинный заголовок режется без trimEnd', () => {
    const longTitle = 'Очень длинный заголовок задачи, который точно не влезет';
    const rows = getDashboardInlineKeyboard({
      activeTab: 'tasks',
      focusTasks: [
        { id: 1, title: 'Короткая' },
        { id: 2, title: 'Ещё одна' },
        { id: 3, title: longTitle },
        { id: 4, title: 'Четвёртая не нужна' },
      ],
    }).inline_keyboard;

    expect(rows).toHaveLength(3 /* фокус */ + 2 /* навигация */ + 1 /* утилиты */);
    expect(rows[0]).toEqual([
      { text: '✅ 1. Короткая', callback_data: 'dash_done:tasks:1' },
    ]);
    expect(rows[2]).toEqual([
      { text: `✅ 3. ${longTitle.slice(0, 28)}…`, callback_data: 'dash_done:tasks:3' },
    ]);
    expect(rows.map((row) => row[0]?.text).join('|')).not.toContain('Четвёртая');
  });

  it('заголовок ровно в 28 символов не режется', () => {
    const title = 'a'.repeat(28);
    const rows = getDashboardInlineKeyboard({ focusTasks: [{ id: 9, title }] }).inline_keyboard;
    expect(rows[0]?.[0]?.text).toBe(`✅ 1. ${title}`);
  });

  it('🧠 Разобрать — до навигации, 📥 Бэкап и 🚀 Открыть — в утилитах', () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    const rows = getDashboardInlineKeyboard({
      includeTriage: true,
      includeBackup: true,
    }).inline_keyboard;

    expect(rows[0]).toEqual([
      { text: '🧠 Разобрать всё прямо сейчас', callback_data: 'triage:inbox' },
    ]);
    expect(rows.at(-1)).toEqual([
      { text: '🔄 Обновить', callback_data: 'nav:status' },
      { text: OPEN_APP_LABEL, web_app: { url: WEBAPP } },
      { text: '📥 Бэкап', callback_data: 'backup:download' },
    ]);
  });

  it('без WEBAPP_URL в утилитах нет 🚀 Открыть', () => {
    const rows = getDashboardInlineKeyboard({ includeBackup: true }).inline_keyboard;
    expect(rows.at(-1)).toEqual([
      { text: '🔄 Обновить', callback_data: 'nav:status' },
      { text: '📥 Бэкап', callback_data: 'backup:download' },
    ]);
  });

  it('маппит activeTab в startapp deep-link для debts, tasks и inbox', () => {
    vi.stubEnv('WEBAPP_URL', WEBAPP);
    expect(getDashboardInlineKeyboard({ activeTab: 'debts' }).inline_keyboard.at(-1)).toEqual([
      { text: '🔄 Обновить', callback_data: 'nav:debts' },
      { text: OPEN_APP_LABEL, web_app: { url: `${WEBAPP}?startapp=debts` } },
    ]);
    expect(getDashboardInlineKeyboard({ activeTab: 'tasks' }).inline_keyboard.at(-1)).toEqual([
      { text: '🔄 Обновить', callback_data: 'nav:tasks' },
      { text: OPEN_APP_LABEL, web_app: { url: `${WEBAPP}?startapp=tasks` } },
    ]);
    expect(getDashboardInlineKeyboard({ activeTab: 'inbox' }).inline_keyboard.at(-1)).toEqual([
      { text: '🔄 Обновить', callback_data: 'nav:inbox' },
      { text: OPEN_APP_LABEL, web_app: { url: `${WEBAPP}?startapp=inbox` } },
    ]);
  });
});

describe('deep-link хелперы Mini App', () => {
  it('webAppDeepLinkUrl возвращает null без URL и добавляет ?/& startapp при непустом параметре', () => {
    expect(webAppDeepLinkUrl('tasks')).toBeNull();

    vi.stubEnv('WEBAPP_URL', WEBAPP);
    expect(webAppDeepLinkUrl()).toBe(WEBAPP);
    expect(webAppDeepLinkUrl('   ')).toBe(WEBAPP);
    expect(webAppDeepLinkUrl(' task_42 ')).toBe(`${WEBAPP}?startapp=task_42`);

    vi.stubEnv('WEBAPP_URL', `${WEBAPP}?v=1`);
    expect(webAppDeepLinkUrl('a b')).toBe(`${WEBAPP}?v=1&startapp=a%20b`);
  });

  it('buildOpenAppButton возвращает кнопку с web_app или null', () => {
    expect(buildOpenAppButton('finances')).toBeNull();

    vi.stubEnv('WEBAPP_URL', WEBAPP);
    expect(buildOpenAppButton('finances')).toEqual({
      text: '📱 В приложении',
      web_app: { url: `${WEBAPP}?startapp=finances` },
    });
    expect(buildOpenAppButton(undefined, '🚀 Перейти')).toEqual({
      text: '🚀 Перейти',
      web_app: { url: WEBAPP },
    });
  });

  it('buildUndoWithAppKeyboard строит 1-рядную клавиатуру с Отменить и опциональной кнопкой приложения', () => {
    expect(buildUndoWithAppKeyboard('undo_task:7', 'task_7')).toEqual({
      inline_keyboard: [[{ text: '🗑️ Отменить', callback_data: 'undo_task:7' }]],
    });

    vi.stubEnv('WEBAPP_URL', WEBAPP);
    expect(buildUndoWithAppKeyboard('undo_task:7', 'task_7')).toEqual({
      inline_keyboard: [
        [
          { text: '🗑️ Отменить', callback_data: 'undo_task:7' },
          { text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=task_7` } },
        ],
      ],
    });
  });

  it('resolveAgentStartAppParam маппит мутации и can_i_afford, игнорируя ошибки и read-only шаги', () => {
    expect(
      resolveAgentStartAppParam([
        { ok: true, action: { name: 'add_task' }, data: { task_id: 42 } },
      ]),
    ).toBe('task_42');
    expect(
      resolveAgentStartAppParam([
        { ok: true, action: { name: 'edit_note' }, data: { note_id: 7 } },
      ]),
    ).toBe('note_7');
    expect(
      resolveAgentStartAppParam([
        { ok: true, action: { name: 'move_note' }, data: { note_id: 8 } },
      ]),
    ).toBe('note_8');
    expect(
      resolveAgentStartAppParam([{ ok: true, action: { name: 'can_i_afford' } }]),
    ).toBe('finances');
    expect(
      resolveAgentStartAppParam([{ ok: true, action: { name: 'link_liability_account' } }]),
    ).toBe('debts');

    // Неудачный шаг пропускается
    expect(
      resolveAgentStartAppParam([
        { ok: false, action: { name: 'add_task' }, data: { task_id: 42 } },
      ]),
    ).toBeNull();

    // Read-only запросы возвращают null
    expect(
      resolveAgentStartAppParam([
        { ok: true, action: { name: 'list_tasks' } },
        { ok: true, action: { name: 'get_fin_balances' } },
        { ok: true, action: { name: 'search_notes' } },
      ]),
    ).toBeNull();

    // Несколько шагов: выбирается последний подходящий успешный шаг
    expect(
      resolveAgentStartAppParam([
        { ok: true, action: { name: 'add_task' }, data: { task_id: 10 } },
        { ok: true, action: { name: 'edit_note' }, data: { note_id: 7 } },
        { ok: true, action: { name: 'list_tasks' } },
        { ok: false, action: { name: 'can_i_afford' } },
      ]),
    ).toBe('note_7');
  });

  it('buildAgentDeepLinkKeyboard строит inline-кнопку только при валидном startapp и WEBAPP_URL', () => {
    expect(
      buildAgentDeepLinkKeyboard([
        { ok: true, action: { name: 'add_task' }, data: { task_id: 42 } },
      ]),
    ).toBeUndefined();

    vi.stubEnv('WEBAPP_URL', WEBAPP);
    expect(
      buildAgentDeepLinkKeyboard([
        { ok: true, action: { name: 'add_task' }, data: { task_id: 42 } },
      ]),
    ).toEqual({
      inline_keyboard: [[{ text: '📱 В приложении', web_app: { url: `${WEBAPP}?startapp=task_42` } }]],
    });
    expect(
      buildAgentDeepLinkKeyboard([{ ok: true, action: { name: 'list_tasks' } }]),
    ).toBeUndefined();
  });
});

describe('клавиатуры заметок и разбора', () => {
  it('заметка инбокса: в задачу / в инбокс / отменить', () => {
    expect(getInboxItemKeyboard('42')).toEqual({
      inline_keyboard: [
        [
          { text: '🎯 В задачу', callback_data: 'inbox_to_task:42' },
          { text: '📥 В инбокс', callback_data: 'inbox_to_inbox:42' },
        ],
        [{ text: '🗑 Отменить', callback_data: 'inbox_undo:42' }],
      ],
    });
  });

  it('бэкап и разбор — по одной кнопке', () => {
    expect(getBackupInlineKeyboard()).toEqual({
      inline_keyboard: [[{ text: '📥 Скачать бэкап .zip', callback_data: 'backup:download' }]],
    });
    expect(getTriageInlineKeyboard()).toEqual({
      inline_keyboard: [
        [{ text: '🧠 Разобрать всё прямо сейчас', callback_data: 'triage:inbox' }],
      ],
    });
  });
});
