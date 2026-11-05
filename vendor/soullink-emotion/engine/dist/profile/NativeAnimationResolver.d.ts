import type { EmotionIntent } from "../reaction/EmotionIntent";
import type { ModelProfile, NativeAnimationDirective } from "./ModelProfile";
/**
 * Resolves the active NativeAnimationDirective for a given EmotionIntent
 * against the profile's expressionMap / motionMap.
 *
 * Returns null when:
 *   - The profile has neither an expressionMap nor a motionMap, OR
 *   - No entry in the maps matches the intent (including minIntensity gates).
 *
 * Lookup order for both maps:
 *   1. `<emotion>:<variant>` composite key (when intent.variant is present)
 *   2. `<emotion>` plain key fallback
 *
 * suppressParamIds is populated from the matching expression's catalog entry
 * (nativeAnimations.expressions[].params). It is empty when no expression is
 * active or the catalog entry has no params list.
 *
 * KEY COMPAT RULE: profiles without expressionMap/motionMap return null here,
 * so snapshot.nativeAnimation stays null and adapter.apply() produces IDENTICAL
 * live2dParams output — no change from pre-C5 behavior.
 */
export declare function resolveNativeAnimation(profile: ModelProfile, intent: EmotionIntent): NativeAnimationDirective | null;
