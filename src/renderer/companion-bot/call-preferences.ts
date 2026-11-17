import type { BotCallModel } from '../../shared/companion-call';
import { BOT_CALL_PORTRAIT_SCALE } from './call-presentation';

export interface BotCallPreferences { scene: string; gazeEnabled: boolean; idleEnabled: boolean }
export interface BotCallFraming { fullBody: boolean; scale: number; x: number; y: number }
export const BOT_CALL_ZOOM = { min: .4, max: 3 };
export const BOT_CALL_PAN_LIMIT = .4;
const key = (companionId: string, version = 2) => `worldlinebox.companion-call.preferences.v${version}:${encodeURIComponent(companionId)}`;
const validScene = (value: unknown): value is string => typeof value === 'string' && (value === 'plain' || value === 'evening'
  || value.length < 4_000_000 && /^data:image\/(?:png|jpeg|webp|avif);base64,[A-Za-z0-9+/]+=*$/u.test(value));

/** Old application-wide choices remain the fallback until this companion has
 * its own preference. No persona or execution settings are stored here. */
export function readBotCallPreferences(companionId: string): BotCallPreferences {
  const defaults: BotCallPreferences = { scene: 'evening', gazeEnabled: false, idleEnabled: true };
  try {
    const legacyScene = localStorage.getItem('worldlinebox.companion-call.scene.v1');
    if (validScene(legacyScene)) defaults.scene = legacyScene;
    const current = localStorage.getItem(key(companionId));
    const parsed: unknown = JSON.parse(current ?? localStorage.getItem(key(companionId, 1)) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const saved = parsed as Record<string, unknown>;
    return { scene: validScene(saved.scene) ? saved.scene : defaults.scene,
      // V1 wrote the old default alongside unrelated preferences.
      gazeEnabled: current !== null && saved.gazeEnabled === true,
      idleEnabled: typeof saved.idleEnabled === 'boolean' ? saved.idleEnabled : defaults.idleEnabled };
  } catch { return defaults; }
}

export function saveBotCallPreferences(companionId: string, update: Partial<BotCallPreferences>): boolean {
  try { localStorage.setItem(key(companionId), JSON.stringify({ ...readBotCallPreferences(companionId), ...update })); return true; }
  catch { return false; }
}

export function usesAutomaticBotCallFraming(model?: BotCallModel): boolean {
  return !!(model?.localImport || model?.modelUrl);
}

export function defaultBotCallFraming(model?: BotCallModel, fullBody = false): BotCallFraming {
  return { fullBody, scale: fullBody || usesAutomaticBotCallFraming(model) ? 1 : BOT_CALL_PORTRAIT_SCALE, x: 0, y: 0 };
}

const framingKey = (companionId: string, model: BotCallModel) =>
  `worldlinebox.companion-call.framing.v1:${encodeURIComponent(companionId)}:${encodeURIComponent(model.modelUrl ?? model.model)}`;

function framingValue(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function readBotCallFraming(companionId: string, model?: BotCallModel): BotCallFraming {
  if (model) try {
    const stored = JSON.parse(localStorage.getItem(framingKey(companionId, model)) ?? 'null') as Partial<BotCallFraming> | null;
    if (stored) {
      const defaults = defaultBotCallFraming(model, stored.fullBody === true);
      return {
        fullBody: defaults.fullBody,
        scale: framingValue(stored.scale, BOT_CALL_ZOOM.min, BOT_CALL_ZOOM.max, defaults.scale),
        x: framingValue(stored.x, -BOT_CALL_PAN_LIMIT, BOT_CALL_PAN_LIMIT, 0),
        y: framingValue(stored.y, -BOT_CALL_PAN_LIMIT, BOT_CALL_PAN_LIMIT, 0),
      };
    }
  } catch { /* Start from automatic framing if the preference is unreadable. */ }
  return defaultBotCallFraming(model);
}

export function saveBotCallFraming(companionId: string, model: BotCallModel, framing: BotCallFraming): boolean {
  try { localStorage.setItem(framingKey(companionId, model), JSON.stringify(framing)); return true; }
  catch { return false; }
}
