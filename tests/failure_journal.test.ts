/**
 * `src/lib/evolution.ts` — журнал сбоев (MU-3).
 *
 * Проверяется наблюдаемое поведение, а не помощники:
 *  - один и тот же отказ агрегируется в один кластер, а разный текст ошибки
 *    не порождает новых кластеров;
 *  - ключи версионированы (`v1`) и разделены по `user_id`;
 *  - `detail` усечён и вычищен: без токенов, chat_id и file_id;
 *  - восстановление видно в агрегате и сбрасывается свежим сбоем;
 *  - отказ записи журнала не бросает наружу и не пишет рекурсивно.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb, sql, sqliteDDL } from './mocks/sdk';
import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { kvGet } from '../src/lib/dal/misc';
import {
  FAILURE_COUNT_PREFIX,
  FAILURE_DETAIL_LIMIT,
  FAILURE_KEY_VERSION,
  FAILURE_META_PREFIX,
  getFailureAggregate,
  listFailureAggregates,
  markFailureRecovered,
  normalizeFailureSignature,
  recordFailure,
  sanitizeFailureDetail,
} from '../src/lib/evolution';

const USER_A = 100001;
const USER_B = 42;

beforeEach(() => {
  resetDb();
  sqliteDDL(createTableStatements(TABLES));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Строки `kv` по префиксу — чтобы проверять сами ключи, а не только агрегаты. */
async function kvKeys(prefix: string): Promise<string[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.all<{ key: string }>(
    sql`SELECT "key" FROM kv WHERE "key" LIKE ${pattern} ESCAPE '\\' ORDER BY "key"`,
  );
  return rows.map((row) => row.key);
}

describe('журнал сбоев: агрегация', () => {
  it('одинаковый сбой увеличивает один счётчик, а не десятки кластеров', async () => {
    for (let i = 0; i < 3; i += 1) {
      const recorded = await recordFailure(USER_A, {
        stage: 'stt',
        media: 'voice',
        reason: 'transcription_failed',
      });
      expect(recorded?.count).toBe(i + 1);
    }

    const aggregates = await listFailureAggregates(USER_A);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({
      signature: 'stt|voice|transcription_failed|-',
      stage: 'stt',
      media: 'voice',
      reason: 'transcription_failed',
      tool: null,
      count: 3,
    });
    expect(aggregates[0]?.lastAt).toBeTruthy();
  });

  it('разный текст одной и той же ошибки даёт ту же сигнатуру', async () => {
    await recordFailure(USER_A, {
      stage: 'vision',
      media: 'photo',
      reason: 'vision_failed',
      detail: 'Network timeout while downloading photo',
    });
    await recordFailure(USER_A, {
      stage: 'vision',
      media: 'photo',
      reason: 'vision_failed',
      detail: 'HTTP 502 Bad Gateway',
    });
    await recordFailure(USER_A, {
      stage: 'vision',
      media: 'photo',
      reason: 'vision_failed',
    });

    const aggregates = await listFailureAggregates(USER_A);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.count).toBe(3);
    // в кластере — detail последнего события, а не список текстов
    expect(aggregates[0]?.detail).toBeNull();
  });

  it('разные коды дают разные кластеры и сортируются по частоте', async () => {
    await recordFailure(USER_A, { stage: 'agent', reason: 'llm_error' });
    await recordFailure(USER_A, { stage: 'agent', reason: 'llm_error' });
    await recordFailure(USER_A, {
      stage: 'agent',
      reason: 'tool_error',
      tool: 'add_task',
    });

    const aggregates = await listFailureAggregates(USER_A);
    expect(aggregates.map((item) => [item.signature, item.count])).toEqual([
      ['agent|none|llm_error|-', 2],
      ['agent|none|tool_error|add_task', 1],
    ]);
    expect(aggregates[1]?.tool).toBe('add_task');
  });

  it('неизвестный код не создаёт новый кластер', async () => {
    const signal = {
      stage: 'made_up_stage' as never,
      reason: 'Не удалось распознать голос: TypeError' as never,
      media: 'camera' as never,
      tool: '../../etc/passwd' as never,
    };

    const first = await recordFailure(USER_A, signal);
    const second = await recordFailure(USER_A, signal);

    expect(first?.signature).toBe(second?.signature);
    expect(first?.signature).toBe('other|none|other|etc_passwd');
    expect(await listFailureAggregates(USER_A)).toHaveLength(1);
  });

  it('ограничивает список агрегатов', async () => {
    await recordFailure(USER_A, { stage: 'stt', reason: 'transcription_failed' });
    await recordFailure(USER_A, { stage: 'vision', reason: 'vision_failed' });
    await recordFailure(USER_A, { stage: 'agent', reason: 'llm_error' });

    expect(await listFailureAggregates(USER_A, { limit: 2 })).toHaveLength(2);
    expect(await listFailureAggregates(USER_A, { limit: 1 })).toHaveLength(1);
  });
});

