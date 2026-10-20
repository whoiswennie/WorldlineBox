import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const seeds: CompanionSeed[] = ['alice','bob','carol'].map(id => ({ id, name: id, persona: '独立生活', description: '', model: '', avatar: 'sister', active: id === 'alice', proactive: false }));
function cleanup(root: string) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('social-flow-pressure-')) return; rmSync(root, { recursive: true, force: true }); }

it('indexes actual audiences without granting every group member knowledge, and removes derived rows with their source', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'social-flow-pressure-')), filename = path.join(root, 'state.sqlite');
  let store: CompanionsStore | undefined, database: CompanionConnection | undefined;
  try {
    store = new CompanionsStore(filename, seeds);
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice','bob','carol'] }).socialConversation!;
    const at = store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.virtualNow;
    const source = store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'alice', recipientIds: ['bob'], content: '只向实际收件人发送的来信', virtualCreatedAt: at, clientId: 'actual_audience' }).socialMessage!;
    expect(store.request({ type: 'social.graph', companionId: 'bob' }).socialGraph!.events.map(event => event.id)).toContain(source.message.id);
    expect(store.request({ type: 'social.graph', companionId: 'carol' }).socialGraph!.events).toHaveLength(0);
    store.close(); store = undefined;
    const db = database = new Database(filename);
    db.prepare('UPDATE companion_social_messages SET recipient_ids=? WHERE message_id=?').run('["carol"]', source.message.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_social_audience WHERE companion_id=? AND message_id=?').get('bob', source.message.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_social_audience WHERE companion_id=? AND message_id=?').get('carol', source.message.id)).toEqual({ n: 1 });
    db.prepare('DELETE FROM companion_social_messages WHERE message_id=?').run(source.message.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_social_audience WHERE message_id=?').get(source.message.id)).toEqual({ n: 0 }); db.close(); database = undefined;
  } finally { database?.close(); store?.close(); cleanup(root); }
});

it('keeps a 200,000-fact archive off the live response and retains complete source text on disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'social-flow-pressure-')), filename = path.join(root, 'state.sqlite');
  let store: CompanionsStore | undefined, database: CompanionConnection | undefined;
  try {
    store = new CompanionsStore(filename, seeds);
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice','bob'] }).socialConversation!;
    const at = store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.virtualNow;
    const initial = store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'alice', content: '归档压力测试的真实来源格式', virtualCreatedAt: at, clientId: 'pressure_template' }).socialMessage!.message;
    store.close(); store = undefined;
    // Synthetic authority records in a disposable, closed database, never the user's profile.
    const db = database = new Database(filename), count = 100000, end = Date.parse(at) - 1000;
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    const eventSequence = Number((db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM companion_world_events').get() as { n: number }).n);
    db.transaction(() => {
      const message = db.prepare('INSERT INTO messages(sequence,id,conversation_id,author_id,kind,content,status,created_at) VALUES(?,?,?,?,?,?,?,?)');
      const social = db.prepare('INSERT INTO companion_social_messages(message_id,conversation_id,sequence,virtual_at,recipient_ids,channel) VALUES(?,?,?,?,?,?)');
      const search = db.prepare('INSERT INTO companion_social_search(rowid,content,title) VALUES(?,?,?)');
      const world = db.prepare('INSERT INTO companion_world_events(id,data) VALUES(?,?)');
      const visit = db.prepare("INSERT INTO companion_world_visit_records(id,guest_id,host_id,status,data) VALUES(?,?,?,'left',?)");
      for (let index = 0; index < count; index++) {
        const id = 'archive_message_' + index, authorId = index % 2 ? 'alice' : 'bob', target = authorId === 'alice' ? 'bob' : 'alice', stamp = new Date(end - (count - index) * 1000).toISOString(), content = '归档的日常来信 ' + index, sequence = initial.sequence + index + 1;
        message.run(sequence, id, room.id, authorId, 'text', content, 'sent', stamp);
        social.run(id, room.id, sequence, stamp, JSON.stringify([target]), 'phone'); search.run(sequence, 'archive ' + index, 'archive');
        const eventId = 'archive_event_' + index;
        const visitId = 'archive_visit_' + index;
        world.run(eventId, JSON.stringify({ id: eventId, sequence: eventSequence + index + 1, at: stamp, realAt: stamp, kind: 'visit_request', actorId: authorId, targetId: target, visitId, text: '合成审计压力测试记录' }));
        visit.run(visitId, authorId, target, JSON.stringify({ id: visitId, guestId: authorId, hostId: target, status: 'left', createdAt: stamp, expiresAt: new Date(Date.parse(stamp) + 60000).toISOString(), reason: '合成归档状态，非自动执行证明' }));
      }
    }).immediate();
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_social_visit_contacts').get()).toEqual({ n: 2 });
    db.close(); database = undefined; store = new CompanionsStore(filename, seeds);
    const durations: number[] = []; let response: ReturnType<CompanionsStore['request']> | undefined;
    for (let read = 0; read < 12; read++) { const start = performance.now(); response = store.request({ type: 'social.graph', companionId: 'alice' }); durations.push(performance.now() - start); }
    expect(() => companionStorageResponseSchema.parse(response)).not.toThrow();
    expect(response!.socialGraph!.events).toHaveLength(60); expect(response!.socialGraph!.hasMoreEvents).toBe(true);
    const longText = '完整原文仍须保留。'.repeat(5000);
    const latest = store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'bob', content: longText, virtualCreatedAt: response!.socialGraph!.virtualNow, clientId: 'actual_new_live' }).socialMessage!;
    const updated = store.request({ type: 'social.graph', companionId: 'alice' }), event = updated.socialGraph!.events.find(event => event.id === latest.message.id)!;
    expect(event.textTruncated).toBe(true); expect(event.text).toHaveLength(600); expect(event.message!.message.content).toHaveLength(600);
    expect(store.request({ type: 'message.get', id: latest.message.id }).message!.content).toBe(longText);
    expect(updated.socialGraph!.events).toHaveLength(60);
    const bytes = Buffer.byteLength(JSON.stringify(updated)), maximumMs = Math.max(...durations);
    expect(bytes).toBeLessThan(250000); expect(maximumMs).toBeLessThan(1000);
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, 'verified-social-flow-pressure.json'), JSON.stringify({ syntheticArchiveFacts: count * 2, archivedVisits: count, reads: durations.length, maximumQueryMs: Math.round(maximumMs), averageQueryMs: Math.round(durations.reduce((a,b) => a+b) / durations.length), responseBytes: bytes, liveEvents: updated.socialGraph!.events.length, completeSourceRetained: true }, null, 2));
  } finally { database?.close(); store?.close(); cleanup(root); }
}, 120000);
