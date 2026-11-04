import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import type { BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { NativeHostEvent } from '../../src/main/dsh/native-host-client';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const roots: string[] = [], brains: BotAppBrain[] = [];
afterEach(async () => {
  for (const brain of brains.splice(0)) await brain.close();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('bot-app-brain-')) throw new Error('Unexpected test root');
    await rm(resolved, { recursive: true, force: true });
  }
});

async function workspace() { const root = await mkdtemp(path.join(tmpdir(), 'bot-app-brain-')); roots.push(root); return root; }
function own(brain: BotAppBrain) { brains.push(brain); return brain; }
function input(root: string, eventId = 'ordinary-1'): BotDshRun {
  return { laneId: 'companion-lane', eventId, cwd: root, system: '你是大肥鱼。自然回应，只依据真实工具回执说明执行情况。', prompt: '今晚只有20分钟，一起整理一个小角落吧。',
    model: { apiFormat: 'openai_chat', model: 'local-protocol-fixture', baseUrl: 'https://model.invalid/v1', apiKey: 'local-fixture-no-billing' },
    tools: [], callback: { url: 'http://127.0.0.1:1/bot/tool', token: 'fixture-unused' } };
}
function stream(frames: unknown[]): Response {
  const encoded = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const frame of frames) controller.enqueue(encoded.encode(`data: ${JSON.stringify(frame)}\n\n`));
    controller.enqueue(encoded.encode('data: [DONE]\n\n')); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const text = (value: string, finish: string | null = null) => ({ choices: [{ index: 0, delta: { content: value }, finish_reason: finish }] });
function toolFrames(id = 'provider-tool-1') {
  return [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'chat_send_sticker', arguments: '{"sticker' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"builtin-encourage"}' } }] }, finish_reason: 'tool_calls' }] }];
}
const stickerTool = { name: 'chat_send_sticker', description: '发送已查询到的真实表情', parameters: { type: 'object', properties: { stickerId: { type: 'string' } }, required: ['stickerId'], additionalProperties: false } };
type RequestBody = { messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>; stream?: boolean; tools?: unknown[]; max_tokens?: number };
const requestBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as RequestBody;

/** A separate process really exits after an external write, before the caller
 * can save its tool receipt. Recovery is not simulated by editing SQLite. */
async function crashAfterPublication(root: string, tool: BotDshRun['tools'][number] = stickerTool, args: Record<string, unknown> = { stickerId: 'builtin-encourage' }) {
  const entry = path.join(root, 'crash-before-receipt.cjs');
  await writeFile(entry, `
    const fs = require('node:fs'), ts = require('typescript');
    require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
    const { writeFile } = require('node:fs/promises');
    const path = require('node:path');
    const { BotAppBrain } = require(${JSON.stringify(path.resolve('src/main/companion-bot/app-brain.ts'))});
    (async () => {
    const root = process.argv[2];
    const frames = ${JSON.stringify(toolFrames())};
    frames[0].choices[0].delta.tool_calls[0].function.name = ${JSON.stringify(tool.name)};
    frames[0].choices[0].delta.tool_calls[0].function.arguments = ${JSON.stringify(JSON.stringify(args).slice(0, 8))};
    frames[1].choices[0].delta.tool_calls[0].function.arguments = ${JSON.stringify(JSON.stringify(args).slice(8))};
    const brain = new BotAppBrain({ root,
      fetchFn: async () => new Response(frames.map(value => 'data: ' + JSON.stringify(value) + '\\n\\n').join('') + 'data: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}}),
      callTool: async () => {
        await writeFile(path.join(root, 'external-publication.json'), JSON.stringify({sent:true,messageId:'published-before-crash',attachmentIds:['already-visible-sticker']}));
        process.exit(73);
      }
    });
    await brain.run(${JSON.stringify({ ...input(root, 'crash-window'), tools: [tool] })});
    process.exit(74);
    })().catch(error => { console.error(error); process.exit(75); });
  `);
  const exit = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: [path.resolve('node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) } });
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Crash fixture did not reach its publication')); }, 30000);
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stderr }); });
  });
  expect(exit, exit.stderr).toMatchObject({ code: 73 });
  return JSON.parse(await readFile(path.join(root, 'external-publication.json'), 'utf8')) as { sent: boolean; messageId: string; attachmentIds: string[] };
}