describe('журнал сбоев: namespace и версия ключей', () => {
  it('ключи версионированы и разделены по user_id', async () => {
    await recordFailure(USER_A, { stage: 'stt', reason: 'transcription_failed' });
    await recordFailure(USER_B, { stage: 'stt', reason: 'transcription_failed' });
    await recordFailure(USER_B, { stage: 'stt', reason: 'transcription_failed' });

    expect(
      await kvKeys(`${FAILURE_COUNT_PREFIX}:${FAILURE_KEY_VERSION}:`),
    ).toEqual([
      `${FAILURE_COUNT_PREFIX}:${FAILURE_KEY_VERSION}:${USER_A}:stt|none|transcription_failed|-`,
      `${FAILURE_COUNT_PREFIX}:${FAILURE_KEY_VERSION}:${USER_B}:stt|none|transcription_failed|-`,
    ]);

    expect((await getFailureAggregate(USER_A, 'stt|none|transcription_failed|-'))?.count).toBe(1);
    expect((await getFailureAggregate(USER_B, 'stt|none|transcription_failed|-'))?.count).toBe(2);
  });

  it('чужой пользователь не видит чужих агрегатов', async () => {
    await recordFailure(USER_A, { stage: 'agent', reason: 'step_limit' });
    expect(await listFailureAggregates(USER_B)).toEqual([]);
    expect(await getFailureAggregate(USER_B, 'agent|none|step_limit|-')).toBeNull();
  });

  it('сосед по префиксу не подмешивается: user 1 и user 12 не пересекаются', async () => {
    await recordFailure(1, { stage: 'stt', reason: 'download_failed' });
    await recordFailure(12, { stage: 'stt', reason: 'download_failed' });

    expect(await listFailureAggregates(1)).toHaveLength(1);
    expect(await listFailureAggregates(12)).toHaveLength(1);
  });

  it('пишет одинаковый счётчик в count и мету под одним префиксом версии', async () => {
    await recordFailure(USER_A, { stage: 'delivery', reason: 'delivery_failed' });

    expect(await kvKeys(`${FAILURE_META_PREFIX}:${FAILURE_KEY_VERSION}:${USER_A}:`)).toEqual([
      `${FAILURE_META_PREFIX}:${FAILURE_KEY_VERSION}:${USER_A}:delivery|none|delivery_failed|-`,
    ]);
    expect(
      await kvGet(
        `${FAILURE_COUNT_PREFIX}:${FAILURE_KEY_VERSION}:${USER_A}:delivery|none|delivery_failed|-`,
      ),
    ).toBe('1');
  });
});

