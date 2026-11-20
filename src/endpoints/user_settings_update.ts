/**
 * PATCH /api/user/settings → `src/endpoints/user_settings_update.ts`.
 *
 * Порт `backend/app/api/routes.py::update_user_settings` (`UserSettingsUpdateSchema`
 * → `UserSettingsSchema`).
 *
 * Паритет с upstream:
 *  - меняются только переданные ключи (`None` в pydantic = «не трогать»);
 *  - `base_currency` приводится к верхнему регистру (`.upper()`);
 *  - после апдейта возвращается полный профиль, как `UserSettingsSchema`.
 *
 * Отличия от upstream (осознанные, из-за схемы платформы):
 *  - `custom_instructions` и `persona_style` в таблице `users` отсутствуют:
 *    принимаем их, но НЕ сохраняем (в ответе — константы из GET);
 *  - дополнительно поддерживаем `timezone` (в upstream его нет в body, но он
 *    есть в response-схеме и в DDL платформы; спека T16 перечисляет его
 *    в «partial above»);
 *  - если строки пользователя нет, `updateUser` возвращает `null` — отдаём
 *    дефолтный профиль (upstream на отсутствующей строке упал бы на `None`).
 */

import { EndpointError } from 'sdk';
import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import { updateUser, type UserPatch } from '../lib/dal/users.js';
import { toUserSettings, type UserSettingsSchema } from './user_settings_get.js';

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<UserSettingsSchema> {
  const userId = requireUserId(input, ctx);

  const patch: UserPatch = {};

  if (Object.hasOwn(input, 'low_stimulation_mode') && input.low_stimulation_mode !== null) {
    if (typeof input.low_stimulation_mode !== 'boolean') {
      throw new EndpointError('Invalid low_stimulation_mode', { code: 'BAD_REQUEST' });
    }
    patch.lowStimulationMode = input.low_stimulation_mode;
  }

  if (Object.hasOwn(input, 'base_currency') && input.base_currency !== null) {
    if (typeof input.base_currency !== 'string') {
      throw new EndpointError('Invalid base_currency', { code: 'BAD_REQUEST' });
    }
    patch.baseCurrency = input.base_currency.toUpperCase();
  }

  if (Object.hasOwn(input, 'timezone') && input.timezone !== null) {
    if (typeof input.timezone !== 'string') {
      throw new EndpointError('Invalid timezone', { code: 'BAD_REQUEST' });
    }
    patch.timezone = input.timezone;
  }

  // `custom_instructions` / `persona_style` — колонок нет, поэтому игнорируем.

  const updated = await updateUser(userId, patch);
  return toUserSettings(updated);
}
