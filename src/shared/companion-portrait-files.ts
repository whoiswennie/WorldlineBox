import type { Companion } from './companions';

/** One source of truth for built-in public portraits in Main and the renderer. */
export const COMPANION_PORTRAIT_FILES: Record<Exclude<Companion['avatar'], 'custom'>, string> = {
  sister: 'assets/companions/portraits/deepseek-sister.png',
  flash: 'assets/companions/portraits/deepseek-flash.png',
  'huan-white': 'assets/companions/portraits/huan-white-v1.png',
  'huan-black': 'assets/companions/portraits/huan-black-v1.png',
  gemini: 'assets/companions/portraits/gemini-v2.png',
  gpt: 'assets/companions/portraits/gpt-v2.png',
  grok: 'assets/companions/portraits/grok-v1.png',
  kimi: 'assets/companions/portraits/kimi-v1.png',
  minimax: 'assets/companions/portraits/minimax-v2.png',
  qwen: 'assets/companions/portraits/qwen-v2.png',
  gugugaga: 'assets/companions/portraits/gugugaga-v1.png',
  guga: 'assets/companions/portraits/guga-v1.png',
  doro: 'assets/companions/portraits/doro-v1.png',
  phoebe: 'assets/companions/portraits/phoebe-v1.png',
  phrolova: 'assets/companions/portraits/phrolova-v1.png',
};

/** Public reference boards are defaults; an imported attachment always takes priority. */
export const COMPANION_APPEARANCE_FILES: Readonly<Record<string, string>> = {
  'deepseek-sister': 'assets/companions/appearance/deepseek-sister-orthographic.png',
  'deepseek-flash': 'assets/companions/appearance/deepseek-flash-orthographic.png',
};
