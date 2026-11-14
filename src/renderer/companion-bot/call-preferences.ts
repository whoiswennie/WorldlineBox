export interface BotCallPreferences { scene: string; gazeEnabled: boolean; idleEnabled: boolean }
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
