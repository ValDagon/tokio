/**
 * Рантайм-настройки пользователя в `kv` (без миграций схемы БД):
 *  - `user_prefs:v1:<uid>` — переопределения ассистента, AI, персон, СДВГ, финансов, дневника, проактивности, рутин и пресетов;
 *  - `user_prefs_history:v1:<uid>` — кольцевая история снимков (до 10 шагов) для отката;
 *  - `talk_mode:v1:<uid>` — состояние и TTL разговорного режима (`/talk`).
 *
 * Важно: функции чтения (`loadUserPrefs`, `loadPrefsHistory`, `captureSettingsState`,
 * `getTalkModeStatus`, `isTalkModeActive`, `isInQuietHours`, `evaluateRoutineSchedule`)
 * строго read-only и никогда не пишут в `kv`.
 */

import { CUSTOM_INSTRUCTIONS_SLUG } from './agent/constants.js';
import { getChapter } from './dal/docs.js';
import { kvDelete, kvGet, kvGetJson, kvSet, kvSetJson } from './dal/misc.js';
import { ensureUser, getUser, updateUser } from './dal/users.js';
import { normalizeLocale } from './i18n.js';
import { listRuleLines, saveDirectives, splitDirectives } from './learning.js';
import type { OverlayAccountTheme, OverlayManifest } from './overlay.js';
import { parseProviderId, type ProviderId } from './provider/index.js';
import type { LocaleCode } from './types.js';
import { nowIso, parseTimeOfDay, truncate, zonedParts } from './utils.js';

export const USER_PREFS_VERSION = 1;
export const MAX_PREFS_HISTORY = 10;
export const MAX_ASSISTANT_NAME_CHARS = 40;
export const MIN_AGENT_MAX_STEPS = 4;
export const MAX_AGENT_MAX_STEPS = 16;

export const TALK_MODE_TTL_MS = 30 * 60_000;
export const MIN_TALK_MODE_TTL_MINUTES = 5;
export const MAX_TALK_MODE_TTL_MINUTES = 240;

// ---------------------------------------------------------------------------
// Константы и границы Волны 2 (СДВГ, финансы, дневник, проактивность, рутины)
// ---------------------------------------------------------------------------

export const DEFAULT_OVERLOAD_OVERDUE_THRESHOLD = 3;
export const MIN_OVERLOAD_OVERDUE_THRESHOLD = 1;
export const MAX_OVERLOAD_OVERDUE_THRESHOLD = 30;

export const DEFAULT_OVERLOAD_ACTIVE_TODO_THRESHOLD = 12;
export const MIN_OVERLOAD_ACTIVE_TODO_THRESHOLD = 3;
export const MAX_OVERLOAD_ACTIVE_TODO_THRESHOLD = 100;

export const DEFAULT_OVERLOAD_NIGHT_START_HOUR = 21;
export const DEFAULT_OVERLOAD_NIGHT_END_HOUR = 6;

export const MIN_FOCUS_LIMIT = 1;
export const MAX_FOCUS_LIMIT = 10;

export const DEFAULT_STALE_AFTER_DAYS = 2;
export const MIN_STALE_AFTER_DAYS = 1;
export const MAX_STALE_AFTER_DAYS = 30;

export const MAX_FINANCE_ALIASES = 30;
export const MAX_ALIAS_PATTERNS = 15;
export const MAX_RESERVE_EUR_CENTS = 100_000_000;
export const MIN_RUNWAY_BURN_CENTS = 100;
export const MAX_RUNWAY_BURN_CENTS = 5_000_000;
export const MIN_RUNWAY_WINDOW_DAYS = 7;
export const MAX_RUNWAY_WINDOW_DAYS = 365;
export const MIN_RUNWAY_HORIZON_DAYS = 1;
export const MAX_RUNWAY_HORIZON_DAYS = 365;

export const MAX_DIARY_SECTIONS = 10;
export const MAX_DIARY_SECTION_CHARS = 100;
export const MAX_DIARY_HEADER_CHARS = 120;

export const DIGEST_SECTION_IDS = [
  'focus',
  'medications',
  'finance',
  'inbox',
  'telemetry',
  'coaching',
] as const;
export type DigestSectionId = (typeof DIGEST_SECTION_IDS)[number];

export const DEFAULT_MORNING_DIGEST_WINDOW_MINUTES = 720;
export const MIN_MORNING_DIGEST_WINDOW_MINUTES = 30;
export const MAX_MORNING_DIGEST_WINDOW_MINUTES = 1440;

export const DEFAULT_LIABILITY_WARNING_DAYS = 3;
export const MIN_LIABILITY_WARNING_DAYS = 0;
export const MAX_LIABILITY_WARNING_DAYS = 14;

export const DEFAULT_MEDICATION_REMINDER_WINDOW_MINUTES = 180;
export const MIN_MEDICATION_REMINDER_WINDOW_MINUTES = 15;
export const MAX_MEDICATION_REMINDER_WINDOW_MINUTES = 720;

export const DEFAULT_NIGHTLY_CONSOLIDATION_HOUR = 3;
export const DEFAULT_NIGHTLY_CONSOLIDATION_NOTE_LIMIT = 30;
export const MIN_NIGHTLY_CONSOLIDATION_NOTE_LIMIT = 5;
export const MAX_NIGHTLY_CONSOLIDATION_NOTE_LIMIT = 100;

export const MAX_CUSTOM_ROUTINES = 20;
export const MAX_ACTIVE_AI_ROUTINES = 3;
export const DEFAULT_ROUTINE_WINDOW_MINUTES = 180;
export const MIN_ROUTINE_WINDOW_MINUTES = 15;
export const MAX_ROUTINE_WINDOW_MINUTES = 720;

export const BUILTIN_PERSONA_IDS: readonly string[] = [
  'mentor',
  'strategist',
  'calm_partner',
  'concise',
];

export type ResetSection =
  | 'all'
  | 'ai'
  | 'brain'
  | 'proactive'
  | 'routines'
  | 'adhd'
  | 'finance'
  | 'diary'
  | 'miniapp'
  | 'presets';

export const RESET_SECTIONS: readonly ResetSection[] = [
  'all',
  'ai',
  'brain',
  'proactive',
  'routines',
  'adhd',
  'finance',
  'diary',
  'miniapp',
  'presets',
];

export const MINIAPP_TAB_IDS = ['today', 'tasks', 'finances', 'notes', 'system'] as const;
export type MiniAppTabId = (typeof MINIAPP_TAB_IDS)[number];

export const MINIAPP_ACCOUNT_THEMES = ['primary', 'secondary', 'accent', 'neutral'] as const;
export type MiniAppAccountThemeKind = (typeof MINIAPP_ACCOUNT_THEMES)[number];

export interface MiniAppAccountThemeOverride {
  pattern: string;
  theme?: MiniAppAccountThemeKind;
  shortName?: string;
  roleLabel?: string;
}

export interface MiniAppPrefs {
  tabs?: MiniAppTabId[];
  accountThemes?: MiniAppAccountThemeOverride[];
}

export interface CustomPersona {
  id: string;
  name: string;
  description: string;
  instructions: string;
  updatedAt: string;
}

export interface AiPrefs {
  preferredModel?: string | null;
  maxSteps?: number | null;
  temperature?: number | null;
}

export interface BrainPrefs {
  customPersonas?: Record<string, CustomPersona>;
  disabledBuiltinSkills?: string[];
}

export interface OverloadShieldPrefs {
  enabled?: boolean;
  overdueTaskCount?: number;
  activeTodoCount?: number;
  nightStartHour?: number;
  nightEndHour?: number;
}

export interface AdhdPrefs {
  overloadShield?: OverloadShieldPrefs;
  focusLimit?: number;
  staleAfterDays?: number;
}

export interface AccountAliasRule {
  account: string;
  patterns: string[];
}

export interface RunwayPrefs {
  dailyBurnOverrideCents?: number | null;
  minDailyBurnCents?: number;
  seedDailyBurnCents?: number;
  burnWindowDays?: number;
  horizonDays?: number | null;
}

export interface FinancePrefs {
  accountAliases?: AccountAliasRule[];
  defaultAccountByCurrency?: Record<string, string>;
  reserveCents?: number;
  runway?: RunwayPrefs;
}

export interface DiaryPrefs {
  sections?: string[];
  includeTasks?: boolean;
  headerTemplate?: string;
}

export interface QuietHoursPrefs {
  enabled?: boolean;
  start?: string;
  end?: string;
}

export interface MorningDigestJobPrefs {
  enabled?: boolean;
  windowMinutes?: number;
  sections?: DigestSectionId[];
}

export interface LiabilityWarningJobPrefs {
  enabled?: boolean;
  daysBefore?: number;
}

export interface LiabilityReviewJobPrefs {
  enabled?: boolean;
}

export interface MedicationReminderJobPrefs {
  enabled?: boolean;
  windowMinutes?: number;
}

export interface NightlyConsolidationJobPrefs {
  enabled?: boolean;
  hour?: number;
  noteLimit?: number;
}

export interface ProactiveJobsPrefs {
  morning_digest?: MorningDigestJobPrefs;
  liability_warning?: LiabilityWarningJobPrefs;
  liability_review?: LiabilityReviewJobPrefs;
  medication_reminder?: MedicationReminderJobPrefs;
  nightly_consolidation?: NightlyConsolidationJobPrefs;
}

export type RoutineKind = 'text' | 'summary' | 'ai';
export type RoutineSummaryKind = 'quick' | 'balance' | 'debts' | 'tasks' | 'meds' | 'digest';
export type RoutineScheduleType = 'daily' | 'weekly' | 'monthly';
export type RoutineToolAccess = 'read-only' | 'allow_writes';

export interface CustomRoutine {
  id: string;
  name: string;
  enabled: boolean;
  kind: RoutineKind;
  schedule: RoutineScheduleType;
  time: string;
  weekdays?: number[];
  dayOfMonth?: number;
  windowMinutes?: number;
  message?: string;
  summaryKind?: RoutineSummaryKind;
  prompt?: string;
  toolAccess?: RoutineToolAccess;
  respectQuietHours?: boolean;
  updatedAt: string;
}

