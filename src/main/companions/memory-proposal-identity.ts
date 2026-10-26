import { createHash } from 'node:crypto';
import type { CompanionModelConfig } from './model';
import { companionModelConnection } from './model-quota';

/** A host checkpoint identity, not a provider request. Canonical roles are
 * freshly resolved from their actual files. Time, energy and transient world
 * state cannot invalidate a paid proposal on the next budget window. */
export async function companionMemoryProposalIdentity(config: CompanionModelConfig, ownerId: string, purpose: string): Promise<string> {
  const probe = { system: '', user: JSON.stringify({ purpose, companion: { id: ownerId } }) };
  const resolved = config.resolveAssetContext ? await config.resolveAssetContext(probe, 'structured') : probe;
  return createHash('sha256').update(JSON.stringify(['companion-memory-proposal-identity-v1', ownerId, purpose,
    companionModelConnection(config), config.apiFormat, config.model, resolved.system, resolved.user])).digest('hex');
}
