/**
 * GET /api/docs/chapters → `src/endpoints/docs_chapters.ts`.
 *
 * Порт `backend/app/api/docs.py::list_documentation_chapters`:
 * `DocChapterSummary` — без полного текста и секций (`content=''`,
 * `sections=[]`), только сводка и количество секций.
 */

import { requireUserId } from '../lib/auth.js';
import { listDocs } from '../lib/systemDocs.js';
import type { DocSection } from '../lib/systemDocs.js';

export interface DocSectionSchema {
  chapter_slug: string;
  chapter_title: string;
  section_title: string;
  level: number;
  content: string;
}

export interface DocChapterSummarySchema {
  slug: string;
  filename: string;
  title: string;
  summary: string;
  sections_count: number;
  content: string;
  sections: DocSectionSchema[];
}

/** Секция → `DocSectionOut` (camelCase DAL → snake_case). */
export function toSectionSchema(section: DocSection): DocSectionSchema {
  return {
    chapter_slug: section.chapterSlug,
    chapter_title: section.chapterTitle,
    section_title: section.sectionTitle,
    level: section.level,
    content: section.content,
  };
}

export default async function (
  input: Record<string, unknown>,
  ctx?: { initData?: { user?: { id?: number } } },
): Promise<DocChapterSummarySchema[]> {
  const userId = requireUserId(input, ctx);

  const chapters = await listDocs(userId);
  return chapters.map((chapter) => ({
    slug: chapter.slug,
    filename: chapter.filename ?? `${chapter.slug}.md`,
    title: chapter.title,
    summary: chapter.summary,
    sections_count: chapter.sections.length,
    content: '',
    sections: [],
  }));
}
