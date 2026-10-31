import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CompanionsStore } from '../../src/companions/store';
import type { Companion, CompanionMemory } from '../../src/shared/companions';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import type { CompanionArtifactReference } from '../../src/shared/companion-artifact';
import { canonicalMemoryFiles } from './canonical-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { CompanionContextSnapshots } from '../../src/main/companions/context-snapshots';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { validateCompanionPersonaPublication } from '../../src/main/companions/growth-service';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';

/** Actual Main context/transport methods and production file actors. It does
 * not emulate renderer IPC, foreground scheduling or physical-world time. */
export async function canonicalInferenceHost(root: string, store: CompanionsStore, config: CompanionModelConfig) {
  const files = await canonicalMemoryFiles(root, store, config), assetIo = new CompanionAssetIo(); let closed = false;
  const vendor = path.resolve('vendor/vcp-memory');
  const profiles: CompanionAssetProfileStore = new CompanionAssetProfileStore(path.join(root, 'owner-assets'), {
    registryStorage: { request: async command => files.request(command) },
    validatePersonaPublication: proposal => validateCompanionPersonaPublication(proposal, { profiles, requestStorage: files.request, isStopped: () => closed }),
    loadInitialFocusPrompt: () => readFile(path.join(vendor, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8'),
    loadInitialTagPrompt: () => readFile(path.join(vendor, 'Plugin/DailyNote/TagMaster.txt'), 'utf8'), loadInitialTimelinePrompts: () => loadInitialTimelinePrompts(vendor),
  });
  const snapshots = new CompanionContextSnapshots({ artifacts: owner => profiles.artifacts(owner),
    currentRevocationEpoch: async owner => (await files.request({ type: 'memory.lifecycle.state', companionId: owner })).memoryLifecycleState!.revocationEpoch,
    validateRead: async snapshot => { if (!store.state().companions.some(owner => owner.id === snapshot.companionId)) throw new Error('QA owner unavailable.'); },
    references: async input => {
      const registry = await profiles.artifacts(input.frame.companionId), identity = await registry.read({ artifactId: 'persona:current', consumer: 'identity' });
      if (identity.artifact.contentHash !== input.frame.profileRevision) throw new Error('QA persona changed before actual provider dispatch.');
      const page = await registry.page({ kind: 'source_evidence', consumer: 'source_verification', limit: 256 });
      if (page.hasMore) throw new Error('Small QA corpus exceeded its explicit source closure bound.');
      const sourceRefs: CompanionArtifactReference[] = [];
      for (const metadata of page.items) {
        const actual = await registry.read({ artifactId: metadata.artifactId, consumer: 'source_verification' });
        sourceRefs.push({ artifactId: actual.artifact.artifactId, contentRevision: actual.artifact.contentRevision, contentHash: actual.artifact.contentHash });
      }
      return { sourceRefs, dependencyRefs: [{ artifactId: identity.artifact.artifactId, contentRevision: identity.artifact.contentRevision, contentHash: identity.artifact.contentHash }] };
    } });
  const main = Object.assign(Object.create(CompanionService.prototype), { assetProfiles: profiles, assetIo, contextSnapshots: snapshots,
    storage: { request: files.request }, closed: false, modelOperations: new Map<string, Set<Promise<unknown>>>(), storageEventJobs: new Map<string, Set<Promise<unknown>>>(),
    resettingCompanions: new Set<string>(), dormantCompanions: new Set<string>(), options: { getConfig: () => config } });
  const prepare: CompanionService['prepareModelAssetContext'] = (...args) => Reflect.apply(CompanionService.prototype.prepareModelAssetContext, main, args);
  const configFor = async (owner: Pick<Companion, 'id'>): Promise<CompanionModelConfig> => {
    await files.publish(owner.id);
    const current = { ...config, resolveAssetContext: (context: { system: string; user: string }, kind: 'reply' | 'structured' | 'text') => prepare(owner.id, context, kind) };
    return Reflect.apply(CompanionService.prototype.bindModelTransport, main, [owner.id, current]);
  };
  const materialize = async (owner: string, notes: readonly CompanionMemory[]) => {
    await files.publish(owner); return (await files.live.materialize(owner, notes)).notes;
  };
  return { files, profiles, snapshots, configFor, prepare, request: files.request, materialize,
    resolveOwnerStorage: (owner: string) => Reflect.apply(CompanionService.prototype.resolveOwnerStorage, main, [owner]) as ReturnType<CompanionService['resolveOwnerStorage']>,
    resolveOwnerCleanupStorage: (owner: string) => Reflect.apply(CompanionService.prototype.resolveOwnerCleanupStorage, main, [owner]) as ReturnType<CompanionService['resolveOwnerCleanupStorage']>,
    close: async () => { closed = true; main.closed = true; await Reflect.apply(Reflect.get(CompanionService.prototype, 'drainModelOperations'), main, []);
      await Reflect.apply(Reflect.get(CompanionService.prototype, 'drainStorageEvents'), main, []); await assetIo.close(); await files.close(); } };
}
