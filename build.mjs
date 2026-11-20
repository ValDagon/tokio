// Transpile-only build: src/**/*.ts -> tgcloud/**/*.js
//
// Deliberately NOT a bundle: the tgcloud isolate loads each module separately, so
// module structure and singletons (db handles, caches) must be preserved.
// Layout after the build (outbase = src, outdir = tgcloud):
//   src/schema.ts        -> tgcloud/schema.js
//   src/lib/x.ts         -> tgcloud/lib/x.js
//   src/handlers/a.ts    -> tgcloud/handlers/a.js
//   src/endpoints/b.ts   -> tgcloud/endpoints/b.js
//
// SDK imports ('sdk', 'sdk/db', 'sdk/api', 'sdk/fetch') stay external: the platform
// provides them. No node_modules imports are allowed in deployed code.

import { build } from 'esbuild';
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRuntimeAssets } from './scripts/compile-runtime-assets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { overlaySource } = await compileRuntimeAssets({ rootDir: __dirname });
console.log(`build: overlay source: ${overlaySource}`);

const SECRETS_STUB = `// Auto-generated fallback stub for compilation. Real secrets deployed to tgcloud/lib/secrets.js.
export const GEMINI_API_KEY = '';
export const MASTER_KEY = '';
export const BETA_WHITELIST = [];
export const ADMIN_IDS = [];
export const WEBHOOK_SECRET = '';
export const WHITELIST_IDS = [];
`;
mkdirSync('src/lib', { recursive: true });
mkdirSync('tgcloud/lib', { recursive: true });
if (!existsSync('src/lib/secrets.ts')) {
  writeFileSync('src/lib/secrets.ts', SECRETS_STUB);
}
if (!existsSync('tgcloud/lib/secrets.js')) {
  writeFileSync('tgcloud/lib/secrets.js', SECRETS_STUB);
}

const SRC_DIR = 'src';
const OUT_DIR = 'tgcloud';

/** Collect every .ts source under src/ (declaration and test files excluded). */
async function collectEntries(dir = SRC_DIR) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = full.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      // Root db/ and vendor/ are shims for tests; real code lives under lib/
      if (dir === SRC_DIR && (entry.name === 'db' || entry.name === 'vendor')) continue;
      if (rel === 'src/lib/agent/tools') continue;
      found.push(...(await collectEntries(full)));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue; // types only, never deployed
    if (entry.name.includes('.example.') || entry.name.endsWith('.example.ts')) continue; // never deploy examples
    if (dir === SRC_DIR && entry.name === 'types.ts') continue; // root types shim
    if (dir === path.join(SRC_DIR, 'lib') && entry.name === 'secrets.ts') continue; // secrets managed directly in tgcloud/lib/secrets.js
    if (
      rel === 'src/lib/overlay.ts' ||
      rel === 'src/lib/overlay.generated.ts' ||
      rel === 'src/lib/i18n.ts' ||
      rel === 'src/lib/i18n.generated.ts'
    ) {
      continue;
    }
    if (rel.startsWith('src/lib/agent/tools/')) continue;
    if (rel === 'src/lib/db/ddl.ts') continue;
    // Handlers helpers are bundled into handlers/message.js (tgcloud allows only update type names in handlers/)
    if (dir === path.join(SRC_DIR, 'handlers') && entry.name !== 'message.ts' && entry.name !== 'callback_query.ts') {
      continue;
    }
    found.push(full);
  }
  return found;
}

/** Remove previously emitted .js/.js.map so renamed/removed sources don't linger. */
async function cleanOutput(dir = OUT_DIR) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `lib/` also holds hand-written secrets.js — only drop build output
      await cleanOutput(full);
      continue;
    }
    // Remove any example files unconditionally (tgcloud throws MODULE_NAME_INVALID for dots in stems)
    if (entry.name.includes('.example.') || entry.name === 'secrets.example.js') {
      await rm(full, { force: true });
      continue;
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) {
      // keep hand-maintained secrets.js (only secrets.js, never secrets.example.js)
      if (entry.name === 'secrets.js') continue;
      await rm(full, { force: true });
    }
  }
}

const allEntries = await collectEntries();
const entryPoints = allEntries.filter(
  (p) =>
    p !== path.join(SRC_DIR, 'schema.ts') &&
    p !== path.join(SRC_DIR, 'handlers/message.ts') &&
    p !== path.join(SRC_DIR, 'handlers/callback_query.ts'),
);
if (entryPoints.length === 0) {
  console.error(`build: no TypeScript sources found in ${SRC_DIR}/`);
  process.exit(1);
}

await cleanOutput();

await build({
  entryPoints,
  outbase: SRC_DIR,
  outdir: OUT_DIR,
  bundle: false, // transpile only
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  loader: { '.ts': 'ts' },
});

