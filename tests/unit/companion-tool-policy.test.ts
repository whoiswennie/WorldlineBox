import { expect, it, vi } from 'vitest';
import { generateCompanionReply } from '../../src/main/companions/model';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { DEFAULT_COMPANION_TOOL_POLICY, companionToolPolicyAllows, filterCompanionTools, intersectCompanionToolPolicies, normalizeCompanionToolPolicy } from '../../src/shared/companion-tool-policy';
import { COMPANION_DSH_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL } from '../../src/shared/companion-capability-tools';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint, CompanionLoopCall } from '../../src/shared/companion-loop';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

const input: CompanionReplyInput = {
  companion: { id: 'alice', name: '澄澄', description: '', persona: '保留自己的判断。', model: 'mock', avatar: 'sister', builtin: false, proactive: false, createdAt: '2026-10-29T08:00:00.000Z' },
  conversation: { id: 'private_alice', kind: 'private', title: '澄澄', memberIds: ['alice'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-29T08:00:00.000Z', lastMessage: '' },
  messages: [], memories: [],
};
it('keeps the legacy host-memory flag readable while independently restricting offered action selections', () => {
  expect(normalizeCompanionToolPolicy()).toEqual({ dsh: true, browser: false, memory: true, world: true, social: true, planning: true, observation: true, files: true });
  const draft = normalizeCompanionToolPolicy(); draft.browser = true; draft.dsh = false;
  expect(DEFAULT_COMPANION_TOOL_POLICY).toMatchObject({ browser: false, dsh: true });
});
it('a supplement can narrow but cannot silently widen the original message selection', () => {
  const original = { ...DEFAULT_COMPANION_TOOL_POLICY, dsh: false, browser: true };
  const supplement = { ...DEFAULT_COMPANION_TOOL_POLICY, dsh: true, browser: false };
  expect(intersectCompanionToolPolicies([original, supplement])).toMatchObject({ dsh: false, browser: false });
  expect(original).toMatchObject({ dsh: false, browser: true });
});
it.each([
  ['browser', {}, 'browser'], ['research', {}, 'browser'], ['observe', {}, 'observation'], ['agenda', {}, 'planning'],
  ['dsh', { operation: 'run' }, 'dsh'],
  ['dsh_control', { operation: 'send' }, 'dsh'], ['think', {}, 'dsh'], ['dsh', { operation: 'read_image' }, 'files'],
  ['read_image', {}, 'files'], ['agenda_files', {}, 'files'], ['world', { action: 'social' }, 'social'],
  ['world', { action: 'topic' }, 'social'], ['topic', {}, 'social'], ['world', { action: 'move' }, 'world'],
] as const)('blocks disabled %s operations before dispatch even under umbrella aliases', (name, args, category) => {
  expect(companionToolPolicyAllows({ ...DEFAULT_COMPANION_TOOL_POLICY, [category]: false }, { name, arguments: JSON.stringify(args) })).toBe(false);
  expect(companionToolPolicyAllows({ ...DEFAULT_COMPANION_TOOL_POLICY, [category]: true }, { name, arguments: JSON.stringify(args) })).toBe(true);
});
it.each([
  { name: 'memory', arguments: { action: 'search', query: '旧任务' } }, { name: 'memory.search', arguments: { query: '旧任务' } },
  { name: 'memory.read', arguments: { id: 'old_note' } }, { name: 'memory.record', arguments: {} },
  { name: 'memory.world_query', arguments: { category: 'contacts' } }, { name: 'experience', arguments: { action: 'list' } },
  { name: 'world', arguments: { action: 'experience', parameters: { action: 'days' } } },
])('never reopens retired recall operation $name from a legacy enabled memory switch', call => {
  for (const memory of [true, false]) expect(companionToolPolicyAllows({ ...DEFAULT_COMPANION_TOOL_POLICY, memory }, call)).toBe(false);
});
it('removes disabled operations from real composite schemas while preserving independently enabled files and social actions', () => {
  const policy = { ...DEFAULT_COMPANION_TOOL_POLICY, dsh: false, world: false };
  const tools = filterCompanionTools([COMPANION_DSH_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL], policy);
  const dsh = tools.find(tool => tool.name === 'dsh')!.parameters as { properties: { operation: { enum: string[] } } };
  const world = tools.find(tool => tool.name === 'world')!.parameters as { properties: { action: { enum: string[] } } };
  expect(dsh.properties.operation.enum).not.toContain('run'); expect(dsh.properties.operation.enum).toContain('read_file');
  expect(world.properties.action.enum).not.toContain('move'); expect(world.properties.action.enum).not.toContain('collaborate');
  expect(world.properties.action.enum).not.toContain('experience');
  expect(world.properties.action.enum).toContain('message'); expect(world.properties.action.enum).toContain('query');
});

it.each([
  { name: 'memory', arguments: { action: 'search', query: '旧经历' } },
  { name: 'memory', arguments: { action: 'read', id: 'old_note' } },
  { name: 'world', arguments: { action: 'experience', parameters: { action: 'days' } } },
])('the real host dispatcher refuses hallucinated $name recall even when the persisted memory switch is enabled', async proposed => {
  const source: CompanionMessage = { id: 'source', sequence: 1, conversationId: 'private_alice', authorId: 'user', kind: 'text', content: '聊聊眼前这件事。',
    attachments: [], status: 'sent', createdAt: '2026-10-29T08:00:00.000Z', toolPolicy: { ...DEFAULT_COMPANION_TOOL_POLICY, memory: true } };
  const checkpoint: CompanionLoopCheckpoint = { sourceMessageId: source.id, companionId: 'alice', conversationId: source.conversationId,
    messageId: 'reply', status: 'running', turns: [], supplements: [] };
  const search = vi.fn(), read = vi.fn(), callHost = vi.fn(), storage = { request: vi.fn(async () => ({ ok: true, message: source })) };
  const host = Object.assign(Object.create(CompanionService.prototype), { storage, memory: { search, read }, call: callHost,
    chatAgendaRoots: new Map(), capabilityJournal: { run: vi.fn(async (_scope: unknown, _call: unknown, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<unknown>) => execute(signal)) } }) as {
      executeLoopTools(input: { checkpoint: CompanionLoopCheckpoint; turn: { text: string; calls: CompanionLoopCall[] }; companionId: string; conversationId: string;
        userMessage: CompanionMessage; proactive: boolean; step: number; loopKey: string; signal: AbortSignal; authorizationSourceIds: string[] }): Promise<{ results: Array<{ content: string }> }> };
  const result = await host.executeLoopTools({ checkpoint, turn: { text: '', calls: [{ id: 'hallucinated_recall', name: proposed.name, arguments: JSON.stringify(proposed.arguments) }] },
    companionId: 'alice', conversationId: source.conversationId, userMessage: source, proactive: false, step: 0, loopKey: 'source:alice',
    signal: new AbortController().signal, authorizationSourceIds: [source.id] });
  expect(result.results).toHaveLength(1);
  expect(JSON.parse(result.results[0]!.content)).toMatchObject({ ok: false, error: expect.stringContaining('不提供主动记忆') });
  expect(search).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(callHost).not.toHaveBeenCalled();
});
it.each([false, true])('advertises native browser=%s only from the frozen message policy in the real provider request', async browser => {
  const toolPolicy = { ...DEFAULT_COMPANION_TOOL_POLICY, browser, memory: false, observation: false };
  const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
    const body = JSON.parse(String(request!.body)) as { tools: Array<{ function: { name: string } }>; messages: Array<{ content: string }> };
    expect(body.tools.some(tool => tool.function.name === 'browser')).toBe(browser);
    expect(body.tools.some(tool => tool.function.name === 'memory')).toBe(false);
    expect(body.tools.some(tool => tool.function.name === 'dsh')).toBe(true);
    expect(body.messages[0]?.content).toContain('DSH是实际任务的主要执行能力');
    return new Response(JSON.stringify({ choices: [{ message: { content: '我先核对目标，再安排执行。' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  await generateCompanionReply(input, { apiFormat: 'openai_chat', model: 'mock', baseUrl: 'https://fixture.invalid', apiKey: 'fixture' },
    undefined, { loop: true, browser: true, toolPolicy, fetchFn });
  expect(fetchFn).toHaveBeenCalledOnce();
});

it.each(['browser', 'dsh'] as const)('the real host dispatcher rejects forged %s calls from a disabled frozen source without executing the capability', async name => {
  const source: CompanionMessage = { id: 'source', sequence: 1, conversationId: 'private_alice', authorId: 'user', kind: 'text', content: '先商量。',
    attachments: [], status: 'sent', createdAt: '2026-10-29T08:00:00.000Z', toolPolicy: { ...DEFAULT_COMPANION_TOOL_POLICY, dsh: false } };
  const checkpoint: CompanionLoopCheckpoint = { sourceMessageId: source.id, companionId: 'alice', conversationId: source.conversationId,
    messageId: 'reply', status: 'running', turns: [], supplements: [] };
  const executeBrowser = vi.fn(), launchAction = vi.fn();
  const storage = { request: vi.fn(async () => ({ ok: true, message: source })) };
  const host = Object.assign(Object.create(CompanionService.prototype), { storage, executeBrowser, launchAction,
    chatAgendaRoots: new Map(), capabilityJournal: { run: vi.fn(async (_scope: unknown, _call: unknown, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<unknown>) => execute(signal)) } }) as {
      executeLoopTools(input: { checkpoint: CompanionLoopCheckpoint; turn: { text: string; calls: CompanionLoopCall[] }; companionId: string; conversationId: string;
        userMessage: CompanionMessage; proactive: boolean; step: number; loopKey: string; signal: AbortSignal; authorizationSourceIds: string[] }): Promise<{ results: Array<{ content: string }> }> };
  const call = { id: 'forged_call', name, arguments: JSON.stringify(name === 'browser' ? { action: 'tabs' }
    : { operation: 'run', tasks: [{ title: '实际任务', prompt: '处理实际任务。' }] }) };
  const result = await host.executeLoopTools({ checkpoint, turn: { text: '', calls: [call] }, companionId: 'alice', conversationId: source.conversationId,
    userMessage: source, proactive: false, step: 0, loopKey: 'source:alice', signal: new AbortController().signal, authorizationSourceIds: [source.id] });
  expect(result.results).toHaveLength(1);
  expect(JSON.parse(result.results[0]!.content)).toMatchObject({ ok: false, error: expect.stringContaining('关闭') });
  expect(executeBrowser).not.toHaveBeenCalled(); expect(launchAction).not.toHaveBeenCalled();
});
