import React, { useState } from 'react';
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
  Shield,
  Users,
  UserCheck,
  UserX,
  Link2,
  Copy,
  Plus,
  AlertTriangle,
  ExternalLink,
  Key,
  Download,
  Upload,
  Database,
  Globe,
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
  AdminDashboardData,
  AdminUserItem,
  AdminInviteItem,
  AccessInfo,
} from '../types';
import {
  fetchAdminUsers,
  createAdminInvite,
  deleteAdminInvite,
  updateAdminUser,
  saveByokKey,
  clearByokKey,
  exportBackupJson,
  restoreBackupJson,
} from '../api';
import { findDocSectionMatches, stripMarkdownInline } from '../utils';

export interface PersonaPreset {
  id: string;
  title: string;
  desc: string;
  instruction: string;
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
    personal_memory?: string;
  }) => void;
  suggestedQuestions?: readonly string[];
  copiedPromptIndex?: number | null;
  handleCopyPrompt?: (q: string, idx: number) => void;
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
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;

  userSettings?: UserSettings | null;
  accessInfo?: AccessInfo | null;
  onReloadSettings?: () => Promise<void> | void;
  assistantName?: string;
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

function getPresetIcon(id: string) {
  switch (id) {
    case 'mentor':
      return <HeartHandshake size={15} color="var(--accent-color)" />;
    case 'executive':
      return <Zap size={15} color="var(--accent-color)" />;
    case 'partner':
      return <GraduationCap size={15} color="var(--accent-color)" />;
    case 'socratic':
      return <Brain size={15} color="var(--accent-color)" />;
    default:
      return <Sparkles size={15} color="var(--accent-color)" />;
  }
}

