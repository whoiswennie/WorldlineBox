import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryMessage } from '../../src/main/vcp-memory/contracts';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Real unchanged VCP JS/Rust graph and the original AIMemo handler. The local
 * deterministic model checks exact prompt/orchestration parity, not NL quality. */
it('releases the graph before focusing, survives worker LRU, and matches original exact model inputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-detached-native-'));
  let modelRelease!: () => void, modelEntered!: () => void;
  const entered = new Promise<void>(resolve => { modelEntered = resolve; });
  const release = new Promise<void>(resolve => { modelRelease = resolve; });
  let blockModel = false;
  const prompts: unknown[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw);
    if (Array.isArray(body.input)) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [.8, .3, .2, .1] })) })); return;
    }
    prompts.push(body);
    if (blockModel) { modelEntered(); await release; }
    const text = `这是我获取的所有相关知识/记忆[[聚焦 ${createHash('sha256').update(body.messages[0].content).digest('hex')}]]`;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  let client: VcpMemoryClient | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server not listening.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const launch = (file: string): VcpMemoryTransport => {
      const child = fork(file, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      return { postMessage: message => child.send(message as object), on: child.on.bind(child), kill: () => { child.kill(); } };
    };
    client = new VcpMemoryClient({ dataRoot: root, vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
      embedding: { baseUrl, apiKey: 'fixture', model: 'detached-native', dimension: 4 }, plugins: { chat: { baseUrl, model: 'detached-native', apiKey: 'fixture' }, behaviorProfile: 'upstream' },
      launch, maxOpenScopes: 1, requestTimeoutMs: 90_000 });
    const scope = { scopeId: 'alice' }, direct = { scopeId: 'original-parity' };
    const notes = [0, 1, 2].map(index => ({ id: 'alice-note-' + index, content: `umbrella 雨伞约定${index}：下雨不出门，尚未完成。`, tags: ['umbrella', '约定'], author: 'alice', occurredAt: '2026-10-25T01:02:03Z' }));
    await client.replace(scope, notes);
    const messages: VcpMemoryMessage[] = [{ role: 'system', content: '[[AIMemo=True]]\n[[memories日记本::RiverMemo::AIMemo+]]' }, { role: 'user', content: 'umbrella 雨伞的约定是什么？' }];
    const clock = { now: '2026-10-26T03:04:05Z', timeZone: 'Asia/Shanghai' };
    const prepared = await client.prepareRecall(scope, messages, clock);
    expect(prompts).toEqual([]);
    expect(prepared.contextReferences.length).toBeGreaterThan(0);
    blockModel = true;
    const focusing = client.focusRecall(prepared, { validate: async () => undefined });
    await entered;
    // A pending remote model does not occupy the original worker command.
    await client.remember(scope, { ...notes[0]!, content: '新的无关修订；旧任务继续使用原候选。' });
    // With a single process permit, opening this scope must retire Alice's
    // original worker while her immutable candidate package remains usable.
    await client.replace(direct, notes);
    expect(client.hasOpenScope(scope)).toBe(false);
    blockModel = false; modelRelease();
    const detached = await focusing, detachedPrompts = structuredClone(prompts); prompts.length = 0;
    const original = await client.preprocess(direct, messages, clock);
    expect(prompts).toEqual(detachedPrompts);
    expect(detached.messages).toEqual(original.messages);
    const keys = (items = prepared.contextReferences) => items.map(({ id, role, textHash }) => ({ id, role, textHash })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(keys(detached.contextReferences)).toEqual(keys(original.contextReferences));
    prompts.length = 0;
    await client.focusRecall(await client.prepareRecall(direct, messages, clock));
    expect(prompts.length).toBeGreaterThan(0);
    prompts.length = 0;
    const repeated = await client.focusRecall(await client.prepareRecall(direct, messages, clock));
    expect(prompts).toEqual([]);
    expect(repeated.receiptCache?.hit).toBe(true);
    expect(repeated.messages).toEqual(original.messages);
    const survivingPackage = await client.prepareRecall(direct, messages.map(message => message.role === 'user'
      ? { ...message, content: String(message.content) + '另一任务取消时保留此问题。' } : message), clock);
    let survivorStarted!: () => void, survivorResponse!: (response: Response) => void;
    const survivorEntered = new Promise<void>(resolve => { survivorStarted = resolve; });
    const surviving = client.focusRecall(survivingPackage, { fetchFn: async () => {
      survivorStarted(); return new Promise<Response>(resolve => { survivorResponse = resolve; });
    } });
    await survivorEntered;
    // Cancelling an unrelated native operation is distinct from withdrawing
    // the owner. This kills the worker without revoking another task's packet.
    await client.interruptScope(direct, { preservePrepared: true });
    survivorResponse(new Response(JSON.stringify({ choices: [{ message: { content: '这是我获取的所有相关知识/记忆[[另一任务取消后仍可完成。]]' } }] }),
      { headers: { 'content-type': 'application/json' } }));
    expect((await surviving).messages.some(message => String(message.content).includes('另一任务取消后仍可完成。'))).toBe(true);
    client.setOwnerPrompts({ aimemoTemplate: 'OWNER_OLD_TEMPLATE {{knowledge_base}} {{current_user_prompt}}' });
    const mentioningModes = await client.prepareRecall(direct, [messages[0]!, { role: 'user', content: 'umbrella 以及文字中的 ::Rerank 和 ::AIMemo，不是检索标记。' }], clock);
    await client.discardRecall(mentioningModes);
    await expect(client.preprocess(direct, [{ role: 'system', content: '[[memories日记本::RiverMemo::AIMemo+:未登记预设]]' }], clock)).rejects.toThrow('managed prompt');
    expect((await client.capabilities(direct)).modes?.meta_thinking?.available).toBe(false);
    const beforeTemplateEdit = await client.prepareRecall(direct, messages, clock);
    client.setOwnerPrompts({ aimemoTemplate: 'OWNER_NEW_TEMPLATE {{knowledge_base}} {{current_user_prompt}}' });
    prompts.length = 0; await client.focusRecall(beforeTemplateEdit);
    expect(JSON.stringify(prompts)).toContain('OWNER_OLD_TEMPLATE'); expect(JSON.stringify(prompts)).not.toContain('OWNER_NEW_TEMPLATE');
    prompts.length = 0; await client.focusRecall(await client.prepareRecall(direct, messages, clock));
    expect(JSON.stringify(prompts)).toContain('OWNER_NEW_TEMPLATE'); expect(JSON.stringify(prompts)).not.toContain('OWNER_OLD_TEMPLATE');
    const revokedPackage = await client.prepareRecall(direct, messages.map(message => message.role === 'user'
      ? { ...message, content: String(message.content) + '请逐字核对新增问题。' } : message), clock);
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    // A different question cannot reuse the focused answer above.
    const revokedFocus = client.focusRecall(revokedPackage, { validate: async () => { await Promise.resolve(); }, fetchFn: async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); });
    } });
    const rejection = expect(revokedFocus).rejects.toThrow('withdrawn');
    await requestStarted;
    await client.interruptScope(direct);
    await rejection;
    await expect(client.focusRecall(revokedPackage)).rejects.toThrow();

  } finally {
    modelRelease?.(); await client?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await removeOwnedDirectory(root);
  }
}, 180_000);
