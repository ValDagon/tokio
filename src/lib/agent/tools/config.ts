/**
 * Тулзы агента: полная рантайм-конфигурация через чат (Волны 1–2 `PLAN-CHAT-CONFIG.md`).
 *
 * Что здесь есть:
 *  - чтение/обновление профиля, AI-параметров, СДВГ-порогов, финансовых правил, дневника и проактивности с diff «было → стало»;
 *  - 10-шаговый откат и сброс секций (сами сбросы тоже откатываются);
 *  - именованные пресеты режимов и кастомные регулярные рутины (`manage_routines`);
 *  - точечное управление правилами `/learn`, кастомными персонами и полным циклом скиллов;
 *  - CRUD категорий/подкатегорий задач и финансовых категорий с безопасной отвязкой;
 *  - управление главами `doc_chapters`, бэклогом эволюции и режимом `/talk` / сбросом треда.
 *
 * Секреты (BYOK-ключи, `ADMIN_IDS`, `MASTER_KEY`, `WEBHOOK_SECRET`) строго запрещены.
 */

import { CUSTOM_INSTRUCTIONS_SLUG } from '../constants.js';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry.js';
import { asInt, asText, errorText, fail } from './tasks.js';
import { loadThread, clearThread } from '../../dal/agentState.js';
import { deleteChapter, getChapter, listChapters, upsertChapter } from '../../dal/docs.js';
import {
  countCategoryUsage,
  createCategory as createFinCategory,
  deleteCategory as deleteFinCategory,
  listCategories as listFinCategories,
  updateCategory as updateFinCategory,
} from '../../dal/finances.js';
import {
  createCategory as createTaskCategory,
  createSubcategory as createTaskSubcategory,
  deleteCategory as deleteTaskCategory,
  deleteSubcategory as deleteTaskSubcategory,
  findCategoryByNameInsensitive,
  findSubcategoryByNameInsensitive,
  listCategories as listTaskCategories,
  listSubcategories as listTaskSubcategories,
  updateCategory as updateTaskCategory,
  updateSubcategory as updateTaskSubcategory,
} from '../../dal/tasks.js';
import { ensureUser, updateUser } from '../../dal/users.js';
import {
  activateSkill,
  addItem,
  createManualSkillDraft,
  disableSkill,
  getItem,
  listAllUserSkills,
  listItems,
  rejectSkill,
  removeItem,
  resolveItem,
} from '../../evolution.js';
import { scheduleNightlyConsolidation } from '../../consolidation.js';
import { buildMorningDigest } from '../../digest.js';
import { isProviderKeyAvailable } from '../../gemini.js';
import { SUPPORTED_LOCALES } from '../../i18n.js';
import {
  editRule,
  listLearnedRules,
  rememberRule,
  removeRule,
  setPersonaStyle,
  splitDirectives,
} from '../../learning.js';
import { findOverlaySkill, getOverlay, getOverlaySkills, getPersonaStyleText } from '../../overlay.js';
import {
  BUILTIN_PERSONA_IDS,
  DEFAULT_LIABILITY_WARNING_DAYS,
  DEFAULT_MEDICATION_REMINDER_WINDOW_MINUTES,
  DEFAULT_MORNING_DIGEST_WINDOW_MINUTES,
  DEFAULT_NIGHTLY_CONSOLIDATION_HOUR,
  DEFAULT_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
  DEFAULT_OVERLOAD_ACTIVE_TODO_THRESHOLD,
  DEFAULT_OVERLOAD_NIGHT_END_HOUR,
  DEFAULT_OVERLOAD_NIGHT_START_HOUR,
  DEFAULT_OVERLOAD_OVERDUE_THRESHOLD,
  DEFAULT_ROUTINE_WINDOW_MINUTES,
  DEFAULT_STALE_AFTER_DAYS,
  DIGEST_SECTION_IDS,
  MAX_ACTIVE_AI_ROUTINES,
  MAX_AGENT_MAX_STEPS,
  MAX_ALIAS_PATTERNS,
  MAX_CUSTOM_ROUTINES,
  MAX_DIARY_HEADER_CHARS,
  MAX_DIARY_SECTION_CHARS,
  MAX_DIARY_SECTIONS,
  MAX_FINANCE_ALIASES,
  MAX_LIABILITY_WARNING_DAYS,
  MAX_MEDICATION_REMINDER_WINDOW_MINUTES,
  MAX_MORNING_DIGEST_WINDOW_MINUTES,
  MAX_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
  MAX_OVERLOAD_ACTIVE_TODO_THRESHOLD,
  MAX_OVERLOAD_OVERDUE_THRESHOLD,
  MAX_RESERVE_EUR_CENTS,
  MAX_ROUTINE_WINDOW_MINUTES,
  MAX_RUNWAY_BURN_CENTS,
  MAX_RUNWAY_HORIZON_DAYS,
  MAX_RUNWAY_WINDOW_DAYS,
  MAX_STALE_AFTER_DAYS,
  MAX_TALK_MODE_TTL_MINUTES,
  MINIAPP_ACCOUNT_THEMES,
  MINIAPP_TAB_IDS,
  MIN_AGENT_MAX_STEPS,
  MIN_FOCUS_LIMIT,
  MAX_FOCUS_LIMIT,
  MIN_LIABILITY_WARNING_DAYS,
  MIN_MEDICATION_REMINDER_WINDOW_MINUTES,
  MIN_MORNING_DIGEST_WINDOW_MINUTES,
  MIN_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
  MIN_OVERLOAD_ACTIVE_TODO_THRESHOLD,
  MIN_OVERLOAD_OVERDUE_THRESHOLD,
  MIN_ROUTINE_WINDOW_MINUTES,
  MIN_RUNWAY_BURN_CENTS,
  MIN_RUNWAY_HORIZON_DAYS,
  MIN_RUNWAY_WINDOW_DAYS,
  MIN_STALE_AFTER_DAYS,
  MIN_TALK_MODE_TTL_MINUTES,
  RESET_SECTIONS,
  TALK_MODE_TTL_MS,
  applyPresetPayloadToState,
  applySettingsState,
  buildPresetPayloadFromState,
  captureSettingsState,
  countActiveAiRoutines,
  disableTalkMode,
  enableTalkMode,
  formatSettingsDiff,
  getTalkModeStatus,
  loadPrefsHistory,
  normalizeConfigSlug,
  normalizeTimeHHMM,
  parseWeekdaysInput,
  pushPrefsSnapshot,
  resetSettingsSection,
  resolveEffectiveUiConfig,
  rollbackSettings,
  saveUserPrefs,
  type CustomPersona,
  type CustomRoutine,
  type DigestSectionId,
  type MiniAppAccountThemeKind,
  type MiniAppTabId,
  type ResetSection,
  type RoutineKind,
  type RoutineScheduleType,
  type RoutineSummaryKind,
  type RoutineToolAccess,
  type SettingsPreset,
  type UserPrefs,
} from '../../prefs.js';
import { PROVIDER_IDS, parseProviderId } from '../../provider/index.js';
import {
  balanceSummary,
  debtsSummary,
  medsSummary,
  quickSummary,
  tasksSummary,
} from '../../summary.js';
import type { EvolutionCategory, EvolutionPriority, EvolutionStatus, FinCategoryKind, LocaleCode } from '../../../types.js';
import { nowIso, parseAmountToCents, truncate } from '../../utils.js';

const FORBIDDEN_SECRET_ARGS = new Set([
  'apikey',
  'byok',
  'byokkey',
  'geminiapikey',
  'openaiapikey',
  'deepseekapikey',
  'anthropicapikey',
  'token',
  'masterkey',
  'adminids',
  'webhooksecret',
  'secrets',
]);

const VALID_RESET_SECTIONS: ReadonlySet<ResetSection> = new Set(RESET_SECTIONS);

function hasForbiddenSecretArg(args: ToolArgs): string | null {
  for (const key of Object.keys(args)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_SECRET_ARGS.has(normalized) && args[key] !== undefined) {
      return key;
    }
  }
  return null;
}

function asBool(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'да') return true;
    if (lower === 'false' || lower === '0' || lower === 'нет') return false;
  }
  return null;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatEurFromCents(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return 'по умолчанию';
  const eur = cents / 100;
  return Number.isInteger(eur) ? `${eur} €` : `${eur.toFixed(2)} €`;
}

function parseNonNegativeEurCents(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'number' && (!Number.isFinite(raw) || raw < 0)) return null;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    const cents = parseAmountToCents(text);
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

function parseIntArg(raw: unknown, min: number, max: number): number | null {
  const n = asInt(raw);
  if (n === null || n < min || n > max) return null;
  return n;
}

function isResetSentinel(raw: unknown): boolean {
  if (raw === null) return true;
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase();
    return clean === '' || clean === 'default' || clean === 'reset' || clean === 'clear' || clean === 'none';
  }
  return false;
}

function slugFromTitle(raw: string): string {
  return normalizeConfigSlug(raw);
}

const VALID_GET_SECTIONS = new Set([
  'all',
  'profile',
  'ai',
  'brain',
  'adhd',
  'finance',
  'diary',
  'proactive',
  'routines',
  'miniapp',
  'presets',
  'session',
]);

// ---------------------------------------------------------------------------
// 1. get_settings (read-only)
// ---------------------------------------------------------------------------

async function getSettingsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const requested = asText(args.section)?.toLowerCase() ?? 'all';
  const section = VALID_GET_SECTIONS.has(requested) ? requested : 'all';

  try {
    const [state, history, talk, thread, userSkills, providerStatuses] = await Promise.all([
      captureSettingsState(ctx.userId),
      loadPrefsHistory(ctx.userId),
      getTalkModeStatus(ctx.userId, ctx.now.getTime()),
      loadThread(ctx.userId).catch(() => []),
      listAllUserSkills(ctx.userId).catch(() => []),
      Promise.all(
        PROVIDER_IDS.map(async (id) => ({
          id,
          available: await isProviderKeyAvailable(ctx.userId, id),
        })),
      ),
    ]);

    const overlaySkills = getOverlaySkills();
    const disabledBuiltin = new Set(state.prefs.brain?.disabledBuiltinSkills ?? []);
    const customPersonas = state.prefs.brain?.customPersonas ?? {};
    const presets = state.prefs.presets ?? {};
    const rules = listLearnedRulesSync(state.directives.instructions);

    const activeUserSkills = userSkills.filter((s) => s.row.status === 'active').length;
    const pendingUserSkills = userSkills.filter((s) => s.row.status === 'pending').length;
    const disabledUserSkills = userSkills.filter((s) => s.row.status === 'disabled').length;

    const adhd = state.prefs.adhd;
    const shield = adhd?.overloadShield;
    const finance = state.prefs.finance;
    const runway = finance?.runway;
    const diary = state.prefs.diary;
    const proactive = state.prefs.proactive;
    const jobs = proactive?.jobs;
    const routinesMap = proactive?.routines ?? {};
    const routinesList = Object.values(routinesMap).sort(
      (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
    );
    const activeAiCount = countActiveAiRoutines(routinesMap);
    const effectiveUi = resolveEffectiveUiConfig(
      getOverlay().manifest,
      state.prefs,
      state.profile.language,
    );
    const tabsOverridden = Boolean(state.prefs.miniapp?.tabs && state.prefs.miniapp.tabs.length > 0);
    const customAccountThemes = state.prefs.miniapp?.accountThemes ?? [];

    const lines: string[] = ['⚙️ **Текущие настройки системы:**'];
    if (section === 'all' || section === 'profile') {
      lines.push(
        `• Профиль: имя=${state.profile.name ?? 'не задано'}, язык=${state.profile.language}, валюта=${state.profile.baseCurrency}, таймзона=${state.profile.timezone}, дайджест=${state.profile.summaryTime}, calm=${state.profile.lowStimulationMode ? 'вкл' : 'выкл'}`,
      );
    }
    if (section === 'all' || section === 'ai') {
      const avail = providerStatuses.filter((p) => p.available).map((p) => p.id).join(', ') || 'нет';
      lines.push(
        `• AI-движок: провайдер=${state.profile.modelProvider ?? 'gemini'}, модель=${state.prefs.ai?.preferredModel ?? 'по умолчанию'}, шаги=${state.prefs.ai?.maxSteps ?? '8 (по умолчанию)'}, температура=${state.prefs.ai?.temperature ?? '0.7 (по умолчанию)'}; доступные провайдеры: ${avail}`,
      );
    }
    if (section === 'all' || section === 'brain') {
      lines.push(
        `• Мозг и персонализация: имя ассистента=${state.prefs.assistantName ?? 'по умолчанию'}, персона=${state.directives.style ?? 'mentor'}, кастомных персон=${Object.keys(customPersonas).length}, правил /learn=${rules.length}`,
      );
      lines.push(
        `• Скиллы: встроенных=${overlaySkills.length} (отключено: ${disabledBuiltin.size}), пользовательских=${userSkills.length} (active=${activeUserSkills}, pending=${pendingUserSkills}, disabled=${disabledUserSkills})`,
      );
    }
    if (section === 'all' || section === 'adhd') {
      const shieldEnabled = shield?.enabled !== false ? 'вкл' : 'выкл';
      const nStart = String(shield?.nightStartHour ?? DEFAULT_OVERLOAD_NIGHT_START_HOUR).padStart(2, '0');
      const nEnd = String(shield?.nightEndHour ?? DEFAULT_OVERLOAD_NIGHT_END_HOUR).padStart(2, '0');
      lines.push(
        `• СДВГ и фокус: Щит=${shieldEnabled} (просрочка>=${shield?.overdueTaskCount ?? DEFAULT_OVERLOAD_OVERDUE_THRESHOLD}, активных>=${shield?.activeTodoCount ?? DEFAULT_OVERLOAD_ACTIVE_TODO_THRESHOLD}, ночь=${nStart}:00–${nEnd}:00), фокус дня=${adhd?.focusLimit ?? 'по умолчанию (3 в задачах / 2 в дайджесте)'}, стагнация=${adhd?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS} дн.`,
      );
    }
    if (section === 'all' || section === 'finance') {
      const aliasSummary =
        finance?.accountAliases && finance.accountAliases.length > 0
          ? finance.accountAliases.map((a) => `${a.account}: ${a.patterns.join(', ')}`).join('; ')
          : 'нет';
      const defaultAccSummary =
        finance?.defaultAccountByCurrency && Object.keys(finance.defaultAccountByCurrency).length > 0
          ? Object.entries(finance.defaultAccountByCurrency)
              .map(([c, a]) => `${c}→${a}`)
              .join(', ')
          : 'по умолчанию';
      lines.push(
        `• Финансы: алиасы=[${aliasSummary}], дефолт по валютам=[${defaultAccSummary}], целевой резерв=${finance?.reserveCents ? formatEurFromCents(finance.reserveCents) : '0 €'}, burn фикс=${runway?.dailyBurnOverrideCents ? formatEurFromCents(runway.dailyBurnOverrideCents) : 'авто'}, min burn=${runway?.minDailyBurnCents ? formatEurFromCents(runway.minDailyBurnCents) : 'по умолчанию'}, seed burn=${runway?.seedDailyBurnCents ? formatEurFromCents(runway.seedDailyBurnCents) : 'по умолчанию'}, окно burn=${runway?.burnWindowDays ?? 'по умолчанию'} дн., горизонт=${runway?.horizonDays ?? 'до конца месяца'} дн.`,
      );
    }
    if (section === 'all' || section === 'diary') {
      lines.push(
        `• Дневник: секции=${diary?.sections ? diary.sections.join(', ') : 'по умолчанию'}, задачи дня=${diary?.includeTasks === false ? 'выкл' : 'вкл'}, заголовок=${diary?.headerTemplate ?? 'по умолчанию'}`,
      );
    }
    if (section === 'all' || section === 'proactive') {
      const qh = proactive?.quietHours;
      const qhText = qh?.enabled ? `вкл (${qh.start ?? '23:00'}–${qh.end ?? '07:00'})` : 'выкл';
      const md = jobs?.morning_digest;
      const lw = jobs?.liability_warning;
      const lr = jobs?.liability_review;
      const mr = jobs?.medication_reminder;
      const nc = jobs?.nightly_consolidation;
      lines.push(
        `• Проактивность: тихие часы=${qhText}; дайджест=${md?.enabled === false ? 'выкл' : 'вкл'} (окно=${md?.windowMinutes ?? DEFAULT_MORNING_DIGEST_WINDOW_MINUTES} мин, секции=${md?.sections ? md.sections.join(',') : 'все'}); предупреждения о платежах=${lw?.enabled === false ? 'выкл' : 'вкл'} (за ${lw?.daysBefore ?? DEFAULT_LIABILITY_WARNING_DAYS} дн.); проверка списаний=${lr?.enabled === false ? 'выкл' : 'вкл'}; лекарства=${mr?.enabled === false ? 'выкл' : 'вкл'} (окно=${mr?.windowMinutes ?? DEFAULT_MEDICATION_REMINDER_WINDOW_MINUTES} мин); ночная консолидация=${nc?.enabled === false ? 'выкл' : 'вкл'} (${String(nc?.hour ?? DEFAULT_NIGHTLY_CONSOLIDATION_HOUR).padStart(2, '0')}:00, лимит=${nc?.noteLimit ?? DEFAULT_NIGHTLY_CONSOLIDATION_NOTE_LIMIT} заметок)`,
      );
    }
    if (section === 'all' || section === 'routines') {
      lines.push(
        `• Кастомные рутины: ${routinesList.length}/${MAX_CUSTOM_ROUTINES} (активных AI: ${activeAiCount}/${MAX_ACTIVE_AI_ROUTINES})`,
      );
      for (const r of routinesList) {
        const extra =
          r.schedule === 'weekly'
            ? ` [дни: ${(r.weekdays ?? []).join(',')}]`
            : r.schedule === 'monthly'
              ? ` [${r.dayOfMonth ?? 1}-е]`
              : '';
        const aiTag = r.kind === 'ai' ? `, ${r.toolAccess ?? 'read-only'}` : '';
        lines.push(
          `  - \`${r.id}\` «${r.name}»: ${r.kind}, ${r.schedule}${extra} ${r.time}, ${r.enabled ? 'вкл' : 'пауза'}${aiTag}`,
        );
      }
    }
    if (section === 'all' || section === 'miniapp') {
      const themesSummary =
        customAccountThemes.length > 0
          ? customAccountThemes
              .map((t) => {
                const attrs = [t.theme, t.shortName, t.roleLabel].filter(Boolean).join(' · ');
                return `${t.pattern}${attrs ? ` (${attrs})` : ''}`;
              })
              .join('; ')
          : 'по умолчанию';
      lines.push(
        `• Mini App: вкладки=${effectiveUi.miniapp.tabs.join(', ')}${tabsOverridden ? ' (кастомные)' : ' (по умолчанию)'}, кастомные роли/темы счетов=[${themesSummary}]`,
      );
    }
    if (section === 'all' || section === 'presets') {
      const presetNames = Object.values(presets).map((p) => `${p.name} (${p.id})`);
      lines.push(
        `• Пресеты: ${presetNames.length > 0 ? presetNames.join(', ') : 'нет'} · Шагов для отката: ${history.length}`,
      );
    }
    if (section === 'all' || section === 'session') {
      lines.push(
        `• Сессия: /talk=${talk.active ? `вкл (осталось ${talk.remainingMinutes} мин)` : 'выкл'}, сообщений в треде=${thread.length}`,
      );
    }

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        profile: state.profile,
        assistant_name: state.prefs.assistantName ?? null,
        ai: {
          provider: state.profile.modelProvider ?? 'gemini',
          preferred_model: state.prefs.ai?.preferredModel ?? null,
          max_steps: state.prefs.ai?.maxSteps ?? null,
          temperature: state.prefs.ai?.temperature ?? null,
          available_providers: providerStatuses,
        },
        brain: {
          persona_style: state.directives.style ?? 'mentor',
          rules_count: rules.length,
          custom_personas: Object.values(customPersonas),
          disabled_builtin_skills: [...disabledBuiltin],
          builtin_skills_total: overlaySkills.length,
          user_skills_counts: {
            total: userSkills.length,
            active: activeUserSkills,
            pending: pendingUserSkills,
            disabled: disabledUserSkills,
          },
        },
        adhd: adhd ?? {},
        finance: finance ?? {},
        diary: diary ?? {},
        proactive: {
          quiet_hours: proactive?.quietHours ?? { enabled: false },
          jobs: jobs ?? {},
        },
        miniapp: {
          tabs: effectiveUi.miniapp.tabs,
          tabs_overridden: tabsOverridden,
          account_themes_overrides: customAccountThemes,
          effective_account_themes: effectiveUi.miniapp.accountThemes,
        },
        routines: routinesList,
        active_ai_routines: activeAiCount,
        presets: Object.values(presets),
        rollback_history_count: history.length,
        session: {
          talk_mode: talk,
          thread_messages: thread.length,
        },
      },
    };
  } catch (error) {
    return fail(`Не удалось прочитать настройки: ${errorText(error)}`);
  }
}

