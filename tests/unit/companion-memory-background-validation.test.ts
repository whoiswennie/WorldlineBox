import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

it('runs a scheduled durable memory quantum independently of the cancelled foreground that woke it', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(), report = vi.fn(), processed = vi.fn(async () => withCompanionExecutionValidation(async () => true));
  const service = Object.assign(Object.create(CompanionMemoryService.prototype), { options: { changed: () => undefined, report }, closed: false,
    process: processed }) as { schedule(delay: number): void; closed: boolean };
  try {
    await withCompanionExecutionValidation(async () => { service.schedule(0); }, controller.signal);
    controller.abort(new Error('reply_cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    expect(processed).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled();
  } finally { service.closed = true; vi.clearAllTimers(); vi.useRealTimers(); }
});

it('registers an independently owned index delivery after its foreground requester was cancelled', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const claims = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController(), report = vi.fn();
  const request = vi.fn(async () => withCompanionExecutionValidation(async () => ({ ok: true,
    memoryOutbox: { id: 'durable_outbox', companionId: 'alice', leaseToken: 'actual_lease' } })));
  const delivered = vi.fn(async () => withCompanionExecutionValidation(async () => undefined));
  const service = Object.assign(Object.create(CompanionMemoryService.prototype), { options: { runtime: {}, request, changed: () => undefined, report },
    closed: false, deliveryClaims: claims, deliveries: new Map(), deliverOne: delivered }) as {
      admitDelivery(): Promise<{ owner: string; job: Promise<void> } | undefined>; closed: boolean };
  let admission!: ReturnType<typeof service.admitDelivery>;
  try {
    await withCompanionExecutionValidation(async () => { admission = service.admitDelivery(); }, controller.signal);
    controller.abort(new Error('reply_cancelled')); release();
    const registered = await admission;
    expect(registered?.owner).toBe('alice'); await registered?.job;
    expect(request).toHaveBeenCalledOnce(); expect(delivered).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled();
  } finally { service.closed = true; vi.clearAllTimers(); vi.useRealTimers(); }
});
