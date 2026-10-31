import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import { COMPANION_WORLD_SEATING_MS } from '../../src/shared/companion-world-engine';

const seed: CompanionSeed = { id: 'alice', name: 'Alice', persona: '认真生活', description: '', model: '', avatar: 'sister', proactive: true };
const stores = new Set<CompanionsStore>(), roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-computer-transition-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, [{ ...seed, active: true }]); stores.add(store);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  store.request({ type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: 'alice_computer' } }); advance(store, 12000);
  return { store, filename, scope };
}
const subject = (world: CompanionWorldSnapshot) => world.actors.find(actor => actor.companionId === 'alice')!;
function advance(store: CompanionsStore, milliseconds: number) { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function begin(f: ReturnType<typeof fixture>, id: string) {
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请开始实际处理工作 ' + id, replyDirective: 'none' });
  const command = { type: 'world.work.begin', ...f.scope, kind: 'action', workId: id, sourceMessageId: source.id } as const;
  expect(f.store.request(command).worldWork!.status).toBe('seating');
  const world = f.store.request({ type: 'world.snapshot' }).world!, started = world.events.findLast(event => event.behavior?.kind === 'seating' && event.behavior.phase === 'started')!;
  expect(started.behavior?.id).toBeTruthy(); expect(subject(world).transitionEndsAtReal).toBe(new Date(Date.now() + COMPANION_WORLD_SEATING_MS).toISOString());
  return { command, source, started, deadline: Date.parse(subject(world).transitionEndsAtReal!) };
}
const phases = (world: CompanionWorldSnapshot, id: string) => world.events.filter(event => event.behavior?.id === id).map(event => event.behavior!.phase);

describe('one authoritative computer seating transition', () => {
  it('shares one real deadline and one transition id across jobs, and cannot become ready at frame three before that deadline', () => {
    const f = fixture(), first = begin(f, 'first'), id = first.started.behavior!.id;
    advance(f.store, 500);
    const secondSource = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '还有一项并行工作。', replyDirective: 'none' });
    expect(f.store.request({ ...first.command, workId: 'second', sourceMessageId: secondSource.id }).worldWork!.status).toBe('seating');
    let world = f.store.request({ type: 'world.snapshot' }).world!;
    expect(subject(world).transitionEndsAtReal).toBe(new Date(first.deadline).toISOString()); expect(phases(world, id)).toEqual(['started']);
    world = advance(f.store, first.deadline - Date.now() - 1);
    expect(subject(world)).toMatchObject({ activity: 'seating', frame: 2 });
    expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'first' }).worldWork!.status).toBe('seating');
    expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'second' }).worldWork!.status).toBe('seating');
    world = advance(f.store, 1);
    expect(subject(world).activity).toBe('working'); expect(subject(world).transitionEndsAtReal).toBeUndefined();
    expect(world.works.filter(work => ['first', 'second'].includes(work.workId)).every(work => work.status === 'ready')).toBe(true);
    expect(phases(world, id)).toEqual(['started', 'completed']);
    expect(world.events.find(event => event.behavior?.id === id && event.behavior.phase === 'completed')?.realAt).toBe(new Date(first.deadline).toISOString());
    world = advance(f.store, 1000); expect(phases(world, id)).toEqual(['started', 'completed']);
    expect(world.events.filter(event => event.behavior?.kind === 'seating' && event.behavior.phase === 'started')).toHaveLength(1);
  });

  it('interrupts cancelled seating once, stands physically, releases the computer and never completes the cancelled id', () => {
    const f = fixture(), first = begin(f, 'cancelled'), id = first.started.behavior!.id;
    advance(f.store, 500); f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'cancelled' });
    let world = f.store.request({ type: 'world.snapshot' }).world!;
    expect(subject(world).activity).toBe('standingUp'); expect(phases(world, id)).toEqual(['started', 'interrupted']);
    const standing = world.events.findLast(event => event.behavior?.kind === 'standingUp' && event.behavior.phase === 'started')!;
    expect(world.scenes.find(scene => scene.ownerId === 'alice')!.objects.find(object => object.kind === 'computer')!.reservedBy).toBe('alice');
    world = advance(f.store, COMPANION_WORLD_SEATING_MS);
    expect(subject(world).activity).toBe('idle'); expect(phases(world, id)).toEqual(['started', 'interrupted']); expect(phases(world, standing.behavior!.id)).toEqual(['started', 'completed']);
    expect(world.scenes.find(scene => scene.ownerId === 'alice')!.objects.find(object => object.kind === 'computer')!.reservedBy).toBeUndefined();
    world = advance(f.store, 5000); expect(subject(world).activity).not.toBe('working'); expect(phases(world, id)).not.toContain('completed');
  });

  it('interrupts orphaned seating when its actual source is withdrawn instead of resurrecting work at the old deadline', () => {
    const f = fixture(), first = begin(f, 'withdrawn'), id = first.started.behavior!.id;
    advance(f.store, 500); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [first.source.id] });
    let world = advance(f.store, 1); expect(subject(world).activity).toBe('standingUp'); expect(phases(world, id)).toEqual(['started', 'interrupted']);
    world = advance(f.store, 5000); expect(subject(world).activity).not.toBe('working'); expect(phases(world, id)).not.toContain('completed');
  });

  it('terminates a stopped process seating on restart and creates a fresh identity only for an actual resumed request', () => {
    const f = fixture(), first = begin(f, 'restart'), id = first.started.behavior!.id;
    advance(f.store, 500); f.store.close(); stores.delete(f.store);
    const reopened = new CompanionsStore(f.filename, [{ ...seed, active: true }]); stores.add(reopened);
    let world = reopened.request({ type: 'world.snapshot' }).world!;
    expect(subject(world).transitionEndsAtReal).toBeUndefined(); expect(phases(world, id)).toEqual(['started', 'interrupted']);
    world = advance(reopened, 5000); expect(subject(world).activity).not.toBe('working'); expect(phases(world, id)).not.toContain('completed');
    expect(reopened.request(first.command).worldWork!.status).toBe('seating');
    const resumed = reopened.request({ type: 'world.snapshot' }).world!, next = resumed.events.findLast(event => event.behavior?.kind === 'seating' && event.behavior.phase === 'started')!;
    expect(next.behavior!.id).not.toBe(id); expect(phases(resumed, next.behavior!.id)).toEqual(['started']);
    expect(subject(advance(reopened, COMPANION_WORLD_SEATING_MS)).activity).toBe('working');
  });
});
