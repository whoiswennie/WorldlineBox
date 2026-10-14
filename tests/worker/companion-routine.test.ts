import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '安静认真', description: '', model: '', avatar: 'sister', proactive: false }));
const stores = new Set<CompanionsStore>(), folders: string[] = [];
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'companion-routine-')); folders.push(folder);
  const store = new CompanionsStore(path.join(folder, 'messages.sqlite'), seeds); stores.add(store);
  return { store, filename: path.join(folder, 'messages.sqlite'), scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
const habit = { id: 'reading', title: '私人阅读计划_440', at: '10:00', durationMinutes: 30, kind: 'study' as const };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-14T09:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); vi.useRealTimers(); });

describe('persistent virtual routine source and clock behavior', () => {
  it('records an actual human form source and derives progress offline without resetting it on unrelated edits', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    const saved = store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', meals: [], habits: [habit] } }).routine!;
    expect(store.getMessage(saved.sourceMessageId!)).toMatchObject({ authorId: 'user', memoryEvidenceOnly: true });
    expect(saved.habitProgress[0]).toMatchObject({ completedCount: 0, strength: 0 });
    vi.setSystemTime('2026-10-17T11:00:00Z');
    const offline = store.request({ type: 'routine.get', ...scope }).routine!;
    expect(offline.habitProgress[0]).toMatchObject({ completedCount: 4, streak: 4 });
    const edited = store.request({ type: 'routine.configure', ...scope, expectedRevision: offline.revision, patch: { wakeAt: '06:30' } }).routine!;
    expect(edited.habitProgress[0]?.completedCount).toBe(4);
    expect(() => store.request({ type: 'routine.configure', ...scope, expectedRevision: offline.revision, patch: { wakeAt: '06:00' } })).toThrow('已更新');
  });
  it('hides private routine facts and ownership in a group and rejects group configuration', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    const saved = store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision,
      patch: { timeZone: 'UTC', habits: [habit], meals: [{ name: '私人餐食_885', at: '12:00', durationMinutes: 30 }] } }).routine!;
    vi.setSystemTime('2026-10-14T10:05:00Z');
    const group = store.createConversation('公开群', ['alice', 'bob']), groupScope = { companionId: 'alice', conversationId: group.id };
    const visible = store.request({ type: 'routine.get', ...groupScope }).routine!;
    expect(visible.config.habits).toEqual([]); expect(visible.habitProgress).toEqual([]);
    expect(visible.runtime).toMatchObject({ phase: 'habit', activity: '个人习惯活动' });
    expect(JSON.stringify(visible)).not.toContain('私人'); expect(visible.sourceMessageId).toBeUndefined();
    expect(() => store.request({ type: 'routine.configure', ...groupScope, expectedRevision: saved.revision, patch: { habits: [] } })).toThrow('私聊');
  });
  it('withdraws a forgotten configuration instead of reusing its private title or source in future state', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    const saved = store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', habits: [habit] } }).routine!;
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [saved.sourceMessageId!] });
    const refreshed = store.request({ type: 'routine.get', ...scope }).routine!;
    expect(refreshed.revision).toBeGreaterThan(saved.revision); expect(refreshed.sourceMessageId).toBeUndefined();
    expect(JSON.stringify(refreshed)).not.toContain(habit.title);
    expect(refreshed.habitProgress.every(progress => progress.completedCount === 0)).toBe(true);
  });
  it('retains provenance of unchanged private settings across a later partial edit and enforces replay boundaries', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    const old = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '你好' });
    const first = store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', habits: [habit] } }).routine!;
    const later = store.request({ type: 'routine.configure', ...scope, expectedRevision: first.revision, patch: { wakeAt: '06:30' } }).routine!;
    expect(later.config.habits[0]?.title).toBe(habit.title);
    const before = store.request({ type: 'routine.get', ...scope, beforeSequence: old.sequence }).routine!;
    expect(JSON.stringify(before)).not.toContain(habit.title); expect(before.sourceMessageId).toBeUndefined();
    expect(JSON.stringify(store.request({ type: 'state.get', ...scope, beforeSequence: old.sequence }).runtimeState)).not.toContain(habit.title);
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [first.sourceMessageId!] });
    expect(JSON.stringify(store.request({ type: 'routine.get', ...scope }).routine)).not.toContain(habit.title);
  });
  it('requires a real directed configuration request and independently wakes every addressed group companion', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    for (const content of ['你喜欢什么作息？', '我每天十点睡觉', '他说请你修改作息']) {
      const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content });
      expect(() => store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, sourceMessageId: source.id, patch: { sleepAt: '22:00' } })).toThrow('明确');
    }
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '把睡觉时间改到十点。' });
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, sourceMessageId: source.id, patch: { timeZone: 'UTC', sleepAt: '22:00', meals: [] } });
    const bobScope = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
    const bob = store.request({ type: 'routine.get', ...bobScope }).routine!;
    store.request({ type: 'routine.configure', ...bobScope, expectedRevision: bob.revision, patch: { timeZone: 'UTC', sleepAt: '22:00', meals: [] } });
    vi.setSystemTime('2026-10-14T23:30:00Z');
    const group = store.createConversation('紧急联系', ['alice', 'bob']);
    const urgent = store.appendMessage({ conversationId: group.id, authorId: 'user', content: '别睡了，紧急帮我处理故障。' });
    for (const companionId of ['alice', 'bob']) expect(store.request({ type: 'routine.interrupt', companionId, conversationId: group.id, sourceMessageId: urgent.id }).routine?.runtime).toMatchObject({ phase: 'awake', canRespond: true });
  });
  it('reports actual running work past the initial wake window and resumes the raw clock when it finishes', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', meals: [] } });
    vi.setSystemTime('2026-10-14T23:30:00Z');
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '紧急帮我做一次只读检查。' });
    store.request({ type: 'routine.interrupt', ...scope, sourceMessageId: source.id });
    const action = store.createAction({ ...scope, sourceMessageId: source.id, title: '只读检查', status: 'running' });
    vi.setSystemTime('2026-10-15T00:10:00Z');
    expect(store.request({ type: 'routine.get', ...scope }).routine?.runtime).toMatchObject({ phase: 'awake', canRespond: true, activity: '正在处理已答应的事，作息暂延' });
    store.updateAction(action.id, { status: 'succeeded', result: '实际完成检查' });
    expect(store.request({ type: 'routine.get', ...scope }).routine?.runtime.phase).toBe('sleeping');
  });
  it('excludes a genuinely interrupted habit from completed count and resets its streak', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', meals: [], habits: [habit] } });
    vi.setSystemTime('2026-10-15T10:10:00Z');
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '紧急帮我处理故障。' });
    store.request({ type: 'routine.interrupt', ...scope, sourceMessageId: source.id });
    vi.setSystemTime('2026-10-15T10:20:00Z'); store.request({ type: 'routine.complete-interrupt', companionId: scope.companionId });
    vi.setSystemTime('2026-10-15T11:00:00Z');
    expect(store.request({ type: 'routine.get', ...scope }).routine?.habitProgress[0]).toMatchObject({ completedCount: 1, streak: 0 });
  });
  it('excludes a habit while real work continues beyond the thirty-minute wake window', () => {
    const { store, scope } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', meals: [], habits: [habit] } });
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '紧急帮我执行只读检查。' });
    store.request({ type: 'routine.interrupt', ...scope, sourceMessageId: source.id });
    const action = store.createAction({ ...scope, sourceMessageId: source.id, title: '只读检查', status: 'running' });
    vi.setSystemTime('2026-10-14T10:35:00Z');
    expect(store.request({ type: 'routine.get', ...scope }).routine?.habitProgress[0]?.completedCount).toBe(0);
    vi.setSystemTime('2026-10-14T11:00:00Z'); store.updateAction(action.id, { status: 'succeeded', result: '完成' });
    expect(store.request({ type: 'routine.get', ...scope }).routine?.habitProgress[0]?.completedCount).toBe(0);
    vi.setSystemTime('2026-10-15T11:00:00Z');
    expect(store.request({ type: 'routine.get', ...scope }).routine?.habitProgress[0]).toMatchObject({ completedCount: 1, streak: 1 });
  });
  it('ends crashed work at its last observation so offline habits can actually progress', () => {
    const { store, scope, filename } = fixture(), initial = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', meals: [], habits: [habit] } });
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '做一次检查。' });
    store.createAction({ ...scope, sourceMessageId: source.id, title: '检查', status: 'running' });
    vi.setSystemTime('2026-10-14T09:20:00Z'); store.request({ type: 'state.get', ...scope });
    store.close(); stores.delete(store);
    vi.setSystemTime('2026-10-16T11:00:00Z');
    const reopened = new CompanionsStore(filename, seeds); stores.add(reopened); reopened.interruptPendingActions();
    expect(reopened.request({ type: 'routine.get', ...scope }).routine?.habitProgress[0]).toMatchObject({ completedCount: 3, streak: 3 });
  });
});
