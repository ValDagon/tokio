/**
 * Чистка протухших меток идемпотентности напоминаний (`pruneStaleKvLabels`)
 * и её ежедневный запуск (`runDailyKvPrune` из ночной задачи).
 *
 * Что здесь закреплено:
 *  - старые `liability_warn:` / `liability_review:` / `med_remind:` /
 *    `morning_digest:` удаляются;
 *  - свежие метки и чужие ключи выживают, в том числе похожий по началу ключ;
 *  - метка без значения, с битым JSON или без разборчивой даты не удаляется;
 *  - повторный проход ничего не удаляет (идемпотентность);
 *  - чистка едет из ночной задачи и не чаще одного раза в сутки.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { db, resetApi, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { kvGet, kvSet } from '../src/lib/dal/misc';
import { ensureUser } from '../src/lib/dal/users';
import { schedule } from '../src/lib/dal/due_jobs';
import {
  KV_LABEL_RETENTION_DAYS,
  pruneStaleKvLabels,
} from '../src/lib/reminders';
import {
  KV_PRUNE_MARKER_KEY,
  ensureJobHandlers,
  resetJobHandlers,
  runDailyKvPrune,
} from '../src/lib/jobs';
import handleUpdate from '../src/handlers/message';

const USER = 100001;
const NOW = new Date('2026-11-13T09:00:00.000Z');

beforeEach(async () => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
  resetApi();
  resetJobHandlers();
  await ensureUser(USER, 'Owner');
});

/** Все ключи `kv` — для проверки выживших и удалённых. */
async function kvKeys(): Promise<string[]> {
  const rows = await db.all<{ key: string }>(sql`SELECT "key" FROM kv ORDER BY "key"`);
  return rows.map((row) => row.key);
}

const STALE = {
  liability: `liability_warn:${USER}:7:2026-01`,
  review: `liability_review:${USER}:7:2026-01`,
  med: `med_remind:${USER}:3:2026-01-05:08:00`,
  digest: `morning_digest:${USER}:2026-01-05`,
};

const FRESH = {
  liability: `liability_warn:${USER}:7:2026-11`,
  review: `liability_review:${USER}:7:2026-11`,
  med: `med_remind:${USER}:3:2026-11-13:08:00`,
  digest: `morning_digest:${USER}:2026-11-13`,
};

async function seedMixedLabels(): Promise<void> {
  await kvSet(STALE.liability, JSON.stringify({ warnedAt: '2026-01-02T08:00:00.000Z', dueAt: '2026-01-05' }));
  await kvSet(STALE.review, JSON.stringify({ decision: 'paid', decidedAt: '2026-01-05T08:00:00.000Z', dueAt: '2026-01-05' }));
  await kvSet(STALE.med, JSON.stringify({ remindedAt: '2026-01-05T06:00:00.000Z', date: '2026-01-05' }));
  await kvSet(STALE.digest, JSON.stringify({ sentAt: '2026-01-05T06:00:00.000Z', digestDate: '2026-01-05' }));

  await kvSet(FRESH.liability, JSON.stringify({ warnedAt: '2026-11-12T08:00:00.000Z', dueAt: '2026-11-15' }));
  await kvSet(FRESH.review, JSON.stringify({ decision: 'unpaid', decidedAt: '2026-11-12T08:00:00.000Z', dueAt: '2026-11-15' }));
  await kvSet(FRESH.med, JSON.stringify({ remindedAt: '2026-11-13T06:00:00.000Z', date: '2026-11-13' }));
  await kvSet(FRESH.digest, JSON.stringify({ sentAt: '2026-11-13T06:00:00.000Z', digestDate: '2026-11-13' }));

  // Мусор: не JSON, не объект, нет даты, неразборчивая дата, дата-мусор.
  await kvSet(`liability_warn:${USER}:9:2026-02`, 'not json at all');
  await kvSet(`med_remind:${USER}:4:2026-02-01:07:00`, '[]');
  await kvSet(`morning_digest:${USER}:2026-02-01`, JSON.stringify({ sentAt: 'not-a-date' }));
  await kvSet(`liability_warn:${USER}:8:2026-02`, JSON.stringify({ dueAt: 'not-a-date' }));

  // Чужие ключи: служебные и похожие по началу (проверка экранирования `_`).
  await kvSet('schema_version', '23');
  // Ловушка экранирования: без ESCAPE `_` совпал бы с любым символом.
  await kvSet('liabilityXwarn:1', JSON.stringify({ dueAt: '2020-01-01' }));
  await kvSet(`liability_warn:${USER}:7:2026-01:extra`, JSON.stringify({ dueAt: '2026-01-05' }));
}

