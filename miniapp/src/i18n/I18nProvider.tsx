import React, { useCallback, useMemo, useState } from 'react';
import { updateSettings } from '../api';
import { I18nContext, type I18nContextValue } from './context';
import {
  detectInitialLocale,
  formatCurrency as formatCurrencyCore,
  formatDate as formatDateCore,
  formatNumber as formatNumberCore,
  normalizeLocale,
  setStoredLocale,
  translate,
  type LocaleCode,
} from './core';

export interface I18nProviderProps {
  children: React.ReactNode;
  initialLocale?: LocaleCode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({ children, initialLocale }) => {
  const [locale, setLocaleState] = useState<LocaleCode>(() => {
    const detected = initialLocale ?? detectInitialLocale();
    if (typeof document !== 'undefined') {
      document.documentElement.lang = detected;
    }
    return detected;
  });

  const applyLocale = useCallback((next: LocaleCode) => {
    const normalized = normalizeLocale(next, 'ru');
    setLocaleState(normalized);
    setStoredLocale(normalized);
  }, []);

  const setLocale = useCallback(async (next: LocaleCode) => {
    const normalized = normalizeLocale(next, 'ru');
    setLocaleState(normalized);
    setStoredLocale(normalized);
    try {
      await updateSettings({ language: normalized });
    } catch {
      // ignore in standalone dev/offline mode
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  );

  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) => formatNumberCore(locale, value, options),
    [locale]
  );

  const formatDate = useCallback(
    (date: Date | string | number, options?: Intl.DateTimeFormatOptions) =>
      formatDateCore(locale, date, options),
    [locale]
  );

  const formatCurrency = useCallback(
    (amount: number, currency?: string, options?: Intl.NumberFormatOptions) =>
      formatCurrencyCore(locale, amount, currency, options),
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      applyLocale,
      t,
      formatNumber,
      formatDate,
      formatCurrency,
    }),
    [locale, setLocale, applyLocale, t, formatNumber, formatDate, formatCurrency]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};
