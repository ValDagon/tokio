import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_CURRENCY,
  DEFAULT_GEMINI_MODELS,
  DEFAULT_SUMMARY_TIME,
  DEFAULT_TIMEZONE,
  buildConfig,
  getConfig,
  loadSecrets,
  parseIds,
  parseModelChain,
  primaryModel,
  resetConfigCache,
  setConfigOverrides,
} from '../src/lib/config';
import { collectTargetFiles, normalizeAntiSplit, scanContent } from '../scripts/check-leaks.mjs';

afterEach(() => {
  resetConfigCache();
});

describe('дефолты конфига — нейтральные', () => {
  it('без секретов и окружения отдаёт нейтральные значения', () => {
    const config = buildConfig({}, {});

    expect(config.defaultTimezone).toBe('UTC');
    expect(config.defaultBaseCurrency).toBe('EUR');
    expect(config.defaultSummaryTime).toBe('07:00');
    expect(config.geminiApiKey).toBe('');
    expect(config.masterKey).toBe('');
    expect(config.betaWhitelist).toEqual([]);
    expect(config.adminIds).toEqual([]);
    expect(config.geminiModels).toEqual([...DEFAULT_GEMINI_MODELS]);
    expect(primaryModel(config)).toBe('gemini-4-hydrogen');
  });

  it('константы дефолтов совпадают с базовой спецификацией', () => {
    expect(DEFAULT_TIMEZONE).toBe('UTC');
    expect(DEFAULT_BASE_CURRENCY).toBe('EUR');
    expect(DEFAULT_SUMMARY_TIME).toBe('07:00');
  });

  it('пустые строки в секретах не считаются значением', () => {
    const config = buildConfig({ GEMINI_API_KEY: '   ', MASTER_KEY: '' }, {});
    expect(config.geminiApiKey).toBe('');
    expect(config.masterKey).toBe('');
  });
});

describe('источники значений', () => {
  it('окружение перекрывает секреты', () => {
    const config = buildConfig(
      { GEMINI_API_KEY: 'from-secrets', APP_BASE_CURRENCY: 'RSD' },
      { GEMINI_API_KEY: 'from-env', APP_BASE_CURRENCY: 'usd' },
    );
    expect(config.geminiApiKey).toBe('from-env');
    expect(config.defaultBaseCurrency).toBe('USD');
  });

  it('секреты подхватываются, если в окружении пусто', () => {
    const config = buildConfig(
      {
        GEMINI_API_KEY: ' g-key ',
        MASTER_KEY: 'm-key',
        BETA_WHITELIST: ['5', 6],
        ADMIN_IDS: '42',
        APP_TIMEZONE: 'Europe/Berlin',
      },
      {},
    );
    expect(config.geminiApiKey).toBe('g-key');
    expect(config.masterKey).toBe('m-key');
    expect(config.betaWhitelist).toEqual([5, 6]);
    expect(config.adminIds).toEqual([42]);
    expect(config.defaultTimezone).toBe('Europe/Berlin');
  });

  it('переменные окружения полноценно переопределяют дефолты', () => {
    const config = buildConfig(
      {},
      {
        APP_TIMEZONE: 'Europe/Berlin',
        APP_BASE_CURRENCY: 'usd',
        APP_SUMMARY_TIME: '08:30',
        BETA_WHITELIST: '1, 2 3',
        ADMIN_IDS: '777;888',
        GEMINI_MODELS: 'custom-model, backup-model',
      },
    );
    expect(config.defaultTimezone).toBe('Europe/Berlin');
    expect(config.defaultBaseCurrency).toBe('USD');
    expect(config.defaultSummaryTime).toBe('08:30');
    expect(config.betaWhitelist).toEqual([1, 2, 3]);
    expect(config.adminIds).toEqual([777, 888]);
    expect(config.geminiModels).toEqual(['custom-model', 'backup-model']);
  });
});

