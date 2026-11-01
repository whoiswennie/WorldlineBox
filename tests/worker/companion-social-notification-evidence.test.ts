import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSocialNotificationReceiptFixture } from '../fixtures/social-notification-receipts';
import { admitCompanionSocialNotificationEvidence, readCompanionSocialNotificationEvidence } from '../../src/main/companions/social-notification-evidence';
import { reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-23T10:00:00Z')); });
afterEach(() => vi.useRealTimers());
const config = { apiFormat: 'openai_chat' as const, model: 'fixture-review', apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid' };
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

function reader(f: ReturnType<typeof createSocialNotificationReceiptFixture>, messages = [f.report]) {
  const commands: CompanionStorageCommand[] = [];
  const raw = async (command: CompanionStorageCommand) => { commands.push(command); return f.store.request(command); };
  const request = async (command: CompanionStorageCommand) => guardCompanionExecutionSources(command, await raw(command), {
    identity: f.store, revision: () => 0, storage: raw, valid: (proof, sqliteSourcesValidated) =>
      verifyCompanionExecutionReadset(proof.executionReadset, proof, { request: raw, sqliteSourcesValidated }) });
  return { commands, input: { companionId: 'alice', conversationId: f.room.id,
    serializedContext: JSON.stringify({ messages: messages.map(message => ({ id: message.id, revision: message.revision,
      authorId: message.authorId, conversationId: message.conversationId, content: message.content, realCreatedAt: message.createdAt })) }),
    identity: f.store, request, requestFresh: raw } };
}

it('gives the reviewer only its already read same-room host report backed by the real prior phone replies', async () => {
  const f = createSocialNotificationReceiptFixture(advance);
  try {
    f.certifyReport(); const r = reader(f);
    await withCompanionExecutionValidation(async () => {
      const evidence = await readCompanionSocialNotificationEvidence(r.input); expect(evidence).toBeDefined();
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
        expect(data.facts).toEqual([]); expect(data.verifiedReceivedNotifications).toHaveLength(1);
        expect(data.verifiedReceivedNotifications[0].report.content).toBe(f.report.content);
        expect(data.verifiedReceivedNotifications[0].receipt.peerReplies.map((value: { messageId: string }) => value.messageId).sort())
          .toEqual(f.peerReplies.map(message => message.id).sort());
        for (const peer of f.peerReplies) expect(JSON.stringify(data)).not.toContain(peer.content);
        expect(wire.messages[0].content).toContain('不能据此否定这些已经发生且已正式通知的历史来信');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ supported: true, correction: '' }) } }] }));
      });
      expect(await reviewCompanionSocialProgress('伙伴此前回我了。', [], config, undefined,
        { requireReview: true, receivedNotifications: evidence, fetchFn })).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledOnce();
    });
    expect(r.commands.filter(command => command.type === 'social.notifications.receipts')).toHaveLength(2);
  } finally { f.close(); }
});

it.each(['uncertified', 'ordinary-report', 'not-read'] as const)('does not upgrade %s text to a host received-reply fact', async state => {
  const f = createSocialNotificationReceiptFixture(advance);
  try {
    if (state !== 'uncertified') f.certifyReport();
    const messages = state === 'ordinary-report' ? [f.store.appendMessage({ conversationId: f.room.id, authorId: 'alice', content: f.report.content })]
      : state === 'not-read' ? [] : [f.report];
    const r = reader(f, messages);
    expect(await readCompanionSocialNotificationEvidence(r.input)).toBeUndefined();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      supported: false, correction: '没有本次已读的真实来信通知。', violation: { kind: 'social_effect', quote: '我已联系并收到答复。' } }) } }] })));
    expect(await reviewCompanionSocialProgress('我已联系并收到答复。', [], config, undefined, { requireReview: true, fetchFn })).toContain('真实来信');
    expect(fetchFn).toHaveBeenCalledOnce();
  } finally { f.close(); }
});

it('rejects changed context prose and a lookalike token instead of granting a new room read', async () => {
  const f = createSocialNotificationReceiptFixture(advance);
  try {
    f.certifyReport(); const r = reader(f, [{ ...f.report, content: '另一份没有实际读过的通知正文。' }]);
    await expect(readCompanionSocialNotificationEvidence(r.input)).rejects.toThrow();
    await expect(admitCompanionSocialNotificationEvidence({ notifications: [] })).rejects.toThrow();
  } finally { f.close(); }
});

it.each(['relation', 'forget', 'cancelled'] as const)('rejects a late %s before the enclosing read frame can finish', async change => {
  const f = createSocialNotificationReceiptFixture(advance), controller = new AbortController();
  try {
    f.certifyReport(); const r = reader(f); let consumed = false;
    const pending = withCompanionExecutionValidation(async () => {
      expect(await readCompanionSocialNotificationEvidence(r.input)).toBeDefined(); consumed = true;
      if (change === 'relation') f.db.prepare("UPDATE companion_social_notifications SET data=json_set(data,'$.evidence.authorId','carol') WHERE id=?").run(f.notice.id);
      else if (change === 'forget') f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.peerRoom.id,
        sourceMessageIds: [f.peerReplies[0]!.id], persistent: true });
      else controller.abort(new DOMException('Cancelled after actual receipt read.', 'AbortError'));
    }, controller.signal);
    await expect(pending).rejects.toThrow(); expect(consumed).toBe(true);
  } finally { f.close(); }
});

it('carries only an opaque exact observation into a separate publication frame with a new fresh final check', async () => {
  const f = createSocialNotificationReceiptFixture(advance);
  try {
    f.certifyReport(); const r = reader(f), evidence = await readCompanionSocialNotificationEvidence(r.input);
    expect(evidence).toBeDefined();
    await withCompanionExecutionValidation(() => admitCompanionSocialNotificationEvidence(evidence!));
    f.db.prepare("UPDATE companion_social_notifications SET data=json_set(data,'$.resultMessageId','different_result') WHERE id=?").run(f.notice.id);
    let completed = false;
    await expect(withCompanionExecutionValidation(() => admitCompanionSocialNotificationEvidence(evidence!)).then(() => { completed = true; })).rejects.toThrow();
    expect(completed).toBe(false);
  } finally { f.close(); }
});
