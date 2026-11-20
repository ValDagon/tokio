/**
 * Тулзы агента: системная документация (SPEC §3 T12, паритет с
 * `backend/app/agent/tools/system_docs.py`).
 *
 * Тонкая обёртка над `searchDocs`: никакой собственной логики поиска, вся
 * работа с главами — в `src/lib/systemDocs.ts`. Ошибка чтения документации
 * возвращается текстом (`ok:false`), как в upstream, чтобы модель могла
 * продолжить диалог без падения turn'а.
 */

import { searchDocs } from '../../systemDocs';
import type { Tool, ToolArgs, ToolContext, ToolOutcome } from '../registry';
import { asText, errorText, fail } from './tasks';

// ---------------------------------------------------------------------------
// consult_system_docs
// ---------------------------------------------------------------------------

async function consultSystemDocs(args: ToolArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const query = asText(args.query);
  if (!query) return fail('Пустой запрос — нечего искать в документации.');

  const topic = asText(args.topic);

  try {
    const content = await searchDocs(ctx.userId, query, topic ?? undefined);
    return { ok: true, content, data: { query, topic } };
  } catch (error) {
    return fail(`Ошибка при обращении к документации: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

export const systemDocsTools: Tool[] = [
  {
    name: 'consult_system_docs',
    description:
      'Ищет ответ в системной документации пользователя (главы-инструкции: профиль, финансы, здоровье, проекты, персонализация).',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Вопрос или ключевые слова для поиска по главам.' },
        topic: {
          type: 'string',
          description: 'Опциональный слаг/тема главы (например «финансы», «здоровье»).',
        },
      },
      required: ['query'],
    },
    run: consultSystemDocs,
  },
];

