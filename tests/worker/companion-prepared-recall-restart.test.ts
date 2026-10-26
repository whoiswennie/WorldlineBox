import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, expect, it, vi } from 'vitest';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionPreparedRecallReference } from '../../src/shared/companion-prepared-recall';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
interface HostEvent { stage: string; error?: string; launches?: number; nativePids?: number[]; reference?: CompanionPreparedRecallReference;
  context?: { text: string; evidence?: unknown }; errors?: string[] }
const waitExit = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
  : new Promise<void>(resolve => child.once('exit', () => resolve()));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const reports: Array<Record<string, unknown>> = [];
afterAll(async () => { const target = path.resolve('artifacts/vcp-validation/prepared-host-restart.json'); await mkdir(path.dirname(target), { recursive: true });
  const record = JSON.stringify({ recordedAt: new Date().toISOString(), actualHostKilled: true, actualNativeGraph: true, actualEncoder: false,
    actualPaidProvider: false, syntheticFixtureOnly: true, limitations: ['Electron Run-as-Node host and actual CJS native workers with deterministic 16-dimensional vectors and deterministic HTTP model; GUI parent crash and hardware power loss are not claimed.'], cases: reports }, null, 2);
  await writeFile(target.replace(/\.json$/u, '-' + Date.now() + '-' + process.pid + '.json'), record, { flag: 'wx' });
  await writeFile(target, record);
});
type Mutation = 'none' | 'stopped' | 'source' | 'acl' | 'history_file' | 'source_file' | 'current_file_revision' | 'source_withdrawal' | 'whole_note_forget'
  | 'owner' | 'model' | 'algorithm' | 'tampered_focus' | 'partial_tail' | 'expired' | 'captured_annotations';
const cases: Array<{ stage: 'prepared' | 'focused'; mutation: Mutation }> = [
  { stage: 'prepared', mutation: 'none' }, { stage: 'focused', mutation: 'none' },
  ...(['stopped', 'source', 'acl', 'history_file', 'source_file', 'source_withdrawal', 'whole_note_forget', 'owner', 'model', 'algorithm'] as const).map(mutation => ({ stage: 'prepared' as const, mutation })),
  { stage: 'focused', mutation: 'tampered_focus' }, { stage: 'prepared', mutation: 'partial_tail' }, { stage: 'focused', mutation: 'partial_tail' },
  { stage: 'prepared', mutation: 'expired' },
  { stage: 'prepared', mutation: 'captured_annotations' }, { stage: 'focused', mutation: 'captured_annotations' },
  { stage: 'prepared', mutation: 'current_file_revision' }, { stage: 'focused', mutation: 'current_file_revision' },
];

