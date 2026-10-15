import { z } from 'zod';

export const WORLD_OBSERVER_PREFERENCES_KEY = 'companion-world-observer';
const coordinate = z.number().finite().min(-10_000).max(10_000);
const point = z.object({ x: coordinate, y: coordinate, z: coordinate }).strict();
export const worldCameraViewSchema = z.object({ position: point, target: point, zoom: z.number().finite().min(.1).max(4) }).strict().refine(view => {
  const distance = Math.hypot(view.position.x - view.target.x, view.position.y - view.target.y, view.position.z - view.target.z);
  return distance >= .1 && distance <= 2_000 && view.position.y > view.target.y;
});
export type WorldCameraView = z.infer<typeof worldCameraViewSchema>;
const identifier = z.string().min(1).max(200);
const preferencesSchema = z.object({ sceneId: identifier.optional(), followId: identifier.optional(), views: z.record(identifier, worldCameraViewSchema).refine(views => Object.keys(views).length <= 256) }).strict();
export type WorldObserverPreferences = z.infer<typeof preferencesSchema>;
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Camera preferences are local presentation only; no actor or simulation state is stored here. */
export function readWorldObserverPreferences(storage?: PreferenceStorage, key = WORLD_OBSERVER_PREFERENCES_KEY): WorldObserverPreferences {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(key);
    if (!raw || raw.length > 200_000) return { views: {} };
    const parsed = preferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { views: {} };
  } catch { return { views: {} }; }
}
export function saveWorldObserverPreferences(preferences: WorldObserverPreferences, storage?: PreferenceStorage, key = WORLD_OBSERVER_PREFERENCES_KEY): void {
  try {
    const parsed = preferencesSchema.safeParse(preferences);
    if (parsed.success) {
      const target = storage ?? globalThis.localStorage, serialized = JSON.stringify(parsed.data);
      if (target?.getItem(key) !== serialized) target?.setItem(key, serialized);
    }
  } catch { /* Observation still works when local storage is unavailable or full. */ }
}
