import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

export interface FullRespondCompletionTask {
  sourceMessageId: string; companionId: string; label: string; kind: 'reply' | 'social'; socialJobId?: string;
}
export interface FullRespondCompletion {
  label: string; status: 'completed' | 'completed_silent'; completedAtMs: number; sha256: string; bytes: number;
}
/** Read only real durable host outcomes. Provider prose is hashed in memory;
 * neither a response stub nor a fabricated completed status is accepted. */
export async function waitForFullRespondCompletions(options: {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  tasks: readonly FullRespondCompletionTask[]; nowMs(): number; timeoutMs?: number;
}): Promise<FullRespondCompletion[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 180000), completed = new Map<string, FullRespondCompletion>();
  const read = async (command: CompanionStorageCommand) => { const response = await options.request(command);
    if (!response.ok) throw new Error('A real completion receipt could not be read.'); return response; };
  while (Date.now() < deadline) {
    for (const task of options.tasks) {
      if (completed.has(task.sourceMessageId)) continue;
      let messageId: string | undefined, conversationId: string;
      if (task.kind === 'social') {
        if (!task.socialJobId) throw new Error('An actual incoming social task was not bound to its source.');
        const job = (await read({ type: 'social.job.read', companionId: task.companionId, id: task.socialJobId })).socialJob;
        if (!job || job.sourceMessageId !== task.sourceMessageId || job.companionId !== task.companionId) throw new Error('A social completion receipt changed its actual scope.');
        if (job.stop || ['failed', 'cancelled', 'parked', 'abandoned', 'stale'].includes(job.status)) throw new Error('An actual social task did not complete: ' + task.label + '/' + job.status);
        if (job.status !== 'done') continue;
        const entry = (await read({ type: 'social.reply.progress', conversationId: job.conversationId,
          companionId: task.companionId, limit: 50 })).socialReplyProgress?.find(value => value.jobId === task.socialJobId);
        if (!entry || entry.sourceMessageId !== task.sourceMessageId || entry.companionId !== task.companionId
          || entry.conversationId !== job.conversationId || entry.status !== 'done' || entry.progress.phase !== 'completed')
          throw new Error('The completed social job has no matching durable public completion receipt.');
        messageId = entry.messageId; conversationId = entry.conversationId;
      } else {
        const works = (await read({ type: 'work.list', sourceMessageId: task.sourceMessageId })).works ?? [];
        const work = works.find(work => work.companionId === task.companionId);
        if (!work) continue;
        const loop = (await read({ type: 'loop.get', sourceMessageId: task.sourceMessageId, companionId: task.companionId })).loop;
        if (['cancelled', 'interrupted'].includes(work.status) || loop?.progress && ['failed', 'cancelled', 'interrupted'].includes(loop.progress.phase))
          throw new Error('An actual reply did not complete: ' + task.label + '/' + work.status);
        if (work.status !== 'done' || loop?.status !== 'done') continue;
        if (work.sourceMessageId !== task.sourceMessageId || loop.sourceMessageId !== task.sourceMessageId
          || loop.companionId !== task.companionId || loop.conversationId !== work.conversationId)
          throw new Error('A reply completion receipt changed its actual scope.');
        messageId = loop.messageId; conversationId = work.conversationId;
      }
      const message = messageId ? (await read({ type: 'message.get', id: messageId })).message : undefined;
      if (messageId && (!message || message.authorId !== task.companionId || message.status !== 'sent'
        || message.conversationId !== conversationId || message.replyToId !== task.sourceMessageId))
        throw new Error('A completed task has no matching formal reply.');
      const text = message?.content ?? '';
      completed.set(task.sourceMessageId, { label: task.label, status: text ? 'completed' : 'completed_silent', completedAtMs: options.nowMs(),
        sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
    }
    if (completed.size === options.tasks.length) return options.tasks.map(task => completed.get(task.sourceMessageId)!);
    await delay(100);
  }
  throw new Error('The actual provider tasks did not all reach a durable completed state before the deadline.');
}