describe('журнал сбоев: detail', () => {
  it('усекает detail до лимита', async () => {
    const long = `boom ${'о'.repeat(500)}`;
    const recorded = await recordFailure(USER_A, {
      stage: 'receipt',
      reason: 'parse_failed',
      detail: long,
    });

    expect(recorded?.detail).toHaveLength(FAILURE_DETAIL_LIMIT);
    expect(recorded?.detail?.endsWith('…')).toBe(true);

    const aggregate = await getFailureAggregate(USER_A, 'receipt|none|parse_failed|-');
    expect(aggregate?.detail).toHaveLength(FAILURE_DETAIL_LIMIT);
  });

  it('сохраняет только первую строку — дамп сообщения не протекает', async () => {
    const recorded = await recordFailure(USER_A, {
      stage: 'ingest',
      reason: 'download_failed',
      detail: 'Telegram getFileContent returned 400\nКупить молоко и позвонить маме',
    });

    expect(recorded?.detail).toBe('Telegram getFileContent returned 400');
    expect(recorded?.detail).not.toContain('молоко');
  });

  it('вырезает токены, chat_id и file_id', () => {
    const scrubbed = sanitizeFailureDetail(
      'send failed chat_id=100001 token=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw file_id=AgACAgIAAxkBAAI',
    );

    expect(scrubbed).toBeTruthy();
    expect(scrubbed).not.toContain('100001');
    expect(scrubbed).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    expect(scrubbed).not.toContain('AgACAgIAAxkBAAI');
    expect(scrubbed).toContain('[redacted]');
  });

  it('пустой detail превращается в null, а не в пустую строку', async () => {
    const recorded = await recordFailure(USER_A, {
      stage: 'agent',
      reason: 'empty_reply',
      detail: '   \n  ',
    });
    expect(recorded?.detail).toBeNull();
  });
});

describe('журнал сбоев: восстановление', () => {
  it('фиксирует recovery и сбрасывает его свежим сбоем', async () => {
    await recordFailure(USER_A, {
      stage: 'stt',
      media: 'voice',
      reason: 'transcription_failed',
    });

    const recoveredAt = await markFailureRecovered(USER_A, {
      stage: 'stt',
      media: 'voice',
      reason: 'transcription_failed',
    });
    expect(recoveredAt).toBeTruthy();

    const aggregate = await listFailureAggregates(USER_A);
    expect(aggregate[0]?.recoveredAt).toBe(recoveredAt);
    expect(aggregate[0]?.count).toBe(1);

    await recordFailure(USER_A, {
      stage: 'stt',
      media: 'voice',
      reason: 'transcription_failed',
    });

    const afterRepeat = await listFailureAggregates(USER_A);
    expect(afterRepeat[0]?.count).toBe(2);
    expect(afterRepeat[0]?.recoveredAt).toBeNull();
  });

  it('recovery по сигнатуре работает так же, как по сбою', async () => {
    await recordFailure(USER_A, { stage: 'vision', reason: 'vision_failed' });
    const at = await markFailureRecovered(USER_A, 'vision|none|vision_failed|-');
    expect(at).toBeTruthy();
    expect((await getFailureAggregate(USER_A, 'vision|none|vision_failed|-'))?.recoveredAt).toBe(at);
  });

  it('recovery без записи сбоя кластер не создаёт', async () => {
    await markFailureRecovered(USER_A, 'agent|none|step_limit|-');
    expect(await listFailureAggregates(USER_A)).toEqual([]);
  });

  it('recovery помечает только тот кластер, к которому относится повтор', async () => {
    // Два кластера одной стадии и медиа, но разных причин — повтор был у одного.
    await recordFailure(USER_A, { stage: 'ingest', media: 'voice', reason: 'transcription_failed' });
    await recordFailure(USER_A, { stage: 'ingest', media: 'voice', reason: 'download_failed' });

    const at = await markFailureRecovered(USER_A, {
      stage: 'ingest',
      media: 'voice',
      reason: 'transcription_failed',
    });
    expect(at).toBeTruthy();

    const aggregates = await listFailureAggregates(USER_A);
    const recovered = aggregates.find((row) => row.reason === 'transcription_failed');
    const untouched = aggregates.find((row) => row.reason === 'download_failed');
    expect(recovered?.recoveredAt).toBe(at);
    expect(untouched?.recoveredAt).toBeNull();
  });

  it('неудачный повтор recovery не ставит: отметка появляется только явным вызовом', async () => {
    await recordFailure(USER_A, { stage: 'vision', media: 'photo', reason: 'vision_failed' });
    await recordFailure(USER_A, { stage: 'vision', media: 'photo', reason: 'vision_failed' });

    const aggregate = (await listFailureAggregates(USER_A))[0];
    expect(aggregate?.count).toBe(2);
    expect(aggregate?.recoveredAt).toBeNull();
  });
});

