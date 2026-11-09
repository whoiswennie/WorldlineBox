import type { BotDshModel } from './dsh-brain';
import { resolveBotModelLimits } from './model-limits';
/** Conservative envelope admission only; generation is performed by native DSH. */
export function fitsNativeModelEnvelope(model: BotDshModel, system: string, prompt: string): boolean {
  const limits = resolveBotModelLimits(model);
  return Buffer.byteLength(JSON.stringify({ system, prompt }), 'utf8') + limits.maxTokens + 512 <= limits.window;
}
