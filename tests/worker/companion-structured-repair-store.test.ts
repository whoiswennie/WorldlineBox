import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionAgentRun } from '../../src/shared/companion-agent-run';
import { companionContextFrameSchema } from '../../src/shared/companion-cognition';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
const seeds = [{ id: 'alice', name: 'Alice', description: '', persona: '核对真实来源。', model: '', avatar: 'sister' as const, proactive: false, active: true }];
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-structured-repair-store-')) throw new Error('Unexpected repair fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-structured-repair-store-')); roots.push(root);
  const filename = path.join(root, 'state.sqlite'); let store = new CompanionsStore(filename, seeds); stores.add(store);
  const room = store.openPrivate('alice'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '核对本轮资料，只读。', replyDirective: 'none' });
  let run: CompanionAgentRun = { id: 'repair_run', companionId: 'alice', conversationId: room.id, invocationId: 'repair_fixture', requestDigest: sha('fixture'),
    revision: 0, status: 'running', turns: [{ text: '', rawText: '{"answer":12}', calls: [] }],
    sources: [{ id: source.id, conversationId: room.id, checksum: sha(source.content) }], memories: [], effects: [] };
  const save = (next = structuredClone(run)) => {
    const candidate = { ...next, revision: run.revision + 1 };
    const response = store.request({ type: 'agent.run.save', run: candidate, expectedRevision: run.revision });
    expect(response.ok).toBe(true); run = candidate; return structuredClone(run);
  };
  save();
  const attempted = () => { const next = structuredClone(run); next.turns[0]!.structuredRepair = { originalHash: sha(next.turns[0]!.rawText), attempts: 1 }; return save(next); };
  const succeeded = () => { const next = structuredClone(run), content = '{"answer":"核对完成"}'; next.turns[0]!.structuredRepair = {
    ...next.turns[0]!.structuredRepair!, content, contentHash: sha(content) }; return save(next); };
  return { get store() { return store; }, current: () => structuredClone(run), save, attempted, succeeded,
    reopen: () => { store.close(); stores.delete(store); store = new CompanionsStore(filename, seeds); stores.add(store); },
    read: () => store.request({ type: 'agent.run.get', companionId: 'alice', id: run.id }).agentRun! };
}

it('retains a successful repair across a real SQLite restart and permits identical repeated saves', () => {
  const f = fixture(); f.attempted(); f.save(); f.succeeded(); const expected = f.save();
  f.reopen(); expect(f.read()).toEqual(expected); expect(f.read().turns[0]!.rawText).toBe('{"answer":12}');
});

it('rejects attempt rollback, skipped attempts and fabricated success without a prior attempt', () => {
  const f = fixture(), forged = f.current();
  forged.turns[0]!.structuredRepair = { originalHash: sha(forged.turns[0]!.rawText), attempts: 2 };
  expect(() => f.save(forged)).toThrow('次数');
  const noAttempt = f.current(); noAttempt.turns[0]!.structuredRepair = { originalHash: sha(noAttempt.turns[0]!.rawText), attempts: 1,
    content: '{}', contentHash: sha('{}') }; expect(() => f.save(noAttempt)).toThrow('次数');
  f.attempted(); const second = f.current(); second.turns[0]!.structuredRepair!.attempts = 2; f.save(second);
  const rollback = f.current(); rollback.turns[0]!.structuredRepair!.attempts = 1; expect(() => f.save(rollback)).toThrow('次数');
  expect(f.read().turns[0]!.structuredRepair!.attempts).toBe(2);
});

it.each(['content', 'originalHash', 'remove'] as const)('rejects %s changes to a successful repair without replacing its original proposal', mode => {
  const f = fixture(); f.attempted(); const saved = f.succeeded(), changed = f.current();
  if (mode === 'remove') delete changed.turns[0]!.structuredRepair;
  else if (mode === 'content') { changed.turns[0]!.structuredRepair!.content = '{"answer":"伪造的新回答"}'; changed.turns[0]!.structuredRepair!.contentHash = sha(changed.turns[0]!.structuredRepair!.content!); }
  else changed.turns[0]!.structuredRepair!.originalHash = sha('another proposal');
  expect(() => f.save(changed)).toThrow(); expect(f.read()).toEqual(saved);
});

it('rejects repair receipts on capability turns and on already completed valid finals', () => {
  const f = fixture(), capability = f.current();
  capability.turns[0]!.calls = [{ id: 'native', name: 'memory', arguments: '{}' }];
  capability.turns[0]!.structuredRepair = { originalHash: sha(capability.turns[0]!.rawText), attempts: 1 };
  expect(() => f.save(capability)).toThrow();
  const done = f.current(); done.status = 'done'; const saved = f.save(done);
  const tampered = f.current(); tampered.turns[0]!.structuredRepair = { originalHash: sha(tampered.turns[0]!.rawText), attempts: 1 };
  expect(() => f.save(tampered)).toThrow(); expect(f.read()).toEqual(saved);
});

it('requires the raw final decision to be committed before any paid repair attempt can be recorded', () => {
  const f = fixture(), next = f.current(); next.turns.push({ text: '', rawText: '{}', calls: [], structuredRepair: { originalHash: sha('{}'), attempts: 1 } });
  expect(() => f.save(next)).toThrow('先保存原始最终提案'); expect(f.read().turns).toHaveLength(1);
});

it.each(['owner', 'profile', 'sources', 'input'] as const)('refuses a different %s in the immutable original request repair receipt', changed => {
  const f = fixture(), next = f.current();
  const frame = companionContextFrameSchema.parse({ schema: 'worldlinebox.companion-context-v2', companionId: 'alice', purpose: 'fixture', profileRevision: '1'.repeat(64),
    promptRevision: '2'.repeat(64), revocationEpoch: 0, invocationId: 'actual_provider_invocation', identity: '仅本人的身份', roleGuidance: '', processorContract: '', input: '实际已发送输入' });
  const context = { system: '本次职能', user: '实际已发送输入', frame,
    hash: sha(JSON.stringify(['本次职能', '实际已发送输入', frame])) };
  next.turns[0]!.structuredRepair = { originalHash: sha(next.turns[0]!.rawText), attempts: 1, rootContext: context };
  const saved = f.save(next), forged = f.current(), root = forged.turns[0]!.structuredRepair!.rootContext!;
  if (changed === 'owner') root.frame.companionId = 'another_owner';
  else if (changed === 'profile') root.frame.profileRevision = '4'.repeat(64);
  else if (changed === 'sources') root.frame.sourceRefs = [{ artifactId: 'source:another', contentRevision: 1, contentHash: '3'.repeat(64) }];
  else root.user = '替换原始输入';
  root.hash = sha(JSON.stringify([root.system, root.user, root.frame]));
  expect(() => f.save(forged)).toThrow(); f.reopen(); expect(f.read()).toEqual(saved);
});
