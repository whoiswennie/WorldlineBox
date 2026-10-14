/** Each action owns one independently authored, three-frame image. */
export const COMPANION_WORLD_ART_ACTIONS = ['idle', 'walk', 'run', 'turn', 'read', 'standingRead', 'sitDown', 'sit', 'standUp', 'lieDown', 'sleep', 'wake', 'rest', 'communicate', 'follow', 'work', 'eat', 'think', 'tired', 'pleased', 'troubled', 'handle', 'phoneTypingStanding', 'phoneTypingSeated', 'phoneCallingStanding', 'phoneCallingSeated', 'surprised', 'sad', 'angry', 'exercise', 'cook'] as const;
export type CompanionWorldArtAction = typeof COMPANION_WORLD_ART_ACTIONS[number];
