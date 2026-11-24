/**
 * Regression suite for SPLITBRAIN1:
 * - Never injects a hardcoded production fallback API_BASE.
 * - Never falls back to direct HTTP writes when Serverless RPC fails.
 * - Flags GET reads served from a fallback host or offline local cache as stale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

type RpcCallback = (err: { message?: string } | null, result: unknown) => void;

let rpcImpl: (endpoint: string, params: Record<string, unknown>, cb: RpcCallback) => void;
let storage: Storage;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  storage = makeStorage();

  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: makeStorage(), configurable: true });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      localStorage: storage,
      location: { hash: '' },
      Telegram: {
        WebApp: {
          initData: 'user=%7B%22id%22%3A1%7D',
          initDataUnsafe: { user: { id: 1 } },
          Serverless: {
            call: (endpoint: string, params: Record<string, unknown>, cb: RpcCallback) => {
              rpcImpl(endpoint, params, cb);
            },
          },
        },
      },
    },
  });

  rpcImpl = (_endpoint, _params, cb) => cb({ message: 'edge unavailable' }, null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('API_BASE', () => {
  it('defaults to empty string in production', async () => {
    const { API_BASE } = await import('./api');
    expect(API_BASE).toBe('');
  });

  it('reads VITE_API_BASE_URL for local development and strips trailing slash', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8000/');
    const { API_BASE } = await import('./api');
    expect(API_BASE).toBe('http://localhost:8000');
  });
});

describe('request: RPC write guard and stale data source tracking', () => {
  it('blocks mutating POST fallback when Serverless RPC fails (ru default & en locale)', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://fallback.example');
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true });

    const { request, getDataSource } = await import('./api');

    await expect(
      request('/api/tasks', { method: 'POST', body: { title: 'blocked write' } }),
    ).rejects.toThrow(/Serverless RPC/);

    storage.setItem('tokio_locale', 'en');
    await expect(
      request('/api/tasks', { method: 'POST', body: { title: 'blocked write en' } }),
    ).rejects.toThrow(/Write failed: Serverless RPC is unavailable/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getDataSource()).toBe('live');
  });

  it('marks GET served through a foreign fallback host as stale fallback', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://fallback.example');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify([{ id: '1' }]), { status: 200 }));
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true });

    const { request, getDataSource, isStaleDataSource } = await import('./api');

    await expect(request('/api/tasks')).resolves.toEqual([{ id: '1' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getDataSource()).toBe('fallback');
    expect(isStaleDataSource()).toBe(true);
  });

  it('restores live source on subsequent RPC success and notifies subscribers', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://fallback.example');
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true });

    const { request, getDataSource, isStaleDataSource, subscribeDataSource } = await import('./api');

    const events: string[] = [];
    const unsubscribe = subscribeDataSource((source) => events.push(source));

    await request('/api/tasks');
    expect(getDataSource()).toBe('fallback');
    expect(isStaleDataSource()).toBe(true);

    rpcImpl = (_endpoint, _params, cb) => cb(null, [{ id: '2' }]);
    await expect(request('/api/tasks')).resolves.toEqual([{ id: '2' }]);
    expect(getDataSource()).toBe('live');
    expect(isStaleDataSource()).toBe(false);
    expect(events).toEqual(['fallback', 'live']);

    unsubscribe();
    rpcImpl = (_endpoint, _params, cb) => cb({ message: 'edge unavailable' }, null);
    await request('/api/tasks');
    expect(events).toEqual(['fallback', 'live']);
  });

  it('serves cached GET data when offline and marks source as cache', async () => {
    storage.setItem('edge_cache:/api/tasks', JSON.stringify([{ id: 'cached' }]));
    const fetchSpy = vi.fn(async () => new Response('{"detail":"down"}', { status: 500 }));
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true });

    const { request, getDataSource, isStaleDataSource } = await import('./api');

    await expect(request('/api/tasks')).resolves.toEqual([{ id: 'cached' }]);
    expect(getDataSource()).toBe('cache');
    expect(isStaleDataSource()).toBe(true);
  });

  it('retries GET wrapped in POST /api/rpc on tgcloud.ai up to 3 attempts, but never retries POST writes', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('VITE_API_BASE_URL', 'https://app999.tgcloud.ai');
      // Simulate standalone / non-Serverless environment so HTTP fallback is used directly
      const tgWin = window as unknown as { Telegram?: { WebApp?: { Serverless?: unknown } } };
      if (tgWin.Telegram?.WebApp) {
        delete tgWin.Telegram.WebApp.Serverless;
      }

      const fetchSpy = vi
        .fn()
        .mockRejectedValueOnce(new Error('net glitch 1'))
        .mockResolvedValueOnce(new Response('{"detail":"unavailable"}', { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'ok' }]), { status: 200 }));
      Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true });

      const { request } = await import('./api');

      const getPromise = request<Array<{ id: string }>>('/api/tasks');
      await vi.runAllTimersAsync();
      await expect(getPromise).resolves.toEqual([{ id: 'ok' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Mutating POST must attempt strictly once even on 503/network failure
      const postFetchSpy = vi
        .fn()
        .mockResolvedValue(new Response('{"detail":"unavailable"}', { status: 503 }));
      Object.defineProperty(globalThis, 'fetch', { value: postFetchSpy, configurable: true });

      await expect(
        request('/api/tasks', { method: 'POST', body: { title: 'single attempt' } }),
      ).rejects.toThrow();
      expect(postFetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Wave 3 UI config and settings endpoints', () => {
  it('fetchUiConfig preserves extended Wave 3 fields and merges partial payloads cleanly', async () => {
    rpcImpl = (_endpoint, params, cb) => {
      expect(params.path).toBe('/api/config/ui');
      expect(params.method).toBe('GET');
      cb(null, {
        brand: { assistantName: 'Nova', backupPrefix: 'nova-backup', supportContact: '' },
        finance: {
          reserveAmount: 350,
          accountAliases: [{ account: 'Main Card', patterns: ['main'] }],
          defaultAccountByCurrency: { EUR: 'Main Card' },
        },
        miniapp: {
          tabs: ['finances', 'today', 'system'],
          accountThemes: [{ pattern: 'Main Card', theme: 'primary', shortName: 'Main', roleLabel: 'Daily' }],
        },
        adhd: { focusLimit: 2, staleAfterDays: 5, overloadShieldEnabled: false },
        personas: [{ id: 'coach', name: 'Coach', description: 'Calm coach', instructions: 'Be gentle.' }],
        summary: { activeRoutinesCount: 2, totalRoutinesCount: 3, presetsCount: 1 },
      });
    };

    const { fetchUiConfig } = await import('./api');
    const cfg = await fetchUiConfig();
    expect(cfg.brand.assistantName).toBe('Nova');
    expect(cfg.finance.reserveAmount).toBe(350);
    expect(cfg.finance.accountAliases).toEqual([{ account: 'Main Card', patterns: ['main'] }]);
    expect(cfg.finance.defaultAccountByCurrency).toEqual({ EUR: 'Main Card' });
    expect(cfg.miniapp.tabs).toEqual(['finances', 'today', 'system']);
    expect(cfg.adhd).toEqual({ focusLimit: 2, staleAfterDays: 5, overloadShieldEnabled: false });
    expect(cfg.personas).toHaveLength(1);
    expect(cfg.summary).toEqual({ activeRoutinesCount: 2, totalRoutinesCount: 3, presetsCount: 1 });
  });

  it('fetchUiConfig falls back to DEFAULT_UI_CONFIG when RPC fails', async () => {
    const { fetchUiConfig, DEFAULT_UI_CONFIG } = await import('./api');
    const cfg = await fetchUiConfig();
    expect(cfg).toEqual(DEFAULT_UI_CONFIG);
  });

  it('calls routine toggle, preset apply, reset, and rollback RPC routes with write guard', async () => {
    const seen: Array<{ path: string; method: string; body: unknown }> = [];
    rpcImpl = (_endpoint, params, cb) => {
      seen.push({
        path: String(params.path),
        method: String(params.method),
        body: params.body,
      });
      cb(null, { ok: true });
    };

    const {
      toggleSettingsRoutine,
      applySettingsPreset,
      resetSettingsToDefault,
      rollbackSettingsChange,
    } = await import('./api');

    await toggleSettingsRoutine('morning_ping', false);
    await applySettingsPreset('deep_focus');
    await resetSettingsToDefault('all');
    await rollbackSettingsChange(1);

    expect(seen).toEqual([
      { path: '/api/settings/routines/morning_ping', method: 'PATCH', body: { enabled: false } },
      { path: '/api/settings/presets/deep_focus/apply', method: 'POST', body: undefined },
      { path: '/api/settings/reset', method: 'POST', body: { section: 'all' } },
      { path: '/api/settings/rollback', method: 'POST', body: { steps: 1 } },
    ]);

    // Write guard: failed RPC must reject without falling back to fetch
    vi.stubEnv('VITE_API_BASE_URL', 'https://fallback.example');
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, configurable: true });
    rpcImpl = (_endpoint, _params, cb) => cb({ message: 'rpc down' }, null);

    await expect(toggleSettingsRoutine('morning_ping', true)).rejects.toThrow(/Serverless RPC/);
    await expect(applySettingsPreset('deep_focus')).rejects.toThrow(/Serverless RPC/);
    await expect(resetSettingsToDefault('all')).rejects.toThrow(/Serverless RPC/);
    await expect(rollbackSettingsChange(1)).rejects.toThrow(/Serverless RPC/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
