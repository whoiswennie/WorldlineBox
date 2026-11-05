import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';
import type { BotMemoryRecallReport } from '../../src/shared/companion-bot-memory';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
interface Session {
  pid: number; closed: Promise<void>; close(): Promise<void>;
  request(operation: string, payload?: object, options?: { signal?: AbortSignal; timeoutMs?: number; withTelemetry?: boolean }): Promise<unknown>;
}
interface Call { pid: number; operation: string; payload: object; telemetry: boolean; output?: unknown }
async function sourceFiles(home: string) {
  const files: Array<{ file: string; sha256: string }> = [];
  const walk = async (directory: string, kind: 'diary' | 'history') => {
    if (!existsSync(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, kind);
      else if (entry.isFile() && (kind === 'diary' ? /\.(txt|md)$/iu.test(entry.name) : entry.name === 'history.json')) {
        files.push({ file: path.relative(home, file), sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
      }
    }
  };
  await walk(path.join(home, 'dailynote'), 'diary'); await walk(path.join(home, 'sessions'), 'history');
  return files.sort((left, right) => left.file.localeCompare(right.file));
}
function oneRingRows(home: string) {
  const query = spawnSync(nodePath, ['-e', `
    const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
    const directory=path.join(process.argv[1],'runtime','Plugin','OneRing','data');
    const result=fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>name.endsWith('.db')).sort().map(name=>{
      const db=new Database(path.join(directory,name),{readonly:true,fileMustExist:true});
      try{return {name,messages:db.prepare('SELECT * FROM messages ORDER BY id').all(),postTurns:db.prepare('SELECT * FROM postTurns ORDER BY turnId').all()};}
      finally{db.close();}
    }):[];
    console.log(JSON.stringify(result));
  `, home], { cwd: packageRoot, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(query.status, query.stderr).toBe(0);
  return JSON.parse(query.stdout) as Array<{ name: string; messages: unknown[]; postTurns: unknown[] }>;
}
function originalStages(call: Call): Row[] {
  const telemetry = row(row(call.output).telemetry);
  return [...(Array.isArray(row(telemetry.vcp).spans) ? row(telemetry.vcp).spans as unknown[] : []),
    ...(Array.isArray(row(telemetry.chat).spans) ? row(telemetry.chat).spans as unknown[] : [])].map(row);
}
function assertOriginalRanking(report: BotMemoryRecallReport, candidates: Row[]) {
  expect(candidates.length).toBeGreaterThan(0); expect(report.hits).toHaveLength(candidates.length);
  for (const [index, candidate] of candidates.entries()) {
    const hit = report.hits[index]!;
    expect(hit.rank).toBe(index + 1); expect(hit.text).toBe(Array.from(String(candidate.text)).slice(0, 4000).join(''));
    if (typeof candidate.score === 'number' && Number.isFinite(candidate.score)) expect(hit.score).toBe(candidate.score);
    else expect(hit.score).toBeUndefined();
    for (const [key, score] of Object.entries(hit.scores ?? {})) {
      const original = key.startsWith('riverMemo.') ? row(candidate.riverMemo)[key.slice(10)] : candidate[key];
      expect(typeof original).toBe('number'); expect(score).toBe(original);
    }
  }
  expect(row(report.coverage).scoring).toBe('original fields and original order; missing fields are not provided');
}

// Only the vector HTTP protocol is a fixture. The staged worker, original
// plugins, DailyNote/indexing, SQLite, retrieval and diagnostic hooks are real.
it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'node_modules/better-sqlite3')))(
  'inspects real passive, semantic and history recall on one resident VCP without recording the inspection or calling chat/DSH', async () => {
    const version = spawnSync(nodePath, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(version.status, version.stderr).toBe(0); expect(Number(version.stdout.trim().split('.')[0])).toBe(24);
    const root = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-inspection-native-'));
    const cleanupRoot = path.resolve(root);
    if (!cleanupRoot.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(cleanupRoot).startsWith('bot-memory-inspection-native-')) throw new Error('Unexpected inspection fixture root');
    const logs: string[] = [], calls: Call[] = [], sessions: Session[] = [], unexpected: string[] = [];
    let embeddingRequests = 0;
    const server = createServer((request, response) => {
      void (async () => {
        let body = ''; for await (const chunk of request) body += chunk;
        if (request.method !== 'POST' || !request.url?.endsWith('/v1/embeddings')) {
          unexpected.push(`${request.method} ${request.url}`); response.writeHead(503).end('No chat provider is available'); return;
        }
        embeddingRequests++; const payload = JSON.parse(body) as { input: string | string[] };
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: 'inspection-fixture64',
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 64 }, (_, axis) => axis === 0 ? 1 : 0.01) })),
          usage: { prompt_tokens: 8, total_tokens: 8 } }));
      })().catch(error => { unexpected.push(String(error)); response.writeHead(500).end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local embedding fixture did not bind');
    const base = `http://127.0.0.1:${address.port}`, secret = 'native-inspection-secret-not-for-report';
    const client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs') as {
      createSession(options: Parameters<NonNullable<BotMemoryOptions['createSession']>>[0]): Session;
    };
    const service = new BotMemoryService({ root, runtime: async () => ({ nodePath, packageRoot }), requestTimeoutMs: 60000,
      embedding: async () => ({ baseUrl: base + '/document', queryBaseUrl: base + '/query', apiKey: secret, model: 'inspection-fixture64', dimension: 64, modelSignature: 'inspection-native-64-v1' }),
      chat: async () => ({ baseUrl: base, apiKey: secret, model: 'chat-must-not-be-called' }), onLog: message => logs.push(message),
      createSession: options => {
        const actual = client.createSession(options); sessions.push(actual);
        return { closed: actual.closed, close: () => actual.close(), request: async (operation, payload = {}, options) => {
          const call: Call = { pid: actual.pid, operation, payload, telemetry: options?.withTelemetry === true }; calls.push(call);
          call.output = await actual.request(operation, payload, options); return call.output;
        } };
      } });
    const scope = { companionId: 'inspection-native-owner', conversationId: 'inspection-direct', securityDomainId: 'inspection-direct' };
    try {
      expect(await service.remember(scope, { sourceEventId: 'inspection-diary-source', content: 'INSPECTDAILY2026：项目决定用 SQLite 保存消息，晚间只喝麦茶。', tags: 'SQLite,决策,麦茶', waitForIndex: true })).toMatchObject({ indexed: 1, pending: 0 });
      await service.appendHistory(scope, [{ id: 'native-original-user', role: 'user', content: 'INSPECTHISTORY2026 原始聊天：今晚只有20分钟，先整理桌角。', timestamp: 1793614000000 },
        { id: 'native-original-answer', role: 'assistant', content: '原始回应：只整理一个小角落，不代替你动手。', timestamp: 1793614001000 }]);
      const prepared = await service.prepareTurn({ scope, requestId: 'ordinary-before-inspection', messages: [{ id: 'ordinary-message', role: 'user', content: 'SQLite 普通对话准备。', timestamp: 1793614002000 }] });
      await service.finishTurn(prepared, '普通回应，未执行任何任务。', true);
      const statusBefore = row(await service.status(scope)); expect(statusBefore.historyMessages).toBe(2); expect(statusBefore.indexed).toBe(1);
      const [domain] = await readdir(root); expect(domain).toBeTruthy(); const home = path.join(root, domain!);
      const filesBefore = await sourceFiles(home), ringBefore = oneRingRows(home);
      expect(filesBefore.some(file => file.file.includes('dailynote'))).toBe(true); expect(filesBefore.some(file => file.file.endsWith('history.json'))).toBe(true);
      expect(ringBefore.reduce((sum, db) => sum + db.messages.length, 0)).toBeGreaterThan(0);
      const ordinaryBefore = [...calls]; expect(ordinaryBefore.every(call => !call.telemetry)).toBe(true);
      expect(ordinaryBefore.every(call => !Object.hasOwn(row(call.output), 'telemetry'))).toBe(true);
      const passive = await service.recall(scope, { query: 'INSPECTDAILY2026 SQLite', mode: 'passive' });
      const semantic = await service.recall(scope, { query: 'INSPECTDAILY2026 SQLite', mode: 'semantic' });
      const history = await service.recall(scope, { query: 'INSPECTHISTORY2026', mode: 'history' });
      const observed = calls.filter(call => call.telemetry);
      expect(observed.map(call => call.operation)).toEqual(['preprocess', 'search', 'tool']);
      const rag = row(row(observed[0]!.output).result), events = Array.isArray(rag.events) ? rag.events.map(row) : [];
      const candidates = events.filter(event => event.type === 'RAG_RETRIEVAL_DETAILS').flatMap(event => (Array.isArray(event.results) ? event.results : []).map(row));
      assertOriginalRanking(passive, candidates); expect(passive.hits.some(hit => hit.text.includes('INSPECTDAILY2026'))).toBe(true);
      const final = originalStages(observed[1]!).findLast(span => span.stage === 'lightmemo.final-candidates'); expect(final).toBeDefined();
      const finalCandidates = row(final!.input).candidates; expect(Array.isArray(finalCandidates)).toBe(true);
      assertOriginalRanking(semantic, (finalCandidates as unknown[]).map(row)); expect(semantic.hits.some(hit => hit.text.includes('SQLite'))).toBe(true);
      expect(history.evidence).toContain('INSPECTHISTORY2026'); expect(history.hits).toEqual([]); expect(row(history.coverage).finalRankingAvailable).toBe(false);
      expect(passive.stages.some(stage => stage.name === 'plugin.RAGDiaryPlugin.processMessages')).toBe(true);
      expect(history.stages.some(stage => stage.name === 'chat.DeepMemo.processToolCall')).toBe(true);
      for (const [index, report] of [passive, semantic, history].entries()) {
        const spans = originalStages(observed[index]!); expect(spans.length).toBeGreaterThan(0);
        const actual = report.stages.filter(stage => stage.name !== 'host.context.prepare');
        expect(actual.map(stage => stage.name)).toEqual(spans.slice(0, 120).map(span => span.stage));
        expect(row(report.coverage).internalStageCount).toBe(spans.length);
        for (const [index, stage] of actual.entries()) {
          const raw = spans[index]!, duration = row(raw.hostTiming).durationMs;
          expect(stage.status).toBe(raw.status); expect(stage.source).toBe(raw.source);
          if (typeof duration === 'number' && Number.isFinite(duration)) expect(stage.durationMs).toBe(duration); else expect(stage.durationMs).toBeUndefined();
        }
        expect(row(report.coverage).stageTiming).toBe('nested inclusive boundaries; do not add durations');
        expect(JSON.stringify(report.raw)).not.toContain(secret);
      }
      const afterManual = calls.length; await service.tool(scope, 'LightMemo', { query: 'SQLite' });
      expect(calls.slice(afterManual).every(call => !call.telemetry && !Object.hasOwn(row(call.output), 'telemetry'))).toBe(true);
      const statusAfter = row(await service.status(scope)); expect(statusAfter.historyMessages).toBe(statusBefore.historyMessages);
      expect(await sourceFiles(home)).toEqual(filesBefore); expect(oneRingRows(home)).toEqual(ringBefore);
      expect(sessions).toHaveLength(1); expect(calls.every(call => call.pid === sessions[0]!.pid)).toBe(true);
      expect(embeddingRequests).toBeGreaterThan(0); expect(unexpected).toEqual([]);
    } catch (error) { throw new Error(String(error) + '\n' + logs.join('').slice(-10000), { cause: error }); }
    finally {
      await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(cleanupRoot, { recursive: true, force: true });
    }
  }, 90000);
