import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';

let store: CompanionsStore, root: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-20T05:40:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'social-graph-'));
  const seeds: CompanionSeed[] = ['alice', 'bob', 'carol'].map(id => ({ id, name: id, persona: '独立生活', description: '', model: '', avatar: 'sister', active: true, proactive: true }));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'Asia/Shanghai' } });
  for (const id of ['alice', 'bob', 'carol']) {
    const scope = { companionId: id, conversationId: store.openPrivate(id).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
});
afterEach(() => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('social-graph-')) throw new Error('Unexpected fixture'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const scope = (id: string) => ({ companionId: id, conversationId: store.openPrivate(id).id });
const room = (ids = ['alice', 'bob']) => store.request({ type: 'social.conversation.ensure', companionId: ids[0]!, memberIds: ids }).socialConversation!;
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }

it('projects player and peer relationships from actual sources, isolates other private chat, and never wakes a dormant peer', () => {
  const pair = room();
  store.request({ type: 'social.message.append', conversationId: pair.id, authorId: 'alice', content: '真实的伙伴消息', virtualCreatedAt: new Date().toISOString(), clientId: 'one' });
  const own = store.appendMessage({ conversationId: scope('alice').conversationId, authorId: 'user', content: '我与alice的对话', replyDirective: 'none' });
  store.appendMessage({ conversationId: scope('bob').conversationId, authorId: 'user', content: 'BOB_PRIVATE_NEVER_IN_ALICE_GRAPH', replyDirective: 'none' });
  store.setCompanionActive('bob', false);
  const before = store.request({ type: 'world.snapshot' }).world!, response = store.request({ type: 'social.graph', companionId: 'alice' });
  expect(() => companionStorageResponseSchema.parse(response)).not.toThrow();
  const graph = response.socialGraph!;
  expect(graph.nodes.map(node => node.id)).toEqual(['alice', 'bob', 'user']);
  expect(graph.nodes.find(node => node.id === 'bob')).toMatchObject({ active: false, state: 'dormant' });
  expect(graph.events.some(event => event.id === own.id)).toBe(true);
  expect(JSON.stringify(graph)).not.toContain('BOB_PRIVATE');
  expect(graph.events.find(event => event.text === '真实的伙伴消息')?.kind).toBe('unknown');
  const after = store.request({ type: 'world.snapshot' }).world!;
  expect(after.actors).toEqual(before.actors); expect(after.scenes).toEqual(before.scenes);
  expect(after.actors.some(actor => actor.companionId === 'bob')).toBe(false);
  expect(after.scenes.some(scene => scene.ownerId === 'bob')).toBe(false);
  // Observation does not create the model's own long-term knowledge.
  expect(store.request({ type: 'memory.browse', ...scope('alice') }).memoryPage!.items).toHaveLength(0);
});

it('distinguishes requested, allowed, departed and physically entered without exposing private goals or inventing a face conversation', () => {
  const pair = room(), alice = scope('alice'), bob = scope('bob');
  const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: 'PRIVATE_VISIT_GOAL', replyDirective: 'none' });
  store.request({ type: 'world.tool', ...alice, sourceMessageId: source.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: 'PRIVATE_VISIT_GOAL' } });
  let graph = store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!;
  expect(graph.links.find(link => link.targetId === 'bob')?.status).toBe('permission');
  expect(graph.events.filter(event => !event.message).map(event => event.kind)).toEqual(['visit_request']);
  // The owner's actual response is a different fact from arrival.
  const visit = graph.visits[0]!;
  store.request({ type: 'world.tool', ...bob, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎来玩。' } });
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'travel', targetSceneId: 'home_bob' } });
  let flow = store.request({ type: 'social.flow', conversationId: pair.id }).socialFlowPage!;
  expect(flow.items.map(event => event.kind)).toContain('scene_depart');
  expect(flow.items.some(event => event.kind === 'scene_enter')).toBe(false);
  expect(JSON.stringify(flow)).not.toContain('PRIVATE_VISIT_GOAL');
  advance(40000);
  flow = store.request({ type: 'social.flow', conversationId: pair.id }).socialFlowPage!;
  expect(flow.items.find(event => event.kind === 'visit_response')).toMatchObject({ label: '允许拜访', visitId: visit.id });
  expect(flow.items.find(event => event.kind === 'scene_enter')).toMatchObject({ actorId: 'alice', targetIds: ['bob'], sceneId: 'home_bob', visitId: visit.id });
  expect(flow.items.some(event => event.kind === 'face_to_face')).toBe(false);
  expect(() => companionStorageResponseSchema.parse({ ok: true, socialFlowPage: flow })).not.toThrow();
  graph = store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!;
  expect(graph.links.find(link => link.targetId === 'bob')?.status).toBe('visiting');
});

it('pages equal-time facts without duplicates and scopes world facts to the actual peer room and virtual day', () => {
  const pair = room(), other = room(['bob', 'carol']);
  for (let i = 0; i < 8; i++) store.request({ type: 'social.message.append', conversationId: pair.id, authorId: 'alice', content: '事实 ' + i, virtualCreatedAt: new Date().toISOString(), clientId: 'page_' + i });
  store.request({ type: 'social.message.append', conversationId: other.id, authorId: 'bob', content: 'OTHER_PAIR', virtualCreatedAt: new Date().toISOString(), clientId: 'other_pair' });
  const ids: string[] = []; let before: { at: string; id: string } | undefined;
  do {
    const page = store.request({ type: 'social.flow', conversationId: pair.id, day: '2026-10-20', before, limit: 3 }).socialFlowPage!;
    ids.push(...page.items.map(item => item.id)); before = page.nextCursor;
  } while (before);
  expect(ids).toHaveLength(8); expect(new Set(ids).size).toBe(8);
  expect(store.request({ type: 'social.flow', conversationId: pair.id, day: '2026-10-19' }).socialFlowPage!.items).toHaveLength(0);
  expect(JSON.stringify(store.request({ type: 'social.flow', conversationId: pair.id }))).not.toContain('OTHER_PAIR');
  expect(() => store.request({ type: 'social.flow', conversationId: scope('alice').conversationId })).toThrow('社交会话');
});
