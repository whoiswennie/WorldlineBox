import { EventEmitter } from 'node:events';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ColdKnowledgeClient } from '../../src/main/vcp-memory/cold-client';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const embedding = { baseUrl: 'http://127.0.0.1', model: 'fixture', apiKey: 'synthetic', dimension: 4 };

it('shares actual slots across hot and cold children, preserves active cold work and reopens an idle retired cold client', async () => {
  const broker = new VcpMemoryProcessBroker(2), live = new Set<EventEmitter>(); let peak = 0, coldLaunches = 0;
  let blockCold = false, finishCold!: () => void;
  const launch = (file: string): VcpMemoryTransport => {
    const events = new EventEmitter(); live.add(events); peak = Math.max(peak, live.size); if (file === 'cold') coldLaunches++;
    let exited = false;
    const exit = () => { if (!exited) { exited = true; live.delete(events); events.emit('exit', 0); } };
    return { on: events.on.bind(events), kill: exit, postMessage: (value: unknown) => {
      const { requestId, command } = value as { requestId: string; command: { type: string; configuration?: object } };
      if (command.type === 'initialize' && file === 'cold') expect(command.configuration).not.toHaveProperty('processBroker');
      const reply = () => events.emit('message', { requestId, ok: true, value: command.type === 'close' ? { closed: true } : { ready: true } });
      if (file === 'cold' && command.type === 'barrier' && blockCold) finishCold = reply;
      else { reply(); if (command.type === 'close') exit(); }
    } };
  };
  const cold = new ColdKnowledgeClient({ dataRoot: path.resolve('unused-cold-budget'), vendorRoot: 'unused', workerPath: 'cold', embedding, processBroker: broker, launch });
  const hot = new VcpMemoryClient({ dataRoot: path.resolve('unused-hot-budget'), vendorRoot: 'unused', workerPath: 'hot', embedding, processBroker: broker, launch });
  try {
    await cold.request({ type: 'barrier' }); await hot.list({ scopeId: 'first' });
    blockCold = true; const active = cold.request({ type: 'barrier' });
    await vi.waitFor(() => expect(finishCold).toBeDefined());
    await hot.list({ scopeId: 'second' }); expect(coldLaunches).toBe(1); expect(broker.snapshot().active).toBe(1);
    blockCold = false; finishCold(); await active;
    await new Promise(resolve => setTimeout(resolve, 2)); await hot.list({ scopeId: 'third' });
    await hot.list({ scopeId: 'fourth' });
    await cold.request({ type: 'barrier' });
    expect(coldLaunches).toBe(2); expect(peak).toBeLessThanOrEqual(2); expect(broker.snapshot().processes).toBe(2);
  } finally { blockCold = false; finishCold?.(); await cold.close(); await hot.close(); await broker.close(); expect(live.size).toBe(0); }
});

it('holds a cold permit through a shutdown timeout until actual exit and dependency cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const broker = new VcpMemoryProcessBroker(1), events = new EventEmitter();
  const cold = new ColdKnowledgeClient({ dataRoot: path.resolve('unused-cold-late-exit'), vendorRoot: 'unused', workerPath: 'cold', embedding, processBroker: broker,
    launch: () => ({ on: events.on.bind(events), kill: () => undefined, postMessage: (value: unknown) => {
      const { requestId } = value as { requestId: string }; events.emit('message', { requestId, ok: true, value: { ready: true } });
    } }) });
  try {
    await cold.request({ type: 'barrier' }); const closing = cold.close(), rejected = expect(closing).rejects.toMatchObject({ code: 'VCP_MEMORY_SHUTDOWN_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5001); await rejected;
    expect(broker.snapshot().processes).toBe(1);
    events.emit('exit', 0); await vi.waitFor(() => expect(broker.snapshot().processes).toBe(0));
  } finally { events.emit('exit', 0); await cold.close().catch(() => undefined); await broker.close(); vi.useRealTimers(); }
});

it('rejects native overload before admitting another operation without interrupting an active body', async () => {
  const broker = new VcpMemoryProcessBroker(1, 2); let identity!: symbol, finish!: () => void;
  const first = await broker.acquire('active', { deadline: Date.now() + 5000, assertCurrent() {}, open(value) {
    identity = value; return { stop: async () => broker.retired('active', value) };
  } });
  const next = broker.acquire('waiting', { deadline: Date.now() + 5000, assertCurrent() {}, open(value) {
    return { stop: async () => broker.retired('waiting', value) };
  } });
  try {
    await expect(broker.acquire('overload', { deadline: Date.now() + 5000, assertCurrent() {}, open: vi.fn() })).rejects.toMatchObject({ code: 'VCP_MEMORY_NATIVE_CAPACITY' });
    expect(broker.snapshot()).toMatchObject({ active: 1, processes: 1, outstanding: 2, waiting: 1 });
    finish = () => { first.release(); broker.retired('active', identity); }; finish();
    const resumed = await next; resumed.release();
    expect(broker.snapshot().outstanding).toBe(0);
  } finally { finish?.(); await broker.close(); }
});