describe('журнал сбоев: отказ записи', () => {
  it('не бросает и не пишет рекурсивно: ровно одна попытка записи', async () => {
    const runSpy = vi.spyOn(db, 'run').mockRejectedValue(new Error('database is locked'));

    const recorded = await recordFailure(USER_A, {
      stage: 'agent',
      reason: 'llm_error',
      detail: 'provider returned 500',
    });

    expect(recorded).toBeNull();
    // рекурсивной записи о неудачной записи нет — попытка ровно одна
    expect(runSpy).toHaveBeenCalledTimes(1);

    const writes = await db.all<{ key: string }>(`SELECT "key" FROM kv`);
    expect(writes).toEqual([]);
  });

  it('отказ recovery не бросает', async () => {
    vi.spyOn(db, 'run').mockRejectedValue(new Error('database is locked'));
    await expect(markFailureRecovered(USER_A, 'agent|none|llm_error|-')).resolves.toBeNull();
  });

  it('не оставляет фантомного инкремента, если упала запись меты', async () => {
    const realRun = db.run.bind(db);
    let calls = 0;
    vi.spyOn(db, 'run').mockImplementation(async (query, params) => {
      calls += 1;
      // 1 — сброс recovery, 2 — мета (падает), 3 — счётчик, которого быть не должно
      if (calls === 2) throw new Error('disk I/O error');
      return realRun(query, params);
    });

    const recorded = await recordFailure(USER_A, { stage: 'agent', reason: 'llm_error' });

    expect(recorded).toBeNull();
    expect(calls).toBe(2);
    expect(await kvGet(`failure_count:v1:${USER_A}:agent|none|llm_error|-`)).toBeNull();
  });

  it('невалидная строка сигнатуры не создаёт осиротевший ключ recovery', async () => {
    expect(await markFailureRecovered(USER_A, 'просто текст')).toBeNull();
    expect(await markFailureRecovered(USER_A, 'a|b|c')).toBeNull();
    expect(await kvKeys('failure_recovered:')).toEqual([]);
  });

  it('невалидный user_id не читает агрегаты', async () => {
    await recordFailure(USER_A, { stage: 'agent', reason: 'llm_error' });

    expect(await listFailureAggregates(Number.NaN)).toEqual([]);
    expect(await getFailureAggregate(Number.NaN, 'agent|none|llm_error|-')).toBeNull();
  });

  it('невалидный user_id не пишет и не бросает', async () => {
    await expect(
      recordFailure(Number.NaN, { stage: 'agent', reason: 'llm_error' }),
    ).resolves.toBeNull();
    await expect(markFailureRecovered(Number.NaN, 'agent|none|llm_error|-')).resolves.toBeNull();
  });
});

describe('normalizeFailureSignature', () => {
  it('строит сигнатуру из кодов, а не из detail', () => {
    const base = normalizeFailureSignature({ stage: 'stt', reason: 'empty_transcription' });
    const other = normalizeFailureSignature({
      stage: 'stt',
      reason: 'empty_transcription',
      detail: 'совершенно другой текст',
    });

    expect(base).toBe('stt|none|empty_transcription|-');
    expect(other).toBe(base);
  });

  it('нормализует имя инструмента и не пускает произвольные символы в ключ', () => {
    expect(
      normalizeFailureSignature({
        stage: 'agent',
        reason: 'tool_error',
        tool: '  Add_Task  ',
      }),
    ).toBe('agent|none|tool_error|add_task');

    expect(
      normalizeFailureSignature({
        stage: 'agent',
        reason: 'tool_error',
        tool: 'a'.repeat(80),
      }),
    ).toHaveLength('agent|none|tool_error|'.length + 32);
  });
});
