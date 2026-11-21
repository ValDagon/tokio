import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Platform modules ('sdk', 'sdk/db', 'sdk/api', 'sdk/fetch') only exist inside the
// tgcloud isolate. For local tests every one of them resolves to a single mock
// module (better-sqlite3 + recorded Bot API calls), so a test can import the same
// `db`/`api` singletons the code under test uses.
const sdkMock = fileURLToPath(new URL('./tests/mocks/sdk.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^sdk$/, replacement: sdkMock },
      { find: /^sdk\/(db|api|fetch)$/, replacement: sdkMock },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
});
