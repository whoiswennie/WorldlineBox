import { mkdtemp, readdir, unlink } from 'node:fs/promises';
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
  const memory = store.saveMemory({ ...scope, content: '旧素材说明纸盒放在东柜。', tags: [] });
  for (;;) { const item = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!item) break; store.request({ type: 'memory.outbox.complete', id: item.id, leaseToken: item.leaseToken, indexed: true }); }
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '新纸张要放入这个纸盒。', replyDirective: 'none' });
  const files = await canonicalMemoryFiles(root, store, { apiFormat: 'openai_chat', model: 'synthetic-no-http', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' });
  const config = await files.configFor(alice), claim = () => store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  const open = (job: CompanionMemoryJob) => CompanionCaptureProposalCheckpoint.open(files.request, job, config, alice, [], [], 'policy-same');
  const proposal = { notes: [{ content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [], relatedMemoryIds: [memory.id] }] };
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
    f.store.request({ type: 'memory.jobs.defer', id: f.job.id, leaseToken: f.job.leaseToken, error: '本地预算', retryAfterMs: 1000 });
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
      const folder = path.join(f.root, 'owner-assets', 'alice', '记忆历史', f.memory.id), file = (await readdir(folder)).find(name => name.endsWith('.md'))!;
      await unlink(path.join(folder, file));
    } else if (invalidation === 'forgotten_dependency') f.store.request({ type: 'memory.forget', ...f.scope, id: f.memory.id });
    else {
      const assets = await f.files.profiles.load('alice'), role = assets.modules.find(module => module.purposes.includes('vcp_experience_journal'))!;
      await f.files.profiles.writePrompt({ companionId: 'alice', relativePath: role.path, expectedRevision: role.revision, content: role.content + '\n新的文件规则。' });
    }
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
it.each(['before_accounting', 'after_accounting'] as const)('rejects revoked queued capture input %s and leaves no charged or unfinished HTTP reservation', async timing => {
  const f = await fixture();
  try {
    const withdraw = () => f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
    const beforeRequest = vi.fn(async (...args: Parameters<NonNullable<typeof f.config.providerBudget>['beforeRequest']>) => {
      const finish = await f.config.providerBudget!.beforeRequest(...args);
      if (timing === 'after_accounting') withdraw();
      return finish;
    });
    if (timing === 'before_accounting') withdraw();
    const guarded = f.checkpoint.modelConfig({ ...f.config, providerBudget: { beforeRequest } });
    await expect(guarded.providerBudget!.beforeRequest(100, 100, 'journal')).rejects.toThrow();
    expect(beforeRequest).toHaveBeenCalledTimes(timing === 'after_accounting' ? 1 : 0);
    expect(f.store.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage).toMatchObject({ requests: 0, unfinished: 0 });
  } finally { await f.close(); }
});
