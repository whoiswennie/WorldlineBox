import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';

export async function realMemoryRuntime(root: string, generate?: (context: { system: string; user: string }, signal: AbortSignal) => Promise<string>) {
  const encoder = new GlobalEmbeddingService({ userDataPath: path.join(root, 'encoder'), bundleDirectory: path.resolve('resources/embedding-models'), koffiPath: createRequire(import.meta.url).resolve('koffi') });
  const profile = await encoder.resolveProfile(); const gateway = new VcpEmbeddingGateway(encoder);
  const configuration = await gateway.configuration(profile.selectionId, profile);
  const childLaunch = (file: string): VcpMemoryTransport => {
    const child = fork(file, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return { postMessage: message => child.send(message as object), on: child.on.bind(child), kill: () => { child.kill(); } };
  };
  const chat = generate ? new VcpChatGateway(generate) : undefined;
  const plugins = chat ? { chat: await chat.configuration() } : undefined;
  const client = new VcpMemoryClient({ dataRoot: path.join(root, 'vcp'), vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), embedding: configuration, plugins, launch: childLaunch, maxOpenScopes: 4, requestTimeoutMs: 120000 });
  const runtime = { get: async () => ({ client, profileKey: profile.profileKey }), close: () => client.close() };
  return { client, encoder, gateway, runtime, profile, close: async () => { await client.close(); await chat?.close(); await gateway.close(); await encoder.close(); } };
}
