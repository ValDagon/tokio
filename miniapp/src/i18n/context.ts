import { createContext, useContext } from 'react';
import {
  formatCurrency as formatCurrencyCore,
  formatDate as formatDateCore,
  formatNumber as formatNumberCore,
  translate,
  type LocaleCode,
} from './core';

export interface I18nContextValue {
  locale: LocaleCode;
  setLocale: (next: LocaleCode) => Promise<void>;
  applyLocale: (next: LocaleCode) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatCurrency: (amount: number, currency?: string, options?: Intl.NumberFormatOptions) => string;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'ru',
  setLocale: async () => {},
  applyLocale: () => {},
  t: (key, vars) => translate('ru', key, vars),
  formatNumber: (value, options) => formatNumberCore('ru', value, options),
  formatDate: (date, options) => formatDateCore('ru', date, options),
  formatCurrency: (amount, currency, options) => formatCurrencyCore('ru', amount, currency, options),
});

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
