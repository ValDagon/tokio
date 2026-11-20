import React, { useState } from 'react';
import {
  Sparkles,
  User,
  Coins,
  Clock,
  Wallet,
  Check,
  AlertCircle,
  ArrowRight,
  GraduationCap,
  Zap,
  HeartHandshake,
  Brain,
  CreditCard,
  Banknote,
  DollarSign,
} from 'lucide-react';
import type { UserSettings, OnboardingPayload } from '../types';
import { completeOnboarding } from '../api';
import { useI18n } from '../i18n/index';

export interface OnboardingModalProps {
  initialSettings: UserSettings;
  onComplete: (updatedSettings: UserSettings) => Promise<void> | void;
  triggerHaptic?: (type?: 'light' | 'medium' | 'success') => void;
  assistantName?: string;
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

interface PersonaChoice {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  initialSettings,
  onComplete,
  triggerHaptic,
  assistantName = 'Tokio',
}) => {
  const { t } = useI18n();

  const personaChoices: PersonaChoice[] = [
    {
      id: 'mentor',
      title: t('personas.mentorTitle'),
      desc: t('personas.mentorDesc'),
      icon: <HeartHandshake size={18} color="var(--accent-color)" />,
    },
    {
      id: 'executive',
      title: t('personas.executiveTitle'),
      desc: t('personas.executiveDesc'),
      icon: <Zap size={18} color="var(--accent-color)" />,
    },
    {
      id: 'partner',
      title: t('personas.partnerTitle'),
      desc: t('personas.partnerDesc'),
      icon: <GraduationCap size={18} color="var(--accent-color)" />,
    },
    {
      id: 'socratic',
      title: t('personas.socraticTitle'),
      desc: t('personas.socraticDesc'),
      icon: <Brain size={18} color="var(--accent-color)" />,
    },
  ];

  const starterAccountOptions = [
    {
      id: 'card',
      title: t('onboarding.cardTitle'),
      desc: t('onboarding.cardDesc'),
      icon: <CreditCard size={18} />,
    },
    {
      id: 'cash',
      title: t('onboarding.cashTitle'),
      desc: t('onboarding.cashDesc'),
      icon: <Banknote size={18} />,
    },
    {
      id: 'crypto',
      title: t('onboarding.cryptoTitle'),
      desc: t('onboarding.cryptoDesc'),
      icon: <DollarSign size={18} />,
    },
  ] as const;

  const telegramFirstName =
    typeof window !== 'undefined'
      ? window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || ''
      : '';

  const detectedTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
    } catch {
      return 'Europe/Moscow';
    }
  })();

  const [name, setName] = useState(telegramFirstName || initialSettings.name || '');
  const [baseCurrency, setBaseCurrency] = useState(initialSettings.base_currency || 'EUR');
  const [timezone, setTimezone] = useState(initialSettings.timezone || detectedTz);
  const [personaStyle, setPersonaStyle] = useState(initialSettings.persona_style || 'mentor');
  const [starterAccounts, setStarterAccounts] = useState<string[]>(['card', 'cash']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const toggleStarterAccount = (id: string) => {
    triggerHaptic?.('light');
    setStarterAccounts((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg(t('onboarding.nameError'));
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMsg(null);
      triggerHaptic?.('medium');

      const payload: OnboardingPayload = {
        name: name.trim(),
        base_currency: baseCurrency.toUpperCase(),
        timezone: timezone.trim(),
        persona_style: personaStyle,
        starter_accounts: starterAccounts,
      };

      const updated = await completeOnboarding(payload);
      triggerHaptic?.('success');
      await onComplete(updated);
    } catch (err: unknown) {
      console.error('Onboarding submission failed:', err);
      const msg = err instanceof Error ? err.message : t('onboarding.submitError');
      setErrorMsg(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(5, 6, 8, 0.85)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px 12px',
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 540,
          maxHeight: '90vh',
          background: 'var(--bg-surface, #14161b)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 'var(--radius-lg, 16px)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.65)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'slideUp 0.25s cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 20px 14px 20px',
            borderBottom: '1px solid var(--border-hairline, rgba(255, 255, 255, 0.08))',
            background: 'linear-gradient(180deg, rgba(245, 158, 11, 0.08) 0%, transparent 100%)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '8px',
                background: 'rgba(245, 158, 11, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-color, #f59e0b)',
              }}
            >
              <Sparkles size={18} />
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary, #f4f4f6)' }}>
                {t('onboarding.welcomeTitle', { name: assistantName })}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary, #a1a1aa)' }}>
                {t('onboarding.welcomeSubtitle')}
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={handleSubmit}
          style={{
            padding: '18px 20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            scrollbarWidth: 'thin',
          }}
        >
          {errorMsg && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm, 6px)',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
                fontSize: 12.5,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 1. Name */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              htmlFor="onboarding-name"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              <User size={15} color="var(--accent-color)" />
              <span>{t('onboarding.nameLabel')}</span>
            </label>
            <input
              id="onboarding-name"
              type="text"
              className="input-field"
              placeholder={t('onboarding.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          {/* 2. Base Currency */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <Coins size={15} color="var(--accent-color)" />
              <span>{t('onboarding.currencyLabel')}</span>
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {CURRENCY_OPTIONS.map((c) => {
                const isSelected = baseCurrency.toUpperCase() === c.code;
                return (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => {
                      triggerHaptic?.('light');
                      setBaseCurrency(c.code);
                    }}
                    style={{
                      flex: '1 1 calc(20% - 8px)',
                      minWidth: 80,
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm, 6px)',
                      background: isSelected
                        ? 'rgba(245, 158, 11, 0.16)'
                        : 'rgba(255, 255, 255, 0.04)',
                      border: isSelected
                        ? '1px solid var(--accent-color, #f59e0b)'
                        : '1px solid var(--border-hairline, rgba(255, 255, 255, 0.08))',
                      color: isSelected ? 'var(--accent-color)' : 'var(--text-secondary)',
                      fontWeight: isSelected ? 700 : 500,
                      fontSize: 13,
                      cursor: 'pointer',
                      textAlign: 'center',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {t('onboarding.currencyHint')}
            </span>
          </div>

          {/* 3. Timezone */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label
              htmlFor="onboarding-timezone"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              <Clock size={15} color="var(--accent-color)" />
              <span>{t('onboarding.timezoneLabel')}</span>
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TIMEZONE_PRESETS.map((tz) => {
                const isPreset = timezone === tz;
                return (
                  <button
                    key={tz}
                    type="button"
                    onClick={() => {
                      triggerHaptic?.('light');
                      setTimezone(tz);
                    }}
                    style={{
                      padding: '4px 8px',
                      borderRadius: '12px',
                      fontSize: 11.5,
                      background: isPreset
                        ? 'rgba(245, 158, 11, 0.16)'
                        : 'rgba(255, 255, 255, 0.04)',
                      border: isPreset
                        ? '1px solid var(--accent-color)'
                        : '1px solid rgba(255, 255, 255, 0.08)',
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
              id="onboarding-timezone"
              type="text"
              className="input-field"
              placeholder="Europe/Moscow"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
            />
          </div>

          {/* 4. Persona Style */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <Sparkles size={15} color="var(--accent-color)" />
              <span>{t('onboarding.personaLabel')}</span>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {personaChoices.map((p) => {
                const isSelected = personaStyle === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      triggerHaptic?.('light');
                      setPersonaStyle(p.id);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md, 10px)',
                      background: isSelected
                        ? 'rgba(245, 158, 11, 0.09)'
                        : 'rgba(255, 255, 255, 0.03)',
                      border: isSelected
                        ? '1px solid var(--accent-color, #f59e0b)'
                        : '1px solid var(--border-hairline, rgba(255, 255, 255, 0.08))',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ marginTop: 2, flexShrink: 0 }}>{p.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: isSelected ? 'var(--accent-color)' : 'var(--text-primary)',
                          marginBottom: 2,
                        }}
                      >
                        {p.title}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          lineHeight: 1.35,
                        }}
                      >
                        {p.desc}
                      </div>
                    </div>
                    {isSelected && (
                      <span
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          background: 'var(--accent-color)',
                          color: 'var(--accent-text, #0c0d10)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          marginTop: 2,
                        }}
                      >
                        <Check size={12} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 5. Starter Accounts */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <Wallet size={15} color="var(--accent-color)" />
              <span>{t('onboarding.starterAccountsLabel')}</span>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {starterAccountOptions.map((acc) => {
                const isChecked = starterAccounts.includes(acc.id);
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() => toggleStarterAccount(acc.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm, 6px)',
                      background: isChecked
                        ? 'rgba(255, 255, 255, 0.06)'
                        : 'rgba(255, 255, 255, 0.02)',
                      border: isChecked
                        ? '1px solid rgba(255, 255, 255, 0.16)'
                        : '1px solid var(--border-hairline, rgba(255, 255, 255, 0.06))',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ color: isChecked ? 'var(--accent-color)' : 'var(--text-muted)' }}>
                        {acc.icon}
                      </span>
                      <div>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: isChecked ? 'var(--text-primary)' : 'var(--text-secondary)',
                          }}
                        >
                          {acc.title}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {acc.desc}
                        </div>
                      </div>
                    </div>
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: isChecked
                          ? '1px solid var(--accent-color)'
                          : '1px solid rgba(255, 255, 255, 0.3)',
                        background: isChecked ? 'var(--accent-color)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--accent-text, #0c0d10)',
                        flexShrink: 0,
                      }}
                    >
                      {isChecked && <Check size={12} strokeWidth={3} />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Submit */}
          <div style={{ marginTop: 6 }}>
            <button
              type="submit"
              className="btn-primary"
              disabled={isSubmitting || !name.trim()}
              style={{
                width: '100%',
                padding: '12px 16px',
                fontSize: 14,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {isSubmitting ? (
                <span>{t('onboarding.submitting')}</span>
              ) : (
                <>
                  <span>{t('onboarding.submitBtn')}</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
