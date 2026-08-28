/** Host loader entry for the browser implementation exported from `./client`. */

/**
 * Keep the dual-face package loadable without registering product onboarding
 * state on the Host. The browser half owns the settings shell.
 */
export function apply(): void {}
