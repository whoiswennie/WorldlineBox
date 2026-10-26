/**
 * Necessary cognitive maintenance has its own durable owner session. Physical
 * sleep is an opportunity, never the only entrance. Fiction has one persisted
 * draw per session; only a successful narrative starts the eight-hour cooldown.
 */
export const COMPANION_SLEEP_DREAM_PROBABILITY = 0.6;
export const COMPANION_SLEEP_DREAM_COOLDOWN_MS = 8 * 60 * 60 * 1000;
export const COMPANION_SLEEP_MINIMUM_REAL_MS = 5000;
export const COMPANION_SLEEP_DREAM_CONCURRENCY = 2;
export const COMPANION_SLEEP_MAX_ATTEMPTS = 3;
export const COMPANION_SLEEP_SEED_LIMIT = 12;
export const COMPANION_SLEEP_RECALL_LIMIT = 20;
export const COMPANION_MEMORY_DEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const COMPANION_MEMORY_DEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const COMPANION_MEMORY_DEEP_MIN_EPISODES = 3;
export const COMPANION_MEMORY_MAINTENANCE_CHECK_MS = 5000;
