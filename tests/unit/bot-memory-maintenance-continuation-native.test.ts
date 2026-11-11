import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryMaintenance, type BotMemoryMaintenanceOptions, type BotMemoryMaintenanceSnapshot } from '../../src/main/companion-bot/memory-maintenance';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { BotMemoryMaintenanceReviewer, MEMORY_REVIEW_CRITERIA } from '../../src/main/companion-bot/memory-maintenance-reviewer';
import type { BotMemoryMaintenancePlan } from '../../src/main/companion-bot/memory-maintenance';
import type { BotMaintenanceCandidateDetail } from '../../src/shared/companion-bot-maintenance';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('finishes a structured maintenance plan across actual native max-token stops without replaying the original input', async () => {
  const body = JSON.stringify({ narrative: '方案通过真实原生宿主自动续接完成。', candidates: [] });
  const requests: Array<{ max_tokens: number; messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(input);
    const index = requests.length - 1, text = body.slice(Math.floor(body.length * index / 3), Math.floor(body.length * (index + 1) / 3));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: index < 2 ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing native maintenance provider port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const brain = new BotDshBrain({ getHost: async (_id, signal) => ({ client: await native.instances.ensureHost(native.instance.id, signal) }) });
  const notes = ['a', 'b'].map(id => ({ id: id.repeat(64), checksum: id.repeat(32), indexState: 'indexed', content: id === 'a' ? '完整原文资料。'.repeat(18000) : '原生维护续接测试日记 b', tags: [], createdAt: '2026-11-11T00:00:00Z', sourceMessageIds: [] }));
  let snapshot: BotMemoryMaintenanceSnapshot | undefined;
  const core = new BotMemoryMaintenance({ brain,
    memory: { catalog: async () => ({ items: notes }), readNote: async (_scope: unknown, input: { id: string }) => notes.find(note => note.id === input.id),
      withdrawnSources: async () => ({ revision: '0', sourceEventIds: [], sourceMessageIds: [] }), tool: async () => ({ results: [] }) },
    cwd: () => path.join(native.root, 'maintenance-work'), callback: async () => ({ url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'c'.repeat(64) }),
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'localhost-fixture', baseUrl: `http://127.0.0.1:${address.port}`, contextWindow: 1048576, maxTokens: 4096, maxOutputTokens: 32768 }),
  } as unknown as BotMemoryMaintenanceOptions);
  try {
    const plan = await core.preparePlan({ scope: { companionId: 'native', conversationId: 'native-room', securityDomainId: 'native-room' }, kind: 'organize', operationId: 'native-plan-continuation', contextEpoch: 1,
      onSnapshot: async value => { snapshot = value; } });
    expect(plan.narrative).toBe('方案通过真实原生宿主自动续接完成。'); expect(requests).toHaveLength(3); expect(JSON.stringify(snapshot).length).toBeGreaterThan(100000);
    expect(requests[0]!.max_tokens).toBe(32768);
    const textOf = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';
    for (const request of requests) expect(request.messages.filter(message => message.role === 'user' && textOf(message.content) === JSON.stringify(snapshot))).toHaveLength(1);
    expect(requests[1]!.messages.some(message => JSON.stringify(message.content).includes('剩余字符'))).toBe(true);
  } finally { await brain.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('reviews an individual candidate through the native host, preserving full evidence and resuming structured output', async () => {
  const note = { id: 'a'.repeat(64), checksum: 'a'.repeat(32), indexState: 'indexed', content: '用户原计划去湖边，后来改为博物馆，尚未订票。', tags: [], sourceMessageIds: [], createdAt: '2026-11-11T00:00:00Z' };
  const body = JSON.stringify({ decision: 'approve', reason: '原文中的计划变化和未订票状态均保留。', checks: MEMORY_REVIEW_CRITERIA.map(criterion => ({ criterion, passed: true, reason: '已逐项对照原件。' })), evidence: [{ sourceId: note.id, quote: note.content }] });
  const requests: Array<{ model: string; max_tokens: number; messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const index = requests.length - 1, text = body.slice(Math.floor(body.length * index / 2), Math.floor(body.length * (index + 1) / 2));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: index ? 'stop' : 'length' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\n\n'); response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing review provider port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const brain = new BotDshBrain({ getHost: async (_id, signal) => ({ client: await native.instances.ensureHost(native.instance.id, signal) }) });
  const memory = { readNote: async () => note, withdrawnSources: async () => ({ revision: '0', sourceEventIds: [], sourceMessageIds: [] }) };
  const reviewer = new BotMemoryMaintenanceReviewer({ brain, memory, root: native.root, callback: async () => ({ url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'c'.repeat(64) }) });
  const scope = { companionId: 'native', conversationId: 'native-review', securityDomainId: 'native-review' };
  try {
    const candidate = { id: 'review-candidate', jobId: 'native-review', type: 'update', status: 'pending', revision: 'b'.repeat(64), content: note.content, sources: [note], tags: [], quotes: [{ sourceId: note.id, text: note.content }], uncertainties: [], reason: '保留计划更正。' } as unknown as BotMaintenanceCandidateDetail;
    const plan: BotMemoryMaintenancePlan = { format: 'worldlinebox-memory-maintenance-v1', id: 'native-review', operationId: 'native-review', scope, kind: 'organize', contextEpoch: 1, createdAt: note.createdAt, sourceRevision: '0', sources: [note], scan: { examined: 1, selected: 1, deferred: [] }, retrieval: { engine: 'LightMemo', result: {} }, narrative: '', candidates: [] };
    const result = await reviewer.review({ scope, plan, candidate, operationId: 'native-review', signal: new AbortController().signal,
      model: { apiFormat: 'openai_chat', model: 'configured-global-model', apiKey: 'localhost-fixture', baseUrl: `http://127.0.0.1:${address.port}`, contextWindow: 1048576, maxTokens: 4096, maxOutputTokens: 32768 }, saveContinuation: () => undefined, diagnostic: () => undefined });
    expect(result).toMatchObject({ decision: 'approve', model: 'configured-global-model', evidence: [{ sourceId: note.id, quote: note.content }] }); expect(result.checks).toHaveLength(8); expect(requests).toHaveLength(2);
    expect(requests.every(request => request.model === 'configured-global-model' && request.max_tokens === 32768)).toBe(true);
    expect(JSON.stringify(requests[0]!.messages)).toContain('独立的长期记忆质量审查员'); expect(JSON.stringify(requests[1]!.messages)).toContain('剩余字符');
  } finally { await brain.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);
