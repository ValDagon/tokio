#!/usr/bin/env node
/**
 * 2-layer leak & hygiene scanner for the Tokio core repository.
 *
 * Layer 1 (always on): scans repository source, tests, docs, CI, hooks, and config
 * files for secrets/tokens, hardcoded deployment URLs, personal identifiers,
 * clinical markers, and personal email domains.
 *
 * Layer 2 (optional / `--require-private`): scans all files + git history against
 * `.forbidden-strings.local` or `process.env.FORBIDDEN_PATTERNS_B64` with
 * case-insensitive and anti-split normalization (`['a','b'].join('')`, `'a' + 'b'`).
 *
 * Flags:
 *   --require-private  Fail if neither `.forbidden-strings.local` nor `FORBIDDEN_PATTERNS_B64` exists.
 *   --git-history      Also scan `git log --all` commits, author/committer emails, and messages.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['src', 'miniapp/src', 'public-overlay', 'example', 'locales', 'tests', 'docs', '.agents', '.github', '.githooks', 'scripts'];
const ROOT_FILES = [
  'AGENTS.md',
  'CITATION.cff',
  'CONTRIBUTORS.md',
  'NOTICE',
  '.mailmap',
  '.env.example',
  '.gitignore',
  '.pre-commit-config.yaml',
  'tgcloud.jsonc',
  'build.mjs',
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'miniapp/package.json',
  'miniapp/index.html',
  'miniapp/README.md',
];
const ALLOWED_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.json', '.jsonc', '.md', '.css', '.html',
  '.py', '.sh', '.yml', '.yaml', '.cff', '.toml', '.txt',
]);
const EXTENSIONLESS_FILENAMES = new Set(['NOTICE', '.mailmap', 'pre-push', '.env.example', '.gitignore']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.tgcloud', 'tgcloud', 'miniapp-dist', '.agent-worktrees', 'overlay']);
const SELF_EXCLUDED_PATHS = new Set([
  'scripts/check-leaks.mjs',
  '.gitleaks.toml',
  'package-lock.json',
  'miniapp/package-lock.json',
]);

// Narrow, path-scoped rule exemptions (path -> exempt rule names). The public instance
// (`@LifeOS_Public_bot`) tracks its own overlay in the repo and its deployment URL is public
// by design: it backs that bot's Mini App button. The README documents the same address.
// `manifest.json` and `README.md` are the exact two paths `.gitleaks.toml` already exempts;
// every other overlay file is still fully scanned. Guard against widening: do not add a
// directory or a whole-prefix here.
const PATH_RULE_ALLOWLIST = new Map([
  ['public-overlay/manifest.json', new Set(['Hardcoded tgcloud URL'])],
  ['public-overlay/README.md', new Set(['Hardcoded tgcloud URL'])],
]);

export function normalizeAntiSplit(text) {
  return String(text)
    .replace(/\.join\s*\(\s*['"`]{2}\s*\)/g, '')
    .replace(/['"`]\s*\+\s*['"`]/g, '')
    .replace(/['"`\[\],\s]/g, '')
    .toLowerCase();
}

export const LAYER1_PATTERNS = [
  {
    name: 'Google API key',
    re: /AIza[0-9A-Za-z_-]{30,}/g,
    allowInTests: (m) => /dummy|test|fake|example/i.test(m),
  },
  {
    name: 'Gemini AQ key',
    re: /AQ\.Ab[0-9A-Za-z._-]{20,}/g,
    allowInTests: (m) => /testdummykey|dummy|test/i.test(m),
  },
  { name: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { name: 'tgcloud CLI token', re: /\bapp\d+:[A-Za-z0-9_-]{16,}\b/g },
  { name: 'Supabase project_ref', re: /project_ref=/g },
  { name: 'Hardcoded tgcloud URL', re: /app\d{10}\.tgcloud\.ai/g },
  { name: 'OWNER_TELEGRAM_ID', re: /\bOWNER_TELEGRAM_ID\b/g },
  { name: 'Local macOS user path', re: /\/Users\/[a-zA-Z0-9._-]+\//g },
  { name: 'Render URL', re: /onrender\.com/gi },
  { name: 'Cloudflare Pages URL', re: /pages\.dev/gi },
  { name: 'Private LifeOS instance string', re: /Private LifeOS instance/g },
  { name: 'Legacy personal bot dir', re: /\bhpd_life_os_bot\b/g },
  { name: 'Clinical ICD code', re: /\bF[24]\d\.\d\b/g },
  {
    name: 'Personal email domain',
    re: /[A-Za-z0-9._%+-]+@(?:gmail\.com|yandex\.(?:ru|com)|mail\.ru)\b/gi,
  },
];

export function scanContent(content, rel, options = {}) {
  const normalizedRel = rel.replace(/\\/g, '/');
  if (
    SELF_EXCLUDED_PATHS.has(normalizedRel) ||
    normalizedRel.endsWith('.generated.ts') ||
    normalizedRel.endsWith('.generated.js')
  ) {
    return [];
  }

  const violations = [];
  const isTest = normalizedRel.startsWith('tests/') || normalizedRel.endsWith('.test.ts') || normalizedRel.endsWith('.test.tsx');
  const exemptRules = PATH_RULE_ALLOWLIST.get(normalizedRel) ?? new Set();

  for (const rule of LAYER1_PATTERNS) {
    if (exemptRules.has(rule.name)) continue;
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(content)) !== null) {
      if (isTest && rule.allowInTests && rule.allowInTests(match[0])) continue;
      const line = content.slice(0, match.index).split('\n').length;
      violations.push(`[Layer1:${rule.name}] ${normalizedRel}:${line}`);
    }
  }

  const privatePatterns = options.privatePatterns ?? [];
  if (privatePatterns.length > 0) {
    const lowerContent = content.toLowerCase();
    const normalized = normalizeAntiSplit(content);
    for (const pat of privatePatterns) {
      const lowerPat = pat.toLowerCase();
      const normPat = normalizeAntiSplit(pat);
      if (lowerContent.includes(lowerPat) || (normPat && normalized.includes(normPat))) {
        violations.push(`[Layer2:private] ${normalizedRel} matched private pattern`);
      }
    }
  }

  return violations;
}

function shouldIncludeFile(name) {
  if (EXTENSIONLESS_FILENAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_EXT.has(name.slice(dot).toLowerCase());
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (shouldIncludeFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function loadPrivatePatterns(rootDir = ROOT) {
  const localForbiddenPath = join(rootDir, '.forbidden-strings.local');
  const privatePatterns = [];
  if (existsSync(localForbiddenPath)) {
    const lines = readFileSync(localForbiddenPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    privatePatterns.push(...lines);
  }
  if (process.env.FORBIDDEN_PATTERNS_B64) {
    const decoded = Buffer.from(process.env.FORBIDDEN_PATTERNS_B64, 'base64').toString('utf8');
    const lines = decoded
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    privatePatterns.push(...lines);
  }
  return privatePatterns;
}

export function collectTargetFiles(rootDir = ROOT) {
  const targetFiles = new Set();
  for (const dir of SCAN_DIRS) {
    for (const f of walk(join(rootDir, dir))) targetFiles.add(f);
  }
  // Root README*.md, SECURITY*.md, CONTRIBUTING*.md
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^(?:README|SECURITY|CONTRIBUTING)(?:\.[a-z-]+)?\.md$/i.test(entry.name)) {
      targetFiles.add(join(rootDir, entry.name));
    }
  }
  for (const file of ROOT_FILES) {
    const full = join(rootDir, file);
    if (existsSync(full) && statSync(full).isFile()) targetFiles.add(full);
  }
  return targetFiles;
}

function scanGitHistory(rootDir, privatePatterns) {
  if (!existsSync(join(rootDir, '.git'))) return [];
  let logText = '';
  try {
    logText = execSync('git log --all --format="%H %an <%ae> %cn <%ce> %s %b"', {
      cwd: rootDir,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  if (!logText.trim()) return [];
  return scanContent(logText, 'git-history', { privatePatterns });
}

function main() {
  const args = process.argv.slice(2);
  const requirePrivate = args.includes('--require-private');
  const includeHistory = args.includes('--git-history');

  const privatePatterns = loadPrivatePatterns(ROOT);
  if (requirePrivate && privatePatterns.length === 0) {
    console.error('check-leaks: --require-private specified, but no .forbidden-strings.local or FORBIDDEN_PATTERNS_B64 found.');
    process.exit(1);
  }

  const violations = [];
  const targetFiles = collectTargetFiles(ROOT);
  for (const filePath of targetFiles) {
    const rel = relative(ROOT, filePath).replace(/\\/g, '/');
    const content = readFileSync(filePath, 'utf8');
    violations.push(...scanContent(content, rel, { privatePatterns }));
  }

  // When Layer 2 patterns exist, also sweep every git-tracked file
  if (privatePatterns.length > 0 && existsSync(join(ROOT, '.git'))) {
    const trackedRaw = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
    for (const rel of trackedRaw.split(/\r?\n/).filter(Boolean)) {
      if (rel === '.forbidden-strings.local' || SELF_EXCLUDED_PATHS.has(rel)) continue;
      const full = join(ROOT, rel);
      if (!existsSync(full) || !statSync(full).isFile()) continue;
      const content = readFileSync(full, 'utf8');
      for (const hit of scanContent(content, rel, { privatePatterns })) {
        if (!violations.includes(hit)) violations.push(hit);
      }
    }
  }

  if (includeHistory) {
    violations.push(...scanGitHistory(ROOT, privatePatterns));
  }

  if (violations.length > 0) {
    console.error(`check-leaks: FAILED (${violations.length} violation(s)):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  const modeNote = includeHistory ? ' + git history' : '';
  console.log(`check-leaks: ok (${targetFiles.size} files scanned${modeNote}, 0 violations)`);
}

const isCli =
  typeof process.argv[1] === 'string' &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    basename(process.argv[1]) === 'check-leaks.mjs');

if (isCli) {
  main();
}