describe('разбор списков', () => {
  it('parseIds чистит мусор и дубликаты', () => {
    expect(parseIds('1, 2, 2, -3, x, 0, 7')).toEqual([1, 2, 7]);
    expect(parseIds([1, '2', ' 2 ', 'нет'])).toEqual([1, 2]);
    expect(parseIds('')).toEqual([]);
    expect(parseIds(null)).toEqual([]);
    expect(parseIds(undefined)).toEqual([]);
    expect(parseIds(123)).toEqual([123]);
  });

  it('parseModelChain сохраняет порядок и отбрасывает дубликаты', () => {
    expect(parseModelChain('a, a  b,b c')).toEqual(['a', 'b', 'c']);
    expect(parseModelChain(['a', 'b a'])).toEqual(['a', 'b']);
    expect(parseModelChain('')).toEqual([...DEFAULT_GEMINI_MODELS]);
    expect(parseModelChain(null)).toEqual([...DEFAULT_GEMINI_MODELS]);
  });
});

describe('getConfig и подмена в тестах', () => {
  it('работает без secrets.js — файл не обязателен', async () => {
    await expect(loadSecrets()).resolves.toEqual({});

    const config = await getConfig();
    expect(config.defaultTimezone).toBe('UTC');
    expect(config.defaultBaseCurrency).toBe('EUR');
  });

  it('setConfigOverrides накладывается поверх, resetConfigCache сбрасывает', async () => {
    setConfigOverrides({ defaultBaseCurrency: 'USD', adminIds: [1] });
    const overridden = await getConfig();
    expect(overridden.defaultBaseCurrency).toBe('USD');
    expect(overridden.adminIds).toEqual([1]);
    expect(overridden.defaultTimezone).toBe('UTC');

    resetConfigCache();
    expect((await getConfig()).defaultBaseCurrency).toBe('EUR');

    setConfigOverrides({ defaultTimezone: 'Asia/Tokyo' });
    setConfigOverrides(null);
    expect((await getConfig()).defaultTimezone).toBe('UTC');
  });

  it('getConfig кэширует результат', async () => {
    const first = await getConfig();
    const second = await getConfig();
    expect(second).toBe(first);
  });
});

describe('нейтральность исходников и сканер утечек', () => {
  it('в публичном дереве репозитория нет структурных утечек Layer 1', () => {
    const repoRoot = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of collectTargetFiles(repoRoot)) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8');
      offenders.push(...scanContent(text, rel));
    }
    expect(offenders).toEqual([]);
  });

  it('сканер ловит структурные утечки, lowercase, split-join, email и клинические коды', () => {
    const tgcloudLeak = ['app', '1234567890', '.tgcloud.ai'].join('');
    const homeLeak = ['', 'Users', 'alice', 'work', ''].join('/');
    const mailLeak = ['alice', ['gmail', 'com'].join('.')].join('@');
    const icdLeak = ['F', '42.0'].join('');
    const ownerLeak = ['OWNER', 'TELEGRAM', 'ID'].join('_');

    const layer1Hits = scanContent(
      `${tgcloudLeak} ${homeLeak} ${mailLeak} ${icdLeak} ${ownerLeak}`,
      'src/sample.ts',
    );
    expect(layer1Hits.length).toBe(5);

    expect(normalizeAntiSplit("['Secret', 'Bank'].join('')")).toContain('secretbank');
    expect(
      scanContent("const x = ['sec', 'ret', 'marker'].join('');", 'src/sample.ts', {
        privatePatterns: ['SecretMarker'],
      }),
    ).toEqual(['[Layer2:private] src/sample.ts matched private pattern']);
    expect(
      scanContent("const y = 'secret' + 'marker';", 'src/sample.ts', {
        privatePatterns: ['SecretMarker'],
      }),
    ).toEqual(['[Layer2:private] src/sample.ts matched private pattern']);
  });
});