// handlers/message.ts bundles its helper modules (router, formatting, keyboards, onboarding)
await build({
  entryPoints: [path.join(SRC_DIR, 'handlers/message.ts')],
  outfile: path.join(OUT_DIR, 'handlers/message.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external: ['sdk', 'sdk/*', '../lib/*'],
});

// handlers/callback_query.ts bundles its helper modules (router, formatting, keyboards, summary, etc.)
await build({
  entryPoints: [path.join(SRC_DIR, 'handlers/callback_query.ts')],
  outfile: path.join(OUT_DIR, 'handlers/callback_query.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external: ['sdk', 'sdk/*', '../lib/*'],
});

// Bundle src/lib/overlay.ts (+ overlay.generated.ts) into a single module tgcloud/lib/overlay.js
await build({
  entryPoints: [path.join(SRC_DIR, 'lib/overlay.ts')],
  outfile: path.join(OUT_DIR, 'lib/overlay.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external: ['sdk', 'sdk/*'],
});

// Bundle src/lib/i18n.ts (+ i18n.generated.ts) into a single module tgcloud/lib/i18n.js
if (existsSync(path.join(SRC_DIR, 'lib/i18n.ts'))) {
  await build({
    entryPoints: [path.join(SRC_DIR, 'lib/i18n.ts')],
    outfile: path.join(OUT_DIR, 'lib/i18n.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    sourcemap: true,
    external: ['sdk', 'sdk/*'],
  });
}

// tgcloud/schema.js must be a self-contained single file without imports from lib/
await build({
  entryPoints: [path.join(SRC_DIR, 'schema.ts')],
  outfile: path.join(OUT_DIR, 'schema.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external: ['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch'],
});

// Bundle all domain tool files under src/lib/agent/tools/ into tgcloud/lib/agent/tools/index.js
// while keeping imports outside src/lib/agent/tools/ external so shared singletons are never duplicated.
const toolsDir = resolve(__dirname, 'src/lib/agent/tools');
await build({
  entryPoints: [path.join(SRC_DIR, 'lib/agent/tools/index.ts')],
  outfile: path.join(OUT_DIR, 'lib/agent/tools/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  keepNames: true,
  external: ['sdk', 'sdk/*'],
  plugins: [
    {
      name: 'externalize-outside-tools',
      setup(b) {
        b.onResolve({ filter: /^\.\./ }, (args) => {
          let relFromTools = relative(toolsDir, resolve(dirname(args.importer), args.path)).replace(/\\/g, '/');
          if (!relFromTools.startsWith('..')) return undefined;
          relFromTools = relFromTools.replace(/\.ts$/, '');
          if (!relFromTools.endsWith('.js')) relFromTools += '.js';
          return { path: relFromTools, external: true };
        });
      },
    },
  ],
});

// Ensure all relative imports in emitted JS end with .js
async function fixRelativeImports(dir = OUT_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fixRelativeImports(full);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.map')) continue;
    const content = await (await import('node:fs/promises')).readFile(full, 'utf-8');
    const fixed = content
      .replace(/((?:from|import)\s+['"])(\.[^'"]+)(['"])/g, (m, p1, spec, p3) => {
        if (!spec.endsWith('.js')) return `${p1}${spec}.js${p3}`;
        return m;
      })
      .replace(/(import\s*\(\s*['"])(\.[^'"]+)(['"]\s*\))/g, (m, p1, spec, p3) => {
        if (!spec.endsWith('.js')) return `${p1}${spec}.js${p3}`;
        return m;
      });
    if (fixed !== content) {
      await (await import('node:fs/promises')).writeFile(full, fixed, 'utf-8');
    }
  }
}
await fixRelativeImports();

// Платформа отбивает приложение больше 100 модулей: `Too many modules per app`.
// Проверено на 101 — push падает уже после git push, то есть в самом конце
// деплоя, когда откатывать дороже всего. Считаем ровно то, что уезжает в
// изолят: все собранные .js вместе с рукописным lib/secrets.js. Гейт живёт
// здесь, а не только в check_bundle_graph, потому что реальный счётчик видит
// только сборка.
const MODULE_CAP = 100;

async function countModules(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countModules(path.join(dir, entry.name));
    else if (entry.name.endsWith('.js')) total += 1;
  }
  return total;
}

const deployedModules = await countModules(OUT_DIR);
if (deployedModules > MODULE_CAP) {
  console.error(
    `build: ${deployedModules} модулей в ${OUT_DIR}/ — платформа отклонит push (лимит ${MODULE_CAP}).`,
  );
  console.error(
    'build: объедините модули в один (пример: src/lib/vendor/crypto.ts) или вшейте помощники внутрь родителя.',
  );
  process.exit(1);
}

const reportedEntries = [
  ...allEntries,
  path.join(SRC_DIR, 'lib/overlay.ts'),
  ...(existsSync(path.join(SRC_DIR, 'lib/i18n.ts')) ? [path.join(SRC_DIR, 'lib/i18n.ts')] : []),
  path.join(SRC_DIR, 'lib/agent/tools/index.ts'),
];
const count = reportedEntries.length;
console.log(`build: ${count} source(s), ${deployedModules} module(s) -> ${OUT_DIR}/ (лимит ${MODULE_CAP})`);
for (const entry of reportedEntries) {
  const out = path.join(OUT_DIR, path.relative(SRC_DIR, entry).replace(/\.ts$/, '.js'));
  if (!existsSync(out)) continue;
  const size = (await stat(out)).size;
  console.log(`  ${entry} -> ${out} (${size} B)`);
}
