/** Default conversation template; exact provider metadata or explicit limits
 * still take precedence, including models with smaller context windows. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 100_000;
/** Bounded text envelopes and response bodies; not attachment/file limits. */
export const DEFAULT_MODEL_CONTEXT_CHARS = 100_000;
