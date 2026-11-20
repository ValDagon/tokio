/**
 * T16 — group C: settings, life context, notes, trash.
 *
 * Паритет с `legacy/backend/app/api/routes.py` (см. `.scratch/T16-endpoints-spec.md`
 * §4 «Group C», §5 «Tests»). Каждый тест стартует с чистой in-memory SQLite.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { ensureUser } from '../../src/lib/dal/users';
import { createTask } from '../../src/lib/dal/tasks';
import userSettingsGet, {
  DEFAULT_USER_SETTINGS,
} from '../../src/endpoints/user_settings_get';
import userSettingsUpdate from '../../src/endpoints/user_settings_update';
import userLifeContext from '../../src/endpoints/user_life_context';
import notesCreate from '../../src/endpoints/notes_create';
import notesList from '../../src/endpoints/notes_list';
import notesUpdate from '../../src/endpoints/notes_update';
import notesDelete from '../../src/endpoints/notes_delete';
import tasksDelete from '../../src/endpoints/tasks_delete';
import trashList from '../../src/endpoints/trash_list';
import trashRestore from '../../src/endpoints/trash_restore';
import trashDelete from '../../src/endpoints/trash_delete';
import trashEmpty from '../../src/endpoints/trash_empty';

const TEST_USER = 777000111;
const ABSENT_USER = 888000222;
const mockCtx = { initData: { user: { id: TEST_USER } } };
const absentCtx = { initData: { user: { id: ABSENT_USER } } };

const UNAUTHORIZED = {
  name: 'EndpointError',
  message: 'Unauthorized',
  parameters: { code: 'UNAUTHORIZED' },
};

describe('T16 endpoints: settings, notes, trash', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
  });

  it('без initData все эндпоинты группы отдают Unauthorized', async () => {
    const unauthenticated: Array<() => Promise<unknown>> = [
      () => userSettingsGet({}),
      () => userSettingsUpdate({ base_currency: 'USD' }),
      () => userLifeContext({}),
      () => notesCreate({ text: 'x' }),
      () => notesList({}),
      () => notesUpdate({ id: 1, clean_text: 'x' }),
      () => notesDelete({ id: 1 }),
      () => tasksDelete({ id: 1 }),
      () => trashList({}),
      () => trashRestore({ item_type: 'note', item_id: 1 }),
      () => trashDelete({ item_type: 'note', item_id: 1 }),
      () => trashEmpty({}),
    ];

    for (const call of unauthenticated) {
      await expect(call()).rejects.toMatchObject(UNAUTHORIZED);
    }
  });

  it('user_settings_get отдаёт дефолты для пользователя без строки', async () => {
    const settings = await userSettingsGet({}, mockCtx);
    expect(settings).toEqual(DEFAULT_USER_SETTINGS);
    expect(settings).toEqual({
      base_currency: 'EUR',
      timezone: 'UTC',
      low_stimulation_mode: false,
      custom_instructions: '',
      persona_style: 'mentor',
    });
  });

  it('user_settings_update сохраняет base_currency в upper-case и low_stimulation_mode', async () => {
    await ensureUser(TEST_USER);

    const patched = await userSettingsUpdate(
      { base_currency: 'usd', low_stimulation_mode: true },
      mockCtx,
    );
    expect(patched).toEqual({
      base_currency: 'USD',
      timezone: 'UTC',
      low_stimulation_mode: true,
      custom_instructions: '',
      persona_style: 'mentor',
    });

    // GET после PATCH видит сохранённое значение.
    const reread = await userSettingsGet({}, mockCtx);
    expect(reread.base_currency).toBe('USD');
    expect(reread.low_stimulation_mode).toBe(true);

    // Непереданные ключи не трогаются.
    const timezoneOnly = await userSettingsUpdate({ timezone: 'Europe/Belgrade' }, mockCtx);
    expect(timezoneOnly.base_currency).toBe('USD');
    expect(timezoneOnly.timezone).toBe('Europe/Belgrade');
    expect(timezoneOnly.low_stimulation_mode).toBe(true);
  });

  it('user_settings_update без строки пользователя отдаёт дефолты (документированное отличие)', async () => {
    const patched = await userSettingsUpdate({ base_currency: 'gbp' }, absentCtx);
    expect(patched).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('user_settings_update валидирует типы полей', async () => {
    await ensureUser(TEST_USER);
    await expect(
      userSettingsUpdate({ low_stimulation_mode: 'yes' }, mockCtx),
    ).rejects.toMatchObject({
      message: 'Invalid low_stimulation_mode',
      parameters: { code: 'BAD_REQUEST' },
    });
    await expect(userSettingsUpdate({ base_currency: 42 }, mockCtx)).rejects.toMatchObject({
      message: 'Invalid base_currency',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('user_life_context собирает досье с активными задачами', async () => {
    await createTask(TEST_USER, { title: 'Сходить в аптеку' });

    const { context } = await userLifeContext({}, mockCtx);
    expect(typeof context).toBe('string');
    expect(context.length).toBeGreaterThan(0);
    expect(context).toContain('Текущие задачи и фокус');
    expect(context).toContain('Сходить в аптеку');
  });

  it('notes_create обрезает текст, ставит column=raw и clean_text=null', async () => {
    const note = await notesCreate({ text: '  Купить хлеб  ' }, mockCtx);

    expect(note.raw_text).toBe('Купить хлеб');
    expect(note.clean_text).toBeNull();
    expect(note.column).toBe('raw');
    expect(typeof note.id).toBe('string');
    expect(note.id).toMatch(/^\d+$/);
    expect(note.created_at).toBe(note.updated_at);
    expect(note.created_at.length).toBeGreaterThan(0);

    const idea = await notesCreate({ text: 'Идея для проекта', column: 'idea' }, mockCtx);
    expect(idea.column).toBe('idea');

    const malformed = notesCreate({ text: 123 }, mockCtx);
    await expect(malformed).rejects.toMatchObject({
      message: 'Invalid text',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('notes_list возвращает активные заметки и фильтрует по column', async () => {
    await notesCreate({ text: 'Первая мысль' }, mockCtx);
    await notesCreate({ text: 'Идея' , column: 'idea' }, mockCtx);

    const all = await notesList({}, mockCtx);
    expect(all).toHaveLength(2);

    const rawOnly = await notesList({ column: 'raw' }, mockCtx);
    expect(rawOnly).toHaveLength(1);
    expect(rawOnly[0].raw_text).toBe('Первая мысль');

    const empty = await notesList({ column: 'note' }, mockCtx);
    expect(empty).toHaveLength(0);

    await expect(notesList({ column: 5 }, mockCtx)).rejects.toMatchObject({
      message: 'Invalid column',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('notes_update пишет clean_text и отдаёт 404 для чужого/несуществующего id', async () => {
    const note = await notesCreate({ text: 'Черновик' }, mockCtx);

    const updated = await notesUpdate(
      { id: note.id, clean_text: 'Очищенный текст' },
      mockCtx,
    );
    expect(updated.id).toBe(note.id);
    expect(updated.raw_text).toBe('Черновик');
    expect(updated.clean_text).toBe('Очищенный текст');
    expect(updated.updated_at).toBe(note.created_at);

    // Обновление видно в списке.
    const listed = await notesList({}, mockCtx);
    expect(listed[0].clean_text).toBe('Очищенный текст');

    await expect(
      notesUpdate({ id: 999999, clean_text: 'x' }, mockCtx),
    ).rejects.toMatchObject({
      message: 'Note not found',
      parameters: { code: 'NOT_FOUND' },
    });
  });

  it('notes_delete отправляет в корзину, повторное удаление — 404', async () => {
    const note = await notesCreate({ text: 'Удаляемая заметка' }, mockCtx);

    const deleted = await notesDelete({ id: note.id }, mockCtx);
    expect(deleted).toEqual({ status: 'deleted', in_trash: true });

    // Из активного списка пропала.
    expect(await notesList({}, mockCtx)).toHaveLength(0);

    await expect(notesDelete({ id: note.id }, mockCtx)).rejects.toMatchObject({
      message: 'Note not found or already in trash',
      parameters: { code: 'NOT_FOUND' },
    });
  });

  it('trash_list отдаёт задачи и заметки в snake_case со сроком 30 дней', async () => {
    const task = await createTask(TEST_USER, { title: 'Убрать со стола' });
    const note = await notesCreate({ text: 'Мусорная мысль' }, mockCtx);

    await tasksDelete({ id: task.id }, mockCtx);
    await notesDelete({ id: note.id }, mockCtx);

    const trash = await trashList({}, mockCtx);
    expect(trash.total_count).toBe(2);
    expect(trash.tasks).toHaveLength(1);
    expect(trash.notes).toHaveLength(1);

    const taskItem = trash.tasks[0];
    expect(taskItem).toEqual({
      id: String(task.id),
      title: 'Убрать со стола',
      notes: null,
      status: 'todo',
      category_id: null,
      category_name: 'Быт',
      steps_count: 0,
      created_at: expect.any(String),
      deleted_at: expect.any(String),
      days_remaining: 30,
    });

    const noteItem = trash.notes[0];
    expect(noteItem).toEqual({
      id: note.id,
      raw_text: 'Мусорная мысль',
      clean_text: null,
      column: 'raw',
      created_at: expect.any(String),
      deleted_at: expect.any(String),
      days_remaining: 30,
    });
  });

  it('tasks_delete: повторное удаление возвращает 404', async () => {
    const task = await createTask(TEST_USER, { title: 'Разовое дело' });
    const deleted = await tasksDelete({ id: task.id }, mockCtx);
    expect(deleted).toEqual({ status: 'deleted', in_trash: true });

    await expect(tasksDelete({ id: task.id }, mockCtx)).rejects.toMatchObject({
      message: 'Task not found or already in trash',
      parameters: { code: 'NOT_FOUND' },
    });
  });

  it('trash_restore восстанавливает заметку, повтор — 404, мусорный type — 400', async () => {
    const note = await notesCreate({ text: 'Вернуть меня' }, mockCtx);
    await notesDelete({ id: note.id }, mockCtx);

    const restored = await trashRestore({ item_type: 'note', item_id: note.id }, mockCtx);
    expect(restored).toEqual({ status: 'restored', type: 'note', id: note.id });

    const active = await notesList({}, mockCtx);
    expect(active.some((item) => item.id === note.id)).toBe(true);
    expect((await trashList({}, mockCtx)).total_count).toBe(0);

    await expect(
      trashRestore({ item_type: 'note', item_id: note.id }, mockCtx),
    ).rejects.toMatchObject({
      message: 'Note not found in trash',
      parameters: { code: 'NOT_FOUND' },
    });

    await expect(
      trashRestore({ item_type: 'event', item_id: note.id }, mockCtx),
    ).rejects.toMatchObject({
      message: "Invalid item type. Must be 'task' or 'note'",
      parameters: { code: 'BAD_REQUEST' },
    });

    await expect(trashRestore({ item_type: 'note' }, mockCtx)).rejects.toMatchObject({
      message: 'Invalid item_id',
      parameters: { code: 'BAD_REQUEST' },
    });
  });

  it('trash_delete окончательно удаляет заметку, повтор — 404', async () => {
    const note = await notesCreate({ text: 'Насовсем' }, mockCtx);
    await notesDelete({ id: note.id }, mockCtx);

    const purged = await trashDelete({ item_type: 'note', item_id: note.id }, mockCtx);
    expect(purged).toEqual({
      status: 'permanently_deleted',
      type: 'note',
      id: note.id,
    });

    const trash = await trashList({}, mockCtx);
    expect(trash.notes).toHaveLength(0);
    expect(trash.total_count).toBe(0);

    await expect(
      trashDelete({ item_type: 'note', item_id: note.id }, mockCtx),
    ).rejects.toMatchObject({
      message: 'Note not found in trash',
      parameters: { code: 'NOT_FOUND' },
    });
  });

  it('trash_empty очищает корзину и считает удалённое', async () => {
    const first = await notesCreate({ text: 'Заметка 1' }, mockCtx);
    const second = await notesCreate({ text: 'Заметка 2' }, mockCtx);
    const task = await createTask(TEST_USER, { title: 'Задача в корзину' });

    await notesDelete({ id: first.id }, mockCtx);
    await notesDelete({ id: second.id }, mockCtx);
    await tasksDelete({ id: task.id }, mockCtx);

    const emptied = await trashEmpty({}, mockCtx);
    expect(emptied).toEqual({ status: 'emptied', tasks_purged: 1, notes_purged: 2 });

    const trash = await trashList({}, mockCtx);
    expect(trash.total_count).toBe(0);
  });
});
