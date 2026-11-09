import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { botRequestSchema } from '../../src/shared/companion-bot';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';

class Memory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No VCP process in this protocol test'); }, embedding: async () => { throw Error('No model'); } }); }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { appended: [] }; }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'native', evidence: '已核验的VCP证据', metadata: {}, events: [], status: 'ready', omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
}
class Brain extends BotDshBrain {
  calls: BotDshRun[] = [];
  execute: (input: BotDshRun) => Promise<Partial<BotDshResult>> = async () => ({ text: '原生最终正文' });
  constructor() { super({ getHost: async () => { throw Error('Only native adapter boundary is mocked'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    if (input.laneId.startsWith('memory-')) return { sessionId: this.session(input), eventId: input.eventId, status: 'succeeded', text: '{"notes":[]}' };
    this.calls.push(input);
    return { sessionId: this.session(input), eventId: input.eventId, status: 'succeeded', text: '', ...await this.execute(input) };
  }
  private session(input: BotDshRun) { return BotDshBrain.sessionId(input.laneId); }
  override async archive() {}
  override async close() {}
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-native-service-')), brain = new Brain();
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.join(root, 'builtins') });
  const service = new BotService({ root, brain, media, memory: new Memory(path.join(root, 'memory')),
    model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', model: 'fixture', apiKey: 'test-only' }), onEvent: () => undefined });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, room = snapshot.conversations[0]!;
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const send = (content: string) => service.handle({ type: 'message.send', conversationId: room.id, content, requestId: 'native-' + ++sequence });
  return { root, brain, service, room, send };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() > end) throw Error('Native service did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function callback(input: BotDshRun, name: string, args: object, callId = 'native-tool') {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!result.ok) throw Error(result.error); return result.result;
}
it('routes each message to a fresh DSH session in the same companion workspace without replaying chat history', async () => {
  const f = await fixture();
  const first = await f.send('第一轮的私有上下文');
  await until(() => f.service.store.getMessage(first.replyMessageIds![0]!)?.status === 'sent');
  const second = await f.send('第二轮');
  await until(() => f.service.store.getMessage(second.replyMessageIds![0]!)?.status === 'sent');
  expect(f.brain.calls).toHaveLength(2);
  expect(f.brain.calls[0]!.laneId).not.toBe(f.brain.calls[1]!.laneId);
  expect(f.brain.calls[0]!.cwd).toBe(f.brain.calls[1]!.cwd);
  expect(f.brain.calls[1]!.prompt).not.toContain('第一轮的私有上下文');
  expect(f.brain.calls[1]!.prompt).toContain('已核验的VCP证据');
  expect(f.brain.calls[1]).toMatchObject({ role: 'worker', workerAccess: 'full', tools: [] });
  expect(f.service.store.getMessage(second.replyMessageIds![0]!)!.content).toBe('原生最终正文');
});
it('projects real native deliveries onto the reply and preserves process separately from final text', async () => {
  const f = await fixture();
  f.brain.execute = async input => {
    const file = path.join(input.cwd, 'native-report.txt'); await writeFile(file, 'DSH原生产物');
    input.onEvent?.({ type: 'tool_call', sequence: 1, receivedAt: new Date().toISOString(), toolName: 'present' });
    input.onEvent?.({ type: 'artifacts', sequence: 2, receivedAt: new Date().toISOString(), artifacts: [{ path: file }] });
    return { text: '最终交付正文', artifacts: [{ path: file }] };
  };
  const sent = await f.send('写一份文件');
  await until(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
  const snapshot = (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!;
  const reply = snapshot.messages.find(message => message.id === sent.replyMessageIds![0])!;
  expect(reply.content).toBe('最终交付正文'); expect(reply.attachments).toHaveLength(1);
  expect(reply.attachments![0]!.name).toBe('native-report.txt');
  expect(reply.execution).toMatchObject({ status: 'succeeded', steps: [{ toolName: 'present' }, { type: 'artifacts' }] });
});
it('keeps a native question pending and resumes that exact session after the user answers', async () => {
  const f = await fixture();
  f.brain.execute = async input => ({ text: '用户选择：' + (await callback(input, 'chat_ask_user', { question: '选择红色还是蓝色？' }) as { text: string }).text });
  const sent = await f.send('需要一个选择');
  let questionId = '';
  await until(async () => { const reply = (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!.messages.find(message => message.id === sent.replyMessageIds![0]); questionId = reply?.execution?.question?.id ?? ''; return !!questionId; });
  await f.service.handle({ type: 'execution.answer', messageId: sent.replyMessageIds![0]!, questionId, text: '蓝色' });
  await until(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
  expect(f.brain.calls).toHaveLength(1); expect(f.service.store.getMessage(sent.replyMessageIds![0]!)!.content).toBe('用户选择：蓝色');
});
it('removes application task APIs and custom file delivery tools', () => {
  expect(botRequestSchema.safeParse({ type: 'task.list', conversationId: 'room' }).success).toBe(false);
  for (const name of ['dsh_task', 'dsh_plan', 'chat_send_file', 'worker_chat_send_file']) expect(BOT_TOOLS.some(tool => tool.name === name)).toBe(false);
});
