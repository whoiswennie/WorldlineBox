import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

afterEach(() => { vi.useRealTimers(); });
it('leaves extraction jobs unclaimed while the physical world is catching up and retries automatically', async () => {
  vi.useFakeTimers();
  let backlog = true;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'world.clock') return { ok: true, worldClock: { realNow: new Date().toISOString(), virtualNow: new Date().toISOString(), timeZone: 'UTC', mode: 'realtime', speed: 1, backlog } };
    if (command.type === 'memory.jobs.backfill') return { ok: true, backfillComplete: true };
    if (command.type === 'state') return { ok: true };
    throw new Error('Unexpected request: ' + command.type);
  });
  const service = new CompanionMemoryService({ request, configFor: vi.fn(), fetchFn: vi.fn(), changed: vi.fn(), report: vi.fn(), busy: () => false });
  service.schedule(0); await vi.advanceTimersByTimeAsync(10);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['world.clock']);
  backlog = false; await vi.advanceTimersByTimeAsync(2000);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['world.clock', 'world.clock', 'memory.jobs.backfill', 'state']);
  await service.close();
});
