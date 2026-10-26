import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { generateCompanionText, COMPANION_TEXT_GENERATION_PROFILE } from '../../src/main/companions/model';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import type { VcpMemoryEmbeddingConfig } from '../../src/main/vcp-memory/contracts';
import type { VcpMemoryClientOptions } from '../../src/main/vcp-memory/client';
import path from 'node:path';
import { fixtureOwnerRuntimeStorage, fixtureOwnerRuntimePaths } from './owner-runtime-storage';
import { renderCompanionNativeMemoryPrompt, validateCompanionNativeMemoryPrompt } from '../../src/shared/companion-native-memory-prompt';

/** Real production owner routing over a fixture's existing encoder transport. */
export function ownerGenerationRuntime(dataRoot: string, embedding: VcpMemoryEmbeddingConfig,
  launch: VcpMemoryClientOptions['launch'], fetchFn?: typeof fetch) {
  const gateway = new VcpChatGateway();
  const resolveOwnerStorage = fixtureOwnerRuntimeStorage(path.join(dataRoot, '伙伴记忆'));
  const runtime = new CompanionVcpRuntime({ resolveOwnerStorage,
    resolveOwnerCleanupStorage: fixtureOwnerRuntimePaths(path.join(dataRoot, '伙伴记忆')),
    vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
    resolveEmbedding: async () => embedding, launch, generationProfile: COMPANION_TEXT_GENERATION_PROFILE,
    resolveGenerationPlugins: async input => {
      const config = Object.freeze({ ...input.config });
      const route = await gateway.registerOwnerRoute({ ownerId: input.ownerId, credential: config.apiKey,
        semanticProfile: { ownerId: input.ownerId, profileKey: input.profileKey, generation: COMPANION_TEXT_GENERATION_PROFILE },
        generate: (context, signal, work) => generateCompanionText(context, { ...config, ownerId: input.ownerId, workPriority: work?.priority ?? 'foreground',
          resolveAssetContext: async context => {
            if (!work?.nativePrompt) return context;
            const native = validateCompanionNativeMemoryPrompt(work.nativePrompt, input.ownerId, context.system);
            const storage = await resolveOwnerStorage(input.ownerId);
            return { ...context, system: renderCompanionNativeMemoryPrompt(native.kind === 'timeline'
              ? storage.ownerPrompts.timelineTemplate : storage.ownerPrompts.summaryTemplate, native) };
          } }, signal, { fetchFn, timeoutMs: 120000 }) });
      return { plugins: { chat: route.chat }, dispose: route.dispose };
    } });
  return { runtime, close: async () => { await runtime.close(); await gateway.close(); } };
}
