import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CompanionsStore } from '../../src/companions/store';
import { companionModelWorld } from '../../src/main/companions/world-perception-context';
import { captureCompanionExecutionReadset, companionWorldReadSources, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

let root: string, store: CompanionsStore;
let alice: { companionId: string; conversationId: string }, bob: typeof alice;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-world-source-readset-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id,
    persona: '认真核验来源', description: '', avatar: 'sister' as const, model: '', active: true, proactive: true })));
  alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
});
afterEach(() => { store.close(); removeOwnedDirectorySync(root); vi.useRealTimers(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const request = async (command: CompanionStorageCommand) => store.request(command);
function visit() {
  const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '请拜访 bob，一起看书。', replyDirective: 'none' });
  const snapshot = store.request({ type: 'world.tool', ...alice, sourceMessageId: source.id,
    arguments: { action: 'visit', targetCompanionId: 'bob', reason: '一起看书' } }).world!;
  return { source, visit: snapshot.visits.find(visit => visit.guestId === 'alice')! };
}

it('retains a typed visit response dependency after its event leaves model context, then removes its text and pointers on withdrawal', async () => {
  const first = visit();
  const response = store.appendMessage({ conversationId: bob.conversationId, authorId: 'user', content: 'RESPONSE_PRIVATE_482 欢迎来读书。', replyDirective: 'none' });
  store.request({ type: 'world.tool', ...bob, sourceMessageId: response.id,
    arguments: { action: 'respond', requestId: first.visit.id, decision: 'allow', reason: response.content } });
  vi.setSystemTime(Date.now() + 121_000); store.request({ type: 'world.tick' });
  const model = companionModelWorld(store.request({ type: 'world.observe', ...bob }).world, 'bob')!;
  expect(model.events.some(event => event.kind === 'visit_response')).toBe(false);
  expect(model.visits[0]).toMatchObject({ response: response.content, responseSourceMessageId: response.id, responseConversationId: bob.conversationId,
    responseSourceRead: { id: response.id, conversationId: bob.conversationId, checksum: hash(response.content) } });
  const captured = companionWorldReadSources({ context: { user: JSON.stringify({ world: model }) } });
  expect(captured).toEqual({ complete: true, sources: [{ id: response.id, conversationId: bob.conversationId, checksum: hash(response.content) }] });
  const proof = captureCompanionExecutionReadset(bob, { sources: captured.sources });
  expect(await verifyCompanionExecutionReadset(proof, bob, { request })).toBe(true);
  // The guest may observe the permission status but cannot inherit the host's
  // private source or private wording as a result of the physical visit.
  const guest = companionModelWorld(store.request({ type: 'world.observe', ...alice }).world, 'alice')!;
  expect(JSON.stringify(guest)).not.toContain(response.content);
  expect(guest.visits[0]?.responseSourceRead).toBeUndefined();
  store.request({ type: 'memory.forget', ...bob, sourceMessageIds: [response.id] });
  expect(await verifyCompanionExecutionReadset(proof, bob, { request })).toBe(false);
  const current = companionModelWorld(store.request({ type: 'world.observe', ...bob }).world, 'bob')!;
  expect(current.visits[0]).toMatchObject({ status: 'allowed', response: '房主已回应拜访请求' });
  expect(current.visits[0]?.responseSourceMessageId).toBeUndefined();
  expect(current.visits[0]?.responseConversationId).toBeUndefined();
  expect(current.visits[0]?.responseSourceRead).toBeUndefined();
  expect(companionWorldReadSources({ context: { user: JSON.stringify({ world: current }) } })).toEqual({ complete: true, sources: [] });
});

it('never binds an old world quotation to new bytes when a real formal reply is republished with the same ID', async () => {
  const first = visit();
  const authority = store.appendMessage({ conversationId: bob.conversationId, authorId: 'user', content: '请回应拜访。', replyDirective: 'none' });
  const bubble = store.appendMessage({ conversationId: bob.conversationId, authorId: 'bob', content: '', loopStep: 0 });
  const sourceProof = captureCompanionExecutionReadset(bob, { context: { user: JSON.stringify({ messages: [authority] }) } });
  const checkpoint = { ...bob, sourceMessageId: authority.id, messageId: bubble.id, status: 'done' as const,
    turns: [{ text: 'OLD_FORMAL_QUOTE_593', rawText: 'OLD_FORMAL_QUOTE_593', calls: [] }] };
  store.request({ type: 'loop.save', checkpoint, executionReadset: sourceProof });
  const original = store.getMessage(bubble.id);
  const read = store.request({ type: 'world.tool', ...bob, sourceMessageId: bubble.id,
    arguments: { action: 'respond', requestId: first.visit.id, decision: 'allow', reason: original.content } }).world!;
  const world = companionModelWorld(read, 'bob')!;
  const captured = companionWorldReadSources({ context: { user: JSON.stringify({ world }) } });
  expect(captured.complete).toBe(true);
  expect(captured.sources).toContainEqual({ id: bubble.id, conversationId: bob.conversationId, checksum: hash(original.content) });
  const proof = captureCompanionExecutionReadset(bob, { sources: captured.sources });
  expect(await verifyCompanionExecutionReadset(proof, bob, { request })).toBe(true);
  store.request({ type: 'loop.save', checkpoint: { ...checkpoint, turns: [{ text: 'NEW_FORMAL_QUOTE_694', rawText: 'NEW_FORMAL_QUOTE_694', calls: [] }] }, executionReadset: sourceProof });
  expect(store.getMessage(bubble.id)).toMatchObject({ content: 'NEW_FORMAL_QUOTE_694' });
  expect(await verifyCompanionExecutionReadset(proof, bob, { request })).toBe(false);
  expect(proof.sources.find(source => source.id === bubble.id)?.checksum).toBe(hash(original.content));
  const current = companionModelWorld(store.request({ type: 'world.observe', ...bob }).world, 'bob')!;
  expect(current.events.some(event => event.kind === 'visit_response')).toBe(false);
  expect(current.visits[0]?.response).toBe('房主已回应拜访请求');
  expect(JSON.stringify(current)).not.toContain('OLD_FORMAL_QUOTE_593');
  expect(JSON.stringify(current)).not.toContain('NEW_FORMAL_QUOTE_694');
});