it('streams an ordinary app-owned reply directly from the model without any DSH Host or callback', async () => {
  const root = await workspace(), events: NativeHostEvent[] = [];
  const callTool = vi.fn(async () => { throw new Error('Ordinary chat must not call a tool'); });
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://model.invalid/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-fixture-no-billing');
    expect(requestBody(init)).toMatchObject({ stream: true });
    expect(requestBody(init).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' })]));
    return stream([text('先挑一个'), text('手掌大的角落吧。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, fetchFn, callTool }));
  const result = await brain.run({ ...input(root), onEvent: event => events.push(event) });
  expect(result).toMatchObject({ status: 'succeeded', eventId: 'ordinary-1', text: '先挑一个手掌大的角落吧。' });
  expect(events.filter(event => event.type === 'text_stream').map(event => event.text)).toEqual(['先挑一个', '先挑一个手掌大的角落吧。']);
  expect(events.at(-1)).toMatchObject({ type: 'complete', status: 'succeeded', text: result.text });
  expect(fetchFn).toHaveBeenCalledTimes(1); expect(callTool).not.toHaveBeenCalled();
});

it('executes one streamed tool call and gives its real receipt back to the model before the final reply', async () => {
  const root = await workspace(), bodies: RequestBody[] = [], events: NativeHostEvent[] = [];
  const receipt = { sent: true, messageId: 'actual-media-message', attachmentIds: ['actual-sticker-ref'] };
  const callTool = vi.fn(async (call: BotToolCall) => { expect(call.eventId).toBe('with-sticker'); return receipt; });
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init); bodies.push(body);
    if (bodies.length === 1) return stream(toolFrames());
    const result = body.messages.find(message => message.role === 'tool');
    expect(result?.tool_call_id).toBe(callTool.mock.calls[0]?.[0].callId);
    expect(JSON.parse(String(result?.content))).toMatchObject(receipt);
    const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.length === 1);
    expect(assistant).toBeDefined();
    expect((assistant?.tool_calls?.[0] as { id: string }).id).toBe(result?.tool_call_id);
    return stream([text('好，一起从这个角落开始。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, fetchFn, callTool }));
  const result = await brain.run({ ...input(root, 'with-sticker'), tools: [stickerTool], onEvent: event => events.push(event) });
  expect(result.status).toBe('succeeded'); expect(fetchFn).toHaveBeenCalledTimes(2); expect(callTool).toHaveBeenCalledTimes(1);
  expect(callTool.mock.calls[0]?.[0]).toMatchObject({ laneId: 'companion-lane', eventId: 'with-sticker', name: 'chat_send_sticker', args: { stickerId: 'builtin-encourage' } });
  expect(events.some(event => event.type === 'tool_call' && event.toolName === 'chat_send_sticker')).toBe(true);
});

it('reopens durable app state and replays a completed tool turn without another model request or publication', async () => {
  const root = await workspace(); let requests = 0;
  const fetchFn = vi.fn(async () => ++requests === 1 ? stream(toolFrames()) : stream([text('已经发到聊天里，一起开始吧。', 'stop')]));
  const callTool = vi.fn(async () => ({ sent: true, messageId: 'once-only-message', attachmentIds: ['once-only-media'] }));
  const event = { ...input(root, 'durable-publication'), tools: [stickerTool] };
  const first = own(new BotAppBrain({ root, fetchFn, callTool })), result = await first.run(event);
  await first.close(); brains.splice(brains.indexOf(first), 1);
  const reopened = own(new BotAppBrain({ root, fetchFn, callTool }));
  expect(await reopened.run(event)).toEqual(result);
  expect(fetchFn).toHaveBeenCalledTimes(2); expect(callTool).toHaveBeenCalledTimes(1);
});

it('cancels a live model stream with a durable cancelled outcome and no later tool publication', async () => {
  const root = await workspace(), abort = new AbortController(), events: NativeHostEvent[] = [];
  let firstText!: () => void;
  const received = new Promise<void>(resolve => { firstText = resolve; });
  const callTool = vi.fn(async () => { throw new Error('No tool is allowed after cancellation'); });
  const cancelledReader = vi.fn();
  const fetchFn = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(text('先选一个小角落'))}\n\n`)); },
    cancel: cancelledReader,
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const brain = own(new BotAppBrain({ root, fetchFn, callTool }));
  const running = brain.run({ ...input(root, 'cancelled-stream'), signal: abort.signal, onEvent: event => {
    events.push(event); if (event.type === 'text_stream') firstText();
  } }).catch((error: { result?: unknown }) => error.result ?? error);
  await received; abort.abort(new Error('User stopped the reply'));
  expect(await running).toMatchObject({ status: 'cancelled', eventId: 'cancelled-stream' });
  expect(cancelledReader).toHaveBeenCalledTimes(1); expect(callTool).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(events.some(event => event.type === 'complete' && event.status === 'succeeded')).toBe(false);
  await brain.close(); brains.splice(brains.indexOf(brain), 1);
  const reopened = own(new BotAppBrain({ root, fetchFn, callTool }));
  expect(await reopened.run(input(root, 'cancelled-stream'))).toMatchObject({ status: 'cancelled', eventId: 'cancelled-stream' });
  expect(fetchFn).toHaveBeenCalledTimes(1); expect(callTool).not.toHaveBeenCalled();
});

it('recovers an externally committed write after a real process exit without sending that write twice', async () => {
  const root = await workspace(), receipt = await crashAfterPublication(root);
  const callTool = vi.fn(async () => { throw new Error('The previous process already published the sticker'); });
  const reconcileTool = vi.fn(async (call: BotToolCall) => {
    expect(call).toMatchObject({ eventId: 'crash-window', name: 'chat_send_sticker', args: { stickerId: 'builtin-encourage' } });
    return { state: 'committed' as const, result: receipt };
  });
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const history = requestBody(init).messages;
    expect(JSON.parse(String(history.find(message => message.role === 'tool')?.content))).toMatchObject(receipt);
    return stream([text('表情已经在聊天中，继续吧。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, callTool, reconcileTool, fetchFn }));
  expect(await brain.run({ ...input(root, 'crash-window'), tools: [stickerTool] })).toMatchObject({ status: 'succeeded' });
  expect(reconcileTool).toHaveBeenCalledTimes(1); expect(callTool).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('keeps an unknown interrupted write fenced instead of guessing that it was absent and republishing it', async () => {
  const root = await workspace(); await crashAfterPublication(root);
  const callTool = vi.fn(async () => { throw new Error('An unknown external effect cannot be repeated'); });
  const fetchFn = vi.fn(async () => { throw new Error('Unresolved effect must be reconciled before continuation'); });
  const reconcileTool = vi.fn(async () => ({ state: 'unknown' as const }));
  const brain = own(new BotAppBrain({ root, callTool, reconcileTool, fetchFn }));
  await expect(brain.run({ ...input(root, 'crash-window'), tools: [stickerTool] })).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
  expect(reconcileTool).toHaveBeenCalledTimes(1); expect(callTool).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled();
});

it('can repeat an interrupted read when reconciliation has no receipt instead of fencing it as a write', async () => {
  const root = await workspace();
  const tool = { name: 'memory_history', description: '回查当前受众的原话', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'], additionalProperties: false } };
  const args = { keyword: '20分钟' };
  await crashAfterPublication(root, tool, args);
  const receipt = { sources: [{ messageId: 'original-source', content: '今晚我只有20分钟。' }] };
  const reconcileTool = vi.fn(async () => ({ state: 'unknown' as const }));
  const callTool = vi.fn(async (call: BotToolCall) => { expect(call).toMatchObject({ name: 'memory_history', args }); return receipt; });
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(requestBody(init).messages.find(message => message.role === 'tool')?.content))).toEqual(receipt);
    return stream([text('查到原话了，今晚只有20分钟。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, callTool, reconcileTool, fetchFn }));
  expect(await brain.run({ ...input(root, 'crash-window'), tools: [tool] })).toMatchObject({ status: 'succeeded' });
  expect(reconcileTool).toHaveBeenCalledTimes(1); expect(callTool).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('blocks newer events behind an unresolved write in the same lane while another companion lane can still chat', async () => {
  const root = await workspace(); let requests = 0;
  const fetchFn = vi.fn(async () => ++requests === 1 ? stream(toolFrames()) : stream([text('另一位伙伴仍然可以正常回应。', 'stop')]));
  const callTool = vi.fn(async () => { throw new Error('The publication connection ended before its receipt'); });
  const brain = own(new BotAppBrain({ root, fetchFn, callTool }));
  await expect(brain.run({ ...input(root, 'unknown-earlier'), tools: [stickerTool] })).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
  await expect(brain.run(input(root, 'newer-same-lane'))).rejects.toMatchObject({ code: 'BOT_LANE_BUSY' });
  expect(fetchFn).toHaveBeenCalledTimes(1); expect(callTool).toHaveBeenCalledTimes(1);
  expect(await brain.run({ ...input(root, 'other-companion'), laneId: 'independent-companion-lane' })).toMatchObject({ status: 'succeeded', text: '另一位伙伴仍然可以正常回应。' });
  expect(fetchFn).toHaveBeenCalledTimes(2); expect(callTool).toHaveBeenCalledTimes(1);
});

it('bounds repeated-turn model context with durable summaries while preserving the current request', async () => {
  const root = await workspace(), limit = 8192;
  let expectedTrigger = '';
  const summarize = vi.fn(async () => '历史摘要：用户只整理一个小角落，今晚限制20分钟；所有已完成动作都以回执为准。');
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const messages = requestBody(init).messages;
    expect(JSON.stringify(messages).length).toBeLessThanOrEqual(limit);
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: expectedTrigger });
    return stream([text('保持这个范围，不用一下收拾完。'.repeat(25), 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, fetchFn, summarize, maxContextChars: limit }));
  for (let index = 0; index < 8; index++) {
    expectedTrigger = `第${index}轮：` + '当前只讨论这个小角落里的物品。'.repeat(110);
    expect(await brain.run({ ...input(root, `bounded-${index}`), prompt: expectedTrigger })).toMatchObject({ status: 'succeeded' });
  }
  expect(fetchFn).toHaveBeenCalledTimes(8); expect(summarize).toHaveBeenCalled();
});

it('rejects a current request that cannot fit rather than silently truncating it or transmitting an oversized context', async () => {
  const root = await workspace();
  const fetchFn = vi.fn(async () => { throw new Error('Oversized current input must not reach the provider'); });
  const brain = own(new BotAppBrain({ root, fetchFn, maxContextChars: 4096 }));
  await expect(brain.run({ ...input(root, 'oversized-current'), prompt: '必须完整保留的用户请求。'.repeat(800) })).rejects.toThrow(/上下文|容量|context/i);
  expect(fetchFn).not.toHaveBeenCalled();
});

it('keeps both Chinese conversation and real summary requests inside the configured model capacity', async () => {
  const root = await workspace(), contextWindow = 4096; let expectedTrigger = '', normal = 0, summaries = 0;
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init), serialized = String(init?.body);
    expect(Buffer.byteLength(serialized, 'utf8') + 256 + (body.max_tokens ?? 0)).toBeLessThanOrEqual(contextWindow);
    if (body.messages.some(message => message.role === 'user' && message.content === expectedTrigger)) {
      normal++; expect(body.messages.at(-1)?.content).toBe(expectedTrigger);
      return stream([text('先保持这个小角落的范围。'.repeat(3), 'stop')]);
    }
    summaries++;
    return stream([text('历史事实：用户今晚只有20分钟，只整理桌面一个小角落；没有替用户实际收拾。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, fetchFn }));
  for (let index = 0; index < 8; index++) {
    expectedTrigger = '本轮还在整理桌面一个小角落。'.repeat(18) + `当前步骤${index}`;
    const request = input(root, `chinese-capacity-${index}`);
    expect(await brain.run({ ...request, prompt: expectedTrigger, model: { ...request.model, contextWindow, maxTokens: 256 } })).toMatchObject({ status: 'succeeded' });
  }
  expect(normal).toBe(8); expect(summaries).toBeGreaterThan(0);
});

it('preserves confirmed tool pairs when a later model request fails and does not replay the completed effect', async () => {
  const root = await workspace(), receipt = { sent: true, messageId: 'confirmed-before-provider-failure', attachmentIds: ['published-sticker'] };
  let requests = 0;
  const callTool = vi.fn(async () => receipt);
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    if (requests === 1) return stream(toolFrames());
    if (requests === 2) return new Response('Unavailable', { status: 503 });
    const history = requestBody(init).messages;
    expect(history.some(message => message.role === 'assistant' && message.tool_calls?.length === 1)).toBe(true);
    expect(JSON.parse(String(history.find(message => message.role === 'tool')?.content))).toMatchObject(receipt);
    return stream([text('刚才的表情已经在聊天里，这次继续聊。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, fetchFn, callTool }));
  await expect(brain.run({ ...input(root, 'confirmed-then-failed'), tools: [stickerTool] })).rejects.toMatchObject({ code: 'BOT_TERMINAL_FAILED', inputContextCommitted: true });
  expect(await brain.run(input(root, 'after-confirmed-failure'))).toMatchObject({ status: 'succeeded' });
  expect(callTool).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(3);
});

it('continues 12 large-receipt tool steps inside 32k, pages exact raw evidence after restart, and refuses another lane', async () => {
  const root = await workspace(), contextWindow = 32768, trigger = '回查原话，看看有哪些表情，继续这件事。';
  const original = '【精确原话，不可概括】今晚我只有20分钟，只整理桌面一个小角落。' + '请只动这个角落，剩下的留给下次。'.repeat(110);
  const sources = Array.from({ length: 100 }, (_, index) => ({ messageId: `source-message-${index}`, eventId: `source-event-${index}`, senderId: 'user',
    content: index === 0 ? original : `第${index}条独立原文：` + '原始历史资料包含中文，分页读取必须保留正确归属。'.repeat(90) }));
  const stickers = Array.from({ length: 80 }, (_, index) => ({ id: `builtin-sticker-${index}`, packId: 'kaguya',
    originalName: `八千代-${'一起开工然后认真鼓励对方。'.repeat(14)}-${index}.gif`, name: `表情${index}`, description: '源文件动作描述，长名称仍要能找到对应的真实编号。'.repeat(28), tags: ['开工', '鼓励'] }));
  const historyResult = { status: 'success', sources }, stickerResult = { status: 'success', stickers };
  expect(Buffer.byteLength(JSON.stringify(historyResult), 'utf8')).toBeGreaterThan(contextWindow);
  expect(Buffer.byteLength(JSON.stringify(stickerResult), 'utf8')).toBeGreaterThan(contextWindow);
  const tools = [{ name: 'memory_history', description: '回查当前受众的原话', parameters: { type: 'object', properties: { keyword: { type: 'string' } } } },
    { name: 'chat_list_stickers', description: '查看真实表情及原文件名', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
  const external: BotToolCall[] = [], firstCalls = new Map<string, string>();
  const callTool = vi.fn(async (call: BotToolCall) => {
    external.push(call); if (!firstCalls.has(call.name)) firstCalls.set(call.name, call.callId);
    if (call.name === 'memory_history') return historyResult;
    if (call.name === 'chat_list_stickers') return stickerResult;
    throw new Error('Internal receipt reading must not be dispatched to an external tool');
  });
  let normalRequests = 0, sawWorkingLedger = false;
  type Action = { name: string; args(): Record<string, unknown>; verify?(value: Record<string, unknown>): void };
  const actions: Action[] = Array.from({ length: 12 }, (_, index) => ({ name: index % 2 ? 'chat_list_stickers' : 'memory_history',
    args: () => index % 2 ? { query: `开工${index}` } : { keyword: `20分钟${index}` },
    verify: value => { expect(value).toMatchObject({ kind: 'durable_tool_result_view', callId: external.at(-1)!.callId });
      expect(JSON.stringify(value)).toContain('agent_read_tool_result'); expect(JSON.stringify(value)).toContain('omitted'); } }));
  const receivedPages: string[] = [];
  const readOriginal = (offset: number): Action => ({ name: 'agent_read_tool_result',
    args: () => ({ callId: firstCalls.get('memory_history')!, jsonPath: '/sources/0/content', offset, limit: 1024 }),
    verify: value => { expect(value).toMatchObject({ kind: 'tool_result_page', offset, total: original.length });
      const chunk = String(value.value); expect(chunk.length).toBeGreaterThan(0); expect(chunk.length).toBeLessThanOrEqual(1024);
      expect(chunk).toBe(original.slice(offset, offset + chunk.length)); receivedPages.push(chunk);
      if (value.nextOffset !== undefined) { expect(value.nextOffset).toBe(offset + chunk.length); actions.splice(normalRequests, 0, readOriginal(Number(value.nextOffset))); }
      else expect(offset + chunk.length).toBe(original.length); } });
  actions.push(readOriginal(0));
  for (const offset of [78, 79]) actions.push({ name: 'agent_read_tool_result',
    args: () => ({ callId: firstCalls.get('chat_list_stickers')!, jsonPath: '/stickers', offset, limit: 1 }),
    verify: value => { expect(value).toMatchObject({ kind: 'tool_result_page', offset, total: 80 });
      expect(value.value).toEqual([expect.objectContaining({ id: `builtin-sticker-${offset}` })]); } });
  actions.push({ name: 'agent_read_tool_result', args: () => ({ callId: firstCalls.get('chat_list_stickers')!, jsonPath: '/stickers/79/originalName', offset: 0, limit: 4096 }),
    verify: value => { expect(value.value).toBe(stickers[79]!.originalName); } });
  // Several sizeable, distinct source pages force current-step compaction too;
  // tiny receipt views alone may legitimately fit without a working ledger.
  for (let index = 1; index <= 5; index++) actions.push({ name: 'agent_read_tool_result',
    args: () => ({ callId: firstCalls.get('memory_history')!, jsonPath: `/sources/${index}/content`, offset: 0, limit: 4096 }),
    verify: value => { const chunk = String(value.value); expect(value).toMatchObject({ kind: 'tool_result_page', offset: 0, total: sources[index]!.content.length });
      expect(chunk.length).toBeGreaterThan(1024); expect(chunk).toBe(sources[index]!.content.slice(0, chunk.length));
      if (value.nextOffset !== undefined) expect(value.nextOffset).toBe(chunk.length); } });
  const replyToTool = (name: string, args: Record<string, unknown>, id: string) => stream([{ choices: [{ index: 0, delta: {
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
  const assertBudget = (init?: RequestInit) => { const body = requestBody(init);
    expect(Buffer.byteLength(String(init?.body), 'utf8') + 256 + (body.max_tokens ?? 0)).toBeLessThanOrEqual(contextWindow); return body; };
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = assertBudget(init);
    if (!body.tools?.length) return stream([text('已确认历史资料和表情查询的回执存在，精确原话与原文件名必须通过回执分页读取，不将摘要当原文。', 'stop')]);
    expect(body.messages.some(message => message.role === 'user' && message.content === trigger)).toBe(true);
    for (const message of body.messages) {
      let value: Record<string, unknown>; try { value = JSON.parse(String(message.content)) as Record<string, unknown>; } catch { continue; }
      if (value?.kind !== 'durable_tool_steps_summary') continue;
      sawWorkingLedger = true;
      expect(Number(value.confirmedCalls)).toBeGreaterThan(0);
      expect(value.read).toMatchObject({ tool: 'agent_read_tool_result', callId: 'turn:large-current-tool-loop', jsonPath: '/steps' });
    }
    const previous = actions[normalRequests - 1];
    if (previous?.verify) previous.verify(JSON.parse(String(body.messages.findLast(message => message.role === 'tool')?.content)) as Record<string, unknown>);
    const next = actions[normalRequests++];
    return next ? replyToTool(next.name, next.args(), `protocol-step-${normalRequests}`) : stream([text('核对了原话、表情和对应编号，可以继续。', 'stop')]);
  });
  const brain = own(new BotAppBrain({ root, fetchFn, callTool })), request = { ...input(root, 'large-current-tool-loop'), prompt: trigger, tools };
  request.model = { ...request.model, contextWindow, maxTokens: 512 };
  expect(await brain.run(request)).toMatchObject({ status: 'succeeded' });
  expect(external).toHaveLength(12); expect(normalRequests).toBe(actions.length + 1); expect(receivedPages.join('')).toBe(original);
  expect(sawWorkingLedger).toBe(true);
  await brain.close(); brains.splice(brains.indexOf(brain), 1);
  let probeStep = 0, probeOffset = 0, expectedValue = '', isForeign = false;
  const durablePieces: string[] = [];
  const nextProbe = () => replyToTool('agent_read_tool_result', { callId: firstCalls.get('memory_history')!, jsonPath: '/sources/99/content', offset: probeOffset, limit: 512 }, `read-durable-raw-${probeOffset}`);
  const probeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = assertBudget(init);
    if (!body.tools?.length) return stream([text('历史工具结果仍以耐久回执为准。', 'stop')]);
    if (probeStep++ === 0) return nextProbe();
    const page = JSON.parse(String(body.messages.findLast(message => message.role === 'tool')?.content)) as Record<string, unknown>;
    if (isForeign) { expect(page).toEqual({ error: '当前上下文没有可读取的已确认工具回执。' }); expect(JSON.stringify(page)).not.toContain(String(expectedValue)); }
    else {
      const chunk = String(page.value); expect(page.offset).toBe(probeOffset); expect(chunk).toBe(expectedValue.slice(probeOffset, probeOffset + chunk.length)); durablePieces.push(chunk);
      if (page.nextOffset !== undefined) { expect(page.nextOffset).toBe(probeOffset + chunk.length); probeOffset = Number(page.nextOffset); return nextProbe(); }
      expect(durablePieces.join('')).toBe(expectedValue);
    }
    return stream([text(isForeign ? '当前上下文不能读取那份资料。' : '精确原文仍可读取。', 'stop')]);
  });
  const reopened = own(new BotAppBrain({ root, fetchFn: probeFetch, callTool }));
  expectedValue = sources[99]!.content;
  expect(await reopened.run({ ...request, eventId: 'read-after-restart', prompt: '读取之前的精确原文。' })).toMatchObject({ status: 'succeeded' });
  probeStep = 0; probeOffset = 0; isForeign = true;
  expect(await reopened.run({ ...request, laneId: 'unrelated-private-lane', eventId: 'foreign-result-read', prompt: '读取那个编号。' })).toMatchObject({ status: 'succeeded' });
  expect(external).toHaveLength(12);
});

it('makes progress through one-unit receipt pages without dropping emoji or looping on an empty page', async () => {
  const root = await workspace(), original = '🐳大肥鱼🌙', pieces: string[] = [];
  const tool = { name: 'memory_history', description: '回查原话', parameters: { type: 'object', properties: { keyword: { type: 'string' } } } };
  let callId = '', requests = 0, offset = 0;
  const callTool = vi.fn(async (call: BotToolCall) => { expect(call.name).toBe('memory_history'); callId = call.callId; return { content: original }; });
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init);
    if (!body.tools?.length) return stream([text('精确原话在工具回执中，按分页读取。', 'stop')]);
    const call = (name: string, args: Record<string, unknown>) => stream([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `unicode-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
    if (requests++ === 0) return call('memory_history', { keyword: '大肥鱼' });
    if (requests > 2) {
      const page = JSON.parse(String(body.messages.findLast(message => message.role === 'tool')?.content)) as { value: string; offset: number; nextOffset?: number };
      expect(page.offset).toBe(offset); expect(page.value.length).toBeGreaterThan(0); pieces.push(page.value);
      if (page.nextOffset === undefined) { expect(pieces.join('')).toBe(original); return stream([text('已完整读取原话。', 'stop')]); }
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    }
    return call('agent_read_tool_result', { callId, jsonPath: '/content', offset, limit: 1 });
  });
  const brain = own(new BotAppBrain({ root, fetchFn, callTool }));
  expect(await brain.run({ ...input(root, 'unicode-tiny-pages'), prompt: '精确读取这句话。', tools: [tool] })).toMatchObject({ status: 'succeeded' });
  expect(callTool).toHaveBeenCalledTimes(1); expect(pieces.join('')).toBe(original);
});
