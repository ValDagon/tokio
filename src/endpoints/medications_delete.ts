/**
 * DELETE /api/medications/{id} → `src/endpoints/medications_delete.ts`.
 *
 * Порт `backend/app/api/routes.py::delete_medication` +
 * `backend/app/services/medications.py::delete_user_medication`.
 *
 * Паритет с upstream: роут игнорирует результат удаления и ВСЕГДА отвечает
 * `{"status": "deleted"}` (в том числе для несуществующего/чужого id) — 404
 * здесь не отдаётся, в отличие от take/skip.
 */

import { EndpointError } from 'sdk';
import { requireUserId } from '../lib/auth.js';
import { deleteMedication } from '../lib/dal/medications.js';

export interface MedicationDeleteResponse {
  status: 'deleted';
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<MedicationDeleteResponse> {
  const userId = requireUserId(input, ctx);

  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new EndpointError('Invalid medication id', { code: 'BAD_REQUEST' });
  }

  await deleteMedication(userId, id);
  return { status: 'deleted' };
}
