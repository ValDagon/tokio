/**
 * Runtime Overlay accessor (V8 isolate compatible, zero node:fs).
 *
 * Reads the build-time compiled overlay from `./overlay.generated.js`
 * (produced by `scripts/compile-runtime-assets.mjs` from `overlay/` or
 * `example/overlay/`). Supports in-memory deep-merge overrides for unit tests
 * via `setOverlayOverride()` / `resetOverlayOverride()`.
 */

import {
  COMPILED_DEMO_SEED,
  COMPILED_OVERLAY,
  OVERLAY_SOURCE,
} from './overlay.generated.js';

export type OverlayLocaleCode = 'ru' | 'en' | 'sr' | 'ja';
export type OverlaySource = 'custom' | 'example';
export type OverlayPromptSection = 'identity' | 'mission' | 'principles' | 'classifier';

export interface OverlayBrand {
  assistantName: string;
  localizedNames: Record<OverlayLocaleCode, string>;
  backupPrefix: string;
  supportContact: string;
  miniAppUrl: string;
  accessDeniedMessage: Record<OverlayLocaleCode, string>;
}

export interface OverlayDefaults {
  timezone: string;
  baseCurrency: string;
  summaryTime: string;
  supportedCurrencies: string[];
  inboxCurrencies: string[];
}

export interface OverlayFeatures {
  spendLimitEnabled: boolean;
  spendLimitUsd: number;
  onboardingWizard: boolean;
  byokCommand: boolean;
  feedbackEnabled: boolean;
  overloadShield: boolean;
  microFocusTriage: boolean;
  calmModeUi: boolean;
  /**
   * Explicit open registration for a deliberately public instance.
   *
   * Optional on purpose: an overlay that never declares it (the personal one)
   * reads `undefined`, which the access gate treats as `false`, so the
   * fail-closed whitelist behaviour is unchanged. Only a literal `true` opens
   * `checkAccess` to unknown users, and only `overlay/manifest.json` can set it.
   */
  publicOpenAccess?: boolean;
}

/**
 * True only for a literal `publicOpenAccess: true` in the active overlay.
 *
 * A missing key is `false`, not "unset but allowed": keep this predicate as the
 * single reader of the flag so the default stays closed in one place.
 */
export function isPublicOpenAccessEnabled(
  features: OverlayFeatures = getOverlay().manifest.features,
): boolean {
  return features.publicOpenAccess === true;
}

export interface OverlayAccountAlias {
  account: string;
  patterns: string[];
}

export interface OverlayFinance {
  accountAliases: OverlayAccountAlias[];
  defaultAccountByCurrency: Record<string, string>;
  genericCardAccountByCurrency: Record<string, string>;
  reserveAmount: number;
}

export interface OverlayAccountTheme {
  pattern: string;
  theme: string;
}

export interface OverlayMiniApp {
  tabs: string[];
  accountThemes: OverlayAccountTheme[];
}

export interface OverlayPromptLocalePaths {
  identity: string;
  mission: string;
  principles: string;
  classifier: string;
}

export interface OverlayPromptsConfig {
  locales: Record<OverlayLocaleCode, OverlayPromptLocalePaths>;
  personaStyles: Record<string, Partial<Record<OverlayLocaleCode, string>>>;
}

export interface OverlayManifest {
  schemaVersion: number;
  id: string;
  defaultLocale: OverlayLocaleCode;
  brand: OverlayBrand;
  defaults: OverlayDefaults;
  features: OverlayFeatures;
  finance: OverlayFinance;
  miniapp: OverlayMiniApp;
  prompts: OverlayPromptsConfig;
}

export type OverlayPromptSections = Record<OverlayPromptSection, string>;

export interface CompiledOverlay {
  manifest: OverlayManifest;
  prompts: Record<OverlayLocaleCode, OverlayPromptSections>;
}

export interface DemoSeedAccount {
  name: string;
  currency: string;
  balanceCents: number;
  envelope: 'spendable' | 'reserved';
}

export interface DemoSeedLiability {
  name: string;
  queue: string;
  amountCents: number;
  currency: string;
  monthlyPaymentCents: number;
  paymentDay: number;
  notes: string;
}

export interface DemoSeedTask {
  title: string;
  notes: string;
  dueOffsetDays: number;
  reminderInHours: number | null;
}

export interface DemoSeedNote {
  rawText: string;
  column: 'idea' | 'note' | 'raw';
  title: string;
  tags: string[];
}

