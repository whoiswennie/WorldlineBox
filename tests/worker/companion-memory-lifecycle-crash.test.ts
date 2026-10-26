import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
interface Event { stage: string; error?: string; nativePids?: number[]; journals?: CompanionMemory[]; nativeIndexed?: Array<{ id: string }>;
  modelCalls?: number; errors?: string[]; sourceIds?: string[]; originals?: CompanionMessage[]; capture?: { pending: number; running: number; failed: number };
  queues?: Record<string, Record<string, number>>; filesChecked?: { current: number; history: number; sources: number };
  afterRevocation?: { historicalRejected: boolean; sourceRejected: boolean; queues: Record<string, Record<string, number>> } }
const phases = ['claim', 'model-return', 'commit', 'partial-native-index', 'before-publish'] as const;
const reports: unknown[] = [];
let buildRoot: string, hostFile: string;
const exit = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
beforeAll(async () => {
  buildRoot = await mkdtemp(path.join(tmpdir(), 'worldline-memory-kill-build-')); hostFile = path.join(buildRoot, 'host.cjs');
  await build({ configFile: false, logLevel: 'silent', resolve: { conditions: ['node'] }, build: { outDir: buildRoot, emptyOutDir: false,
    target: 'node24', minify: false, lib: { entry: path.resolve('tests/fixtures/memory-lifecycle-crash-host.ts'), formats: ['cjs'], fileName: () => 'host.cjs' },
    rollupOptions: { external: id => !id.startsWith('.') && !path.isAbsolute(id), output: { banner: `module.paths.unshift(${JSON.stringify(path.resolve('node_modules'))});` } } } });
});
afterAll(async () => {
  const destination = path.resolve(`artifacts/vcp-validation/memory-lifecycle-host-kill-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ actualHostSIGKILL: true, actualVendoredRustIndex: true, actualEncoder: false, actualPaidProvider: false,
    canonicalCurrentFiles: true, canonicalHistoricalAndSourceFiles: true, syntheticFixtureOnly: true, userDataModified: false,
    limitations: ['Electron Run-as-Node host and actual native subprocesses; no GUI crash, hardware power loss or real provider quality claim',
      'running lease deadlines are explicitly expired after SIGKILL; source/body versions and stored outputs are not changed',
      'a provider response killed before database commit is regenerated; this proves no duplicate journal outcomes, not exactly-once provider billing',
      'optional monthly-generation routing is not configured in this bounded capture/index host; resulting route errors remain in reports and are outside these crash assertions'], reports }, null, 2));
  if (buildRoot) await removeOwnedDirectory(buildRoot);
});

it.each(phases)('recovers real killed capture/index publication host at %s without duplicate journals or premature archives', async phase => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-memory-host-kill-')), started = performance.now();
  const provider: unknown[] = [], embeddings: unknown[] = [], children: ChildProcess[] = [], nativePids = new Set<number>();
  let passed = false, failure: string | undefined, gate: Event | undefined, resumed: Event | undefined;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes.toString();
    const body = JSON.parse(text); response.setHeader('content-type', 'application/json');
    if (Array.isArray(body.input)) {
      embeddings.push(body.input);
      response.end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: Array.from({ length: 16 }, (_, position) => position === 0 ? 1 : 0) })) }));
    } else {
      const data = JSON.parse(body.messages[1].content) as { purpose: string; messages: Array<{ id: string; content: string }> };
      provider.push(data);
      const groups = [data.messages.slice(0, 6), data.messages.slice(6)].filter(group => group.length);
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notes: groups.map(group => ({ content: group.map(source => source.content).join('\n'),
        tags: ['合成验收'], diaryName: '经历', sourceMessageIds: group.map(source => source.id), evidence: group.map(source => ({ sourceMessageId: source.id, quote: source.content })) })) }) } }] }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing synthetic local endpoint');
  const start = (mode: 'seed' | 'resume', expected: string) => {
    const child = fork(hostFile, [root, `http://127.0.0.1:${address.port}`, phase, mode], { execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
    let diagnostic = '';
    child.stderr?.on('data', bytes => { diagnostic += bytes.toString(); });
    const result = new Promise<Event>((resolve, reject) => {
      child.on('message', (event: Event) => {
        for (const pid of event.nativePids ?? []) nativePids.add(pid);
        if (event.stage === expected || event.stage === 'fatal') resolve(event);
      });
      child.once('exit', code => { if (code) reject(Error(`Synthetic host exited ${code}: ${diagnostic.slice(-3000)}`)); });
      child.once('error', reject);
    });
    return { child, result };
  };
  try {
    const first = start('seed', phase); gate = await first.result;
    expect(gate.stage, gate.error ?? gate.errors?.join(';')).toBe(phase);
    expect(gate.journals?.some(note => note.archivedAt)).toBe(false);
    if (phase === 'claim' || phase === 'model-return') expect(gate.journals).toHaveLength(0);
    else expect(gate.journals).toHaveLength(phase === 'before-publish' ? 3 : 2);
    if (phase === 'partial-native-index') expect(gate.nativeIndexed).toHaveLength(1);
    if (phase === 'before-publish') expect(gate.nativeIndexed).toHaveLength(3);
    expect(first.child.kill('SIGKILL')).toBe(true); await exit(first.child);
    await vi.waitFor(() => expect([...nativePids].some(alive)).toBe(false), { timeout: 10000 });
    const second = start('resume', 'complete'); resumed = await second.result;
    expect(resumed.stage, resumed.error ?? resumed.errors?.join(';')).toBe('complete');
    const active = resumed.journals!.filter(note => !note.archivedAt && note.status === 'indexed');
    expect(active).toHaveLength(phase === 'before-publish' ? 1 : 2);
    expect(resumed.journals).toHaveLength(phase === 'before-publish' ? 3 : 2);
    if (phase === 'before-publish') expect(resumed.journals!.filter(note => note.archivedAt)).toHaveLength(2);
    const counts = new Map<string, number>();
    for (const note of active) for (const source of note.sources) counts.set(source.messageId, (counts.get(source.messageId) ?? 0) + 1);
    expect([...counts.values()]).toEqual(Array(12).fill(1));
    expect(new Set(resumed.originals?.map(source => source.id)).size).toBe(12);
    expect(resumed.originals?.every(source => source.content.includes('下半部尚未开始') && source.content.includes('抽屉'))).toBe(true);
    expect(resumed.capture).toMatchObject({ pending: 0, running: 0, failed: 0 });
    expect(Object.keys(resumed.queues!)).toHaveLength(4);
    for (const states of Object.values(resumed.queues!)) for (const state of ['pending', 'running', 'failed']) expect(states[state] ?? 0).toBe(0);
    expect(resumed.filesChecked).toEqual({ current: active.length, history: resumed.journals!.length, sources: 12 });
    expect(resumed.afterRevocation).toMatchObject({ historicalRejected: true, sourceRejected: true });
    expect(resumed.nativeIndexed?.map(note => note.id).sort()).toEqual(active.map(note => note.id).sort());
    if (gate.journals?.length) expect(resumed.journals!.map(note => note.id).sort()).toEqual(gate.journals.map(note => note.id).sort());
    expect(provider).toHaveLength(phase === 'model-return' ? 2 : 1);
    await exit(second.child); passed = true;
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    reports.push({ phase, passed, failure, durationMs: performance.now() - started, actualHostPids: children.map(child => child.pid),
      actualNativePids: [...nativePids], providerRequests: provider, embeddingRequests: embeddings, gate, resumed });
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit(child); }
    for (const pid of nativePids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removeOwnedDirectory(root);
  }
}, 120000);
