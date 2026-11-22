import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sqliteDDL } from './mocks/sdk';

import { TABLES } from '../src/db/tables';
import { createTableStatements } from '../src/db/ddl';
import { buildSystemPrompt, evaluateExecutiveOverload } from '../src/lib/agent/prompts';
import { checkSpendLimit } from '../src/lib/billing';
import { resetConfigCache } from '../src/lib/config';
import { listAccounts, listLiabilities } from '../src/lib/dal/finances';
import { listNotes, searchNotesHybrid } from '../src/lib/dal/notes';
import { listTasks } from '../src/lib/dal/tasks';
import { ensureUser } from '../src/lib/dal/users';
import { matchExplicitAccount } from '../src/lib/financial-parser';
import {
  getAssistantName,
  getOverlay,
  getOverlayPrompt,
  getOverlaySource,
  isPublicOpenAccessEnabled,
  resetOverlayOverride,
  setOverlayOverride,
  type OverlayFeatures,
  type OverlayOverride,
} from '../src/lib/overlay';
import { balanceSummary, debtsSummary, helpText, quickSummary } from '../src/lib/summary';
import {
  ACCESS_UNCONFIGURED_MESSAGE,
  checkAccess,
  ensureUserProfile,
  seedDemoWorkspace,
} from '../src/handlers/onboarding';
// @ts-expect-error ESM build script without .d.ts
import { compileRuntimeAssets } from '../scripts/compile-runtime-assets.mjs';

