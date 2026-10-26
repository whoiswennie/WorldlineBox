import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';

/** Explicit orchestration-only fixture protocol adapter. Its supplied client is
 * controlled by each test; this is not evidence of production owner routing. */
export function controlledMemoryRuntime(base: Pick<CompanionMemoryRuntime, 'get' | 'close'>): CompanionMemoryRuntime {
  let current: Awaited<ReturnType<CompanionMemoryRuntime['get']>> | undefined;
  const get = async (scope = { ownerId: 'controlled-fixture' }) => current = await base.get(scope);
  return { get, close: () => base.close(),
    describeEmbedding: async () => ({ profileKey: (await get()).profileKey }),
    describeGeneration: async ({ ownerId }) => ({ ownerId, profileKey: (await get()).profileKey }),
    acquireGeneration: async ({ ownerId, signal }) => {
      signal?.throwIfAborted();
      return { ...await get({ ownerId }), ownerId, connectionEpoch: 1, release: async () => undefined };
    },
    interruptOwner: async () => undefined,
    purgeOwner: async (_owner, scopes) => {
      for (const scopeId of new Set([...(scopes?.canonicalScopes ?? []), ...(scopes?.historicalViews?.map(view => view.scopeId) ?? [])])) {
        await current?.client.interruptScope({ scopeId }); await current?.client.purgeScope({ scopeId });
      }
    } };
}