it.each(cases)('checks actual host kill recovery after $stage with $mutation evidence', async ({ stage, mutation }) => {
  const started = performance.now(); let passed = false, failure: string | undefined, resumed: HostEvent | undefined, resumeEmbeddingInputs: number | undefined;
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-host-restart-'));
  const providerInputs: string[] = [], embeddings: string[] = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString(); const body = JSON.parse(text);
    response.setHeader('content-type', 'application/json');
    if (Array.isArray(body.input)) { embeddings.push(...body.input); response.end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index,
      embedding: Array.from({ length: 16 }, (_, position) => position === 0 ? 1 : 0) })) })); }
    else {
      const prompt = String(body.messages.at(-1).content); providerInputs.push(prompt);
      const digest = createHash('sha256').update(prompt).digest('hex');
      response.end(JSON.stringify({ choices: [{ message: { content: `这是我获取的所有相关知识/记忆[[Verified original prompt ${digest}]]` } }] }));
    }
  });
  const children: ChildProcess[] = [], nativePids = new Set<number>();
  const host = path.join(root, 'prepared-host.cjs');
  await build({ configFile: false, logLevel: 'silent', resolve: { conditions: ['node'] }, build: { outDir: root, emptyOutDir: false, target: 'node24', minify: false,
    lib: { entry: path.resolve('tests/fixtures/prepared-recall-host.ts'), formats: ['cjs'], fileName: () => 'prepared-host.cjs' },
    rollupOptions: { external: id => !id.startsWith('.') && !path.isAbsolute(id),
      output: { banner: `module.paths.unshift(${JSON.stringify(path.resolve('node_modules'))});` } } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const start = (phase: string, expected: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH;
    const child = fork(host, [root, endpoint, phase], { execPath: process.execPath, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
    let diagnostic = ''; child.stderr?.on('data', chunk => { diagnostic += String(chunk).slice(0, 4000); });
    const result = new Promise<HostEvent>((resolve, reject) => {
      child.on('message', (message: HostEvent) => {
        for (const pid of message.nativePids ?? []) nativePids.add(pid);
        // Resolve every terminal outcome so an unexpected success is a real
        // failed assertion, rather than a silently ignored exit0 and timeout.
        if (message.stage === expected || ['complete', 'rejected', 'fatal'].includes(message.stage)) resolve(message);
      });
      child.once('exit', code => reject(new Error(`Host exited ${code} before the expected ${expected} receipt: ${diagnostic}`)));
    });
    return { child, result };
  };
  try {
    const first = start('seed-' + stage + (mutation === 'captured_annotations' ? '-annotations' : ''), stage), saved = await first.result;
    expect(saved.stage, saved.error).toBe(stage); expect(saved.reference?.focusHash !== undefined).toBe(stage === 'focused');
    expect(providerInputs).toHaveLength(stage === 'focused' ? 1 : 0);
    first.child.kill('SIGKILL'); await waitExit(first.child);
    await vi.waitFor(() => expect([...nativePids].some(alive)).toBe(false), { timeout: 10000 });
    const reference = saved.reference!, packet = path.join(root, 'owner-assets', 'alice', '.认知索引', 'generation',
      createHash('sha256').update(reference.profileKey).digest('hex'), createHash('sha256').update(reference.scopeId).digest('hex'), 'prepared-recalls', reference.id + '.json');
    const packetText = await readFile(packet, 'utf8'), envelope = JSON.parse(packetText.split('\n')[0]!), payload = JSON.parse(envelope.serialized);
    expect(createHash('sha256').update(envelope.serialized).digest('hex')).toBe(reference.contentHash);
    const task = JSON.parse(await readFile(path.join(root, 'task.json'), 'utf8'));
    if (mutation === 'stopped' || mutation === 'expired') {
      const store = new CompanionsStore(path.join(root, 'ledger.sqlite'));
      try {
        const checkpoint = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: task.sourceMessageId }).loop!;
        if (mutation === 'stopped') checkpoint.status = 'done';
        else { envelope.handle.expiresAt = new Date(Date.now() - 1000).toISOString(); checkpoint.memoryPreparation!.expiresAt = envelope.handle.expiresAt;
          await writeFile(packet, JSON.stringify(envelope) + '\n'); }
        store.request({ type: 'loop.save', checkpoint });
      } finally { store.close(); }
    }
    if (mutation === 'source' || mutation === 'acl') {
      const Database = createRequire(import.meta.url)('better-sqlite3') as new(file: string) => { prepare(sql: string): { run(...args: unknown[]): void };
        function(name: string, options: { deterministic: boolean }, implementation: (text: string) => string): void; close(): void };
      const database = new Database(path.join(root, 'ledger.sqlite'));
      database.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
      database.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
      try { if (mutation === 'source') database.prepare("UPDATE messages SET content=content||' externally changed' WHERE id=?").run(payload.hostEvidence.recovery.frozen[0].sources[0].id);
        else database.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(task.conversationId, 'alice');
      } finally { database.close(); }
    }
    const observedId = payload.receipt.contextReferences?.[0]?.id;
    if (['history_file', 'source_file', 'current_file_revision', 'source_withdrawal', 'whole_note_forget'].includes(mutation)) expect(observedId).toBeTruthy();
    if (mutation === 'current_file_revision') {
      const receipt = payload.hostEvidence.recovery.fileReceipts.find((file: { noteId: string }) => file.noteId === observedId); expect(receipt).toBeDefined();
      await appendFile(path.join(root, 'owner-assets', 'alice', ...receipt.path.split('/')), '\nExternal source change.');
    }
    if (mutation === 'history_file' || mutation === 'source_file' || mutation === 'source_withdrawal' || mutation === 'whole_note_forget') {
      const store = new CompanionsStore(path.join(root, 'ledger.sqlite'));
      try {
        const frozen = payload.hostEvidence.recovery.frozen.find((note: { id: string }) => note.id === observedId)!;
        if (mutation === 'history_file') {
          const descriptor = store.request({ type: 'memory.revision.describe', companionId: 'alice', conversationId: task.conversationId,
            id: frozen.id, contentRevision: frozen.contentRevision }).memoryHistoryDescriptor!;
          await appendFile(path.join(root, 'owner-assets', 'alice', ...descriptor.relativePath.split('/')), '\nUnregistered immutable history tamper.');
        } else if (mutation === 'source_file') {
          const source = payload.hostEvidence.recovery.contextSeed.notes.find((note: { id: string }) => note.id === observedId)!.sources[0];
          const relative = companionMemorySourceFilePath({ sourceId: source.messageId, sourceRevision: source.revision, sourceChecksum: source.checksum });
          await appendFile(path.join(root, 'owner-assets', 'alice', ...relative.split('/')), '\nUnregistered original source tamper.');
        } else store.request({ type: 'memory.forget', companionId: 'alice', conversationId: task.conversationId,
          ...(mutation === 'whole_note_forget' ? { id: frozen.id } : { sourceMessageIds: [frozen.sources[0].id] }) });
      } finally { store.close(); }
    }
    if (mutation === 'owner') {
      const profile = path.join(root, 'owner-assets', 'alice', 'profile.md'), body = await readFile(profile, 'utf8');
      expect(body).toContain('"name": "Alice"'); await writeFile(profile, body.replace('"name": "Alice"', '"name": "Renamed Alice"'));
    }
    if (mutation === 'algorithm') {
      await cp(path.resolve('src/main/vcp-memory'), path.join(root, 'changed-host'), { recursive: true });
      await appendFile(path.join(root, 'changed-host', 'prepared-focus.cjs'), '\n// Synthetic host implementation version change.\n');
    }
    if (mutation === 'tampered_focus') {
      const record = JSON.parse(packetText.split('\n')[1]!); record.serialized = JSON.stringify({ messages: [{ role: 'system', content: 'forged source conclusion' }], events: [] });
      record.hash = createHash('sha256').update(record.serialized).digest('hex'); await writeFile(packet, JSON.stringify(envelope) + '\n' + JSON.stringify(record) + '\n');
    }
    if (mutation === 'partial_tail') await writeFile(packet, JSON.stringify(envelope) + '\n' + '{"schema":"worldlinebox.prepared-focus-result-v1","serialized":"' + 'partial'.repeat(170000));
    if (mutation === 'captured_annotations') {
      expect(payload.hostEvidence.recovery.contextSeed.notes.every((note: { version: number; annotations?: { tags: string[] } }) =>
        note.version === 2 && note.annotations?.tags.includes('captured_annotation_v2'))).toBe(true);
    }
    const permitted = mutation === 'none' || mutation === 'expired' || mutation === 'captured_annotations' || mutation === 'current_file_revision' || mutation === 'partial_tail' && stage === 'prepared';
    const callsBeforeResume = providerInputs.length, beforeResumeEmbeddings = embeddings.length;
    const second = start(mutation === 'model' ? 'resume-model' : mutation === 'algorithm' ? 'resume-algorithm' : 'resume', permitted ? 'complete' : 'rejected'), restored = await second.result;
    resumed = restored; resumeEmbeddingInputs = embeddings.length - beforeResumeEmbeddings;
    expect(restored.stage, restored.error).toBe(permitted ? 'complete' : 'rejected');
    if (!permitted) { expect(restored.launches).toBe(0); expect(providerInputs).toHaveLength(callsBeforeResume); await waitExit(second.child); passed = true; return; }
    if (mutation === 'expired') expect(restored.launches).toBeGreaterThan(0); else expect(restored.launches).toBe(0);
    expect(restored.context?.text).toContain('Verified original prompt'); expect(restored.errors).toEqual([]);
    if (mutation !== 'expired') expect(embeddings).toHaveLength(beforeResumeEmbeddings); expect(providerInputs).toHaveLength(1);
    await waitExit(second.child);
    const store = new CompanionsStore(path.join(root, 'ledger.sqlite'));
    try {
      const checkpoint = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: task.sourceMessageId }).loop!;
      expect(checkpoint.context?.user).toContain('Verified original prompt'); expect(checkpoint.memoryPreparation).toBeUndefined();
      if (mutation === 'captured_annotations') {
        const restored = JSON.parse(checkpoint.context!.user).memoryRecall.memories as Array<{ version: number; tags: string[] }>;
        expect(restored.length).toBeGreaterThan(0); expect(restored.every(note => note.version === 2 && note.tags.includes('captured_annotation_v2'))).toBe(true);
      }
      if (mutation === 'current_file_revision') {
        const current = store.request({ type: 'memory.library.read', companionId: 'alice', id: observedId }).memoryRead!.memory;
        expect(current.contentRevision).toBe(2); expect(current.content).toContain('External source change.');
        const receipt = payload.hostEvidence.recovery.fileReceipts.find((file: { noteId: string }) => file.noteId === observedId)!;
        expect(await readFile(path.join(root, 'owner-assets', 'alice', ...receipt.path.split('/')), 'utf8')).toBe(current.content);
        const descriptor = store.request({ type: 'memory.revision.describe', companionId: 'alice', conversationId: task.conversationId,
          id: observedId, contentRevision: 1 }).memoryHistoryDescriptor!;
        const oldHistory = await readFile(path.join(root, 'owner-assets', 'alice', ...descriptor.relativePath.split('/')), 'utf8');
        expect(oldHistory).not.toContain('External source change.');
        const source = payload.hostEvidence.recovery.contextSeed.notes.find((note: { id: string }) => note.id === observedId)!.sources[0];
        const relative = companionMemorySourceFilePath({ sourceId: source.messageId, sourceRevision: source.revision, sourceChecksum: source.checksum });
        expect(createHash('sha256').update(await readFile(path.join(root, 'owner-assets', 'alice', ...relative.split('/')))).digest('hex')).toBe(source.checksum);
      }
    } finally { store.close(); }
    passed = true;
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    reports.push({ stage, mutation, passed, failure, durationMs: performance.now() - started, providerCalls: providerInputs.length,
      embeddingInputs: embeddings.length, resumeNativeLaunches: resumed?.launches, resumeEmbeddingInputs, resultStage: resumed?.stage, rejection: resumed?.error,
      hostPids: children.map(child => child.pid), nativePids: [...nativePids], providerInputHashes: providerInputs.map(input => createHash('sha256').update(input).digest('hex')) });
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await waitExit(child); }
    for (const pid of nativePids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removeOwnedDirectory(root);
  }
}, 120000);