function listLearnedRulesSync(instructions: string): string[] {
  return String(instructions ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 2. update_settings
// ---------------------------------------------------------------------------

type UpdatePatchResult =
  | { ok: true; hasChange: boolean; rescheduleConsolidation?: boolean; apply: (prefs: UserPrefs) => void }
  | { ok: false; error: string };

function parseAdhdUpdate(args: ToolArgs): UpdatePatchResult {
  let hasChange = false;
  let shieldEnabled: boolean | undefined;
  let overdueThreshold: number | undefined;
  let activeTodoThreshold: number | undefined;
  let nightStartHour: number | undefined;
  let nightEndHour: number | undefined;
  let focusLimit: number | undefined;
  let staleAfterDays: number | undefined;

  if (args.overload_shield_enabled !== undefined && args.overload_shield_enabled !== null) {
    const val = asBool(args.overload_shield_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'overload_shield_enabled должен быть true или false.' };
    }
    shieldEnabled = val;
    hasChange = true;
  }

  if (args.overload_overdue_threshold !== undefined && args.overload_overdue_threshold !== null) {
    const val = parseIntArg(
      args.overload_overdue_threshold,
      MIN_OVERLOAD_OVERDUE_THRESHOLD,
      MAX_OVERLOAD_OVERDUE_THRESHOLD,
    );
    if (val === null) {
      return {
        ok: false,
        error: `overload_overdue_threshold должен быть целым числом от ${MIN_OVERLOAD_OVERDUE_THRESHOLD} до ${MAX_OVERLOAD_OVERDUE_THRESHOLD}.`,
      };
    }
    overdueThreshold = val;
    hasChange = true;
  }

  if (args.overload_active_todo_threshold !== undefined && args.overload_active_todo_threshold !== null) {
    const val = parseIntArg(
      args.overload_active_todo_threshold,
      MIN_OVERLOAD_ACTIVE_TODO_THRESHOLD,
      MAX_OVERLOAD_ACTIVE_TODO_THRESHOLD,
    );
    if (val === null) {
      return {
        ok: false,
        error: `overload_active_todo_threshold должен быть целым числом от ${MIN_OVERLOAD_ACTIVE_TODO_THRESHOLD} до ${MAX_OVERLOAD_ACTIVE_TODO_THRESHOLD}.`,
      };
    }
    activeTodoThreshold = val;
    hasChange = true;
  }

  if (args.overload_night_start_hour !== undefined && args.overload_night_start_hour !== null) {
    const val = parseIntArg(args.overload_night_start_hour, 0, 23);
    if (val === null) {
      return { ok: false, error: 'overload_night_start_hour должен быть целым часом от 0 до 23.' };
    }
    nightStartHour = val;
    hasChange = true;
  }

  if (args.overload_night_end_hour !== undefined && args.overload_night_end_hour !== null) {
    const val = parseIntArg(args.overload_night_end_hour, 0, 23);
    if (val === null) {
      return { ok: false, error: 'overload_night_end_hour должен быть целым часом от 0 до 23.' };
    }
    nightEndHour = val;
    hasChange = true;
  }

  if (args.focus_limit !== undefined && args.focus_limit !== null) {
    const val = parseIntArg(args.focus_limit, MIN_FOCUS_LIMIT, MAX_FOCUS_LIMIT);
    if (val === null) {
      return {
        ok: false,
        error: `focus_limit должен быть целым числом от ${MIN_FOCUS_LIMIT} до ${MAX_FOCUS_LIMIT}.`,
      };
    }
    focusLimit = val;
    hasChange = true;
  }

  if (args.stale_after_days !== undefined && args.stale_after_days !== null) {
    const val = parseIntArg(args.stale_after_days, MIN_STALE_AFTER_DAYS, MAX_STALE_AFTER_DAYS);
    if (val === null) {
      return {
        ok: false,
        error: `stale_after_days должен быть целым числом от ${MIN_STALE_AFTER_DAYS} до ${MAX_STALE_AFTER_DAYS}.`,
      };
    }
    staleAfterDays = val;
    hasChange = true;
  }

  return {
    ok: true,
    hasChange,
    apply(nextPrefs) {
      if (!hasChange) return;
      const adhd = { ...(nextPrefs.adhd ?? {}) };
      if (
        shieldEnabled !== undefined ||
        overdueThreshold !== undefined ||
        activeTodoThreshold !== undefined ||
        nightStartHour !== undefined ||
        nightEndHour !== undefined
      ) {
        const shield = { ...(adhd.overloadShield ?? {}) };
        if (shieldEnabled !== undefined) shield.enabled = shieldEnabled;
        if (overdueThreshold !== undefined) shield.overdueTaskCount = overdueThreshold;
        if (activeTodoThreshold !== undefined) shield.activeTodoCount = activeTodoThreshold;
        if (nightStartHour !== undefined) shield.nightStartHour = nightStartHour;
        if (nightEndHour !== undefined) shield.nightEndHour = nightEndHour;
        adhd.overloadShield = shield;
      }
      if (focusLimit !== undefined) adhd.focusLimit = focusLimit;
      if (staleAfterDays !== undefined) adhd.staleAfterDays = staleAfterDays;
      nextPrefs.adhd = adhd;
    },
  };
}

function parseFinanceUpdate(args: ToolArgs): UpdatePatchResult {
  let hasChange = false;

  const hasAliasAccount = args.finance_alias_account !== undefined && args.finance_alias_account !== null;
  const hasAliasPatterns = Object.hasOwn(args, 'finance_alias_patterns') && args.finance_alias_patterns !== undefined;
  let aliasAccount = '';
  let aliasPatterns: string[] | null | undefined;
  if (hasAliasAccount || hasAliasPatterns) {
    aliasAccount = hasAliasAccount ? String(args.finance_alias_account).trim() : '';
    if (!aliasAccount) {
      return { ok: false, error: 'Укажите finance_alias_account — точное имя счёта для алиасов.' };
    }
    if (!hasAliasPatterns) {
      return {
        ok: false,
        error: 'Укажите finance_alias_patterns (паттерны через запятую или "" для удаления алиасов счёта).',
      };
    }
    if (isResetSentinel(args.finance_alias_patterns)) {
      aliasPatterns = null;
    } else {
      const seen = new Set<string>();
      const parsed: string[] = [];
      for (const part of String(args.finance_alias_patterns).split(/[,;|]+/)) {
        const clean = truncate(part.trim().replace(/\s+/g, ' '), 40);
        if (!clean || seen.has(clean.toLowerCase())) continue;
        seen.add(clean.toLowerCase());
        parsed.push(clean);
      }
      if (parsed.length === 0) {
        return { ok: false, error: 'finance_alias_patterns пуст: передайте слова через запятую или "" для удаления.' };
      }
      if (parsed.length > MAX_ALIAS_PATTERNS) {
        return { ok: false, error: `Слишком много паттернов алиаса (максимум ${MAX_ALIAS_PATTERNS}).` };
      }
      aliasPatterns = parsed;
    }
    hasChange = true;
  }

  const hasDefCur = args.finance_default_currency !== undefined && args.finance_default_currency !== null;
  const hasDefAcc = Object.hasOwn(args, 'finance_default_account') && args.finance_default_account !== undefined;
  let defCur = '';
  let defAcc: string | null | undefined;
  if (hasDefCur || hasDefAcc) {
    defCur = hasDefCur ? String(args.finance_default_currency).trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(defCur)) {
      return { ok: false, error: 'finance_default_currency должен быть 3-буквенным кодом ISO-4217 (например EUR, RUB).' };
    }
    if (!hasDefAcc) {
      return { ok: false, error: 'Укажите finance_default_account (имя счёта или "" для сброса дефолта).' };
    }
    defAcc = isResetSentinel(args.finance_default_account)
      ? null
      : truncate(String(args.finance_default_account).trim(), 80);
    hasChange = true;
  }

  let reserveCents: number | null | undefined;
  if (Object.hasOwn(args, 'finance_reserve_eur') && args.finance_reserve_eur !== undefined) {
    if (isResetSentinel(args.finance_reserve_eur) || args.finance_reserve_eur === 0 || String(args.finance_reserve_eur).trim() === '0') {
      reserveCents = null;
    } else {
      const cents = parseNonNegativeEurCents(args.finance_reserve_eur);
      if (cents === null || cents > MAX_RESERVE_EUR_CENTS) {
        return {
          ok: false,
          error: `finance_reserve_eur должен быть от 0 до ${Math.trunc(MAX_RESERVE_EUR_CENTS / 100)} EUR.`,
        };
      }
      reserveCents = cents === 0 ? null : cents;
    }
    hasChange = true;
  }

  const parseRunwayEur = (key: string): { present: boolean; value?: number | null; error?: string } => {
    if (!Object.hasOwn(args, key) || args[key] === undefined) return { present: false };
    if (isResetSentinel(args[key]) || args[key] === 0 || String(args[key]).trim() === '0') {
      return { present: true, value: null };
    }
    const cents = parseNonNegativeEurCents(args[key]);
    if (cents === null || (cents > 0 && cents < MIN_RUNWAY_BURN_CENTS) || cents > MAX_RUNWAY_BURN_CENTS) {
      return {
        present: true,
        error: `${key} должен быть от ${MIN_RUNWAY_BURN_CENTS / 100} до ${MAX_RUNWAY_BURN_CENTS / 100} EUR (или 0 для сброса).`,
      };
    }
    return { present: true, value: cents === 0 ? null : cents };
  };

  const dailyOverride = parseRunwayEur('runway_daily_burn_override_eur');
  if (dailyOverride.error) return { ok: false, error: dailyOverride.error };
  const minBurn = parseRunwayEur('runway_min_daily_burn_eur');
  if (minBurn.error) return { ok: false, error: minBurn.error };
  const seedBurn = parseRunwayEur('runway_seed_daily_burn_eur');
  if (seedBurn.error) return { ok: false, error: seedBurn.error };

  if (dailyOverride.present || minBurn.present || seedBurn.present) hasChange = true;

  let burnWindowDays: number | null | undefined;
  if (Object.hasOwn(args, 'runway_burn_window_days') && args.runway_burn_window_days !== undefined) {
    if (isResetSentinel(args.runway_burn_window_days) || args.runway_burn_window_days === 0 || String(args.runway_burn_window_days).trim() === '0') {
      burnWindowDays = null;
    } else {
      const val = parseIntArg(args.runway_burn_window_days, MIN_RUNWAY_WINDOW_DAYS, MAX_RUNWAY_WINDOW_DAYS);
      if (val === null) {
        return {
          ok: false,
          error: `runway_burn_window_days должен быть от ${MIN_RUNWAY_WINDOW_DAYS} до ${MAX_RUNWAY_WINDOW_DAYS} (или 0 для сброса).`,
        };
      }
      burnWindowDays = val;
    }
    hasChange = true;
  }

  let horizonDays: number | null | undefined;
  if (Object.hasOwn(args, 'runway_horizon_days') && args.runway_horizon_days !== undefined) {
    if (isResetSentinel(args.runway_horizon_days) || args.runway_horizon_days === 0 || String(args.runway_horizon_days).trim() === '0') {
      horizonDays = null;
    } else {
      const val = parseIntArg(args.runway_horizon_days, MIN_RUNWAY_HORIZON_DAYS, MAX_RUNWAY_HORIZON_DAYS);
      if (val === null) {
        return {
          ok: false,
          error: `runway_horizon_days должен быть от ${MIN_RUNWAY_HORIZON_DAYS} до ${MAX_RUNWAY_HORIZON_DAYS} (или 0 для возврата до конца месяца).`,
        };
      }
      horizonDays = val;
    }
    hasChange = true;
  }

  return {
    ok: true,
    hasChange,
    apply(nextPrefs) {
      if (!hasChange) return;
      const fin = { ...(nextPrefs.finance ?? {}) };
      if (aliasPatterns !== undefined) {
        const currentAliases = [...(fin.accountAliases ?? [])];
        const idx = currentAliases.findIndex((a) => a.account.toLowerCase() === aliasAccount.toLowerCase());
        if (aliasPatterns === null) {
          if (idx >= 0) currentAliases.splice(idx, 1);
        } else if (idx >= 0) {
          currentAliases[idx] = { account: truncate(aliasAccount, 80), patterns: aliasPatterns };
        } else if (currentAliases.length < MAX_FINANCE_ALIASES) {
          currentAliases.push({ account: truncate(aliasAccount, 80), patterns: aliasPatterns });
        }
        if (currentAliases.length === 0) delete fin.accountAliases;
        else fin.accountAliases = currentAliases;
      }
      if (defAcc !== undefined) {
        const map = { ...(fin.defaultAccountByCurrency ?? {}) };
        if (defAcc === null) delete map[defCur];
        else map[defCur] = defAcc;
        if (Object.keys(map).length === 0) delete fin.defaultAccountByCurrency;
        else fin.defaultAccountByCurrency = map;
      }
      if (reserveCents !== undefined) {
        if (reserveCents === null) delete fin.reserveCents;
        else fin.reserveCents = reserveCents;
      }
      if (
        dailyOverride.present ||
        minBurn.present ||
        seedBurn.present ||
        burnWindowDays !== undefined ||
        horizonDays !== undefined
      ) {
        const runway = { ...(fin.runway ?? {}) };
        if (dailyOverride.present) {
          if (dailyOverride.value === null) delete runway.dailyBurnOverrideCents;
          else runway.dailyBurnOverrideCents = dailyOverride.value;
        }
        if (minBurn.present) {
          if (minBurn.value === null) delete runway.minDailyBurnCents;
          else runway.minDailyBurnCents = minBurn.value;
        }
        if (seedBurn.present) {
          if (seedBurn.value === null) delete runway.seedDailyBurnCents;
          else runway.seedDailyBurnCents = seedBurn.value;
        }
        if (burnWindowDays !== undefined) {
          if (burnWindowDays === null) delete runway.burnWindowDays;
          else runway.burnWindowDays = burnWindowDays;
        }
        if (horizonDays !== undefined) {
          if (horizonDays === null) delete runway.horizonDays;
          else runway.horizonDays = horizonDays;
        }
        if (Object.keys(runway).length === 0) delete fin.runway;
        else fin.runway = runway;
      }
      if (Object.keys(fin).length === 0) delete nextPrefs.finance;
      else nextPrefs.finance = fin;
    },
  };
}

