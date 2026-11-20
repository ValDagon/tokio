/**
 * GET /api/system/digest → `src/endpoints/system_digest.ts`.
 *
 * Порт `backend/app/api/routes.py::get_system_digest`: готовый текст утреннего
 * дайджеста (`generate_morning_digest_text` → `buildMorningDigest`).
 */

import { requireUserId } from '../lib/auth.js';
import { buildMorningDigest } from '../lib/digest.js';

export interface SystemDigestResponse {
  digest: string;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<SystemDigestResponse> {
  const userId = requireUserId(input, ctx);

  return { digest: await buildMorningDigest(userId) };
}
