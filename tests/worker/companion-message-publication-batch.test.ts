import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionPublishedActionFrontier } from '../../src/shared/companion-message-publication';
import { CompanionExecutionSourceStore } from '../../src/companions/execution-source-store';
import { readPublishedMessageActionPins } from '../../src/companions/published-message-action-pins';
import { readPublishedDependencyCut } from '../../src/companions/published-dependency-index';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const connections: CompanionConnection[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.close();
  for (const f of fixtures.splice(0)) await f.close();
});

function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  connections.push(db);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const source = f.source('每个真实任务都有准确原始来源。');
  const readset = (owner: string, sources: CompanionMessage[]): CompanionExecutionReadset => ({
    schema: 'worldlinebox.companion-execution-readset-v1', complete: true, companionId: owner,
    conversationId: f.store.openPrivate(owner).id, memories: [], contexts: [], knowledgeReads: [], topics: [],
    sources: sources.map(value => ({ id: value.id, conversationId: value.conversationId, checksum: hash(value.content) })),
  });
  const action = (owner: string, origin: CompanionMessage, title: string) => {
    const scope = { companionId: owner, conversationId: origin.conversationId };
    const value = f.store.request({ type: 'action.create', action: { ...scope, sourceMessageId: origin.id, title, status: 'queued' },
      checkpoint: { prompt: title, executionReadset: readset(owner, [origin]) } }).action!;
    f.store.request({ type: 'action.update', id: value.id, patch: { status: 'succeeded', result: title + '的真实结果。' } });
    const message = f.store.messages({ conversationId: scope.conversationId }).messages.find(item => item.actionId === value.id)!;
    expect(message).toBeDefined(); return { action: value, message };
  };
  const append = (owner: string, content: string, sources: CompanionMessage[]) => f.store.appendMessage({
    authorId: owner, conversationId: f.store.openPrivate(owner).id, content, executionReadset: readset(owner, sources),
  });
  const observe = (message: CompanionMessage) => {
    // Reference: the original certification algorithm resolved one root at a
    // time. Keep that real Store path as the per-root expected action subset.
    const proofs = f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources!;
    const candidate = proofs.find(proof => proof.kind === 'message' && proof.id === message.id)?.publicationCandidate;
    expect(candidate).toBeDefined();
    const pins = proofs.filter(proof => proof.kind === 'action').map(proof => proof.storageActionBinding!);
    expect(pins.every(Boolean)).toBe(true);
    return { candidate: candidate!, pins };
  };
  const count = (table: 'companion_message_publication_certificates' | 'companion_message_publication_action_pins') =>
    Number((db.prepare('SELECT COUNT(*) AS count FROM ' + table).get() as { count: number }).count);
  return { f, db, source, action, append, observe, readset, count };
}

it.each(['new_publication', 'revalidated_historical'] as const)('resolves a %s batch once while preserving exact per-root shared/disjoint/cross-owner pins', mode => {
  const h = fixture(), shared = h.action('alice', h.source, '共享任务'), exclusive = h.action('alice', h.source, '独立任务');
  const foreignSource = h.f.source('另一位伙伴自己的真实来源。', 'bob'), foreign = h.action('bob', foreignSource, '另一位伙伴的任务');
  const roots = Array.from({ length: 10 }, (_, index) => h.append('alice', '共享来源的正式结果 ' + index,
    index % 2 ? [shared.message] : [shared.message, exclusive.message]));
  roots.push(h.append('alice', '没有任务义务的独立结果。', [h.source]));
  roots.push(h.append('bob', '另一位伙伴正式结果。', [foreign.message]));
  const references = roots.map(root => h.observe(root));
  const bindings = [...new Map(references.flatMap(reference => reference.pins).map(pin => [pin.id, pin])).values()];
  const resolve = vi.spyOn(CompanionExecutionSourceStore.prototype, 'resolve');
  const response = h.f.store.request({ type: 'execution.message.certify', messages: references.map(reference => ({ ...reference.candidate, mode })), actionBindings: bindings });
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]![0]).toEqual(roots.map(root => root.id));
  expect(response.messagePublicationCertificates).toHaveLength(roots.length);
  for (const [index, certificate] of response.messagePublicationCertificates!.entries()) {
    expect(certificate.mode).toBe(mode);
    expect(readPublishedMessageActionPins(h.db, certificate)).toEqual([...references[index]!.pins].sort((a, b) => a.id.localeCompare(b.id)));
    const cut = readPublishedDependencyCut(h.db, certificate.messageId);
    expect(cut).toBeDefined();
    expect(cut!.volatileActions.map(pin => pin.id).sort()).toEqual(references[index]!.pins.map(pin => pin.id).sort());
  }
  resolve.mockClear();
  h.f.store.request({ type: 'execution.message.certify', messages: references.map(reference => ({ ...reference.candidate, mode })), actionBindings: bindings });
  expect(resolve).toHaveBeenCalledOnce(); // No result crosses the request boundary.
});

