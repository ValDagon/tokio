#!/usr/bin/env node
// Bundle module-graph check for tgcloud V8 isolate builds.
//
// The isolate loads `tgcloud/` directly while tests resolve `src/`. An import from
// `lib/` back into `handlers/` passes typecheck and Vitest, then fails at module
// load in production because `build.mjs` only emits `handlers/message.js` and
// `handlers/callback_query.js` with helper modules bundled inside them.
//
// Usage:
//   node scripts/check_bundle_graph.mjs           — checks `tgcloud` if present;
//     skips cleanly when missing (`tgcloud/` is a gitignored build artifact).
//   node scripts/check_bundle_graph.mjs tgcloud   — requires the specified
//     bundle directory to exist and contain valid relative imports.
//
// Exit code: 0 — graph valid; 1 — dangling relative import or missing bundle.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUNDLES = ['tgcloud'];
const requested = process.argv.slice(2);
const bundles = requested.length > 0 ? requested : DEFAULT_BUNDLES;
const required = requested.length > 0;
const RELATIVE_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

let fail = 0;
let files = 0;
let imports = 0;

for (const bundle of bundles) {
  const root = resolve(ROOT, bundle);
  if (!existsSync(root)) {
    if (required) {
      console.error(`FAIL: не найден бандл ${bundle} (соберите: npm run build)`);
      fail = 1;
    } else {
      console.log(`NOTE: бандла ${bundle} нет — пропускаю (это артефакт сборки)`);
    }
    continue;
  }
  for (const file of walk(root)) {
    files += 1;
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      imports += 1;
      const target = resolve(dirname(file), match[1]);
      if (!existsSync(target) || !statSync(target).isFile()) {
        fail = 1;
        console.error(`FAIL: ${relative(ROOT, file)} → ${match[1]} (файла нет в бандле)`);
      }
    }
  }
}

if (fail) {
  console.error('check-bundle-graph: модульный граф разорван — изолят упадёт при загрузке модуля');
  process.exit(1);
}
console.log(`check-bundle-graph: ok — ${imports} относительных импортов в ${files} файлах, все резолвятся`);
