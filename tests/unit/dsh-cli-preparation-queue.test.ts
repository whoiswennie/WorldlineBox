import { expect, it, vi } from 'vitest';
import { InstanceService } from '../../src/main/dsh/instance-service';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';
it('serializes short profile preparation while allowing independent callers and cancellation to preserve the queue', async () => {
  const service = new InstanceService({} as never);
  let release!: () => void;
  const first = new Promise<DshCliSelection>(resolve => { release = () => resolve({} as DshCliSelection); });
  const native = vi.spyOn(service as unknown as { prepareCliNow(id: string, signal?: AbortSignal): Promise<DshCliSelection> }, 'prepareCliNow')
    .mockImplementationOnce(() => first).mockResolvedValue({} as DshCliSelection);
  const running = service.prepareCli('instance-a');
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1));
  const abort = new AbortController();
  const cancelled = service.prepareCli('instance-a', abort.signal); void cancelled.catch(() => undefined);
  const next = service.prepareCli('instance-a');
  abort.abort(new Error('cancel queued input'));
  await expect(cancelled).rejects.toThrow('cancel queued input');
  expect(native).toHaveBeenCalledTimes(1);
  release(); await running; await next;
  expect(native).toHaveBeenCalledTimes(2);
});
