// Self-test for the platform mock. The mock is the base every other test stands on,
// so it gets exercised directly: DDL, CRUD, the `sql` tag with named parameters and
// the Bot API call recorder.

import { beforeEach, describe, expect, it } from 'vitest';
import { api } from 'sdk';
import {
  callsOf,
  db,
  eq,
  integer,
  resetApi,
  sql,
  sqliteDDL,
  table,
  text,
} from './sdk';

const notes = table('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body'),
  done: integer('done'),
});

sqliteDDL([notes]);

describe('tests/mocks/sdk', () => {
  beforeEach(async () => {
    await db.run(sql.raw('DELETE FROM notes'));
  });

  it('создаёт таблицу из дескриптора и делает CRUD', async () => {
    await db.insert(notes).values({ body: 'hello', done: 0 }).run();

    const rows = await db.select().from(notes).where(eq(notes.columns.body, 'hello')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: 'hello', done: 0 });
    expect(await db.$count(notes, eq(notes.columns.done, 0))).toBe(1);

    await db.update(notes).set({ done: 1 }).where(eq(notes.columns.body, 'hello')).run();
    expect(await db.$count(notes, eq(notes.columns.done, 0))).toBe(0);
  });

  it('биндит named-параметры :p1 в sql-теге', async () => {
    await db.insert(notes).values({ body: 'tagged', done: 0 }).run();

    const row = await db.get<{ body: string }>(
      sql`SELECT body FROM notes WHERE body = ${'tagged'} AND done = ${0}`,
    );
    expect(row?.body).toBe('tagged');
  });

  it('пишет вызовы бот-API и сбрасывается через resetApi', async () => {
    await api.sendMessage({ chat_id: 1, text: 'ping' });
    expect(callsOf('sendMessage')).toHaveLength(1);

    resetApi();
    expect(callsOf('sendMessage')).toHaveLength(0);
    expect(api.getApp).toBeTypeOf('function');
  });
});
