import { describe, expect, it } from 'vitest';
import { waitForFullRespondCompletions } from '../fixtures/companion-full-respond-online-completion';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const task = { sourceMessageId: 'source', companionId: 'owner', label: 'peer', kind: 'social' as const, socialJobId: 'job' };
const completed = { jobId: 'job', companionId: 'owner', conversationId: 'room', sourceMessageId: 'source', messageId: 'reply',
  status: 'done', progress: { phase: 'completed' } };
function port(entry: unknown = completed, replyToId = 'source') {
  return async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    // Only consumed fields are projected here; no provider response is mocked.
    if (command.type === 'social.job.read') return { ok: true, socialJob: { id: 'job', companionId: 'owner', conversationId: 'room', sourceMessageId: 'source', status: 'done' } } as CompanionStorageResponse;
    if (command.type === 'social.reply.progress') return { ok: true, socialReplyProgress: entry ? [entry] : [] } as CompanionStorageResponse;
    if (command.type === 'message.get') return { ok: true, message: { id: 'reply', authorId: 'owner', conversationId: 'room', replyToId, status: 'sent', content: 'A real published message.' } } as CompanionStorageResponse;
    throw new Error('Unexpected completion read.');
  };
}
describe('real-provider benchmark completion evidence', () => {
  it('reads the public social completion receipt and hashes its exact formal reply', async () => {
    const result = await waitForFullRespondCompletions({ request: port(), tasks: [task], nowMs: () => 123 });
    expect(result).toEqual([{ label: 'peer', status: 'completed', completedAtMs: 123,
      sha256: 'fb9b1b313f498c185cdb31b1f3d2132f0116b4caf568ac65e17347dcefa60f9d', bytes: 25 }]);
  });
  it('never interprets a private result field omitted from public job.read as silent completion', async () => {
    await expect(waitForFullRespondCompletions({ request: port(null), tasks: [task], nowMs: () => 0 })).rejects.toThrow('matching durable public completion receipt');
  });
  it('rejects a formal peer reply attached to another actual incoming message', async () => {
    await expect(waitForFullRespondCompletions({ request: port(completed, 'different_source'), tasks: [task], nowMs: () => 0 })).rejects.toThrow('matching formal reply');
  });
  it('accepts silent completion only from an exact completed public receipt', async () => {
    const result = await waitForFullRespondCompletions({ request: port({ ...completed, messageId: undefined }), tasks: [task], nowMs: () => 123 });
    expect(result[0]).toMatchObject({ status: 'completed_silent', bytes: 0 });
  });
});