function getPresetBadge(id: string, t: (key: string) => string): string {
  switch (id) {
    case 'mentor':
      return t('badges.calmMode');
    case 'executive':
      return t('badges.focusFacts');
    case 'partner':
      return t('badges.peerToPeer');
    case 'socratic':
      return t('badges.socratic');
    default:
      return '';
  }
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
  assistantName = 'Tokio',
  backupPrefix = 'tokio-backup',
  feedbackEnabled = true,
}) => {
  const { locale, setLocale, t, formatDate } = useI18n();
  const isAdmin = userSettings?.role === 'admin';

  // Profile preferences state
  const [baseCurrency, setBaseCurrency] = useState(userSettings?.base_currency || 'EUR');
  const [timezone, setTimezone] = useState(userSettings?.timezone || 'Europe/Moscow');
  const [personalMemory, setPersonalMemory] = useState(userSettings?.personal_memory || '');
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
    if (userSettings?.personal_memory !== undefined) setPersonalMemory(userSettings.personal_memory);
    if (userSettings?.has_byok_key !== undefined) setLocalByokOverride(null);
  }

  // Section accordions
  const [openSection, setOpenSection] = useState<'directives' | 'meds' | 'admin' | 'dossier' | 'docs' | null>(
    isAdmin ? 'docs' : 'directives'
  );

  // Admin Dashboard state
  const [adminData, setAdminData] = useState<AdminDashboardData | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [copiedInviteCode, setCopiedInviteCode] = useState<string | null>(null);
  const [isUpdatingUser, setIsUpdatingUser] = useState(false);
  const [userLimitInputs, setUserLimitInputs] = useState<Record<number, string>>({});

  const loadAdminData = async () => {
    if (!isAdmin) return;
    try {
      setAdminLoading(true);
      setAdminError(null);
      const data = await fetchAdminUsers();
      setAdminData(data);
    } catch (err: unknown) {
      console.error('Failed to load admin data:', err);
      const msg = err instanceof Error ? err.message : t('system.adminErrLoad');
      setAdminError(msg);
    } finally {
      setAdminLoading(false);
    }
  };

  const toggleSection = (section: 'directives' | 'meds' | 'admin' | 'dossier' | 'docs') => {
    triggerHaptic('light');
    setOpenSection((prev) => {
      const next = prev === section ? null : section;
      if (next === 'admin' && !adminData) {
        loadAdminData();
      }
      return next;
    });
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsCreatingInvite(true);
      triggerHaptic('medium');
      const inv = await createAdminInvite(inviteNote.trim() || t('system.inviteDefaultNote'), inviteMaxUses);
      triggerHaptic('success');
      setInviteNote('');
      setInviteMaxUses(1);
      setAdminData((prev) => (prev ? { ...prev, invites: [inv, ...prev.invites] } : null));
    } catch (err: unknown) {
      console.error('Failed to create invite:', err);
      const msg = err instanceof Error ? err.message : t('system.adminErrInvite');
      setAdminError(msg);
    } finally {
      setIsCreatingInvite(false);
    }
  };

  const handleCopyInviteLink = async (invite: AdminInviteItem) => {
    try {
      const link = invite.bot_link || invite.code;
      await navigator.clipboard.writeText(link);
      triggerHaptic('success');
      setCopiedInviteCode(invite.code);
      setTimeout(() => setCopiedInviteCode(null), 2500);
    } catch (e) {
      console.warn('Clipboard write error:', e);
    }
  };

  const handleShareInvite = (invite: AdminInviteItem) => {
    const link = invite.bot_link || '';
    const wa = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
    if (link && wa && 'openTelegramLink' in wa && typeof (wa as unknown as { openTelegramLink: (url: string) => void }).openTelegramLink === 'function') {
      triggerHaptic('light');
      (wa as unknown as { openTelegramLink: (url: string) => void }).openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t('system.shareInviteText', { name: assistantName, note: invite.note }))}`
      );
    } else {
      handleCopyInviteLink(invite);
    }
  };

  const handleDeleteInvite = async (code: string) => {
    try {
      triggerHaptic('medium');
      await deleteAdminInvite(code);
      triggerHaptic('success');
      setAdminData((prev) =>
        prev ? { ...prev, invites: prev.invites.filter((i) => i.code !== code) } : null
      );
    } catch (err) {
      console.error('Failed to delete invite:', err);
    }
  };

  const handleApproveUser = async (telegramId: number) => {
    try {
      setIsUpdatingUser(true);
      triggerHaptic('medium');
      await updateAdminUser(telegramId, { is_approved: true });
      triggerHaptic('success');
      setAdminData((prev) =>
        prev
          ? {
              ...prev,
              users: prev.users.map((u) =>
                u.telegram_id === telegramId ? { ...u, is_approved: true } : u
              ),
            }
          : null
      );
    } catch (err) {
      console.error('Failed to approve user:', err);
    } finally {
      setIsUpdatingUser(false);
    }
  };

  const handleToggleUserApproval = async (u: AdminUserItem) => {
    try {
      setIsUpdatingUser(true);
      triggerHaptic('medium');
      const nextApproved = !u.is_approved;
      await updateAdminUser(u.telegram_id, { is_approved: nextApproved });
      triggerHaptic('success');
      setAdminData((prev) =>
        prev
          ? {
              ...prev,
              users: prev.users.map((item) =>
                item.telegram_id === u.telegram_id ? { ...item, is_approved: nextApproved } : item
              ),
            }
          : null
      );
    } catch (err) {
      console.error('Failed to toggle approval:', err);
    } finally {
      setIsUpdatingUser(false);
    }
  };

  const handleUpdateLimit = async (telegramId: number, newLimit: number) => {
    if (newLimit < 0) return;
    try {
      setIsUpdatingUser(true);
      triggerHaptic('light');
      await updateAdminUser(telegramId, { daily_msg_limit: newLimit });
      triggerHaptic('success');
      setAdminData((prev) =>
        prev
          ? {
              ...prev,
              users: prev.users.map((u) =>
                u.telegram_id === telegramId ? { ...u, daily_msg_limit: newLimit } : u
              ),
            }
          : null
      );
    } catch (err) {
      console.error('Failed to update limit:', err);
    } finally {
      setIsUpdatingUser(false);
    }
  };

  const handleSaveAll = () => {
    handleSaveDirectives({
      base_currency: baseCurrency.toUpperCase(),
      timezone: timezone.trim(),
      personal_memory: personalMemory,
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
      await saveByokKey(key);
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
                  {hasByokKey ? t('system.byokActive') : t('system.byokShared')}
                </span>
              </div>

              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                {t('system.byokDesc')}
              </span>

              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <input
                  type="password"
                  placeholder="AIzaSy..."
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

            {/* Persona Presets Grid */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('system.personaStyleLabel')}
              </label>
              <div className="persona-presets-grid">
                {personaPresets.map((preset) => {
                  const isActive = personaStyle === preset.id;
                  const cleanTitle = preset.title.replace(/^[^\p{L}\p{N}]+\s*/u, '');
                  const badge = getPresetBadge(preset.id, t);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`persona-preset-btn ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        triggerHaptic('light');
                        setPersonaStyle(preset.id);
                        setCustomInstructions(preset.instruction);
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

            {/* Personal Memory Textarea */}
            <label
              id="memory-label"
              style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 2, marginTop: 4 }}
            >
              {t('system.memoryLabel')}
            </label>
            <textarea
              className="directives-textarea"
              aria-labelledby="memory-label"
              aria-label={t('system.memoryLabel')}
              style={{ minHeight: 70 }}
              placeholder={t('system.memoryPlaceholder')}
              value={personalMemory}
              onChange={(e) => setPersonalMemory(e.target.value)}
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

      {/* SECTION 3: Admin */}
      {isAdmin && (
        <div className="system-accordion-card">
          <button
            type="button"
            className="system-accordion-trigger"
            onClick={() => toggleSection('admin')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Shield size={18} color="var(--accent-color)" />
              <span>{t('system.adminTitle')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {adminData && (
                <span
                  className="tabular-nums"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: '10px',
                    background: 'rgba(255, 255, 255, 0.06)',
                    color: adminData.users.some((u) => !u.is_approved) ? '#f59e0b' : 'var(--accent-color)',
                  }}
                >
                  {t('system.usersCount', { count: adminData.users.length })}
                </span>
              )}
              {openSection === 'admin' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>
          </button>

          {openSection === 'admin' && (
            <div className="system-accordion-body">
              {adminError && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#fca5a5',
                    fontSize: 12.5,
                  }}
                >
                  {adminError}
                </div>
              )}

              {/* Stats Bar */}
              <div className="admin-stat-row">
                <div className="admin-stat-box">
                  <span className="title">{t('system.totalUsers')}</span>
                  <span className="val tabular-nums">{adminData?.users.length ?? '—'}</span>
                </div>
                <div className="admin-stat-box">
                  <span className="title">{t('system.pendingApproval')}</span>
                  <span
                    className="val tabular-nums"
                    style={{
                      color:
                        (adminData?.users.filter((u) => !u.is_approved).length ?? 0) > 0
                          ? 'var(--accent-color)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {adminData?.users.filter((u) => !u.is_approved).length ?? 0}
                  </span>
                </div>
                <div className="admin-stat-box">
                  <span className="title">{t('system.activeInvites')}</span>
                  <span className="val tabular-nums">{adminData?.invites.length ?? '—'}</span>
                </div>
              </div>

              {/* Create Invite Form */}
              <form onSubmit={handleCreateInvite} className="admin-card">
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {t('system.createInviteTitle')}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="input-field"
                    style={{ flex: 1 }}
                    placeholder={t('system.invitePlaceholder')}
                    value={inviteNote}
                    onChange={(e) => setInviteNote(e.target.value)}
                    required
                  />
                  <input
                    type="number"
                    min="1"
                    max="100"
                    className="input-field"
                    style={{ width: 75 }}
                    placeholder={t('system.usesLimitPlaceholder')}
                    title={t('system.usesLimitTitle')}
                    value={inviteMaxUses}
                    onChange={(e) => setInviteMaxUses(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  />
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={isCreatingInvite}
                    style={{ padding: '0 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Plus size={15} />
                    <span>{isCreatingInvite ? '...' : t('common.create')}</span>
                  </button>
                </div>
              </form>

              {/* Active Invites List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <span className="section-title" style={{ fontSize: 13 }}>
                  {t('system.inviteLinks')}
                </span>
                {adminData?.invites.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('system.noInvites')}</div>
                ) : (
                  adminData?.invites.map((inv) => {
                    const isCopied = copiedInviteCode === inv.code;
                    return (
                      <div key={inv.code} className="admin-invite-row">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Link2 size={13} color="var(--accent-color)" />
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                              {inv.note || t('system.inviteDefaultNote')}
                            </span>
                            <span
                              className="tabular-nums"
                              style={{
                                fontSize: 11,
                                padding: '1px 6px',
                                borderRadius: 8,
                                background: 'rgba(255, 255, 255, 0.06)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              {inv.uses_count} / {inv.max_uses}
                            </span>
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {inv.code}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button
                            type="button"
                            className="admin-btn-action"
                            onClick={() => handleCopyInviteLink(inv)}
                          >
                            <Copy size={12} />
                            <span>{isCopied ? t('system.copiedBtn') : t('system.copyBtn')}</span>
                          </button>
                          <button
                            type="button"
                            className="admin-btn-action"
                            onClick={() => handleShareInvite(inv)}
                            title={t('system.shareTg')}
                          >
                            <ExternalLink size={12} />
                          </button>
                          <button
                            type="button"
                            className="admin-btn-action admin-btn-danger"
                            onClick={() => handleDeleteInvite(inv.code)}
                            title={t('system.deleteInvite')}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Users Management */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="section-title" style={{ fontSize: 13 }}>
                    {t('system.usersSection')}
                  </span>
                  <button
                    type="button"
                    className="btn-link"
                    disabled={adminLoading}
                    onClick={() => {
                      triggerHaptic('light');
                      loadAdminData();
                    }}
                    style={{ fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <RefreshCw size={12} className={adminLoading ? 'spin-icon' : ''} />
                    <span>{adminLoading ? t('common.loading') : t('common.refresh')}</span>
                  </button>
                </div>

                {adminLoading && !adminData ? (
                  <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
                    {t('system.loadingUsers')}
                  </div>
                ) : (
                  <>
                    {/* Pending Users Highlight */}
                    {adminData?.users
                      .filter((u) => !u.is_approved)
                      .map((u) => (
                        <div key={u.telegram_id} className="admin-card pending">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <AlertTriangle size={15} color="#f59e0b" />
                                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                                  {u.name || t('system.newUser')}
                                </span>
                              </div>
                              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                                ID: {u.telegram_id} · {t('system.currencyShort')} {u.base_currency} · {t('system.createdShort')}{' '}
                                {u.created_at ? formatDate(u.created_at) : '—'}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="admin-btn-action admin-btn-approve"
                              disabled={isUpdatingUser}
                              onClick={() => handleApproveUser(u.telegram_id)}
                              style={{ padding: '6px 12px', fontSize: 12 }}
                            >
                              <UserCheck size={14} />
                              <span>{t('system.approveAccess')}</span>
                            </button>
                          </div>
                        </div>
                      ))}

                    {/* Approved Users List */}
                    {adminData?.users
                      .filter((u) => u.is_approved)
                      .map((u) => {
                        const isSelf = userSettings?.name === u.name;
                        const currentInputLimit =
                          userLimitInputs[u.telegram_id] !== undefined
                            ? userLimitInputs[u.telegram_id]
                            : String(u.daily_msg_limit);

                        return (
                          <div key={u.telegram_id} className="admin-card">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <Users size={14} color="var(--accent-color)" />
                                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {u.name || t('system.userDefault')}
                                  </span>
                                  {u.role === 'admin' && (
                                    <span
                                      style={{
                                        fontSize: 10,
                                        padding: '1px 5px',
                                        borderRadius: 6,
                                        background: 'rgba(245, 158, 11, 0.16)',
                                        color: 'var(--accent-color)',
                                        fontWeight: 700,
                                      }}
                                    >
                                      Admin
                                    </span>
                                  )}
                                  {isSelf && (
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('system.selfTag')}</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                                  ID: {u.telegram_id} · {t('system.currencyShort')} {u.base_currency}
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div className="tabular-nums" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                                  {t('system.aiQuotaShort', { used: u.daily_msg_used, limit: u.daily_msg_limit })}
                                </div>
                                <div className="tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  {t('system.spentUsd', { amount: u.total_cost_usd !== undefined ? u.total_cost_usd.toFixed(2) : '0.00' })}
                                </div>
                              </div>
                            </div>

                            {/* Quota adjusting controls */}
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 6,
                                paddingTop: 6,
                                borderTop: '1px solid var(--border-hairline)',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{t('system.quotaLabel')}</span>
                                <input
                                  type="number"
                                  className="input-field"
                                  style={{ width: 60, padding: '3px 6px', fontSize: 12 }}
                                  value={currentInputLimit}
                                  onChange={(e) =>
                                    setUserLimitInputs((prev) => ({
                                      ...prev,
                                      [u.telegram_id]: e.target.value,
                                    }))
                                  }
                                />
                                <button
                                  type="button"
                                  className="admin-btn-action"
                                  onClick={() =>
                                    handleUpdateLimit(
                                      u.telegram_id,
                                      parseInt(currentInputLimit, 10) || u.daily_msg_limit
                                    )
                                  }
                                >
                                  OK
                                </button>
                                <button
                                  type="button"
                                  className="admin-btn-action"
                                  onClick={() => handleUpdateLimit(u.telegram_id, u.daily_msg_limit + 20)}
                                >
                                  +20
                                </button>
                              </div>

                              {!isSelf && (
                                <button
                                  type="button"
                                  className="admin-btn-action admin-btn-danger"
                                  onClick={() => handleToggleUserApproval(u)}
                                >
                                  <UserX size={12} />
                                  <span>{t('system.pauseUser')}</span>
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

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
