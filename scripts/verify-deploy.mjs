#!/usr/bin/env node
// Post-deploy verification for the public Telegram Serverless instance.
//
// A green `deploy` job proves only that `tgcloud push` returned 0. Revision 58
// showed why that is not enough: CI built from a fresh checkout, `build.mjs`
// wrote its empty `tgcloud/lib/secrets.js` stub, and the push happily deployed a
// bot without `ADMIN_IDS` or `GEMINI_API_KEY`. This script checks the two things
// a job log cannot: the module that is actually deployed, and the live host.
//
// Checks:
//   1. Deployed secrets module (optional, `--snapshot`) — the cloud copy of
//      `tgcloud/lib/secrets.js` fetched by `npx tgcloud fetch` into
//      `.tgcloud/remote/`, which must not be the build stub and must carry a
//      non-empty `ADMIN_IDS` and a non-empty `GEMINI_API_KEY`.
//   2. Live smoke — `/` answers 200 with HTML, every asset referenced by that
//      HTML answers 200, and `POST /api/rpc` rejects an unsigned request (401).
//
// Never printed: the secret values. The report names the field and says
// `present` / `empty`, nothing else, so this can run in a public job log.
//
// Usage:
//   node scripts/verify-deploy.mjs --url https://<your-app>.tgcloud.ai
//   node scripts/verify-deploy.mjs --url https://<your-app>.tgcloud.ai --snapshot .tgcloud/remote/lib/secrets.js
//
// Options:
//   --url <base>       Base URL of the deployed app (required).
//   --snapshot <path>  Deployed `lib/secrets.js` from the cloud snapshot.
//                      Omit to skip check 1 (local runs without `tgcloud fetch`).
//   --attempts <n>     Attempts per HTTP check, default 3 (deploy propagation).
//   --timeout <ms>     Per-request timeout, default 15000.
//
// Exit code: 0 — every requested check passed; 1 — a check failed; 2 — bad usage.
import { readFileSync } from 'node:fs';

const STUB_MARKER = 'Auto-generated fallback stub';
const ADMIN_IDS_ASSIGNMENT = /(?:export\s+)?(?:const|let|var)\s+ADMIN_IDS\s*(?::\s*number\[\])?\s*=\s*\[([\s\S]*?)\]/;
const GEMINI_KEY_ASSIGNMENT = /(?:export\s+)?(?:const|let|var)\s+GEMINI_API_KEY\s*(?::\s*string)?\s*=\s*(['"])([\s\S]*?)\1/;

function parseArgs(argv) {
  const options = { attempts: 3, timeout: 15000 };
  const known = new Set(['--url', '--snapshot', '--attempts', '--timeout']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!known.has(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    options[flag.slice(2)] = value;
    i += 1;
  }
  for (const name of ['attempts', 'timeout']) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] <= 0) throw new Error(`--${name} must be a positive integer`);
  }
  return options;
}

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(message) {
  console.log(`ok: ${message}`);
}

function fail(message, hint) {
  failures.push({ message, hint });
  console.error(`::error::${message}${hint ? ` — ${hint}` : ''}`);
}

/** Runs `probe` until it returns a result or the attempt budget is spent. */
async function retry(label, attempts, probe) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await probe();
    if (last.ok || attempt === attempts) return last;
    console.log(`retry ${attempt}/${attempts - 1}: ${label} — ${last.reason}`);
    await sleep(1500 * attempt);
  }
  return last;
}

