import React, { useEffect, useState } from 'react';
import { FeedbackPanel } from '../components/FeedbackPanel';
import {
  Sparkles,
  Brain,
  Check,
  BookOpen,
  Search,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Pill,
  Clock,
  Trash2,
  GraduationCap,
  HeartHandshake,
  Zap,
  X,
  Coins,
  AlertTriangle,
  Key,
  Download,
  Upload,
  Database,
  Globe,
  Wrench,
  Activity,
  Bug,
  Lightbulb,
  RotateCcw,
  SlidersHorizontal,
  Layers,
  Undo2,
} from 'lucide-react';
import {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  useI18n,
  type LocaleCode,
} from '../i18n/index';
import type {
  DocChapterSummary,
  DocChapterDetail,
  Medication,
  UserSettings,
  AccessInfo,
  SkillsResponse,
  BacklogItem,
  DiagnosticsResponse,
  DocSearchResult,
  ReaderSkillData,
  CustomRoutineItem,
} from '../types';
import {
  saveByokKey,
  clearByokKey,
  exportBackupJson,
  restoreBackupJson,
  fetchSkills,
  activateUserSkill,
  rejectUserSkill,
  fetchBacklog,
  resolveBacklogItem,
  fetchDiagnostics,
  resetAgentSession,
  searchDocs,
  toggleSettingsRoutine,
  applySettingsPreset,
  resetSettingsToDefault,
  rollbackSettingsChange,
} from '../api';
import { findDocSectionMatches, stripMarkdownInline } from '../utils';

export type SystemSectionId = 'directives' | 'skills' | 'diagnostics' | 'meds' | 'dossier' | 'docs';

export interface PersonaPreset {
  id: string;
  title: string;
  desc: string;
  instruction: string;
  isCustom?: boolean;
}

export interface SystemTabProps {
  personaPresets: readonly PersonaPreset[];
  personaStyle: string;
  setPersonaStyle: (style: string) => void;
  customInstructions: string;
  setCustomInstructions: (inst: string) => void;
  isSavingDirectives: boolean;
  directivesSavedMsg: boolean;
  handleSaveDirectives: (extra?: {
    base_currency?: string;
    timezone?: string;
    summary_time?: string;
    model_provider?: string;
  }) => void;
  loadingContext: boolean;
  lifeContext: string;
  contextDepth: number;
  setContextDepth: (depth: number) => void;
  loadAssistantData: (depth?: number) => void;
  loadingDocs: boolean;
  loadDocsData: () => void;
  docSearchQuery: string;
  setDocSearchQuery: (query: string) => void;
  filteredDocChapters: DocChapterSummary[];
  docChapters: DocChapterSummary[];
  selectedChapterSlug: string | null;
  handleToggleChapter: (slug: string, sectionTitle?: string) => void;
  loadingChapterDetail: boolean;
  chapterDetail: DocChapterDetail | null;
  onOpenDossierReader?: () => void;
  onOpenSkillReader?: (skill: ReaderSkillData) => void;
  initialOpenSection?: SystemSectionId | null;
  skillsRefreshKey?: number;
  showConfirm?: (msg: string) => Promise<boolean>;
  showAlert?: (msg: string) => Promise<void>;
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;

  userSettings?: UserSettings | null;
  accessInfo?: AccessInfo | null;
  onReloadSettings?: () => Promise<void> | void;
  onRefreshConfig?: (updatedSettings?: UserSettings) => Promise<void> | void;
  backupPrefix?: string;
  feedbackEnabled?: boolean;

  // Collapsible Medications module props
  medications?: Medication[];
  medsLoading?: boolean;
  isAddingMed?: boolean;
  setIsAddingMed?: (val: boolean) => void;
  newMedName?: string;
  setNewMedName?: (val: string) => void;
  newMedDosage?: string;
  setNewMedDosage?: (val: string) => void;
  newMedTimes?: string;
  setNewMedTimes?: (val: string) => void;
  newMedInstructions?: string;
  setNewMedInstructions?: (val: string) => void;
  isSubmittingMed?: boolean;
  handleCreateMedication?: (e: React.FormEvent) => void;
  handleTakeMed?: (medId: string, scheduledTime: string) => void;
  handleSkipMed?: (medId: string, scheduledTime: string) => void;
  handleDeleteMedication?: (medId: string) => void;
}

const CURRENCY_OPTIONS = [
  { code: 'EUR', label: 'EUR (€)' },
  { code: 'RUB', label: 'RUB (₽)' },
  { code: 'USD', label: 'USD ($)' },
  { code: 'KZT', label: 'KZT (₸)' },
  { code: 'TRY', label: 'TRY (₺)' },
] as const;

const TIMEZONE_PRESETS = [
  'Europe/Moscow',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Almaty',
] as const;

const PROVIDER_OPTIONS = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'anthropic', label: 'Anthropic' },
] as const;

function getPresetIcon(id: string) {
  switch (id) {
    case 'mentor':
      return <HeartHandshake size={15} color="var(--accent-color)" />;
    case 'strategist':
      return <Zap size={15} color="var(--accent-color)" />;
    case 'calm_partner':
      return <GraduationCap size={15} color="var(--accent-color)" />;
    case 'concise':
      return <Brain size={15} color="var(--accent-color)" />;
    default:
      return <Sparkles size={15} color="var(--accent-color)" />;
  }
}

const SUPPORTS_NATIVE_SWITCH =
  typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

function bindNativeSwitchAttr(el: HTMLInputElement | null): void {
  if (el && SUPPORTS_NATIVE_SWITCH && !el.hasAttribute('switch')) {
    el.setAttribute('switch', '');
  }
}

function getPresetBadge(preset: PersonaPreset, t: (key: string) => string): string {
  if (preset.isCustom) return t('system.customPersonaBadge');
  switch (preset.id) {
    case 'mentor':
      return t('badges.calmMode');
    case 'strategist':
      return t('badges.focusFacts');
    case 'calm_partner':
      return t('badges.peerToPeer');
    case 'concise':
      return t('badges.concise');
    default:
      return '';
  }
}

function formatRoutineScheduleLabel(
  routine: CustomRoutineItem,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (routine.schedule) {
    case 'weekly':
      return t('system.routineScheduleWeekly');
    case 'monthly':
      return t('system.routineScheduleMonthly');
    default:
      return t('system.routineScheduleDaily');
  }
}

function formatRoutineKindLabel(
  routine: CustomRoutineItem,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (routine.kind) {
    case 'summary':
      return t('system.routineKindSummary');
    case 'ai':
      return t('system.routineKindAi');
    default:
      return t('system.routineKindText');
  }
}