it.each(['missing', 'cycle', 'forgotten', 'wrong-owner', 'body'] as const)('rolls back every candidate when one root has a late %s change', change => {
  const h = fixture(), first = h.append('alice', '仍有效的独立发言。', [h.source]);
  const origin = h.f.source('只属于另一条结果的独立原始来源。');
  const second = h.append('alice', '必须准确匹配的第二条发言。', [origin]);
  const references = [h.observe(first), h.observe(second)];
  if (change === 'forgotten') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [origin.id] });
  else if (change === 'body') h.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('已变化的正式发言。', second.id);
  else if (change === 'wrong-owner') references[1]!.candidate = { ...references[1]!.candidate, companionId: 'bob' };
  else {
    const proof = h.readset('alice', [origin]);
    proof.sources = [{ id: change === 'cycle' ? second.id : 'missing-source', conversationId: second.conversationId,
      checksum: hash(change === 'cycle' ? second.content : '缺失来源') }];
    h.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(proof), 'message-execution-readset/' + second.id);
  }
  expect(() => h.f.store.request({ type: 'execution.message.certify', messages: references.map(reference => ({ ...reference.candidate, mode: 'new_publication' as const })) })).toThrow();
  expect(h.count('companion_message_publication_certificates')).toBe(0);
  expect(h.count('companion_message_publication_action_pins')).toBe(0);
});

it('keeps a changed supplied action binding fail-closed without issuing any sibling certificate', () => {
  const h = fixture(), task = h.action('alice', h.source, '准确任务');
  const roots = [h.append('alice', '引用这项任务的结果。', [task.message]), h.append('alice', '不依赖任务的独立结果。', [h.source])];
  const references = roots.map(h.observe), wrong: CompanionPublishedActionFrontier = { ...references[0]!.pins[0]!, companionId: 'bob' };
  expect(() => h.f.store.request({ type: 'execution.message.certify', messages: references.map(reference => ({ ...reference.candidate, mode: 'revalidated_historical' as const })), actionBindings: [wrong] })).toThrow('Main');
  expect(h.count('companion_message_publication_certificates')).toBe(0);
  expect(h.count('companion_message_publication_action_pins')).toBe(0);
});

it('does not turn a correctly supplied partial action frontier into a closed publication index', () => {
  const h = fixture(), first = h.action('alice', h.source, '已提供准确pin的任务'), second = h.action('alice', h.source, '仍需完整Main门的任务');
  const root = h.append('alice', '两个真实任务共同支持这条发言。', [first.message, second.message]), reference = h.observe(root);
  const response = h.f.store.request({ type: 'execution.message.certify', messages: [{ ...reference.candidate, mode: 'revalidated_historical' }],
    actionBindings: reference.pins.filter(pin => pin.id === first.action.id) });
  expect(response.messagePublicationCertificates).toHaveLength(1);
  expect(readPublishedMessageActionPins(h.db, response.messagePublicationCertificates![0]!)).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, root.id)).toBeUndefined();
});

it.each([false, true])('does not let a missing sibling pin hide a supplied mismatch in either root order (reverse=%s)', reverse => {
  const h = fixture(), shared = h.action('alice', h.source, '没有Main pin的共享任务'), own = h.action('alice', h.source, 'Main pin不一致的任务');
  const roots = [h.append('alice', '只有缺失pin的分支。', [shared.message]),
    h.append('alice', '先遇自己的任务再遇共享任务。', [own.message, shared.message])];
  if (reverse) roots.reverse();
  const references = roots.map(h.observe);
  const binding = references.flatMap(reference => reference.pins).find(pin => pin.id === own.action.id)!;
  expect(() => h.f.store.request({ type: 'execution.message.certify', messages: references.map(reference => ({ ...reference.candidate,
    mode: 'new_publication' as const })), actionBindings: [{ ...binding, companionId: 'bob' }] })).toThrow('Main');
  expect(h.count('companion_message_publication_certificates')).toBe(0);
  expect(h.count('companion_message_publication_action_pins')).toBe(0);
});
