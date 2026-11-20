/**
 * GET /api/docs/search → `src/endpoints/docs_search.ts`.
 *
 * Порт `backend/app/api/docs.py::search_documentation`: `DocSearchResult`
 * `{query, topic, result}`. `result` — готовый текстовый блок из
 * `searchDocs` (оглавление / цитаты / «не найдено»).
 * `q` обязателен; в теле принимается и алиас `query` (path/query params на
 * платформе нет). `topic` нормализуется через `resolveTopic` — «финансы» → слаг
 * `03_finances` (upstream возвращал тему как пришла).
 */

import { EndpointError } from 'sdk';
import { requireUserId } from '../lib/auth.js';
import { resolveTopic, searchDocs } from '../lib/systemDocs.js';

export interface DocSearchResponseSchema {
  query: string;
  topic: string | null;
  result: string;
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<DocSearchResponseSchema> {
  const userId = requireUserId(input, ctx);

  const rawQuery = input.q ?? input.query;
  if (typeof rawQuery !== 'string') {
    throw new EndpointError('q is required', { code: 'BAD_REQUEST' });
  }
  const rawTopic = typeof input.topic === 'string' ? input.topic : null;
  // Поиск идёт по разрешённому слагу, а в ответе тема эхом — как в upstream.
  const resolvedTopic = resolveTopic(rawTopic);

  const result = await searchDocs(userId, rawQuery, resolvedTopic);

  return { query: rawQuery, topic: rawTopic, result };
}
