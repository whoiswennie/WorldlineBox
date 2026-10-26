import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

afterEach(() => { vi.useRealTimers(); });
it('checks current memory owners during physical-world catchup without replaying historical messages', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'world.clock') return { ok: true, worldClock: { realNow: new Date().toISOString(), virtualNow: new Date().toISOString(), timeZone: 'UTC', mode: 'realtime', speed: 1, backlog: true } };
    if (command.type === 'state') return { ok: true };
    throw new Error('Unexpected request: ' + command.type);
  });
  const service = new CompanionMemoryService({ request, configFor: vi.fn(), fetchFn: vi.fn(), changed: vi.fn(), report: vi.fn(), busy: () => false });
  service.schedule(0); await vi.advanceTimersByTimeAsync(10);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['state']);
  service.schedule(0); await vi.advanceTimersByTimeAsync(10);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['state', 'state']);
  await service.close();
});
