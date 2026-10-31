import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const revision = '918baf448ac12853c44d5a314542ac96e97affe7';
type Build = { CompanionsStore: typeof CompanionsStore; CompanionMemoryService: typeof CompanionMemoryService };
type Input = { purpose: string; memoryStage?: unknown; messages: Array<{ id: string; content: string }> };

it('compares actual checkpointed and current capture admission on the same timed source trace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-memory-capture-paired-'));
  const reports: Array<Record<string, unknown>> = [], requests: Input[] = [];
  const server = createServer(async (request, response) => {
    try {
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    const data = JSON.parse(JSON.parse(raw).messages[1].content) as Input; requests.push(data);
    if (!Array.isArray(data.messages)) throw new Error('The deterministic journal fixture received an unexpected purpose: ' + data.purpose);
    const notes = data.messages.length ? [{ ...(data.memoryStage ? { artifactKind: 'episode_memory' } : {}), content: data.messages.map(message => message.content).join('\n'), tags: ['合成修伞资料'],
      sourceMessageIds: data.messages.map(message => message.id), evidence: data.messages.map(message => ({ sourceMessageId: message.id, quote: message.content })) }] : [];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notes }) } }] }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  let passed = false, failure: string | undefined;
  try {
    const baseline = path.join(root, 'checkpoint'), archive = path.join(root, 'checkpoint.tar'); await mkdir(baseline);
    execFileSync('git', ['archive', '--format=tar', '--output', archive, revision, 'src'], { cwd: process.cwd(), windowsHide: true });
    execFileSync('tar', ['-xf', archive, '-C', baseline], { windowsHide: true });
    const entry = path.join(baseline, 'entry.ts');
    await writeFile(entry, "export { CompanionsStore } from './src/companions/store';\nexport { CompanionMemoryService } from './src/main/companions/memory-service';\n");
    await build({ configFile: false, logLevel: 'silent', resolve: { conditions: ['node'] }, build: { outDir: baseline, emptyOutDir: false, target: 'node24', minify: false,
      lib: { entry, formats: ['cjs'], fileName: () => 'checkpoint.cjs' }, rollupOptions: { external: id => !id.startsWith('.') && !path.isAbsolute(id),
        output: { banner: `module.paths.unshift(${JSON.stringify(path.resolve('node_modules'))});` } } } });
    const old = createRequire(import.meta.url)(path.join(baseline, 'checkpoint.cjs')) as Build;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const scenarios = ['burst', 'important'] as const;
    for (const scenario of scenarios) for (const [name, code] of [['checkpoint', old], ['current', { CompanionsStore, CompanionMemoryService }]] as const) {
      vi.useFakeTimers({ toFake: ['Date'] }); let now = Date.parse('2026-10-26T08:00:00Z'); vi.setSystemTime(now);
      const directory = path.join(root, name + '-' + scenario); await mkdir(directory);
      const store = new code.CompanionsStore(path.join(directory, 'ledger.sqlite'), [{ id: 'alice', name: 'Alice', description: 'Synthetic probe owner',
        persona: '只按实际原始资料记录。', model: '', avatar: 'sister', active: true, proactive: false }]);
      const room = store.openPrivate('alice'), errors: string[] = [], start = requests.length;
      const memory = new code.CompanionMemoryService({ request: async command => store.request(command),
        configFor: async () => ({ apiFormat: 'openai_chat', model: 'paired-fixture', baseUrl: endpoint, apiKey: 'synthetic-local-only' }),
        fetchFn: fetch, changed: () => undefined, busy: () => false, report: error => errors.push(String(error)) });
      memory.schedule = () => undefined;
      const processCapture = async () => {
        // Advance the actual world's existing clock before both implementations,
        // so old backlog gating is not mistaken for successful batching.
        for (let attempt = 0; attempt < 1000; attempt++) { if (!store.request({ type: 'world.clock' }).worldClock?.backlog) break;
          if (attempt === 999) throw Error('Synthetic world backlog did not settle.'); }
        await (Reflect.get(memory, 'process') as () => Promise<void>).call(memory);
      };
      const contents = scenario === 'burst' ? Array.from({ length: 24 }, (_, index) => `合成修伞资料${index + 1}：第${index + 1}盒棉线放在第${index + 1}层抽屉，修理下半部仍未完成。`)
        : ['我叫林澈，请把这个名字和我本人对应，修伞这件事尚未完成。', '更正一下，之前说错了，取棉线应去第二层抽屉，不能拿第一层。', '请记住这项约定：下周三归还蓝色雨伞，具体几点还没有确定。'];
      try {
        for (const content of contents) { store.appendMessage({ conversationId: room.id, authorId: 'user', content, replyDirective: 'none' }); await processCapture();
          now += 2000; vi.setSystemTime(now); }
        now += 60001; vi.setSystemTime(now); await processCapture();
        const afterCapture = requests.length, notes = store.listMemory('alice');
        // Poll unchanged input repeatedly through the actual coordinator. A
        // separate week-long maintenance simulation lives in its own suite.
        for (let poll = 0; poll < 10; poll++) { now += 5000; vi.setSystemTime(now); await processCapture(); }
        const calls = requests.slice(start), covered = new Set(notes.flatMap(note => note.sources.map(source => source.messageId)));
        const duplicateGroups = new Map<string, number>();
        for (const note of notes) { const key = createHash('sha256').update(JSON.stringify([note.content, note.sources.map(source => source.messageId).sort()])).digest('hex');
          duplicateGroups.set(key, (duplicateGroups.get(key) ?? 0) + 1); }
        reports.push({ implementation: name, scenario, sourceCount: contents.length, journalModelRequests: calls.length,
          sourcesPerRequest: calls.map(call => call.messages.length), journalEntries: notes.length, coveredSourceCount: covered.size,
          exactDuplicateNotes: [...duplicateGroups.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0), unchangedPollAdditionalRequests: requests.length - afterCapture,
          sourceTextCoverage: contents.every(content => notes.some(note => note.content.includes(content))), errors });
        expect(calls.every(call => call.purpose === 'vcp_experience_journal')).toBe(true); expect(errors).toEqual([]);
        expect(covered.size).toBe(contents.length); expect(contents.every(content => notes.some(note => note.content.includes(content)))).toBe(true);
        expect(requests.length - afterCapture).toBe(0);
      } finally { await memory.close(); store.close(); vi.useRealTimers(); }
    }
    const count = (implementation: string, scenario: string) => Number(reports.find(row => row.implementation === implementation && row.scenario === scenario)!.journalModelRequests);
    expect(count('checkpoint', 'burst')).toBe(24); expect(count('current', 'burst')).toBe(2);
    expect(count('checkpoint', 'important')).toBe(3); expect(count('current', 'important')).toBe(3); passed = true;
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    vi.useRealTimers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const directory = path.resolve('artifacts/vcp-validation'); await mkdir(directory, { recursive: true });
    const receipt = JSON.stringify({ passed, failure, recordedAt: new Date().toISOString(), baselineRevision: revision,
      currentSourceHashes: await Promise.all(['src/companions/memory-store.ts', 'src/main/companions/memory-service.ts', 'src/main/companions/memory-model.ts'].map(async file => ({ file,
        sha256: createHash('sha256').update(await readFile(file)).digest('hex') }))),
      loadedClassFingerprints: { store: createHash('sha256').update(CompanionsStore.toString()).digest('hex'), coordinator: createHash('sha256').update(CompanionMemoryService.toString()).digest('hex') },
      actualSQLite: true, actualProductionCaptureCoordinators: true, actualHTTP: true, actualPaidModel: false, actualNativeRetrieval: false, actualCanonicalAssetFiles: false,
      simulatedClock: true, syntheticOnly: true, limitations: ['Identical deterministic local HTTP journal writer; not a semantic quality evaluation or provider cost invoice.',
        'Current source is an in-flight implementation; saved source hashes and loaded class fingerprints are recorded separately, not represented as a clean frozen HEAD.',
        'Both capture coordinators run with native retrieval unavailable in isolated temporary databases; this measures admission and literal source preservation, not full production file/RAG latency.',
        'Exact byte-and-source duplicates are counted; semantic duplicate quality and a week of maintenance are separate evaluations.'], reports }, null, 2);
    await writeFile(path.join(directory, 'memory-capture-paired-' + Date.now() + '.json'), receipt); await writeFile(path.join(directory, 'memory-capture-paired.json'), receipt);
    await removeOwnedDirectory(root);
  }
}, 180000);
