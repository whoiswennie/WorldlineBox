import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotMemoryService, type BotMemoryScope } from '../../src/main/companion-bot/memory-service';
import type { BotMemoryCitationPage } from '../../src/main/companion-bot/memory-evidence';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(run => run())); });
const scope: BotMemoryScope = { companionId: 'c1', conversationId: 'dm1', securityDomainId: 'dm1' };
type Session = { home: string; env: Record<string, string>; request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
async function fixture(limit = 3, configure?: (session: Session, generation: number) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-test-'));
  const sessions: Session[] = [], preparedByHome = new Map<string, Map<string, object>>();
  const service = new BotMemoryService({ root, maxActiveDomains: limit,
    runtime: async () => ({ nodePath: process.execPath, packageRoot: '/unused-fixture' }),
    embedding: async () => ({ baseUrl: 'http://127.0.0.1/document', queryBaseUrl: 'http://127.0.0.1/query', model: 'builtin', dimension: 8, modelSignature: 'profile-1', apiKey: 'secret-key' }),
    createSession: options => {
      const prepared = preparedByHome.get(options.home) ?? new Map<string, object>(); preparedByHome.set(options.home, prepared);
      const session = { ...options, close: vi.fn(async () => undefined), request: vi.fn(async (operation: string, payload: Record<string, unknown>) => {
        if (operation === 'bot.prepared.get') return prepared.get(String(payload.id)) || null;
        if (operation === 'bot.prepared.put') { const row = { prepared: JSON.stringify(payload.prepared) }; prepared.set(String(payload.id), row); return row; }
        if (operation === 'bot.prepared.complete') { const row = { completion: JSON.stringify(payload.completion) }; prepared.set(String(payload.id), row); return payload.completion; }
        if (operation === 'context.prepare') return { messages: [{ role: 'system', content: 'placeholder' }, ...(payload.history as object[])], vcpchatExtensions: { requestContext: { requestId: 'req1' } } };
        if (operation === 'preprocess') return { messages: [{ role: 'system', content: '实际RAG证据' }, { role: 'user', content: 'query' }], metadata: { oneRing: { requestId: 'req1' } }, events: [], memoryPending: false };
        if (operation === 'bot.remember') return { id: 'receipt', state: 'pending' };
        if (operation === 'response') return { recorded: true };
        return { status: 'success', pending: 0, indexed: 0, uncertain: 0 };
      }) }; sessions.push(session); configure?.(session, sessions.length); return session;
    },
  });
  cleanup.push(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, sessions };
}
function replaceResponse(session: Session, operation: string, reply: (payload: Record<string, unknown>) => unknown) {
  const original = session.request.getMockImplementation() as (op: string, payload: Record<string, unknown>) => Promise<unknown>;
  session.request.mockImplementation(async (op, payload) => op === operation ? reply(payload) : original(op, payload));
}

describe('standalone VCP bot memory adapter', () => {
  it('uses the generated thinking tray as passive evidence and propagates failures in that tray', async () => {
    const { service, sessions } = await fixture();
    await service.warm(scope); const session = sessions[0]!;
    const query = '[系统提示:]\n[RAG处理失败] 这是用户引用的原话。';
    let tray = '[系统提示:]\n本轮真实托盘';
    replaceResponse(session, 'preprocess', () => ({ messages: [{ role: 'user', content: tray }, { role: 'user', content: query }] }));
    const report = await service.recall(scope, { query, mode: 'passive' });
    expect(report.evidence).toBe(tray);
    tray = '[系统提示:]\n[RAG处理失败]';
    await expect(service.recall(scope, { query, mode: 'passive' })).rejects.toMatchObject({ code: 'MEMORY_RECALL_FAILED' });
  });
  it('rejects a stored preparation without native context on both normal admission and recovery', async () => {
    const { service, sessions } = await fixture(), input = { scope, requestId: 'retired-preparation', messages: [] };
    const prepared = await service.prepareTurn(input);
    replaceResponse(sessions[0]!, 'bot.prepared.get', () => ({ prepared: JSON.stringify({ ...prepared, nativeContext: undefined, evidence: 'old diary body' }) }));
    await expect(service.prepareTurn(input)).rejects.toMatchObject({ code: 'MEMORY_PREPARED_INCOMPATIBLE' });
    await expect(service.resumePrepared(input)).rejects.toMatchObject({ code: 'MEMORY_PREPARED_INCOMPATIBLE' });
  });
  it('sends one scoped semantic-group command and fences the next edit after withdrawal', async () => {
    const { service, sessions } = await fixture(), source = { sourceEventId: 'event-a', messageIds: ['m1'] };
    const update = { command: 'UpdateGroups' as const, name: '观鸟计划', words: ['青鹭湾', '北岸'] };
    await service.semanticGroups(scope, update, source);
    const session = sessions[0]!;
    expect(session.request).toHaveBeenCalledWith('tool', { name: 'SemanticGroupEditor',
      args: { command: 'UpdateGroups', groupname: '观鸟计划', groupwords: '青鹭湾,北岸' } }, expect.anything());
    replaceResponse(session, 'bot.source.filter', () => ({ sourceEventWithdrawn: true, blockedMessageIds: ['m1'] }));
    await expect(service.semanticGroups(scope, update, source)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' });
    expect(session.request.mock.calls.filter(([operation]) => operation === 'tool')).toHaveLength(1);
  });
  it('checks native provenance and tombstone revision for one explicitly selected cross-conversation read without passive recall', async () => {
    const evidence = { content: 'source-owned fact', sourceEventId: 'origin-event', sourceMessageIds: ['origin-message'] };
    const f = await fixture(3, session => {
      replaceResponse(session, 'bot.tombstones', () => ({ revision: '4' }));
      replaceResponse(session, 'retrieve', payload => {
        expect(payload).toMatchObject({ diaries: ['Companion'], managedSources: true, fallback: 'knn' });
        return { results: [evidence], unverifiedWrapper: 'must not be copied' };
      });
      replaceResponse(session, 'bot.source.filter', () => ({ sourceEventWithdrawn: false, blockedMessageIds: [] }));
    });
    expect(await f.service.readScoped(scope, 'memory_search', { query: 'fact' })).toEqual({ available: true, records: [evidence], provenance: { revision: '4', sourceEventIds: ['origin-event'], sourceMessageIds: ['origin-message'] } });
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.request.mock.calls.find(([op]) => op === 'bot.source.filter')?.[1]).toEqual({ sourceEventId: 'origin-event', messageIds: ['origin-message'] });
    expect(f.sessions[0]!.request.mock.calls.some(([op]) => ['preprocess', 'response', 'bot.remember'].includes(op))).toBe(false);
  });
  it('withholds withdrawn, unproven and concurrently revoked cross-conversation results', async () => {
    let revision = '4', withdrawn = false, raw = false, revokeDuringRead = false;
    const f = await fixture(3, session => {
      replaceResponse(session, 'bot.tombstones', () => ({ revision }));
      replaceResponse(session, 'bot.note.read', () => { if (revokeDuringRead) revision = '5'; return raw ? 'unproven secret' : { id: 'note', content: 'protected secret', sourceEventId: 'origin-event', sourceMessageIds: ['origin-message'] }; });
      replaceResponse(session, 'bot.source.filter', () => ({ sourceEventWithdrawn: withdrawn, blockedMessageIds: [] }));
    });
    withdrawn = true;
    expect(await f.service.readScoped(scope, 'memory_note', { id: 'note' })).toMatchObject({ available: false, reason: 'memory-source-withdrawn' });
    withdrawn = false; raw = true;
    const unproven = await f.service.readScoped(scope, 'memory_note', { id: 'note' });
    expect(unproven).toMatchObject({ available: false, reason: 'memory-provenance-unavailable' }); expect(JSON.stringify(unproven)).not.toContain('secret');
    raw = false; revokeDuringRead = true;
    const revoked = await f.service.readScoped(scope, 'memory_note', { id: 'note' });
    expect(revoked).toMatchObject({ available: false, reason: 'memory-source-revision-changed' }); expect(JSON.stringify(revoked)).not.toContain('protected secret');
  });
  it('activates independent domains concurrently, reads a busy native source journal, and cancels queued recall', async () => {
    let release!: () => void, arrived!: () => void;
    const hold = new Promise<void>(resolve => { release=resolve; }), started = new Promise<void>(resolve => { arrived=resolve; });
    const {service,sessions} = await fixture(2,(session,generation) => {
      if (generation===1) replaceResponse(session,'doctor',async () => { arrived(); await hold; return {status:'success'}; });
    });
    const first = service.warm(scope), other = {...scope,companionId:'other'};
    try {
      await started; expect(service.isBusy(scope)).toBe(true); expect(service.isBusy(other)).toBe(false);
      await service.warm(other); expect(service.isWarm(other)).toBe(true);
      const db = new DatabaseSync(path.join(sessions[0]!.home,'bot-adapter.sqlite'));
      try { db.exec("PRAGMA journal_mode=WAL; CREATE TABLE metadata(key TEXT,value INTEGER); CREATE TABLE tombstones(kind TEXT,id TEXT); INSERT INTO metadata VALUES('forget-revision',7); INSERT INTO tombstones VALUES('event','private-event'),('message','private-message')");
        await expect(service.withdrawnSources(scope)).resolves.toEqual({revision:'7',sourceEventIds:['private-event'],sourceMessageIds:['private-message']});
      } finally { db.close(); }
      const abort = new AbortController();
      const cancelled = service.tool(scope,'memory_search',{query:'退出'},abort.signal); abort.abort(new Error('cancelled-before-admission'));
      await expect(cancelled).rejects.toThrow('cancelled-before-admission');
      expect(sessions[0]!.request.mock.calls.some(([op])=>op==='search')).toBe(false);
    } finally { release(); await first; }
  });

  it('waits for a resident slot without rejecting another audience’s durable request', async () => {
    let release!: () => void, arrived!: () => void;
    const hold=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{arrived=resolve;});
    const {service,sessions}=await fixture(1,(session,index)=>{ if(index===1)replaceResponse(session,'doctor',async()=>{arrived();await hold;return{status:'success'};}); });
    const first=service.warm(scope), other={...scope,companionId:'another'};
    try { await started; expect(service.isBusy(other)).toBe(true);
      const second=service.warm(other); release(); await Promise.all([first,second]);
      expect(service.isWarm(other)).toBe(true); expect(sessions[0]!.close).toHaveBeenCalledOnce();
    } finally {release();}
  });

  it('verifies a cold source scope independently of model availability and fails closed when established diaries lose their journal', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'bot-source-preflight-'));
    const unavailable=vi.fn(async ():Promise<never>=>{throw new Error('offline');});
    const service=new BotMemoryService({root,runtime:unavailable,embedding:unavailable});
    cleanup.push(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
    expect(await service.withdrawnSources(scope)).toEqual({revision:'0',sourceEventIds:[],sourceMessageIds:[]}); expect(unavailable).not.toHaveBeenCalled();
    const home=path.join(root,createHash('sha256').update(JSON.stringify([scope.companionId,scope.securityDomainId])).digest('hex'));
    await mkdir(path.join(home,'dailynote','Companion'),{recursive:true}); await writeFile(path.join(home,'dailynote','Companion','retained.txt'),'有来源的旧日记');
    await expect(service.withdrawnSources(scope)).rejects.toThrow('来源账本缺失');
  });

  it('fences the WAL preflight behind an already admitted same-domain withdrawal', async () => {
    let release!:()=>void, arrived!:()=>void; const gate=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{arrived=r;});
    const f=await fixture(2,session=>replaceResponse(session,'bot.sources.withdraw',async()=>{ arrived();await gate;
      const db=new DatabaseSync(path.join(session.home,'bot-adapter.sqlite'));
      try { db.exec("CREATE TABLE metadata(key TEXT,value INTEGER); CREATE TABLE tombstones(kind TEXT,id TEXT); BEGIN; INSERT INTO metadata VALUES('forget-revision',2); INSERT INTO tombstones VALUES('message','withdraw-me'); COMMIT"); } finally {db.close();}
      return {withdrawn:true,revision:'2',sourceMessageIds:['withdraw-me'],sourceEventIds:[]}; }));
    const write=f.service.withdrawSources(scope,{sourceEventIds:[],sourceMessageIds:['withdraw-me']});
    try { await started; let completed=false; const read=f.service.withdrawnSources(scope).then(value=>{completed=true;return value;});
      await new Promise(res=>setImmediate(res)); expect(completed).toBe(false); release();
      await write; expect(await read).toEqual({revision:'2',sourceEventIds:[],sourceMessageIds:['withdraw-me']});
    } finally {release();}
  });

  it('single-flights only the selected audience warm-up and shares its resident worker with a concurrent turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { service, sessions } = await fixture(3, session => replaceResponse(session, 'doctor', async () => { await gate; return { status: 'success' }; }));
    const firstPhases: string[] = [], secondPhases: string[] = [];
    expect(service.isWarm(scope)).toBe(false);
    const first = service.warm(scope, phase => firstPhases.push(phase));
    const second = service.warm(scope, phase => secondPhases.push(phase));
    expect(second).toBe(first);
    const turn = service.prepareTurn({ scope, requestId: 'after-selected', messages: [] });
    await vi.waitFor(() => expect(sessions[0]?.request.mock.calls[0]?.[0]).toBe('doctor'));
    expect(sessions).toHaveLength(1); expect(service.isWarm(scope)).toBe(false);
    expect(sessions[0]!.request.mock.calls.map(([operation]) => operation)).toEqual(['doctor']);
    release(); await Promise.all([first, second, turn]);
    expect(service.isWarm(scope)).toBe(true); expect(sessions).toHaveLength(1);
    expect(firstPhases).toEqual(['memory-starting', 'memory-verifying', 'memory-indexing']); expect(secondPhases).toEqual(firstPhases);
    const operations = sessions[0]!.request.mock.calls.map(([operation]) => operation);
    expect(operations.slice(0, 4)).toEqual(['doctor', 'status', 'sync', 'bot.repair']);
    expect(operations.filter(operation => operation === 'doctor')).toHaveLength(1);
    expect(operations).not.toContain('bot.history.append'); expect(operations).not.toContain('bot.remember'); expect(operations).not.toContain('response');
    const before = operations.length; await service.warm(scope); expect(sessions[0]!.request.mock.calls).toHaveLength(before);
    expect(service.isWarm({ ...scope, companionId: 'not-selected' })).toBe(false);
  });
  it('aborts an unfinished warm-up on shutdown and cannot report its closed worker as warm', async () => {
    const { service, sessions } = await fixture(3, session => {
      const original = session.request.getMockImplementation() as (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
      session.request.mockImplementation((operation: string, payload: Record<string, unknown>, options: { signal?: AbortSignal }) => operation !== 'doctor' ? original(operation, payload)
        : new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })));
    });
    const outcome = service.warm(scope).then(() => 'unexpected success', error => error.message as string);
    await vi.waitFor(() => expect(sessions[0]?.request.mock.calls[0]?.[0]).toBe('doctor'));
    await service.close(); expect(await outcome).toContain('shutting down');
    expect(service.isWarm(scope)).toBe(false); expect(sessions[0]!.close).toHaveBeenCalledOnce();
    await expect(service.warm(scope)).rejects.toThrow('closed');
  });
  it('shares only ephemeral release seals across memory worker generations and retains every health probe', async () => {
    const { service, sessions, root } = await fixture(1, session => replaceResponse(session, 'doctor', () => ({ snapshotIntegrity: { seal: 'authenticated-runtime-seal' } })));
    await service.status(scope);
    await service.status({ ...scope, companionId: 'another' });
    await service.status(scope);
    expect(sessions).toHaveLength(3);
    expect(sessions.map(session => session.request.mock.calls.find(([operation]) => operation === 'doctor')?.[1])).toEqual([
      { integritySeal: undefined }, { integritySeal: 'authenticated-runtime-seal' }, { integritySeal: 'authenticated-runtime-seal' },
    ]);
    expect(sessions.every(session => session.request.mock.calls.some(([operation]) => operation === 'sync'))).toBe(true);
    expect(new Set(sessions.map(session => session.env.WORLDLINEBOX_VCP_INTEGRITY_KEY)).size).toBe(1);
    expect(sessions[0]!.env.WORLDLINEBOX_VCP_INTEGRITY_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(sessions[0]!.home, 'config.json'), 'utf8')).not.toContain('INTEGRITY');
    expect(sessions[0]!.home).toContain(root);
    const nextApp = await fixture(); await nextApp.service.status(scope);
    expect(nextApp.sessions[0]!.env.WORLDLINEBOX_VCP_INTEGRITY_KEY).not.toBe(sessions[0]!.env.WORLDLINEBOX_VCP_INTEGRITY_KEY);
    expect(nextApp.sessions[0]!.request.mock.calls.find(([operation]) => operation === 'doctor')?.[1]).toEqual({ integritySeal: undefined });
  });
  it('reports cold initialization phases separately from actual recall and does not repeat them on a warm turn', async () => {
    const { service } = await fixture(), phases: string[] = [];
    await service.prepareTurn({ scope, requestId: 'cold-phases', messages: [], onPhase: phase => phases.push(phase) });
    expect(phases).toEqual(['memory-starting', 'memory-verifying', 'memory-indexing', 'recalling-memory']);
    phases.length = 0;
    await service.prepareTurn({ scope, requestId: 'warm-phases', messages: [], onPhase: phase => phases.push(phase) });
    expect(phases).toEqual(['recalling-memory']);
  });
  it.each(['passive', 'semantic'] as const)('reconnects one interrupted %s inspection on the same domain without recording its query', async mode => {
    const operation = mode === 'passive' ? 'preprocess' : 'search';
    const { service, sessions } = await fixture(3, (session, generation) => {
      replaceResponse(session, operation, () => {
        if (generation === 1) throw Object.assign(new Error('simulated native exit'), { code: 'MEMORY_SESSION_CLOSED', exitCode: 3221226505 });
        const candidate = { text: 'replacement generation result', score: 0 };
        return mode === 'passive'
          ? { result: { messages: [], events: [{ type: 'RAG_RETRIEVAL_DETAILS', results: [candidate] }] }, telemetry: {} }
          : { result: { content: candidate.text }, telemetry: { vcp: { spans: [{ stage: 'lightmemo.final-candidates', input: { candidates: [candidate] } }] } } };
      });
    });
    const report = await service.recall(scope, { query: 'read only query', mode });
    expect(report.hits).toEqual([expect.objectContaining({ rank: 1, text: 'replacement generation result', score: 0 })]);
    expect(sessions).toHaveLength(2); expect(sessions[0]!.home).toBe(sessions[1]!.home); expect(sessions[0]!.close).toHaveBeenCalledOnce();
    const operations = sessions.flatMap(session => session.request.mock.calls.map(([operation]) => operation));
    expect(operations).not.toContain('bot.history.append'); expect(operations).not.toContain('response'); expect(operations).not.toContain('bot.remember');
    if (mode === 'passive') for (const session of sessions) expect(session.request).toHaveBeenCalledWith('preprocess', expect.objectContaining({ options: expect.objectContaining({ oneRing: false }) }), expect.anything());
  });
  it('reconnects a catalog without booting semantic memory and also recovers a read interrupted during activation', async () => {
    const first = await fixture(3, (session, generation) => replaceResponse(session, 'bot.catalog', () => {
      if (generation === 1) throw Object.assign(new Error('closed catalog'), { code: 'MEMORY_SESSION_CLOSED' });
      return { items: [], tags: [], total: 0 };
    }));
    await expect(first.service.catalog(scope, {})).resolves.toEqual({ items: [], tags: [], total: 0 });
    expect(first.sessions).toHaveLength(2); expect(first.sessions.every(session => session.request.mock.calls.every(([operation]) => operation === 'bot.catalog'))).toBe(true);
    const cold = await fixture(3, (session, generation) => { if (generation === 1) replaceResponse(session, 'doctor', () => { throw Object.assign(new Error('activation exit'), { code: 'MEMORY_SESSION_CLOSED' }); }); });
    await expect(cold.service.status(scope)).resolves.toMatchObject({ engine: 'vcp-memory' });
    expect(cold.sessions).toHaveLength(2); expect(cold.sessions[0]!.close).toHaveBeenCalledOnce();
  });
  it('holds the domain FIFO until the interrupted read has closed and completed on its replacement', async () => {
    let rejectRead!: (error: Error) => void, releaseClose!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectRead = reject; }), closing = new Promise<void>(resolve => { releaseClose = resolve; });
    const { service, sessions } = await fixture(3, (session, generation) => {
      if (generation === 1) { replaceResponse(session, 'search', () => interrupted); session.close.mockImplementation(() => closing); }
      else replaceResponse(session, 'search', payload => ({ content: payload.query }));
    });
    const first = service.tool(scope, 'LightMemo', { query: 'first read' });
    await vi.waitFor(() => expect(sessions[0]?.request.mock.calls.some(([operation]) => operation === 'search')).toBe(true));
    const next = service.tool(scope, 'LightMemo', { query: 'queued read' });
    rejectRead(Object.assign(new Error('closed'), { code: 'MEMORY_SESSION_CLOSED' }));
    await vi.waitFor(() => expect(sessions[0]!.close).toHaveBeenCalledOnce()); expect(sessions).toHaveLength(1);
    releaseClose(); await expect(first).resolves.toMatchObject({ content: 'first read' }); await expect(next).resolves.toMatchObject({ content: 'queued read' });
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.request.mock.calls.filter(([operation]) => operation === 'search').map(([, payload]) => payload.query)).toEqual(['first read', 'queued read']);
  });
  it('stops after one read reconnect and preserves the second typed native exit', async () => {
    const { service, sessions } = await fixture(3, (session, generation) => replaceResponse(session, 'search', () => {
      throw Object.assign(new Error(`generation ${generation} failed`), { code: 'MEMORY_SESSION_CLOSED', exitCode: 3221226505 });
    }));
    await expect(service.tool(scope, 'LightMemo', { query: 'repeated failure' })).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED', exitCode: 3221226505, message: 'generation 2 failed' });
    expect(sessions).toHaveLength(2); expect(sessions.every(session => session.close.mock.calls.length === 1)).toBe(true);
  });
  it.each(['timeout', 'abort', 'shutdown'] as const)('does not reconnect a read after %s', async kind => {
    const controller = new AbortController();
    let rejectRead!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
    const { service, sessions } = await fixture(3, session => replaceResponse(session, 'search', () => pending));
    const running = service.tool(scope, 'LightMemo', { query: 'cancellable read' }, controller.signal);
    const failure = expect(running).rejects.toMatchObject({ code: kind === 'timeout' ? 'MEMORY_TIMEOUT' : 'MEMORY_SESSION_CLOSED' });
    await vi.waitFor(() => expect(sessions[0]?.request.mock.calls.some(([operation]) => operation === 'search')).toBe(true));
    if (kind === 'abort') controller.abort(new Error('cancelled'));
    const closing = kind === 'shutdown' ? service.close() : undefined;
    rejectRead(Object.assign(new Error(kind), { code: kind === 'timeout' ? 'MEMORY_TIMEOUT' : 'MEMORY_SESSION_CLOSED' }));
    await failure; await closing; expect(sessions).toHaveLength(1);
  });
  it.each(['remember', 'update', 'organize', 'history', 'forget', 'finish'] as const)('never blindly replays an unknown %s write outcome', async kind => {
    const { service, sessions } = await fixture(); await service.status(scope);
    const operation = { remember: 'bot.remember', update: 'bot.update', organize: 'bot.organize', history: 'bot.history.append', forget: 'bot.forget', finish: 'response' }[kind];
    const prepared = kind === 'finish' ? await service.prepareTurn({ scope, requestId: 'write-reply', messages: [] }) : undefined;
    replaceResponse(sessions[0]!, operation, () => { throw Object.assign(new Error('write result unknown'), { code: 'MEMORY_SESSION_CLOSED' }); });
    const common = { operationId: 'mutation', sourceEventId: 'source', content: 'changed note' };
    const work = kind === 'remember' ? service.remember(scope, common)
      : kind === 'update' ? service.update(scope, { ...common, id: 'a'.repeat(64), expectedChecksum: 'b'.repeat(32) })
        : kind === 'organize' ? service.organize(scope, { ...common, sources: [{ id: 'a'.repeat(64), expectedChecksum: 'b'.repeat(32) }] })
          : kind === 'history' ? service.appendHistory(scope, [{ id: 'original', role: 'user', content: 'original words', timestamp: 1 }])
            : kind === 'forget' ? service.forget(scope, { id: 'a'.repeat(64) }) : service.finishTurn(prepared!, 'answer');
    await expect(work).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED' }); expect(sessions).toHaveLength(1);
    expect(sessions[0]!.request.mock.calls.filter(([op]) => op === operation)).toHaveLength(1);
  });
  it('does not replay OneRing preparation after a committed preparation loses its response, but can read that exact durable snapshot', async () => {
    const { service, sessions } = await fixture(); await service.status(scope);
    const original = sessions[0]!.request.getMockImplementation() as (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
    sessions[0]!.request.mockImplementation(async (operation, payload) => {
      const result = await original(operation, payload);
      if (operation === 'bot.prepared.put') throw Object.assign(new Error('committed preparation response lost'), { code: 'MEMORY_SESSION_CLOSED' });
      return result;
    });
    const input = { scope, requestId: 'durable-prepare', messages: [{ id: 'u1', role: 'user' as const, content: 'original context', timestamp: 1 }] };
    await expect(service.prepareTurn(input)).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED' }); expect(sessions).toHaveLength(1);
    const recovered = await service.resumePrepared(input); expect(recovered.requestId).toBe(input.requestId); expect(recovered.sourceMessageIds).toEqual(['u1']);
    expect(sessions).toHaveLength(2); expect(sessions[1]!.request.mock.calls.some(([operation]) => operation === 'preprocess')).toBe(false);
    expect(sessions[0]!.request.mock.calls.filter(([operation]) => operation === 'preprocess')).toHaveLength(1);
  });
  it('never recomputes a preparation whose OneRing preprocessor stopped before a durable snapshot was confirmed', async () => {
    const { service, sessions } = await fixture(); await service.status(scope);
    replaceResponse(sessions[0]!, 'preprocess', () => { throw Object.assign(new Error('OneRing write outcome unknown'), { code: 'MEMORY_SESSION_CLOSED' }); });
    await expect(service.prepareTurn({ scope, requestId: 'unconfirmed-preparation', messages: [] })).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED' });
    expect(sessions).toHaveLength(1); expect(sessions[0]!.request.mock.calls.filter(([operation]) => operation === 'preprocess')).toHaveLength(1);
    expect(sessions[0]!.request.mock.calls.some(([operation]) => operation === 'bot.prepared.put')).toBe(false);
  });
  it('reconnects a durable preparation read without repeating its earlier OneRing pass', async () => {
    const { service, sessions } = await fixture();
    const input = { scope, requestId: 'frozen-read', messages: [] }, prepared = await service.prepareTurn(input);
    replaceResponse(sessions[0]!, 'bot.prepared.get', () => { throw Object.assign(new Error('read transport closed'), { code: 'MEMORY_SESSION_CLOSED' }); });
    await expect(service.resumePrepared(input)).resolves.toEqual(prepared);
    expect(sessions).toHaveLength(2); expect(sessions[1]!.request.mock.calls.some(([operation]) => operation === 'preprocess')).toBe(false);
  });
  it('inspects passive and active recall on the resident original paths without recording the test as conversation memory', async () => {
    const { service, sessions } = await fixture(); await service.status(scope);
    replaceResponse(sessions[0]!, 'preprocess', () => ({ result: { messages: [{ role: 'system', content: '原VCP被动证据' }],
      events: [{ type: 'RAG_RETRIEVAL_DETAILS', results: [{ text: '真实第一条', score: 0 }] }] },
      telemetry: { vcp: { spans: [{ id: 1, stage: 'embedding.query-cache-or-provider', hostTiming: { durationMs: 38.25 }, status: 'completed' }] } } }));
    replaceResponse(sessions[0]!, 'search', () => ({ result: { content: '原LightMemo输出' }, telemetry: { vcp: { spans: [
      { stage: 'lightmemo.final-candidates', input: { candidates: [{ text: '语义命中', bm25Score: 12, hybridScore: 0.32 }] }, status: 'completed' },
    ] } } }));
    const passive = await service.recall(scope, { query: '自然语言试查', mode: 'passive' });
    expect(passive.hits[0]).toMatchObject({ rank: 1, text: '真实第一条', score: 0 });
    expect(passive.stages).toContainEqual(expect.objectContaining({ name: 'embedding.query-cache-or-provider', durationMs: 38.25 }));
    expect(sessions[0]!.request).toHaveBeenCalledWith('preprocess', expect.objectContaining({ options: expect.objectContaining({ oneRing: false, sync: false }) }), expect.objectContaining({ withTelemetry: true }));
    const semantic = await service.recall(scope, { query: '主动查找', mode: 'semantic' });
    expect(semantic.hits[0]).toMatchObject({ text: '语义命中', scores: { bm25Score: 12, hybridScore: 0.32 } });
    expect(sessions).toHaveLength(1);
    const calls = sessions[0]!.request.mock.calls.map(([operation]) => operation);
    expect(calls).not.toContain('response'); expect(calls).not.toContain('bot.remember'); expect(calls).not.toContain('bot.history.append');
  });
  it('archives original messages without semantic startup and upgrades the same resident worker once before recall', async () => {
    const { service, sessions } = await fixture();
    await service.appendHistory(scope, [{ id: 'source-only', role: 'user', content: '准确原话', timestamp: 1793614000000 }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.request.mock.calls.map(([op]) => op)).toEqual(['bot.history.append']);
    await service.status(scope); await service.status(scope);
    expect(sessions).toHaveLength(1);
    const calls = sessions[0]!.request.mock.calls.map(([op]) => op);
    expect(calls.slice(1, 5)).toEqual(['doctor', 'status', 'sync', 'bot.repair']);
    expect(calls.filter(op => op === 'sync')).toHaveLength(1);
  });
  it('retains a resident session, uses the built-in routes and keeps credentials off disk', async () => {
    const { service, sessions } = await fixture();
    await service.status(scope); await service.status(scope);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.env.EMBEDDING_API_KEY).toBe('secret-key');
    const config = await readFile(path.join(sessions[0]!.home, 'config.json'), 'utf8');
    expect(config).not.toContain('secret-key'); expect(config).not.toContain('127.0.0.1');
    expect(JSON.parse(config).LOCAL_EMBEDDING_ENABLED).toBe(false);
    expect(sessions[0]!.request.mock.calls.filter(([op]) => op === 'sync')).toHaveLength(1);
  });
  it('separates security domains and evicts only an idle domain', async () => {
    const { service, sessions } = await fixture(1);
    await service.status(scope); await service.status({ ...scope, conversationId: 'g1', securityDomainId: 'g1' });
    expect(sessions).toHaveLength(2); expect(sessions[0]!.home).not.toBe(sessions[1]!.home);
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
  });
  it('passes exact timestamp bindings and request-local metadata through the completion hook', async () => {
    const { service, sessions } = await fixture();
    const input = { scope, requestId: 'req1', messages: [{ id: 'u1', role: 'user' as const, content: 'query', timestamp: 1793614000000 }] };
    const first = await service.prepareTurn(input); const retry = await service.prepareTurn(input);
    expect(first.citations?.[0]?.text).toBe('实际RAG证据'); expect(retry).toEqual(first);
    const preprocess = sessions[0]!.request.mock.calls.find(([op]) => op === 'preprocess')!;
    expect(first.status).toBe('ready'); expect(preprocess[1]).toMatchObject({ includeTurnReadiness: true });
    expect(sessions[0]!.request.mock.calls.some(([op]) => op === 'bot.status')).toBe(false);
    expect(preprocess[1]).toMatchObject({ options: { folding: true, tray: true, timeline: true, oneRing: true, sync: false, vcpchatExtensions: { requestContext: { requestId: 'req1' } } } });
    expect(JSON.parse(first.nativeContext!)).toEqual([{ role: 'system', content: '实际RAG证据' }]);
    await service.finishTurn(JSON.parse(JSON.stringify(first)), 'answer', true);
    await service.finishTurn(first, 'answer', true);
    const calls = sessions[0]!.request.mock.calls.filter(([op]) => op === 'response');
    expect(calls).toHaveLength(1); expect(calls[0]![1]).toMatchObject({ metadata: first.metadata, messages: first.messages, text: 'answer', completed: true });
  });
  it('freezes a pending non-telemetry readiness receipt across retries and never saves an aborted preprocessor', async () => {
    const { service, sessions } = await fixture(); await service.status(scope);
    const session = sessions[0]!;
    replaceResponse(session, 'preprocess', () => ({ messages: [], memoryPending: true }));
    const input = { scope, requestId: 'pending-turn', messages: [] };
    const pending = await service.prepareTurn(input); expect(pending.status).toBe('pending');
    replaceResponse(session, 'preprocess', () => ({ messages: [], memoryPending: false }));
    expect(await service.prepareTurn(input)).toEqual(pending);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    replaceResponse(session, 'preprocess', () => new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); entered();
    }));
    const cancelled = service.prepareTurn({ ...input, requestId: 'aborted-turn', signal: controller.signal });
    await started; controller.abort(new Error('cancelled by user'));
    await expect(cancelled).rejects.toThrow('cancelled by user');
    expect(session.request.mock.calls.filter(([op]) => op === 'bot.prepared.put')).toHaveLength(1);
    expect(session.close).toHaveBeenCalledOnce();
  });
  it('carries generated tray, OneRing and folded context without copying quoted markers from original turns', async () => {
    const { service, sessions } = await fixture(); await service.status(scope);
    const originals = [
      { id: 'u', role: 'user' as const, content: '[系统提示:]\n[RAG处理失败] 是在讨论一段日志', timestamp: 1 },
      { id: 'a', role: 'assistant' as const, content: '[VCP上下文语义折叠-本层摘要:对方提供的例子]\n[OneRing通知:原作者于2026-11-26 16:00:00发送于WorldlineBox]', timestamp: 2 },
    ];
    const generated = [
      { role: 'user', content: '[系统提示:]\n日记来自春季旅行' },
      { role: 'user', content: '[系统提示:][OneRing通知:上一条消息由小南于2026-11-27 07:00:00发送于WorldlineBox]' },
      { role: 'assistant', content: '[VCP上下文语义折叠-本层摘要:早上六点集合]' },
      { role: 'user', content: '[系统提示:]\n从 OneRing 召回的历史错误记录 [RAG处理失败]' },
    ];
    replaceResponse(sessions[0]!, 'preprocess', () => ({ messages: [
      { role: 'user', content: originals[0]!.content + '\n[OneRing通知:用户于2026-11-27 08:00:00发送于WorldlineBox]' },
      { role: 'assistant', content: originals[1]!.content.replace('原作者于2026-11-26 16:00:00', '伙伴于2026-11-27 08:05:00') }, { role: 'assistant', content: '[系统提示:] 错误角色' },
      { role: 'user', content: '[VCP上下文语义折叠-本层摘要:错误角色]' }, ...generated,
    ], injectedHistoryIndices: [7] }));
    const prepared = await service.prepareTurn({ scope, requestId: 'quoted-markers', messages: originals });
    expect(JSON.parse(prepared.nativeContext!)).toEqual(generated);
  });
  it('freezes native context and complete citations, then pages any original without another retrieval', async () => {
    const { service, sessions } = await fixture(); await service.status(scope);
    const results = Array.from({ length: 20 }, (_, index) => ({ text: `第${index}条精确原文🐳：时间20分钟，路径C:\\资料\\"更正"\n`.repeat(120),
      score: index / 20, source: 'rag', date: '2026-11-03', fullPath: `Companion/original-${index}.txt`, sourceFile: `original-${index}.txt` }));
    const events = [{ type: 'RAG_RETRIEVAL_DETAILS', dbName: 'Companion', k: 8, results }];
    replaceResponse(sessions[0]!, 'preprocess', () => ({ messages: [{ role: 'system', content: 'SYSTEM_FALLBACK_IS_NOT_THE_BROADCAST' }, { role: 'user', content: 'query' }], events }));
    const requestId = 'large-passive-rag', messages = [{ id: 'original-user', role: 'user' as const, content: '核对今晚时间。', timestamp: 1793614000000 }];
    const prepared = await service.prepareTurn({ scope, requestId, messages });
    expect(JSON.parse(prepared.nativeContext)).toEqual([{ role: 'system', content: 'SYSTEM_FALLBACK_IS_NOT_THE_BROADCAST' }]);
    expect(prepared.evidenceCoverage).toMatchObject({ basis: 'vcp-rag-broadcast', broadcastEvents: 1, broadcastMaxPerEvent: 20, internalCandidates: 'not-exposed' });
    expect(prepared.citations?.filter(citation => citation.origin === 'vcp-rag-result').map(citation => citation.text)).toEqual(results.map(result => result.text));
    expect(prepared.citations?.find(citation => citation.origin === 'vcp-system-snapshot')).toMatchObject({ text: 'SYSTEM_FALLBACK_IS_NOT_THE_BROADCAST', referenceOnly: true });
    expect(prepared.evidenceCoverage).toMatchObject({ ragResults: 20, systemSnapshots: 1, systemMaterial: 'unclassified-not-memory-facts' });
    expect(prepared.citations?.[0]).toMatchObject({ score: 0, source: 'rag', fullPath: results[0]!.fullPath, origin: 'vcp-rag-result' });
    const durable = sessions[0]!.request.mock.calls.find(([op]) => op === 'bot.prepared.put')![1].prepared as typeof prepared;
    expect(durable.citations).toEqual(prepared.citations); expect(durable.events).toEqual(events);
    expect(durable).not.toHaveProperty('evidence'); expect(durable).not.toHaveProperty('omittedChars');
    replaceResponse(sessions[0]!, 'bot.prepared.get', () => ({ prepared: JSON.stringify({ ...durable, evidence: 'retired preview', omittedChars: 121 }) }));
    expect(await service.resumePrepared({ scope, requestId })).toStrictEqual(prepared);
    expect(await service.prepareTurn({ scope, requestId, messages })).toEqual(prepared);
    const catalog = await service.recallDetails({ scope, requestId }) as { requestId: string; coverage: unknown; citations: Array<{ citationId: string; totalChars: number }> };
    expect(catalog.requestId).toBe(requestId); expect(catalog.coverage).toEqual(prepared.evidenceCoverage); expect(catalog.citations).toHaveLength(prepared.citations!.length);
    const citation = prepared.citations![19]!, original = results[19]!.text;
    let offset = 0, combined = '', pages = 0;
    for (;;) {
      const page = await service.recallDetails({ scope, requestId, citationId: citation.id, offset }) as BotMemoryCitationPage;
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(4096);
      expect(page).toMatchObject({ requestId, citationId: citation.id, offset, offsetUnit: 'utf16', totalChars: original.length,
        totalBytes: Buffer.byteLength(original, 'utf8'), source: 'rag', date: '2026-11-03', score: 19 / 20, fullPath: results[19]!.fullPath });
      expect(page.text.length).toBeGreaterThan(0); expect(page.text).toBe(original.slice(offset, offset + page.text.length));
      expect(/[\uD800-\uDBFF]$/.test(page.text)).toBe(false); expect(/^[\uDC00-\uDFFF]/.test(page.text)).toBe(false);
      combined += page.text; pages++;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(offset + page.text.length); offset = page.nextOffset;
      if (pages > 100) throw new Error('Passive citation paging did not finish');
    }
    expect(pages).toBeGreaterThan(1); expect(combined).toBe(original);
    const operations = sessions[0]!.request.mock.calls.map(([op]) => op);
    expect(operations.filter(op => op === 'context.prepare')).toHaveLength(1); expect(operations.filter(op => op === 'preprocess')).toHaveLength(1);
    expect(operations.filter(op => ['search', 'tool'].includes(op))).toEqual([]);
    const sourceChecks = sessions[0]!.request.mock.calls.filter(([op]) => op === 'bot.source.filter');
    expect(sourceChecks.length).toBeGreaterThanOrEqual(pages + 2);
    expect(sourceChecks.every(([, payload]) => payload.sourceEventId === requestId && JSON.stringify(payload.messageIds) === JSON.stringify(['original-user']))).toBe(true);
  });
  it('refuses a citation from another request even when both preparations belong to the same domain', async () => {
    const { service } = await fixture();
    const first = await service.prepareTurn({ scope, requestId: 'citation-request-a', messages: [] });
    const second = await service.prepareTurn({ scope, requestId: 'citation-request-b', messages: [] });
    expect(first.citations![0]!.id).not.toBe(second.citations![0]!.id);
    await expect(service.recallDetails({ scope, requestId: second.requestId, citationId: first.citations![0]!.id })).rejects.toMatchObject({ code: 'MEMORY_CITATION_NOT_FOUND' });
  });
  it.each(['owner', 'audience'] as const)('refuses a frozen citation row returned from another %s instead of trusting its requested identifier', async kind => {
    const { service, sessions } = await fixture();
    const prepared = await service.prepareTurn({ scope, requestId: 'private-citation', messages: [] });
    const other = kind === 'owner' ? { ...scope, companionId: 'other-companion' } : { ...scope, conversationId: 'other-room', securityDomainId: 'other-room' };
    await expect(service.recallDetails({ scope: other, requestId: prepared.requestId, citationId: prepared.citations![0]!.id })).rejects.toMatchObject({ code: 'MEMORY_PREPARED_MISSING' });
    // A buggy/incorrect worker reply must not bypass the host's domain check.
    replaceResponse(sessions[1]!, 'bot.prepared.get', () => ({ prepared: JSON.stringify(prepared) }));
    await expect(service.recallDetails({ scope: other, requestId: prepared.requestId, citationId: prepared.citations![0]!.id })).rejects.toThrow('another request or domain');
  });
  it.each(['event', 'message'] as const)('rechecks %s withdrawal before each citation read and retains a withdrawn completion fence', async kind => {
    const { service, sessions } = await fixture();
    const prepared = await service.prepareTurn({ scope, requestId: 'withdraw-citation', messages: [{ id: 'withdrawn-source', role: 'user', content: '旧资料', timestamp: 1 }] });
    const citationId = prepared.citations![0]!.id;
    await expect(service.recallDetails({ scope, requestId: prepared.requestId, citationId })).resolves.toMatchObject({ text: '实际RAG证据' });
    replaceResponse(sessions[0]!, 'bot.source.filter', () => ({ status: 'success', sourceEventWithdrawn: kind === 'event', blockedMessageIds: kind === 'message' ? ['withdrawn-source'] : [] }));
    await expect(service.recallDetails({ scope, requestId: prepared.requestId, citationId })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' });
    await service.finishTurn(prepared, '撤回后不应记录这个回答', false);
    await expect(service.recallDetails({ scope, requestId: prepared.requestId, citationId })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' });
    expect(sessions[0]!.request.mock.calls.filter(([op]) => op === 'response')).toHaveLength(0);
  });
  it.each(['context.prepare', 'preprocess'])('treats plugin_error from %s as failure rather than a successful passive card', async operation => {
    const { service, sessions } = await fixture(); await service.status(scope);
    replaceResponse(sessions[0]!, operation, () => ({ status: 'success', plugin_error: 'PASSIVE_RECALL_PLUGIN_FAILED', messages: [{ role: 'system', content: '不应被呈现的成功证据' }], events: [] }));
    await expect(service.prepareTurn({ scope, requestId: 'plugin-error', messages: [] })).rejects.toMatchObject({ code: 'MEMORY_TOOL_FAILED', message: 'PASSIVE_RECALL_PLUGIN_FAILED' });
    expect(sessions[0]!.request.mock.calls.filter(([op]) => op === 'bot.prepared.put')).toHaveLength(0);
  });
  it('never lets model tool arguments select a different diary, owner or home', async () => {
    const { service, sessions } = await fixture();
    await service.tool(scope, 'DeepMemo', { keyword: 'SQLite', maid: 'other-owner', agentId: 'other-owner', home: '../private' });
    const call = sessions[0]!.request.mock.calls.find(([op, payload]) => op === 'tool' && payload.name === 'DeepMemo')!;
    expect(call[1]).toEqual({ name: 'DeepMemo', args: { keyword: 'SQLite', maid: 'c1', window_size: 4 }, context: { agentId: 'c1', topicId: 'dm1' } });
    await expect(service.tool(scope, 'arbitrary_fs_read', {})).rejects.toThrow('Unsupported');
  });
  it('acknowledges durable DailyNote writes without waiting for indexing and supports a separate background wait', async () => {
    const { service, sessions } = await fixture();
    expect(await service.remember(scope, { sourceEventId: 'fact-1', content: 'User prefers tea' })).toMatchObject({ state: 'pending', durable: true, indexed: false });
    expect(sessions[0]!.request.mock.calls.some(([op]) => op === 'bot.sync')).toBe(false);
    await service.remember(scope, { sourceEventId: 'fact-1', content: 'User prefers tea', waitForIndex: true });
    const calls = sessions[0]!.request.mock.calls;
    expect(calls.find(([op]) => op === 'bot.remember')?.[1]).toMatchObject({ sourceEventId: 'fact-1' });
    expect(calls.find(([op]) => op === 'bot.sync')?.[1]).toEqual({ id: 'receipt' });
  });
  it('does not present an upstream RAG failure marker as successful memory', async () => {
    const { service, sessions } = await fixture();
    await service.status(scope);
    const original = sessions[0]!.request.getMockImplementation() as (op: string, payload: Record<string, unknown>) => Promise<unknown>;
    sessions[0]!.request.mockImplementation(async (op, payload) => op === 'preprocess'
      ? { messages: [{ role: 'system', content: '[RAG处理失败]' }] } : original(op, payload));
    await expect(service.prepareTurn({ scope, requestId: 'bad', messages: [] })).rejects.toMatchObject({ code: 'MEMORY_RECALL_FAILED' });
  });
  it('preserves real authors in group history and refuses changed input under a reused request id', async () => {
    const { service, sessions } = await fixture();
    const messages = [{ id: 'g1', role: 'user' as const, content: 'hello', timestamp: 42, senderId: 'peer-2', senderName: '伙伴乙' }];
    await service.prepareTurn({ scope, requestId: 'group-event', messages });
    const prepare = sessions[0]!.request.mock.calls.find(([op]) => op === 'context.prepare')!;
    expect(JSON.stringify(prepare[1])).toContain('peer-2'); expect(JSON.stringify(prepare[1])).toContain('伙伴乙');
    await expect(service.prepareTurn({ scope, requestId: 'group-event', messages: [{ ...messages[0]!, content: 'changed' }] })).rejects.toThrow('different input');
  });
  it('never evicts an active domain when the resident process bound is reached', async () => {
    const { service, sessions } = await fixture(1); await service.status(scope);
    const original = sessions[0]!.request.getMockImplementation() as (op: string, payload: Record<string, unknown>) => Promise<unknown>;
    let release!: (value: object) => void;
    const blocker = new Promise<object>(resolve => { release = resolve; });
    sessions[0]!.request.mockImplementation(async (op, payload) => op === 'bot.status' ? blocker : original(op, payload));
    const running = service.status(scope); await new Promise<void>(resolve => setImmediate(resolve));
    const other = { ...scope, securityDomainId: 'other' }, waiting = service.status(other);
    expect(service.isBusy(other)).toBe(true); expect(sessions[0]!.close).not.toHaveBeenCalled();
    release({ pending: 0 }); await running; await waiting; expect(sessions).toHaveLength(2);
  });
  it('hands queued queries and preparation to the new worker only after forgetting retires the old worker', async () => {
    const { service, sessions } = await fixture(1); await service.status(scope);
    const old = sessions[0]!, original = old.request.getMockImplementation() as (op: string, payload: Record<string, unknown>) => Promise<unknown>;
    old.request.mockImplementation(async (op, payload) => op === 'bot.forget'
      ? { forgotten: true, id: 'a'.repeat(64), sourceEventIds: ['source'], sourceMessageIds: ['u1'] } : original(op, payload));
    let release!: () => void; const retired = new Promise<void>(resolve => { release = resolve; });
    old.close.mockImplementation(async () => retired);
    const forgetting = service.forget(scope, { id: 'a'.repeat(64) });
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledOnce());
    const query = service.tool(scope, 'LightMemo', { query: 'after forgetting' });
    const preparing = service.prepareTurn({ scope, requestId: 'new-turn', messages: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sessions).toHaveLength(1);
    expect(old.request.mock.calls.filter(([op]) => ['search', 'preprocess'].includes(op))).toHaveLength(0);
    release(); await forgetting; await query; await preparing;
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.request.mock.calls.some(([op]) => op === 'search')).toBe(true);
    expect(sessions[1]!.request.mock.calls.some(([op]) => op === 'preprocess')).toBe(true);
    expect(old.request.mock.calls.filter(([op]) => ['search', 'preprocess'].includes(op))).toHaveLength(0);
  });
});