function parseDiaryUpdate(args: ToolArgs): UpdatePatchResult {
  let hasChange = false;
  let sections: string[] | null | undefined;
  let includeTasks: boolean | undefined;
  let headerTemplate: string | null | undefined;

  if (Object.hasOwn(args, 'diary_sections') && args.diary_sections !== undefined) {
    if (isResetSentinel(args.diary_sections)) {
      sections = null;
    } else {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of String(args.diary_sections).split(/[,|\n]+/)) {
        const clean = truncate(raw.replace(/[\r\n]+/g, ' ').trim(), MAX_DIARY_SECTION_CHARS);
        if (!clean || seen.has(clean.toLowerCase())) continue;
        seen.add(clean.toLowerCase());
        out.push(clean);
      }
      if (out.length === 0) {
        return { ok: false, error: 'diary_sections пуст. Укажите секции через запятую или "default" для сброса.' };
      }
      if (out.length > MAX_DIARY_SECTIONS) {
        return { ok: false, error: `Слишком много секций дневника (максимум ${MAX_DIARY_SECTIONS}).` };
      }
      sections = out;
    }
    hasChange = true;
  }

  if (args.diary_include_tasks !== undefined && args.diary_include_tasks !== null) {
    const val = asBool(args.diary_include_tasks);
    if (val === null || val === undefined) {
      return { ok: false, error: 'diary_include_tasks должен быть true или false.' };
    }
    includeTasks = val;
    hasChange = true;
  }

  if (Object.hasOwn(args, 'diary_header_template') && args.diary_header_template !== undefined) {
    if (isResetSentinel(args.diary_header_template)) {
      headerTemplate = null;
    } else {
      const clean = truncate(String(args.diary_header_template).replace(/[\r\n]+/g, ' ').trim(), MAX_DIARY_HEADER_CHARS);
      if (!clean) headerTemplate = null;
      else headerTemplate = clean;
    }
    hasChange = true;
  }

  return {
    ok: true,
    hasChange,
    apply(nextPrefs) {
      if (!hasChange) return;
      const diary = { ...(nextPrefs.diary ?? {}) };
      if (sections !== undefined) {
        if (sections === null) delete diary.sections;
        else diary.sections = sections;
      }
      if (includeTasks !== undefined) diary.includeTasks = includeTasks;
      if (headerTemplate !== undefined) {
        if (headerTemplate === null) delete diary.headerTemplate;
        else diary.headerTemplate = headerTemplate;
      }
      if (Object.keys(diary).length === 0) delete nextPrefs.diary;
      else nextPrefs.diary = diary;
    },
  };
}

function parseProactiveUpdate(args: ToolArgs): UpdatePatchResult {
  let hasChange = false;
  let rescheduleConsolidation = false;

  let qhEnabled: boolean | undefined;
  let qhStart: string | undefined;
  let qhEnd: string | undefined;
  if (args.quiet_hours_enabled !== undefined && args.quiet_hours_enabled !== null) {
    const val = asBool(args.quiet_hours_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'quiet_hours_enabled должен быть true или false.' };
    }
    qhEnabled = val;
    hasChange = true;
  }
  if (args.quiet_hours_start !== undefined && args.quiet_hours_start !== null) {
    const t = normalizeTimeHHMM(args.quiet_hours_start);
    if (!t) return { ok: false, error: 'quiet_hours_start должен быть в формате ЧЧ:ММ (например 23:00).' };
    qhStart = t;
    hasChange = true;
  }
  if (args.quiet_hours_end !== undefined && args.quiet_hours_end !== null) {
    const t = normalizeTimeHHMM(args.quiet_hours_end);
    if (!t) return { ok: false, error: 'quiet_hours_end должен быть в формате ЧЧ:ММ (например 07:00).' };
    qhEnd = t;
    hasChange = true;
  }

  let mdEnabled: boolean | undefined;
  let mdWindow: number | undefined;
  let mdSections: DigestSectionId[] | null | undefined;
  if (args.morning_digest_enabled !== undefined && args.morning_digest_enabled !== null) {
    const val = asBool(args.morning_digest_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'morning_digest_enabled должен быть true или false.' };
    }
    mdEnabled = val;
    hasChange = true;
  }
  if (args.morning_digest_window_minutes !== undefined && args.morning_digest_window_minutes !== null) {
    const val = parseIntArg(
      args.morning_digest_window_minutes,
      MIN_MORNING_DIGEST_WINDOW_MINUTES,
      MAX_MORNING_DIGEST_WINDOW_MINUTES,
    );
    if (val === null) {
      return {
        ok: false,
        error: `morning_digest_window_minutes должен быть от ${MIN_MORNING_DIGEST_WINDOW_MINUTES} до ${MAX_MORNING_DIGEST_WINDOW_MINUTES}.`,
      };
    }
    mdWindow = val;
    hasChange = true;
  }
  if (Object.hasOwn(args, 'morning_digest_sections') && args.morning_digest_sections !== undefined) {
    const raw = args.morning_digest_sections === null ? '' : String(args.morning_digest_sections).trim().toLowerCase();
    if (raw === '' || raw === 'all' || raw === 'default' || raw === 'reset') {
      mdSections = null;
    } else {
      const validSet = new Set<string>(DIGEST_SECTION_IDS);
      const out: DigestSectionId[] = [];
      const seen = new Set<DigestSectionId>();
      for (const token of raw.split(/[\s,;|]+/).filter(Boolean)) {
        if (!validSet.has(token)) {
          return {
            ok: false,
            error: `Неизвестная секция дайджеста «${token}». Доступны: ${DIGEST_SECTION_IDS.join(', ')} (или "all").`,
          };
        }
        const typed = token as DigestSectionId;
        if (!seen.has(typed)) {
          seen.add(typed);
          out.push(typed);
        }
      }
      if (out.length === 0) {
        return { ok: false, error: `Укажите хотя бы одну секцию из: ${DIGEST_SECTION_IDS.join(', ')}.` };
      }
      mdSections = out;
    }
    hasChange = true;
  }

  let lwEnabled: boolean | undefined;
  let lwDays: number | undefined;
  if (args.liability_warning_enabled !== undefined && args.liability_warning_enabled !== null) {
    const val = asBool(args.liability_warning_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'liability_warning_enabled должен быть true или false.' };
    }
    lwEnabled = val;
    hasChange = true;
  }
  if (args.liability_warning_days !== undefined && args.liability_warning_days !== null) {
    const val = parseIntArg(args.liability_warning_days, MIN_LIABILITY_WARNING_DAYS, MAX_LIABILITY_WARNING_DAYS);
    if (val === null) {
      return {
        ok: false,
        error: `liability_warning_days должен быть от ${MIN_LIABILITY_WARNING_DAYS} до ${MAX_LIABILITY_WARNING_DAYS}.`,
      };
    }
    lwDays = val;
    hasChange = true;
  }

  let lrEnabled: boolean | undefined;
  if (args.liability_review_enabled !== undefined && args.liability_review_enabled !== null) {
    const val = asBool(args.liability_review_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'liability_review_enabled должен быть true или false.' };
    }
    lrEnabled = val;
    hasChange = true;
  }

  let mrEnabled: boolean | undefined;
  let mrWindow: number | undefined;
  if (args.medication_reminder_enabled !== undefined && args.medication_reminder_enabled !== null) {
    const val = asBool(args.medication_reminder_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'medication_reminder_enabled должен быть true или false.' };
    }
    mrEnabled = val;
    hasChange = true;
  }
  if (args.medication_reminder_window_minutes !== undefined && args.medication_reminder_window_minutes !== null) {
    const val = parseIntArg(
      args.medication_reminder_window_minutes,
      MIN_MEDICATION_REMINDER_WINDOW_MINUTES,
      MAX_MEDICATION_REMINDER_WINDOW_MINUTES,
    );
    if (val === null) {
      return {
        ok: false,
        error: `medication_reminder_window_minutes должен быть от ${MIN_MEDICATION_REMINDER_WINDOW_MINUTES} до ${MAX_MEDICATION_REMINDER_WINDOW_MINUTES}.`,
      };
    }
    mrWindow = val;
    hasChange = true;
  }

  let ncEnabled: boolean | undefined;
  let ncHour: number | undefined;
  let ncNoteLimit: number | undefined;
  if (args.nightly_consolidation_enabled !== undefined && args.nightly_consolidation_enabled !== null) {
    const val = asBool(args.nightly_consolidation_enabled);
    if (val === null || val === undefined) {
      return { ok: false, error: 'nightly_consolidation_enabled должен быть true или false.' };
    }
    ncEnabled = val;
    hasChange = true;
  }
  if (args.nightly_consolidation_hour !== undefined && args.nightly_consolidation_hour !== null) {
    const val = parseIntArg(args.nightly_consolidation_hour, 0, 23);
    if (val === null) {
      return { ok: false, error: 'nightly_consolidation_hour должен быть целым часом от 0 до 23.' };
    }
    ncHour = val;
    hasChange = true;
    rescheduleConsolidation = true;
  }
  if (args.nightly_consolidation_note_limit !== undefined && args.nightly_consolidation_note_limit !== null) {
    const val = parseIntArg(
      args.nightly_consolidation_note_limit,
      MIN_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
      MAX_NIGHTLY_CONSOLIDATION_NOTE_LIMIT,
    );
    if (val === null) {
      return {
        ok: false,
        error: `nightly_consolidation_note_limit должен быть от ${MIN_NIGHTLY_CONSOLIDATION_NOTE_LIMIT} до ${MAX_NIGHTLY_CONSOLIDATION_NOTE_LIMIT}.`,
      };
    }
    ncNoteLimit = val;
    hasChange = true;
  }

  return {
    ok: true,
    hasChange,
    rescheduleConsolidation,
    apply(nextPrefs) {
      if (!hasChange) return;
      const pro = { ...(nextPrefs.proactive ?? {}) };
      if (qhEnabled !== undefined || qhStart !== undefined || qhEnd !== undefined) {
        const qh = { ...(pro.quietHours ?? {}) };
        if (qhEnabled !== undefined) qh.enabled = qhEnabled;
        if (qhStart !== undefined) qh.start = qhStart;
        if (qhEnd !== undefined) qh.end = qhEnd;
        pro.quietHours = qh;
      }

      if (
        mdEnabled !== undefined ||
        mdWindow !== undefined ||
        mdSections !== undefined ||
        lwEnabled !== undefined ||
        lwDays !== undefined ||
        lrEnabled !== undefined ||
        mrEnabled !== undefined ||
        mrWindow !== undefined ||
        ncEnabled !== undefined ||
        ncHour !== undefined ||
        ncNoteLimit !== undefined
      ) {
        const jobs = { ...(pro.jobs ?? {}) };
        if (mdEnabled !== undefined || mdWindow !== undefined || mdSections !== undefined) {
          const md = { ...(jobs.morning_digest ?? {}) };
          if (mdEnabled !== undefined) md.enabled = mdEnabled;
          if (mdWindow !== undefined) md.windowMinutes = mdWindow;
          if (mdSections !== undefined) {
            if (mdSections === null) delete md.sections;
            else md.sections = mdSections;
          }
          jobs.morning_digest = md;
        }
        if (lwEnabled !== undefined || lwDays !== undefined) {
          const lw = { ...(jobs.liability_warning ?? {}) };
          if (lwEnabled !== undefined) lw.enabled = lwEnabled;
          if (lwDays !== undefined) lw.daysBefore = lwDays;
          jobs.liability_warning = lw;
        }
        if (lrEnabled !== undefined) {
          jobs.liability_review = { ...(jobs.liability_review ?? {}), enabled: lrEnabled };
        }
        if (mrEnabled !== undefined || mrWindow !== undefined) {
          const mr = { ...(jobs.medication_reminder ?? {}) };
          if (mrEnabled !== undefined) mr.enabled = mrEnabled;
          if (mrWindow !== undefined) mr.windowMinutes = mrWindow;
          jobs.medication_reminder = mr;
        }
        if (ncEnabled !== undefined || ncHour !== undefined || ncNoteLimit !== undefined) {
          const nc = { ...(jobs.nightly_consolidation ?? {}) };
          if (ncEnabled !== undefined) nc.enabled = ncEnabled;
          if (ncHour !== undefined) nc.hour = ncHour;
          if (ncNoteLimit !== undefined) nc.noteLimit = ncNoteLimit;
          jobs.nightly_consolidation = nc;
        }
        pro.jobs = jobs;
      }

      nextPrefs.proactive = pro;
    },
  };
}

