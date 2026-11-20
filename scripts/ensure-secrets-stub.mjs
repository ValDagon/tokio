// Ensure the gitignored `src/lib/secrets.ts` fallback exists before typecheck/test.
//
// Real secrets live only on the operator machine and in the tgcloud isolate
// (`tgcloud/lib/secrets.js`). `src/lib/config.ts` imports `./secrets.js`
// statically (required by the tgcloud V8 isolate — dynamic import() is not
// supported there), so the module must resolve even on a fresh clone. CI and
// fresh checkouts therefore get this empty stub, written only when the file is
// absent, so a local operator copy is never overwritten. Empty values are
// intentional: `loadSecrets()` falls back to env/defaults, and under Vitest it
// returns `{}` outright, so the stub never leaks or overrides anything.

import { existsSync, writeFileSync } from 'node:fs';

const SECRETS_STUB = `// Auto-generated fallback stub for compilation. Real secrets deployed to tgcloud/lib/secrets.js.
export const WEBHOOK_SECRET = '';
export const WHITELIST_IDS: number[] = [];
export const MASTER_KEY = '';
export const GEMINI_API_KEY = '';
export const ADMIN_IDS: number[] = [];
export const BETA_WHITELIST: number[] = [];
`;

if (!existsSync('src/lib/secrets.ts')) {
  writeFileSync('src/lib/secrets.ts', SECRETS_STUB);
}
