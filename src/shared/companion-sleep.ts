/**
 * Admission follows upstream AgentDream's 0.6 probability and eight-hour
 * cooldown (Plugin/AgentDream/AgentDream.js). The world owns actual sleep and
 * persists one draw per sleep episode; missed draws are never rerolled by ticks.
 * Reflection is independent: a quiet, dreamless sleep may still consolidate.
 */
export const COMPANION_SLEEP_DREAM_PROBABILITY = 0.6;
export const COMPANION_SLEEP_DREAM_COOLDOWN_MS = 8 * 60 * 60 * 1000;
export const COMPANION_SLEEP_MINIMUM_REAL_MS = 5000;
export const COMPANION_SLEEP_DREAM_CONCURRENCY = 2;
export const COMPANION_SLEEP_MAX_ATTEMPTS = 3;
export const COMPANION_SLEEP_SEED_LIMIT = 12;
export const COMPANION_SLEEP_RECALL_LIMIT = 20;