function parseMiniAppUpdate(args: ToolArgs): UpdatePatchResult {
  let hasChange = false;

  let nextTabs: MiniAppTabId[] | null | undefined;
  if (Object.hasOwn(args, 'miniapp_tabs') && args.miniapp_tabs !== undefined) {
    const rawStr = args.miniapp_tabs === null ? '' : String(args.miniapp_tabs).trim().toLowerCase();
    if (isResetSentinel(args.miniapp_tabs) || rawStr === 'all') {
      nextTabs = null;
    } else {
      const validSet = new Set<string>(MINIAPP_TAB_IDS);
      const seen = new Set<MiniAppTabId>();
      const parsed: MiniAppTabId[] = [];
      for (const rawTok of rawStr.split(/[\s,;|]+/).filter(Boolean)) {
        const mapped = rawTok === 'assistant' ? 'system' : rawTok;
        if (!validSet.has(mapped)) {
          return {
            ok: false,
            error: `Неизвестная вкладка Mini App «${rawTok}». Доступны: ${MINIAPP_TAB_IDS.join(', ')} (или "default").`,
          };
        }
        const typed = mapped as MiniAppTabId;
        if (!seen.has(typed)) {
          seen.add(typed);
          parsed.push(typed);
        }
      }
      if (parsed.length === 0) {
        return {
          ok: false,
          error: `Укажите хотя бы одну вкладку из: ${MINIAPP_TAB_IDS.join(', ')} (или "default").`,
        };
      }
      if (!seen.has('system')) {
        parsed.push('system');
      }
      nextTabs = parsed;
    }
    hasChange = true;
  }

  const hasPattern = Object.hasOwn(args, 'miniapp_account_pattern') && args.miniapp_account_pattern !== undefined;
  const hasTheme = Object.hasOwn(args, 'miniapp_account_theme') && args.miniapp_account_theme !== undefined;
  const hasShortName =
    Object.hasOwn(args, 'miniapp_account_short_name') && args.miniapp_account_short_name !== undefined;
  const hasRoleLabel =
    Object.hasOwn(args, 'miniapp_account_role_label') && args.miniapp_account_role_label !== undefined;

  if (!hasPattern && (hasTheme || hasShortName || hasRoleLabel)) {
    return {
      ok: false,
      error:
        'Укажите miniapp_account_pattern (имя или паттерн счёта) вместе с темой/коротким именем/ролью.',
    };
  }

  let patternTarget: string | undefined;
  let removeAccountOverride = false;
  let parsedTheme: MiniAppAccountThemeKind | null | undefined;
  let parsedShortName: string | null | undefined;
  let parsedRoleLabel: string | null | undefined;

  if (hasPattern) {
    const cleanPattern = truncate(
      String(args.miniapp_account_pattern ?? '')
        .replace(/[\r\n]+/g, ' ')
        .trim(),
      80,
    );
    if (!cleanPattern) {
      return { ok: false, error: 'miniapp_account_pattern не может быть пустым.' };
    }
    patternTarget = cleanPattern;

    if (hasTheme) {
      if (isResetSentinel(args.miniapp_account_theme)) {
        parsedTheme = null;
      } else {
        const cleanTheme = String(args.miniapp_account_theme).trim().toLowerCase();
        if (!(MINIAPP_ACCOUNT_THEMES as readonly string[]).includes(cleanTheme)) {
          return {
            ok: false,
            error: `Неизвестная тема счёта «${cleanTheme}». Доступны: ${MINIAPP_ACCOUNT_THEMES.join(', ')}.`,
          };
        }
        parsedTheme = cleanTheme as MiniAppAccountThemeKind;
      }
    }

    if (hasShortName) {
      if (isResetSentinel(args.miniapp_account_short_name)) {
        parsedShortName = null;
      } else {
        const cleanShort = truncate(
          String(args.miniapp_account_short_name).replace(/[\r\n]+/g, ' ').trim(),
          40,
        );
        parsedShortName = cleanShort || null;
      }
    }

    if (hasRoleLabel) {
      if (isResetSentinel(args.miniapp_account_role_label)) {
        parsedRoleLabel = null;
      } else {
        const cleanRole = truncate(
          String(args.miniapp_account_role_label).replace(/[\r\n]+/g, ' ').trim(),
          80,
        );
        parsedRoleLabel = cleanRole || null;
      }
    }

    const noAttrArgs = !hasTheme && !hasShortName && !hasRoleLabel;
    const allPassedAreNull =
      (!hasTheme || parsedTheme === null) &&
      (!hasShortName || parsedShortName === null) &&
      (!hasRoleLabel || parsedRoleLabel === null);
    if (noAttrArgs || allPassedAreNull) {
      removeAccountOverride = true;
    }
    hasChange = true;
  }

  return {
    ok: true,
    hasChange,
    apply(nextPrefs) {
      if (!hasChange) return;
      const miniapp = { ...(nextPrefs.miniapp ?? {}) };
      if (nextTabs !== undefined) {
        if (nextTabs === null) delete miniapp.tabs;
        else miniapp.tabs = nextTabs;
      }
      if (patternTarget !== undefined) {
        const list = [...(miniapp.accountThemes ?? [])];
        const keyLower = patternTarget.toLowerCase();
        const existingIdx = list.findIndex((item) => item.pattern.toLowerCase() === keyLower);
        if (removeAccountOverride) {
          if (existingIdx !== -1) list.splice(existingIdx, 1);
        } else {
          const base = existingIdx !== -1 ? { ...list[existingIdx]! } : { pattern: patternTarget };
          if (parsedTheme !== undefined) {
            if (parsedTheme === null) delete base.theme;
            else base.theme = parsedTheme;
          }
          if (parsedShortName !== undefined) {
            if (parsedShortName === null) delete base.shortName;
            else base.shortName = parsedShortName;
          }
          if (parsedRoleLabel !== undefined) {
            if (parsedRoleLabel === null) delete base.roleLabel;
            else base.roleLabel = parsedRoleLabel;
          }
          if (!base.theme && !base.shortName && !base.roleLabel) {
            if (existingIdx !== -1) list.splice(existingIdx, 1);
          } else if (existingIdx !== -1) {
            list[existingIdx] = base;
          } else {
            list.push(base);
          }
        }
        if (list.length === 0) delete miniapp.accountThemes;
        else miniapp.accountThemes = list.slice(0, MAX_FINANCE_ALIASES);
      }
      if (Object.keys(miniapp).length === 0) delete nextPrefs.miniapp;
      else nextPrefs.miniapp = miniapp;
    },
  };
}

