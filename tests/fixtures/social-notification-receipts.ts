import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

/** Actual isolated SQL phone/delegation/notification publication. The caller
 * supplies its controlled Date advancement; this fixture never calls an LLM. */
export function createSocialNotificationReceiptFixture(advanceTime: (ms: number) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'wlbox-social-notice-receipts-')), filename = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(filename, ['alice', 'bob', 'carol'].map(id => ({ id, name: id, description: '', persona: '独立真实来源。',
    model: '', avatar: 'flash' as const, active: true, proactive: false })));
  const fixture = publishSocialNotificationReceipt({ store, filename, advanceTime, companionId: 'alice', peerId: 'bob' });
  return { root, filename, ...fixture, close: () => { fixture.db.close(); store.close();
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlbox-social-notice-receipts-')) throw new Error('Unsafe fixture cleanup');
    removeOwnedDirectorySync(root); } };
}

/** Populate the same actual host chain in an already constructed Service fixture. */
export function publishSocialNotificationReceipt(input: { store: CompanionsStore; filename: string; advanceTime(ms: number): void;
  companionId: string; peerId: string; wakeAt?: string; configureRoutine?: boolean }) {
  const { store, filename, advanceTime, companionId: owner, peerId } = input;
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of input.configureRoutine === false ? [] : store.state().companions.map(role => role.id)) {
    const scope = { companionId, conversationId: store.openPrivate(companionId).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: input.wakeAt ?? '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  const advance = (ms = 1300) => { advanceTime(ms); store.request({ type: 'world.tick' }); };
  advance(10000);
  const room = store.openPrivate(owner), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请联系伙伴，听听今天的情况。', replyDirective: 'none' });
  const peerRoom = store.request({ type: 'social.conversation.ensure', companionId: owner, memberIds: [owner, peerId] }).socialConversation!;
  store.request({ type: 'social.send', companionId: owner, conversationId: peerRoom.id, channel: 'phone', content: '今天过得怎么样？',
    authorizationMessageId: source.id, clientId: 'fixture_actual_phone' });
  advance();
  const first = store.request({ type: 'social.job.claim' }).socialJob!;
  if (!first?.leaseToken || first.companionId !== peerId) throw new Error('Actual peer phone job did not become ready.');
  advance(); const peerOne = store.request({ type: 'social.job.complete', id: first.id, leaseToken: first.leaseToken, text: '今天晴天，我收拾了屋子。' }).socialMessage!.message;
  advance(); const followup = store.request({ type: 'social.job.claim' }).socialJob!;
  if (!followup?.leaseToken || followup.companionId !== owner) throw new Error('Actual phone continuation did not become ready.');
  advance(); store.request({ type: 'social.job.complete', id: followup.id, leaseToken: followup.leaseToken, text: '谢谢，还有其他计划吗？' });
  advance(); const last = store.request({ type: 'social.job.claim' }).socialJob!;
  if (!last?.leaseToken || last.companionId !== peerId) throw new Error('Second actual peer reply did not become ready.');
  advance(); const peerTwo = store.request({ type: 'social.job.complete', id: last.id, leaseToken: last.leaseToken, text: '下午留一点安静听歌的时间。' }).socialMessage!.message;
  // A pair has three reply opportunities. The second peer reply consumes the
  // final one; a fourth settlement job would exceed the real chain budget.
  advance(); const finish = store.request({ type: 'social.job.claim' }).socialJob;
  if (finish) throw new Error('The actual bounded phone chain unexpectedly admitted a fourth reply.');
  advance(); const notice = store.request({ type: 'social.notification.claim' }).socialNotification!;
  if (!notice?.leaseToken) throw new Error('Actual combined notification did not become ready.');
  const report = store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken,
    text: '伙伴已经回信：今天晴天，收拾了屋子，下午想安静听歌。' }).message!;
  const db = new (Database as { new(filename: string): CompanionConnection })(filename);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const certifyReport = () => {
    const proofs = store.request({ type: 'execution.sources', sourceMessageIds: [report.id] }).executionSources!;
    const candidate = proofs.find(value => value.id === report.id)?.publicationCandidate;
    if (!candidate) throw new Error('Actual completed notification was not eligible for the full SQL publication gate.');
    return store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }],
      actionBindings: proofs.flatMap(value => value.storageActionBinding ? [value.storageActionBinding] : []) }).messagePublicationCertificates![0]!;
  };
  const lookup = () => store.request({ type: 'social.notifications.receipts', companionId: owner, conversationId: room.id, messageIds: [report.id] });
  return { store, db, room, source, peerRoom, peerReplies: [peerOne, peerTwo], notice, report, advance, certifyReport, lookup };
}
