import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { companionStorageResponseSchema, type CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => fetch(url, init) } }));
const names = ['林澄', '周岚', '顾宁', '沈星', '许棠', '乔雨', '陆川', '苏禾'];
const ids = names.map((_, index) => `group_peer_${index}`);
const Database = BetterSqlite3 as { new(filename: string, options: { readonly: boolean }): CompanionConnection };

/** This is the production WorldService -> SQLite claim -> actual model ->
 * completion path. Only the initial utterance and topic admission are host
 * fixture setup; no fixture chooses or generates the subsequent speakers. */
it.skipIf(process.env.WORLDLINEBOX_PEER_GROUP_ACCEPTANCE !== '1')('lets the actual peer scheduler give eight real members independent, scoped model turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-peer-group-real-'));
  const config = await realGlobalChatConfig(root), marker = randomUUID();
  const startedAt = new Date().toISOString(), started = performance.now();
  const output = path.resolve('artifacts/companion-agent-acceptance/peer-group-content.json');
  const privateCanary = `OBSERVER_PRIVATE_${marker}`, otherTopicCanary = `OTHER_TOPIC_${marker}`;
  const faults: string[] = [], claims: CompanionSocialJob[] = [], completions: unknown[] = [];
  const modelCalls: Array<{ data: Record<string, unknown>; status?: number }> = [];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [...ids, 'outside_observer'].map((id, index) => ({
    id, name: names[index] ?? '旁观者', avatar: 'sister', model: '', active: true, proactive: false,
    description: '具有独立判断的露营讨论参与者', persona: `你是${names[index] ?? '旁观者'}，保持自己的真实身份。喜欢认真而简短地交流，提出自己的实际建议，不能替其他成员说话。` })));
  const request = async (command: CompanionStorageCommand) => {
    const result = companionStorageResponseSchema.parse(store.request(command));
    if (command.type === 'social.job.claim' && result.socialJob) claims.push(result.socialJob);
    if (command.type === 'social.job.complete') completions.push({ actor: claims.find(job => job.id === command.id)?.companionId,
      jobId: command.id, text: command.text, nextRecipientId: command.nextRecipientId,
      message: result.socialMessage?.message, pending: result.socialPending });
    if (command.type === 'social.job.fail') faults.push(command.error);
    return result;
  };
  function findContext(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'string') { try { return findContext(JSON.parse(value)); } catch { return undefined; } }
    if (!value || typeof value !== 'object') return undefined;
    if ('purpose' in value && value.purpose === 'world_social') return value as Record<string, unknown>;
    for (const child of Object.values(value)) { const result = findContext(child); if (result) return result; }
    return undefined;
  }
  const fetchFn: typeof fetch = async (url, init) => {
    const data = findContext(JSON.parse(String(init?.body ?? '{}'))), call = data ? { data, status: undefined as number | undefined } : undefined;
    if (call) modelCalls.push(call);
    const response = await fetch(url, init); if (call) call.status = response.status; return response;
  };
  const service = new CompanionWorldService({ request, configFor: async () => config, fetchFn,
    // This fixture has no indexed memories. Supply the real source revision
    // with an explicitly empty recall instead of the unsupported SQLite-only
    // search fallback; this acceptance does not claim to test VCP retrieval.
    recall: async input => {
      const snapshot = store.request({ type: 'memory.snapshot', companionId: input.companion.id,
        conversationId: input.conversation.id, beforeSequence: input.beforeSequence }).memorySnapshot!;
      return { memories: [], sources: [], reasons: [], pending: false, degraded: false,
        context: { text: '', revision: snapshot.revision, profileKey: 'empty-peer-acceptance-index' } };
    },
    memoryContextValid: async (scope, context) => !context || store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.revision === context.revision,
    changed: () => undefined, wakeWaiting: () => undefined, report: error => faults.push(error instanceof Error ? error.message : String(error)) });
  const inspect = new Database(path.join(root, 'messages.sqlite'), { readonly: true });
  onTestFinished(async () => { await service.close(); inspect.close(); store.close(); });
  let status = 'running', roomId = '', topicId = '';
  try {
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now - 30000);
    for (const companionId of ids) { const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
      store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
        patch: { timeZone: 'UTC', wakeAt: '00:01', sleepAt: '23:59', meals: [], habits: [] } }); }
    vi.setSystemTime(now); store.request({ type: 'world.tick' }); vi.useRealTimers();
    const observer = store.openPrivate('outside_observer');
    store.appendMessage({ conversationId: observer.id, authorId: 'user', content: privateCanary, replyDirective: 'none' });
    const playerRoom = store.openPrivate(ids[0]!);
    const delegation = store.appendMessage({ conversationId: playerRoom.id, authorId: 'user', content: '请邀请这七位同伴讨论露营准备，每人自主给出建议。', replyDirective: 'none' });
    const room = store.request({ type: 'social.conversation.ensure', companionId: ids[0]!, memberIds: ids }).socialConversation!; roomId = room.id;
    const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: ids[0]!, title: '八人露营讨论', kind: 'discussion', participantIds: ids.slice(1), tags: ['真实群聊验收'] }).topic!; topicId = topic.id;
    // Admission is setup, not evidence that the models autonomously joined.
    for (const readerId of ids.slice(1)) store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId });
    const unrelated = store.request({ type: 'topic.create', conversationId: room.id, readerId: ids[0]!, title: '无关话题', kind: 'discussion', participantIds: ids.slice(1) }).topic!;
    store.appendMessage({ conversationId: room.id, authorId: ids[0]!, topicId: unrelated.id, content: otherTopicCanary });
    store.request({ type: 'topic.activate', conversationId: room.id, readerId: ids[0]!, topicId: topic.id });
    const initial = { type: 'social.send' as const, conversationId: room.id, companionId: ids[0]!, authorizationMessageId: delegation.id,
      channel: 'phone' as const, clientId: `peer-group-${marker}`,
      content: `我是林澄，想和大家商量一次两天露营的准备，讨论标记${marker}。我先建议核对天气和营地规定。请周岚、顾宁、沈星、许棠、乔雨、陆川、苏禾各自用自己的姓名开头，提出一项你认为重要的准备建议及理由；可补充已见到的实际建议，不要替别人说话。我们只交流，不安排现实任务，不操作电脑；没有必要硬问下一位，若没内容也可以不说。` };
    expect(store.request(initial).socialPending).toBe(true);
    service.start();
    const deadline = Date.now() + 360000;
    for (;;) {
      const accepted = completions.filter(item => item && typeof item === 'object' && 'actor' in item).map(item => (item as { actor: string }).actor);
      if (ids.slice(1).every(id => accepted.includes(id))) {
        const pending = inspect.prepare("SELECT COUNT(*) AS n FROM companion_social_jobs WHERE conversation_id=? AND (status IN('pending','running') OR status='failed' AND json_extract(data,'$.attempts')<8)").get(room.id) as { n: number };
        if (!pending.n) break;
      }
      if (Date.now() > deadline) throw Error('Actual WorldService did not complete every first opportunity');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await service.close();
    const messages = store.request({ type: 'messages', conversationId: room.id, topicId: topic.id, limit: 100 }).messages ?? [];
    const actualReplies = messages.filter(message => message.id !== claims[0]?.sourceMessageId);
    expect(claims.slice(0, 7).map(job => job.companionId).sort()).toEqual(ids.slice(1).sort());
    expect(new Set(claims.map(job => job.chainId)).size).toBe(1); expect(claims.length).toBeLessThanOrEqual(9);
    expect(completions.length).toBeGreaterThanOrEqual(7);
    expect(new Set(actualReplies.map(message => message.authorId)).size).toBeGreaterThanOrEqual(4);
    for (const message of actualReplies) { expect(message.topicId).toBe(topic.id); expect(ids).toContain(message.authorId);
      expect(message.content).toContain(names[ids.indexOf(message.authorId)]!); expect(message.content).not.toContain(privateCanary); expect(message.content).not.toContain(otherTopicCanary); }
    expect(modelCalls.length).toBeGreaterThanOrEqual(7);
    for (const call of modelCalls) { expect(call.status).toBe(200); expect(JSON.stringify(call.data)).not.toContain(privateCanary); expect(JSON.stringify(call.data)).not.toContain(otherTopicCanary);
      const identity = call.data.identity as { self: { id: string } }; expect(ids).toContain(identity.self.id);
      const invocation = call.data.invocation as { topicId: string; participants: string[]; authorization: { externalActions: boolean } };
      expect(invocation.topicId).toBe(topic.id); expect(invocation.participants.slice().sort()).toEqual(ids.slice().sort()); expect(invocation.authorization.externalActions).toBe(false); }
    expect(room.memberIds).not.toContain('user'); expect(room.memberIds).not.toContain('outside_observer');
    expect(store.request({ type: 'actions' }).actions).toEqual([]); expect(store.request({ type: 'work.list' }).works).toEqual([]);
    expect(faults).toEqual([]); status = 'passed';
  } catch (error) { status = 'failed'; faults.push(error instanceof Error ? error.message : String(error)); throw error; }
  finally {
    vi.useRealTimers(); await service.close();
    const messages = roomId ? store.request({ type: 'messages', conversationId: roomId, topicId: topicId || undefined, limit: 100 }).messages : [];
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      provider: { apiFormat: config.apiFormat, model: config.model }, boundary: { initialMessage: 'host fixture seed', topicAdmission: 'host fixture setup',
        replies: 'production WorldService social.job.claim -> actual model -> social.job.complete',
        memoryRetrieval: 'empty fixture index with actual SQLite source revision; VCP retrieval not under test', externalActions: false },
      roomId, topicId, memberIds: ids, claims, completions, messages, modelCalls, faults }, null, 2));
  }
}, 420000);