function buildActiveOverrideChips(
  userSettings: UserSettings | null | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string[] {
  if (!userSettings) return [];
  const chips: string[] = [];
  const summary = userSettings.prefs_summary;

  if (userSettings.assistant_name) {
    chips.push(t('system.overrideChipAssistant', { value: userSettings.assistant_name }));
  }
  if (!summary) return chips;

  if (summary.ai.preferred_model) {
    chips.push(t('system.overrideChipModel', { value: summary.ai.preferred_model }));
  } else if (userSettings.model_provider && userSettings.model_provider !== 'gemini') {
    chips.push(t('system.overrideChipModel', { value: userSettings.model_provider }));
  }
  if (summary.ai.max_steps !== null) {
    chips.push(t('system.overrideChipSteps', { value: summary.ai.max_steps }));
  }
  if (summary.ai.temperature !== null) {
    chips.push(t('system.overrideChipTemp', { value: summary.ai.temperature }));
  }

  if (!summary.adhd.overload_shield_enabled) {
    chips.push(t('system.overrideChipShieldOff'));
  } else if (
    summary.adhd.overload_overdue_threshold !== null ||
    summary.adhd.overload_active_todo_threshold !== null ||
    summary.adhd.overload_night_window !== null
  ) {
    chips.push(t('system.overrideChipShieldCustom'));
  }
  if (summary.adhd.focus_limit !== null) {
    chips.push(t('system.overrideChipFocus', { value: summary.adhd.focus_limit }));
  }
  if (summary.adhd.stale_after_days !== null) {
    chips.push(t('system.overrideChipStale', { value: summary.adhd.stale_after_days }));
  }

  if (summary.finance.reserve_eur > 0) {
    chips.push(
      t('system.overrideChipReserve', {
        value: formatNumber(summary.finance.reserve_eur, { maximumFractionDigits: 0 }),
      }),
    );
  }
  if (summary.finance.aliases_count > 0) {
    chips.push(t('system.overrideChipAliases', { count: summary.finance.aliases_count }));
  }
  if (summary.finance.default_accounts_count > 0) {
    chips.push(t('system.overrideChipDefaults', { count: summary.finance.default_accounts_count }));
  }
  if (summary.finance.has_runway_overrides) {
    chips.push(t('system.overrideChipRunway'));
  }

  if (summary.diary.has_overrides) {
    chips.push(t('system.overrideChipDiary'));
  }
  if (summary.proactive.quiet_hours_enabled) {
    chips.push(
      t('system.overrideChipQuietHours', {
        start: summary.proactive.quiet_hours_start || '23:00',
        end: summary.proactive.quiet_hours_end || '07:00',
      }),
    );
  }
  if (summary.proactive.disabled_jobs.length > 0) {
    chips.push(
      t('system.overrideChipDisabledJobs', { count: summary.proactive.disabled_jobs.length }),
    );
  }
  if (summary.brain.custom_personas_count > 0) {
    chips.push(t('system.overrideChipPersonas', { count: summary.brain.custom_personas_count }));
  }
  if (summary.brain.disabled_builtin_skills.length > 0) {
    chips.push(
      t('system.overrideChipDisabledSkills', {
        count: summary.brain.disabled_builtin_skills.length,
      }),
    );
  }
  if (summary.miniapp.tabs && summary.miniapp.tabs.length > 0) {
    chips.push(t('system.overrideChipTabs', { count: summary.miniapp.tabs.length }));
  }
  if (summary.miniapp.account_themes_count > 0) {
    chips.push(t('system.overrideChipAccountRoles', { count: summary.miniapp.account_themes_count }));
  }

  return chips;
}

export const SystemTab: React.FC<SystemTabProps> = ({
  personaPresets,
  personaStyle,
  setPersonaStyle,
  customInstructions,
  setCustomInstructions,
  isSavingDirectives,
  directivesSavedMsg,
  handleSaveDirectives,
  loadingContext,
  lifeContext,
  contextDepth,
  setContextDepth,
  loadAssistantData,
  loadingDocs,
  loadDocsData,
  docSearchQuery,
  setDocSearchQuery,
  filteredDocChapters,
  docChapters,
  handleToggleChapter,
  onOpenDossierReader,
  onOpenSkillReader,
  initialOpenSection,
  skillsRefreshKey = 0,
  showConfirm,
  showAlert,
  triggerHaptic,
  userSettings,
  medications,
  medsLoading,
  isAddingMed,
  setIsAddingMed,
  newMedName,
  setNewMedName,
  newMedDosage,
  setNewMedDosage,
  newMedTimes,
  setNewMedTimes,
  newMedInstructions,
  setNewMedInstructions,
  isSubmittingMed,
  handleCreateMedication,
  handleTakeMed,
  handleSkipMed,
  handleDeleteMedication,
  accessInfo,
  onReloadSettings,
  onRefreshConfig,
  backupPrefix = 'tokio-backup',
  feedbackEnabled = true,
}) => {
  const { locale, setLocale, t, formatDate, formatNumber } = useI18n();
  const isAdmin = userSettings?.role === 'admin';

  // Profile preferences state
  const [baseCurrency, setBaseCurrency] = useState(userSettings?.base_currency || 'EUR');
  const [timezone, setTimezone] = useState(userSettings?.timezone || 'Europe/Moscow');
  const [summaryTime, setSummaryTime] = useState(userSettings?.summary_time || '07:00');
  const [modelProvider, setModelProvider] = useState(
    userSettings?.model_provider || accessInfo?.model_provider || 'gemini'
  );
  const [prevUserSettings, setPrevUserSettings] = useState(userSettings);

  // BYOK state
  const [localByokOverride, setLocalByokOverride] = useState<boolean | null>(null);
  const hasByokKey = localByokOverride ?? Boolean(accessInfo?.has_byok_key ?? userSettings?.has_byok_key);
  const [byokInput, setByokInput] = useState('');
  const [byokLoading, setByokLoading] = useState(false);
  const [byokMsg, setByokMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Backup & Restore state
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [backupMsg, setBackupMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  if (userSettings !== prevUserSettings) {
    setPrevUserSettings(userSettings);
    if (userSettings?.base_currency) setBaseCurrency(userSettings.base_currency);
    if (userSettings?.timezone) setTimezone(userSettings.timezone);
    if (userSettings?.summary_time) setSummaryTime(userSettings.summary_time);
    if (userSettings?.model_provider) setModelProvider(userSettings.model_provider);
    if (userSettings?.has_byok_key !== undefined) setLocalByokOverride(null);
  }

  // Section accordions
  const [openSection, setOpenSection] = useState<SystemSectionId | null>(() =>
    initialOpenSection ?? (isAdmin ? 'docs' : 'directives')
  );
  const [prevInitialSection, setPrevInitialSection] = useState(initialOpenSection);
  if (initialOpenSection !== prevInitialSection) {
    setPrevInitialSection(initialOpenSection);
    if (initialOpenSection) {
      setOpenSection(initialOpenSection);
    }
  }

  // Skills & Backlog state
  const [skillsData, setSkillsData] = useState<SkillsResponse | null>(null);
  const [backlogItems, setBacklogItems] = useState<BacklogItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillBusyId, setSkillBusyId] = useState<string | null>(null);
  const [backlogBusyId, setBacklogBusyId] = useState<string | null>(null);

  // Diagnostics & Session state
  const [diagData, setDiagData] = useState<DiagnosticsResponse | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [sessionResetting, setSessionResetting] = useState(false);
  const [showRawDiagText, setShowRawDiagText] = useState(false);

  // Server-side Docs Search state
  const [docSearchResult, setDocSearchResult] = useState<DocSearchResult | null>(null);

  // Active Settings, Presets & Routines card state
  const [togglingRoutineId, setTogglingRoutineId] = useState<string | null>(null);
  const [applyingPresetId, setApplyingPresetId] = useState<string | null>(null);
  const [prefsBusyAction, setPrefsBusyAction] = useState<'reset' | 'rollback' | null>(null);
  const [prefsToast, setPrefsToast] = useState<string | null>(null);
  const prefsToastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (prefsToastTimerRef.current) clearTimeout(prefsToastTimerRef.current);
    };
  }, []);

  const showPrefsToast = React.useCallback((message: string) => {
    if (prefsToastTimerRef.current) clearTimeout(prefsToastTimerRef.current);
    setPrefsToast(message);
    prefsToastTimerRef.current = setTimeout(() => {
      setPrefsToast(null);
    }, 3200);
  }, []);

  const refreshActiveConfig = React.useCallback(
    async (updatedSettings?: UserSettings) => {
      if (onRefreshConfig) {
        await onRefreshConfig(updatedSettings);
      } else if (onReloadSettings) {
        await onReloadSettings();
      }
    },
    [onRefreshConfig, onReloadSettings],
  );

  const isPrefsMutating =
    prefsBusyAction !== null || togglingRoutineId !== null || applyingPresetId !== null;

  const handleToggleRoutine = async (routineId: string, name: string, nextEnabled: boolean) => {
    if (isPrefsMutating) return;
    try {
      setTogglingRoutineId(routineId);
      triggerHaptic('light');
      const res = await toggleSettingsRoutine(routineId, nextEnabled);
      await refreshActiveConfig(res.settings);
      showPrefsToast(
        nextEnabled
          ? t('system.routineEnabledToast', { name })
          : t('system.routinePausedToast', { name }),
      );
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setTogglingRoutineId(null);
    }
  };

  const handleApplyPreset = async (presetId: string, name: string) => {
    if (isPrefsMutating) return;
    try {
      setApplyingPresetId(presetId);
      triggerHaptic('medium');
      const res = await applySettingsPreset(presetId);
      await refreshActiveConfig(res.settings);
      triggerHaptic('success');
      showPrefsToast(t('system.presetAppliedToast', { name }));
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setApplyingPresetId(null);
    }
  };

  const handleRollbackPrefs = async () => {
    if (isPrefsMutating) return;
    try {
      setPrefsBusyAction('rollback');
      triggerHaptic('medium');
      const res = await rollbackSettingsChange(1);
      await refreshActiveConfig(res.settings);
      triggerHaptic('success');
      showPrefsToast(t('system.prefsRolledBackToast'));
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setPrefsBusyAction(null);
    }
  };

  const handleResetAllPrefs = async () => {
    if (isPrefsMutating) return;
    if (showConfirm && !(await showConfirm(t('system.prefsResetConfirm')))) return;
    try {
      setPrefsBusyAction('reset');
      triggerHaptic('medium');
      const res = await resetSettingsToDefault('all');
      await refreshActiveConfig(res.settings);
      triggerHaptic('success');
      showPrefsToast(t('system.prefsResetToast'));
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setPrefsBusyAction(null);
    }
  };

  const loadSkillsAndBacklog = React.useCallback(async () => {
    try {
      setSkillsLoading(true);
      const [sk, bl] = await Promise.all([fetchSkills(), fetchBacklog()]);
      setSkillsData(sk);
      setBacklogItems(bl.items);
    } catch (err) {
      console.error('Failed to load skills/backlog:', err);
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const loadDiagnostics = React.useCallback(async () => {
    try {
      setDiagLoading(true);
      const d = await fetchDiagnostics();
      setDiagData(d);
    } catch (err) {
      console.error('Failed to load diagnostics:', err);
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (openSection === 'skills' && !skillsData) {
      void Promise.resolve().then(() => {
        if (!cancelled) void loadSkillsAndBacklog();
      });
    } else if (openSection === 'diagnostics' && !diagData) {
      void Promise.resolve().then(() => {
        if (!cancelled) void loadDiagnostics();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [openSection, skillsData, diagData, loadSkillsAndBacklog, loadDiagnostics]);

  useEffect(() => {
    if (skillsRefreshKey <= 0) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void loadSkillsAndBacklog();
    });
    return () => {
      cancelled = true;
    };
  }, [skillsRefreshKey, loadSkillsAndBacklog]);

  useEffect(() => {
    const q = docSearchQuery.trim();
    if (q.length < 2) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchDocs(q)
        .then((res) => {
          if (!cancelled) setDocSearchResult(res);
        })
        .catch(() => {
          if (!cancelled) setDocSearchResult({ query: q, topic: null, result: '' });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [docSearchQuery]);

  const toggleSection = (section: SystemSectionId) => {
    triggerHaptic('light');
    setOpenSection((prev) => (prev === section ? null : section));
  };

  const handleToggleUserSkill = async (skillId: string, action: 'activate' | 'reject') => {
    if (action === 'reject' && showConfirm && !(await showConfirm(t('skills.rejectConfirm')))) {
      return;
    }
    try {
      setSkillBusyId(skillId);
      triggerHaptic('medium');
      if (action === 'activate') {
        await activateUserSkill(skillId);
      } else {
        await rejectUserSkill(skillId);
      }
      triggerHaptic('success');
      await loadSkillsAndBacklog();
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSkillBusyId(null);
    }
  };

  const handleResolveBacklog = async (itemId: string, status: 'shipped' | 'rejected') => {
    try {
      setBacklogBusyId(itemId);
      triggerHaptic('medium');
      await resolveBacklogItem(itemId, status);
      triggerHaptic('success');
      setBacklogItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, status } : it)));
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBacklogBusyId(null);
    }
  };

  const handleResetSession = async () => {
    if (showConfirm && !(await showConfirm(t('system.diagResetConfirm')))) return;
    try {
      setSessionResetting(true);
      triggerHaptic('medium');
      await resetAgentSession();
      triggerHaptic('success');
      await loadDiagnostics();
      if (showAlert) await showAlert(t('system.diagResetDone'));
    } catch (err: unknown) {
      if (showAlert) await showAlert(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSessionResetting(false);
    }
  };

  const handleSaveAll = () => {
    handleSaveDirectives({
      base_currency: baseCurrency.toUpperCase(),
      timezone: timezone.trim(),
      summary_time: summaryTime,
      model_provider: modelProvider,
    });
  };

  const handleSaveByok = async () => {
    const key = byokInput.trim();
    if (!key) {
      setByokMsg({ type: 'error', text: t('system.byokMissing') });
      return;
    }
    try {
      setByokLoading(true);
      setByokMsg(null);
      triggerHaptic('medium');
      await saveByokKey(key, modelProvider);
      setLocalByokOverride(true);
      setByokInput('');
      setByokMsg({ type: 'success', text: t('system.byokSaved') });
      triggerHaptic('success');
      if (onReloadSettings) await onReloadSettings();
    } catch (err: unknown) {
      console.error('Failed to save BYOK key:', err);
      const msg = err instanceof Error ? err.message : t('system.byokErrSave');
      setByokMsg({ type: 'error', text: msg });
    } finally {
      setByokLoading(false);
    }
  };

  const handleClearByok = async () => {
    try {
      setByokLoading(true);
      setByokMsg(null);
      triggerHaptic('medium');
      await clearByokKey();
      setLocalByokOverride(false);
      setByokInput('');
      setByokMsg({ type: 'success', text: t('system.byokCleared') });
      triggerHaptic('success');
      if (onReloadSettings) await onReloadSettings();
    } catch (err: unknown) {
      console.error('Failed to clear BYOK key:', err);
      const msg = err instanceof Error ? err.message : t('system.byokErrClear');
      setByokMsg({ type: 'error', text: msg });
    } finally {
      setByokLoading(false);
    }
  };

  const handleExportBackup = async () => {
    try {
      setIsExportingBackup(true);
      setBackupMsg(null);
      triggerHaptic('medium');
      const data = await exportBackupJson();
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateStr = new Date().toISOString().slice(0, 10);
      a.download = `${backupPrefix}_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      triggerHaptic('success');
      setBackupMsg({ type: 'success', text: t('system.backupExportOk') });
    } catch (err: unknown) {
      console.error('Failed to export backup:', err);
      const msg = err instanceof Error ? err.message : t('system.backupExportErr');
      setBackupMsg({ type: 'error', text: msg });
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setIsRestoringBackup(true);
      setBackupMsg(null);
      triggerHaptic('medium');
      const text = await file.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(t('system.backupInvalidJson'));
      }
      const res = await restoreBackupJson(parsed, restoreMode);
      triggerHaptic('success');
      let details = '';
      if (res.restored) {
        const parts = Object.entries(res.restored)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        details = ` (${parts})`;
      }
      setBackupMsg({
        type: 'success',
        text: t('system.backupRestoreOk', {
          mode: restoreMode === 'merge' ? 'Merge' : 'Replace',
          details,
        }),
      });
      if (onReloadSettings) await onReloadSettings();
    } catch (err: unknown) {
      console.error('Failed to restore backup:', err);
      const msg = err instanceof Error ? err.message : t('system.backupRestoreErr');
      setBackupMsg({ type: 'error', text: msg });
    } finally {
      setIsRestoringBackup(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Meds count logic
  const meds = medications || [];
  let totalLogs = 0;
  let takenLogs = 0;
  let pendingLogs = 0;

  for (const m of meds) {
    if (m.today_logs) {
      for (const log of m.today_logs) {
        totalLogs += 1;
        if (log.status === 'taken') takenLogs += 1;
        else if (log.status === 'pending') pendingLogs += 1;
      }
    }
  }

  const pct = totalLogs > 0 ? Math.round((takenLogs / totalLogs) * 100) : 0;

  return (
    <div className="assistant-container" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Hero Banner */}
      <div className="assistant-hero-card">
        <div className="assistant-hero-header">
          <Sparkles size={20} color="var(--accent-color)" />
          <div className="assistant-hero-title">
            {isAdmin ? t('system.heroTitleAdmin') : t('system.heroTitleUser')}
          </div>
        </div>
        <div className="assistant-hero-desc">
          {isAdmin ? t('system.heroDescAdmin') : t('system.heroDescUser')}
        </div>
      </div>

      {/* Language Selector Card (RU | EN | SR | JA) */}
      <div className="system-accordion-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Globe size={18} color="var(--accent-color)" />
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t('system.languageTitle')}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t('system.languageDesc')}</div>
          </div>
        </div>
        <div
          role="group"
          aria-label={t('system.languageTitle')}
          style={{
            display: 'inline-flex',
            gap: 4,
            background: 'rgba(255, 255, 255, 0.04)',
            padding: 3,
            borderRadius: 10,
            border: '1px solid var(--border-hairline)',
          }}
        >
          {SUPPORTED_LOCALES.map((code: LocaleCode) => {
            const active = locale === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  void setLocale(code);
                }}
                aria-pressed={active}
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: active ? 700 : 500,
                  background: active ? 'var(--accent-color)' : 'transparent',
                  color: active ? 'var(--accent-text, #0c0d10)' : 'var(--text-secondary)',
                  transition: 'all 0.15s ease',
                }}
              >
                {LOCALE_LABELS[code]}
              </button>
            );
          })}
        </div>
      </div>

      {/* SECTION 0: Feedback */}
      {feedbackEnabled && <FeedbackPanel isAdmin={isAdmin} />}

      {/* Compact Active Settings, Presets & Routines Card */}
      {(() => {
        const overrideChips = buildActiveOverrideChips(userSettings, t, formatNumber);
        const presets = userSettings?.presets ?? [];
        const routines = userSettings?.routines ?? [];
        const historyCount = userSettings?.prefs_summary?.history_count ?? 0;
        const hasOverrides = Boolean(userSettings?.prefs_summary?.has_overrides) || overrideChips.length > 0;
        const activeRoutinesCount = routines.filter((r) => r.enabled).length;
        const isDefaultOnly =
          !hasOverrides && presets.length === 0 && routines.length === 0 && historyCount === 0;

        return (
          <section className="system-accordion-card prefs-overview-card" aria-label={t('system.activeConfigTitle')}>
            <div className="prefs-overview-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <SlidersHorizontal size={18} strokeWidth={1.75} color="var(--accent-color)" style={{ flexShrink: 0 }} />
                <span className="prefs-overview-title">{t('system.activeConfigTitle')}</span>
              </div>
              <span className={`prefs-overview-badge tabular-nums ${overrideChips.length > 0 ? 'has-overrides' : ''}`}>
                {overrideChips.length > 0
                  ? t('system.activeConfigOverridesBadge', { count: overrideChips.length })
                  : t('system.activeConfigDefaultBadge')}
              </span>
            </div>

            {prefsToast && (
              <div className="prefs-inline-toast" role="status">
                <Check size={13} strokeWidth={2.25} />
                <span>{prefsToast}</span>
              </div>
            )}

            {isDefaultOnly && (
              <p className="prefs-default-hint">{t('system.activeConfigDefaultHint')}</p>
            )}

            {overrideChips.length > 0 && (
              <div className="prefs-overrides-wrap">
                {overrideChips.map((chip) => (
                  <span key={chip} className="prefs-override-chip tabular-nums">
                    {chip}
                  </span>
                ))}
              </div>
            )}

            {presets.length > 0 && (
              <div className="prefs-subsection">
                <div className="prefs-subsection-label">
                  <Layers size={13.5} strokeWidth={1.75} color="var(--accent-color)" />
                  <span>{t('system.presetsSectionLabel')}</span>
                </div>
                <div className="prefs-presets-row">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="prefs-preset-chip"
                      disabled={isPrefsMutating}
                      onClick={() => void handleApplyPreset(preset.id, preset.name)}
                      title={preset.description || preset.name}
                    >
                      <span>{applyingPresetId === preset.id ? t('common.loading') : preset.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {routines.length > 0 && (
              <div className="prefs-subsection">
                <div className="prefs-subsection-label">
                  <Clock size={13.5} strokeWidth={1.75} color="var(--accent-color)" />
                  <span>{t('system.routinesSectionLabel')}</span>
                  <span className="prefs-subsection-count tabular-nums">
                    {activeRoutinesCount}/{routines.length}
                  </span>
                </div>
                <div className="prefs-routines-list">
                  {routines.map((routine) => (
                    <div key={routine.id} className={`prefs-routine-row ${routine.enabled ? '' : 'is-paused'}`}>
                      <div className="prefs-routine-info">
                        <div className="prefs-routine-name">{routine.name}</div>
                        <div className="prefs-routine-meta tabular-nums">
                          <span>
                            {formatRoutineScheduleLabel(routine, t)} · {routine.time} ·{' '}
                            {formatRoutineKindLabel(routine, t)}
                          </span>
                          {routine.tool_access === 'allow_writes' && (
                            <span className="prefs-routine-writes-badge">{t('system.routineWritesBadge')}</span>
                          )}
                        </div>
                      </div>
                      <label className="prefs-switch-label">
                        <input
                          ref={bindNativeSwitchAttr}
                          type="checkbox"
                          className="prefs-switch-input"
                          role="switch"
                          aria-checked={routine.enabled}
                          aria-label={t('system.routineToggleAria', { name: routine.name })}
                          checked={routine.enabled}
                          disabled={isPrefsMutating}
                          onChange={() => void handleToggleRoutine(routine.id, routine.name, !routine.enabled)}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(hasOverrides || routines.length > 0 || historyCount > 0) && (
              <div className="prefs-footer-actions">
                {historyCount > 0 && (
                  <button
                    type="button"
                    className="prefs-action-btn"
                    disabled={isPrefsMutating}
                    onClick={() => void handleRollbackPrefs()}
                  >
                    <Undo2 size={13.5} strokeWidth={1.75} />
                    <span className="tabular-nums">
                      {t('system.prefsRollbackBtn', { count: historyCount })}
                    </span>
                  </button>
                )}
                {(hasOverrides || routines.length > 0) && (
                  <button
                    type="button"
                    className="prefs-action-btn danger"
                    disabled={isPrefsMutating}
                    onClick={() => void handleResetAllPrefs()}
                  >
                    <RotateCcw size={13.5} strokeWidth={1.75} />
                    <span>{t('system.prefsResetBtn')}</span>
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })()}

      {/* SECTION 1: Thinking Style & Directives + Profile */}
      <div className="system-accordion-card">
        <button
          type="button"
          className="system-accordion-trigger"
          onClick={() => toggleSection('directives')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Brain size={18} color="var(--accent-color)" />
            <span>{t('system.directivesTitle')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {directivesSavedMsg && (
              <span className="directives-saved-toast" style={{ margin: 0, padding: '2px 8px', fontSize: 11 }}>
                <Check size={12} /> {t('common.saved')}
              </span>
            )}
            {openSection === 'directives' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {openSection === 'directives' && (
          <div className="system-accordion-body">
            {/* Daily AI Quota Badge for Non-Admins */}
            {!isAdmin && userSettings?.daily_msg_limit !== undefined && userSettings.daily_msg_limit > 0 && (
              <div className="quota-badge-container">
                <div className="quota-badge-label">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Zap size={14} color="var(--accent-color)" />
                    <span>{t('system.dailyQuota')}</span>
                  </div>
                  <span className="tabular-nums" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {userSettings.daily_msg_used ?? 0} / {userSettings.daily_msg_limit}
                  </span>
                </div>
                <div className="quota-progress-track">
                  <div
                    className="quota-progress-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(((userSettings.daily_msg_used ?? 0) / userSettings.daily_msg_limit) * 100)
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* BYOK Section */}
            <div
              className="byok-card-section"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  <Key size={14} color="var(--accent-color)" />
                  <span>{t('system.byokTitle')}</span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: hasByokKey ? 'rgba(16, 185, 129, 0.16)' : 'rgba(245, 158, 11, 0.16)',
                    color: hasByokKey ? '#34d399' : '#f59e0b',
                    border: hasByokKey ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(245, 158, 11, 0.3)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {hasByokKey ? `${t('system.byokActive')} (${modelProvider})` : t('system.byokShared')}
                </span>
              </div>

              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                {t('system.byokDesc')}
              </span>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                {PROVIDER_OPTIONS.map((prov) => {
                  const selected = modelProvider === prov.id;
                  return (
                    <button
                      key={prov.id}
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        setModelProvider(prov.id);
                      }}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: selected ? '1px solid var(--accent-color)' : '1px solid var(--border-hairline)',
                        background: selected ? 'rgba(245, 158, 11, 0.16)' : 'rgba(255, 255, 255, 0.04)',
                        color: selected ? 'var(--accent-color)' : 'var(--text-secondary)',
                        fontSize: 12,
                        fontWeight: selected ? 700 : 500,
                        cursor: 'pointer',
                      }}
                    >
                      {prov.label}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <input
                  type="password"
                  placeholder={t('system.byokPlaceholder')}
                  value={byokInput}
                  onChange={(e) => setByokInput(e.target.value)}
                  style={{
                    flex: '1 1 180px',
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(0, 0, 0, 0.35)',
                    border: '1px solid var(--border-hairline)',
                    color: 'var(--text-primary)',
                    fontSize: 12.5,
                  }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveByok}
                  disabled={byokLoading || !byokInput.trim()}
                  style={{ padding: '7px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  {byokLoading ? t('common.saving') : t('system.byokSave')}
                </button>
                {hasByokKey && (
                  <button
                    type="button"
                    onClick={handleClearByok}
                    disabled={byokLoading}
                    style={{
                      padding: '7px 12px',
                      fontSize: 12.5,
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(239, 68, 68, 0.12)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#fca5a5',
                      cursor: 'pointer',
                    }}
                  >
                    {t('system.byokClear')}
                  </button>
                )}
              </div>

              {byokMsg && (
                <div
                  style={{
                    fontSize: 12,
                    color: byokMsg.type === 'success' ? '#34d399' : '#fca5a5',
                    marginTop: 2,
                  }}
                >
                  {byokMsg.text}
                </div>
              )}
            </div>

            {/* JSON Backup & Restore */}
            <div
              className="backup-card-section"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  <Database size={14} color="var(--accent-color)" />
                  <span>{t('system.backupTitle')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('system.backupMode')}</label>
                  <select
                    value={restoreMode}
                    onChange={(e) => setRestoreMode(e.target.value as 'merge' | 'replace')}
                    style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: 'rgba(0, 0, 0, 0.4)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-secondary)',
                      fontSize: 11,
                    }}
                  >
                    <option value="merge">{t('system.backupMerge')}</option>
                    <option value="replace">{t('system.backupReplace')}</option>
                  </select>
                </div>
              </div>

              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                {t('system.backupDesc')}
              </span>

              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleExportBackup}
                  disabled={isExportingBackup}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid var(--border-hairline)',
                    color: 'var(--text-primary)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Download size={13} color="var(--accent-color)" />
                  <span>{isExportingBackup ? t('system.backupExporting') : t('system.backupExport')}</span>
                </button>

                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRestoringBackup}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid var(--border-hairline)',
                    color: 'var(--text-primary)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Upload size={13} color="var(--accent-color)" />
                  <span>{isRestoringBackup ? t('system.backupRestoring') : t('system.backupRestore')}</span>
                </button>
              </div>

              {backupMsg && (
                <div
                  style={{
                    fontSize: 12,
                    color: backupMsg.type === 'success' ? '#34d399' : '#fca5a5',
                    marginTop: 2,
                  }}
                >
                  {backupMsg.text}
                </div>
              )}
            </div>

            {/* Currency Selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                <Coins size={14} color="var(--accent-color)" />
                <span>{t('system.baseCurrency')}</span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {CURRENCY_OPTIONS.map((c) => {
                  const isSelected = baseCurrency.toUpperCase() === c.code;
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        setBaseCurrency(c.code);
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-sm)',
                        background: isSelected ? 'rgba(245, 158, 11, 0.16)' : 'rgba(255, 255, 255, 0.04)',
                        border: isSelected ? '1px solid var(--accent-color)' : '1px solid var(--border-hairline)',
                        color: isSelected ? 'var(--accent-color)' : 'var(--text-secondary)',
                        fontSize: 12.5,
                        fontWeight: isSelected ? 700 : 500,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Timezone Selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <label
                htmlFor="profile-timezone"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                <Clock size={14} color="var(--accent-color)" />
                <span>{t('system.timezone')}</span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {TIMEZONE_PRESETS.map((tz) => {
                  const isPreset = timezone === tz;
                  return (
                    <button
                      key={tz}
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        setTimezone(tz);
                      }}
                      style={{
                        padding: '3px 8px',
                        borderRadius: '12px',
                        fontSize: 11.5,
                        background: isPreset ? 'rgba(245, 158, 11, 0.16)' : 'rgba(255, 255, 255, 0.04)',
                        border: isPreset ? '1px solid var(--accent-color)' : '1px solid var(--border-hairline)',
                        color: isPreset ? 'var(--accent-color)' : 'var(--text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      {tz}
                    </button>
                  );
                })}
              </div>
              <input
                id="profile-timezone"
                type="text"
                className="input-field"
                placeholder="Europe/Moscow"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </div>

            {/* Summary Digest Time */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <label
                htmlFor="profile-summary-time"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                <Clock size={14} color="var(--accent-color)" />
                <span>{t('system.summaryTime')}</span>
              </label>
              <input
                id="profile-summary-time"
                type="time"
                className="input-field"
                value={summaryTime}
                onChange={(e) => setSummaryTime(e.target.value)}
              />
            </div>

            {/* Persona Presets Grid */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('system.personaStyleLabel')}
              </label>
              <div className="persona-presets-grid">
                {personaPresets.map((preset) => {
                  const isActive = personaStyle === preset.id;
                  const cleanTitle = preset.title.replace(/^[^\p{L}\p{N}]+\s*/u, '');
                  const badge = getPresetBadge(preset, t);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`persona-preset-btn ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        triggerHaptic('light');
                        setPersonaStyle(preset.id);
                      }}
                    >
                      <div className="persona-preset-header">
                        <div className="preset-title">
                          {getPresetIcon(preset.id)}
                          <span>{cleanTitle}</span>
                        </div>
                        {isActive && (
                          <span className="preset-active-check" title={t('system.selectedTitle')}>
                            <Check size={10} strokeWidth={2.75} />
                          </span>
                        )}
                      </div>
                      {badge && <span className="preset-tag-badge">{badge}</span>}
                      <div className="preset-desc">{preset.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom Instructions Textarea */}
            <label
              id="directives-label"
              style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 2, marginTop: 4 }}
            >
              {t('system.directivesLabel')}
            </label>
            <textarea
              className="directives-textarea"
              aria-labelledby="directives-label"
              aria-label={t('system.directivesLabel')}
              placeholder={t('system.directivesPlaceholder')}
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
            />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {t('system.priorityHint')}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={isSavingDirectives}
                onClick={handleSaveAll}
                style={{ padding: '8px 16px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {isSavingDirectives ? (
                  t('common.saving')
                ) : directivesSavedMsg ? (
                  <>
                    <Check size={14} /> {t('common.saved')}
                  </>
                ) : (
                  t('system.saveSettings')
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* SECTION 2: Medications */}
      <div className="system-accordion-card">
        <button
          type="button"
          className="system-accordion-trigger"
          onClick={() => toggleSection('meds')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Pill size={18} color="var(--accent-color)" />
            <span>{t('system.medsTitle')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: '12px',
                background: 'rgba(255, 255, 255, 0.06)',
                color:
                  meds.length === 0
                    ? 'var(--text-muted)'
                    : takenLogs === totalLogs && totalLogs > 0
                    ? '#10b981'
                    : 'var(--accent-color)',
              }}
            >
              {meds.length === 0 ? t('meds.noActiveCourses') : t('meds.takenCountBadge', { taken: takenLogs, total: totalLogs })}
            </span>
            {openSection === 'meds' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {openSection === 'meds' && (
          <div className="system-accordion-body">
            {/* Top Stats Banner */}
            <div className="med-summary-card">
              <div className="med-summary-header">
                <div>
                  <div className="med-summary-title">{t('meds.todayIntake')}</div>
                  <div className="med-summary-sub">
                    {totalLogs === 0
                      ? t('meds.emptyBanner')
                      : pendingLogs === 0
                      ? t('meds.allTaken')
                      : t('meds.remainingBanner', { pending: pendingLogs, total: totalLogs })}
                  </div>
                </div>
                {totalLogs > 0 && (
                  <span className="med-summary-badge">
                    {takenLogs} / {totalLogs}
                  </span>
                )}
              </div>

              {totalLogs > 0 && (
                <div className="med-progress-track">
                  <div className="med-progress-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>

            {/* Today's Schedule Section */}
            <div className="section-header-row" style={{ marginTop: 4 }}>
              <span className="section-title">{t('meds.todaySchedule')}</span>
              {setIsAddingMed && (
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setIsAddingMed(!isAddingMed)}
                  style={{ fontSize: 13, fontWeight: 600 }}
                >
                  {isAddingMed ? t('common.cancel') : t('meds.addMed')}
                </button>
              )}
            </div>

            {/* Add Medication Form */}
            {isAddingMed && handleCreateMedication && (
              <form onSubmit={handleCreateMedication} className="med-form-card">
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                  {t('meds.newMedTitle')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input
                    type="text"
                    className="input-field"
                    aria-label={t('meds.namePlaceholder')}
                    placeholder={t('meds.namePlaceholder')}
                    value={newMedName || ''}
                    onChange={(e) => setNewMedName?.(e.target.value)}
                    required
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      className="input-field"
                      style={{ flex: 1 }}
                      aria-label={t('meds.dosagePlaceholder')}
                      placeholder={t('meds.dosagePlaceholder')}
                      value={newMedDosage || ''}
                      onChange={(e) => setNewMedDosage?.(e.target.value)}
                      required
                    />
                    <input
                      type="text"
                      className="input-field"
                      style={{ flex: 1 }}
                      aria-label={t('meds.timesPlaceholder')}
                      placeholder={t('meds.timesPlaceholder')}
                      value={newMedTimes || ''}
                      onChange={(e) => setNewMedTimes?.(e.target.value)}
                      required
                    />
                  </div>
                  <input
                    type="text"
                    className="input-field"
                    aria-label={t('meds.instructionsPlaceholder')}
                    placeholder={t('meds.instructionsPlaceholder')}
                    value={newMedInstructions || ''}
                    onChange={(e) => setNewMedInstructions?.(e.target.value)}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => setIsAddingMed?.(false)}
                      style={{ fontSize: 13 }}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={isSubmittingMed}
                      style={{ padding: '6px 14px', fontSize: 13 }}
                    >
                      {isSubmittingMed ? t('common.saving') : t('meds.saveCourse')}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {medsLoading && meds.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)', fontSize: 12.5 }}>
                {t('meds.loadingCourses')}
              </div>
            ) : meds.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
                {t('meds.emptyShort')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {meds.map((med) => {
                  const todayLogs = med.today_logs || [];
                  return (
                    <div key={med.id} className="med-card">
                      <div className="med-card-header">
                        <div>
                          <div className="med-card-title">{med.name}</div>
                          <div className="med-card-dosage">
                            {med.dosage} · {med.frequency}
                          </div>
                        </div>
                        {handleDeleteMedication && (
                          <button
                            type="button"
                            className="btn-link"
                            onClick={() => {
                              triggerHaptic('medium');
                              handleDeleteMedication(med.id);
                            }}
                            title={t('meds.deleteMed')}
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      {med.instructions && (
                        <div className="med-card-instructions">{med.instructions}</div>
                      )}

                      {/* Scheduled slots for today */}
                      <div className="med-slots-row">
                        {todayLogs.map((log, idx) => {
                          const isTaken = log.status === 'taken';
                          const isSkipped = log.status === 'skipped';
                          return (
                            <div key={idx} className={`med-slot-pill ${log.status}`}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Clock size={12} />
                                <span>{log.scheduled_time}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {!isTaken && handleTakeMed && (
                                  <button
                                    type="button"
                                    className="med-action-btn take"
                                    onClick={() => {
                                      triggerHaptic('success');
                                      handleTakeMed(med.id, log.scheduled_time);
                                    }}
                                  >
                                    {t('meds.takeShort')}
                                  </button>
                                )}
                                {!isTaken && !isSkipped && handleSkipMed && (
                                  <button
                                    type="button"
                                    className="med-action-btn skip"
                                    onClick={() => {
                                      triggerHaptic('light');
                                      handleSkipMed(med.id, log.scheduled_time);
                                    }}
                                  >
                                    {t('meds.skipShort')}
                                  </button>
                                )}
                                {isTaken && (
                                  <span style={{ color: '#10b981', fontSize: 11, fontWeight: 600 }}>
                                    ✓ {t('meds.taken')}
                                  </span>
                                )}
                                {isSkipped && (
                                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                    {t('meds.skipped')}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* SECTION 3: Runtime Skills & Evolution Backlog */}
      <div className="system-accordion-card">
        <button
          type="button"
          className="system-accordion-trigger"
          onClick={() => toggleSection('skills')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Wrench size={18} color="var(--accent-color)" />
            <span>{t('skills.sectionTitle')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {skillsData && (
              <span
                className="tabular-nums"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: 'var(--accent-color)',
                }}
              >
                {skillsData.builtin.length + skillsData.user.length}
              </span>
            )}
            {openSection === 'skills' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {openSection === 'skills' && (
          <div className="system-accordion-body">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                {t('skills.sectionDesc')}
              </p>
              <button
                type="button"
                className="btn-link"
                disabled={skillsLoading}
                onClick={() => {
                  triggerHaptic('light');
                  void loadSkillsAndBacklog();
                }}
                style={{ fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
              >
                <RefreshCw size={12} className={skillsLoading ? 'spin-icon' : ''} />
                <span>{skillsLoading ? t('common.loading') : t('common.refresh')}</span>
              </button>
            </div>

            {skillsLoading && !skillsData ? (
              <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
                {t('common.loading')}
              </div>
            ) : (
              <>
                {skillsData && skillsData.builtin.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="section-title" style={{ fontSize: 12.5 }}>
                      {t('skills.builtinHeader')} ({skillsData.builtin.length})
                    </span>
                    {skillsData.builtin.map((sk) => (
                      <div
                        key={sk.id}
                        className="doc-chapter-card reader-preview-card"
                        style={{ marginBottom: 0, padding: '10px 12px' }}
                        onClick={() => {
                          triggerHaptic('light');
                          onOpenSkillReader?.({
                            source: 'builtin',
                            id: sk.id,
                            title: sk.name,
                            subtitle: `${sk.id}.md`,
                            triggers: sk.triggers,
                            body: sk.body,
                          });
                        }}
                      >
                        <div className="doc-chapter-header">
                          <span className="doc-chapter-title">{sk.name}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {sk.disabled && (
                              <span className="doc-chapter-badge">{t('skills.disabledBadge')}</span>
                            )}
                            <span className="doc-chapter-badge">{t('skills.builtinBadge')}</span>
                            <ChevronRight size={14} color="var(--text-muted)" />
                          </div>
                        </div>
                        {sk.description && (
                          <div className="note-preview-snippet" style={{ marginTop: 4 }}>
                            {sk.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  <span className="section-title" style={{ fontSize: 12.5 }}>
                    {t('skills.userHeader')} ({skillsData?.user.length ?? 0})
                  </span>
                  {!skillsData || skillsData.user.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {t('skills.emptyUser')}
                    </div>
                  ) : (
                    skillsData.user.map((sk) => (
                      <div
                        key={sk.id}
                        className="doc-chapter-card reader-preview-card"
                        style={{ marginBottom: 0, padding: '10px 12px' }}
                        onClick={() => {
                          triggerHaptic('light');
                          onOpenSkillReader?.({
                            source: 'user',
                            id: sk.id,
                            title: sk.title || sk.key,
                            subtitle: `${sk.key} · v${sk.version}`,
                            status: sk.status,
                            body: sk.body,
                            runs: sk.runs,
                            views: sk.views,
                          });
                        }}
                      >
                        <div className="doc-chapter-header">
                          <span className="doc-chapter-title">
                            #{sk.id} {sk.key}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="doc-chapter-badge tabular-nums">
                              {sk.status} · {sk.runs}/{sk.views}
                            </span>
                            <ChevronRight size={14} color="var(--text-muted)" />
                          </div>
                        </div>
                        <div
                          style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 0 }}>{sk.title}</span>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {sk.status !== 'active' && (
                              <button
                                type="button"
                                className="admin-btn-action admin-btn-approve"
                                disabled={skillBusyId === sk.id}
                                onClick={() => void handleToggleUserSkill(sk.id, 'activate')}
                              >
                                <Check size={12} />
                                <span>{t('skills.activateBtn')}</span>
                              </button>
                            )}
                            {(sk.status === 'pending' || sk.status === 'active') && (
                              <button
                                type="button"
                                className="admin-btn-action admin-btn-danger"
                                disabled={skillBusyId === sk.id}
                                onClick={() => void handleToggleUserSkill(sk.id, 'reject')}
                              >
                                <X size={12} />
                                <span>{sk.status === 'active' ? t('skills.disableBtn') : t('skills.rejectBtn')}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  <span className="section-title" style={{ fontSize: 12.5 }}>
                    {t('skills.backlogHeader')} ({backlogItems.filter((b) => b.status === 'pending').length})
                  </span>
                  {backlogItems.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {t('skills.emptyBacklog')}
                    </div>
                  ) : (
                    backlogItems.map((item) => (
                      <div key={item.id} className="admin-card" style={{ padding: '10px 12px', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {item.category === 'bug' ? (
                              <Bug size={14} color="#f59e0b" />
                            ) : (
                              <Lightbulb size={14} color="var(--accent-color)" />
                            )}
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{item.title}</span>
                          </div>
                          <span className="doc-chapter-badge">{item.status}</span>
                        </div>
                        {item.status === 'pending' && (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                            <button
                              type="button"
                              className="admin-btn-action admin-btn-approve"
                              disabled={backlogBusyId === item.id}
                              onClick={() => void handleResolveBacklog(item.id, 'shipped')}
                            >
                              <Check size={12} />
                              <span>{t('skills.resolveShipped')}</span>
                            </button>
                            <button
                              type="button"
                              className="admin-btn-action admin-btn-danger"
                              disabled={backlogBusyId === item.id}
                              onClick={() => void handleResolveBacklog(item.id, 'rejected')}
                            >
                              <X size={12} />
                              <span>{t('skills.rejectBtn')}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* SECTION 3B: Agent Diagnostics & Session Reset */}
      <div className="system-accordion-card">
        <button
          type="button"
          className="system-accordion-trigger"
          onClick={() => toggleSection('diagnostics')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Activity size={18} color="var(--accent-color)" />
            <span>{t('system.diagTitle')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {diagData && (
              <span
                className="tabular-nums"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: diagData.last_failure ? '#f59e0b' : '#34d399',
                }}
              >
                {diagData.model_provider}
              </span>
            )}
            {openSection === 'diagnostics' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {openSection === 'diagnostics' && (
          <div className="system-accordion-body">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                {t('system.diagDesc')}
              </p>
              <button
                type="button"
                className="btn-link"
                disabled={diagLoading}
                onClick={() => {
                  triggerHaptic('light');
                  void loadDiagnostics();
                }}
                style={{ fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
              >
                <RefreshCw size={12} className={diagLoading ? 'spin-icon' : ''} />
                <span>{diagLoading ? t('common.loading') : t('common.refresh')}</span>
              </button>
            </div>

            {diagLoading && !diagData ? (
              <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
                {t('common.loading')}
              </div>
            ) : diagData ? (
              <>
                <div className="admin-stat-row">
                  <div className="admin-stat-box">
                    <span className="title">{t('system.diagThreadMessages')}</span>
                    <span className="val tabular-nums">{diagData.thread.count}</span>
                  </div>
                  <div className="admin-stat-box">
                    <span className="title">{t('system.diagTokens')}</span>
                    <span className="val tabular-nums">{formatNumber(diagData.usage.total_tokens)}</span>
                  </div>
                  <div className="admin-stat-box">
                    <span className="title">{t('system.diagCost')}</span>
                    <span className="val tabular-nums">
                      ${diagData.usage.total_cost_usd.toFixed(2)}
                    </span>
                  </div>
                </div>

                {diagData.turn_trace && (
                  <div className="admin-card" style={{ padding: '10px 12px', gap: 4 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{t('system.diagLastTurn')}</div>
                    <div className="tabular-nums" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      stage: {diagData.turn_trace.stage || '—'} · calls: {diagData.turn_trace.modelCalls ?? 0}
                      {diagData.turn_trace.updatedAt ? ` · ${formatDate(diagData.turn_trace.updatedAt)}` : ''}
                    </div>
                  </div>
                )}

                {diagData.last_failure && (
                  <div
                    className="admin-card"
                    style={{
                      padding: '10px 12px',
                      borderColor: 'rgba(245, 158, 11, 0.35)',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f59e0b', fontSize: 12.5, fontWeight: 600 }}>
                      <AlertTriangle size={14} />
                      <span>{t('system.diagLastFailure')}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                      {diagData.last_failure.message || `HTTP ${diagData.last_failure.status ?? 0}`}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ fontSize: 12 }}
                    onClick={() => setShowRawDiagText((p) => !p)}
                  >
                    {showRawDiagText ? t('system.diagHideRaw') : t('system.diagShowRaw')}
                  </button>
                  <button
                    type="button"
                    className="admin-btn-action admin-btn-danger"
                    disabled={sessionResetting}
                    onClick={() => void handleResetSession()}
                    style={{ padding: '6px 12px' }}
                  >
                    <RotateCcw size={13} />
                    <span>{sessionResetting ? t('common.loading') : t('system.diagResetSession')}</span>
                  </button>
                </div>

                {showRawDiagText && (
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 11.5,
                      lineHeight: 1.45,
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(0, 0, 0, 0.35)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-secondary)',
                      margin: 0,
                    }}
                  >
                    {diagData.summary_text}
                  </pre>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* SECTION 4: Grounding Dossier (ADMIN ONLY) */}
      {isAdmin && (
        <div className="system-accordion-card">
          <button
            type="button"
            className="system-accordion-trigger"
            onClick={() => toggleSection('dossier')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BookOpen size={18} color="var(--accent-color)" />
              <span>{t('system.dossierTitle')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                className="tabular-nums"
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: 'var(--accent-color)',
                }}
              >
                {contextDepth === 2 ? t('system.graphTwoRings') : t('system.graphOneRing')}
              </span>
              {openSection === 'dossier' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>
          </button>

          {openSection === 'dossier' && (
            <div className="system-accordion-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                  {t('system.dossierDesc')}
                </p>
                <button
                  type="button"
                  className="btn-link"
                  disabled={loadingContext}
                  onClick={() => {
                    triggerHaptic('light');
                    loadAssistantData(contextDepth);
                  }}
                  style={{ fontSize: 12.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                >
                  <RefreshCw size={12} className={loadingContext ? 'spin-icon' : ''} />
                  <span>{loadingContext ? t('common.loading') : t('common.refresh')}</span>
                </button>
              </div>

              {/* Graph Depth Toggle Pills */}
              <div className="graph-depth-container">
                <span className="graph-depth-label">{t('system.graphDepth')}</span>
                <div className="graph-depth-selector">
                  <button
                    type="button"
                    className={`graph-depth-pill ${contextDepth === 1 ? 'active' : ''}`}
                    onClick={() => {
                      if (contextDepth !== 1) {
                        triggerHaptic('light');
                        setContextDepth(1);
                        loadAssistantData(1);
                      }
                    }}
                  >
                    {t('system.graphBasic')}
                  </button>
                  <button
                    type="button"
                    className={`graph-depth-pill ${contextDepth === 2 ? 'active' : ''}`}
                    onClick={() => {
                      if (contextDepth !== 2) {
                        triggerHaptic('light');
                        setContextDepth(2);
                        loadAssistantData(2);
                      }
                    }}
                  >
                    {t('system.graphDeep')}
                  </button>
                </div>
              </div>

              {loadingContext && !lifeContext ? (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12.5 }}>
                  {t('system.dossierLoading')}
                </div>
              ) : lifeContext ? (
                <div
                  className="doc-chapter-card reader-preview-card"
                  onClick={() => {
                    triggerHaptic('light');
                    onOpenDossierReader?.();
                  }}
                >
                  <div className="doc-chapter-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <BookOpen size={14} color="var(--accent-color)" />
                      <span className="doc-chapter-title">{t('system.openDossierReader')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="graph-depth-badge tabular-nums">
                        {contextDepth === 2 ? t('system.graphTwoRings') : t('system.graphOneRing')}
                      </span>
                      <span className="doc-chapter-badge">{t('system.readBtn')}</span>
                      <ChevronRight size={14} color="var(--text-muted)" />
                    </div>
                  </div>
                  <div className="note-preview-snippet" style={{ marginTop: 6 }}>
                    {stripMarkdownInline(lifeContext.slice(0, 260))}
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)', fontSize: 12.5 }}>
                  {t('system.dossierEmptyHint')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SECTION 5: Docs (ADMIN ONLY) */}
      {isAdmin && (
        <div className="system-accordion-card">
          <button
            type="button"
            className="system-accordion-trigger"
            onClick={() => toggleSection('docs')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BookOpen size={18} color="var(--accent-color)" />
              <span>{t('system.docsTitle')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                className="tabular-nums"
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: 'var(--text-secondary)',
                }}
              >
                {t('system.chaptersCount', { count: docChapters.length })}
              </span>
              {openSection === 'docs' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>
          </button>

          {openSection === 'docs' && (
            <div className="system-accordion-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                  {t('system.docsDesc')}
                </p>
                <button
                  type="button"
                  className="btn-link"
                  disabled={loadingDocs}
                  onClick={() => {
                    triggerHaptic('light');
                    loadDocsData();
                  }}
                  style={{ fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                >
                  <RefreshCw size={12} />
                  <span>{loadingDocs ? t('common.loading') : t('common.refresh')}</span>
                </button>
              </div>

              {/* Full-text search input */}
              <div className="note-search-wrapper">
                <Search size={14} className="note-search-icon" />
                <input
                  type="text"
                  className="input-field note-search-input"
                  placeholder={t('system.docsSearchPlaceholder')}
                  aria-label={t('system.docsSearchAria')}
                  value={docSearchQuery}
                  onChange={(e) => setDocSearchQuery(e.target.value)}
                />
                {docSearchQuery && (
                  <button
                    type="button"
                    className="btn-link note-search-clear"
                    onClick={() => setDocSearchQuery('')}
                    aria-label={t('system.docsSearchClear')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {docSearchQuery.trim().length >= 2 && (
                <div
                  className="admin-card"
                  style={{ padding: '10px 12px', gap: 6, borderColor: 'var(--border-hairline)' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-color)' }}>
                    {t('system.docsServerSearchTitle')}
                  </div>
                  {docSearchResult?.query !== docSearchQuery.trim() ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('common.loading')}</div>
                  ) : docSearchResult.result ? (
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 12,
                        lineHeight: 1.45,
                        color: 'var(--text-secondary)',
                        margin: 0,
                        fontFamily: 'inherit',
                      }}
                    >
                      {docSearchResult.result}
                    </pre>
                  ) : null}
                </div>
              )}

              {loadingDocs && docChapters.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>
                  {t('system.docsLoading')}
                </div>
              ) : filteredDocChapters.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
                  {t('system.docsNotFound', { query: docSearchQuery })}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredDocChapters.map((ch) => {
                    const sectionMatches = docSearchQuery.trim()
                      ? findDocSectionMatches(ch, docSearchQuery)
                      : [];
                    const previewSections =
                      !docSearchQuery.trim() && ch.sections
                        ? ch.sections.slice(0, 4)
                        : [];

                    return (
                      <div
                        key={ch.slug}
                        className="doc-chapter-card reader-preview-card"
                        style={{ marginBottom: 0 }}
                        onClick={() => handleToggleChapter(ch.slug)}
                      >
                        <div className="doc-chapter-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                            <BookOpen size={15} color="var(--accent-color)" style={{ flexShrink: 0 }} />
                            <span className="doc-chapter-title">{stripMarkdownInline(ch.title)}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            <span className="doc-chapter-badge tabular-nums">
                              {t('system.sectionsCount', { count: ch.sections_count })}
                            </span>
                            <ChevronRight size={15} color="var(--text-muted)" />
                          </div>
                        </div>

                        <div className="doc-chapter-summary">
                          {stripMarkdownInline(ch.summary)}
                        </div>

                        {/* Search Matches with Direct Jump to § Section */}
                        {sectionMatches.length > 0 && (
                          <div
                            className="doc-card-section-pills"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {sectionMatches.slice(0, 4).map((m, idx) => (
                              <button
                                key={idx}
                                type="button"
                                className="doc-section-jump-chip matched"
                                onClick={() => handleToggleChapter(ch.slug, m.sectionTitle)}
                              >
                                <div className="doc-jump-chip-title">§ {m.sectionTitle}</div>
                                {m.snippet && (
                                  <div className="doc-jump-chip-snippet">{m.snippet}</div>
                                )}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Default Quick Section Chips */}
                        {previewSections.length > 0 && (
                          <div
                            className="doc-card-inline-chips"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {previewSections.map((sec, idx) => (
                              <button
                                key={idx}
                                type="button"
                                className="doc-inline-sec-pill"
                                onClick={() =>
                                  handleToggleChapter(
                                    ch.slug,
                                    stripMarkdownInline(sec.section_title)
                                  )
                                }
                              >
                                <span>§ {stripMarkdownInline(sec.section_title)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