async function updateSettingsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const secretArg = hasForbiddenSecretArg(args);
  if (secretArg) {
    return fail(
      `Параметр «${secretArg}» запрещён: API-ключи и секреты нельзя передавать в чат агента. Для подключения ключа используй команду /byok или вкладку «Система» в Mini App.`,
    );
  }

  const userPatch: Parameters<typeof updateUser>[1] = {};
  let hasProfileChange = false;

  if (Object.hasOwn(args, 'name') && args.name !== undefined) {
    if (
      args.name === null ||
      String(args.name).trim() === '' ||
      String(args.name).trim().toLowerCase() === 'none'
    ) {
      userPatch.name = null;
    } else {
      userPatch.name = truncate(String(args.name).trim(), 120);
    }
    hasProfileChange = true;
  }

  if (args.language !== undefined && args.language !== null) {
    const lang = String(args.language).trim().toLowerCase();
    if (!SUPPORTED_LOCALES.includes(lang as LocaleCode)) {
      return fail(`Неподдерживаемый язык «${lang}». Доступны: ${SUPPORTED_LOCALES.join(', ')}.`);
    }
    userPatch.language = lang as LocaleCode;
    hasProfileChange = true;
  }

  if (args.timezone !== undefined && args.timezone !== null) {
    const tz = String(args.timezone).trim();
    if (!tz || !isValidTimeZone(tz)) {
      return fail(
        `Некорректная таймзона «${tz}». Укажите IANA-таймзону, например Europe/Belgrade, Europe/Moscow или UTC.`,
      );
    }
    userPatch.timezone = tz;
    hasProfileChange = true;
  }

  if (args.base_currency !== undefined && args.base_currency !== null) {
    const cur = String(args.base_currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
      return fail('base_currency должна быть 3-буквенным кодом ISO-4217 (например EUR, USD, RUB).');
    }
    userPatch.baseCurrency = cur;
    hasProfileChange = true;
  }

  if (args.summary_time !== undefined && args.summary_time !== null) {
    const parsedTime = normalizeTimeHHMM(args.summary_time);
    if (!parsedTime) {
      return fail('summary_time должна быть в формате ЧЧ:ММ (например 07:30).');
    }
    userPatch.summaryTime = parsedTime;
    hasProfileChange = true;
  }

  if (args.low_stimulation_mode !== undefined && args.low_stimulation_mode !== null) {
    const calm = asBool(args.low_stimulation_mode);
    if (calm === null || calm === undefined) {
      return fail('low_stimulation_mode должен быть true или false.');
    }
    userPatch.lowStimulationMode = calm;
    hasProfileChange = true;
  }

  if (Object.hasOwn(args, 'model_provider') && args.model_provider !== undefined) {
    const rawProv = args.model_provider === null ? '' : String(args.model_provider).trim();
    if (rawProv === '' || rawProv.toLowerCase() === 'default') {
      userPatch.modelProvider = null;
      hasProfileChange = true;
    } else {
      const provider = parseProviderId(args.model_provider);
      if (!provider) {
        return fail(`Неизвестный провайдер. Поддерживаются: ${PROVIDER_IDS.join(', ')}.`);
      }
      const keyOk = await isProviderKeyAvailable(ctx.userId, provider);
      if (!keyOk) {
        return fail(
          `У провайдера «${provider}» сейчас нет доступного API-ключа (ни BYOK, ни системного). Сначала подключи ключ через /byok или Mini App.`,
        );
      }
      userPatch.modelProvider = provider;
      hasProfileChange = true;
    }
  }

  let hasBasePrefsChange = false;
  let nextAssistantName: string | null | undefined;
  if (Object.hasOwn(args, 'assistant_name') && args.assistant_name !== undefined) {
    const rawAssist = args.assistant_name === null ? '' : String(args.assistant_name).trim();
    nextAssistantName =
      rawAssist === '' || rawAssist.toLowerCase() === 'default' ? null : rawAssist;
    hasBasePrefsChange = true;
  }

  let nextPreferredModel: string | null | undefined;
  if (Object.hasOwn(args, 'preferred_model') && args.preferred_model !== undefined) {
    const rawModel = args.preferred_model === null ? '' : String(args.preferred_model).trim();
    nextPreferredModel =
      rawModel === '' || rawModel.toLowerCase() === 'default' ? null : rawModel;
    hasBasePrefsChange = true;
  }

  let nextMaxSteps: number | null | undefined;
  if (Object.hasOwn(args, 'max_steps') && args.max_steps !== undefined) {
    if (args.max_steps === null || args.max_steps === '' || args.max_steps === 0) {
      nextMaxSteps = null;
    } else {
      const parsed = asInt(args.max_steps);
      if (parsed === null || parsed < MIN_AGENT_MAX_STEPS || parsed > MAX_AGENT_MAX_STEPS) {
        return fail(
          `max_steps должен быть целым числом от ${MIN_AGENT_MAX_STEPS} до ${MAX_AGENT_MAX_STEPS} (или 0 для сброса).`,
        );
      }
      nextMaxSteps = parsed;
    }
    hasBasePrefsChange = true;
  }

  let nextTemperature: number | null | undefined;
  if (Object.hasOwn(args, 'temperature') && args.temperature !== undefined) {
    if (
      args.temperature === null ||
      args.temperature === '' ||
      String(args.temperature).trim().toLowerCase() === 'default'
    ) {
      nextTemperature = null;
    } else {
      const num =
        typeof args.temperature === 'number'
          ? args.temperature
          : Number(String(args.temperature).replace(',', '.'));
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return fail('temperature должна быть числом от 0 до 1 (или "default" для сброса).');
      }
      nextTemperature = Math.round(num * 100) / 100;
    }
    hasBasePrefsChange = true;
  }

  const adhdRes = parseAdhdUpdate(args);
  if (!adhdRes.ok) return fail(adhdRes.error);
  const finRes = parseFinanceUpdate(args);
  if (!finRes.ok) return fail(finRes.error);
  const diaryRes = parseDiaryUpdate(args);
  if (!diaryRes.ok) return fail(diaryRes.error);
  const proRes = parseProactiveUpdate(args);
  if (!proRes.ok) return fail(proRes.error);
  const miniappRes = parseMiniAppUpdate(args);
  if (!miniappRes.ok) return fail(miniappRes.error);

  const hasPrefsChange =
    hasBasePrefsChange ||
    adhdRes.hasChange ||
    finRes.hasChange ||
    diaryRes.hasChange ||
    proRes.hasChange ||
    miniappRes.hasChange;

  if (!hasProfileChange && !hasPrefsChange) {
    return fail('Не передано ни одной настройки для обновления.');
  }

  try {
    const before = await captureSettingsState(ctx.userId);
    const nextPrefs: UserPrefs = JSON.parse(JSON.stringify(before.prefs)) as UserPrefs;

    if (nextAssistantName !== undefined) {
      if (nextAssistantName === null) delete nextPrefs.assistantName;
      else nextPrefs.assistantName = nextAssistantName;
    }
    if (nextPreferredModel !== undefined || nextMaxSteps !== undefined || nextTemperature !== undefined) {
      const ai = { ...(nextPrefs.ai ?? {}) };
      if (nextPreferredModel !== undefined) {
        if (nextPreferredModel === null) delete ai.preferredModel;
        else ai.preferredModel = nextPreferredModel;
      }
      if (nextMaxSteps !== undefined) {
        if (nextMaxSteps === null) delete ai.maxSteps;
        else ai.maxSteps = nextMaxSteps;
      }
      if (nextTemperature !== undefined) {
        if (nextTemperature === null) delete ai.temperature;
        else ai.temperature = nextTemperature;
      }
      nextPrefs.ai = ai;
    }

    adhdRes.apply(nextPrefs);
    finRes.apply(nextPrefs);
    diaryRes.apply(nextPrefs);
    proRes.apply(nextPrefs);
    miniappRes.apply(nextPrefs);

    // Проверка согласованности границ окон до сохранения снимка
    const nightStart =
      nextPrefs.adhd?.overloadShield?.nightStartHour ?? DEFAULT_OVERLOAD_NIGHT_START_HOUR;
    const nightEnd =
      nextPrefs.adhd?.overloadShield?.nightEndHour ?? DEFAULT_OVERLOAD_NIGHT_END_HOUR;
    if (adhdRes.hasChange && nightStart === nightEnd) {
      return fail('Час начала и час окончания ночного окна СДВГ-щита не могут совпадать.');
    }

    const qh = nextPrefs.proactive?.quietHours;
    if (proRes.hasChange && qh?.enabled === true && (qh.start ?? '23:00') === (qh.end ?? '07:00')) {
      return fail('Время начала и окончания тихих часов не может совпадать.');
    }

    await pushPrefsSnapshot(ctx.userId, 'Обновление настроек', before);

    if (hasProfileChange) {
      await ensureUser(ctx.userId);
      await updateUser(ctx.userId, userPatch);
    }

    if (hasPrefsChange) {
      await saveUserPrefs(ctx.userId, nextPrefs);
    }

    if (proRes.rescheduleConsolidation) {
      await scheduleNightlyConsolidation(ctx.userId).catch(() => {});
    }

    const after = await captureSettingsState(ctx.userId);
    const diff = formatSettingsDiff(before, after);
    return {
      ok: true,
      content: `✅ Настройки обновлены:\n${diff}\n\n_Если нужно вернуть как было — скажи «откати настройку»._`,
      data: { before, after, diff },
    };
  } catch (error) {
    return fail(`Не удалось обновить настройки: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 3. reset_or_rollback_settings
// ---------------------------------------------------------------------------

async function resetOrRollbackSettingsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (action !== 'rollback' && action !== 'reset') {
    return fail('Укажите action: "rollback" (откат) или "reset" (сброс к дефолту).');
  }

  try {
    if (action === 'rollback') {
      const steps =
        args.steps === undefined || args.steps === null ? 1 : asInt(args.steps);
      if (steps === null || steps < 1 || steps > 10) {
        return fail('steps должен быть целым числом от 1 до 10.');
      }
      const res = await rollbackSettings(ctx.userId, steps);
      if (!res.ok) return fail(res.error ?? 'Не удалось откатить настройки.');
      if (
        res.after.prefs.proactive?.jobs?.nightly_consolidation?.hour !==
        res.before.prefs.proactive?.jobs?.nightly_consolidation?.hour
      ) {
        await scheduleNightlyConsolidation(ctx.userId).catch(() => {});
      }
      const diff = formatSettingsDiff(res.before, res.after);
      return {
        ok: true,
        content: `↩️ Откатил настройки (${res.restoredSummary ?? 'последнее изменение'}):\n${diff}\n\nОсталось шагов в истории: ${res.remainingHistory}.`,
        data: {
          action: 'rollback',
          restored_summary: res.restoredSummary,
          remaining_history: res.remainingHistory,
          diff,
        },
      };
    }

    const sectionRaw = (asText(args.section)?.toLowerCase() ?? 'all') as ResetSection;
    if (!VALID_RESET_SECTIONS.has(sectionRaw)) {
      return fail(
        `Неизвестная секция «${sectionRaw}». Доступны: ${[...VALID_RESET_SECTIONS].join(', ')}.`,
      );
    }
    const res = await resetSettingsSection(ctx.userId, sectionRaw);
    if (sectionRaw === 'proactive' || sectionRaw === 'all') {
      await scheduleNightlyConsolidation(ctx.userId).catch(() => {});
    }
    const diff = formatSettingsDiff(res.stateBefore, res.stateAfter);
    return {
      ok: true,
      content: `🧹 Сбросил секцию «${sectionRaw}» к значениям по умолчанию:\n${diff}\n\n_Снимок до сброса сохранён — при необходимости можно откатить._`,
      data: { action: 'reset', section: sectionRaw, diff },
    };
  } catch (error) {
    return fail(`Ошибка при откате/сбросе настроек: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. manage_presets
// ---------------------------------------------------------------------------

function findPreset(
  presets: Record<string, SettingsPreset>,
  rawQuery: string,
): SettingsPreset | null {
  const slug = normalizeConfigSlug(rawQuery);
  if (slug && Object.hasOwn(presets, slug)) return presets[slug]!;
  const needle = rawQuery.trim().toLowerCase();
  return (
    Object.values(presets).find(
      (p) => p.id.toLowerCase() === needle || p.name.trim().toLowerCase() === needle,
    ) ?? null
  );
}

async function managePresetsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['list', 'save', 'apply', 'delete'].includes(action)) {
    return fail('Укажите action: "list", "save", "apply" или "delete".');
  }

  try {
    const state = await captureSettingsState(ctx.userId);
    const presets = { ...(state.prefs.presets ?? {}) };

    if (action === 'list') {
      const list = Object.values(presets);
      if (list.length === 0) {
        return {
          ok: true,
          content: 'Сохранённых пресетов пока нет. Можешь сохранить текущие настройки как пресет (например «Фокус-спринт»).',
          data: { presets: [] },
        };
      }
      const lines = ['🎛️ **Сохранённые пресеты режимов:**'];
      for (const p of list) {
        const desc = p.description ? ` — ${p.description}` : '';
        lines.push(`• **${p.name}** (\`${p.id}\`)${desc}`);
      }
      return { ok: true, content: lines.join('\n'), data: { presets: list } };
    }

    const nameOrId = asText(args.name) ?? asText(args.id);
    if (!nameOrId) return fail('Укажите название или id пресета (name / id).');

    if (action === 'save') {
      const existing = findPreset(presets, nameOrId);
      const rawId = asText(args.id) ?? existing?.id ?? nameOrId;
      const id = slugFromTitle(rawId) || existing?.id || `preset_${Date.now()}`;
      const name = truncate(asText(args.name) ?? existing?.name ?? id, 80);
      const description = asText(args.description) ?? undefined;

      await pushPrefsSnapshot(ctx.userId, `Сохранение пресета «${name}»`, state);
      const entry: SettingsPreset = {
        id,
        name,
        ...(description ? { description: truncate(description, 240) } : {}),
        snapshot: buildPresetPayloadFromState(state),
        updatedAt: nowIso(),
      };
      presets[id] = entry;
      await saveUserPrefs(ctx.userId, { ...state.prefs, presets });
      return {
        ok: true,
        content: `💾 Пресет **«${entry.name}»** (\`${entry.id}\`) сохранён на основе текущих настроек.`,
        data: { preset: entry },
      };
    }

    const found = findPreset(presets, nameOrId);
    if (!found) {
      return fail(`Пресет «${nameOrId}» не найден.`);
    }

    if (action === 'apply') {
      const presetProvider = found.snapshot.profile?.modelProvider;
      if (presetProvider) {
        const keyOk = await isProviderKeyAvailable(ctx.userId, presetProvider);
        if (!keyOk) {
          return fail(
            `Пресет «${found.name}» использует провайдер «${presetProvider}», но у него нет доступного API-ключа. Сначала подключи ключ через /byok или Mini App.`,
          );
        }
      }
      await pushPrefsSnapshot(ctx.userId, `Применение пресета «${found.name}»`, state);
      const nextState = applyPresetPayloadToState(state, found.snapshot);
      await applySettingsState(ctx.userId, nextState);
      const after = await captureSettingsState(ctx.userId);
      if (
        after.prefs.proactive?.jobs?.nightly_consolidation?.hour !==
        state.prefs.proactive?.jobs?.nightly_consolidation?.hour
      ) {
        await scheduleNightlyConsolidation(ctx.userId).catch(() => {});
      }
      const diff = formatSettingsDiff(state, after);
      return {
        ok: true,
        content: `🎛️ Применил пресет **«${found.name}»**:\n${diff}`,
        data: { preset: found, diff },
      };
    }

    // delete
    await pushPrefsSnapshot(ctx.userId, `Удаление пресета «${found.name}»`, state);
    delete presets[found.id];
    await saveUserPrefs(ctx.userId, { ...state.prefs, presets });
    return {
      ok: true,
      content: `🗑️ Пресет **«${found.name}»** (\`${found.id}\`) удалён.`,
      data: { deleted_id: found.id },
    };
  } catch (error) {
    return fail(`Ошибка при работе с пресетами: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 4b. manage_routines
// ---------------------------------------------------------------------------

const VALID_ROUTINE_KINDS = new Set<RoutineKind>(['text', 'summary', 'ai']);
const VALID_ROUTINE_SCHEDULES = new Set<RoutineScheduleType>(['daily', 'weekly', 'monthly']);
const VALID_SUMMARY_KINDS = new Set<RoutineSummaryKind>([
  'quick',
  'balance',
  'debts',
  'tasks',
  'meds',
  'digest',
]);

function findRoutine(
  routines: Record<string, CustomRoutine>,
  rawQuery: string,
): CustomRoutine | null {
  const slug = normalizeConfigSlug(rawQuery);
  if (slug && Object.hasOwn(routines, slug)) return routines[slug]!;
  const needle = rawQuery.trim().toLowerCase();
  return (
    Object.values(routines).find(
      (r) => r.id.toLowerCase() === needle || r.name.trim().toLowerCase() === needle,
    ) ?? null
  );
}

function formatRoutineLine(r: CustomRoutine): string {
  const sched =
    r.schedule === 'weekly'
      ? `еженедельно [${(r.weekdays ?? []).join(',')}]`
      : r.schedule === 'monthly'
        ? `ежемесячно [${r.dayOfMonth ?? 1}-е]`
        : 'ежедневно';
  const details =
    r.kind === 'ai'
      ? `AI (${r.toolAccess ?? 'read-only'})`
      : r.kind === 'summary'
        ? `сводка (${r.summaryKind ?? 'quick'})`
        : 'текст';
  const qh = r.respectQuietHours === false ? ', игнорирует тихие часы' : '';
  return `• \`${r.id}\` **${r.name}** — ${r.enabled ? 'вкл' : 'пауза'} · ${details} · ${sched} в ${r.time} (окно ${r.windowMinutes ?? DEFAULT_ROUTINE_WINDOW_MINUTES} мин${qh})`;
}

async function renderRoutinePreviewContent(
  userId: number,
  routine: CustomRoutine,
  now: Date,
): Promise<string> {
  if (routine.kind === 'text') {
    return `⏰ **[Предпросмотр] ${routine.name}**\n\n${routine.message ?? ''}`.trim();
  }
  if (routine.kind === 'summary') {
    let body: string;
    switch (routine.summaryKind) {
      case 'balance':
        body = await balanceSummary(userId, { now });
        break;
      case 'debts':
        body = await debtsSummary(userId, { now });
        break;
      case 'tasks':
        body = await tasksSummary(userId, { now });
        break;
      case 'meds':
        body = await medsSummary(userId, { now });
        break;
      case 'digest':
        body = await buildMorningDigest(userId, { now });
        break;
      case 'quick':
      default:
        body = await quickSummary(userId, { now });
        break;
    }
    return `⏰ **[Предпросмотр] ${routine.name}**\n\n${body}`;
  }

  const access = routine.toolAccess === 'allow_writes'
    ? 'allow_writes (чтение + запись, destroy-инструменты и самомодификация рутин заблокированы)'
    : 'read-only (только чтение, без побочных эффектов)';
  return [
    `🤖 **[Dry-preview AI-рутины] ${routine.name}** (\`${routine.id}\`)`,
    `• Расписание: ${routine.schedule} в ${routine.time} (окно ${routine.windowMinutes ?? DEFAULT_ROUTINE_WINDOW_MINUTES} мин)`,
    `• Права инструментов: ${access}`,
    '• Ограничения фона: store=null, maxSteps=4, turnBudgetMs=12000, не запускается на rpc, максимум 1 AI-рутина на touch-проход',
    `• Промпт: ${routine.prompt ?? '(пусто)'}`,
  ].join('\n');
}

async function manageRoutinesTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['list', 'upsert', 'pause', 'resume', 'delete', 'preview'].includes(action)) {
    return fail('Укажите action: "list", "upsert", "pause", "resume", "delete" или "preview".');
  }

  try {
    const state = await captureSettingsState(ctx.userId);
    const routines: Record<string, CustomRoutine> = {
      ...(state.prefs.proactive?.routines ?? {}),
    };

    if (action === 'list') {
      const list = Object.values(routines).sort(
        (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
      );
      const activeAiCount = countActiveAiRoutines(routines);
      if (list.length === 0) {
        return {
          ok: true,
          content: `Кастомных рутин пока нет (лимит: ${MAX_CUSTOM_ROUTINES}, активных AI-рутин: 0/${MAX_ACTIVE_AI_ROUTINES}).`,
          data: { routines: [], active_ai_routines: 0 },
        };
      }
      const lines = [
        `⏱ **Кастомные регулярные рутины (${list.length}/${MAX_CUSTOM_ROUTINES}, активных AI: ${activeAiCount}/${MAX_ACTIVE_AI_ROUTINES}):**`,
        ...list.map(formatRoutineLine),
      ];
      return {
        ok: true,
        content: lines.join('\n'),
        data: { routines: list, active_ai_routines: activeAiCount },
      };
    }

    if (action === 'upsert') {
      const rawId = asText(args.id);
      const rawName = asText(args.name);
      const lookup = rawId ?? rawName;
      const existing = lookup ? findRoutine(routines, lookup) : null;

      if (!existing && Object.keys(routines).length >= MAX_CUSTOM_ROUTINES) {
        return fail(`Достигнут лимит кастомных рутин (${MAX_CUSTOM_ROUTINES}). Удалите старую перед добавлением новой.`);
      }

      const id = existing?.id || slugFromTitle(rawId ?? rawName ?? '') || `routine_${Date.now()}`;
      if (!id) {
        return fail('Укажите корректный id или название (name) рутины.');
      }

      const nextKindRaw = asText(args.kind)?.toLowerCase() ?? existing?.kind ?? '';
      if (!VALID_ROUTINE_KINDS.has(nextKindRaw as RoutineKind)) {
        return fail('Укажите kind: "text", "summary" или "ai".');
      }
      const kind = nextKindRaw as RoutineKind;

      // Защита от обхода confirmWhen: при редактировании AI-рутины с allow_writes без явного tool_access (в т.ч. null) отклоняем изменение.
      if (
        existing &&
        existing.kind === 'ai' &&
        existing.toolAccess === 'allow_writes' &&
        kind === 'ai' &&
        (args.tool_access === undefined || args.tool_access === null)
      ) {
        return fail(
          'Эта AI-рутина имеет права записи (allow_writes). При изменении явно укажите tool_access: "allow_writes" (потребует подтверждения) или "read-only".',
        );
      }

      const name = truncate(rawName ?? existing?.name ?? id, 80);
      if (!name) return fail('Укажите название рутины (name).');

      const scheduleRaw = asText(args.schedule)?.toLowerCase() ?? existing?.schedule ?? '';
      if (!VALID_ROUTINE_SCHEDULES.has(scheduleRaw as RoutineScheduleType)) {
        return fail('Укажите schedule: "daily", "weekly" или "monthly".');
      }
      const schedule = scheduleRaw as RoutineScheduleType;

      const timeInput = args.time !== undefined ? args.time : existing?.time;
      const time = normalizeTimeHHMM(timeInput);
      if (!time) {
        return fail('Укажите time в формате ЧЧ:ММ (например 20:30).');
      }

      let weekdays: number[] | undefined;
      if (schedule === 'weekly') {
        if (args.weekdays !== undefined && args.weekdays !== null) {
          const parsedDays = Array.isArray(args.weekdays)
            ? parseWeekdaysInput(args.weekdays.join(','))
            : parseWeekdaysInput(String(args.weekdays));
          if (!parsedDays) {
            return fail('Некорректные дни недели (weekdays). Примеры: "пн, ср, пт", "будни", "0,2,4".');
          }
          weekdays = parsedDays;
        } else if (existing?.schedule === 'weekly' && existing.weekdays && existing.weekdays.length > 0) {
          weekdays = existing.weekdays;
        } else {
          return fail('Для weekly-рутины укажите weekdays (например "пн, ср, пт" или "будни").');
        }
      }

      let dayOfMonth: number | undefined;
      if (schedule === 'monthly') {
        if (args.day_of_month !== undefined && args.day_of_month !== null) {
          const dom = parseIntArg(args.day_of_month, 1, 31);
          if (dom === null) {
            return fail('day_of_month должен быть целым числом от 1 до 31.');
          }
          dayOfMonth = dom;
        } else {
          dayOfMonth = existing?.dayOfMonth ?? 1;
        }
      }

      let windowMinutes = existing?.windowMinutes ?? DEFAULT_ROUTINE_WINDOW_MINUTES;
      if (args.window_minutes !== undefined && args.window_minutes !== null) {
        const win = parseIntArg(
          args.window_minutes,
          MIN_ROUTINE_WINDOW_MINUTES,
          MAX_ROUTINE_WINDOW_MINUTES,
        );
        if (win === null) {
          return fail(
            `window_minutes должен быть от ${MIN_ROUTINE_WINDOW_MINUTES} до ${MAX_ROUTINE_WINDOW_MINUTES} минут.`,
          );
        }
        windowMinutes = win;
      }

      let enabled = existing ? existing.enabled : true;
      if (args.enabled !== undefined && args.enabled !== null) {
        const parsedEnabled = asBool(args.enabled);
        if (parsedEnabled === null || parsedEnabled === undefined) {
          return fail('enabled должен быть true или false.');
        }
        enabled = parsedEnabled;
      }

      let respectQuietHours = existing ? existing.respectQuietHours !== false : true;
      if (args.respect_quiet_hours !== undefined && args.respect_quiet_hours !== null) {
        const parsedQh = asBool(args.respect_quiet_hours);
        if (parsedQh === null || parsedQh === undefined) {
          return fail('respect_quiet_hours должен быть true или false.');
        }
        respectQuietHours = parsedQh;
      }

      let message: string | undefined;
      let summaryKind: RoutineSummaryKind | undefined;
      let prompt: string | undefined;
      let toolAccess: RoutineToolAccess | undefined;

      if (kind === 'text') {
        const msg = truncate(
          (asText(args.message) ?? (existing?.kind === 'text' ? existing.message : '') ?? '').trim(),
          1500,
        );
        if (!msg) return fail('Для text-рутины укажите непустой message.');
        message = msg;
      } else if (kind === 'summary') {
        const skRaw =
          asText(args.summary_kind)?.toLowerCase() ??
          (existing?.kind === 'summary' ? existing.summaryKind : undefined) ??
          '';
        if (!VALID_SUMMARY_KINDS.has(skRaw as RoutineSummaryKind)) {
          return fail('Для summary-рутины укажите summary_kind: quick, balance, debts, tasks, meds или digest.');
        }
        summaryKind = skRaw as RoutineSummaryKind;
      } else {
        const p = truncate(
          (asText(args.prompt) ?? (existing?.kind === 'ai' ? existing.prompt : '') ?? '').trim(),
          1500,
        );
        if (!p) return fail('Для ai-рутины укажите непустой prompt.');
        prompt = p;
        if (args.tool_access !== undefined && args.tool_access !== null) {
          const taRaw = String(args.tool_access).trim().toLowerCase();
          if (taRaw !== 'read-only' && taRaw !== 'allow_writes') {
            return fail('tool_access может быть только "read-only" или "allow_writes".');
          }
          toolAccess = taRaw;
        } else {
          toolAccess = existing?.kind === 'ai' ? (existing.toolAccess ?? 'read-only') : 'read-only';
        }
      }

      const candidate: CustomRoutine = {
        id,
        name,
        enabled,
        kind,
        schedule,
        time,
        ...(weekdays ? { weekdays } : {}),
        ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
        ...(windowMinutes !== DEFAULT_ROUTINE_WINDOW_MINUTES ? { windowMinutes } : {}),
        ...(message ? { message } : {}),
        ...(summaryKind ? { summaryKind } : {}),
        ...(prompt ? { prompt } : {}),
        ...(toolAccess ? { toolAccess } : {}),
        ...(respectQuietHours ? {} : { respectQuietHours: false }),
        updatedAt: nowIso(),
      };

      const nextRoutines = { ...routines, [id]: candidate };
      if (countActiveAiRoutines(nextRoutines) > MAX_ACTIVE_AI_ROUTINES) {
        return fail(
          `Нельзя держать больше ${MAX_ACTIVE_AI_ROUTINES} активных AI-рутин одновременно. Поставьте на паузу или удалите одну из существующих.`,
        );
      }

      await pushPrefsSnapshot(ctx.userId, `${existing ? 'Обновление' : 'Создание'} рутины «${name}»`, state);
      const nextProactive = { ...(state.prefs.proactive ?? {}), routines: nextRoutines };
      await saveUserPrefs(ctx.userId, { ...state.prefs, proactive: nextProactive });
      const after = await captureSettingsState(ctx.userId);
      const diff = formatSettingsDiff(state, after);
      return {
        ok: true,
        content: `✅ Рутина **«${candidate.name}»** (\`${candidate.id}\`) сохранена:\n${diff}`,
        data: { routine: candidate, diff },
      };
    }

    const query = asText(args.id) ?? asText(args.name);
    if (!query) return fail('Укажите id или название (name) рутины.');
    const found = findRoutine(routines, query);
    if (!found) return fail(`Рутина «${query}» не найдена.`);

    if (action === 'preview') {
      const content = await renderRoutinePreviewContent(ctx.userId, found, ctx.now);
      return {
        ok: true,
        content,
        data: { routine: found, preview: true },
      };
    }

    if (action === 'pause' || action === 'resume') {
      const enable = action === 'resume';
      if (
        enable &&
        found.kind === 'ai' &&
        !found.enabled &&
        countActiveAiRoutines(routines) >= MAX_ACTIVE_AI_ROUTINES
      ) {
        return fail(
          `Достигнут лимит активных AI-рутин (${MAX_ACTIVE_AI_ROUTINES}). Поставьте на паузу или удалите другую AI-рутину.`,
        );
      }
      await pushPrefsSnapshot(
        ctx.userId,
        `${enable ? 'Возобновление' : 'Пауза'} рутины «${found.name}»`,
        state,
      );
      const nextRoutines: Record<string, CustomRoutine> = {
        ...routines,
        [found.id]: { ...found, enabled: enable, updatedAt: nowIso() },
      };
      const nextProactive = { ...(state.prefs.proactive ?? {}), routines: nextRoutines };
      await saveUserPrefs(ctx.userId, { ...state.prefs, proactive: nextProactive });
      const after = await captureSettingsState(ctx.userId);
      const diff = formatSettingsDiff(state, after);
      return {
        ok: true,
        content: `${enable ? '▶️ Возобновил' : '⏸ Поставил на паузу'} рутину **«${found.name}»**:\n${diff}`,
        data: { routine: nextRoutines[found.id], diff },
      };
    }

    // delete
    await pushPrefsSnapshot(ctx.userId, `Удаление рутины «${found.name}»`, state);
    const nextRoutines = { ...routines };
    delete nextRoutines[found.id];
    const nextProactive = { ...(state.prefs.proactive ?? {}) };
    if (Object.keys(nextRoutines).length === 0) {
      delete nextProactive.routines;
    } else {
      nextProactive.routines = nextRoutines;
    }
    const nextPrefs = { ...state.prefs };
    if (Object.keys(nextProactive).length === 0) {
      delete nextPrefs.proactive;
    } else {
      nextPrefs.proactive = nextProactive;
    }
    await saveUserPrefs(ctx.userId, nextPrefs);
    const after = await captureSettingsState(ctx.userId);
    const diff = formatSettingsDiff(state, after);
    return {
      ok: true,
      content: `🗑️ Рутина **«${found.name}»** (\`${found.id}\`) удалена:\n${diff}`,
      data: { deleted_id: found.id, diff },
    };
  } catch (error) {
    return fail(`Ошибка при работе с рутинами: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 5. manage_rules
// ---------------------------------------------------------------------------

async function manageRulesTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['list', 'add', 'edit', 'remove'].includes(action)) {
    return fail('Укажите action: "list", "add", "edit" или "remove".');
  }

  try {
    if (action === 'list') {
      const [rules, chapter] = await Promise.all([
        listLearnedRules(ctx.userId),
        getChapter(ctx.userId, CUSTOM_INSTRUCTIONS_SLUG),
      ]);
      const style = splitDirectives(chapter?.content ?? '').style ?? 'mentor';
      if (rules.length === 0) {
        return {
          ok: true,
          content: `Персональных правил (/learn) пока нет (текущий стиль: ${style}).`,
          data: { rules: [], style },
        };
      }
      const lines = [`📌 **Персональные правила (/learn, стиль: ${style}):**`];
      rules.forEach((rule, idx) => lines.push(`${idx + 1}. ${rule}`));
      return { ok: true, content: lines.join('\n'), data: { rules, style } };
    }

    if (action === 'add') {
      const rule = asText(args.rule);
      if (!rule) return fail('Укажите текст правила (rule).');
      const before = await captureSettingsState(ctx.userId);
      const res = await rememberRule(ctx.userId, rule);
      if (res.added) {
        await pushPrefsSnapshot(ctx.userId, `Добавлено правило /learn`, before);
      }
      return {
        ok: true,
        content: res.added
          ? `📌 Запомнил правило: «${res.rule}» (всего правил: ${res.count}).`
          : `📌 Такое правило уже есть: «${res.rule}» (всего правил: ${res.count}).`,
        data: { ...res },
      };
    }

    const index = args.index !== undefined ? asInt(args.index) ?? undefined : undefined;
    const match = asText(args.match) ?? undefined;
    const before = await captureSettingsState(ctx.userId);

    if (action === 'edit') {
      const newRule = asText(args.new_rule) ?? asText(args.rule);
      if (!newRule) return fail('Укажите новый текст правила (new_rule).');
      const res = await editRule(ctx.userId, { index, match }, newRule);
      if (!res.ok) return fail(res.error ?? 'Не удалось изменить правило.');
      await pushPrefsSnapshot(ctx.userId, `Правка правила /learn`, before);
      return {
        ok: true,
        content: `✏️ Правило обновлено:\n• Было: «${res.previous}»\n• Стало: «${res.rule}»`,
        data: { ...res },
      };
    }

    // remove
    const res = await removeRule(ctx.userId, { index, match });
    if (!res.ok) return fail(res.error ?? 'Не удалось удалить правило.');
    await pushPrefsSnapshot(ctx.userId, `Удаление правила /learn`, before);
    return {
      ok: true,
      content: `🗑️ Удалил правило: «${res.removed}» (осталось правил: ${res.count}).`,
      data: { ...res },
    };
  } catch (error) {
    return fail(`Ошибка при управлении правилами: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 6. manage_personas
// ---------------------------------------------------------------------------

async function managePersonasTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['list', 'switch', 'upsert', 'delete'].includes(action)) {
    return fail('Укажите action: "list", "switch", "upsert" или "delete".');
  }

  try {
    const state = await captureSettingsState(ctx.userId);
    const activeId = state.directives.style ?? 'mentor';
    const customMap = { ...(state.prefs.brain?.customPersonas ?? {}) };
    const locale = state.profile.language;

    if (action === 'list') {
      const lines = [`🎭 **Стили и персоны (активна: \`${activeId}\`):**`, '', 'Встроенные:'];
      for (const id of BUILTIN_PERSONA_IDS) {
        const mark = activeId === id ? ' ✅' : '';
        const desc = getPersonaStyleText(id, locale) ?? id;
        lines.push(`• \`${id}\`${mark}: ${desc}`);
      }
      const customs = Object.values(customMap);
      lines.push('', `Кастомные (${customs.length}):`);
      if (customs.length === 0) {
        lines.push('— пока не созданы');
      } else {
        for (const p of customs) {
          const mark = activeId === p.id ? ' ✅' : '';
          lines.push(`• \`${p.id}\` (${p.name})${mark}: ${p.description}`);
        }
      }
      return {
        ok: true,
        content: lines.join('\n'),
        data: { active: activeId, builtin: [...BUILTIN_PERSONA_IDS], custom: customs },
      };
    }

    const rawId = asText(args.id) ?? asText(args.name);
    if (!rawId) return fail('Укажите id или название персоны.');

    if (action === 'switch') {
      const needle = rawId.trim().toLowerCase();
      let resolvedId: string | null = null;
      if (BUILTIN_PERSONA_IDS.includes(needle)) {
        resolvedId = needle;
      } else if (Object.hasOwn(customMap, needle)) {
        resolvedId = needle;
      } else {
        const byName = Object.values(customMap).find(
          (p) => p.name.trim().toLowerCase() === needle,
        );
        if (byName) resolvedId = byName.id;
      }

      if (!resolvedId) {
        return fail(
          `Персона «${rawId}» не найдена. Встроенные: ${BUILTIN_PERSONA_IDS.join(', ')}; кастомные: ${Object.keys(customMap).join(', ') || 'нет'}.`,
        );
      }

      await pushPrefsSnapshot(ctx.userId, `Смена персоны на ${resolvedId}`, state);
      await setPersonaStyle(ctx.userId, resolvedId);
      return {
        ok: true,
        content: `🎭 Персона переключена: \`${activeId}\` → \`${resolvedId}\`.`,
        data: { previous: activeId, active: resolvedId },
      };
    }

    if (action === 'upsert') {
      const id = normalizeConfigSlug(asText(args.id) ?? rawId);
      if (!id) return fail('Укажите id персоны латиницей (например, deep_architect).');
      if (BUILTIN_PERSONA_IDS.includes(id)) {
        return fail(`Встроенную персону «${id}» нельзя перезаписать. Выбери другое имя/id.`);
      }
      const name = truncate(asText(args.name) ?? id, 80);
      const instructions = asText(args.instructions);
      if (!instructions) return fail('Укажите инструкции стиля для персоны (instructions).');
      const description = truncate(asText(args.description) ?? name, 240);
      const activate = asBool(args.activate) === true;

      await pushPrefsSnapshot(ctx.userId, `Сохранение персоны «${name}»`, state);
      const persona: CustomPersona = {
        id,
        name,
        description,
        instructions: truncate(instructions, 2000),
        updatedAt: nowIso(),
      };
      customMap[id] = persona;
      await saveUserPrefs(ctx.userId, {
        ...state.prefs,
        brain: { ...(state.prefs.brain ?? {}), customPersonas: customMap },
      });
      if (activate) {
        await setPersonaStyle(ctx.userId, id);
      }
      return {
        ok: true,
        content: `🎭 Кастомная персона **«${persona.name}»** (\`${persona.id}\`) сохранена${activate ? ' и активирована' : ''}.`,
        data: { persona, activated: activate },
      };
    }

    // delete
    const needle = normalizeConfigSlug(rawId);
    if (BUILTIN_PERSONA_IDS.includes(needle) || BUILTIN_PERSONA_IDS.includes(rawId.toLowerCase())) {
      return fail('Встроенные 4 персоны нельзя удалить.');
    }
    const target =
      (needle && Object.hasOwn(customMap, needle) ? customMap[needle] : undefined) ??
      Object.values(customMap).find((p) => p.name.trim().toLowerCase() === rawId.toLowerCase());
    if (!target) return fail(`Кастомная персона «${rawId}» не найдена.`);

    await pushPrefsSnapshot(ctx.userId, `Удаление персоны «${target.name}»`, state);
    delete customMap[target.id];
    await saveUserPrefs(ctx.userId, {
      ...state.prefs,
      brain: { ...(state.prefs.brain ?? {}), customPersonas: customMap },
    });
    if (activeId === target.id) {
      await setPersonaStyle(ctx.userId, 'mentor');
    }
    return {
      ok: true,
      content: `🗑️ Кастомная персона **«${target.name}»** (\`${target.id}\`) удалена.${activeId === target.id ? ' Активный стиль возвращён к mentor.' : ''}`,
      data: { deleted_id: target.id },
    };
  } catch (error) {
    return fail(`Ошибка при работе с персонами: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 7. manage_skills
// ---------------------------------------------------------------------------

async function resolveUserSkillId(
  userId: number,
  rawIdOrKey: unknown,
  preferredStatuses: readonly EvolutionStatus[],
): Promise<number | null> {
  const numeric = asInt(rawIdOrKey);
  if (numeric !== null && numeric > 0) return numeric;
  const key = asText(rawIdOrKey)?.toLowerCase();
  if (!key) return null;
  const all = await listAllUserSkills(userId);
  for (const status of preferredStatuses) {
    const match = all.find(
      (entry) => entry.row.status === status && entry.spec?.key.toLowerCase() === key,
    );
    if (match) return match.row.id;
  }
  const fallback = all.find((entry) => entry.spec?.key.toLowerCase() === key);
  return fallback ? fallback.row.id : null;
}

async function manageSkillsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['activate', 'disable', 'reject', 'update', 'toggle_builtin'].includes(action)) {
    return fail('Укажите action: "activate", "disable", "reject", "update" или "toggle_builtin".');
  }

  try {
    if (action === 'activate') {
      const id = await resolveUserSkillId(ctx.userId, args.skill_id ?? args.key, [
        'pending',
        'disabled',
        'superseded',
      ]);
      if (!id) return fail('Укажите существующий skill_id (или ключ скилла).');
      const res = await activateSkill(ctx.userId, id);
      if (!res.ok) return fail(res.error);
      return {
        ok: true,
        content: `✅ Скилл #${id} (${res.item.title ?? ''}) активирован и добавлен в библиотеку процедур.`,
        data: { skill_id: id, status: res.item.status },
      };
    }

    if (action === 'disable') {
      const id = await resolveUserSkillId(ctx.userId, args.skill_id ?? args.key, ['active']);
      if (!id) return fail('Укажите skill_id активного скилла.');
      const res = await disableSkill(ctx.userId, id);
      if (!res.ok) return fail(res.error);
      return {
        ok: true,
        content: `⏸️ Скилл #${id} временно отключён (его можно включить обратно через activate).`,
        data: { skill_id: id, status: res.item.status },
      };
    }

    if (action === 'reject') {
      const id = await resolveUserSkillId(ctx.userId, args.skill_id ?? args.key, [
        'pending',
        'active',
        'disabled',
      ]);
      if (!id) return fail('Укажите skill_id скилла для отклонения.');
      const res = await rejectSkill(ctx.userId, id);
      if (!res.ok) return fail(res.error);
      return {
        ok: true,
        content: `🗑️ Скилл #${id} отклонён.`,
        data: { skill_id: id, status: res.item.status },
      };
    }

    if (action === 'update') {
      const key = asText(args.key);
      const title = asText(args.title);
      const whenToUse = asText(args.when_to_use);
      const procedure = asText(args.procedure);
      if (!key || !title || !whenToUse || !procedure) {
        return fail('Для update нужны key, title, when_to_use и procedure.');
      }
      const draft = await createManualSkillDraft(ctx.userId, {
        key,
        title,
        whenToUse,
        procedure,
        pitfalls: asText(args.pitfalls) ?? undefined,
        verification: asText(args.verification) ?? undefined,
      });
      if (!draft.ok) return fail(draft.error);

      const activateNow = asBool(args.activate_now) === true;
      if (activateNow) {
        const activated = await activateSkill(ctx.userId, draft.item.id);
        if (!activated.ok) {
          return fail(`Ревизия #${draft.item.id} создана, но активация не удалась: ${activated.error}`);
        }
        return {
          ok: true,
          content: `✅ Скилл ${draft.spec.key} v${draft.spec.version} (#${draft.item.id}) обновлён и активирован.`,
          data: { skill_id: draft.item.id, key: draft.spec.key, version: draft.spec.version, status: 'active' },
        };
      }

      return {
        ok: true,
        content: `📝 Черновик/ревизия скилла ${draft.spec.key} v${draft.spec.version} (#${draft.item.id}) сохранена в статусе pending.`,
        data: { skill_id: draft.item.id, key: draft.spec.key, version: draft.spec.version, status: 'pending' },
      };
    }

    // toggle_builtin
    const builtinId = asText(args.builtin_id) ?? asText(args.key);
    if (!builtinId) return fail('Укажите builtin_id встроенного .md-скилла.');
    const found = findOverlaySkill(builtinId);
    if (!found) {
      const available = getOverlaySkills().map((s) => s.id).join(', ');
      return fail(`Встроенный скилл «${builtinId}» не найден. Доступны: ${available}.`);
    }
    const enabled = asBool(args.enabled);
    if (enabled === null || enabled === undefined) {
      return fail('Укажите enabled: true (включить) или false (отключить).');
    }

    const before = await captureSettingsState(ctx.userId);
    await pushPrefsSnapshot(
      ctx.userId,
      `${enabled ? 'Включение' : 'Отключение'} встроенного скилла ${found.id}`,
      before,
    );
    const currentDisabled = new Set(before.prefs.brain?.disabledBuiltinSkills ?? []);
    if (enabled) currentDisabled.delete(found.id);
    else currentDisabled.add(found.id);

    await saveUserPrefs(ctx.userId, {
      ...before.prefs,
      brain: {
        ...(before.prefs.brain ?? {}),
        disabledBuiltinSkills: [...currentDisabled],
      },
    });
    return {
      ok: true,
      content: `${enabled ? '✅ Включил' : '⏸️ Отключил'} встроенный скилл **${found.id}** (${found.name}).`,
      data: { builtin_id: found.id, enabled, disabled_builtin_skills: [...currentDisabled] },
    };
  } catch (error) {
    return fail(`Ошибка при управлении скиллами: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 8. manage_categories
// ---------------------------------------------------------------------------

async function manageCategoriesTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const target = asText(args.target)?.toLowerCase();
  const action = asText(args.action)?.toLowerCase();
  if (!target || !['task_category', 'task_subcategory', 'fin_category'].includes(target)) {
    return fail('Укажите target: "task_category", "task_subcategory" или "fin_category".');
  }
  if (!action || !['list', 'create', 'rename', 'delete'].includes(action)) {
    return fail('Укажите action: "list", "create", "rename" или "delete".');
  }

  try {
    if (target === 'task_category') {
      if (action === 'list') {
        const cats = await listTaskCategories(ctx.userId);
        if (cats.length === 0) return { ok: true, content: 'Категорий задач пока нет.', data: { categories: [] } };
        const lines = ['🎯 **Категории задач:**'];
        for (const c of cats) lines.push(`• #${c.id} ${c.name}`);
        return { ok: true, content: lines.join('\n'), data: { categories: cats } };
      }

      if (action === 'create') {
        const name = asText(args.name);
        if (!name) return fail('Укажите название категории (name).');
        const dup = await findCategoryByNameInsensitive(ctx.userId, name);
        if (dup) return fail(`Категория «${dup.name}» (#${dup.id}) уже существует.`);
        const created = await createTaskCategory(ctx.userId, name, asText(args.color) ?? undefined);
        return {
          ok: true,
          content: `✅ Создал категорию задач «${created.name}» (#${created.id}).`,
          data: { category: created },
        };
      }

      const idArg = asInt(args.category_id);
      const nameArg = asText(args.name);
      const cats = await listTaskCategories(ctx.userId);
      const matched =
        (idArg !== null ? cats.find((c) => c.id === idArg) : undefined) ??
        (nameArg ? await findCategoryByNameInsensitive(ctx.userId, nameArg) : null);
      if (!matched) return fail('Категория задач не найдена.');

      if (action === 'rename') {
        const newName = asText(args.new_name);
        if (!newName) return fail('Укажите новое имя категории (new_name).');
        const updated = await updateTaskCategory(ctx.userId, matched.id, { name: newName });
        if (!updated) return fail('Категория задач не найдена.');
        return {
          ok: true,
          content: `✏️ Категория задач переименована: «${matched.name}» → «${updated.name}».`,
          data: { category: updated },
        };
      }

      // delete
      const res = await deleteTaskCategory(ctx.userId, matched.id);
      return {
        ok: true,
        content: `🗑️ Категория задач «${matched.name}» удалена (отвязано задач: ${res.unlinkedTasks}; сами задачи сохранены).`,
        data: { deleted: res.deleted, unlinked_tasks: res.unlinkedTasks },
      };
    }

    if (target === 'task_subcategory') {
      const parentIdArg = asInt(args.parent_category_id);
      const parentNameArg = asText(args.parent_category);
      const taskCats = await listTaskCategories(ctx.userId);
      const parent =
        (parentIdArg !== null ? taskCats.find((c) => c.id === parentIdArg) : undefined) ??
        (parentNameArg ? await findCategoryByNameInsensitive(ctx.userId, parentNameArg) : null) ??
        null;

      if (action === 'list') {
        const targetCats = parent ? [parent] : taskCats;
        const lines: string[] = ['📂 **Подкатегории задач:**'];
        const out: Array<{ category: string; subcategories: unknown[] }> = [];
        for (const cat of targetCats) {
          const subs = await listTaskSubcategories(ctx.userId, cat.id);
          out.push({ category: cat.name, subcategories: subs });
          lines.push(`• **${cat.name}**: ${subs.length > 0 ? subs.map((s) => `#${s.id} ${s.name}`).join(', ') : 'пусто'}`);
        }
        return { ok: true, content: lines.join('\n'), data: { groups: out } };
      }

      if (action === 'create') {
        if (!parent) return fail('Укажите родительскую категорию (parent_category или parent_category_id).');
        const name = asText(args.name);
        if (!name) return fail('Укажите название подкатегории (name).');
        const created = await createTaskSubcategory(ctx.userId, parent.id, name);
        return {
          ok: true,
          content: `✅ Создал подкатегорию «${created.name}» в «${parent.name}» (#${created.id}).`,
          data: { subcategory: created },
        };
      }

      const subIdArg = asInt(args.subcategory_id);
      const subNameArg = asText(args.name);
      let matchedSub: { id: number; name: string; categoryId: number } | null = null;
      if (subIdArg !== null) {
        const searchCats = parent ? [parent] : taskCats;
        for (const cat of searchCats) {
          const subs = await listTaskSubcategories(ctx.userId, cat.id);
          const found = subs.find((s) => s.id === subIdArg);
          if (found) {
            matchedSub = found;
            break;
          }
        }
      } else if (subNameArg) {
        const searchCats = parent ? [parent] : taskCats;
        for (const cat of searchCats) {
          const found = await findSubcategoryByNameInsensitive(ctx.userId, cat.id, subNameArg);
          if (found) {
            matchedSub = found;
            break;
          }
        }
      }
      if (!matchedSub) return fail('Подкатегория задач не найдена.');

      if (action === 'rename') {
        const newName = asText(args.new_name);
        if (!newName) return fail('Укажите новое имя подкатегории (new_name).');
        const updated = await updateTaskSubcategory(ctx.userId, matchedSub.id, { name: newName });
        if (!updated) return fail('Подкатегория не найдена.');
        return {
          ok: true,
          content: `✏️ Подкатегория переименована: «${matchedSub.name}» → «${updated.name}».`,
          data: { subcategory: updated },
        };
      }

      // delete
      const res = await deleteTaskSubcategory(ctx.userId, matchedSub.id);
      return {
        ok: true,
        content: `🗑️ Подкатегория «${matchedSub.name}» удалена (отвязано задач: ${res.unlinkedTasks}; сами задачи сохранены).`,
        data: { deleted: res.deleted, unlinked_tasks: res.unlinkedTasks },
      };
    }

    // fin_category
    const kindRaw = asText(args.kind)?.toLowerCase();
    if (kindRaw && kindRaw !== 'expense' && kindRaw !== 'income') {
      return fail('kind для финансовой категории должен быть "expense" или "income".');
    }
    const kind = kindRaw as FinCategoryKind | undefined;

    if (action === 'list') {
      const cats = await listFinCategories(ctx.userId, kind);
      if (cats.length === 0) return { ok: true, content: 'Финансовых категорий пока нет.', data: { categories: [] } };
      const lines = ['💳 **Финансовые категории:**'];
      for (const c of cats) lines.push(`• #${c.id} ${c.name} (${c.kind})`);
      return { ok: true, content: lines.join('\n'), data: { categories: cats } };
    }

    if (action === 'create') {
      const name = asText(args.name);
      if (!name) return fail('Укажите название финансовой категории (name).');
      const targetKind: FinCategoryKind = kind ?? 'expense';
      const existing = await listFinCategories(ctx.userId, targetKind);
      const dup = existing.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
      if (dup) return fail(`Финансовая категория «${dup.name}» (${targetKind}, #${dup.id}) уже существует.`);
      const created = await createFinCategory(ctx.userId, {
        name,
        kind: targetKind,
        icon: asText(args.icon) ?? undefined,
      });
      return {
        ok: true,
        content: `✅ Создал финансовую категорию «${created.name}» (${created.kind}, #${created.id}).`,
        data: { category: created },
      };
    }

    const finIdArg = asInt(args.category_id);
    const finNameArg = asText(args.name);
    const allFin = await listFinCategories(ctx.userId, kind);
    const matchedFin =
      (finIdArg !== null ? allFin.find((c) => c.id === finIdArg) : undefined) ??
      (finNameArg
        ? allFin.find((c) => c.name.trim().toLowerCase() === finNameArg.toLowerCase())
        : undefined);
    if (!matchedFin) return fail('Финансовая категория не найдена.');

    if (action === 'rename') {
      const newName = asText(args.new_name);
      if (!newName) return fail('Укажите новое имя категории (new_name).');
      const dup = allFin.find(
        (c) =>
          c.id !== matchedFin.id &&
          c.kind === matchedFin.kind &&
          c.name.trim().toLowerCase() === newName.toLowerCase(),
      );
      if (dup) return fail(`Финансовая категория «${dup.name}» уже существует.`);
      const updated = await updateFinCategory(ctx.userId, matchedFin.id, { name: newName });
      return {
        ok: true,
        content: `✏️ Финансовая категория переименована: «${matchedFin.name}» → «${updated.name}».`,
        data: { category: updated },
      };
    }

    // delete (safe unlink)
    const usage = await countCategoryUsage(ctx.userId, matchedFin.id);
    const deleted = await deleteFinCategory(ctx.userId, matchedFin.id, { unlink: true });
    return {
      ok: true,
      content: `🗑️ Финансовая категория «${matchedFin.name}» удалена (отвязано операций: ${usage.transactions}, удалено бюджетов категории: ${usage.budgets}; сами операции сохранены).`,
      data: {
        deleted,
        unlinked_transactions: usage.transactions,
        deleted_budgets: usage.budgets,
      },
    };
  } catch (error) {
    return fail(`Ошибка при управлении категориями: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 9. manage_docs
// ---------------------------------------------------------------------------

async function manageDocsTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['list', 'read', 'update', 'delete'].includes(action)) {
    return fail('Укажите action: "list", "read", "update" или "delete".');
  }

  try {
    if (action === 'list') {
      const chapters = await listChapters(ctx.userId);
      if (chapters.length === 0) {
        return { ok: true, content: 'Глав системной документации пока нет.', data: { chapters: [] } };
      }
      const lines = ['📚 **Главы документации (`doc_chapters`):**'];
      for (const ch of chapters) {
        lines.push(`• \`${ch.slug}\` — ${ch.title} (${ch.content.length} симв.)`);
      }
      return {
        ok: true,
        content: lines.join('\n'),
        data: { chapters: chapters.map((c) => ({ slug: c.slug, title: c.title, chars: c.content.length })) },
      };
    }

    const slug = asText(args.slug);
    if (!slug) return fail('Укажите slug главы (например 01_finances_and_debts).');

    if (action === 'read') {
      const chapter = await getChapter(ctx.userId, slug);
      if (!chapter) return fail(`Глава «${slug}» не найдена.`);
      return {
        ok: true,
        content: `# ${chapter.title} (\`${chapter.slug}\`)\n\n${chapter.content}`,
        data: { slug: chapter.slug, title: chapter.title, content: chapter.content },
      };
    }

    if (slug === CUSTOM_INSTRUCTIONS_SLUG) {
      return fail(
        'Глава 07_custom_instructions управляется через manage_rules, manage_personas или update_custom_directives, чтобы не потерять правила /learn и стиль общения.',
      );
    }

    if (action === 'update') {
      const content = typeof args.content === 'string' ? args.content : null;
      if (content === null || !content.trim()) {
        return fail('Укажите непустой markdown-текст главы (content).');
      }
      const existing = await getChapter(ctx.userId, slug);
      const title = asText(args.title) ?? existing?.title ?? slug;
      const saved = await upsertChapter(ctx.userId, {
        slug,
        title,
        content,
        filename: existing?.filename ?? `${slug}.md`,
        isPinned: true,
      });
      return {
        ok: true,
        content: `📝 Глава «${saved.title}» (\`${saved.slug}\`) сохранена (${saved.content.length} симв.).`,
        data: { slug: saved.slug, title: saved.title, chars: saved.content.length },
      };
    }

    // delete
    const deleted = await deleteChapter(ctx.userId, slug);
    if (!deleted) return fail(`Глава «${slug}» не найдена.`);
    return {
      ok: true,
      content: `🗑️ Глава «${slug}» удалена.`,
      data: { deleted: true, slug },
    };
  } catch (error) {
    return fail(`Ошибка при работе с документацией: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 10. manage_backlog
// ---------------------------------------------------------------------------

const VALID_BACKLOG_CATEGORIES: ReadonlySet<string> = new Set([
  'feature',
  'bug',
  'improvement',
  'idea',
]);
const VALID_BACKLOG_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'shipped',
  'rejected',
]);
const VALID_PRIORITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

async function manageBacklogTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['list', 'add', 'resolve', 'delete'].includes(action)) {
    return fail('Укажите action: "list", "add", "resolve" или "delete".');
  }

  try {
    if (action === 'list') {
      const statusRaw = asText(args.status)?.toLowerCase();
      if (statusRaw && !VALID_BACKLOG_STATUSES.has(statusRaw)) {
        return fail(`status должен быть одним из: ${[...VALID_BACKLOG_STATUSES].join(', ')}.`);
      }
      const items = (
        await listItems(ctx.userId, {
          status: statusRaw as EvolutionStatus | undefined,
          limit: 100,
        })
      ).filter((item) => item.category !== 'skill');
      if (items.length === 0) {
        return { ok: true, content: 'Бэклог авто-эволюции пуст.', data: { items: [] } };
      }
      const lines = ['📋 **Бэклог эволюции:**'];
      for (const item of items) {
        lines.push(`• #${item.id} [${item.category}/${item.status}/${item.priority}] ${item.title}`);
      }
      return { ok: true, content: lines.join('\n'), data: { items } };
    }

    if (action === 'add') {
      const title = asText(args.title);
      if (!title) return fail('Укажите заголовок идеи/задачи (title).');
      const catRaw = asText(args.category)?.toLowerCase() ?? 'idea';
      if (!VALID_BACKLOG_CATEGORIES.has(catRaw)) {
        return fail(`category должна быть одной из: ${[...VALID_BACKLOG_CATEGORIES].join(', ')}.`);
      }
      const prioRaw = asText(args.priority)?.toLowerCase() ?? 'medium';
      if (!VALID_PRIORITIES.has(prioRaw)) {
        return fail('priority должен быть low, medium или high.');
      }
      const rawInput = asText(args.description) ?? title;
      const item = await addItem(ctx.userId, {
        category: catRaw as EvolutionCategory,
        title: truncate(title, 120),
        rawInput,
        priority: prioRaw as EvolutionPriority,
      });
      return {
        ok: true,
        content: `📋 Добавил в бэклог #${item.id} [${item.category}/${item.priority}]: «${item.title}».`,
        data: { item },
      };
    }

    const itemId = asInt(args.item_id);
    if (itemId === null || itemId <= 0) return fail('Укажите числовой item_id.');
    const existing = await getItem(ctx.userId, itemId);
    if (!existing) return fail(`Элемент бэклога #${itemId} не найден.`);
    if (existing.category === 'skill') {
      return fail('Скиллы управляются через manage_skills, а не manage_backlog.');
    }

    if (action === 'resolve') {
      const statusRaw = asText(args.status)?.toLowerCase();
      if (!statusRaw || !VALID_BACKLOG_STATUSES.has(statusRaw)) {
        return fail(`Укажите status: ${[...VALID_BACKLOG_STATUSES].join(', ')}.`);
      }
      const updated = await resolveItem(ctx.userId, itemId, statusRaw as EvolutionStatus);
      return {
        ok: true,
        content: `✅ Элемент #${itemId} («${existing.title}») переведён в статус ${statusRaw}.`,
        data: { item: updated },
      };
    }

    // delete
    const deleted = await removeItem(ctx.userId, itemId);
    return {
      ok: true,
      content: `🗑️ Элемент бэклога #${itemId} («${existing.title}») удалён.`,
      data: { deleted, item_id: itemId },
    };
  } catch (error) {
    return fail(`Ошибка при работе с бэклогом: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 11. manage_session
// ---------------------------------------------------------------------------

async function manageSessionTool(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const action = asText(args.action)?.toLowerCase();
  if (!action || !['status', 'talk_on', 'talk_off', 'reset_thread'].includes(action)) {
    return fail('Укажите action: "status", "talk_on", "talk_off" или "reset_thread".');
  }

  try {
    const nowMs = ctx.now.getTime();
    if (action === 'status') {
      const [talk, thread] = await Promise.all([
        getTalkModeStatus(ctx.userId, nowMs),
        loadThread(ctx.userId).catch(() => []),
      ]);
      return {
        ok: true,
        content:
          `💬 Сессия: режим /talk ${talk.active ? `включён (осталось ${talk.remainingMinutes} мин)` : 'выключен'}, сообщений в контексте: ${thread.length}.`,
        data: { talk_mode: talk, thread_messages: thread.length },
      };
    }

    if (action === 'talk_on') {
      const ttlArg =
        args.ttl_minutes === undefined || args.ttl_minutes === null
          ? undefined
          : asInt(args.ttl_minutes);
      if (ttlArg === null) return fail('ttl_minutes должен быть целым числом.');
      const minutes =
        ttlArg === undefined
          ? Math.round(TALK_MODE_TTL_MS / 60_000)
          : Math.min(MAX_TALK_MODE_TTL_MINUTES, Math.max(MIN_TALK_MODE_TTL_MINUTES, ttlArg));
      const until = await enableTalkMode(ctx.userId, nowMs, minutes * 60_000);
      return {
        ok: true,
        content: `🗣️ Разговорный режим (/talk) включён на ${minutes} мин.`,
        data: { active: true, ttl_minutes: minutes, expires_at: until },
      };
    }

    if (action === 'talk_off') {
      await disableTalkMode(ctx.userId);
      return {
        ok: true,
        content: '🗣️ Разговорный режим (/talk) выключен. Возвращаемся в обычный режим управления.',
        data: { active: false },
      };
    }

    // reset_thread
    await clearThread(ctx.userId);
    return {
      ok: true,
      content: '🧹 Контекст диалога сброшен. Начинаем с чистого листа (данные в базе сохранены).',
      data: { threadReset: true },
    };
  } catch (error) {
    return fail(`Ошибка при управлении сессией: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

export const configTools: Tool[] = [
  {
    name: 'get_settings',
    effect: { kind: 'read' },
    description:
      'Показывает все текущие настройки: профиль, AI-параметры, СДВГ-щит/фокус/стагнацию, финансовые алиасы/резерв/runway, шаблон дневника, тихие часы и 5 проактивных джоб, кастомные рутины, настройки Mini App (вкладки/роли счетов), персоны/правила/скиллы, пресеты, историю откатов и статус сессии. Только чтение.',
    schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: [
            'all',
            'profile',
            'ai',
            'brain',
            'adhd',
            'finance',
            'diary',
            'proactive',
            'routines',
            'miniapp',
            'presets',
            'session',
          ],
          description: 'Необязательный фильтр секции (по умолчанию all).',
        },
      },
      required: [],
    },
    run: getSettingsTool,
  },
  {
    name: 'update_settings',
    effect: { kind: 'mutate' },
    confirmWhen: (args) =>
      args.model_provider !== undefined || args.preferred_model !== undefined,
    description:
      'Обновляет профиль, AI-параметры, СДВГ-щит и фокус (adhd), финансовые правила/резерв/runway (finance), шаблон дневника (diary), тихие часы и 5 встроенных проактивных джоб (proactive), а также вкладки и роли счетов Mini App (miniapp). API-ключи здесь запрещены.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя пользователя (или "none" для очистки).' },
        language: { type: 'string', enum: ['ru', 'en', 'sr', 'ja'], description: 'Язык интерфейса и ответов.' },
        timezone: { type: 'string', description: 'IANA-таймзона, например Europe/Belgrade.' },
        base_currency: { type: 'string', description: 'Базовая валюта ISO-4217 (EUR, USD, RUB…).' },
        summary_time: { type: 'string', description: 'Время утренней сводки ЧЧ:ММ (например 08:30).' },
        low_stimulation_mode: { type: 'boolean', description: 'Включить/выключить спокойный режим (Calm ADHD).' },
        assistant_name: { type: 'string', description: 'Пользовательское имя ассистента (или "default" для сброса).' },
        model_provider: {
          type: 'string',
          enum: ['gemini', 'openai', 'deepseek', 'anthropic', 'default'],
          description: 'Провайдер модели (требует подключённого ключа и подтверждения; "default" для сброса).',
        },
        preferred_model: { type: 'string', description: 'Предпочтительная модель (или "default" для сброса).' },
        max_steps: { type: 'integer', description: 'Лимит шагов рассуждения агента (4..16, или 0 для сброса).' },
        temperature: { type: 'number', description: 'Температура генерации (0..1).' },
        overload_shield_enabled: { type: 'boolean', description: 'Вкл/выкл СДВГ-щит от перегрузки.' },
        overload_overdue_threshold: { type: 'integer', description: 'Порог просроченных задач для СДВГ-щита (1..30, по умолчанию 3).' },
        overload_active_todo_threshold: { type: 'integer', description: 'Порог активных задач для СДВГ-щита (3..100, по умолчанию 12).' },
        overload_night_start_hour: { type: 'integer', description: 'Час начала ночного окна СДВГ-щита (0..23, по умолчанию 21).' },
        overload_night_end_hour: { type: 'integer', description: 'Час окончания ночного окна СДВГ-щита (0..23, по умолчанию 6).' },
        focus_limit: { type: 'integer', description: 'Лимит задач в фокусе дня (1..10).' },
        stale_after_days: { type: 'integer', description: 'Через сколько дней просрочки задача считается застрявшей (1..30, по умолчанию 2).' },
        finance_alias_account: { type: 'string', description: 'Точное имя счёта для пользовательских алиасов.' },
        finance_alias_patterns: { type: 'string', description: 'Синонимы/паттерны счёта через запятую (или "" для удаления алиасов счёта).' },
        finance_default_currency: { type: 'string', description: 'Валюта ISO-4217 для назначения дефолтного счёта (EUR, RUB…).' },
        finance_default_account: { type: 'string', description: 'Имя дефолтного счёта для finance_default_currency (или "" для сброса).' },
        finance_reserve_eur: { type: 'number', description: 'Дополнительный целевой резерв в EUR (0 = без дополнительного резерва).' },
        runway_daily_burn_override_eur: { type: 'number', description: 'Фиксированный дневной расход в EUR для runway (1..50000, или 0 для авто).' },
        runway_min_daily_burn_eur: { type: 'number', description: 'Минимальный дневной burn в EUR (1..50000, или 0 для дефолта).' },
        runway_seed_daily_burn_eur: { type: 'number', description: 'Стартовый дневной burn при отсутствии истории в EUR (1..50000, или 0 для дефолта).' },
        runway_burn_window_days: { type: 'integer', description: 'Окно расчёта среднего расхода в днях (7..365, или 0 для дефолта).' },
        runway_horizon_days: { type: 'integer', description: 'Фиксированный горизонт прогноза runway в днях (1..365, или 0 до конца месяца).' },
        diary_sections: { type: 'string', description: 'Секции дневника через запятую (или "default" для сброса).' },
        diary_include_tasks: { type: 'boolean', description: 'Включать ли выполненные задачи в дневник по умолчанию.' },
        diary_header_template: { type: 'string', description: 'Заголовок шаблона дневника, поддерживает {date} и {weekday} (или "default").' },
        quiet_hours_enabled: { type: 'boolean', description: 'Вкл/выкл тихие часы для проактивных доставок и рутин.' },
        quiet_hours_start: { type: 'string', description: 'Начало тихих часов ЧЧ:ММ (например 23:00).' },
        quiet_hours_end: { type: 'string', description: 'Окончание тихих часов ЧЧ:ММ (например 07:00).' },
        morning_digest_enabled: { type: 'boolean', description: 'Вкл/выкл утренний дайджест.' },
        morning_digest_window_minutes: { type: 'integer', description: 'Окно доставки утреннего дайджеста в минутах (15..720).' },
        morning_digest_sections: { type: 'string', description: 'Секции дайджеста через запятую (focus, medications, finance, inbox, telemetry, coaching) или "all".' },
        liability_warning_enabled: { type: 'boolean', description: 'Вкл/выкл предупреждения об обязательствах.' },
        liability_warning_days: { type: 'integer', description: 'За сколько дней до платежа предупреждать (0..14, по умолчанию 3).' },
        liability_review_enabled: { type: 'boolean', description: 'Вкл/выкл интерактивную проверку списаний после дайджеста.' },
        medication_reminder_enabled: { type: 'boolean', description: 'Вкл/выкл напоминания о приёме лекарств.' },
        medication_reminder_window_minutes: { type: 'integer', description: 'Окно доставки напоминаний о лекарствах в минутах (15..720).' },
        nightly_consolidation_enabled: { type: 'boolean', description: 'Вкл/выкл ночную консолидацию памяти.' },
        nightly_consolidation_hour: { type: 'integer', description: 'Час запуска ночной консолидации по локальному времени (0..23).' },
        nightly_consolidation_note_limit: { type: 'integer', description: 'Лимит заметок за один проход ночной консолидации (5..100).' },
        miniapp_tabs: { type: 'string', description: 'Порядок/состав вкладок Mini App через запятую (today, tasks, finances, notes, system; вкладка system сохраняется всегда) или "default".' },
        miniapp_account_pattern: { type: 'string', description: 'Паттерн или имя счёта для кастомной темы/роли в Mini App.' },
        miniapp_account_theme: { type: 'string', enum: ['primary', 'secondary', 'accent', 'neutral', 'default'], description: 'Цветовая тема карточки счёта в Mini App (или "default").' },
        miniapp_account_short_name: { type: 'string', description: 'Короткое имя карточки счёта в Mini App (до 40 симв., или "default").' },
        miniapp_account_role_label: { type: 'string', description: 'Подпись роли/назначения счёта в Mini App (до 80 симв., или "default" для удаления).' },
      },
      required: [],
    },
    run: updateSettingsTool,
  },
  {
    name: 'reset_or_rollback_settings',
    effect: { kind: 'mutate' },
    confirmWhen: (args) => String(args.action ?? '').trim().toLowerCase() === 'reset',
    description:
      'Откатывает последние изменения настроек на N шагов назад (action="rollback") или сбрасывает секцию/все переопределения к значениям по умолчанию (action="reset", требует подтверждения).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['rollback', 'reset'], description: 'rollback — откат, reset — сброс к дефолту.' },
        steps: { type: 'integer', description: 'На сколько шагов откатить (1..10, для rollback).' },
        section: {
          type: 'string',
          enum: [
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
          ],
          description: 'Какую секцию сбросить (для reset, по умолчанию all).',
        },
      },
      required: ['action'],
    },
    run: resetOrRollbackSettingsTool,
  },
  {
    name: 'manage_routines',
    effect: { kind: 'mutate' },
    confirmWhen: (args) => {
      const act = String(args.action ?? '').trim().toLowerCase();
      if (act === 'delete') return true;
      if (act === 'upsert') {
        return String(args.tool_access ?? '').trim().toLowerCase() === 'allow_writes';
      }
      return false;
    },
    description:
      'Управляет кастомными регулярными рутинами: list, upsert (создать/обновить text, summary или ai — до 3 активных AI), pause, resume, delete (с подтверждением), preview (сухой предпросмотр без вызова LLM в фоне). AI с allow_writes требует подтверждения.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'upsert', 'pause', 'resume', 'delete', 'preview'] },
        id: { type: 'string', description: 'Slug-идентификатор рутины латиницей.' },
        name: { type: 'string', description: 'Понятное название рутины.' },
        kind: { type: 'string', enum: ['text', 'summary', 'ai'], description: 'Тип: text (текстовый пинг, 0 токенов), summary (встроенная сводка, 0 токенов), ai (промпт агенту).' },
        schedule: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Периодичность запуска.' },
        time: { type: 'string', description: 'Целевое время ЧЧ:ММ в таймзоне пользователя.' },
        weekdays: { type: 'string', description: 'Для weekly: дни недели (например "пн, ср, пт", "будни", "выходные", "0,2,4").' },
        day_of_month: { type: 'integer', description: 'Для monthly: день месяца (1..31).' },
        window_minutes: { type: 'integer', description: 'Окно срабатывания в минутах (15..720, по умолчанию 180).' },
        message: { type: 'string', description: 'Текст уведомления (для kind="text").' },
        summary_kind: { type: 'string', enum: ['quick', 'balance', 'debts', 'tasks', 'meds', 'digest'], description: 'Вид сводки (для kind="summary").' },
        prompt: { type: 'string', description: 'Промпт для агента (для kind="ai").' },
        tool_access: { type: 'string', enum: ['read-only', 'allow_writes'], description: 'Права AI-рутины (по умолчанию read-only; allow_writes без destroy и требует подтверждения).' },
        enabled: { type: 'boolean', description: 'Активна ли рутина (по умолчанию true).' },
        respect_quiet_hours: { type: 'boolean', description: 'Откладывать ли при активных тихих часах (по умолчанию true).' },
      },
      required: ['action'],
    },
    run: manageRoutinesTool,
  },
  {
    name: 'manage_presets',
    effect: { kind: 'mutate' },
    confirmWhen: (args) => String(args.action ?? '').trim().toLowerCase() === 'delete',
    description:
      'Управляет именованными пресетами режимов (например «Отпуск», «Фокус-спринт»): list, save (сохранить текущие настройки как пресет), apply (применить пресет), delete (удалить, с подтверждением).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'apply', 'delete'] },
        id: { type: 'string', description: 'Идентификатор пресета латиницей.' },
        name: { type: 'string', description: 'Название пресета.' },
        description: { type: 'string', description: 'Краткое описание (для save).' },
      },
      required: ['action'],
    },
    run: managePresetsTool,
  },
  {
    name: 'manage_rules',
    effect: { kind: 'mutate' },
    description:
      'Точечное управление постоянными правилами поведения (/learn): list (список с номерами), add (добавить), edit (изменить одно правило по номеру index или подстроке match), remove (удалить одно правило).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'edit', 'remove'] },
        rule: { type: 'string', description: 'Текст правила (для add).' },
        new_rule: { type: 'string', description: 'Новый текст правила (для edit).' },
        index: { type: 'integer', description: 'Номер правила из списка, начиная с 1 (для edit/remove).' },
        match: { type: 'string', description: 'Фрагмент текста правила (для edit/remove).' },
      },
      required: ['action'],
    },
    run: manageRulesTool,
  },
  {
    name: 'manage_personas',
    effect: { kind: 'mutate' },
    confirmWhen: (args) => String(args.action ?? '').trim().toLowerCase() === 'delete',
    description:
      'Управление стилями и кастомными персонами общения: list (встроенные 4 + кастомные), switch (переключить), upsert (создать или обновить свою персону), delete (удалить кастомную, с подтверждением).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'switch', 'upsert', 'delete'] },
        id: { type: 'string', description: 'ID персоны (mentor, strategist, calm_partner, concise или свой slug).' },
        name: { type: 'string', description: 'Отображаемое имя персоны.' },
        description: { type: 'string', description: 'Краткое описание.' },
        instructions: { type: 'string', description: 'Подробные инструкции стиля для промпта (для upsert).' },
        activate: { type: 'boolean', description: 'Сразу переключиться на созданную персону (для upsert).' },
      },
      required: ['action'],
    },
    run: managePersonasTool,
  },
  {
    name: 'manage_skills',
    effect: { kind: 'mutate' },
    confirmWhen: (args) =>
      ['activate', 'disable', 'reject', 'update', 'toggle_builtin'].includes(
        String(args.action ?? '').trim().toLowerCase(),
      ),
    description:
      'Полный цикл управления скиллами (все изменяющие действия требуют подтверждения): activate (включить черновик/отключённый), disable (поставить активный на паузу), reject (отклонить), update (обновить или создать ревизию своего скилла), toggle_builtin (включить/отключить встроенный .md-скилл).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['activate', 'disable', 'reject', 'update', 'toggle_builtin'] },
        skill_id: { type: 'string', description: 'Числовой ID или ключ пользовательского скилла.' },
        builtin_id: { type: 'string', description: 'ID встроенного .md-скилла (для toggle_builtin).' },
        enabled: { type: 'boolean', description: 'true/false (для toggle_builtin).' },
        key: { type: 'string', description: 'Ключ скилла в kebab-case (для update).' },
        title: { type: 'string', description: 'Название скилла (для update).' },
        when_to_use: { type: 'string', description: 'Когда применять (для update).' },
        procedure: { type: 'string', description: 'Шаги процедуры (для update).' },
        pitfalls: { type: 'string', description: 'Подводные камни (опционально, для update).' },
        verification: { type: 'string', description: 'Проверка результата (опционально, для update).' },
        activate_now: { type: 'boolean', description: 'Сразу активировать новую ревизию (для update).' },
      },
      required: ['action'],
    },
    run: manageSkillsTool,
  },
  {
    name: 'manage_categories',
    effect: { kind: 'mutate' },
    confirmWhen: (args) => String(args.action ?? '').trim().toLowerCase() === 'delete',
    description:
      'Управление категориями и подкатегориями задач и финансовыми категориями: list, create, rename, delete (с подтверждением и безопасной отвязкой задач/операций без удаления данных).',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['task_category', 'task_subcategory', 'fin_category'] },
        action: { type: 'string', enum: ['list', 'create', 'rename', 'delete'] },
        category_id: { type: 'integer', description: 'ID категории.' },
        subcategory_id: { type: 'integer', description: 'ID подкатегории.' },
        name: { type: 'string', description: 'Текущее или новое название категории/подкатегории.' },
        new_name: { type: 'string', description: 'Новое название (для rename).' },
        parent_category: { type: 'string', description: 'Название родительской категории задач (для task_subcategory).' },
        parent_category_id: { type: 'integer', description: 'ID родительской категории задач.' },
        kind: { type: 'string', enum: ['expense', 'income'], description: 'Тип финансовой категории (для fin_category).' },
        color: { type: 'string', description: 'Цвет категории задач.' },
        icon: { type: 'string', description: 'Иконка финансовой категории.' },
      },
      required: ['target', 'action'],
    },
    run: manageCategoriesTool,
  },
  {
    name: 'manage_docs',
    effect: { kind: 'mutate' },
    confirmWhen: (args) =>
      ['update', 'delete'].includes(String(args.action ?? '').trim().toLowerCase()),
    description:
      'Управление главами базы знаний (doc_chapters): list, read, update (с подтверждением), delete (с подтверждением). Глава 07_custom_instructions защищена от прямой перезаписи.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'update', 'delete'] },
        slug: { type: 'string', description: 'Слаг главы (например 01_finances_and_debts).' },
        title: { type: 'string', description: 'Заголовок главы (для update).' },
        content: { type: 'string', description: 'Markdown-текст главы (для update).' },
      },
      required: ['action'],
    },
    run: manageDocsTool,
  },
  {
    name: 'manage_backlog',
    effect: { kind: 'mutate' },
    confirmWhen: (args) => String(args.action ?? '').trim().toLowerCase() === 'delete',
    description:
      'Управление бэклогом эволюции системы (идеи, баги, улучшения): list, add, resolve (pending/in_progress/shipped/rejected), delete (с подтверждением).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'resolve', 'delete'] },
        item_id: { type: 'integer', description: 'ID элемента бэклога (для resolve/delete).' },
        category: { type: 'string', enum: ['feature', 'bug', 'improvement', 'idea'] },
        title: { type: 'string', description: 'Заголовок (для add).' },
        description: { type: 'string', description: 'Подробное описание (для add).' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        status: { type: 'string', enum: ['pending', 'in_progress', 'shipped', 'rejected'] },
      },
      required: ['action'],
    },
    run: manageBacklogTool,
  },
  {
    name: 'manage_session',
    effect: { kind: 'mutate' },
    description:
      'Управление текущей сессией и режимом разговора (/talk): status, talk_on (опционально ttl_minutes 5..240), talk_off, reset_thread (сбросить контекст диалога, сохранив все данные в базе).',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'talk_on', 'talk_off', 'reset_thread'] },
        ttl_minutes: { type: 'integer', description: 'Длительность режима /talk в минутах (5..240, по умолчанию 30).' },
      },
      required: ['action'],
    },
    run: manageSessionTool,
  },
];
