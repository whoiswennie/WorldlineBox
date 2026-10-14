import type { CompanionMessage } from '../../shared/companions';

export const COMPANION_MESSAGE_WINDOW_LIMIT = 200;
const TEXT_BUDGET = 1_000_000;
/** Evict the opposite end rather than retaining every page ever visited. */
export function trimMessageWindow(messages: CompanionMessage[], keep: 'older' | 'newer'): CompanionMessage[] {
  const candidates = keep === 'older' ? messages : [...messages].reverse();
  const result: CompanionMessage[] = [];
  let size = 0;
  for (const message of candidates) {
    const weight = message.content.length + (message.segments ?? []).reduce((sum, part) => sum + part.text.length, 0);
    if (result.length && (result.length >= COMPANION_MESSAGE_WINDOW_LIMIT || size + weight > TEXT_BUDGET)) break;
    result.push(message); size += weight;
  }
  return keep === 'older' ? result : result.reverse();
}