export interface DemoSeedLocale {
  accounts: DemoSeedAccount[];
  liabilities: DemoSeedLiability[];
  tasks: DemoSeedTask[];
  notes: DemoSeedNote[];
}

export type DemoSeedCatalog = Record<OverlayLocaleCode, DemoSeedLocale>;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type OverlayOverride = DeepPartial<CompiledOverlay>;

let activeOverride: OverlayOverride | null = null;
let cachedOverlay: CompiledOverlay | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    if (patchVal === undefined) continue;
    const baseVal = (base as Record<string, unknown>)[key];
    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      result[key] = deepMerge(baseVal, patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result as T;
}

/** Returns the active compiled overlay (with any test override merged in). */
export function getOverlay(): CompiledOverlay {
  if (!activeOverride) return COMPILED_OVERLAY;
  if (!cachedOverlay) {
    cachedOverlay = deepMerge(COMPILED_OVERLAY, activeOverride);
  }
  return cachedOverlay;
}

/** Returns `'custom'` if built from `overlay/` or `OVERLAY_DIR`, or `'example'` if using the fallback. */
export function getOverlaySource(): OverlaySource {
  return OVERLAY_SOURCE;
}

/** Sets (or clears with `null`) an in-memory deep-merge override for tests. */
export function setOverlayOverride(patch: OverlayOverride | null): void {
  activeOverride = patch;
  cachedOverlay = null;
}

/** Clears any active in-memory overlay override. */
export function resetOverlayOverride(): void {
  activeOverride = null;
  cachedOverlay = null;
}

/** Resolves the assistant display name for a given locale. */
export function getAssistantName(locale?: OverlayLocaleCode): string {
  const overlay = getOverlay();
  const brand = overlay.manifest.brand;
  const fallbackName = brand.assistantName?.trim() || 'Tokio';
  const loc = locale ?? overlay.manifest.defaultLocale ?? 'ru';

  const overrideBrand = activeOverride?.manifest?.brand;
  const assistantNameOverridden =
    typeof overrideBrand?.assistantName === 'string' && overrideBrand.assistantName.trim().length > 0;
  const localizedOverridden =
    typeof overrideBrand?.localizedNames?.[loc] === 'string' &&
    overrideBrand.localizedNames[loc]!.trim().length > 0;

  if (assistantNameOverridden && !localizedOverridden) {
    return fallbackName;
  }

  const localized = brand.localizedNames?.[loc]?.trim();
  return localized || fallbackName;
}

/** Loads a localized prompt section and interpolates `{{var}}` placeholders. */
export function getOverlayPrompt(
  locale: OverlayLocaleCode,
  section: OverlayPromptSection,
  vars?: Record<string, string>,
): string {
  const overlay = getOverlay();
  const defaultLoc = overlay.manifest.defaultLocale ?? 'ru';
  const template =
    overlay.prompts[locale]?.[section] ??
    overlay.prompts[defaultLoc]?.[section] ??
    overlay.prompts.ru?.[section] ??
    '';

  const mergedVars: Record<string, string> = {
    assistantName: getAssistantName(locale),
    ...(vars ?? {}),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(mergedVars, key) ? mergedVars[key]! : match;
  });
}

/** Resolves a known persona style key (`mentor`, `strategist`, `calm_partner`, `concise`) for a locale. */
export function getPersonaStyleText(
  style: string,
  locale?: OverlayLocaleCode,
): string | null {
  const key = typeof style === 'string' ? style.trim() : '';
  if (!key) return null;

  const overlay = getOverlay();
  const entry = overlay.manifest.prompts.personaStyles?.[key];
  if (!entry) return null;

  const defaultLoc = overlay.manifest.defaultLocale ?? 'ru';
  const loc = locale ?? defaultLoc;
  const text = entry[loc] ?? entry[defaultLoc] ?? entry.ru ?? entry.en;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/** Returns the localized demo seed dataset (accounts, liabilities, tasks, notes). */
export function getDemoSeed(locale?: OverlayLocaleCode): DemoSeedLocale {
  const overlay = getOverlay();
  const defaultLoc = overlay.manifest.defaultLocale ?? 'ru';
  const loc = locale ?? defaultLoc;
  return COMPILED_DEMO_SEED[loc] ?? COMPILED_DEMO_SEED[defaultLoc] ?? COMPILED_DEMO_SEED.ru;
}
