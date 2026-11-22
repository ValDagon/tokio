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
});
