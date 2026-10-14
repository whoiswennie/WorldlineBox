/** Stable authoring IDs. These describe characters, never model providers. */
export const COMPANION_TEMPLATE_IDS = ['sister', 'flash', 'huan-white', 'huan-black', 'gemini', 'gpt', 'grok', 'kimi', 'minimax', 'qwen', 'gugugaga', 'guga', 'doro', 'phoebe', 'phrolova'] as const;
export type CompanionTemplateId = typeof COMPANION_TEMPLATE_IDS[number];
export const COMPANION_AVATAR_IDS = [...COMPANION_TEMPLATE_IDS, 'custom'] as const;
