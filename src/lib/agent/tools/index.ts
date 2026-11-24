/**
 * Сборка всех тулз агента в один реестр (SPEC §3 T12/T13, паритет с
 * `backend/app/agent/tools/__init__.py::get_all_tools`).
 *
 * Модуль сознательно без побочных эффектов: импорт НЕ регистрирует тулзы в
 * глобальном реестре — это делает вызывающий код через `registerAllTools()`.
 * Так тесты изолируются (`clearTools`) и движок T11 остаётся агностичным к
 * составу тулз (`runAgent({ tools })` или явная регистрация).
 *
 * Порядок массива — порядок тулз в системном промпте: первыми идут
 * «живые» домены (задачи, заметки, финансы), затем медикаменты, runway,
 * справочники (корзина, документация) и reasoning-блок.
 */

import type { Tool } from '../registry';
import { replaceTool } from '../registry';
import { configTools } from './config';
import { diaryTools } from './diary';
import { financeTools } from './finances';
import { medicationTools } from './medications';
import { notesTools } from './notes';
import { reasoningTools } from './reasoning';
import { runwayTools } from './runway';
import { systemDocsTools } from './systemDocs';
import { tasksTools } from './tasks';
import { trashTools } from './trash';
import { triageTools } from './triage';

export {
  configTools,
  diaryTools,
  financeTools,
  medicationTools,
  notesTools,
  reasoningTools,
  runwayTools,
  systemDocsTools,
  tasksTools,
  trashTools,
  triageTools,
};

/** Домен тулз: по нему каталог в промпте сужается под запрос (`prompts.ts`). */
export type ToolDomain =
  | 'tasks'
  | 'notes'
  | 'diary'
  | 'triage'
  | 'finance'
  | 'medications'
  | 'runway'
  | 'trash'
  | 'system_docs'
  | 'reasoning'
  | 'config';

/**
 * Тулзы по доменам — единственный источник имён для фильтра каталога.
 * `agentTools` собирается из этих групп, поэтому новый домен нельзя добавить
 * мимо каталога: имя появится в промпте и в фильтре одновременно.
 */
export const TOOL_GROUPS: Readonly<Record<ToolDomain, readonly Tool[]>> = {
  tasks: tasksTools,
  notes: notesTools,
  diary: diaryTools,
  triage: triageTools,
  finance: financeTools,
  medications: medicationTools,
  runway: runwayTools,
  trash: trashTools,
  system_docs: systemDocsTools,
  reasoning: reasoningTools,
  config: configTools,
};

/** Все тулзы агента в каноническом порядке (upstream: `ALL_TOOLS`). */
export const agentTools: readonly Tool[] = [
  ...TOOL_GROUPS.tasks,
  ...TOOL_GROUPS.notes,
  ...TOOL_GROUPS.diary,
  ...TOOL_GROUPS.triage,
  ...TOOL_GROUPS.finance,
  ...TOOL_GROUPS.medications,
  ...TOOL_GROUPS.runway,
  ...TOOL_GROUPS.trash,
  ...TOOL_GROUPS.system_docs,
  ...TOOL_GROUPS.reasoning,
  ...TOOL_GROUPS.config,
];

/**
 * Зарегистрировать все тулзы в глобальном реестре движка.
 * Идемпотентно: существующие имена перезаписываются (`replaceTool`),
 * поэтому повторный вызов безопасен при горячей перезагрузке.
 */
export function registerAllTools(): readonly Tool[] {
  for (const tool of agentTools) replaceTool(tool);
  return agentTools;
}
