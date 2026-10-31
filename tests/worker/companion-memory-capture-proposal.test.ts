import { mkdtemp, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionCaptureProposalCheckpoint } from '../../src/main/companions/memory-capture-proposal';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemoryJob } from '../../src/shared/companion-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-capture-proposal-'));
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '初始角色。', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  const alice = store.state().companions.find(owner => owner.id === 'alice')!, scope = { companionId: alice.id, conversationId: store.openPrivate(alice.id).id };
  const previous = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '旧素材说明纸盒放在东柜。', replyDirective: 'none' });
  const memory = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: previous.content,
    sourceMessageIds: [previous.id], evidence: [{ sourceMessageId: previous.id, quote: previous.content }], tags: [], metadata: { autoTags: false } } }).memories![0]!;
  for (;;) { const item = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!item) break; store.request({ type: 'memory.outbox.complete', id: item.id, leaseToken: item.leaseToken, indexed: true }); }
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '新纸张要放入这个纸盒。', replyDirective: 'none' });
  const files = await canonicalMemoryFiles(root, store, { apiFormat: 'openai_chat', model: 'synthetic-no-http', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' });
  const config = await files.configFor(alice), claim = () => store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  const open = (job: CompanionMemoryJob) => CompanionCaptureProposalCheckpoint.open(files.request, job, config, alice, [], [], 'policy-same');
  const proposal = { notes: [{ artifactKind: 'episode_memory' as const, content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [], relatedMemoryIds: [memory.id] }] };
  const job = claim(), checkpoint = await open(job);
  await checkpoint.options([memory], [], 1).onProposal!(proposal);
  return { root, store, files, config, scope, memory, source, job, checkpoint, claim, open, proposal,
    async close() { await files.close(); store.close(); await removeOwnedDirectory(root); } };
}

it('restores exact actual historical bodies and cached checker results under a new lease while preserving original state CAS', async () => {
  const f = await fixture();
  try {
    const input = { content: f.source.content, tags: [], prohibitions: [{ id: 'policy', tags: ['家庭住址'], persistent: true }] }, generate = vi.fn(async () => true);
    expect(await f.checkpoint.options([], []).prohibitionCheck!(input, generate)).toBe(true);
    f.store.request({ type: 'memory.jobs.defer', id: f.job.id, leaseToken: f.job.leaseToken, error: '模型队列暂不可用', retryAfterMs: 1000 });
    f.store.request({ type: 'memory.jobs.retry-admission', companionId: 'alice' });
    const job = f.claim(); expect(job.leaseToken).not.toBe(f.job.leaseToken);
    const restored = await f.open(job), read = await restored.restore();
    expect(read!.memories[0]).toMatchObject({ id: f.memory.id, content: f.memory.content, contentRevision: f.memory.contentRevision });
    expect(restored.expectedStateRevision(999)).toBe(1);
    expect(await restored.options(read!.memories, []).prohibitionCheck!(input, generate)).toBe(true); expect(generate).toHaveBeenCalledTimes(1);
    await expect(f.files.request({ type: 'memory.jobs.proposal.save', id: job.id, leaseToken: f.job.leaseToken,
      proposal: f.store.request({ type: 'memory.jobs.proposal.read', id: job.id, leaseToken: job.leaseToken }).memoryCaptureProposal! })).rejects.toThrow();
  } finally { await f.close(); }
});

it.each(['missing_history', 'forgotten_dependency', 'changed_prompt'] as const)('does not reuse a staged paid proposal after %s', async invalidation => {
  const f = await fixture();
  try {
    if (invalidation === 'missing_history') {
      const artifact = await (await f.files.profiles.artifacts('alice')).get(`history:${f.memory.id}:r${f.memory.contentRevision}`);
      if (!artifact) throw new Error('Missing actual registered history.');
      await unlink(path.join(f.root, 'owner-assets', 'alice', artifact.relativePath));
    } else if (invalidation === 'forgotten_dependency') f.store.request({ type: 'memory.forget', ...f.scope, id: f.memory.id });
    else {
      const assets = await f.files.profiles.load('alice'), role = assets.modules.find(module => module.purposes.includes('vcp_experience_journal'))!;
      const registry = await f.files.profiles.artifacts('alice'), artifact = (await registry.findByPath(role.path))!;
      expect(artifact.kind).toBe('processor_prompt');
      await registry.publish({ artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath, content: role.content + '\n新的文件规则。\n',
        expectedRevision: artifact.contentRevision, producer: { kind: 'host', id: 'synthetic-processor-maintenance' }, sourceRefs: artifact.sourceRefs,
        dependencyRefs: artifact.dependencyRefs, visibility: artifact.visibility, allowedConsumers: artifact.allowedConsumers, retentionClass: artifact.retentionClass,
        operationId: 'processor:' + randomUUID() });
    }
    if (invalidation === 'forgotten_dependency') { await expect(f.open(f.job)).rejects.toThrow('租约已失效'); return; }
    const restored = await f.open(f.job);
    if (invalidation === 'changed_prompt') { expect(await restored.restore()).toBeUndefined(); expect(restored.options([], []).proposal).toBeUndefined(); }
    else await expect(restored.restore()).rejects.toThrow();
  } finally { await f.close(); }
});

it('rejects a forged cohort/source digest and retires its proposal when the real input is withdrawn', async () => {
  const f = await fixture();
  try {
    const saved = f.store.request({ type: 'memory.jobs.proposal.read', id: f.job.id, leaseToken: f.job.leaseToken }).memoryCaptureProposal!;
    expect(() => f.store.request({ type: 'memory.jobs.proposal.save', id: f.job.id, leaseToken: f.job.leaseToken,
      proposal: { ...saved, sourceVersions: saved.sourceVersions.map(source => ({ ...source, checksum: 'f'.repeat(64) })) } })).toThrow('原始来源');
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
    await expect(f.open(f.job)).rejects.toThrow();
  } finally { await f.close(); }
});
it.each(['before_dispatch_guard', 'during_dispatch_guard'] as const)('rejects revoked queued capture input %s and cancels the host lifecycle before HTTP', async timing => {
  const f = await fixture();
  try {
    const withdraw = () => f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
    const finish = vi.fn(async () => undefined), beforeDispatch = vi.fn(async () => {
      if (timing === 'during_dispatch_guard') withdraw();
      return finish;
    });
    if (timing === 'before_dispatch_guard') withdraw();
    const guarded = f.checkpoint.modelConfig({ ...f.config, providerLifecycle: { beforeDispatch } });
    await expect(guarded.providerLifecycle!.beforeDispatch()).rejects.toThrow();
    expect(beforeDispatch).toHaveBeenCalledTimes(timing === 'during_dispatch_guard' ? 1 : 0);
    if (timing === 'during_dispatch_guard') expect(finish).toHaveBeenCalledExactlyOnceWith('cancelled_before_send', 0);
    else expect(finish).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