export interface ProactivePrefs {
  quietHours?: QuietHoursPrefs;
  jobs?: ProactiveJobsPrefs;
  routines?: Record<string, CustomRoutine>;
}

export interface SettingsPresetProfile {
  name?: string | null;
  language?: LocaleCode;
  baseCurrency?: string;
  timezone?: string;
  summaryTime?: string;
  lowStimulationMode?: boolean;
  modelProvider?: ProviderId | null;
}

export interface SettingsPresetPayload {
  profile?: SettingsPresetProfile;
  personaStyle?: string | null;
  prefs?: Omit<UserPrefs, 'presets'>;
}

export interface SettingsPreset {
  id: string;
  name: string;
  description?: string;
  snapshot: SettingsPresetPayload;
  updatedAt: string;
}

export interface UserPrefs {
  assistantName?: string | null;
  ai?: AiPrefs;
  brain?: BrainPrefs;
  presets?: Record<string, SettingsPreset>;
  proactive?: ProactivePrefs;
  adhd?: AdhdPrefs;
  finance?: FinancePrefs;
  diary?: DiaryPrefs;
  miniapp?: MiniAppPrefs;
}

export interface SettingsSnapshotState {
  profile: {
    name: string | null;
    language: LocaleCode;
    baseCurrency: string;
    timezone: string;
    summaryTime: string;
    lowStimulationMode: boolean;
    modelProvider: ProviderId | null;
  };
  directives: {
    instructions: string;
    style: string | null;
  };
  prefs: UserPrefs;
}

export interface SettingsSnapshot {
  at: string;
  summary: string;
  state: SettingsSnapshotState;
}

export interface RollbackResult {
  ok: boolean;
  restoredSummary?: string;
  before: SettingsSnapshotState;
  after: SettingsSnapshotState;
  remainingHistory: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Ключи KV
// ---------------------------------------------------------------------------

export function userPrefsKey(userId: number): string {
  return `user_prefs:v1:${userId}`;
}

export function userPrefsHistoryKey(userId: number): string {
  return `user_prefs_history:v1:${userId}`;
}

export function talkModeKvKey(userId: number): string {
  return `talk_mode:v1:${userId}`;
}

export function routineRunKey(userId: number, routineId: string, triggerDayKey: string): string {
  return `routine_run:${userId}:${routineId}:${triggerDayKey}`;
}

// ---------------------------------------------------------------------------
// Нормализация и валидация
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Глубокая копия JSON-значения без `structuredClone` (не гарантирован в V8-изоляте). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Нормализует идентификатор (персона, пресет, рутина): `[a-z0-9][a-z0-9_-]{0,39}`. */
export function normalizeConfigSlug(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^a-z0-9_-]+/g, '')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 40);
}

