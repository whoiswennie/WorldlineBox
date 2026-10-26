import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import { CompanionMemoryManagementSearch } from '../../src/main/companions/memory-management-search';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { VcpMemoryPluginConfiguration } from '../../src/main/vcp-memory/contracts';
import type { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';

export interface VcpManagementAudit { pid: number; recordReads: number; recordDirectoryScans: number }
/** Public synthetic corpus transport; the SQLite/Rust/River implementation is the actual vendored engine. */
export async function nativeManagementHarness(root: string, requestStorage: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, options?: {
  chatReply?: string; semanticVariants?: boolean; plugins?: VcpMemoryPluginConfiguration;
  workerPath?: string; vendorRoot?: string; processBroker?: VcpMemoryProcessBroker;
  /** Extra audit guard. A final soak requires zero guard rejections, proving
   * the production shared broker itself respected the configured capacity. */
  maxLiveProcesses?: number; beforeLaunch?(workerPath: string): void;
}) {
  const embeddingRequests: Array<{ path: string; input: string[] }> = [], audits = new Map<number, VcpManagementAudit>(), chatRequests: string[] = [];
  const processes = new Map<number, { pid: number; file: string; launchedAt: string; exitedAt?: string; exitCode?: number | null; exitSignal?: NodeJS.Signals | null }>();
  let live = 0, peak = 0, limitViolations = 0;
  const hook = path.join(root, 'audit-worker.cjs');
  await writeFile(hook, `const fs = require('node:fs/promises'), path = require('node:path');
const audit = { pid: process.pid, recordReads: 0, recordDirectoryScans: 0 };
const readFile = fs.readFile, readdir = fs.readdir;
fs.readFile = function(file, ...args) { if (typeof file === 'string' && path.basename(path.dirname(file)) === 'records') audit.recordReads++; return readFile.call(this, file, ...args); };
fs.readdir = function(file, ...args) { if (typeof file === 'string' && path.basename(file) === 'records') audit.recordDirectoryScans++; return readdir.call(this, file, ...args); };
const send = process.send?.bind(process);
if (send) process.send = function(message, ...args) { return send({ ...message, __vcpAudit: { ...audit } }, ...args); };
`, 'utf8');
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    if (options?.chatReply !== undefined && request.url === '/chat/v1/chat/completions') {
      chatRequests.push(text); response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: options.chatReply } }] })); return;
    }
    const body = JSON.parse(text) as { input: string[] };
    embeddingRequests.push({ path: request.url!, input: body.input });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: body.input.map((input, index) => { const group = Number(input.match(/group(\d+)/u)?.[1] ?? 0) % 16;
      // The three episodes have equal cosine relevance to the same query but
      // distinct directions, so upstream semantic dedup need not erase them.
      return { index, embedding: Array.from({ length: 16 }, (_, position) => position === group ? 1 : !options?.semanticVariants ? 0
        : position === 14 ? input.includes('EPISODE_OLD') ? .4 : input.includes('EPISODE_NEW') ? -.4 : 0
          : position === 15 && input.includes('IMPORTANT_OLD') ? .4 : 0) }; }) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint.');
  const auditHookHash = createHash('sha256').update(readFileSync(hook)).digest('hex');
  const launch = (file: string): VcpMemoryTransport => {
    options?.beforeLaunch?.(file);
    if (createHash('sha256').update(readFileSync(hook)).digest('hex') !== auditHookHash) throw new Error('Native audit hook changed after creation.');
    if (options?.maxLiveProcesses !== undefined && live >= options.maxLiveProcesses) {
      limitViolations++; throw new Error('Native fixture attempted to exceed its declared global process budget.');
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH;
    const child = fork(file, [], { execPath: process.execPath, execArgv: ['--require', hook], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    live++; peak = Math.max(peak, live);
    const observation = { pid: child.pid ?? -1, file, launchedAt: new Date().toISOString() } as (typeof processes extends Map<number, infer V> ? V : never);
    processes.set(observation.pid, observation);
    child.once('exit', (code, signal) => { live--; observation.exitedAt = new Date().toISOString(); observation.exitCode = code; observation.exitSignal = signal; });
    child.stderr?.resume();
    child.on('message', value => { if (value && typeof value === 'object' && '__vcpAudit' in value) { const audit = value.__vcpAudit as VcpManagementAudit; audits.set(audit.pid, audit); } });
    return { postMessage: message => { child.send(message as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
  };
  const embedding = { baseUrl: `http://127.0.0.1:${address.port}/document`, queryBaseUrl: `http://127.0.0.1:${address.port}/query`, model: 'synthetic-benchmark', dimension: 16, apiKey: 'synthetic-localhost-fixture' };
  const client = new VcpMemoryClient({ dataRoot: path.join(root, 'native'), vendorRoot: options?.vendorRoot ?? path.resolve('vendor/vcp-memory'), workerPath: options?.workerPath ?? path.resolve('src/main/vcp-memory/worker.cjs'), embedding,
    ...(options?.processBroker ? { processBroker: options.processBroker } : {}),
    ...(options?.plugins ? { plugins: options.plugins } : options?.chatReply !== undefined ? { plugins: { chat: { baseUrl: `http://127.0.0.1:${address.port}/chat`, model: 'synthetic-focusing', apiKey: 'synthetic-localhost-fixture' } } } : {}), launch, requestTimeoutMs: 120000, maxOpenScopes: 1 });
  const errors: unknown[] = [];
  const makeManager = () => new CompanionMemoryManagementSearch({ runtime: { get: async () => ({ client, profileKey: 'synthetic-native-benchmark' }), close: () => client.close() },
    requestStorage, cacheRoot: path.join(root, 'management'), batchSize: 64, report: error => errors.push(error) });
  const audit = () => ({ recordReads: [...audits.values()].reduce((sum, audit) => sum + audit.recordReads, 0), recordDirectoryScans: [...audits.values()].reduce((sum, audit) => sum + audit.recordDirectoryScans, 0) });
  const close = async () => {
    await client.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  };
  const processSnapshot = () => ({ live, peak, limitViolations, ...(options?.maxLiveProcesses !== undefined ? { configuredGlobalLimit: options.maxLiveProcesses } : {}),
    auditHookHash, helperServerChildProcesses: 0, processes: [...processes.values()].map(value => ({ ...value })) });
  return { client, makeManager, errors, embeddingRequests, chatRequests, audits, audit, close, embedding, launch, processSnapshot };
}
