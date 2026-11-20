/**
 * POST /api/medications/{id}/take → `src/endpoints/medications_take.ts`.
 *
 * Порт `backend/app/api/routes.py::take_medication` +
 * `backend/app/services/medications.py::log_medication_action(action='take')`.
 * Не найден или чужой медикамент → 404 `Medication not found`.
 */

import { EndpointError } from 'sdk';
import { requireUserId } from '../lib/auth.js';
import { takeMedication } from '../lib/dal/medications.js';
import { userToday } from './medications_list.js';

export interface MedicationActionResponse {
  status: 'taken';
  scheduled_time: string;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<MedicationActionResponse> {
  const userId = requireUserId(input, ctx);

  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new EndpointError('Invalid medication id', { code: 'BAD_REQUEST' });
  }
  const scheduledTime =
    typeof input.scheduled_time === 'string' && input.scheduled_time.trim()
      ? input.scheduled_time
      : '09:00';

  const action = await takeMedication(userId, id, scheduledTime, await userToday(userId));
  if (!action) {
    throw new EndpointError('Medication not found', { code: 'NOT_FOUND' });
  }

  return { status: 'taken', scheduled_time: scheduledTime };
}
