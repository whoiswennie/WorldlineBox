import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createSocialNotificationReceiptFixture } from '../fixtures/social-notification-receipts';

const fixtures: ReturnType<typeof createSocialNotificationReceiptFixture>[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.useRealTimers(); });
function fixture() {
  const f = createSocialNotificationReceiptFixture(ms => vi.setSystemTime(Date.now() + ms)); fixtures.push(f); return f;
}

it('projects only an actual certified same-room notification and its complete two-event phone receipt without peer prose', () => {
  const f = fixture();
  expect(f.lookup().socialNotificationReceipts).toEqual([]);
  f.certifyReport(); const result = f.lookup().socialNotificationReceipts!;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ messageId: f.report.id, companionId: 'alice', conversationId: f.room.id,
    revision: f.report.revision, checksum: hash(f.report.content), kind: 'peer_reply' });
  expect(result[0]!.notificationIds).toHaveLength(2);
  expect(result[0]!.peerReplies.map(value => value.messageId).sort()).toEqual(f.peerReplies.map(value => value.id).sort());
  expect(result[0]!.peerReplies.every(value => value.authorId === 'bob' && value.conversationId === f.peerRoom.id)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.report.content);
  for (const peer of f.peerReplies) expect(JSON.stringify(result)).not.toContain(peer.content);
  expect(f.lookup().socialNotificationReceipts).toEqual(result);
  const plans = f.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM companion_social_notifications WHERE companion_id=? AND status='done'
    AND CASE WHEN json_valid(data) THEN json_extract(data,'$.conversationId') END=?
    AND CASE WHEN json_valid(data) THEN json_extract(data,'$.resultMessageId') END IN(SELECT value FROM json_each(?))`)
    .all('alice', f.room.id, JSON.stringify([f.report.id])) as { detail: string }[];
  expect(plans.some(value => value.detail.includes('companion_social_notification_report'))).toBe(true);
});

it('does not recognize ordinary self prose as a host receipt or mutate stale scheduling records on lookup', () => {
  const f = fixture(); f.certifyReport();
  const ordinary = f.store.appendMessage({ authorId: 'alice', conversationId: f.room.id, content: '我自己声称已经收到回信。', replyToId: f.source.id });
  // appendMessage is intentionally outside request's common Experience tail.
  // Drain that existing projection/archive before measuring this pure port.
  f.store.request({ type: 'state', includeConversations: false });
  const before = f.db.prepare('SELECT id,status,data FROM companion_social_notifications ORDER BY id').all();
  const version = f.db.prepare('PRAGMA data_version').get();
  const result = f.store.request({ type: 'social.notifications.receipts', companionId: 'alice', conversationId: f.room.id, messageIds: [ordinary.id, f.report.id] });
  expect(result.socialNotificationReceipts?.map(value => value.messageId)).toEqual([f.report.id]);
  expect(f.db.prepare('SELECT id,status,data FROM companion_social_notifications ORDER BY id').all()).toEqual(before);
  expect(f.db.prepare('PRAGMA data_version').get()).toEqual(version);
  f.db.prepare('UPDATE companion_social_delegations SET status=?').run('cancelled');
  const cancelled = f.db.prepare('SELECT id,status,data FROM companion_social_notifications ORDER BY id').all();
  expect(f.lookup().socialNotificationReceipts).toEqual([]);
  expect(f.db.prepare('SELECT id,status,data FROM companion_social_notifications ORDER BY id').all()).toEqual(cancelled);
});

it.each(['report_body', 'source_body', 'peer_body', 'forgotten', 'peer_membership', 'peer_observer', 'certificate', 'binding'] as const)(
  'refuses a current %s drift before returning historical notification authority', change => {
    const f = fixture(); f.certifyReport(); expect(f.lookup().socialNotificationReceipts).toHaveLength(1);
    if (change === 'forgotten') f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [f.peerReplies[0]!.id] });
    else if (change === 'certificate') f.db.prepare('DELETE FROM companion_message_publication_certificates WHERE message_id=?').run(f.report.id);
    else if (change === 'binding') f.db.prepare("UPDATE companion_social_notifications SET data=json_set(data,'$.sourceChecksum',?) WHERE json_extract(data,'$.resultMessageId')=?")
      .run('0'.repeat(64), f.report.id);
    else if (change === 'peer_membership') f.db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(f.peerRoom.id, 'alice');
    else if (change === 'peer_observer') f.db.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(f.peerReplies[0]!.id, 'alice');
    else f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('外部改写后不再是那份准确来源。',
      change === 'report_body' ? f.report.id : change === 'source_body' ? f.source.id : f.peerReplies[0]!.id);
    expect(f.lookup().socialNotificationReceipts).toEqual([]);
  });

it('keeps a report with more than sixteen related notifications unsupported instead of certifying a truncated subset', () => {
  const f = fixture(); f.certifyReport();
  const original = f.db.prepare('SELECT * FROM companion_social_notifications LIMIT 1').get() as Record<string, string | number | null>;
  for (let index = 0; index < 15; index++) {
    const id = 'fixture_extra_notice_' + index, data = { ...JSON.parse(String(original.data)), id };
    f.db.prepare('INSERT INTO companion_social_notifications(id,companion_id,origin_id,event_key,status,lease_until,attempts,created_at,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, original.companion_id, original.origin_id, 'fixture-extra-event-' + index, 'done', null, original.attempts, original.created_at, JSON.stringify(data));
  }
  expect(f.lookup().socialNotificationReceipts).toEqual([]);
});

it('does not treat another owner or a different room as the observed report scope', () => {
  const f = fixture(); f.certifyReport();
  expect(f.store.request({ type: 'social.notifications.receipts', companionId: 'bob', conversationId: f.room.id, messageIds: [f.report.id] }).socialNotificationReceipts).toEqual([]);
  expect(f.store.request({ type: 'social.notifications.receipts', companionId: 'alice', conversationId: f.peerRoom.id, messageIds: [f.report.id] }).socialNotificationReceipts).toEqual([]);
});

it('propagates real SQLite unavailability instead of turning it into an empty authority receipt', () => {
  const f = fixture(); f.certifyReport(); expect(f.lookup().socialNotificationReceipts).toHaveLength(1);
  f.db.exec('ALTER TABLE companion_social_delegations RENAME TO fixture_unavailable_delegations');
  expect(f.lookup).toThrow(/no such table/iu);
});

it('retains schema rejection of malformed JSON and ignores an unconsumed unsupported notification sibling', () => {
  const f = fixture(); f.certifyReport(); const before = f.lookup().socialNotificationReceipts;
  const insert = f.db.prepare('INSERT INTO companion_social_notifications(id,companion_id,origin_id,event_key,status,attempts,created_at,data) VALUES(?,?,?,?,?,?,?,?)');
  // The real schema's other JSON expressions already reject malformed bytes
  // at mutation admission. Do not drop those gates merely to reach a reader.
  expect(() => insert.run('malformed_unconsumed_notice', 'alice', f.notice.origin.id, 'malformed-unconsumed', 'done', 0,
    new Date().toISOString(), '{broken')).toThrow(/malformed JSON/iu);
  insert.run('unsupported_unconsumed_notice', 'alice', f.notice.origin.id, 'unsupported-unconsumed', 'done', 0,
    new Date().toISOString(), JSON.stringify({ kind: 'unknown_future_notice' }));
  expect(f.lookup().socialNotificationReceipts).toEqual(before);
});
