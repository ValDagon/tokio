import React from 'react';
import {
  Sparkles,
  X,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Calendar,
  CheckCircle2,
  CreditCard,
  Building2,
  Layers,
  Briefcase,
  RotateCcw,
  ArrowRight,
  ShieldCheck,
  Pencil,
  Plus,
} from 'lucide-react';
import { updateAccount, createAccount } from '../api';
import type {
  Account,
  FinanceSummary,
  RunwayInfo,
  TransactionItem,
  Liability,
  EnvelopeStatus,
  UiConfigAccountTheme,
} from '../types';
import { getCurrencySymbol } from '../utils';
import { useI18n } from '../i18n/index';

export interface BankAccountGroup {
  name: string;
  total_eur: number;
  subAccounts: {
    id: string;
    currency: string;
    balance: number;
    balance_eur: number;
    envelope?: 'spendable' | 'reserved';
  }[];
}

export interface FinancesTabProps {
  finLoading: boolean;
  accounts: Account[];
  finSummary: FinanceSummary | null;
  runway: RunwayInfo | null;
  groupedAccounts: BankAccountGroup[];
  activeBankName: string | null;
  setActiveBankName: (name: string | null) => void;
  getAccountThemeClass: (name: string) => string;
  triggerHaptic: (type?: 'light' | 'medium' | 'success') => void;
  liabilities: Liability[];
  activeLiabilityQueue: string | null;
  setActiveLiabilityQueue: (queue: string | null) => void;
  filteredLiabilities: Liability[];
  updateLiability: (id: string, data: { account_id?: string }) => Promise<unknown>;
  loadFinances: () => Promise<void>;
  showAlert: (msg: string) => Promise<void>;
  showConfirm: (msg: string) => Promise<boolean>;
  payLiability: (id: string, data: { deduct_from_account?: boolean; account_id?: string }) => Promise<unknown>;
  budgetModalCategory: string | null;
  setBudgetModalCategory: (cat: string | null) => void;
  budgetLimitInput: string;
  setBudgetLimitInput: (val: string) => void;
  handleSaveBudget: () => Promise<void> | void;
  transactions: TransactionItem[];
  undoLastTransaction: () => Promise<{ message: string }>;
  resetFinances: () => Promise<unknown>;
  baseCurrency?: string;
  reserveAmount?: number;
  accountThemes?: UiConfigAccountTheme[];
}

interface AccountPurposeMeta {
  shortName?: string;
  roleLabel: string;
}

function getAccountPurposeMeta(
  name: string,
  envelope: 'spendable' | 'reserved' | undefined,
  accountThemes: UiConfigAccountTheme[],
  t: (key: string) => string
): AccountPurposeMeta {
  const lower = name.toLowerCase();
  for (const rule of accountThemes) {
    if (rule.pattern && lower.includes(rule.pattern.toLowerCase())) {
      return {
        shortName: rule.shortName,
        roleLabel: rule.roleLabel || (envelope === 'spendable' ? t('finances.roleSpendable') : t('finances.roleReserve')),
      };
    }
  }
  if (envelope === 'spendable') {
    return { roleLabel: t('finances.roleSpendable') };
  }
  if (envelope === 'reserved') {
    return { roleLabel: t('finances.roleReserve') };
  }
  return { roleLabel: t('finances.roleTarget') };
}

