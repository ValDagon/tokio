/**
 * GET /api/user/settings → `src/endpoints/user_settings_get.ts`.
 *
 * Порт `backend/app/api/routes.py::get_user_settings` (`UserSettingsSchema`).
 *
 * Отличия от upstream (осознанные, из-за схемы платформы):
 *  - в таблице `users` нет колонок `custom_instructions` и `persona_style` —
 *    отдаём константы `''` и `'mentor'` (upstream вернул бы сохранённые
 *    значения, а для несуществующего пользователя — `None` / `'mentor'`);
 *  - upstream держит дефолт `timezone` жёстко в routes.py (значение
 *    владельца); в порте оно не воспроизводится — DDL платформы даёт
 *    `timezone DEFAULT 'UTC'`, поэтому отсутствие строки пользователя
 *    возвращает `UTC`;
 *  - отсутствие строки пользователя не ошибка: отдаём дефолтный профиль
 *    ровно как upstream `return UserSettingsSchema()`.
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { getUser } from '../lib/dal/users.js';
import type { UserRow } from '../types.js';

/** `UserSettingsSchema` из routes.py (snake_case). */
export interface UserSettingsSchema {
  base_currency: string;
  timezone: string;
  low_stimulation_mode: boolean;
  custom_instructions: string;
  persona_style: string;
}

/** Дефолты для пользователя без строки в `users` (upstream `UserSettingsSchema()`). */
export const DEFAULT_USER_SETTINGS: UserSettingsSchema = {
  base_currency: 'EUR',
  timezone: 'UTC',
  low_stimulation_mode: false,
  custom_instructions: '',
  persona_style: 'mentor',
};

/** Строка DAL → схема ответа. Отсутствующие в схеме колонки — константы. */
export function toUserSettings(user: UserRow | null): UserSettingsSchema {
  if (!user) return { ...DEFAULT_USER_SETTINGS };
  return {
    base_currency: user.baseCurrency || DEFAULT_USER_SETTINGS.base_currency,
    timezone: user.timezone || DEFAULT_USER_SETTINGS.timezone,
    low_stimulation_mode: user.lowStimulationMode,
    custom_instructions: DEFAULT_USER_SETTINGS.custom_instructions,
    persona_style: DEFAULT_USER_SETTINGS.persona_style,
  };
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<UserSettingsSchema> {
  const userId = requireUserId(input, ctx);

  const user = await getUser(userId);
  return toUserSettings(user);
}
