/**
 * GET /api/docs/chapters/{slug} → `src/endpoints/docs_chapter.ts`.
 *
 * Порт `backend/app/api/docs.py::get_documentation_chapter`:
 * `DocChapterDetail` — полный текст главы и разобранные секции.
 * Неизвестный слаг/тема → 404 с текстом upstream
 * `Documentation chapter '<slug>' not found`.
 */

import { EndpointError } from 'sdk';
import { requireUserId } from '../lib/auth.js';
import { getDoc } from '../lib/systemDocs.js';
import { toSectionSchema } from './docs_chapters.js';
import type { DocSectionSchema } from './docs_chapters.js';

export interface DocChapterDetailSchema {
  slug: string;
  filename: string;
  title: string;
  summary: string;
  content: string;
  sections: DocSectionSchema[];
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<DocChapterDetailSchema> {
  const userId = requireUserId(input, ctx);

  const rawSlug = typeof input.slug === 'string' ? input.slug : '';
  if (!rawSlug.trim()) {
    throw new EndpointError('slug is required', { code: 'BAD_REQUEST' });
  }

  const chapter = await getDoc(userId, rawSlug);
  if (!chapter) {
    throw new EndpointError(`Documentation chapter '${rawSlug}' not found`, {
      code: 'NOT_FOUND',
    });
  }

  return {
    slug: chapter.slug,
    filename: chapter.filename ?? `${chapter.slug}.md`,
    title: chapter.title,
    summary: chapter.summary,
    content: chapter.content,
    sections: chapter.sections.map(toSectionSchema),
  };
}
