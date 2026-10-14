import type { Companion } from './companions';
export const COMPANION_PRESENCE_LABELS = { ready: '就绪', working: '工作中', waiting: '等待中', offline: '离线' } as const;
export function companionPresence(companion: Companion, globalConfigured: boolean): NonNullable<Companion['availability']> {
  if (!(companion.llm ? companion.llm.hasKey : globalConfigured)) return 'offline';
  return companion.availability ?? 'ready';
}
