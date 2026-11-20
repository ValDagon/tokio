/**
 * DAL `src/lib/dal/users.ts` — профиль, настройки, квоты, BYOK.
 *
 * `users.id` — telegram user id (PK), поэтому «изоляция по пользователю» здесь
 * означает: операции над одним id не задевают строку другого. Кодирование
 * проверяем и через доменный API, и сырыми SELECT'ами (0/1 у булевых,
 * ISO-строки у дат, NULL в трёх BYOK-колонках при очистке).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql } from 'sdk/db';
import { resetDb, sqliteDDL } from '../mocks/sdk';
import { TABLES } from '../../src/db/tables';
import { createTableStatements } from '../../src/db/ddl';
import { monthKey } from '../../src/lib/utils';
import {
  addUsage,
  ensureUser,
  getUser,
  setMonthlyQuota,
  updateUser,
  type UserPatch,
} from '../../src/lib/dal/users';

const BYOK = { ciphertext: 'ct-blob', nonce: 'nonce-1', tag: 'tag-1' } as const;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

interface RawUser {
  name: string | null;
  base_currency: string;
  timezone: string;
  summary_time: string;
  low_stimulation_mode: number;
  quota_month: string | null;
  quota_tokens: number;
  quota_limit: number;
  byok_ciphertext: string | null;
  byok_nonce: string | null;
  byok_tag: string | null;
  created_at: string | null;
  updated_at: string | null;
}

async function rawUser(id: number): Promise<RawUser | null> {
  return db.get<RawUser>(sql`
    SELECT name, base_currency, timezone, summary_time, low_stimulation_mode,
           quota_month, quota_tokens, quota_limit,
           byok_ciphertext, byok_nonce, byok_tag, created_at, updated_at
      FROM users WHERE id = ${id}
  `);
}

describe('users: ensureUser', () => {
  it('создаёт строку с дефолтами схемы', async () => {
    const user = await ensureUser(1);

    expect(user.id).toBe(1);
    expect(user.name).toBeNull();
    expect(user.baseCurrency).toBe('EUR');
    expect(user.timezone).toBe('UTC');
    expect(user.summaryTime).toBe('07:00');
    expect(user.lowStimulationMode).toBe(false);
    expect(user.quotaTokens).toBe(0);
    expect(user.quotaLimit).toBe(0);
    expect(user.quotaMonth).toBeNull();
    expect(user.byok).toBeNull();
    expect(user.createdAt).not.toBeNull();
    expect(user.updatedAt).not.toBeNull();

    // сырые значения: дефолты проставил DDL, булево лежит как 0
    const raw = await rawUser(1);
    expect(raw).not.toBeNull();
    expect(raw?.base_currency).toBe('EUR');
    expect(raw?.timezone).toBe('UTC');
    expect(raw?.summary_time).toBe('07:00');
    expect(raw?.low_stimulation_mode).toBe(0);
    expect(raw?.quota_tokens).toBe(0);
    expect(raw?.quota_limit).toBe(0);
    expect(raw?.quota_month).toBeNull();
    expect(raw?.byok_ciphertext).toBeNull();
    expect(raw?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('идемпотентен и НЕ перезаписывает имя', async () => {
    await ensureUser(1, 'Alice');
    const again = await ensureUser(1, 'Bob');

    expect(again.name).toBe('Alice');
    expect((await getUser(1))?.name).toBe('Alice');

    const rows = await db.all<{ c: number }>(sql`SELECT COUNT(*) AS c FROM users WHERE id = ${1}`);
    expect(rows[0].c).toBe(1);
  });

  it('без имени пишет NULL', async () => {
    const user = await ensureUser(2);
    expect(user.name).toBeNull();
    expect((await rawUser(2))?.name).toBeNull();
  });
});

describe('users: getUser', () => {
  it('несуществующий пользователь → null', async () => {
    expect(await getUser(404)).toBeNull();
  });

  it('читает созданную строку', async () => {
    await ensureUser(7, 'Seven');
    const user = await getUser(7);
    expect(user?.id).toBe(7);
    expect(user?.name).toBe('Seven');
  });
});

describe('users: updateUser', () => {
  it('частичный патч не трогает остальные поля', async () => {
    await ensureUser(1, 'Alice');
    const before = await getUser(1);
    const updated = await updateUser(1, { timezone: 'Europe/Berlin' });

    expect(updated?.timezone).toBe('Europe/Berlin');
    expect(updated?.name).toBe(before?.name);
    expect(updated?.baseCurrency).toBe(before?.baseCurrency);
    expect(updated?.summaryTime).toBe(before?.summaryTime);
    expect(updated?.lowStimulationMode).toBe(before?.lowStimulationMode);
    expect(updated?.quotaTokens).toBe(before?.quotaTokens);
    expect(updated?.quotaLimit).toBe(before?.quotaLimit);
    expect(updated?.createdAt).toBe(before?.createdAt);
  });

  it('обновляет несколько полей сразу', async () => {
    await ensureUser(1);
    const updated = await updateUser(1, { baseCurrency: 'USD', summaryTime: '09:30' });

    expect(updated?.baseCurrency).toBe('USD');
    expect(updated?.summaryTime).toBe('09:30');

    const raw = await rawUser(1);
    expect(raw?.base_currency).toBe('USD');
    expect(raw?.summary_time).toBe('09:30');
  });

  it('lowStimulationMode пишется как 1 и читается как true', async () => {
    await ensureUser(1);
    const updated = await updateUser(1, { lowStimulationMode: true });

    expect(updated?.lowStimulationMode).toBe(true);
    expect((await rawUser(1))?.low_stimulation_mode).toBe(1);

    const off = await updateUser(1, { lowStimulationMode: false });
    expect(off?.lowStimulationMode).toBe(false);
    expect((await rawUser(1))?.low_stimulation_mode).toBe(0);
  });

  it('byok сохраняется тремя колонками и очищается через null', async () => {
    await ensureUser(1);

    const withByok = await updateUser(1, { byok: { ...BYOK } });
    expect(withByok?.byok).toEqual({ ciphertext: 'ct-blob', nonce: 'nonce-1', tag: 'tag-1' });
    expect((await getUser(1))?.byok).toEqual({ ...BYOK });

    const raw = await rawUser(1);
    expect(raw?.byok_ciphertext).toBe('ct-blob');
    expect(raw?.byok_nonce).toBe('nonce-1');
    expect(raw?.byok_tag).toBe('tag-1');

    const cleared = await updateUser(1, { byok: null });
    expect(cleared?.byok).toBeNull();
    expect((await getUser(1))?.byok).toBeNull();

    const rawCleared = await rawUser(1);
    expect(rawCleared?.byok_ciphertext).toBeNull();
    expect(rawCleared?.byok_nonce).toBeNull();
    expect(rawCleared?.byok_tag).toBeNull();
  });

  it('пустой патч не меняет строку вообще (включая updatedAt)', async () => {
    await ensureUser(1, 'Alice');
    const before = await getUser(1);
    const beforeRaw = await rawUser(1);

    const after = await updateUser(1, {});

    expect(after).toEqual(before);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(await rawUser(1)).toEqual(beforeRaw);
  });

  it('неизвестные ключи патча игнорируются', async () => {
    await ensureUser(1);
    const before = await getUser(1);
    const patch = { nickname: 'x' } as unknown as UserPatch;

    const after = await updateUser(1, patch);
    expect(after).toEqual(before);
  });

  it('несуществующий пользователь → null без создания строки', async () => {
    expect(await updateUser(999, { timezone: 'UTC' })).toBeNull();
    expect(await rawUser(999)).toBeNull();
  });

  it('проставляет updatedAt при реальном изменении', async () => {
    await ensureUser(1);
    const before = await getUser(1);
    const after = await updateUser(1, { name: 'Renamed' });

    expect(after?.name).toBe('Renamed');
    expect(after?.updatedAt).not.toBeNull();
    expect(after?.createdAt).toBe(before?.createdAt);
  });
});

describe('users: квоты', () => {
  it('addUsage накапливает токены за текущий месяц', async () => {
    const id = 1;
    await ensureUser(id);

    await addUsage(id, 50);
    await addUsage(id, 30);

    const user = await getUser(id);
    expect(user?.quotaTokens).toBe(80);
    expect(user?.quotaMonth).toBe(monthKey());

    const raw = await rawUser(id);
    expect(raw?.quota_tokens).toBe(80);
    expect(raw?.quota_month).toBe(monthKey());
  });

  it('addUsage сбрасывает счётчик при смене месяца (rollover)', async () => {
    const id = 2;
    await ensureUser(id);

    await db.run(sql`UPDATE users SET quota_month = ${'2020-01'}, quota_tokens = ${500} WHERE id = ${id}`);
    expect((await getUser(id))?.quotaTokens).toBe(500);

    await addUsage(id, 30);

    const user = await getUser(id);
    expect(user?.quotaTokens).toBe(30);
    expect(user?.quotaMonth).toBe(monthKey());
  });

  it('addUsage не трогает updated_at', async () => {
    const id = 3;
    await ensureUser(id);
    const before = await getUser(id);

    await addUsage(id, 10);

    expect((await getUser(id))?.updatedAt).toBe(before?.updatedAt);
  });

  it('setMonthlyQuota пишет лимит', async () => {
    await ensureUser(1);
    await setMonthlyQuota(1, 100_000);

    expect((await getUser(1))?.quotaLimit).toBe(100_000);
    expect((await rawUser(1))?.quota_limit).toBe(100_000);
  });
});

describe('users: изоляция по пользователю', () => {
  it('операции над юзером 1 не меняют строку юзера 2', async () => {
    await ensureUser(1);
    await ensureUser(2);

    const before2 = await rawUser(2);

    await updateUser(1, {
      name: 'User One',
      baseCurrency: 'USD',
      timezone: 'Asia/Tbilisi',
      summaryTime: '06:15',
      lowStimulationMode: true,
      byok: { ...BYOK },
    });
    await addUsage(1, 1_234);
    await setMonthlyQuota(1, 777);

    const after2 = await rawUser(2);
    expect(after2).toEqual(before2);

    // изменения действительно легли на первого
    const user1 = await getUser(1);
    expect(user1?.name).toBe('User One');
    expect(user1?.quotaTokens).toBe(1_234);
    expect(user1?.quotaLimit).toBe(777);
  });
});
