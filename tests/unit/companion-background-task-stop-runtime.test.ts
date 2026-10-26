import { expect, it, vi } from 'vitest';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionWorldJob } from '../../src/shared/companion-world';
import type { CompanionSocialJob } from '../../src/shared/companion-social';

it.each(['world', 'social', 'social_notification'] as const)('aborts only the selected %s job and never records the late user-stop exception as task failure', async kind => {
  let reject!: (error: Error) => void;
  const waiting = new Promise<CompanionStorageResponse>((_resolve, fail) => { reject = fail; });
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => waiting);
  const report = vi.fn(), service = new CompanionWorldService({ request, report, changed: () => undefined, wakeWaiting: () => undefined,
    configFor: async () => { throw Error('A manually stopped preparation cannot reach the model'); },
    fetchFn: async () => { throw Error('No provider request is allowed'); } });
  const selected = new AbortController(), other = new AbortController();
  const job = { id: 'selected_job', companionId: 'alice', conversationId: 'private_alice', kind: 'decision', status: 'running', leaseToken: 'old_lease' };
  const port = service as unknown as { jobs: Map<string, { controller: AbortController; promise: Promise<void>; companionId: string; kind: 'other' }>;
    process(job: CompanionWorldJob, signal: AbortSignal): Promise<void>; processSocial(job: CompanionSocialJob, signal: AbortSignal): Promise<void>;
    processNotification(job: unknown, signal: AbortSignal): Promise<void> };
  const running = kind === 'world' ? port.process(job as CompanionWorldJob, selected.signal) : kind === 'social' ? port.processSocial(job as unknown as CompanionSocialJob, selected.signal) : port.processNotification(job, selected.signal);
  port.jobs.set(job.id, { controller: selected, promise: running, companionId: 'alice', kind: 'other' });
  port.jobs.set('unrelated_job', { controller: other, promise: Promise.resolve(), companionId: 'bob', kind: 'other' });
  service.cancelTask(job.id);
  expect(selected.signal.reason).toMatchObject({ code: 'USER_STOP' }); expect(other.signal.aborted).toBe(false);
  reject(Error('The old in-flight read rejected after user cancellation'));
  await running;
  expect(request.mock.calls.some(([command]) => command.type === 'world.job.fail' || command.type === 'social.job.fail' || command.type === 'social.notification.fail')).toBe(false);
  expect(report).not.toHaveBeenCalled();
  await service.close();
});
