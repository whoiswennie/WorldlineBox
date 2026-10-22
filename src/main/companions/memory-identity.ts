import { createHash } from 'node:crypto';
import type { Companion } from '../../shared/companions';
import type { VcpMemoryOwnerIdentity } from '../vcp-memory/contracts';

/** A host identity belongs to one stable resident, never the application brand. */
export function companionMemoryIdentity(owner: Pick<Companion, 'id' | 'name'>): VcpMemoryOwnerIdentity {
  const name = Array.from(owner.name, character => character.charCodeAt(0) < 32 ? ' ' : character).join('').trim() || owner.id;
  const safe = name.replace(/[<>:"/\\|?*[\]{}《》]/gu, '_').replace(/[. ]+$/u, '').trim();
  const agentName = safe && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(safe) ? safe : `伙伴-${owner.id}`;
  return { version: 2, companionId: owner.id, name, agentName };
}

export function companionMemoryIdentitySignature(identity: VcpMemoryOwnerIdentity): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function sameCompanionMemoryIdentity(value: VcpMemoryOwnerIdentity | undefined, expected: VcpMemoryOwnerIdentity): boolean {
  return !!value && value.version === expected.version && value.companionId === expected.companionId
    && value.name === expected.name && value.agentName === expected.agentName;
}
