import type { CompanionDraft } from './companions';
import { CATALOGUE_COMPANION_PROFILES } from './companion-catalogue';
import type { CompanionTemplateId } from './companion-template-ids';
import { builtinCompanionPersona } from './companion-character-templates';

/** Templates are not contacts. Only explicit creation instantiates these roles. */
export const BUILTIN_COMPANIONS: Array<CompanionDraft & { id: string }> = [
  { id: 'deepseek-sister', name: '大肥鱼', description: '温柔沉稳的鲸鱼姐姐 · Pro', model: '', avatar: 'sister', proactive: true, persona: builtinCompanionPersona('deepseek-sister') },
  { id: 'deepseek-flash', name: '小肥鱼', description: '活泼好奇的鲸鱼妹妹 · Flash', model: '', avatar: 'flash', proactive: true, persona: builtinCompanionPersona('deepseek-flash') },
  ...CATALOGUE_COMPANION_PROFILES.map(profile => ({ id: profile.id, name: profile.name, description: profile.signature,
    model: '', avatar: profile.id as CompanionTemplateId, proactive: true, persona: builtinCompanionPersona(profile.id) })),
];
export const BUILTIN_WELCOMES: Record<string, string> = {
  ...Object.fromEntries(CATALOGUE_COMPANION_PROFILES.map(profile => [profile.id, profile.welcome])),
  'deepseek-sister': '你来啦。我是大肥鱼。慢慢说，今天想聊点什么？',
  'deepseek-flash': '小肥鱼报到！今天遇到什么有意思的事了吗？',
};
export function builtinCompanionId(templateId: CompanionTemplateId): string {
  return templateId === 'sister' ? 'deepseek-sister' : templateId === 'flash' ? 'deepseek-flash' : templateId;
}
