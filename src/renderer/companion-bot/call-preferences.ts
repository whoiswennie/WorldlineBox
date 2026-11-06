export interface BotCallPreferences { scene: string; gazeEnabled: boolean; idleEnabled: boolean; readAloud: boolean }
const key = (companionId: string) => `worldlinebox.companion-call.preferences.v1:${encodeURIComponent(companionId)}`;
const validScene = (value: unknown): value is string => typeof value === 'string' && (value === 'plain' || value === 'evening'
  || value.length < 4_000_000 && /^data:image\/(?:png|jpeg|webp|avif);base64,[A-Za-z0-9+/]+=*$/u.test(value));

/** Old application-wide choices remain the fallback until this companion has
 * its own preference. No persona or execution settings are stored here. */
export function readBotCallPreferences(companionId: string): BotCallPreferences {
  const defaults: BotCallPreferences = { scene: 'evening', gazeEnabled: true, idleEnabled: true, readAloud: true };
  try {
    const legacyScene = localStorage.getItem('worldlinebox.companion-call.scene.v1');
    if (validScene(legacyScene)) defaults.scene = legacyScene;
    defaults.readAloud = localStorage.getItem('worldlinebox.companion-call.speech.v1') !== 'off';
    const parsed: unknown = JSON.parse(localStorage.getItem(key(companionId)) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const saved = parsed as Record<string, unknown>;
    return { scene: validScene(saved.scene) ? saved.scene : defaults.scene,
      gazeEnabled: typeof saved.gazeEnabled === 'boolean' ? saved.gazeEnabled : defaults.gazeEnabled,
      idleEnabled: typeof saved.idleEnabled === 'boolean' ? saved.idleEnabled : defaults.idleEnabled,
      readAloud: typeof saved.readAloud === 'boolean' ? saved.readAloud : defaults.readAloud };
  } catch { return defaults; }
}

export function saveBotCallPreferences(companionId: string, update: Partial<BotCallPreferences>): boolean {
  try { localStorage.setItem(key(companionId), JSON.stringify({ ...readBotCallPreferences(companionId), ...update })); return true; }
  catch { return false; }
}
