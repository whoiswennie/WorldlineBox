/** Agent Vault URI and host-path validation. */

import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { AgentVaultError } from '@deepseek-ai/dsh-agent-vault'
import type { AgentVaultDomain, VaultUri } from '@deepseek-ai/dsh-agent-vault'

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/**
 * Normalize and validate a portable Agent identity.
 * @param value - Candidate identity.
 * @returns Validated identity.
 */
export function validateAgentId(value: string): string {
  const id = value.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  if (!/^[a-z\d][a-z\d-]{0,119}$/u.test(id)) {
    throw new AgentVaultError('Agent Vault id is invalid.', 'INVALID_AGENT_ID')
  }
  return id
}

/**
 * Convert a safe Vault URI to a relative path.
 * @param uri - Portable URI.
 * @returns Relative path.
 */
export function vaultRelative(uri: VaultUri): string {
  if (!uri.startsWith('vault://')) {
    throw new AgentVaultError('This operation requires a vault:// URI.', 'INVALID_URI')
  }
  const path = uri.slice('vault://'.length).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (path === '' || /^[a-z]:/iu.test(path) || isAbsolute(path)) {
    throw new AgentVaultError('Vault URI is empty or absolute.', 'INVALID_URI')
  }
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..'
    || WINDOWS_RESERVED.test(part) || /[\u0000-\u001f<>:"|?*]/u.test(part))) {
    throw new AgentVaultError('Vault URI contains an unsafe segment.', 'INVALID_URI')
  }
  return parts.join('/')
}

/**
 * Resolve the authorized domain for a relative path.
 * @param path - Vault-relative path.
 * @returns Semantic domain.
 */
export function domainFromRelative(path: string): AgentVaultDomain {
  const first = path.split('/', 1)[0]
  if (first === 'self' || first === 'memory' || first === 'procedures' || first === 'resources'
    || first === 'maps' || first === 'skills') {
    if (first === 'procedures' || first === 'skills') return 'procedure'
    if (first === 'maps') return 'memory'
    return first as AgentVaultDomain
  }
  throw new AgentVaultError('Vault URI does not belong to a semantic domain.', 'DOMAIN_VIOLATION')
}

/**
 * Resolve a URI without allowing root escape.
 * @param root - Absolute Vault root.
 * @param uri - Portable URI.
 * @returns Absolute Host path.
 */
export function resolveInside(root: string, uri: VaultUri): string {
  const target = resolve(root, ...vaultRelative(uri).split('/'))
  const delta = relative(resolve(root), target)
  if (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new AgentVaultError('Vault URI escapes its root.', 'INVALID_URI')
  }
  return target
}

/**
 * Reject symlink traversal beneath a Vault root.
 * @param root - Absolute Vault root.
 * @param target - Absolute target.
 * @returns Completion.
 */
export async function rejectSymlinkAncestors(root: string, target: string): Promise<void> {
  const delta = relative(resolve(root), resolve(target))
  let cursor = resolve(root)
  for (const part of delta.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new AgentVaultError('Symbolic links are not accepted inside a Vault.', 'INVALID_URI')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/**
 * Build a portable URI from a normalized relative path.
 * @param path - Relative path.
 * @returns Vault URI.
 */
export const asVaultUri = (path: string): VaultUri => `vault://${path.replaceAll('\\', '/')}`
