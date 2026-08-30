/** DeepSeek Files API identifiers. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Provider-returned identifier for an uploaded DeepSeek file. */
export type DeepSeekFileId = Branded<'DeepSeekFileId'>
/**
 * Brand a provider-returned file identifier after wire validation.
 * @param id - id value.
 * @returns The resulting value.
 */
export function DeepSeekFileId(id: string): DeepSeekFileId {
  return id as DeepSeekFileId
}

/** Non-secret digest identifying one endpoint and API-key file namespace. */
export type DeepSeekFileScope = Branded<'DeepSeekFileScope'>
/**
* Brand a locally derived namespace digest.
* @param scope - SHA-256 digest of endpoint and API key.
* @returns the same string with namespace identity attached at type level.
*/
export function DeepSeekFileScope(scope: string): DeepSeekFileScope {
  return scope as DeepSeekFileScope
}
