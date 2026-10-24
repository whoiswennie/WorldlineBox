import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import type { VcpMemoryPluginConfiguration } from '../../src/main/vcp-memory/contracts';
import { ColdKnowledgeService, type ColdKnowledgeServiceOptions } from '../../src/main/vcp-memory/cold-service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { generateCompanionText, COMPANION_TEXT_GENERATION_PROFILE } from '../../src/main/companions/model';

export interface RealColdWorkerObservation {
  direction: 'request' | 'response'; requestId: string; commandType: string; ok?: boolean;
  engine?: string; packageVersion?: string; generation?: string; queryChecksum?: string;
  documents?: Array<{ id: string; version: string; sourceId: string; sourceDigest: string }>;
  hits?: Array<{ id: string; version: string; sourceId: string; sourceDigest: string; textChecksum?: string }>;
}

export async function realMemoryRuntime(root: string, generate?: (context: { system: string; user: string }, signal: AbortSignal) => Promise<string>,
  options: { observeColdWorker?(event: RealColdWorkerObservation): void; modelFetch?: typeof fetch } = {}) {
  const encoder = new GlobalEmbeddingService({ userDataPath: path.join(root, 'encoder'), bundleDirectory: path.resolve('resources/embedding-models'), koffiPath: createRequire(import.meta.url).resolve('koffi') });
  const profile = await encoder.resolveProfile(); const gateway = new VcpEmbeddingGateway(encoder);
  const configuration = await gateway.configuration(profile.selectionId, profile);
  const childLaunch = (file: string): VcpMemoryTransport => {
    const child = fork(file, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const isObservedCold = !!options.observeColdWorker && path.basename(file) === 'cold-worker.cjs';
    const coldRequests = new Map<string, string>();
    if (isObservedCold) child.on('message', value => {
      const reply = value as { requestId?: unknown; ok?: unknown; value?: unknown };
      if (typeof reply.requestId !== 'string') return;
      const commandType = coldRequests.get(reply.requestId);
      if (!commandType) return;
      coldRequests.delete(reply.requestId);
      const result = reply.value as { engine?: unknown; packageVersion?: unknown; generation?: unknown } | undefined;
      const hits = Array.isArray(reply.value) ? reply.value as Array<{ id: string; version: string; sourceId: string; sourceDigest: string; text?: unknown }> : undefined;
      options.observeColdWorker!({ direction: 'response', requestId: reply.requestId, commandType, ok: reply.ok === true,
        ...(typeof result?.engine === 'string' ? { engine: result.engine } : {}),
        ...(typeof result?.packageVersion === 'string' ? { packageVersion: result.packageVersion } : {}),
        ...(typeof result?.generation === 'string' ? { generation: result.generation } : {}),
        ...(hits ? { hits: hits.map(({ id, version, sourceId, sourceDigest, text }) => ({ id, version, sourceId, sourceDigest,
          ...(typeof text === 'string' ? { textChecksum: createHash('sha256').update(text).digest('hex') } : {}) })) } : {}) });
    });
    return { postMessage: message => {
      if (isObservedCold) {
        const request = message as { requestId?: unknown; command?: { type?: unknown; generation?: unknown; text?: unknown;
          documents?: Array<{ id: string; version: string; sourceId: string; sourceDigest: string }> } };
        if (typeof request.requestId === 'string' && typeof request.command?.type === 'string') {
          coldRequests.set(request.requestId, request.command.type);
          // Whitelist only native identity/provenance. Initialize configuration,
          // authorization callbacks, endpoint headers and keys are never logged.
          options.observeColdWorker!({ direction: 'request', requestId: request.requestId, commandType: request.command.type,
            ...(typeof request.command.generation === 'string' ? { generation: request.command.generation } : {}),
            ...(typeof request.command.text === 'string' ? { queryChecksum: createHash('sha256').update(request.command.text).digest('hex') } : {}),
            ...(request.command.documents ? { documents: request.command.documents.map(({ id, version, sourceId, sourceDigest }) => ({ id, version, sourceId, sourceDigest })) } : {}) });
        }
      }
      return child.send(message as object);
    }, on: child.on.bind(child), kill: () => { child.kill(); } };
  };
  const chat = generate ? new VcpChatGateway(generate) : undefined;
  const plugins = chat ? { chat: await chat.configuration() } : undefined;
  const client = new VcpMemoryClient({ dataRoot: path.join(root, 'vcp'), vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), embedding: configuration, plugins, launch: childLaunch, maxOpenScopes: 4, requestTimeoutMs: 120000 });
  const extraClients: VcpMemoryClient[] = [];
  const coldServices: ColdKnowledgeService[] = [];
  const cold = (authorize: ColdKnowledgeServiceOptions['authorize']) => {
    const service = new ColdKnowledgeService({ dataRoot: path.join(root, 'real-cold'), vendorRoot: path.resolve('vendor/vcp-memory'),
      workerPath: path.resolve('src/main/vcp-memory/cold-worker.cjs'), embedding: configuration, authorize, launch: childLaunch });
    coldServices.push(service); return service;
  };
  const profileClient = (behaviorProfile: NonNullable<VcpMemoryPluginConfiguration['behaviorProfile']>) => {
    const instance = new VcpMemoryClient({ dataRoot: path.join(root, 'vcp-' + behaviorProfile), vendorRoot: path.resolve('vendor/vcp-memory'),
      workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), embedding: configuration, plugins: { ...plugins, behaviorProfile },
      launch: childLaunch, maxOpenScopes: 2, requestTimeoutMs: 120000 });
    extraClients.push(instance); return instance;
  };
  // Direct parity clients above retain their explicit test callback. Main's
  // generation path uses the production runtime and the actual owner snapshot.
  const ownerChat = new VcpChatGateway();
  const runtime = new CompanionVcpRuntime({ dataRoot: path.join(root, 'owner-runtime'), vendorRoot: path.resolve('vendor/vcp-memory'),
    workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), resolveEmbedding: async () => configuration, launch: childLaunch,
    generationProfile: COMPANION_TEXT_GENERATION_PROFILE, resolveGenerationPlugins: async input => {
      const snapshot = Object.freeze({ ...input.config });
      const route = await ownerChat.registerOwnerRoute({ ownerId: input.ownerId, credential: snapshot.apiKey,
        semanticProfile: { ownerId: input.ownerId, profileKey: input.profileKey, generation: COMPANION_TEXT_GENERATION_PROFILE },
        generate: (context, signal) => generateCompanionText(context, snapshot, signal, { fetchFn: options.modelFetch, timeoutMs: 120000 }) });
      return { plugins: { chat: route.chat }, dispose: route.dispose };
    } });
  return { client, encoder, gateway, runtime, profile, profileClient, cold, close: async () => { await runtime.close(); await ownerChat.close(); await Promise.all(coldServices.map(service => service.close())); await Promise.all(extraClients.map(client => client.close())); await client.close(); await chat?.close(); await gateway.close(); await encoder.close(); } };
}