function clampInt(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export function normalizeTimeHHMM(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return undefined;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeAssistantName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = truncate(raw.replace(/[\r\n]+/g, ' ').trim(), MAX_ASSISTANT_NAME_CHARS);
  return cleaned || undefined;
}

export function clampMaxSteps(raw: unknown): number | undefined {
  return clampInt(raw, MIN_AGENT_MAX_STEPS, MAX_AGENT_MAX_STEPS);
}

export function clampTemperature(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const clamped = Math.min(1, Math.max(0, raw));
  return Math.round(clamped * 100) / 100;
}

function normalizeAiPrefs(raw: unknown): AiPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: AiPrefs = {};
  if (typeof raw.preferredModel === 'string') {
    const model = raw.preferredModel.replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    if (model) out.preferredModel = model;
  }
  const steps = clampMaxSteps(raw.maxSteps);
  if (steps !== undefined) out.maxSteps = steps;
  const temp = clampTemperature(raw.temperature);
  if (temp !== undefined) out.temperature = temp;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCustomPersonas(raw: unknown): Record<string, CustomPersona> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, CustomPersona> = {};
  for (const [rawKey, item] of Object.entries(raw)) {
    if (!isRecord(item)) continue;
    const id = normalizeConfigSlug(typeof item.id === 'string' ? item.id : rawKey);
    if (!id || BUILTIN_PERSONA_IDS.includes(id)) continue;
    const name = typeof item.name === 'string' ? truncate(item.name.trim(), 80) : '';
    const instructions =
      typeof item.instructions === 'string' ? truncate(item.instructions.trim(), 2000) : '';
    if (!name || !instructions) continue;
    const description =
      typeof item.description === 'string' && item.description.trim()
        ? truncate(item.description.trim(), 240)
        : name;
    const updatedAt =
      typeof item.updatedAt === 'string' && item.updatedAt.trim() ? item.updatedAt.trim() : nowIso();
    out[id] = { id, name, description, instructions, updatedAt };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeDisabledSkills(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeBrainPrefs(raw: unknown): BrainPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: BrainPrefs = {};
  const customPersonas = normalizeCustomPersonas(raw.customPersonas);
  if (customPersonas) out.customPersonas = customPersonas;
  const disabledBuiltinSkills = normalizeDisabledSkills(raw.disabledBuiltinSkills);
  if (disabledBuiltinSkills) out.disabledBuiltinSkills = disabledBuiltinSkills;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeOverloadShieldPrefs(raw: unknown): OverloadShieldPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: OverloadShieldPrefs = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const overdue = clampInt(
    raw.overdueTaskCount,
    MIN_OVERLOAD_OVERDUE_THRESHOLD,
    MAX_OVERLOAD_OVERDUE_THRESHOLD,
  );
  if (overdue !== undefined) out.overdueTaskCount = overdue;
  const activeTodo = clampInt(
    raw.activeTodoCount,
    MIN_OVERLOAD_ACTIVE_TODO_THRESHOLD,
    MAX_OVERLOAD_ACTIVE_TODO_THRESHOLD,
  );
  if (activeTodo !== undefined) out.activeTodoCount = activeTodo;
  const nightStart = clampInt(raw.nightStartHour, 0, 23);
  if (nightStart !== undefined) out.nightStartHour = nightStart;
  const nightEnd = clampInt(raw.nightEndHour, 0, 23);
  if (nightEnd !== undefined) out.nightEndHour = nightEnd;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAdhdPrefs(raw: unknown): AdhdPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: AdhdPrefs = {};
  const shield = normalizeOverloadShieldPrefs(raw.overloadShield);
  if (shield) out.overloadShield = shield;
  const focusLimit = clampInt(raw.focusLimit, MIN_FOCUS_LIMIT, MAX_FOCUS_LIMIT);
  if (focusLimit !== undefined) out.focusLimit = focusLimit;
  const staleAfterDays = clampInt(
    raw.staleAfterDays,
    MIN_STALE_AFTER_DAYS,
    MAX_STALE_AFTER_DAYS,
  );
  if (staleAfterDays !== undefined) out.staleAfterDays = staleAfterDays;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAccountAliases(raw: unknown): AccountAliasRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seenAccounts = new Set<string>();
  const out: AccountAliasRule[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const account = typeof item.account === 'string' ? truncate(item.account.trim(), 80) : '';
    if (!account) continue;
    const accKey = account.toLowerCase();
    if (seenAccounts.has(accKey)) continue;
    if (!Array.isArray(item.patterns)) continue;
    const seenPatterns = new Set<string>();
    const patterns: string[] = [];
    for (const p of item.patterns) {
      if (typeof p !== 'string') continue;
      const clean = truncate(p.trim().toLowerCase(), 40);
      if (!clean || seenPatterns.has(clean)) continue;
      seenPatterns.add(clean);
      patterns.push(clean);
      if (patterns.length >= MAX_ALIAS_PATTERNS) break;
    }
    if (patterns.length === 0) continue;
    seenAccounts.add(accKey);
    out.push({ account, patterns });
    if (out.length >= MAX_FINANCE_ALIASES) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeDefaultAccountByCurrency(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [rawCur, rawAcc] of Object.entries(raw)) {
    const cur = rawCur.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) continue;
    if (typeof rawAcc !== 'string') continue;
    const acc = truncate(rawAcc.trim(), 80);
    if (!acc) continue;
    out[cur] = acc;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRunwayPrefs(raw: unknown): RunwayPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: RunwayPrefs = {};
  const dailyOverride = clampInt(
    raw.dailyBurnOverrideCents,
    MIN_RUNWAY_BURN_CENTS,
    MAX_RUNWAY_BURN_CENTS,
  );
  if (dailyOverride !== undefined) out.dailyBurnOverrideCents = dailyOverride;
  const minBurn = clampInt(raw.minDailyBurnCents, MIN_RUNWAY_BURN_CENTS, MAX_RUNWAY_BURN_CENTS);
  if (minBurn !== undefined) out.minDailyBurnCents = minBurn;
  const seedBurn = clampInt(raw.seedDailyBurnCents, MIN_RUNWAY_BURN_CENTS, MAX_RUNWAY_BURN_CENTS);
  if (seedBurn !== undefined) out.seedDailyBurnCents = seedBurn;
  const burnWindowDays = clampInt(
    raw.burnWindowDays,
    MIN_RUNWAY_WINDOW_DAYS,
    MAX_RUNWAY_WINDOW_DAYS,
  );
  if (burnWindowDays !== undefined) out.burnWindowDays = burnWindowDays;
  const horizonDays = clampInt(raw.horizonDays, MIN_RUNWAY_HORIZON_DAYS, MAX_RUNWAY_HORIZON_DAYS);
  if (horizonDays !== undefined) out.horizonDays = horizonDays;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeFinancePrefs(raw: unknown): FinancePrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: FinancePrefs = {};
  const accountAliases = normalizeAccountAliases(raw.accountAliases);
  if (accountAliases) out.accountAliases = accountAliases;
  const defaultAccountByCurrency = normalizeDefaultAccountByCurrency(raw.defaultAccountByCurrency);
  if (defaultAccountByCurrency) out.defaultAccountByCurrency = defaultAccountByCurrency;
  const reserveCents = clampInt(raw.reserveCents, 0, MAX_RESERVE_EUR_CENTS);
  if (reserveCents !== undefined && reserveCents > 0) out.reserveCents = reserveCents;
  const runway = normalizeRunwayPrefs(raw.runway);
  if (runway) out.runway = runway;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeDiaryPrefs(raw: unknown): DiaryPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: DiaryPrefs = {};
  if (Array.isArray(raw.sections)) {
    const sections: string[] = [];
    const seen = new Set<string>();
    for (const item of raw.sections) {
      if (typeof item !== 'string') continue;
      const clean = truncate(item.replace(/[\r\n]+/g, ' ').trim(), MAX_DIARY_SECTION_CHARS);
      if (!clean || seen.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      sections.push(clean);
      if (sections.length >= MAX_DIARY_SECTIONS) break;
    }
    if (sections.length > 0) out.sections = sections;
  }
  if (typeof raw.includeTasks === 'boolean') out.includeTasks = raw.includeTasks;
  if (typeof raw.headerTemplate === 'string') {
    const cleanHeader = truncate(
      raw.headerTemplate.replace(/[\r\n]+/g, ' ').trim(),
      MAX_DIARY_HEADER_CHARS,
    );
    if (cleanHeader) out.headerTemplate = cleanHeader;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeQuietHours(raw: unknown): QuietHoursPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: QuietHoursPrefs = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const start = normalizeTimeHHMM(raw.start);
  if (start) out.start = start;
  const end = normalizeTimeHHMM(raw.end);
  if (end) out.end = end;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeDigestSections(raw: unknown): DigestSectionId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const validSet: ReadonlySet<string> = new Set(DIGEST_SECTION_IDS);
  const seen = new Set<DigestSectionId>();
  const out: DigestSectionId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const clean = item.trim().toLowerCase();
    if (!validSet.has(clean)) continue;
    const typed = clean as DigestSectionId;
    if (seen.has(typed)) continue;
    seen.add(typed);
    out.push(typed);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeProactiveJobs(raw: unknown): ProactiveJobsPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ProactiveJobsPrefs = {};

  if (isRecord(raw.morning_digest)) {
    const m: MorningDigestJobPrefs = {};
    if (typeof raw.morning_digest.enabled === 'boolean') m.enabled = raw.morning_digest.enabled;
    const win = clampInt(
      raw.morning_digest.windowMinutes,
      MIN_MORNING_DIGEST_WINDOW_MINUTES,
      MAX_MORNING_DIGEST_WINDOW_MINUTES,
    );
    if (win !== undefined) m.windowMinutes = win;
    const sections = normalizeDigestSections(raw.morning_digest.sections);
    if (sections) m.sections = sections;
    if (Object.keys(m).length > 0) out.morning_digest = m;
  }

  if (isRecord(raw.liability_warning)) {
    const lw: LiabilityWarningJobPrefs = {};
    if (typeof raw.liability_warning.enabled === 'boolean') lw.enabled = raw.liability_warning.enabled;
    const days = clampInt(
      raw.liability_warning.daysBefore,
      MIN_LIABILITY_WARNING_DAYS,
      MAX_LIABILITY_WARNING_DAYS,
    );
    if (days !== undefined) lw.daysBefore = days;
    if (Object.keys(lw).length > 0) out.liability_warning = lw;
  }

  if (isRecord(raw.liability_review)) {
    const lr: LiabilityReviewJobPrefs = {};
    if (typeof raw.liability_review.enabled === 'boolean') lr.enabled = raw.liability_review.enabled;
    if (Object.keys(lr).length > 0) out.liability_review = lr;
  }

  if (isRecord(raw.medication_reminder)) {
    const mr: MedicationReminderJobPrefs = {};
    if (typeof raw.medication_reminder.enabled === 'boolean') {
      mr.enabled = raw.medication_reminder.enabled;
    }
    const win = clampInt(
      raw.medication_reminder.windowMinutes,
      MIN_MEDICATION_REMINDER_WINDOW_MINUTES,
      MAX_MEDICATION_REMINDER_WINDOW_MINUTES,
    );
    if (win !== undefined) mr.windowMinutes = win;
    if (Object.keys(mr).length > 0) out.medication_reminder = mr;
  }

  if (isRecord(raw.nightly_consolidation)) {
    const nc: NightlyConsolidationJobPrefs = {};
    if (typeof raw.nightly_consolidation.enabled === 'boolean') {
      nc.enabled = raw.nightly_consolidation.enabled;
    }
    const hour = clampInt(raw.nightly_consolidation.hour, 0, 23);
    if (hour !== undefined) nc.hour = hour;
    const noteLimit = clampInt(
      raw.nightly_consolidation.noteLimit,
      MIN_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
      MAX_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
    );
    if (noteLimit !== undefined) nc.noteLimit = noteLimit;
    if (Object.keys(nc).length > 0) out.nightly_consolidation = nc;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

const VALID_ROUTINE_KINDS: ReadonlySet<string> = new Set(['text', 'summary', 'ai']);
const VALID_SUMMARY_KINDS: ReadonlySet<string> = new Set([
  'quick',
  'balance',
  'debts',
  'tasks',
  'meds',
  'digest',
]);
const VALID_SCHEDULES: ReadonlySet<string> = new Set(['daily', 'weekly', 'monthly']);

function normalizeWeekdaysArray(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const set = new Set<number>();
  for (const item of raw) {
    const d = clampInt(item, 0, 6);
    if (d !== undefined && Math.trunc(Number(item)) === d) {
      set.add(d);
    }
  }
  if (set.size === 0) return undefined;
  return [...set].sort((a, b) => a - b);
}

function normalizeCustomRoutines(raw: unknown): Record<string, CustomRoutine> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, CustomRoutine> = {};
  let total = 0;
  let activeAiCount = 0;

  for (const [rawKey, item] of Object.entries(raw)) {
    if (total >= MAX_CUSTOM_ROUTINES) break;
    if (!isRecord(item)) continue;

    const id = normalizeConfigSlug(typeof item.id === 'string' ? item.id : rawKey);
    if (!id) continue;

    const name = typeof item.name === 'string' ? truncate(item.name.trim(), 80) : '';
    if (!name) continue;

    const kindRaw = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '';
    if (!VALID_ROUTINE_KINDS.has(kindRaw)) continue;
    const kind = kindRaw as RoutineKind;

    const scheduleRaw =
      typeof item.schedule === 'string' ? item.schedule.trim().toLowerCase() : '';
    if (!VALID_SCHEDULES.has(scheduleRaw)) continue;
    const schedule = scheduleRaw as RoutineScheduleType;

    const time = normalizeTimeHHMM(item.time);
    if (!time) continue;

    let weekdays: number[] | undefined;
    if (schedule === 'weekly') {
      weekdays = normalizeWeekdaysArray(item.weekdays);
      if (!weekdays) continue;
    }

    let dayOfMonth: number | undefined;
    if (schedule === 'monthly') {
      dayOfMonth = clampInt(item.dayOfMonth ?? 1, 1, 31) ?? 1;
    }

    const windowMinutes = clampInt(
      item.windowMinutes ?? DEFAULT_ROUTINE_WINDOW_MINUTES,
      MIN_ROUTINE_WINDOW_MINUTES,
      MAX_ROUTINE_WINDOW_MINUTES,
    );

    let message: string | undefined;
    let summaryKind: RoutineSummaryKind | undefined;
    let prompt: string | undefined;
    let toolAccess: RoutineToolAccess | undefined;

    if (kind === 'text') {
      const msg = typeof item.message === 'string' ? truncate(item.message.trim(), 1500) : '';
      if (!msg) continue;
      message = msg;
    } else if (kind === 'summary') {
      const sk =
        typeof item.summaryKind === 'string' ? item.summaryKind.trim().toLowerCase() : '';
      if (!VALID_SUMMARY_KINDS.has(sk)) continue;
      summaryKind = sk as RoutineSummaryKind;
    } else {
      const p = typeof item.prompt === 'string' ? truncate(item.prompt.trim(), 1500) : '';
      if (!p) continue;
      prompt = p;
      const ta =
        typeof item.toolAccess === 'string' ? item.toolAccess.trim().toLowerCase() : '';
      toolAccess = ta === 'allow_writes' ? 'allow_writes' : 'read-only';
    }

    let enabled = item.enabled !== false;
    if (kind === 'ai' && enabled) {
      if (activeAiCount >= MAX_ACTIVE_AI_ROUTINES) {
        enabled = false;
      } else {
        activeAiCount += 1;
      }
    }

    const respectQuietHours = item.respectQuietHours !== false;
    const updatedAt =
      typeof item.updatedAt === 'string' && item.updatedAt.trim()
        ? item.updatedAt.trim()
        : nowIso();

    out[id] = {
      id,
      name,
      enabled,
      kind,
      schedule,
      time,
      ...(weekdays ? { weekdays } : {}),
      ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
      ...(windowMinutes !== undefined && windowMinutes !== DEFAULT_ROUTINE_WINDOW_MINUTES
        ? { windowMinutes }
        : {}),
      ...(message ? { message } : {}),
      ...(summaryKind ? { summaryKind } : {}),
      ...(prompt ? { prompt } : {}),
      ...(toolAccess ? { toolAccess } : {}),
      ...(respectQuietHours ? {} : { respectQuietHours: false }),
      updatedAt,
    };
    total += 1;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProactivePrefs(raw: unknown): ProactivePrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ProactivePrefs = {};
  const quietHours = normalizeQuietHours(raw.quietHours);
  if (quietHours) out.quietHours = quietHours;
  const jobs = normalizeProactiveJobs(raw.jobs);
  if (jobs) out.jobs = jobs;
  const routines = normalizeCustomRoutines(raw.routines);
  if (routines) out.routines = routines;
  return Object.keys(out).length > 0 ? out : undefined;
}

const VALID_MINIAPP_TABS: ReadonlySet<string> = new Set(MINIAPP_TAB_IDS);
const VALID_MINIAPP_THEME_KINDS: ReadonlySet<string> = new Set(MINIAPP_ACCOUNT_THEMES);

function normalizeMiniAppTabs(raw: unknown): MiniAppTabId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<MiniAppTabId>();
  const tabs: MiniAppTabId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const rawId = item.trim().toLowerCase();
    const mapped = rawId === 'assistant' ? 'system' : rawId;
    if (!VALID_MINIAPP_TABS.has(mapped)) continue;
    const tabId = mapped as MiniAppTabId;
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    tabs.push(tabId);
  }
  if (tabs.length === 0) return undefined;
  if (!seen.has('system')) {
    tabs.push('system');
  }
  return tabs;
}

function normalizeMiniAppAccountThemes(raw: unknown): MiniAppAccountThemeOverride[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: MiniAppAccountThemeOverride[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const pattern =
      typeof item.pattern === 'string'
        ? truncate(item.pattern.replace(/[\r\n]+/g, ' ').trim(), 80)
        : '';
    if (!pattern) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;

    let theme: MiniAppAccountThemeKind | undefined;
    if (typeof item.theme === 'string') {
      const cleanedTheme = item.theme.trim().toLowerCase();
      if (VALID_MINIAPP_THEME_KINDS.has(cleanedTheme)) {
        theme = cleanedTheme as MiniAppAccountThemeKind;
      }
    }

    const shortName =
      typeof item.shortName === 'string'
        ? truncate(item.shortName.replace(/[\r\n]+/g, ' ').trim(), 40)
        : '';
    const roleLabel =
      typeof item.roleLabel === 'string'
        ? truncate(item.roleLabel.replace(/[\r\n]+/g, ' ').trim(), 80)
        : '';

    if (!theme && !shortName && !roleLabel) continue;
    seen.add(key);
    out.push({
      pattern,
      ...(theme ? { theme } : {}),
      ...(shortName ? { shortName } : {}),
      ...(roleLabel ? { roleLabel } : {}),
    });
    if (out.length >= MAX_FINANCE_ALIASES) break;
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeMiniAppPrefs(raw: unknown): MiniAppPrefs | undefined {
  if (!isRecord(raw)) return undefined;
  const out: MiniAppPrefs = {};
  const tabs = normalizeMiniAppTabs(raw.tabs);
  if (tabs) out.tabs = tabs;
  const accountThemes = normalizeMiniAppAccountThemes(raw.accountThemes);
  if (accountThemes) out.accountThemes = accountThemes;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePrefsWithoutPresets(raw: unknown): Omit<UserPrefs, 'presets'> {
  if (!isRecord(raw)) return {};
  const out: Omit<UserPrefs, 'presets'> = {};
  const assistantName = normalizeAssistantName(raw.assistantName);
  if (assistantName) out.assistantName = assistantName;
  const ai = normalizeAiPrefs(raw.ai);
  if (ai) out.ai = ai;
  const brain = normalizeBrainPrefs(raw.brain);
  if (brain) out.brain = brain;
  const proactive = normalizeProactivePrefs(raw.proactive);
  if (proactive) out.proactive = proactive;
  const adhd = normalizeAdhdPrefs(raw.adhd);
  if (adhd) out.adhd = adhd;
  const finance = normalizeFinancePrefs(raw.finance);
  if (finance) out.finance = finance;
  const diary = normalizeDiaryPrefs(raw.diary);
  if (diary) out.diary = diary;
  const miniapp = normalizeMiniAppPrefs(raw.miniapp);
  if (miniapp) out.miniapp = miniapp;
  return out;
}

function normalizePresetProfile(raw: unknown): SettingsPresetProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const out: SettingsPresetProfile = {};
  if (Object.hasOwn(raw, 'name')) {
    out.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  }
  if (typeof raw.language === 'string' && raw.language.trim()) {
    out.language = normalizeLocale(raw.language, 'ru');
  }
  if (typeof raw.baseCurrency === 'string' && /^[A-Za-z]{3}$/.test(raw.baseCurrency.trim())) {
    out.baseCurrency = raw.baseCurrency.trim().toUpperCase();
  }
  if (typeof raw.timezone === 'string' && raw.timezone.trim()) {
    out.timezone = raw.timezone.trim();
  }
  if (typeof raw.summaryTime === 'string' && raw.summaryTime.trim()) {
    out.summaryTime = raw.summaryTime.trim();
  }
  if (typeof raw.lowStimulationMode === 'boolean') {
    out.lowStimulationMode = raw.lowStimulationMode;
  }
  if (Object.hasOwn(raw, 'modelProvider')) {
    out.modelProvider = raw.modelProvider === null ? null : parseProviderId(raw.modelProvider);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePresets(raw: unknown): Record<string, SettingsPreset> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, SettingsPreset> = {};
  for (const [rawKey, item] of Object.entries(raw)) {
    if (!isRecord(item) || !isRecord(item.snapshot)) continue;
    const id = normalizeConfigSlug(typeof item.id === 'string' ? item.id : rawKey);
    if (!id) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? truncate(item.name.trim(), 80) : id;
    const description =
      typeof item.description === 'string' && item.description.trim()
        ? truncate(item.description.trim(), 240)
        : undefined;
    const profile = normalizePresetProfile(item.snapshot.profile);
    const personaStyle =
      Object.hasOwn(item.snapshot, 'personaStyle') &&
      (typeof item.snapshot.personaStyle === 'string' || item.snapshot.personaStyle === null)
        ? item.snapshot.personaStyle
        : undefined;
    const prefs = isRecord(item.snapshot.prefs)
      ? normalizePrefsWithoutPresets(item.snapshot.prefs)
      : undefined;
    const snapshot: SettingsPresetPayload = {
      ...(profile ? { profile } : {}),
      ...(personaStyle !== undefined ? { personaStyle } : {}),
      ...(prefs && Object.keys(prefs).length > 0 ? { prefs } : {}),
    };
    const updatedAt =
      typeof item.updatedAt === 'string' && item.updatedAt.trim() ? item.updatedAt.trim() : nowIso();
    out[id] = {
      id,
      name,
      ...(description ? { description } : {}),
      snapshot,
      updatedAt,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeUserPrefs(raw: unknown): UserPrefs {
  if (!isRecord(raw)) return {};
  const base = normalizePrefsWithoutPresets(raw);
  const presets = normalizePresets(raw.presets);
  return {
    ...base,
    ...(presets ? { presets } : {}),
  };
}

// ---------------------------------------------------------------------------
// Чистые хелперы расписания, тихих часов и рутин
// ---------------------------------------------------------------------------

/** Количество включённых AI-рутин в наборе. */
export function countActiveAiRoutines(
  routines?: Readonly<Record<string, CustomRoutine>> | null,
): number {
  if (!routines) return 0;
  let count = 0;
  for (const r of Object.values(routines)) {
    if (r.enabled && r.kind === 'ai') count += 1;
  }
  return count;
}

/**
 * Проверяет, попадает ли локальное время в окно тихих часов.
 * Поддерживает дневное окно (`09:00–12:00`) и переход через полночь (`23:00–07:00`).
 */
export function isInQuietHours(
  now: Date,
  timeZone: string,
  quietHours?: QuietHoursPrefs | null,
): boolean {
  if (!quietHours || quietHours.enabled !== true) return false;
  const start = parseTimeOfDay(quietHours.start ?? '23:00');
  const end = parseTimeOfDay(quietHours.end ?? '07:00');
  if (start === null || end === null || start === end) return false;
  const parts = zonedParts(now, timeZone || 'UTC');
  const nowMinutes = parts.hour * 60 + parts.minute;
  if (start < end) {
    return nowMinutes >= start && nowMinutes < end;
  }
  return nowMinutes >= start || nowMinutes < end;
}

export interface RoutineScheduleEval {
  due: boolean;
  triggerDayKey: string | null;
  sinceTargetMinutes: number | null;
}

const MINUTES_PER_DAY = 24 * 60;
const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Вычисляет, созрела ли кастомная рутина в момент `now` в таймзоне `timeZone`.
 * Окно `[time, time + windowMinutes]` учитывает переход через полночь, а день
 * срабатывания (`triggerDayKey`) привязывается к суткам старта окна (чтобы не
 * срабатывать дважды за один ночной слот и правильно проверять `weekly`/`monthly`).
 */
export function evaluateRoutineSchedule(
  routine: CustomRoutine,
  now: Date,
  timeZone: string,
): RoutineScheduleEval {
  const notDue: RoutineScheduleEval = {
    due: false,
    triggerDayKey: null,
    sinceTargetMinutes: null,
  };
  if (!routine.enabled) return notDue;
  const targetMinutes = parseTimeOfDay(routine.time);
  if (targetMinutes === null) return notDue;
  const windowMinutes = clampInt(
    routine.windowMinutes ?? DEFAULT_ROUTINE_WINDOW_MINUTES,
    MIN_ROUTINE_WINDOW_MINUTES,
    MAX_ROUTINE_WINDOW_MINUTES,
  ) ?? DEFAULT_ROUTINE_WINDOW_MINUTES;

  const parts = zonedParts(now, timeZone || 'UTC');
  const nowMinutes = parts.hour * 60 + parts.minute;
  const wrapped = nowMinutes < targetMinutes;
  const sinceTargetMinutes = wrapped
    ? nowMinutes + MINUTES_PER_DAY - targetMinutes
    : nowMinutes - targetMinutes;

  if (sinceTargetMinutes < 0 || sinceTargetMinutes > windowMinutes) {
    return notDue;
  }

  const triggerCalendarUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day - (wrapped ? 1 : 0)),
  );
  const tYear = triggerCalendarUtc.getUTCFullYear();
  const tMonth = triggerCalendarUtc.getUTCMonth() + 1;
  const tDay = triggerCalendarUtc.getUTCDate();

  if (routine.schedule === 'weekly') {
    const weekday = (triggerCalendarUtc.getUTCDay() + 6) % 7; // 0 = Пн .. 6 = Вс
    if (!(routine.weekdays ?? []).includes(weekday)) return notDue;
  } else if (routine.schedule === 'monthly') {
    const daysInMonth = new Date(Date.UTC(tYear, tMonth, 0)).getUTCDate();
    const targetDay = Math.min(routine.dayOfMonth ?? 1, daysInMonth);
    if (tDay !== targetDay) return notDue;
  }

  return {
    due: true,
    triggerDayKey: `${tYear}-${pad2(tMonth)}-${pad2(tDay)}`,
    sinceTargetMinutes,
  };
}

const WEEKDAY_TOKEN_MAP: Record<string, number> = {
  '0': 0, пн: 0, пон: 0, понедельник: 0, mon: 0, monday: 0,
  '1': 1, вт: 1, вторник: 1, tue: 1, tuesday: 1,
  '2': 2, ср: 2, среда: 2, среду: 2, wed: 2, wednesday: 2,
  '3': 3, чт: 3, четв: 3, четверг: 3, thu: 3, thursday: 3,
  '4': 4, пт: 4, пятн: 4, пятница: 4, пятницу: 4, fri: 4, friday: 4,
  '5': 5, сб: 5, суб: 5, суббота: 5, субботу: 5, sat: 5, saturday: 5,
  '6': 6, вс: 6, воск: 6, воскресенье: 6, sun: 6, sunday: 6,
};

/** Разбирает дни недели (`"0,2,4"`, `"пн, ср, пт"`, `"mon,fri"`, `"будни"`, `"выходные"`). */
export function parseWeekdaysInput(raw: string): number[] | null {
  const cleaned = String(raw ?? '').trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned === 'будни' || cleaned === 'weekdays') return [0, 1, 2, 3, 4];
  if (cleaned === 'выходные' || cleaned === 'weekends') return [5, 6];
  if (cleaned === 'ежедневно' || cleaned === 'daily' || cleaned === 'all') {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const tokens = cleaned
    .split(/[\s,;|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;

  const days = new Set<number>();
  for (const token of tokens) {
    if (token === 'будни' || token === 'weekdays') {
      for (const d of [0, 1, 2, 3, 4]) days.add(d);
      continue;
    }
    if (token === 'выходные' || token === 'weekends') {
      days.add(5);
      days.add(6);
      continue;
    }
    const mapped = WEEKDAY_TOKEN_MAP[token];
    if (mapped === undefined) return null;
    days.add(mapped);
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

// ---------------------------------------------------------------------------
// Чтение и запись настроек
// ---------------------------------------------------------------------------

/** Читает `user_prefs:v1:<uid>`; строго read-only (ничего не пишет при отсутствии). */
export async function loadUserPrefs(userId: number): Promise<UserPrefs> {
  const raw = await kvGetJson<unknown>(userPrefsKey(userId), null);
  return normalizeUserPrefs(raw);
}

/** Валидирует, нормализует и сохраняет `user_prefs:v1:<uid>` (удаляет ключ, если пуст). */
export async function saveUserPrefs(userId: number, next: UserPrefs): Promise<UserPrefs> {
  const normalized = normalizeUserPrefs(next);
  if (Object.keys(normalized).length === 0) {
    await kvDelete(userPrefsKey(userId));
    return {};
  }
  await kvSetJson(userPrefsKey(userId), normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// Снимки, откат (10 шагов) и пресеты
// ---------------------------------------------------------------------------

function normalizeSnapshotState(raw: unknown): SettingsSnapshotState | null {
  if (!isRecord(raw) || !isRecord(raw.profile)) return null;
  const p = raw.profile;
  const d = isRecord(raw.directives) ? raw.directives : {};
  return {
    profile: {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
      language: normalizeLocale(typeof p.language === 'string' ? p.language : 'ru', 'ru'),
      baseCurrency:
        typeof p.baseCurrency === 'string' && p.baseCurrency.trim()
          ? p.baseCurrency.trim().toUpperCase()
          : 'EUR',
      timezone:
        typeof p.timezone === 'string' && p.timezone.trim() ? p.timezone.trim() : 'UTC',
      summaryTime:
        typeof p.summaryTime === 'string' && p.summaryTime.trim() ? p.summaryTime.trim() : '07:00',
      lowStimulationMode: Boolean(p.lowStimulationMode),
      modelProvider: p.modelProvider === null ? null : parseProviderId(p.modelProvider),
    },
    directives: {
      instructions: typeof d.instructions === 'string' ? d.instructions : '',
      style: typeof d.style === 'string' && d.style.trim() ? d.style.trim() : null,
    },
    prefs: normalizeUserPrefs(raw.prefs),
  };
}

/** Читает текущий снимок всех настроек пользователя. Строго read-only. */
export async function captureSettingsState(userId: number): Promise<SettingsSnapshotState> {
  const [user, chapter, prefs] = await Promise.all([
    getUser(userId),
    getChapter(userId, CUSTOM_INSTRUCTIONS_SLUG),
    loadUserPrefs(userId),
  ]);
  const split = splitDirectives(chapter?.content ?? '');
  return {
    profile: {
      name: user?.name ?? null,
      language: user?.language ?? 'ru',
      baseCurrency: user?.baseCurrency ?? 'EUR',
      timezone: user?.timezone ?? 'UTC',
      summaryTime: user?.summaryTime ?? '07:00',
      lowStimulationMode: Boolean(user?.lowStimulationMode),
      modelProvider: user?.modelProvider ?? null,
    },
    directives: {
      instructions: split.instructions,
      style: split.style,
    },
    prefs,
  };
}

/** Применяет полный снимок настроек (профиль + директивы/стиль + `user_prefs`). */
export async function applySettingsState(
  userId: number,
  state: SettingsSnapshotState,
): Promise<void> {
  await ensureUser(userId, state.profile.name ?? undefined);
  await updateUser(userId, {
    name: state.profile.name,
    language: state.profile.language,
    baseCurrency: state.profile.baseCurrency,
    timezone: state.profile.timezone,
    summaryTime: state.profile.summaryTime,
    lowStimulationMode: state.profile.lowStimulationMode,
    modelProvider: state.profile.modelProvider,
  });
  await saveDirectives(userId, state.directives.instructions, state.directives.style);
  await saveUserPrefs(userId, state.prefs);
}

/** Читает историю откатов (`user_prefs_history:v1:<uid>`). Строго read-only. */
export async function loadPrefsHistory(userId: number): Promise<SettingsSnapshot[]> {
  const raw = await kvGetJson<unknown>(userPrefsHistoryKey(userId), []);
  if (!Array.isArray(raw)) return [];
  const out: SettingsSnapshot[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const state = normalizeSnapshotState(item.state);
    if (!state) continue;
    out.push({
      at: typeof item.at === 'string' && item.at.trim() ? item.at.trim() : nowIso(),
      summary:
        typeof item.summary === 'string' && item.summary.trim()
          ? item.summary.trim()
          : 'Изменение настроек',
      state,
    });
  }
  return out.slice(-MAX_PREFS_HISTORY);
}

/** Добавляет снимок до изменения в кольцевой буфер истории (не более 10 записей). */
export async function pushPrefsSnapshot(
  userId: number,
  summary: string,
  state: SettingsSnapshotState,
): Promise<SettingsSnapshot[]> {
  const history = await loadPrefsHistory(userId);
  const entry: SettingsSnapshot = {
    at: nowIso(),
    summary: truncate(summary.trim() || 'Изменение настроек', 120),
    state: cloneJson(normalizeSnapshotState(state) ?? state),
  };
  const next = [...history, entry].slice(-MAX_PREFS_HISTORY);
  await kvSetJson(userPrefsHistoryKey(userId), next);
  return next;
}

/** Откатывает настройки на `steps` (1..10) сохранённых шагов назад. */
export async function rollbackSettings(
  userId: number,
  steps: number = 1,
): Promise<RollbackResult> {
  const history = await loadPrefsHistory(userId);
  const before = await captureSettingsState(userId);
  if (history.length === 0) {
    return {
      ok: false,
      before,
      after: before,
      remainingHistory: 0,
      error: 'История изменений пуста — откатывать нечего.',
    };
  }

  const count = Math.min(history.length, Math.max(1, Math.trunc(Number(steps) || 1)));
  const targetIndex = history.length - count;
  const target = history[targetIndex]!;
  const remaining = history.slice(0, targetIndex);

  await applySettingsState(userId, target.state);
  if (remaining.length === 0) {
    await kvDelete(userPrefsHistoryKey(userId));
  } else {
    await kvSetJson(userPrefsHistoryKey(userId), remaining);
  }
  const after = await captureSettingsState(userId);

  return {
    ok: true,
    restoredSummary: target.summary,
    before,
    after,
    remainingHistory: remaining.length,
  };
}

/** Сбрасывает секцию настроек к значениям по умолчанию (предварительно сохраняя снимок для отката). */
export async function resetSettingsSection(
  userId: number,
  section: ResetSection = 'all',
): Promise<{
  before: UserPrefs;
  after: UserPrefs;
  stateBefore: SettingsSnapshotState;
  stateAfter: SettingsSnapshotState;
}> {
  const stateBefore = await captureSettingsState(userId);
  await pushPrefsSnapshot(userId, `Перед сбросом (${section})`, stateBefore);

  const nextPrefs: UserPrefs = cloneJson(stateBefore.prefs);
  let nextProvider = stateBefore.profile.modelProvider;
  let nextStyle = stateBefore.directives.style;

  const customPersonas = nextPrefs.brain?.customPersonas ?? {};

  if (section === 'all') {
    delete nextPrefs.assistantName;
    delete nextPrefs.ai;
    delete nextPrefs.brain;
    delete nextPrefs.proactive;
    delete nextPrefs.adhd;
    delete nextPrefs.finance;
    delete nextPrefs.diary;
    delete nextPrefs.miniapp;
    nextProvider = null;
    if (nextStyle && Object.hasOwn(customPersonas, nextStyle)) {
      nextStyle = 'mentor';
    }
  } else if (section === 'ai') {
    delete nextPrefs.ai;
    nextProvider = null;
  } else if (section === 'brain') {
    delete nextPrefs.assistantName;
    delete nextPrefs.brain;
    if (nextStyle && Object.hasOwn(customPersonas, nextStyle)) {
      nextStyle = 'mentor';
    }
  } else if (section === 'routines') {
    if (nextPrefs.proactive) {
      delete nextPrefs.proactive.routines;
      if (Object.keys(nextPrefs.proactive).length === 0) {
        delete nextPrefs.proactive;
      }
    }
  } else if (section === 'presets') {
    delete nextPrefs.presets;
  } else {
    delete nextPrefs[section];
  }

  const nextState: SettingsSnapshotState = {
    profile: {
      ...stateBefore.profile,
      modelProvider: nextProvider,
    },
    directives: {
      ...stateBefore.directives,
      style: nextStyle,
    },
    prefs: nextPrefs,
  };

  await applySettingsState(userId, nextState);
  const stateAfter = await captureSettingsState(userId);
  return {
    before: stateBefore.prefs,
    after: stateAfter.prefs,
    stateBefore,
    stateAfter,
  };
}

/** Выделяет снимок-пресет из текущего состояния (для `manage_presets`). */
export function buildPresetPayloadFromState(state: SettingsSnapshotState): SettingsPresetPayload {
  const prefsCopy = normalizePrefsWithoutPresets(state.prefs);
  return {
    profile: {
      name: state.profile.name,
      language: state.profile.language,
      baseCurrency: state.profile.baseCurrency,
      timezone: state.profile.timezone,
      summaryTime: state.profile.summaryTime,
      lowStimulationMode: state.profile.lowStimulationMode,
      modelProvider: state.profile.modelProvider,
    },
    personaStyle: state.directives.style,
    ...(Object.keys(prefsCopy).length > 0 ? { prefs: prefsCopy } : {}),
  };
}

/** Применяет пресет поверх текущего состояния, сохраняя существующие правила `/learn` и сами пресеты. */
export function applyPresetPayloadToState(
  current: SettingsSnapshotState,
  payload: SettingsPresetPayload,
): SettingsPresetStateCompat {
  const p = payload.profile ?? {};
  const nextPrefsBase = payload.prefs ? normalizePrefsWithoutPresets(payload.prefs) : {};
  const preservedPresets = current.prefs.presets;
  const mergedPrefs: UserPrefs = {
    ...nextPrefsBase,
    ...(preservedPresets ? { presets: preservedPresets } : {}),
  };
  return {
    profile: {
      name: p.name !== undefined ? p.name : current.profile.name,
      language: p.language ?? current.profile.language,
      baseCurrency: p.baseCurrency ?? current.profile.baseCurrency,
      timezone: p.timezone ?? current.profile.timezone,
      summaryTime: p.summaryTime ?? current.profile.summaryTime,
      lowStimulationMode:
        p.lowStimulationMode !== undefined
          ? p.lowStimulationMode
          : current.profile.lowStimulationMode,
      modelProvider:
        p.modelProvider !== undefined ? p.modelProvider : current.profile.modelProvider,
    },
    directives: {
      instructions: current.directives.instructions,
      style: payload.personaStyle !== undefined ? payload.personaStyle : current.directives.style,
    },
    prefs: mergedPrefs,
  };
}
type SettingsPresetStateCompat = SettingsSnapshotState;

// ---------------------------------------------------------------------------
// Форматирование diff «было → стало»
// ---------------------------------------------------------------------------

function fmtVal(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'по умолчанию';
  if (typeof value === 'boolean') return value ? 'вкл' : 'выкл';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'пусто';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function fmtEurCents(cents: number | null | undefined): string | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  const eur = cents / 100;
  return Number.isInteger(eur) ? `${eur} €` : `${eur.toFixed(2).replace('.', ',')} €`;
}

function fmtAliases(aliases?: readonly AccountAliasRule[]): string {
  if (!aliases || aliases.length === 0) return 'по умолчанию';
  return aliases.map((a) => `${a.account} (${a.patterns.join(', ')})`).join('; ');
}

function fmtQuietHours(qh?: QuietHoursPrefs): string {
  if (!qh || qh.enabled !== true) return 'выкл';
  return `вкл (${qh.start ?? '23:00'}–${qh.end ?? '07:00'})`;
}

function fmtNightWindow(shield?: OverloadShieldPrefs): string | null {
  if (shield?.nightStartHour === undefined && shield?.nightEndHour === undefined) return null;
  const start = shield.nightStartHour ?? DEFAULT_OVERLOAD_NIGHT_START_HOUR;
  const end = shield.nightEndHour ?? DEFAULT_OVERLOAD_NIGHT_END_HOUR;
  return `${pad2(start)}:00–${pad2(end)}:00`;
}

function fmtRoutineBrief(r: CustomRoutine): string {
  const access = r.kind === 'ai' ? `, ${r.toolAccess ?? 'read-only'}` : '';
  const extra =
    r.schedule === 'weekly'
      ? ` [дни: ${(r.weekdays ?? []).join(',')}]`
      : r.schedule === 'monthly'
        ? ` [${r.dayOfMonth ?? 1}-е число]`
        : '';
  return `${r.kind}, ${r.schedule}${extra} ${r.time}, ${r.enabled ? 'вкл' : 'пауза'}${access}`;
}

/** Строит список человекочитаемых строк `• Поле: было → стало` по двум снимкам. */
export function formatSettingsDiff(
  before: SettingsSnapshotState,
  after: SettingsSnapshotState,
): string {
  const lines: string[] = [];
  const push = (label: string, left: unknown, right: unknown): void => {
    const a = fmtVal(left);
    const b = fmtVal(right);
    if (a !== b) lines.push(`• ${label}: ${a} → ${b}`);
  };

  push('Имя', before.profile.name, after.profile.name);
  push('Язык', before.profile.language, after.profile.language);
  push('Валюта', before.profile.baseCurrency, after.profile.baseCurrency);
  push('Таймзона', before.profile.timezone, after.profile.timezone);
  push('Утренний дайджест (время)', before.profile.summaryTime, after.profile.summaryTime);
  push('Спокойный режим (Calm)', before.profile.lowStimulationMode, after.profile.lowStimulationMode);
  push('AI-провайдер', before.profile.modelProvider ?? 'gemini', after.profile.modelProvider ?? 'gemini');

  push('Имя ассистента', before.prefs.assistantName, after.prefs.assistantName);
  push('Предпочтительная модель', before.prefs.ai?.preferredModel, after.prefs.ai?.preferredModel);
  push('Лимит шагов', before.prefs.ai?.maxSteps, after.prefs.ai?.maxSteps);
  push('Температура', before.prefs.ai?.temperature, after.prefs.ai?.temperature);

  push('Стиль общения (персона)', before.directives.style ?? 'mentor', after.directives.style ?? 'mentor');

  if (before.directives.instructions !== after.directives.instructions) {
    const prevRules = listRuleLines(before.directives.instructions).length;
    const nextRules = listRuleLines(after.directives.instructions).length;
    lines.push(`• Правила/директивы: ${prevRules} стр. → ${nextRules} стр.`);
  }

  const beforeDisabled = [...(before.prefs.brain?.disabledBuiltinSkills ?? [])].sort();
  const afterDisabled = [...(after.prefs.brain?.disabledBuiltinSkills ?? [])].sort();
  if (JSON.stringify(beforeDisabled) !== JSON.stringify(afterDisabled)) {
    lines.push(`• Отключённые встроенные скиллы: ${fmtVal(beforeDisabled)} → ${fmtVal(afterDisabled)}`);
  }

  const beforePersonas = before.prefs.brain?.customPersonas ?? {};
  const afterPersonas = after.prefs.brain?.customPersonas ?? {};
  if (JSON.stringify(beforePersonas) !== JSON.stringify(afterPersonas)) {
    lines.push(
      `• Кастомные персоны: ${Object.keys(beforePersonas).length} → ${Object.keys(afterPersonas).length}`,
    );
  }

  const beforePresets = before.prefs.presets ?? {};
  const afterPresets = after.prefs.presets ?? {};
  if (JSON.stringify(beforePresets) !== JSON.stringify(afterPresets)) {
    lines.push(
      `• Пресеты режимов: ${Object.keys(beforePresets).length} → ${Object.keys(afterPresets).length}`,
    );
  }

  // Волна 2 — СДВГ
  const bAdhd = before.prefs.adhd;
  const aAdhd = after.prefs.adhd;
  push(
    'СДВГ-щит',
    bAdhd?.overloadShield?.enabled ?? true,
    aAdhd?.overloadShield?.enabled ?? true,
  );
  push(
    'Щит: порог просроченных задач',
    bAdhd?.overloadShield?.overdueTaskCount,
    aAdhd?.overloadShield?.overdueTaskCount,
  );
  push(
    'Щит: порог активных задач',
    bAdhd?.overloadShield?.activeTodoCount,
    aAdhd?.overloadShield?.activeTodoCount,
  );
  push(
    'Щит: ночное окно',
    fmtNightWindow(bAdhd?.overloadShield),
    fmtNightWindow(aAdhd?.overloadShield),
  );
  push('Лимит фокуса дня', bAdhd?.focusLimit, aAdhd?.focusLimit);
  push('Порог стагнации задач (дней)', bAdhd?.staleAfterDays, aAdhd?.staleAfterDays);

  // Волна 2 — Финансы
  const bFin = before.prefs.finance;
  const aFin = after.prefs.finance;
  push(
    'Финансовые алиасы счетов',
    fmtAliases(bFin?.accountAliases),
    fmtAliases(aFin?.accountAliases),
  );
  const currencies = new Set([
    ...Object.keys(bFin?.defaultAccountByCurrency ?? {}),
    ...Object.keys(aFin?.defaultAccountByCurrency ?? {}),
  ]);
  for (const cur of [...currencies].sort()) {
    push(
      `Счёт по умолчанию (${cur})`,
      bFin?.defaultAccountByCurrency?.[cur],
      aFin?.defaultAccountByCurrency?.[cur],
    );
  }
  push('Финансовый резерв (EUR)', fmtEurCents(bFin?.reserveCents), fmtEurCents(aFin?.reserveCents));
  push(
    'Runway: ручной дневной расход',
    fmtEurCents(bFin?.runway?.dailyBurnOverrideCents),
    fmtEurCents(aFin?.runway?.dailyBurnOverrideCents),
  );
  push(
    'Runway: минимум дневного расхода',
    fmtEurCents(bFin?.runway?.minDailyBurnCents),
    fmtEurCents(aFin?.runway?.minDailyBurnCents),
  );
  push(
    'Runway: стартовый дневной расход',
    fmtEurCents(bFin?.runway?.seedDailyBurnCents),
    fmtEurCents(aFin?.runway?.seedDailyBurnCents),
  );
  push(
    'Runway: окно расчёта трат (дней)',
    bFin?.runway?.burnWindowDays,
    aFin?.runway?.burnWindowDays,
  );
  push(
    'Runway: горизонт планирования (дней)',
    bFin?.runway?.horizonDays,
    aFin?.runway?.horizonDays,
  );

  // Волна 2 — Дневник
  const bDiary = before.prefs.diary;
  const aDiary = after.prefs.diary;
  push('Дневник: секции шаблона', bDiary?.sections, aDiary?.sections);
  push(
    'Дневник: подтягивать выполненные задачи',
    bDiary?.includeTasks ?? true,
    aDiary?.includeTasks ?? true,
  );
  push('Дневник: шаблон заголовка', bDiary?.headerTemplate, aDiary?.headerTemplate);

  // Волна 2 — Проактивность и тихие часы
  const bPro = before.prefs.proactive;
  const aPro = after.prefs.proactive;
  push('Тихие часы', fmtQuietHours(bPro?.quietHours), fmtQuietHours(aPro?.quietHours));
  push(
    'Утренний дайджест (авто)',
    bPro?.jobs?.morning_digest?.enabled ?? true,
    aPro?.jobs?.morning_digest?.enabled ?? true,
  );
  push(
    'Утренний дайджест: окно (мин)',
    bPro?.jobs?.morning_digest?.windowMinutes,
    aPro?.jobs?.morning_digest?.windowMinutes,
  );
  push(
    'Утренний дайджест: секции',
    bPro?.jobs?.morning_digest?.sections,
    aPro?.jobs?.morning_digest?.sections,
  );
  push(
    'Предупреждения о платежах',
    bPro?.jobs?.liability_warning?.enabled ?? true,
    aPro?.jobs?.liability_warning?.enabled ?? true,
  );
  push(
    'Предупреждения о платежах: за сколько дней',
    bPro?.jobs?.liability_warning?.daysBefore,
    aPro?.jobs?.liability_warning?.daysBefore,
  );
  push(
    'Проверка списаний (после дайджеста)',
    bPro?.jobs?.liability_review?.enabled ?? true,
    aPro?.jobs?.liability_review?.enabled ?? true,
  );
  push(
    'Напоминания о лекарствах',
    bPro?.jobs?.medication_reminder?.enabled ?? true,
    aPro?.jobs?.medication_reminder?.enabled ?? true,
  );
  push(
    'Напоминания о лекарствах: окно (мин)',
    bPro?.jobs?.medication_reminder?.windowMinutes,
    aPro?.jobs?.medication_reminder?.windowMinutes,
  );
  push(
    'Ночная консолидация',
    bPro?.jobs?.nightly_consolidation?.enabled ?? true,
    aPro?.jobs?.nightly_consolidation?.enabled ?? true,
  );
  push(
    'Ночная консолидация: час запуска',
    bPro?.jobs?.nightly_consolidation?.hour,
    aPro?.jobs?.nightly_consolidation?.hour,
  );
  push(
    'Ночная консолидация: лимит заметок',
    bPro?.jobs?.nightly_consolidation?.noteLimit,
    aPro?.jobs?.nightly_consolidation?.noteLimit,
  );

  // Волна 2 — Кастомные рутины
  const bRoutines = bPro?.routines ?? {};
  const aRoutines = aPro?.routines ?? {};
  const routineIds = new Set([...Object.keys(bRoutines), ...Object.keys(aRoutines)]);
  for (const id of [...routineIds].sort()) {
    const left = bRoutines[id];
    const right = aRoutines[id];
    if (!left && right) {
      lines.push(`• Рутина «${right.name}» (${id}): добавлена (${fmtRoutineBrief(right)})`);
    } else if (left && !right) {
      lines.push(`• Рутина «${left.name}» (${id}): удалена`);
    } else if (left && right && JSON.stringify(left) !== JSON.stringify(right)) {
      lines.push(
        `• Рутина «${right.name}» (${id}): ${fmtRoutineBrief(left)} → ${fmtRoutineBrief(right)}`,
      );
    }
  }

  // Волна 3 — Mini App
  const bMini = before.prefs.miniapp;
  const aMini = after.prefs.miniapp;
  push('Вкладки Mini App', bMini?.tabs, aMini?.tabs);
  const fmtAccountThemes = (items?: readonly MiniAppAccountThemeOverride[]): string => {
    if (!items || items.length === 0) return 'по умолчанию';
    return items
      .map((it) => {
        const attrs = [it.theme, it.shortName, it.roleLabel].filter(Boolean).join(' · ');
        return `${it.pattern}${attrs ? ` (${attrs})` : ''}`;
      })
      .join('; ');
  };
  push(
    'Роли/темы счетов Mini App',
    fmtAccountThemes(bMini?.accountThemes),
    fmtAccountThemes(aMini?.accountThemes),
  );

  return lines.length > 0 ? lines.join('\n') : '• Без изменений.';
}

// ---------------------------------------------------------------------------
// Резолверы эффективной конфигурации UI и сводки настроек (Волна 3)
// ---------------------------------------------------------------------------

export interface EffectiveUiConfig {
  brand: {
    assistantName: string;
    localizedNames: Record<string, string>;
    backupPrefix: string;
    supportContact: string;
  };
  features: {
    feedbackEnabled: boolean;
    calmModeUi: boolean;
    onboardingWizard: boolean;
  };
  finance: {
    reserveAmount: number;
    accountAliases: AccountAliasRule[];
    defaultAccountByCurrency: Record<string, string>;
  };
  miniapp: {
    tabs: string[];
    accountThemes: OverlayAccountTheme[];
  };
  adhd: {
    focusLimit: number | null;
    staleAfterDays: number | null;
    overloadShieldEnabled: boolean;
  };
  personas: Array<{
    id: string;
    name: string;
    description: string;
    instructions: string;
  }>;
  summary: {
    activeRoutinesCount: number;
    totalRoutinesCount: number;
    presetsCount: number;
  };
}

/**
 * Сливает скомпилированный манифест оверлея с пользовательскими рантайм-настройками `UserPrefs`.
 * Пользовательские правила счетов, алиасов и ролей всегда идут первыми, сохраняя приоритет.
 */
export function resolveEffectiveUiConfig(
  manifest: OverlayManifest,
  prefs: UserPrefs,
  _locale?: LocaleCode,
): EffectiveUiConfig {
  const customAssistantName = prefs.assistantName?.trim() || '';
  const assistantName = customAssistantName || manifest.brand.assistantName;
  const localizedNames: Record<string, string> = {};
  for (const [loc, val] of Object.entries(manifest.brand.localizedNames)) {
    localizedNames[loc] = customAssistantName || val;
  }

  const reserveAmount =
    typeof prefs.finance?.reserveCents === 'number' && prefs.finance.reserveCents > 0
      ? Math.round(prefs.finance.reserveCents) / 100
      : manifest.finance.reserveAmount;

  const userAliases = prefs.finance?.accountAliases ?? [];
  const overriddenAliasAccounts = new Set(userAliases.map((a) => a.account.toLowerCase()));
  const mergedAliases: AccountAliasRule[] = [
    ...userAliases.map((a) => ({ account: a.account, patterns: [...a.patterns] })),
    ...manifest.finance.accountAliases
      .filter((a) => !overriddenAliasAccounts.has(a.account.toLowerCase()))
      .map((a) => ({ account: a.account, patterns: [...a.patterns] })),
  ];

  const defaultAccountByCurrency: Record<string, string> = {
    ...manifest.finance.defaultAccountByCurrency,
    ...(prefs.finance?.defaultAccountByCurrency ?? {}),
  };

  const tabs =
    prefs.miniapp?.tabs && prefs.miniapp.tabs.length > 0
      ? [...prefs.miniapp.tabs]
      : [...manifest.miniapp.tabs];

  const overlayThemesByPattern = new Map<string, OverlayAccountTheme>();
  for (const rule of manifest.miniapp.accountThemes) {
    overlayThemesByPattern.set(rule.pattern.toLowerCase(), rule);
  }
  const userThemeOverrides = prefs.miniapp?.accountThemes ?? [];
  const overriddenThemePatterns = new Set<string>();
  const customThemesResolved: OverlayAccountTheme[] = [];
  for (const ov of userThemeOverrides) {
    const key = ov.pattern.toLowerCase();
    overriddenThemePatterns.add(key);
    const baseRule = overlayThemesByPattern.get(key);
    customThemesResolved.push({
      pattern: baseRule?.pattern ?? ov.pattern,
      theme: ov.theme ?? baseRule?.theme ?? 'neutral',
      ...(ov.shortName ?? baseRule?.shortName ? { shortName: ov.shortName ?? baseRule?.shortName } : {}),
      ...(ov.roleLabel ?? baseRule?.roleLabel ? { roleLabel: ov.roleLabel ?? baseRule?.roleLabel } : {}),
    });
  }
  const remainingOverlayThemes = manifest.miniapp.accountThemes
    .filter((rule) => !overriddenThemePatterns.has(rule.pattern.toLowerCase()))
    .map((rule) => ({ ...rule }));

  const personas = Object.values(prefs.brain?.customPersonas ?? {})
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      instructions: p.instructions,
    }));

  const routines = Object.values(prefs.proactive?.routines ?? {});

  return {
    brand: {
      assistantName,
      localizedNames,
      backupPrefix: manifest.brand.backupPrefix,
      supportContact: manifest.brand.supportContact,
    },
    features: {
      feedbackEnabled: manifest.features.feedbackEnabled,
      calmModeUi: manifest.features.calmModeUi,
      onboardingWizard: manifest.features.onboardingWizard,
    },
    finance: {
      reserveAmount,
      accountAliases: mergedAliases,
      defaultAccountByCurrency,
    },
    miniapp: {
      tabs,
      accountThemes: [...customThemesResolved, ...remainingOverlayThemes],
    },
    adhd: {
      focusLimit: prefs.adhd?.focusLimit ?? null,
      staleAfterDays: prefs.adhd?.staleAfterDays ?? null,
      overloadShieldEnabled: prefs.adhd?.overloadShield?.enabled ?? true,
    },
    personas,
    summary: {
      activeRoutinesCount: routines.filter((r) => r.enabled).length,
      totalRoutinesCount: routines.length,
      presetsCount: Object.keys(prefs.presets ?? {}).length,
    },
  };
}

export interface SettingsPrefsSummaryPayload {
  assistant_name: string | null;
  prefs_summary: {
    has_overrides: boolean;
    history_count: number;
    ai: {
      preferred_model: string | null;
      max_steps: number | null;
      temperature: number | null;
    };
    adhd: {
      overload_shield_enabled: boolean;
      overload_overdue_threshold: number | null;
      overload_active_todo_threshold: number | null;
      overload_night_window: string | null;
      focus_limit: number | null;
      stale_after_days: number | null;
    };
    finance: {
      reserve_eur: number;
      aliases_count: number;
      default_accounts_count: number;
      has_runway_overrides: boolean;
    };
    diary: {
      has_overrides: boolean;
      include_tasks: boolean;
      sections_count: number;
      header_template: string | null;
    };
    proactive: {
      quiet_hours_enabled: boolean;
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      disabled_jobs: string[];
    };
    brain: {
      custom_personas_count: number;
      disabled_builtin_skills: string[];
    };
    miniapp: {
      tabs: string[] | null;
      account_themes_count: number;
    };
  };
  custom_personas: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  presets: Array<{
    id: string;
    name: string;
    description?: string;
    updated_at: string;
  }>;
  routines: Array<{
    id: string;
    name: string;
    enabled: boolean;
    kind: RoutineKind;
    schedule: RoutineScheduleType;
    time: string;
    weekdays?: number[];
    day_of_month?: number;
    summary_kind?: RoutineSummaryKind;
    tool_access?: RoutineToolAccess;
    respect_quiet_hours: boolean;
  }>;
}

/**
 * Формирует компактную сводку активных оверрайдов, персон, пресетов и рутин для `/api/settings`.
 * Никогда не включает секреты или токены.
 */
export function buildSettingsPrefsSummary(
  state: SettingsSnapshotState,
  historyCount: number,
): SettingsPrefsSummaryPayload {
  const { prefs, profile } = state;
  const ai = prefs.ai;
  const adhd = prefs.adhd;
  const shield = adhd?.overloadShield;
  const finance = prefs.finance;
  const diary = prefs.diary;
  const proactive = prefs.proactive;
  const jobs = proactive?.jobs;
  const brain = prefs.brain;
  const miniapp = prefs.miniapp;

  const disabledJobs: string[] = [];
  if (jobs?.morning_digest?.enabled === false) disabledJobs.push('morning_digest');
  if (jobs?.liability_warning?.enabled === false) disabledJobs.push('liability_warning');
  if (jobs?.liability_review?.enabled === false) disabledJobs.push('liability_review');
  if (jobs?.medication_reminder?.enabled === false) disabledJobs.push('medication_reminder');
  if (jobs?.nightly_consolidation?.enabled === false) disabledJobs.push('nightly_consolidation');

  const hasProactiveTuning =
    Boolean(proactive?.quietHours && Object.keys(proactive.quietHours).length > 0) ||
    Boolean(proactive?.jobs && Object.keys(proactive.jobs).length > 0);
  const hasDiaryOverrides = Boolean(diary && Object.keys(diary).length > 0);
  const hasRunwayOverrides = Boolean(finance?.runway && Object.keys(finance.runway).length > 0);
  const customPersonas = Object.values(brain?.customPersonas ?? {}).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const disabledBuiltinSkills = [...(brain?.disabledBuiltinSkills ?? [])];

  const hasOverrides = Boolean(
    prefs.assistantName ||
      (profile.modelProvider !== null && profile.modelProvider !== 'gemini') ||
      (ai && Object.keys(ai).length > 0) ||
      (adhd && Object.keys(adhd).length > 0) ||
      (finance && Object.keys(finance).length > 0) ||
      hasDiaryOverrides ||
      hasProactiveTuning ||
      customPersonas.length > 0 ||
      disabledBuiltinSkills.length > 0 ||
      (miniapp && Object.keys(miniapp).length > 0),
  );

  const presets = Object.values(prefs.presets ?? {})
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      updated_at: p.updatedAt,
    }));

  const routines = Object.values(proactive?.routines ?? {})
    .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      kind: r.kind,
      schedule: r.schedule,
      time: r.time,
      ...(r.weekdays ? { weekdays: [...r.weekdays] } : {}),
      ...(r.dayOfMonth !== undefined ? { day_of_month: r.dayOfMonth } : {}),
      ...(r.summaryKind ? { summary_kind: r.summaryKind } : {}),
      ...(r.toolAccess ? { tool_access: r.toolAccess } : {}),
      respect_quiet_hours: r.respectQuietHours !== false,
    }));

  return {
    assistant_name: prefs.assistantName ?? null,
    prefs_summary: {
      has_overrides: hasOverrides,
      history_count: historyCount,
      ai: {
        preferred_model: ai?.preferredModel ?? null,
        max_steps: ai?.maxSteps ?? null,
        temperature: ai?.temperature ?? null,
      },
      adhd: {
        overload_shield_enabled: shield?.enabled ?? true,
        overload_overdue_threshold: shield?.overdueTaskCount ?? null,
        overload_active_todo_threshold: shield?.activeTodoCount ?? null,
        overload_night_window: fmtNightWindow(shield),
        focus_limit: adhd?.focusLimit ?? null,
        stale_after_days: adhd?.staleAfterDays ?? null,
      },
      finance: {
        reserve_eur:
          typeof finance?.reserveCents === 'number' && finance.reserveCents > 0
            ? Math.round(finance.reserveCents) / 100
            : 0,
        aliases_count: finance?.accountAliases?.length ?? 0,
        default_accounts_count: Object.keys(finance?.defaultAccountByCurrency ?? {}).length,
        has_runway_overrides: hasRunwayOverrides,
      },
      diary: {
        has_overrides: hasDiaryOverrides,
        include_tasks: diary?.includeTasks ?? true,
        sections_count: diary?.sections?.length ?? 0,
        header_template: diary?.headerTemplate ?? null,
      },
      proactive: {
        quiet_hours_enabled: proactive?.quietHours?.enabled === true,
        quiet_hours_start: proactive?.quietHours?.start ?? null,
        quiet_hours_end: proactive?.quietHours?.end ?? null,
        disabled_jobs: disabledJobs,
      },
      brain: {
        custom_personas_count: customPersonas.length,
        disabled_builtin_skills: disabledBuiltinSkills,
      },
      miniapp: {
        tabs: miniapp?.tabs ? [...miniapp.tabs] : null,
        account_themes_count: miniapp?.accountThemes?.length ?? 0,
      },
    },
    custom_personas: customPersonas.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    })),
    presets,
    routines,
  };
}

// ---------------------------------------------------------------------------
// Разговорный режим (/talk) — перенесён из handlers/ingest.ts для lib/
// ---------------------------------------------------------------------------

export interface TalkModeStatus {
  active: boolean;
  expiresAt: number | null;
  remainingMinutes: number;
}

/** Читает статус режима `/talk` (строго read-only). */
export async function getTalkModeStatus(
  userId: number,
  nowMs: number = Date.now(),
): Promise<TalkModeStatus> {
  const raw = await kvGet(talkModeKvKey(userId));
  if (!raw) return { active: false, expiresAt: null, remainingMinutes: 0 };
  try {
    const parsed = JSON.parse(raw) as { until?: unknown };
    if (typeof parsed?.until === 'number' && parsed.until > nowMs) {
      return {
        active: true,
        expiresAt: parsed.until,
        remainingMinutes: Math.max(1, Math.ceil((parsed.until - nowMs) / 60_000)),
      };
    }
    return { active: false, expiresAt: null, remainingMinutes: 0 };
  } catch {
    return { active: false, expiresAt: null, remainingMinutes: 0 };
  }
}

export async function isTalkModeActive(
  userId: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const status = await getTalkModeStatus(userId, nowMs);
  return status.active;
}

export async function enableTalkMode(
  userId: number,
  nowMs: number = Date.now(),
  ttlMs: number = TALK_MODE_TTL_MS,
): Promise<number> {
  const safeTtlMs = Math.min(
    MAX_TALK_MODE_TTL_MINUTES * 60_000,
    Math.max(MIN_TALK_MODE_TTL_MINUTES * 60_000, Math.trunc(ttlMs)),
  );
  const until = nowMs + safeTtlMs;
  await kvSet(talkModeKvKey(userId), JSON.stringify({ until }));
  return until;
}

export async function disableTalkMode(userId: number): Promise<void> {
  await kvDelete(talkModeKvKey(userId));
}
