import { builtinBotCompanion, DEFAULT_BOT_COMPANION_ID } from './builtin-bot-companions';
import dafeiyuDocumentTemplates from './builtin-bot-persona-data.json';

export interface BuiltinBotPersonaTemplate {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
}

/**
 * The document templates contain only the user-provided DOCX “人格设定” body,
 * preserving its paragraphs and examples. AstrBot export metadata is excluded.
 * These are editable character descriptions, not host tool or permission policy.
 * Keep document IDs separate from `default` so upgrades preserve existing personas.
 */
export function builtinBotPersonaTemplates(companionId: string): readonly BuiltinBotPersonaTemplate[] {
  const builtin = builtinBotCompanion(companionId);
  if (!builtin) return [];
  const defaults: BuiltinBotPersonaTemplate = { id: 'default', name: '默认人格', prompt: builtin.persona };
  return companionId === DEFAULT_BOT_COMPANION_ID
    ? [defaults, ...dafeiyuDocumentTemplates]
    : [defaults];
}
