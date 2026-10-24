import { describe, expect, it, vi } from 'vitest';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
const deadline = () => Date.now() + 2_000;
describe('shared VCP process permits', () => {
  it('holds a retiring permit until its exact child exits and ignores its late duplicate retirement', async () => {
    const broker = new VcpMemoryProcessBroker(1); let first!: symbol, second!: symbol, exit!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { exit = () => { broker.retired('scope', first); resolve(); }; }));
    const one = await broker.acquire('scope', { deadline: deadline(), assertCurrent() {}, open(identity) { first = identity; return { stop }; } });
    one.release(); broker.beginRetirement('scope', first);
    const open = vi.fn((identity: symbol) => { second = identity; return { stop: async () => broker.retired('scope', identity) }; });
    const next = broker.acquire('scope', { deadline: deadline(), assertCurrent() {}, open });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(open).not.toHaveBeenCalled();
    // The external close owns the same child stop; broker does not issue a
    // second shutdown just because it sees that retiring reservation.
    const stopping = stop(); exit(); await stopping; const two = await next;
    broker.retired('scope', first); expect(broker.snapshot().processes).toBe(1); expect(second).not.toBe(first);
    two.release(); broker.retired('scope', second); await broker.close();
  });
  it('evicts only idle children, awaits actual exit, and admits no cancelled waiter', async () => {
    const broker = new VcpMemoryProcessBroker(1); let identity!: symbol, finish!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = () => { broker.retired('one', identity); resolve(); }; }));
    const first = await broker.acquire('one', { deadline: deadline(), assertCurrent() {}, open(id) { identity = id; return { stop }; } });
    let cancelled = false; const open = vi.fn();
    const waiting = broker.acquire('two', { deadline: deadline(), assertCurrent() { if (cancelled) throw new Error('cancelled'); }, open });
    const rejected = expect(waiting).rejects.toThrow('cancelled');
    await new Promise(resolve => setTimeout(resolve, 25)); expect(stop).not.toHaveBeenCalled();
    first.release(); await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(broker.snapshot().processes).toBe(1); expect(open).not.toHaveBeenCalled();
    cancelled = true; finish(); await rejected; expect(open).not.toHaveBeenCalled(); await broker.close();
  });
  it('uses the original absolute deadline across admission queues and closes pending admission', async () => {
    const broker = new VcpMemoryProcessBroker(1); let id!: symbol;
    const lease = await broker.acquire('busy', { deadline: deadline(), assertCurrent() {}, open(identity) { id = identity; return { stop: async () => broker.retired('busy', id) }; } });
    const open = vi.fn(); const waiting = broker.acquire('late', { deadline: Date.now() + 25, assertCurrent() {}, open });
    await expect(waiting).rejects.toThrow('busy'); expect(open).not.toHaveBeenCalled();
    const closed = broker.acquire('closed', { deadline: deadline(), assertCurrent() {}, open });
    const rejected = expect(closed).rejects.toThrow('closed'); await broker.close(); await rejected;
    lease.release(); broker.retired('busy', id);
  });
});
