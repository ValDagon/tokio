#!/usr/bin/env node
/**
 * Build-time compiler for Overlay assets and Locale catalogs.
 *
 * Reads `overlay/manifest.json` (or `OVERLAY_DIR`, falling back to `example/overlay/`),
 * validates the schema, loads all localized Markdown prompts and `example/seed/demo.json`,
 * and emits V8-isolate-safe TypeScript modules with zero `node:fs` runtime imports:
 *   - `src/lib/overlay.generated.ts`
 *   - `src/lib/i18n.generated.ts`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

const SUPPORTED_LOCALES = ['ru', 'en', 'sr', 'ja'];
const PROMPT_SECTIONS = ['identity', 'mission', 'principles', 'classifier'];

function readJson(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`compile-runtime-assets: missing ${label} at ${filePath}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `compile-runtime-assets: invalid JSON in ${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validateManifest(manifest, manifestPath) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`compile-runtime-assets: manifest at ${manifestPath} must be a JSON object`);
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `compile-runtime-assets: unsupported schemaVersion=${String(manifest.schemaVersion)} in ${manifestPath} (expected 1)`,
    );
  }
  if (
    !manifest.brand ||
    typeof manifest.brand !== 'object' ||
    typeof manifest.brand.assistantName !== 'string' ||
    !manifest.brand.assistantName.trim()
  ) {
    throw new Error(
      `compile-runtime-assets: brand.assistantName must be a non-empty string in ${manifestPath}`,
    );
  }
  if (!manifest.features || typeof manifest.features !== 'object' || Array.isArray(manifest.features)) {
    throw new Error(`compile-runtime-assets: features must be an object in ${manifestPath}`);
  }
  if (
    !manifest.prompts ||
    typeof manifest.prompts !== 'object' ||
    !manifest.prompts.locales ||
    typeof manifest.prompts.locales !== 'object'
  ) {
    throw new Error(`compile-runtime-assets: prompts.locales must be an object in ${manifestPath}`);
  }
  for (const locale of SUPPORTED_LOCALES) {
    const locPrompts = manifest.prompts.locales[locale];
    if (!locPrompts || typeof locPrompts !== 'object') {
      throw new Error(
        `compile-runtime-assets: prompts.locales.${locale} is missing in ${manifestPath}`,
      );
    }
    for (const section of PROMPT_SECTIONS) {
      if (typeof locPrompts[section] !== 'string' || !locPrompts[section].trim()) {
        throw new Error(
          `compile-runtime-assets: prompts.locales.${locale}.${section} must be a non-empty path in ${manifestPath}`,
        );
      }
    }
  }
}

function resolveOverlayDir(rootDir, explicitOverlayDir) {
  const exampleDir = resolve(rootDir, 'example/overlay');
  const customDir = resolve(rootDir, 'overlay');

  let chosenDir;
  if (explicitOverlayDir && String(explicitOverlayDir).trim()) {
    chosenDir = resolve(rootDir, String(explicitOverlayDir).trim());
  } else if (process.env.OVERLAY_DIR && process.env.OVERLAY_DIR.trim()) {
    chosenDir = resolve(rootDir, process.env.OVERLAY_DIR.trim());
  } else if (existsSync(resolve(customDir, 'manifest.json'))) {
    chosenDir = customDir;
  } else {
    chosenDir = exampleDir;
  }

  const overlaySource = resolve(chosenDir) === resolve(exampleDir) ? 'example' : 'custom';
  return { overlayDir: chosenDir, overlaySource };
}

function writeIfChanged(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const prev = readFileSync(filePath, 'utf8');
    if (prev === content) return false;
  }
  writeFileSync(filePath, content, 'utf8');
  return true;
}

/**
 * Compiles overlay manifest + prompts + demo seed and locale JSON catalogs into
 * generated TypeScript modules inside `src/lib/`.
 *
 * @param {{ rootDir?: string; overlayDir?: string; write?: boolean }} [options]
 */
export async function compileRuntimeAssets(options = {}) {
  const rootDir = resolve(options.rootDir ?? DEFAULT_ROOT);
  const shouldWrite = options.write !== false;

  const { overlayDir, overlaySource } = resolveOverlayDir(rootDir, options.overlayDir);
  const manifestPath = resolve(overlayDir, 'manifest.json');
  const manifest = readJson(manifestPath, 'overlay manifest');
  validateManifest(manifest, manifestPath);

  const prompts = {};
  for (const locale of SUPPORTED_LOCALES) {
    prompts[locale] = {};
    for (const section of PROMPT_SECTIONS) {
      const relPath = manifest.prompts.locales[locale][section];
      const absPath = resolve(overlayDir, relPath);
      if (!existsSync(absPath)) {
        throw new Error(
          `compile-runtime-assets: missing prompt file for ${locale}.${section}: ${absPath}`,
        );
      }
      prompts[locale][section] = readFileSync(absPath, 'utf8').trim();
    }
  }

  const demoSeedPath = resolve(rootDir, 'example/seed/demo.json');
  const demoSeed = readJson(demoSeedPath, 'demo seed');

  const compiledOverlay = {
    manifest,
    prompts,
  };

  const relOverlay = relative(rootDir, overlayDir).replace(/\\/g, '/');
  const displayOverlay = !relOverlay || relOverlay.startsWith('..') ? 'external' : relOverlay;
  const overlayGeneratedPath = resolve(rootDir, 'src/lib/overlay.generated.ts');
  const overlayTs = `// Auto-generated by scripts/compile-runtime-assets.mjs — DO NOT EDIT MANUALLY.
// Source: ${overlaySource} (${displayOverlay})

import type { CompiledOverlay, DemoSeedCatalog, OverlaySource } from './overlay.js';

export const OVERLAY_SOURCE: OverlaySource = ${JSON.stringify(overlaySource)};

export const COMPILED_OVERLAY: CompiledOverlay = ${JSON.stringify(compiledOverlay, null, 2)};

export const COMPILED_DEMO_SEED: DemoSeedCatalog = ${JSON.stringify(demoSeed, null, 2)};
`;

  const compiledLocales = {};
  for (const locale of SUPPORTED_LOCALES) {
    const localePath = resolve(rootDir, `locales/${locale}.json`);
    if (existsSync(localePath)) {
      compiledLocales[locale] = readJson(localePath, `locale ${locale}`);
    } else {
      compiledLocales[locale] = {};
    }
  }

  const i18nGeneratedPath = resolve(rootDir, 'src/lib/i18n.generated.ts');
  const i18nTs = `// Auto-generated by scripts/compile-runtime-assets.mjs — DO NOT EDIT MANUALLY.

export const COMPILED_LOCALES: Record<'ru' | 'en' | 'sr' | 'ja', Record<string, unknown>> = ${JSON.stringify(compiledLocales, null, 2)};
`;

  if (shouldWrite) {
    writeIfChanged(overlayGeneratedPath, overlayTs);
    writeIfChanged(i18nGeneratedPath, i18nTs);
  }

  return {
    overlayDir,
    overlaySource,
    compiledOverlay,
    demoSeed,
    compiledLocales,
    files: {
      overlayGeneratedPath,
      i18nGeneratedPath,
    },
  };
}

const isCli =
  typeof process.argv[1] === 'string' &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].endsWith('compile-runtime-assets.mjs'));

if (isCli) {
  compileRuntimeAssets()
    .then(({ overlaySource, overlayDir }) => {
      console.log(`compile-runtime-assets: ok (overlay source: ${overlaySource}, dir: ${overlayDir})`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
