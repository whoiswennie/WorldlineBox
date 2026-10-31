import { expect, it, vi } from 'vitest';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSocialJobSchema } from '../../src/shared/companion-social';

it('publishes body-work reservation changes as progress and keeps delivered peer messages as content changes', async () => {
  const changed = vi.fn(), requests: string[] = [];
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    requests.push(command.type);
    if (command.type === 'world.work.begin') return { ok: true, worldWork: { workId: command.workId, companionId: command.companionId, kind: command.kind, status: 'ready' } };
    if (command.type === 'social.job.claim') return { ok: true, socialMessage: { message: { id: 'real-delivered-peer-message' } } } as CompanionStorageResponse;
    return { ok: true };
  };
  const service = new CompanionWorldService({ request, changed, wakeWaiting: vi.fn(), report: vi.fn(),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'test', apiKey: 'test' }), fetchFn: vi.fn() });
  try {
    await service.ready({ companionId: 'owner', conversationId: 'private', workId: 'work', kind: 'chat', sourceMessageId: 'source' });
    await service.end('owner', 'work');
    expect(changed.mock.calls).toEqual([['progress'], ['progress']]);
    expect(requests).toEqual(['world.work.begin', 'world.work.end']);
    changed.mockClear();
    await service.tick();
    expect(changed.mock.calls).toEqual([[]]);
    expect(requests).toContain('social.job.claim');
  } finally { await service.close(); }
});

it('publishes peer preparation milestones through the lightweight progress channel', async () => {
  const changed = vi.fn(), requests: string[] = [];
  let releaseState!: () => void;
  const stateGate = new Promise<void>(resolve => { releaseState = resolve; });
  const now = new Date().toISOString();
  const job = companionSocialJobSchema.parse({ id: 'peer-job', companionId: 'owner', conversationId: 'peer-room',
    sourceMessageId: 'peer-message', throughSequence: 1, chainId: 'peer-chain', remainingTurns: 0,
    memberIds: ['owner', 'peer'], channel: 'phone', status: 'running', attempts: 1,
    leaseToken: 'peer-lease', typingNotBefore: now, createdAt: now });
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    requests.push(command.type);
    if (command.type === 'social.job.claim') return { ok: true, socialJob: job };
    if (command.type === 'state') await stateGate;
    return { ok: true };
  };
  const service = new CompanionWorldService({ request, changed, wakeWaiting: vi.fn(), report: vi.fn(),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'test', apiKey: 'test' }), fetchFn: vi.fn() });
  try {
    await service.tick();
    expect(requests).toContain('social.job.progress');
    // The actual peer input is still being checked. A status milestone must
    // not reload every historical message/action in the renderer.
    expect(changed.mock.calls).toEqual([['progress']]);
  } finally { releaseState(); await service.close(); }
});