describe('overlay system', () => {
  beforeEach(() => {
    resetDb();
    sqliteDDL(createTableStatements(TABLES));
    resetConfigCache();
    resetOverlayOverride();
  });

  afterEach(() => {
    resetOverlayOverride();
  });

  it('falls back to example overlay when overlay/ is absent', () => {
    expect(getOverlaySource()).toBe('example');
    expect(getOverlay().manifest.id).toBe('tokio-example');
    expect(getAssistantName('ru')).toBe('Tokio');
  });

  it('compileRuntimeAssets() loads a custom OVERLAY_DIR with custom manifest and prompt .md', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'tokio-overlay-test-'));
    try {
      const exampleDir = resolve(__dirname, '..', 'example', 'overlay');
      cpSync(exampleDir, tmpRoot, { recursive: true });

      const manifestPath = join(tmpRoot, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.id = 'custom-test';
      manifest.brand.assistantName = 'CustomBot';
      manifest.brand.localizedNames.en = 'CustomBotEN';
      manifest.features.spendLimitEnabled = false;
      manifest.miniapp.accountThemes = [
        { pattern: 'custom', theme: 'primary', shortName: 'Custom', roleLabel: 'Custom role' },
      ];
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      writeFileSync(
        join(tmpRoot, 'prompts', 'en', 'identity.md'),
        'You are {{assistantName}}, a custom test assistant.',
        'utf8',
      );

      const compiled = await compileRuntimeAssets({ overlayDir: tmpRoot, write: false });
      expect(compiled.overlaySource).toBe('custom');
      expect(compiled.compiledOverlay.manifest.brand.assistantName).toBe('CustomBot');
      expect(compiled.compiledOverlay.manifest.features.spendLimitEnabled).toBe(false);
      expect(compiled.compiledOverlay.manifest.miniapp.accountThemes[0]).toEqual({
        pattern: 'custom',
        theme: 'primary',
        shortName: 'Custom',
        roleLabel: 'Custom role',
      });
      expect(compiled.compiledOverlay.prompts.en.identity).toBe(
        'You are {{assistantName}}, a custom test assistant.',
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('setOverlayOverride overrides prompts, features, supportContact, and finance.accountAliases', async () => {
    setOverlayOverride({
      manifest: {
        brand: {
          assistantName: 'Nova',
          supportContact: '@nova_support',
        },
        features: {
          spendLimitEnabled: false,
          overloadShield: false,
          onboardingWizard: false,
        },
        finance: {
          accountAliases: [{ account: 'NovaBank', patterns: ['novabank', 'нова'] }],
        },
      },
      prompts: {
        en: {
          identity: 'Custom identity for {{assistantName}}.',
        },
      },
    } as unknown as OverlayOverride);

    expect(getOverlayPrompt('en', 'identity')).toBe('Custom identity for Nova.');
    expect(helpText('en')).toContain('@nova_support');

    const spend = await checkSpendLimit(100001);
    expect(spend.allowed).toBe(true);
    expect(spend.reason).toBe('disabled');

    const prompt = buildSystemPrompt({
      locale: 'en',
      executiveOverload: evaluateExecutiveOverload({ lowStimulationMode: true }),
    });
    expect(prompt).not.toContain('EXECUTIVE OVERLOAD SHIELD');

    const { user } = await ensureUserProfile(100002, 'Tester', 'en');
    expect(user.onboardingStep).toBe('completed');
    expect(matchExplicitAccount('spent at novabank', 'EUR')).toBe('NovaBank');
  });

  it('ships publicOpenAccess: false in the example overlay', () => {
    expect(getOverlay().manifest.features.publicOpenAccess).toBe(false);
  });

  it('isPublicOpenAccessEnabled() opens only on a literal true', () => {
    // A manifest that never declares the key is the personal overlay's shape:
    // `undefined` must read as closed, in the same place the gate asks.
    expect(isPublicOpenAccessEnabled({} as OverlayFeatures)).toBe(false);
    expect(isPublicOpenAccessEnabled({ publicOpenAccess: undefined } as OverlayFeatures)).toBe(false);
    expect(isPublicOpenAccessEnabled({ publicOpenAccess: false } as OverlayFeatures)).toBe(false);
    expect(isPublicOpenAccessEnabled({ publicOpenAccess: true } as OverlayFeatures)).toBe(true);
    expect(isPublicOpenAccessEnabled()).toBe(false);
  });

  it('a manifest without publicOpenAccess still compiles and keeps the gate closed', async () => {
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      // Compile a manifest that predates the flag — the exact shape of the
      // personal overlay, which must not need an edit when the core adds it.
      const tmpRoot = mkdtempSync(join(tmpdir(), 'tokio-overlay-open-'));
      try {
        cpSync(resolve(__dirname, '..', 'example', 'overlay'), tmpRoot, { recursive: true });
        const manifestPath = join(tmpRoot, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        delete manifest.features.publicOpenAccess;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        const compiled = await compileRuntimeAssets({ overlayDir: tmpRoot, write: false });
        expect(compiled.compiledOverlay.manifest.features.publicOpenAccess).toBeUndefined();
        expect(isPublicOpenAccessEnabled(compiled.compiledOverlay.manifest.features)).toBe(false);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }

      // The shipped example overlay declares `false`; production + an empty
      // access list must still refuse unknown users.
      resetOverlayOverride();
      await expect(checkAccess(424242, { kind: 'message' })).resolves.toEqual({
        allowed: false,
        reply: ACCESS_UNCONFIGURED_MESSAGE,
      });
    } finally {
      if (previous === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previous;
    }
  });

  it.each(['ru', 'en', 'sr', 'ja'] as const)(
    'seedDemoWorkspace(%s) inserts accounts, liability, tasks with reminder, and searchable notes',
    async (locale) => {
      const userId = 200000 + ['ru', 'en', 'sr', 'ja'].indexOf(locale);
      await ensureUser(userId, 'Demo');

      const msg = await seedDemoWorkspace(userId, locale);
      expect(msg.length).toBeGreaterThan(0);

      const accounts = await listAccounts(userId);
      const liabilities = await listLiabilities(userId, 'active');
      const tasks = await listTasks(userId, { status: 'todo' });
      const notes = await listNotes(userId, { limit: 20 });
      const hybrid = await searchNotesHybrid(userId, { query: notes[0]!.rawText.slice(0, 10), limit: 10 });

      expect(accounts.length).toBeGreaterThanOrEqual(3);
      expect(liabilities.length).toBeGreaterThanOrEqual(1);
      expect(tasks.length).toBeGreaterThanOrEqual(3);
      expect(tasks.some((t) => t.remindAt !== null)).toBe(true);
      expect(notes.length).toBeGreaterThanOrEqual(3);
      expect(hybrid.length).toBeGreaterThanOrEqual(1);

      const quick = await quickSummary(userId, { locale });
      const bal = await balanceSummary(userId);
      const debts = await debtsSummary(userId);
      expect(quick.length).toBeGreaterThan(20);
      expect(bal).toContain(accounts[0]!.name);
      expect(debts).toContain(liabilities[0]!.name);
    },
  );
});
