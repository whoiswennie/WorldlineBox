import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };

it('queries a real 20,000-person ego network without truncation, large IPC payloads, world loading or losing off-page live events', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'social-scale-')), filename = path.join(root, 'state.sqlite');
  const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', persona: '独立生活', description: '', model: '', avatar: 'sister', active: true, proactive: false }];
  let store: CompanionsStore | undefined;
  try {
    store = new CompanionsStore(filename, seeds); store.openPrivate('alice');
    const template = store.request({ type: 'state' }).state!.companions[0]!;
    store.close(); store = undefined;
    // Synthetic authority records in a closed, disposable SQLite fixture. Counts are never mocked.
    const db = new Database(filename);
    db.transaction(() => {
      const companion = db.prepare('INSERT INTO companions(id,data) VALUES(?,?)'), room = db.prepare("INSERT INTO conversations(id,kind,title,updated_at,hidden_at) VALUES(?,'group',?,?,?)"), member = db.prepare('INSERT INTO conversation_members VALUES(?,?)'), social = db.prepare('INSERT INTO companion_social_conversations VALUES(?,?)');
      const now = new Date().toISOString();
      for (let index = 0; index < 20000; index++) {
        const id = 'scale_' + String(index).padStart(5, '0'), roomId = 'scale_room_' + index;
        companion.run(id, JSON.stringify({ ...template, id, name: '关系对象 ' + index, avatar: 'custom', active: false, builtin: false }));
        room.run(roomId, '真实关系记录 ' + index, now, now); member.run(roomId, 'alice'); member.run(roomId, id); social.run(roomId, 'alice|' + id);
      }
    }).immediate(); db.close();
    store = new CompanionsStore(filename, seeds);
    const context = store.request({ type: 'state', includeHidden: true, activeOnly: true, conversationId: 'scale_room_19999' }).state!;
    expect(context.companions.map(role => role.id)).toEqual(['alice']); expect(context.conversations.map(room => room.id)).toEqual(['scale_room_19999']);
    expect(store.request({ type: 'state', includeConversations: false }).state!.conversations).toHaveLength(0);
    const before = store.request({ type: 'world.snapshot' }).world!;
    const start = performance.now(), first = store.request({ type: 'social.graph', companionId: 'alice' });
    const elapsed = performance.now() - start, graph = first.socialGraph!;
    expect(() => companionStorageResponseSchema.parse(first)).not.toThrow();
    expect(graph.total).toBe(20001); expect(graph.groups).toContainEqual({ id: 'dormant', count: 20000 });
    expect(graph.nodes.length).toBeLessThanOrEqual(42); expect(graph.hasMorePeers).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(100000);
    const second = store.request({ type: 'social.graph', companionId: 'alice', afterPeerId: graph.nextPeerId }).socialGraph!;
    const ids = new Set(graph.nodes.filter(node => node.id !== 'alice').map(node => node.id));
    expect(second.nodes.filter(node => node.id !== 'alice').every(node => !ids.has(node.id))).toBe(true);
    expect(second.total).toBe(20001);
    const found = store.request({ type: 'social.graph', companionId: 'alice', query: 'scale_19999' }).socialGraph!;
    expect(found.matchedTotal).toBe(1); expect(found.nodes.map(node => node.id)).toEqual(['alice','scale_19999']);
    // The global event stream still includes an actual source outside the currently loaded neighbourhood.
    const virtualNow = graph.virtualNow;
    const actual = store.request({ type: 'social.message.append', conversationId: 'scale_room_19999', authorId: 'scale_19999', content: '来自画布之外的真实新消息', virtualCreatedAt: virtualNow, clientId: 'off_page_live' }).socialMessage!;
    const refreshed = store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!;
    expect(refreshed.nodes.some(node => node.id === 'scale_19999')).toBe(false);
    expect(refreshed.events.find(event => event.id === actual.message.id)).toMatchObject({ actorId: 'scale_19999', actorName: '关系对象 19999', text: '来自画布之外的真实新消息' });
    const focused = store.request({ type: 'social.graph', companionId: 'scale_19999' }).socialGraph!;
    expect(focused.nodes.some(node => node.id === 'alice')).toBe(true);
    const after = store.request({ type: 'world.snapshot' }).world!;
    expect(after.actors.map(actor => actor.companionId)).toEqual(before.actors.map(actor => actor.companionId));
    expect(after.scenes.map(scene => scene.id)).toEqual(before.scenes.map(scene => scene.id));
    console.info(JSON.stringify({ socialScale: { relationships: 20001, firstQueryMs: Math.round(elapsed), responseBytes: JSON.stringify(first).length, renderedNeighbourhood: graph.nodes.length } }));
    expect(elapsed).toBeLessThan(1500);
  } finally { store?.close(); if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('social-scale-')) rmSync(root, { recursive: true, force: true }); }
}, 60000);
