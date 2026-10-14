import profiles from './companion-catalogue-data.json';
import type { CompanionTemplateId } from './companion-template-ids';

export interface BuiltinCompanionProfile {
  id: string;
  templateId: CompanionTemplateId;
  name: string;
  category: string;
  introduction: string;
  appearance: string;
  sourceSummary: string;
}

export const CATALOGUE_COMPANION_PROFILES = profiles;
export const BUILTIN_COMPANION_PROFILES: readonly BuiltinCompanionProfile[] = [
  { id: 'deepseek-sister', templateId: 'sister', name: '大肥鱼', category: 'AI 拟人', introduction: '温柔沉稳的鲸鱼姐姐，喜欢安静听歌、看海和热腾腾的白米饭。关心有一点小傲娇，答应你的事情，会认真放在心上。', appearance: '蓝色渐变长发、蓝瞳、鲸鳍耳与鲸尾，蓝白女仆装与蝴蝶结。', sourceSummary: '大肥鱼姐姐 · Pro' },
  { id: 'deepseek-flash', templateId: 'flash', name: '小肥鱼', category: 'AI 拟人', introduction: '活泼好奇的鲸鱼妹妹，喜欢音乐、探索新鲜事物和分享小发现。她更轻快爱玩，有一点可爱的小傲娇，也会认真完成自己的事情。', appearance: '蓝色渐变长发、蓝瞳、鲸鳍耳与鲸尾，蓝白女仆装与蝴蝶结。', sourceSummary: '小肥鱼妹妹 · Flash' },
  ...profiles.map(profile => ({ ...profile, templateId: profile.id as CompanionTemplateId })),
];

export function builtinCompanionProfile(id: string): BuiltinCompanionProfile | undefined {
  return BUILTIN_COMPANION_PROFILES.find(profile => profile.id === id);
}
