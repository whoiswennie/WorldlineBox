import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import { generateCompanionText } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const enabled = process.env.WORLDLINEBOX_CONTENT_EVALUATION === '1';

it.skipIf(!enabled)('audits two resident identities and virtual dates through original timelines with actual global chat and bundled embeddings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-timeline-real-'));
  const output = path.resolve('artifacts/vcp-validation/timeline-identity-real.json');
  const started = performance.now(), calls: Array<Record<string, unknown>> = [], errors: string[] = [];
  const published = new Map<string, VcpMemoryTimelineArtifacts>();
  const assertions: Array<{ name: string; passed: boolean }> = [];
  let native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined, store: CompanionsStore | undefined, service: CompanionMemoryService | undefined;
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), status: 'running', fixtureOnly: true,
    realUserDataModified: false, plaintextApiKeyPersisted: false, realGlobalChat: true, realBundledEmbedding: true,
    vendorSourcesChanged: false, assertions, calls, errors,
    limitations: ['Two synthetic, evidence-bound diaries exercise owner identity and virtual event dates in original VCP monthly timeline and summary generation. This is not a broad memory-quality benchmark.',
      'Diaries are seeded through the real source ledger; automatic diary writing, peer scheduling and dreams are covered by separate acceptance scenarios.'] };
  try {
    const config = await realGlobalChatConfig(root); report.chatModel = config.model; report.apiFormat = config.apiFormat;
    const residents = [{ id: 'little-fish', name: '小肥鱼', persona: '轻快谨慎，会区分约定与已经发生的事实。', occurredAt: '2026-10-16T01:10:00Z', date: '2026-10-16',
      content: '【隔离验收的合成已发生经历；虚拟世界时间2026-10-16 09:10】我（小肥鱼）在自己的窗边给薄荷浇水，随后和白幻约好下午去她家串门。目前只是约定，我尚未出门。白幻答应给我留温水。', tags: ['白幻', '薄荷', '串门约定'] },
    { id: 'big-fish', name: '大肥鱼', persona: '沉稳细致，不把阅读和他人的建议写成亲历成果。', occurredAt: '2026-10-17T07:20:00Z', date: '2026-10-17',
      content: '【隔离验收的合成已发生经历；虚拟世界时间2026-10-17 15:20】我（大肥鱼）在虚拟书房整理一本航海笔记，把蓝色书签夹在第十二页。我向黑幻请教海图符号，她建议我先核对图例。我还没有出海，也没有把这份建议当成已验证的航海技能。', tags: ['黑幻', '航海笔记', '图例'] }];
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), residents.map(owner => ({ ...owner, description: '', model: '', avatar: 'sister', proactive: false, active: true })));
    const sourceNotes = residents.map(owner => {
      const conversation = store!.openPrivate(owner.id);
      const source = store!.appendMessage({ conversationId: conversation.id, authorId: owner.id, content: owner.content, replyDirective: 'none' });
      const note = store!.request({ type: 'memory.record', companionId: owner.id, conversationId: conversation.id,
        candidate: { content: owner.content, tags: owner.tags, diaryName: '日记', occurredAt: owner.occurredAt,
          sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: owner.content }] } }).memories![0]!;
      // The subject of this case is already-written diaries, not another journal-model run.
      for (let n = 0; n < 10; n++) {
        const job = store!.request({ type: 'memory.jobs.claim', companionId: owner.id }).memoryJob;
        if (!job) break;
        store!.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
      }
      return { owner, conversationId: conversation.id, note };
    });
    const fetchFn: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
      const system = body.messages?.find(message => message.role === 'system')?.content ?? '';
      const owner = residents.find(owner => system.includes(`伙伴「${owner.name}」`));
      const at = performance.now(), response = await fetch(input, init);
      const payload = await response.clone().json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
      calls.push({ purpose: /月度时间线摘要器/u.test(system) ? 'original_vcp_summary' : 'original_vcp_timeline', owner: owner?.id,
        elapsedMs: performance.now() - at, output: payload.choices?.[0]?.message?.content, finishReason: payload.choices?.[0]?.finish_reason,
        usage: payload.usage ?? null, responseStatus: response.status });
      return response;
    };
    native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { fetchFn, timeoutMs: 90000 }));
    report.embeddingProfile = native.profile;
    service = new CompanionMemoryService({ request: async command => { const result = store!.request(command); if (result.worldClock) result.worldClock.backlog = false; return result; },
      configFor: async () => config, runtime: native.runtime, cacheRoot: path.join(root, 'views'), fetchFn,
      busy: () => false, blocked: () => false, changed: () => undefined,
      report: error => errors.push(error instanceof Error && /[\u4e00-\u9fff]/u.test(error.message) ? error.message : 'TIMELINE_OPERATION_FAILED'),
      onTimelineArtifacts: async (scope, artifacts, stillValid) => { if (await stillValid()) published.set(scope.companionId, artifacts); } });
    while (published.size < residents.length || residents.some(owner => !service!.processingFor(owner.id).some(job => job.status === 'completed'))) {
      service.schedule(0);
      if (performance.now() - started > 240000) throw new Error('REAL_TIMELINE_ACCEPTANCE_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    for (const { owner, note } of sourceNotes) {
      const artifacts = published.get(owner.id)!, month = artifacts.agents.find(agent => agent.agentName === owner.name)?.months.find(month => month.month === '2026-10');
      const text = (month?.content ?? '') + '\n' + (month?.summary ?? '');
      const actual = store.request({ type: 'memory.read', companionId: owner.id, conversationId: note.sourceConversationId, id: note.id }).memoryRead!.memory;
      assertions.push({ name: owner.name + '的稳定身份和当前姓名贯穿时间线', passed: JSON.stringify(artifacts.owner) === JSON.stringify(companionMemoryIdentity(owner)) && artifacts.agents.length === 1 && artifacts.agents[0]?.agentName === owner.name && !!month?.content?.includes(owner.name) });
      assertions.push({ name: owner.name + '的事件日期来自虚拟世界来源', passed: !!month?.content?.includes(owner.date) && actual.occurredAt === owner.occurredAt });
      assertions.push({ name: owner.name + '没有被改写成应用或另一位伙伴', passed: !/WorldlineBox/iu.test(text) && !text.includes(residents.find(other => other.id !== owner.id)!.name) });
      assertions.push({ name: owner.name + '的来源原文和修订未被月报改写', passed: actual.content === note.content && actual.version === note.version && !!month?.summary?.trim() });
    }
    assertions.push({ name: '只调用两份原版月报和两份摘要，使用实际模型输出', passed: calls.length === 4 && calls.filter(call => call.purpose === 'original_vcp_timeline').length === 2 && calls.filter(call => call.purpose === 'original_vcp_summary').length === 2 && calls.every(call => typeof call.output === 'string' && call.output.length > 0) });
    report.outputs = Object.fromEntries(published); report.elapsedMs = performance.now() - started;
    report.sourceDiaries = sourceNotes.map(({ owner, note }) => ({ ownerId: owner.id, ownerName: owner.name, noteId: note.id, occurredAt: note.occurredAt, recordedAt: note.createdAt, content: note.content }));
    report.processing = residents.map(owner => ({ ownerId: owner.id, jobs: service!.processingFor(owner.id) }));
    report.status = assertions.every(assertion => assertion.passed) ? 'passed' : 'failed';
    expect(assertions.filter(assertion => !assertion.passed), JSON.stringify(report.outputs)).toEqual([]);
  } catch (error) { report.status = 'failed'; report.errorCode = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : 'REAL_TIMELINE_ASSERTION_FAILED'; throw error; }
  finally {
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
    try { await service?.close(); } finally { try { await native?.close(); } finally { store?.close(); await removeOwnedDirectory(root); } }
  }
}, 300000);
