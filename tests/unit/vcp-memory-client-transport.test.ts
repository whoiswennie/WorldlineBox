import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import type { VcpMemoryCommand } from '../../src/main/vcp-memory/contracts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

describe('VCP worker transport serialization', () => {
  it('detaches dependencies after an idle worker exits unexpectedly and preserves their external target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-idle-exit-'));
    const source = path.join(root, 'external-source'), dataRoot = path.join(root, 'owned'), scope = { scopeId: 'idle-worker-crash' };
    const runtime = path.join(dataRoot, createHash('sha256').update(scope.scopeId).digest('hex'), 'runtime'), link = path.join(runtime, 'node_modules');
    await mkdir(source); await mkdir(runtime, { recursive: true }); await writeFile(path.join(source, 'SENTINEL'), 'external source survives');
    await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    const events = new EventEmitter(), transport: VcpMemoryTransport = { on: events.on.bind(events), kill: () => { events.emit('exit', 0); },
      postMessage(message) { const request = message as { requestId: string }; events.emit('message', { requestId: request.requestId, ok: true, value: {} }); } };
    const client = new VcpMemoryClient({ dataRoot, vendorRoot: 'unused', workerPath: 'unused',
      embedding: { baseUrl: 'http://127.0.0.1/internal', apiKey: 'fixture', model: 'fixture', dimension: 4 }, launch: () => transport });
    try {
      await client.replace(scope, []); events.emit('exit', 7); await client.close();
      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(source, 'SENTINEL'), 'utf8')).toBe('external source survives');
    } finally { await client.close(); await removeOwnedDirectory(root); }
  });
  it('sends a plain scope selector when a permission view also contains host functions', async () => {
    const events = new EventEmitter(), sent: VcpMemoryCommand[] = [];
    const transport: VcpMemoryTransport = {
      on: events.on.bind(events), kill: () => { events.emit('exit', 0); },
      postMessage(message) {
        // Unlike Node fork's JSON mode, the production utility process rejects functions.
        const envelope = structuredClone(message) as { requestId: string; command: VcpMemoryCommand };
        sent.push(envelope.command);
        const value = envelope.command.type === 'replace' ? { replaced: true, count: envelope.command.notes.length }
          : envelope.command.type === 'search' ? { results: [], diagnostics: {}, degraded: false } : {};
        events.emit('message', { requestId: envelope.requestId, ok: true, value });
        if (envelope.command.type === 'close') events.emit('exit', 0);
      },
    };
    const client = new VcpMemoryClient({ dataRoot: 'unused-data', vendorRoot: 'unused-vendor', workerPath: 'unused-worker',
      embedding: { baseUrl: 'http://127.0.0.1/internal', apiKey: 'fixture', model: 'fixture', dimension: 4 }, launch: () => transport });
    const view = { scopeId: 'authorized-view', revision: 'host-only-revision', commit: vi.fn(), internal: { task: () => undefined } };
    try {
      await expect(client.replace(view, [{ id: 'note', content: 'alpha', tags: [] }])).resolves.toEqual({ replaced: true, count: 1 });
      await client.search(view, { text: 'alpha', topK: 4, hostCallback: () => undefined } as { text: string; topK: number });
      expect(sent[0]).toMatchObject({ type: 'initialize', configuration: { scope: { scopeId: view.scopeId } } });
      expect(sent[0]!.type === 'initialize' && Object.keys(sent[0]!.configuration.scope)).toEqual(['scopeId']);
      expect(JSON.stringify(sent)).not.toContain('host-only-revision');
      expect(sent.find(command => command.type === 'search')).toEqual({ type: 'search', text: 'alpha', topK: 4 });
      expect(view.commit).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
  it('shares four actual children across clients and never evicts an active peer', async () => {
    const broker = new VcpMemoryProcessBroker(4), live = new Set<EventEmitter>(); let peak = 0;
    let complete!: () => void; const killed: string[] = [];
    const launch = () => {
      const events = new EventEmitter(); live.add(events); peak = Math.max(peak,live.size); let scope = '';
      const exit = () => { if (!live.delete(events)) return; killed.push(scope); events.emit('exit',0); };
      return { on: events.on.bind(events), kill: exit, postMessage(message: unknown) {
        const envelope = message as {requestId:string;command:VcpMemoryCommand};
        if (envelope.command.type === 'initialize') scope = envelope.command.configuration.scope.scopeId;
        const reply = () => events.emit('message',{requestId:envelope.requestId,ok:true,value:{}});
        if (envelope.command.type === 'search' && envelope.command.text === 'hold') complete = () => { reply(); };
        else { reply(); if (envelope.command.type === 'close') exit(); }
      } };
    };
    const options = { dataRoot:'unused-shared-pool',vendorRoot:'unused',workerPath:'unused',embedding:{baseUrl:'http://127.0.0.1',apiKey:'local-fixture',model:'fixture',dimension:4},processBroker:broker,launch };
    const alice = new VcpMemoryClient(options), bob = new VcpMemoryClient({...options,dataRoot:'unused-shared-peer'});
    try {
      const active = alice.search({scopeId:'alice-active'},{text:'hold'}); await vi.waitFor(() => expect(complete).toBeDefined());
      for (const scopeId of ['bob-one','bob-two','bob-three','bob-four','bob-five']) await bob.list({scopeId});
      expect(peak).toBe(4); expect(live.size).toBe(4); expect(killed).not.toContain('alice-active');
      complete(); await active; expect(broker.snapshot().active).toBe(0);
    } finally { await Promise.all([alice.close(),bob.close()]); await broker.close(); }
    expect(live.size).toBe(0);
  });
  it('coalesces manual close with LRU retirement and waits for exit before opening a replacement', async () => {
    const broker = new VcpMemoryProcessBroker(1); let closes = 0, launches = 0, kills = 0, exit!: () => void;
    const launch = () => {
      const events = new EventEmitter(); const ordinal = ++launches; let exited = false;
      const finish = () => { if (exited) return; exited=true; events.emit('exit',0); };
      return { on:events.on.bind(events), kill() { kills++; if (ordinal !== 1) finish(); }, postMessage(message:unknown) {
        const envelope = message as {requestId:string;command:VcpMemoryCommand};
        if (envelope.command.type === 'close') { closes++; if (ordinal === 1) exit = () => { events.emit('message',{requestId:envelope.requestId,ok:true,value:{}}); finish(); }; else { events.emit('message',{requestId:envelope.requestId,ok:true,value:{}}); finish(); } }
        else events.emit('message',{requestId:envelope.requestId,ok:true,value:{}});
      } };
    };
    const options = {dataRoot:'unused-race',vendorRoot:'unused',workerPath:'unused',embedding:{baseUrl:'http://127.0.0.1',apiKey:'local-fixture',model:'fixture',dimension:4},processBroker:broker,launch};
    const first = new VcpMemoryClient(options), peer = new VcpMemoryClient({...options,dataRoot:'unused-race-peer'});
    try {
      await first.list({scopeId:'one'}); const closing = first.closeScope({scopeId:'one'});
      const next = peer.list({scopeId:'two'}); await vi.waitFor(() => expect(exit).toBeDefined());
      await new Promise(resolve => setTimeout(resolve,25)); expect(closes).toBe(1); expect(launches).toBe(1);
      exit(); await closing; await next; expect(launches).toBe(2); expect(closes).toBe(1);
      expect(kills).toBe(1); expect(broker.snapshot().processes).toBe(1);
    } finally { await first.close(); await peer.close(); await broker.close(); }
  });
  it('cancels queued admission without spawning after scope interruption and does not renew its original deadline', async () => {
    const broker = new VcpMemoryProcessBroker(1); let launches=0, finish!:()=>void;
    const launch = () => { launches++; const events=new EventEmitter(); return {on:events.on.bind(events),kill(){events.emit('exit',0);},postMessage(message:unknown){
      const envelope=message as {requestId:string;command:VcpMemoryCommand}; const reply=()=>events.emit('message',{requestId:envelope.requestId,ok:true,value:{}});
      if(envelope.command.type==='search')finish=reply; else {reply();if(envelope.command.type==='close')events.emit('exit',0);}
    }}; };
    const options={dataRoot:'unused-cancel',vendorRoot:'unused',workerPath:'unused',embedding:{baseUrl:'http://127.0.0.1',apiKey:'local-fixture',model:'fixture',dimension:4},processBroker:broker,launch};
    const busy=new VcpMemoryClient(options),waiting=new VcpMemoryClient({...options,dataRoot:'unused-cancel-peer',requestTimeoutMs:100});
    try {
      const work=busy.search({scopeId:'busy'},{text:'hold'}); await vi.waitFor(()=>expect(finish).toBeDefined());
      const pending=waiting.list({scopeId:'cancelled'}), rejected=expect(pending).rejects.toThrow('interrupted');
      await new Promise(resolve=>setTimeout(resolve,25)); await waiting.interruptScope({scopeId:'cancelled'}); await rejected;
      expect(launches).toBe(1);
      const expired=waiting.list({scopeId:'expired'}); await expect(expired).rejects.toThrow(/timed out|busy/u); expect(launches).toBe(1);
      finish();await work;
    } finally {await Promise.all([busy.close(),waiting.close()]);await broker.close();}
  });

  it('reports shutdown timeout but still detaches and releases the exact permit on a later actual exit',async()=>{
    vi.useFakeTimers();const broker=new VcpMemoryProcessBroker(1),events=new EventEmitter();
    const client=new VcpMemoryClient({dataRoot:'unused-late-exit',vendorRoot:'unused',workerPath:'unused',embedding:{baseUrl:'http://127.0.0.1',apiKey:'local-fixture',model:'fixture',dimension:4},processBroker:broker,
      launch:()=>({on:events.on.bind(events),kill(){},postMessage(message:unknown){const envelope=message as {requestId:string};events.emit('message',{requestId:envelope.requestId,ok:true,value:{}});}})});
    try{
      await client.list({scopeId:'late-exit'});const closing=client.closeScope({scopeId:'late-exit'}),rejected=expect(closing).rejects.toThrow('did not exit');
      await vi.advanceTimersByTimeAsync(5_001);await rejected;expect(broker.snapshot().processes).toBe(1);
      events.emit('exit',0);await vi.waitFor(()=>expect(broker.snapshot().processes).toBe(0));
    }finally{await client.close().catch(()=>undefined);await broker.close();vi.useRealTimers();}
  });

});
