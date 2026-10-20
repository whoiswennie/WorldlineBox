import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const roots: string[] = [], stores = new Set<CompanionsStore>();
const fish = 'deepseek-flash', sister = 'deepseek-sister';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-20T10:00:00Z'); });
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) { if (!root.startsWith(path.join(tmpdir(), 'companion-activation-'))) throw new Error('Unexpected fixture path'); rmSync(root, { recursive: true, force: true }); }
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-activation-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename); stores.add(store);
  const settings = store.request({ type: 'world.snapshot' }).world!.settings;
  store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  return { store, filename };
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function activate(store: CompanionsStore, id: string, active = true) { return store.request({ type: 'companion.set-active', id, active }).companion!; }
function awake(store: CompanionsStore, companionId: string) {
  const scope = { companionId, conversationId: store.openPrivate(companionId).id };
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  return scope;
}

it('loads only the default fish world and never creates dormant actors, interiors, perceptions or cognition jobs', () => {
  const { store, filename } = fixture(), world = store.request({ type: 'world.snapshot' }).world!;
  expect(store.state().companions.filter(role => role.active).map(role => role.id)).toEqual([fish]);
  expect(world.actors.map(actor => actor.companionId)).toEqual([fish]);
  expect(world.scenes.filter(scene => scene.kind === 'home').map(scene => scene.ownerId)).toEqual([fish]);
  const room = store.openPrivate(sister);
  store.appendMessage({ conversationId: room.id, authorId: 'user', content: '在吗？' });
  expect(store.request({ type: 'world.snapshot' }).world!.actors.map(actor => actor.companionId)).toEqual([fish]);
  const db = new Database(filename);
  try {
    expect(db.prepare('SELECT 1 FROM companion_world_perceptions WHERE companion_id=?').get(sister)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM companion_world_jobs WHERE companion_id=?').get(sister)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM companion_routine_work WHERE companion_id=? AND ends_at IS NULL').get(sister)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM companion_world_suspended WHERE companion_id=?').get(sister)).toBeUndefined();
  } finally { db.close(); }
});

it('migrates legacy choices once, persists manual activation across restart, and creates custom contacts dormant', () => {
  const f = fixture(); f.store.close(); stores.delete(f.store);
  const db = new Database(f.filename); db.exec("UPDATE companions SET data=json_remove(data,'$.active')"); db.close();
  let store = new CompanionsStore(f.filename); stores.add(store);
  expect(store.state().companions.filter(role => role.active).map(role => role.id)).toEqual([fish]);
  activate(store, sister); activate(store, fish, false);
  const custom = store.createCompanion({ name: '新伙伴', description: '', persona: '友好', avatar: 'custom', model: '', proactive: true });
  expect(custom.active).toBe(false);
  store.close(); stores.delete(store); store = new CompanionsStore(f.filename); stores.add(store);
  expect(store.state().companions.filter(role => role.active).map(role => role.id)).toEqual([sister]);
  expect(store.request({ type: 'world.snapshot' }).world!.actors.map(actor => actor.companionId)).toEqual([sister]);
});

it('unloads a suspended actor into SQLite, freezes its state, retains history and restores only on explicit activation', () => {
  const { store, filename } = fixture(), scope = awake(store, fish);
  advance(store, 6000);
  store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '这段聊天应当保留。', replyDirective: 'none' });
  store.request({ type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: fish + '_bed' } });
  advance(store, 400);
  const before = store.request({ type: 'world.snapshot' }).world!.actors[0]!;
  const energy = store.request({ type: 'state.get', ...scope }).runtimeState!.energy;
  activate(store, fish, false);
  advance(store, 3 * 3600_000);
  const world = store.request({ type: 'world.snapshot' }).world!;
  expect(world.actors).toEqual([]); expect(world.scenes.filter(scene => scene.kind === 'home')).toEqual([]);
  expect(store.request({ type: 'state.get', ...scope }).runtimeState!.energy).toBe(energy);
  expect(() => store.request({ type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: fish + '_bed' } })).toThrow('休眠');
  const db = new Database(filename);
  try {
    const hot = JSON.parse(String((db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data));
    expect(hot.actors).toEqual([]); expect(hot.suspendedActors).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM companion_world_suspended WHERE companion_id=?').get(fish)).toBeDefined();
  } finally { db.close(); }
  expect(store.request({ type: 'messages', conversationId: scope.conversationId }).messages?.some(message => message.content === '这段聊天应当保留。')).toBe(true);
  activate(store, fish);
  const restored = store.request({ type: 'world.snapshot' }).world!.actors[0]!;
  expect(restored.position).toEqual(before.position); expect(restored.route).toEqual(before.route);
});

it('delivers one real message to a dormant recipient without loading her world and resumes the pending reply after activation', () => {
  const { store } = fixture(); awake(store, fish); advance(store, 6000);
  const room = store.request({ type: 'social.conversation.ensure', companionId: fish, memberIds: [fish, sister] }).socialConversation!;
  const input = { type: 'social.send', companionId: fish, conversationId: room.id, channel: 'phone', content: '想找你玩，你方便的时候回我就好。', clientId: 'invitation' } as const;
  expect(store.request(input)).toMatchObject({ socialPending: true, socialRecipients: [{ companionId: sister, state: 'dormant' }] });
  advance(store, 1300);
  const delivered = store.request(input).socialMessage!;
  expect(delivered.message.authorId).toBe(fish);
  expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  const status = companionStorageResponseSchema.parse(store.request({ type: 'world.status', companionIds: [fish] })).worldStatus!;
  expect(status.interactions).toContainEqual(expect.objectContaining({ companionId: fish, recipientIds: [sister], phase: 'waiting', recipients: [{ companionId: sister, state: 'dormant' }] }));
  expect(store.request({ type: 'world.snapshot' }).world!.actors.some(actor => actor.companionId === sister)).toBe(false);
  activate(store, sister); awake(store, sister); advance(store, 6000);
  const job = store.request({ type: 'social.job.claim' }).socialJob!; expect(job.companionId).toBe(sister);
  advance(store, 1300);
  const reply = store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '现在有空啦。' }).socialMessage!;
  expect(reply.message.authorId).toBe(sister); expect(reply.message.replyToId).toBe(delivered.message.id);
});

it('reports sleeping, eating and working without forcing a reply or waking a dormant world', () => {
  const { store } = fixture(); activate(store, sister); const scope = awake(store, sister);
  const settings = store.request({ type: 'world.snapshot' }).world!.settings;
  store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { timeZone: 'UTC' } });
  const state = () => store.request({ type: 'world.status', companionIds: [sister] }).worldStatus!.contacts[0]!.state;
  let routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { sleepAt: '09:00', wakeAt: '11:00' } });
  expect(state()).toBe('sleeping');
  routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { sleepAt: '23:00', wakeAt: '07:00', meals: [{ name: '午饭', at: '10:00', durationMinutes: 60 }] } });
  advance(store, 20000); expect(state()).toBe('eating');
  awake(store, sister); advance(store, 20000);
  store.request({ type: 'world.work.begin', ...scope, workId: 'work', kind: 'action', fixed: true });
  expect(state()).toBe('working');
  activate(store, sister, false); expect(state()).toBe('dormant');
  expect(store.request({ type: 'world.snapshot' }).world!.works.filter(work => work.companionId === sister)).toEqual([]);
});