describe('pruneStaleKvLabels', () => {
  it('удаляет старые метки всех четырёх видов', async () => {
    await seedMixedLabels();

    const result = await pruneStaleKvLabels({ now: NOW });

    const keys = await kvKeys();
    expect(keys).not.toContain(STALE.liability);
    expect(keys).not.toContain(STALE.review);
    expect(keys).not.toContain(STALE.med);
    expect(keys).not.toContain(STALE.digest);
    // `:extra` — тоже старый ключ с тем же префиксом, он тоже метка.
    expect(keys).not.toContain(`liability_warn:${USER}:7:2026-01:extra`);
    expect(result.deleted).toBe(5);
  });

  it('оставляет свежие метки, чужие ключи и неразборчивые значения', async () => {
    await seedMixedLabels();

    const result = await pruneStaleKvLabels({ now: NOW });
    const keys = await kvKeys();

    expect(keys).toContain(FRESH.liability);
    expect(keys).toContain(FRESH.review);
    expect(keys).toContain(FRESH.med);
    expect(keys).toContain(FRESH.digest);
    expect(keys).toContain('schema_version');
    expect(keys).toContain('liabilityXwarn:1');
    expect(keys).toContain(`liability_warn:${USER}:9:2026-02`);
    expect(keys).toContain(`med_remind:${USER}:4:2026-02-01:07:00`);
    expect(keys).toContain(`morning_digest:${USER}:2026-02-01`);
    expect(keys).toContain(`liability_warn:${USER}:8:2026-02`);

    expect(result.kept).toBe(4);
    expect(result.skipped).toBe(4);
  });

  it('идемпотентен: повторный проход ничего не удаляет', async () => {
    await seedMixedLabels();

    const first = await pruneStaleKvLabels({ now: NOW });
    const second = await pruneStaleKvLabels({ now: NOW });

    expect(first.deleted).toBe(5);
    expect(second.deleted).toBe(0);
    expect(await kvKeys()).toEqual(
      expect.arrayContaining([FRESH.liability, FRESH.review, FRESH.med, FRESH.digest]),
    );
  });

  it('считает возраст по значению, а не по времени записи', async () => {
    // Свежая запись со старым `dueAt`: перезапись не делает метку новой.
    await kvSet(`liability_warn:${USER}:5:2026-03`, JSON.stringify({ dueAt: '2026-03-10' }));

    const result = await pruneStaleKvLabels({ now: NOW });

    expect(result.deleted).toBe(1);
    expect(await kvKeys()).not.toContain(`liability_warn:${USER}:5:2026-03`);
  });

  it('на горизонте хранения метка ещё живёт', async () => {
    const boundary = new Date(NOW.getTime() - KV_LABEL_RETENTION_DAYS * 86_400_000);
    const day = boundary.toISOString().slice(0, 10);
    await kvSet(`morning_digest:${USER}:${day}`, JSON.stringify({ digestDate: day }));

    const result = await pruneStaleKvLabels({ now: NOW });

    expect(result.deleted).toBe(0);
    expect(await kvKeys()).toContain(`morning_digest:${USER}:${day}`);
  });
});

describe('runDailyKvPrune', () => {
  it('чистит не чаще одного раза в сутки', async () => {
    await kvSet(STALE.digest, JSON.stringify({ digestDate: '2026-01-05' }));

    const first = await runDailyKvPrune({ now: NOW });
    expect(first?.deleted).toBe(1);
    expect(await kvGet(KV_PRUNE_MARKER_KEY)).toBe('2026-11-13');

    // Новая протухшая метка в тех же сутках: маркер держит, чистки нет.
    await kvSet(STALE.med, JSON.stringify({ date: '2026-01-05' }));
    expect(await runDailyKvPrune({ now: NOW })).toBeNull();
    expect(await kvKeys()).toContain(STALE.med);

    // Следующие сутки — снова чистит.
    const nextDay = new Date('2026-11-14T09:00:00.000Z');
    const second = await runDailyKvPrune({ now: nextDay });
    expect(second?.deleted).toBe(1);
    expect(await kvKeys()).not.toContain(STALE.med);
  });

  it('едет из ночной задачи: протухшая метка удаляется на прогоне due_jobs', async () => {
    const staleKey = `liability_warn:${USER}:7:2020-01`;
    await kvSet(staleKey, JSON.stringify({ dueAt: '2020-01-05' }));
    const freshKey = `liability_warn:${USER}:7:2020-01:fresh`;
    await kvSet(freshKey, JSON.stringify({ dueAt: '2099-01-05' }));

    await schedule(USER, 'nightly_consolidation', '2020-01-01T03:00:00.000Z');
    ensureJobHandlers();
    await handleUpdate(null);

    const keys = await kvKeys();
    expect(keys).not.toContain(staleKey);
    expect(keys).toContain(freshKey);
    expect(await kvGet(KV_PRUNE_MARKER_KEY)).not.toBeNull();
  });
});