async function request(url, init, timeout) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    const text = await response.text();
    return { response, text, bytes: Buffer.byteLength(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check 1 — the deployed secrets module is real.
 * Reads the cloud snapshot only; values never reach the log.
 */
function checkSecretsModule(snapshotPath) {
  let text;
  try {
    text = readFileSync(snapshotPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`deployed secrets module unreadable at ${snapshotPath}`, reason);
    return;
  }

  if (text.includes(STUB_MARKER)) {
    fail('deployed tgcloud/lib/secrets.js is the build stub', 'run "npx tgcloud fetch" and restore the real module — see deploy.yml "Restore deployment secrets module"');
    return;
  }

  const adminMatch = text.match(ADMIN_IDS_ASSIGNMENT);
  const adminIds = adminMatch ? adminMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean) : [];
  const numericIds = adminIds.filter((entry) => /^\d+$/.test(entry));
  if (!adminMatch) fail('deployed tgcloud/lib/secrets.js has no ADMIN_IDS assignment');
  else if (numericIds.length === 0) fail('deployed ADMIN_IDS is empty', 'a deployed instance with no admin cannot answer anyone');
  else pass(`ADMIN_IDS present (${numericIds.length} numeric entr${numericIds.length === 1 ? 'y' : 'ies'}, values hidden)`);

  const keyMatch = text.match(GEMINI_KEY_ASSIGNMENT);
  if (!keyMatch) fail('deployed tgcloud/lib/secrets.js has no GEMINI_API_KEY assignment');
  else if (keyMatch[2].length === 0) fail('deployed GEMINI_API_KEY is empty', 'the agent cannot answer without a model key');
  else pass('GEMINI_API_KEY present (value hidden)');
}

/** Check 2 — the live host serves the app and still rejects unsigned RPC. */
async function checkLiveHost(base, options) {
  const root = new URL('./', base.endsWith('/') ? base : `${base}/`).href;

  const home = await retry('GET /', options.attempts, async () => {
    const result = await request(root, { redirect: 'follow' }, options.timeout);
    if (result.error) return { ok: false, reason: result.error };
    const { response } = result;
    if (response.status !== 200) return { ok: false, reason: `status ${response.status}` };
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) return { ok: false, reason: `content-type ${type || 'missing'}` };
    return { ok: true, html: result.text, bytes: result.bytes, finalUrl: response.url };
  });
  if (!home.ok) {
    fail(`GET ${root} did not answer 200 with HTML`, home.reason);
  } else {
    pass(`GET / answered 200 with HTML (${home.bytes} bytes, ${home.finalUrl})`);
    await checkAssets(home.html, home.finalUrl, options);
  }

  const rpc = await retry('POST /api/rpc', options.attempts, async () => {
    const result = await request(
      new URL('api/rpc', root).href,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual' },
      options.timeout,
    );
    if (result.error) return { ok: false, reason: result.error };
    if (result.response.status !== 401) return { ok: false, reason: `status ${result.response.status}` };
    return { ok: true };
  });
  if (!rpc.ok) fail(`POST /api/rpc did not answer 401 for an unsigned request`, rpc.reason);
  else pass('POST /api/rpc answered 401 for an unsigned request');
}

/** Every `assets/…` reference in the served HTML must resolve. */
async function checkAssets(html, pageUrl, options) {
  const references = new Set();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']*\/?assets\/[^"']+)["']/g)) {
    references.add(new URL(match[1], pageUrl).href);
  }
  if (references.size === 0) {
    fail('index.html references no built assets', 'the deployed Mini App bundle looks empty or the static snapshot is stale');
    return;
  }
  for (const assetUrl of references) {
    const asset = await retry(`GET ${assetUrl}`, options.attempts, async () => {
      const result = await request(assetUrl, { redirect: 'follow' }, options.timeout);
      if (result.error) return { ok: false, reason: result.error };
      if (result.response.status !== 200) return { ok: false, reason: `status ${result.response.status}` };
      if (result.bytes === 0) return { ok: false, reason: 'empty body' };
      return { ok: true, bytes: result.bytes };
    });
    if (!asset.ok) fail(`current asset ${assetUrl} did not answer 200`, asset.reason);
    else pass(`asset ${new URL(assetUrl).pathname} answered 200 (${asset.bytes} bytes)`);
  }
}

const USAGE = `usage: node scripts/verify-deploy.mjs --url <base> [--snapshot <path>] [--attempts <n>] [--timeout <ms>]`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-deploy: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.url) {
    console.error('verify-deploy: --url is required');
    console.error(USAGE);
    return 2;
  }

  if (options.snapshot) {
    checkSecretsModule(options.snapshot);
  } else {
    console.log('skip: no --snapshot given — the deployed secrets module is not checked');
  }
  await checkLiveHost(options.url, options);

  if (failures.length > 0) {
    console.error(`\nverify-deploy: ${failures.length} check(s) failed`);
    return 1;
  }
  console.log('\nverify-deploy: all checks passed');
  return 0;
}

process.exitCode = await main();