export const FinancesTab: React.FC<FinancesTabProps> = ({
  finLoading,
  accounts,
  finSummary,
  runway,
  groupedAccounts,
  activeBankName,
  setActiveBankName,
  getAccountThemeClass,
  triggerHaptic,
  liabilities,
  activeLiabilityQueue,
  setActiveLiabilityQueue,
  filteredLiabilities,
  updateLiability,
  loadFinances,
  showAlert,
  showConfirm,
  payLiability,
  budgetModalCategory,
  setBudgetModalCategory,
  budgetLimitInput,
  setBudgetLimitInput,
  handleSaveBudget,
  transactions,
  undoLastTransaction,
  resetFinances,
  baseCurrency = 'EUR',
  reserveAmount = 0,
  accountThemes = [],
}) => {
  const { t, formatNumber, formatDate } = useI18n();
  const currSym = getCurrencySymbol(baseCurrency);
  const [showTotals, setShowTotals] = React.useState(false);
  const [showAllLiabilities, setShowAllLiabilities] = React.useState(false);
  const [linkingLiability, setLinkingLiability] = React.useState<Liability | null>(null);

  // Account Envelope Toggle & Edit state
  const [editingAccount, setEditingAccount] = React.useState<Account | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = React.useState(false);
  const [accountFormName, setAccountFormName] = React.useState('');
  const [accountFormCurrency, setAccountFormCurrency] = React.useState(baseCurrency);
  const [accountFormBalance, setAccountFormBalance] = React.useState('');
  const [accountFormEnvelope, setAccountFormEnvelope] = React.useState<'spendable' | 'reserved'>('spendable');
  const [isSavingAccount, setIsSavingAccount] = React.useState(false);
  const [accountActionError, setAccountActionError] = React.useState<string | null>(null);

  const handleToggleAccountEnvelope = async (accId: string, targetEnvelope: 'spendable' | 'reserved') => {
    try {
      triggerHaptic('medium');
      await updateAccount(accId, { envelope: targetEnvelope });
      triggerHaptic('success');
      await loadFinances();
    } catch (err: unknown) {
      console.error('Failed to toggle envelope:', err);
      const msg = err instanceof Error ? err.message : t('finances.errToggleEnvelope');
      await showAlert(msg);
    }
  };

  const handleOpenCreateAccount = () => {
    triggerHaptic('light');
    setAccountFormName('');
    setAccountFormCurrency(baseCurrency);
    setAccountFormBalance('0');
    setAccountFormEnvelope('spendable');
    setAccountActionError(null);
    setIsCreatingAccount(true);
  };

  const handleOpenEditAccount = (acc: Account) => {
    triggerHaptic('light');
    setEditingAccount(acc);
    setAccountFormName(acc.name);
    setAccountFormCurrency(acc.currency);
    setAccountFormBalance(String(acc.current_balance));
    const effectiveEnv = acc.envelope || 'spendable';
    setAccountFormEnvelope(effectiveEnv);
    setAccountActionError(null);
  };

  const handleSaveAccountForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = accountFormName.trim();
    if (!name) {
      setAccountActionError(t('finances.errAccountName'));
      return;
    }
    const balanceNum = parseFloat(accountFormBalance) || 0;
    try {
      setIsSavingAccount(true);
      setAccountActionError(null);
      triggerHaptic('medium');
      if (editingAccount) {
        await updateAccount(editingAccount.id, {
          name,
          currency: accountFormCurrency,
          current_balance: balanceNum,
          envelope: accountFormEnvelope,
        });
      } else {
        await createAccount({
          name,
          currency: accountFormCurrency,
          current_balance: balanceNum,
          envelope: accountFormEnvelope,
        });
      }
      triggerHaptic('success');
      setEditingAccount(null);
      setIsCreatingAccount(false);
      await loadFinances();
    } catch (err: unknown) {
      console.error('Failed to save account:', err);
      const msg = err instanceof Error ? err.message : t('finances.errSaveAccount');
      setAccountActionError(msg);
    } finally {
      setIsSavingAccount(false);
    }
  };

  if (finLoading && accounts.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 40 }}>
        <Sparkles size={28} color="var(--accent-color)" />
        <p>{t('finances.loading')}</p>
      </div>
    );
  }

  const isFrozenLiability = (l: Liability): boolean =>
    Boolean(
      l.notes?.toLowerCase().includes('заморож') ||
      l.notes?.toLowerCase().includes('пауз') ||
      l.notes?.toLowerCase().includes('frozen') ||
      (l as Liability & { is_frozen?: boolean }).is_frozen
    );

  const hasBudgets = Boolean(finSummary?.categories && finSummary.categories.length > 0);
  const hasTransactions = transactions.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 1. Compact Hero Card */}
      {runway && (
        <div className="capital-card" style={{ padding: '14px 16px', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="capital-label">{t('finances.freeResource')}</span>
            <button
              type="button"
              className="btn-link"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                color: 'var(--text-secondary)',
                padding: '2px 8px',
                borderRadius: 12,
                background: 'rgba(255, 255, 255, 0.05)',
              }}
              onClick={() => {
                triggerHaptic('light');
                setShowTotals(!showTotals);
              }}
            >
              {showTotals ? <EyeOff size={13} /> : <Eye size={13} />}
              <span>{t('finances.capital')}</span>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span className="capital-value tabular-nums" style={{ fontSize: 24 }}>
              ~{formatNumber(runway.safe_daily_spend_eur, { maximumFractionDigits: 0 })} {currSym}
              <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-muted)', marginLeft: 5 }}>
                {t('finances.perDay')}
              </span>
            </span>
            <span className="tabular-nums" style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
              {t('finances.freeCashForHorizon')}{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {formatNumber(runway.true_free_cash_eur ?? runway.spendable_eur, { maximumFractionDigits: 0 })} {currSym}
              </strong>{' '}
              {t('finances.forDays', { days: runway.horizon_days })}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, color: 'var(--text-muted)' }}>
            <span>
              {reserveAmount > 0
                ? t('finances.reserveHint', { reserve: formatNumber(reserveAmount, { maximumFractionDigits: 0 }), currency: currSym })
                : t('finances.spendableHint')}
            </span>
            <span className="tabular-nums">
              {t('finances.inReserve', { amount: formatNumber(runway.reserved_eur, { maximumFractionDigits: 0 }), currency: currSym })}
            </span>
          </div>

          {showTotals && (
            <div
              style={{
                marginTop: 6,
                paddingTop: 8,
                borderTop: '1px solid var(--border-hairline)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 12.5,
              }}
            >
              <span style={{ color: 'var(--text-muted)' }}>
                {t('finances.totalLabel')}{' '}
                <strong className="tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {finSummary?.total_net_worth_eur !== undefined
                    ? `${formatNumber(finSummary.total_net_worth_eur, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currSym}`
                    : '—'}
                </strong>
              </span>
              <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {t('finances.spentLabel', { amount: formatNumber(finSummary?.total_spent_eur || 0, { maximumFractionDigits: 0 }), currency: currSym })} ·{' '}
                {t('finances.incomeLabel', { amount: formatNumber(finSummary?.total_income_eur || 0, { maximumFractionDigits: 0 }), currency: currSym })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Accounts Section Header with Add Account button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px', marginBottom: 2 }}>
        <span className="section-title">{t('finances.accountsTitle')}</span>
        <button
          type="button"
          onClick={handleOpenCreateAccount}
          className="btn-link"
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent-color)' }}
        >
          <Plus size={13} /> {t('finances.addAccount')}
        </button>
      </div>

      {/* 2. Clean 2x2 Accounts Grid */}
      <div className="accounts-grid">
        {groupedAccounts.map((grp) => {
          const isMulti = grp.subAccounts.length > 1;
          const isSelected = activeBankName === grp.name;
          const single = grp.subAccounts[0];
          const singleAccount = !isMulti && single ? accounts.find((a) => a.id === single.id) : null;
          const effectiveEnv = single?.envelope || singleAccount?.envelope || 'spendable';
          const purposeMeta = getAccountPurposeMeta(grp.name, effectiveEnv, accountThemes, t);
          const displayTitle = purposeMeta.shortName || grp.name;
          const isSpendable = effectiveEnv === 'spendable';

          return (
            <div
              key={grp.name}
              className={`account-card ${getAccountThemeClass(grp.name)} ${isSelected ? 'active-bank' : ''}`}
              onClick={() => {
                triggerHaptic('light');
                setActiveBankName(isSelected ? null : grp.name);
              }}
              style={{ cursor: 'pointer', padding: '11px 12px', gap: 4 }}
            >
              <div className="account-header">
                <span className="account-name">{displayTitle}</span>
                {isMulti ? (
                  <span className="currency-badge tabular-nums">
                    {t('finances.multiCurrencies', { count: grp.subAccounts.length })}
                  </span>
                ) : (
                  <span className="currency-badge">{single?.currency || baseCurrency}</span>
                )}
              </div>

              <span className="account-balance tabular-nums" style={{ marginTop: 2 }}>
                ~{formatNumber(grp.total_eur, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {currSym}
              </span>

              {/* Secondary line: native currency, or multi-currency trigger */}
              {!isMulti && single && single.currency !== baseCurrency ? (
                <span className="account-eur tabular-nums" style={{ fontSize: 12.5 }}>
                  {formatNumber(single.balance, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {single.currency}
                </span>
              ) : isMulti ? (
                <span
                  style={{
                    fontSize: 12.5,
                    color: isSelected ? 'var(--accent-color)' : 'rgba(255, 255, 255, 0.75)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                  }}
                >
                  {isSelected ? t('finances.collapse') : t('finances.currencies')}
                  {isSelected ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </span>
              ) : null}

              {/* Quiet 1-line purpose caption + envelope toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 }}>
                <span className="account-purpose-badge">
                  {purposeMeta.roleLabel}
                </span>
                {!isMulti && single && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => handleToggleAccountEnvelope(single.id, isSpendable ? 'reserved' : 'spendable')}
                      className={`account-envelope-badge ${isSpendable ? 'spendable' : 'reserved'}`}
                      title={t('finances.toggleEnvelopeTitle')}
                    >
                      {isSpendable ? t('finances.envelopeSpendable') : t('finances.envelopeReserved')}
                    </button>
                    {singleAccount && (
                      <button
                        type="button"
                        onClick={() => handleOpenEditAccount(singleAccount)}
                        className="btn-link"
                        style={{ padding: 2, color: 'var(--text-muted)' }}
                        title={t('finances.editAccountTitle')}
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {isMulti && isSelected && (
                <div className="sub-currencies-list" style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                  {grp.subAccounts.map((sub) => {
                    const fullSub = accounts.find((a) => a.id === sub.id);
                    const subEnv = sub.envelope || fullSub?.envelope || 'spendable';
                    const subIsSpendable = subEnv === 'spendable';
                    return (
                      <div key={sub.id} className="sub-currency-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="sub-currency-badge">{sub.currency}</span>
                          <button
                            type="button"
                            onClick={() => handleToggleAccountEnvelope(sub.id, subIsSpendable ? 'reserved' : 'spendable')}
                            className={`account-envelope-badge ${subIsSpendable ? 'spendable' : 'reserved'}`}
                            style={{ fontSize: 10, padding: '1px 5px' }}
                            title={t('finances.toggleEnvelopeTitle')}
                          >
                            {subIsSpendable ? t('finances.envelopeSpendable') : t('finances.envelopeReserved')}
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="sub-currency-amount tabular-nums">
                            {formatNumber(sub.balance, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          {fullSub && (
                            <button
                              type="button"
                              onClick={() => handleOpenEditAccount(fullSub)}
                              className="btn-link"
                              style={{ padding: 2, color: 'var(--text-muted)' }}
                              title={t('finances.editAccountTitle')}
                            >
                              <Pencil size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Reserves & Envelopes Control */}
      {runway?.envelopes && runway.envelopes.length > 0 && (
        <div className="envelopes-card">
          <div className="envelopes-card-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck
                size={15}
                strokeWidth={1.75}
                style={{
                  color: runway.envelopes.every((e) => e.status === 'green')
                    ? '#10b981'
                    : runway.envelopes.some((e) => e.status === 'red')
                    ? '#f87171'
                    : '#f59e0b',
                }}
              />
              <span className="envelopes-card-title">{t('finances.reserveControlTitle')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="envelopes-card-summary tabular-nums">
                {(() => {
                  const totalDeficit = runway.envelopes.reduce((sum, e) => sum + (e.deficit_eur || 0), 0);
                  if (totalDeficit > 0) {
                    return (
                      <span style={{ color: '#f87171', fontWeight: 600 }}>
                        {t('finances.deficitPrefix', { amount: formatNumber(totalDeficit, { maximumFractionDigits: 0 }), currency: currSym })}
                      </span>
                    );
                  }
                  return <span style={{ color: 'var(--text-muted)' }}>{t('finances.allCovered')}</span>;
                })()}
              </span>
            </div>
          </div>

          <div className="envelopes-list">
            {runway.envelopes.map((env: EnvelopeStatus) => {
              const cleanTitle = env.name.replace(/\s*\([^)]*\)$/, '').trim() || env.name;
              const envLower = env.envelope_id.toLowerCase();
              const titleLower = cleanTitle.toLowerCase();
              const isSelected =
                activeBankName !== null &&
                (activeBankName.toLowerCase().includes(envLower) ||
                  activeBankName.toLowerCase().includes(titleLower));

              const handleEnvelopeClick = () => {
                triggerHaptic('light');
                const matched = groupedAccounts.find((grp) => {
                  const lower = grp.name.toLowerCase();
                  return lower.includes(envLower) || lower.includes(titleLower);
                });
                if (matched) {
                  setActiveBankName(activeBankName === matched.name ? null : matched.name);
                }
              };

              return (
                <div
                  key={env.envelope_id}
                  className={`envelope-row ${isSelected ? 'active' : ''}`}
                  onClick={handleEnvelopeClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleEnvelopeClick();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="envelope-row-main">
                    <div className="envelope-info">
                      <div className="envelope-title-line">
                        <span className="envelope-name">{cleanTitle}</span>
                        <span className={`envelope-badge ${env.status}`}>
                          <span className={`envelope-dot ${env.status}`} />
                          {env.status === 'green'
                            ? t('finances.coveredBadge')
                            : env.status === 'yellow'
                            ? t('finances.tightBadge')
                            : t('finances.deficitBadge')}
                        </span>
                      </div>
                      <span className="envelope-role">{env.role}</span>
                    </div>

                    <div className="envelope-amounts">
                      <div className="envelope-balance-line tabular-nums">
                        <span className="envelope-current">
                          ~{formatNumber(env.current_balance_eur, { maximumFractionDigits: 0 })} {currSym}
                        </span>
                        <span className="envelope-divider">/</span>
                        <span className="envelope-required">
                          {formatNumber(env.required_reserve_eur, { maximumFractionDigits: 0 })} {currSym}
                        </span>
                      </div>
                      {env.deficit_eur > 0 ? (
                        <span className="envelope-deficit tabular-nums">
                          {t('finances.deficitPrefix', { amount: formatNumber(env.deficit_eur, { maximumFractionDigits: 0 }), currency: currSym })}
                        </span>
                      ) : (
                        <span className="envelope-ratio tabular-nums">
                          {t('finances.coveredPct', { pct: Math.round(env.coverage_ratio * 100) })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="envelope-track">
                    <div
                      className={`envelope-fill ${env.status}`}
                      style={{
                        width: `${Math.min(100, Math.max(0, env.coverage_ratio * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Monthly Payment Schedule Card */}
      {(() => {
        const scheduledLiabs = liabilities.filter(
          (l) => l.monthly_payment && l.payment_day && !isFrozenLiability(l)
        );
        const remainingToPayRub = scheduledLiabs
          .filter((l) => l.currency === 'RUB' && !l.is_paid_this_month)
          .reduce((acc, l) => acc + (l.monthly_payment || 0), 0);
        const totalMonthlyRub = scheduledLiabs
          .filter((l) => l.currency === 'RUB')
          .reduce((acc, l) => acc + (l.monthly_payment || 0), 0);

        return (
          <div className="liabilities-summary-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('finances.monthPayments')}</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span
                  className="tabular-nums"
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: remainingToPayRub > 0 ? 'var(--accent-color)' : '#10b981',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5
                  }}
                >
                  {remainingToPayRub > 0 ? (
                    t('finances.toPaySuffix', { amount: formatNumber(remainingToPayRub), currency: '₽' })
                  ) : (
                    <>
                      <CheckCircle2 size={14} /> {t('finances.allPaid')}
                    </>
                  )}
                </span>
                {remainingToPayRub !== totalMonthlyRub && (
                  <span className="tabular-nums" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('finances.ofTotal', { amount: formatNumber(totalMonthlyRub), currency: '₽' })}
                  </span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {scheduledLiabs
                .sort((a, b) => (a.payment_day || 0) - (b.payment_day || 0))
                .map((l) => (
                  <div
                    key={l.id}
                    className="payment-schedule-pill"
                    style={{
                      opacity: l.is_paid_this_month ? 0.65 : 1,
                      background: l.is_paid_this_month ? 'rgba(16, 185, 129, 0.06)' : undefined
                    }}
                  >
                    <span
                      className="pay-day-badge tabular-nums"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 62 }}
                    >
                      <Calendar size={12} />
                      {t('finances.daySuffix', { day: l.payment_day ?? '' })}
                    </span>
                    <span className="pay-name" style={{ textDecoration: l.is_paid_this_month ? 'line-through' : 'none' }}>
                      {l.name}
                    </span>
                    {l.is_paid_this_month ? (
                      <span
                        style={{
                          fontSize: 12,
                          color: '#10b981',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        <CheckCircle2 size={12} />
                        {t('finances.paidStatus')}
                      </span>
                    ) : (
                      <span className="pay-amount tabular-nums">
                        {l.monthly_payment !== undefined && l.monthly_payment !== null ? formatNumber(l.monthly_payment) : ''} {l.currency}
                      </span>
                    )}
                  </div>
                ))}
            </div>
          </div>
        );
      })()}

      {/* 4. Calm Spoiler for Full Debt Queues */}
      <button
        type="button"
        className="spoiler-toggle-btn"
        onClick={() => {
          triggerHaptic('light');
          setShowAllLiabilities(!showAllLiabilities);
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={16} />
          <span className="tabular-nums">{t('finances.allLiabilitiesAndQueues', { count: liabilities.length })}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {showTotals && (
            <span className="tabular-nums" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              ~{formatNumber(liabilities.reduce((acc, l) => acc + l.amount_eur, 0), { maximumFractionDigits: 0 })} {currSym}
            </span>
          )}
          {showAllLiabilities ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {showAllLiabilities && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Queue Filter Chips */}
          <div className="categories-bar" style={{ marginTop: 2 }}>
            <button
              className={`category-chip ${activeLiabilityQueue === null ? 'active' : ''} tabular-nums`}
              onClick={() => { triggerHaptic('light'); setActiveLiabilityQueue(null); }}
            >
              {t('common.all')} ({liabilities.length})
            </button>
            <button
              className={`category-chip ${activeLiabilityQueue === 'bank' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setActiveLiabilityQueue('bank'); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <Building2 size={13} />
              {t('finances.bankQueue')}
            </button>
            <button
              className={`category-chip ${activeLiabilityQueue === 'queue_1' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setActiveLiabilityQueue('queue_1'); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <span className="queue-dot" style={{ background: '#ef4444' }} />
              {t('finances.queue1')}
            </button>
            <button
              className={`category-chip ${activeLiabilityQueue === 'queue_2' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setActiveLiabilityQueue('queue_2'); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <span className="queue-dot" style={{ background: '#f59e0b' }} />
              {t('finances.queue2')}
            </button>
            <button
              className={`category-chip ${activeLiabilityQueue === 'queue_3' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setActiveLiabilityQueue('queue_3'); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <span className="queue-dot" style={{ background: '#94a3b8' }} />
              {t('finances.queue3')}
            </button>
            <button
              className={`category-chip ${activeLiabilityQueue === 'investors' ? 'active' : ''}`}
              onClick={() => { triggerHaptic('light'); setActiveLiabilityQueue('investors'); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <Briefcase size={13} />
              {t('finances.investorsQueue')}
            </button>
          </div>

          {/* Liabilities Cards List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredLiabilities.map((l) => {
              const queueBadgeMap: Record<string, { label: string; color: string }> = {
                bank: { label: t('finances.bankBadge'), color: '#3b82f6' },
                queue_1: { label: t('finances.queue1Badge'), color: '#ef4444' },
                queue_2: { label: t('finances.queue2Badge'), color: '#f59e0b' },
                queue_3: { label: t('finances.queue3Badge'), color: '#94a3b8' },
                investors: { label: t('finances.investorBadge'), color: '#10b981' }
              };
              const qInfo = queueBadgeMap[l.queue] || { label: l.queue, color: '#64748b' };
              const isFrozen = isFrozenLiability(l);

              return (
                <div key={l.id} className="liability-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14.5, fontWeight: 600 }}>{l.name}</span>
                        <span
                          style={{
                            fontSize: 12,
                            padding: '1px 6px',
                            borderRadius: 8,
                            background: `${qInfo.color}1a`,
                            color: qInfo.color,
                            fontWeight: 600
                          }}
                        >
                          {qInfo.label}
                        </span>
                        {isFrozen && (
                          <span
                            style={{
                              fontSize: 12,
                              padding: '1px 6px',
                              borderRadius: 8,
                              background: 'rgba(148, 163, 184, 0.16)',
                              color: '#94a3b8',
                              fontWeight: 600
                            }}
                          >
                            {t('finances.pausedFrozen')}
                          </span>
                        )}
                        {l.is_paid_this_month && (
                          <span
                            style={{
                              fontSize: 12,
                              padding: '1px 6px',
                              borderRadius: 8,
                              background: 'rgba(16, 185, 129, 0.15)',
                              color: '#10b981',
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4
                            }}
                          >
                            <CheckCircle2 size={12} />
                            {t('finances.paidStatus')}
                          </span>
                        )}
                        {l.account_name && (
                          <span
                            style={{
                              fontSize: 12,
                              padding: '1px 6px',
                              borderRadius: 8,
                              background: 'rgba(59, 130, 246, 0.12)',
                              color: '#3b82f6',
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4
                            }}
                          >
                            <CreditCard size={12} />
                            {l.account_name}
                          </span>
                        )}
                      </div>
                      {l.notes && (
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
                          {l.notes}
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn-link"
                        style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, padding: 0 }}
                        onClick={() => {
                          triggerHaptic('light');
                          setLinkingLiability(l);
                        }}
                      >
                        {l.account_name ? t('finances.changeAccount') : t('finances.linkAccount')}
                      </button>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      <div className="tabular-nums" style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {formatNumber(l.amount)} {l.currency}
                      </div>
                      {l.currency !== baseCurrency && (
                        <div className="tabular-nums" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          ~{formatNumber(l.amount_eur, { maximumFractionDigits: 0 })} {currSym}
                        </div>
                      )}
                      {!l.is_paid_this_month && l.monthly_payment && !isFrozen && (
                        <button
                          type="button"
                          className="btn-link"
                          style={{ fontSize: 12, color: 'var(--accent-color)', marginTop: 2, padding: 0 }}
                          onClick={async () => {
                            triggerHaptic('medium');
                            const accMsg = l.account_name
                              ? t('finances.payConfirmFromAccount', { account: l.account_name })
                              : '';
                            const deduct = await showConfirm(
                              t('finances.payConfirm', {
                                amount: l.monthly_payment ?? 0,
                                currency: l.currency,
                                accountPart: accMsg,
                              })
                            );
                            await payLiability(l.id, { deduct_from_account: deduct, account_id: l.account_id || undefined });
                            await loadFinances();
                          }}
                        >
                          {t('finances.markPayment')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 5. Category Budgets & Recent Transactions */}
      {!hasBudgets && !hasTransactions ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--text-muted)',
            textAlign: 'center',
            padding: '10px 14px',
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {t('finances.emptyFinancesHint')}
        </div>
      ) : (
        <>
          {hasBudgets && (
            <>
              <div className="section-header-row">
                <span className="section-title">{t('finances.categoryBudgets')}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {finSummary!.categories.map((cat) => {
                  const pct = cat.percent_used || 0;
                  const isOver = pct > 100;
                  const isWarn = pct > 80 && pct <= 100;
                  return (
                    <div key={cat.category_name} className="budget-card">
                      <div className="budget-info">
                        <span className="budget-name">{cat.category_name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="budget-amounts tabular-nums">
                            {formatNumber(cat.spent_eur, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {currSym}
                            {cat.limit_eur ? ` / ${formatNumber(cat.limit_eur, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currSym}` : ''}
                          </span>
                          <button
                            type="button"
                            className="btn-link"
                            style={{ fontSize: 12 }}
                            onClick={() => {
                              setBudgetModalCategory(cat.category_name);
                              setBudgetLimitInput(cat.limit_eur ? String(cat.limit_eur) : '');
                            }}
                          >
                            {t('finances.limitBtn')}
                          </button>
                        </div>
                      </div>
                      {cat.limit_eur && (
                        <div className="progress-track">
                          <div
                            className={`progress-fill ${isOver ? 'danger' : isWarn ? 'warning' : ''}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {budgetModalCategory && (
            <div className="task-form" style={{ borderColor: 'var(--accent-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {t('finances.monthLimitFor', { category: budgetModalCategory })}
                </span>
                <button className="btn-link" aria-label={t('common.close')} onClick={() => setBudgetModalCategory(null)}>
                  <X size={16} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  type="number"
                  className="input-field"
                  aria-label={t('finances.limitPlaceholderEur', { currency: baseCurrency })}
                  placeholder={t('finances.limitPlaceholderEur', { currency: baseCurrency })}
                  value={budgetLimitInput}
                  onChange={(e) => setBudgetLimitInput(e.target.value)}
                  autoFocus
                />
                <button className="btn-primary" onClick={handleSaveBudget}>
                  {t('common.save')}
                </button>
              </div>
            </div>
          )}

          {hasTransactions && (
            <>
              <div className="section-header-row">
                <span className="section-title">{t('finances.recentTransactions')}</span>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    onClick={async () => {
                      triggerHaptic('medium');
                      try {
                        const res = await undoLastTransaction();
                        await showAlert(res.message);
                        await loadFinances();
                      } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : t('finances.errUndo');
                        await showAlert(message);
                      }
                    }}
                  >
                    <RotateCcw size={13} />
                    {t('finances.undo')}
                  </button>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ fontSize: 12, opacity: 0.7 }}
                    onClick={async () => {
                      if (!await showConfirm(t('finances.clearConfirm'))) return;
                      triggerHaptic('light');
                      await resetFinances();
                      await loadFinances();
                    }}
                  >
                    {t('common.clear')}
                  </button>
                </div>
              </div>
              <div className="transactions-list">
                {transactions.map((tx) => {
                  const isExpense = tx.kind === 'expense';
                  const isIncome = tx.kind === 'income';
                  const sign = isIncome ? '+' : isExpense ? '-' : '';
                  const dateStr = formatDate(tx.occurred_at, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit'
                  });

                  return (
                    <div key={tx.id} className="transaction-card">
                      <div className="tx-main">
                        <span className="tx-desc">
                          {tx.description || tx.category_name || (tx.kind === 'transfer' ? t('finances.transferLabel') : t('finances.exchangeLabel'))}
                        </span>
                        <span className="tx-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {tx.account_name}
                          {tx.to_account_name && (
                            <>
                              <ArrowRight size={11} style={{ opacity: 0.7 }} />
                              {tx.to_account_name}
                            </>
                          )}
                          {' • '}
                          {dateStr}
                        </span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span className={`tx-amount tabular-nums ${tx.kind}`}>
                          {sign}{formatNumber(Math.abs(tx.amount), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {tx.currency}
                        </span>
                        {tx.currency !== baseCurrency && (
                          <div className="tabular-nums" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            ~{Math.abs(tx.amount_eur).toFixed(2)} {currSym}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* Account Picker Bottom-Sheet Modal */}
      {linkingLiability && (
        <div
          className="sheet-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setLinkingLiability(null);
            }
          }}
        >
          <div className="sheet-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                {t('finances.linkAccountFor', { name: linkingLiability.name })}
              </span>
              <button
                type="button"
                className="btn-link"
                aria-label={t('common.close')}
                onClick={() => setLinkingLiability(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '60vh', overflowY: 'auto' }}>
              {accounts.map((acc) => {
                const isSelected = linkingLiability.account_id === acc.id;
                return (
                  <button
                    key={acc.id}
                    type="button"
                    className={`sheet-option-btn ${isSelected ? 'selected' : ''}`}
                    onClick={async () => {
                      triggerHaptic('light');
                      await updateLiability(linkingLiability.id, { account_id: acc.id });
                      setLinkingLiability(null);
                      await loadFinances();
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{acc.name}</span>
                      <span className="currency-badge">{acc.currency}</span>
                    </div>
                    <span className="tabular-nums" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                      {formatNumber(acc.current_balance, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {acc.currency}
                    </span>
                  </button>
                );
              })}
              {linkingLiability.account_id && (
                <button
                  type="button"
                  className="sheet-option-btn"
                  style={{ color: '#ef4444', justifyContent: 'center' }}
                  onClick={async () => {
                    triggerHaptic('light');
                    await updateLiability(linkingLiability.id, { account_id: undefined });
                    setLinkingLiability(null);
                    await loadFinances();
                  }}
                >
                  {t('finances.unlinkAccount')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Account Edit/Create Bottom-Sheet Modal */}
      {(editingAccount || isCreatingAccount) && (
        <div
          className="sheet-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setEditingAccount(null);
              setIsCreatingAccount(false);
            }
          }}
        >
          <div className="sheet-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                {editingAccount ? t('finances.editAccountHeader', { name: editingAccount.name }) : t('finances.newAccountHeader')}
              </span>
              <button
                type="button"
                className="btn-link"
                aria-label={t('common.close')}
                onClick={() => {
                  setEditingAccount(null);
                  setIsCreatingAccount(false);
                }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveAccountForm} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  {t('finances.accountNameLabel')}
                </label>
                <input
                  type="text"
                  required
                  placeholder={t('finances.accountNamePlaceholder')}
                  value={accountFormName}
                  onChange={(e) => setAccountFormName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-hairline)',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: '1 1 120px' }}>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    {t('finances.currencyLabel')}
                  </label>
                  <select
                    value={accountFormCurrency}
                    onChange={(e) => setAccountFormCurrency(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(0, 0, 0, 0.4)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-primary)',
                      fontSize: 13,
                    }}
                  >
                    <option value="EUR">EUR (€)</option>
                    <option value="RUB">RUB (₽)</option>
                    <option value="USD">USD ($)</option>
                    <option value="KZT">KZT (₸)</option>
                    <option value="TRY">TRY (₺)</option>
                    <option value="USDT">USDT</option>
                  </select>
                </div>

                <div style={{ flex: '2 1 160px' }}>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    {t('finances.balanceLabel')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={accountFormBalance}
                    onChange={(e) => setAccountFormBalance(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(0, 0, 0, 0.4)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-primary)',
                      fontSize: 13,
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                  {t('finances.envelopeLabel')}
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setAccountFormEnvelope('spendable')}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: accountFormEnvelope === 'spendable' ? '1px solid #10b981' : '1px solid var(--border-hairline)',
                      background: accountFormEnvelope === 'spendable' ? 'rgba(16, 185, 129, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                      color: accountFormEnvelope === 'spendable' ? '#34d399' : 'var(--text-secondary)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {t('finances.envelopeSpendable')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAccountFormEnvelope('reserved')}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: accountFormEnvelope === 'reserved' ? '1px solid #3b82f6' : '1px solid var(--border-hairline)',
                      background: accountFormEnvelope === 'reserved' ? 'rgba(59, 130, 246, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                      color: accountFormEnvelope === 'reserved' ? '#60a5fa' : 'var(--text-secondary)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {t('finances.envelopeReserved')}
                  </button>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                  {accountFormEnvelope === 'spendable'
                    ? t('finances.spendableDesc')
                    : t('finances.reservedDesc')}
                </span>
              </div>

              {accountActionError && (
                <div style={{ fontSize: 12, color: '#fca5a5' }}>
                  {accountActionError}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => {
                    setEditingAccount(null);
                    setIsCreatingAccount(false);
                  }}
                  className="btn-secondary"
                  style={{ padding: '8px 14px', fontSize: 13 }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSavingAccount}
                  className="btn-primary"
                  style={{ padding: '8px 18px', fontSize: 13 }}
                >
                  {isSavingAccount ? t('common.saving') : editingAccount ? t('common.save') : t('finances.createAccountBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
