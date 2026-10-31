import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { generateCompanionReply, generateCompanionStructured, type CompanionModelConfig } from '../../src/main/companions/model';
import { companionModelVisionCapability, companionUnsupportedImageError } from '../../src/main/companions/public-profile-context';
import { generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { generateCompanionWorldDecision } from '../../src/main/companions/world-model';
import type { CompanionPublicProfile, CompanionVisualInput } from '../../src/shared/companion-public-profile';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import type { CompanionWorldJob, CompanionWorldSnapshot } from '../../src/shared/companion-world';
const at = '2026-10-15T02:00:00Z';
const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxZkAAAAASUVORK5CYII=';
const userPixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function image(personId: string, role: CompanionVisualInput['role'], base64 = pixels): CompanionVisualInput { return { personId, role, mime: 'image/png', base64, sha256: createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') }; }
const selfId = 'deepseek-flash', peerId = 'deepseek-sister';
const self: CompanionPublicProfile = { id: selfId, name: '小肥鱼', description: '当前公开联系人资料。', kind: 'companion', revision: 2,
  avatar: { absolutePath: 'C:\\public\\self-avatar.png', mime: 'image/png', available: true }, orthographic: { absolutePath: 'C:\\public\\self-three-views.png', mime: 'image/png', available: true } };
const player: CompanionPublicProfile = { id: 'user', name: '星野', description: '当前用户公开简介，喜欢海边。', kind: 'human_player', revision: 4,
  avatar: { absolutePath: 'C:\\public\\player-avatar.png', mime: 'image/png', available: true }, orthographic: { absolutePath: 'C:\\public\\player-three-views.png', mime: 'image/png', available: true } };
function input(): CompanionReplyInput { return {
  companion: { id: selfId, name: '旧名字', description: '旧简介', persona: '你是小肥鱼，姐姐是大肥鱼伙伴。', model: '', avatar: 'flash', builtin: true, proactive: false, createdAt: at },
  conversation: { id: 'room', kind: 'private', memberIds: [selfId], title: '聊天', unread: 0, muted: false, pinned: false, updatedAt: at, lastMessage: '' },
  messages: [{ id: 'actual_user', sequence: 1, authorId: 'user', conversationId: 'room', content: '我们现在各自的公开资料是什么？', kind: 'text', status: 'sent', createdAt: at, attachments: [] }], memories: [],
  publicProfiles: [self, player], visualInputs: [image(selfId, 'orthographic'), image('user', 'avatar', userPixels)],
}; }
const models: Record<AiApiFormat, string> = { openai_chat: 'gpt-4o-mini', openai_responses: 'gpt-4o-mini', anthropic: 'claude-sonnet-4-20250514', gemini_native: 'gemini-2.5-flash', dashscope_native: 'qwen3-vl-plus' };
function config(format: AiApiFormat = 'openai_chat'): CompanionModelConfig { return { apiFormat: format, baseUrl: 'https://fixture.invalid', model: models[format], apiKey: 'private-fixture-key' }; }
function envelope(format: AiApiFormat, value: unknown = { text: '按当前公开资料说明。', memories: [] }) { const text = JSON.stringify(value); return new Response(JSON.stringify(
  format === 'openai_chat' ? { choices: [{ message: { content: text } }] }
    : format === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : format === 'anthropic' ? { content: [{ type: 'text', text }] }
        : format === 'gemini_native' ? { candidates: [{ content: { parts: [{ text }] } }] }
          : { output: { choices: [{ message: { content: text } }] } }), { headers: { 'Content-Type': 'application/json' } }); }
type WirePart = Record<string, unknown> & { type?: string; text?: string };
type WireMessage = { content?: string | WirePart[]; parts?: WirePart[] };
function transport(body: Record<string, unknown>, format: AiApiFormat) {
  const messages = (format === 'openai_responses' ? body.input : format === 'gemini_native' ? body.contents : format === 'dashscope_native'
    ? (body.input as { messages: WireMessage[] }).messages : body.messages) as WireMessage[];
  const base = format === 'gemini_native' ? messages[0]!.parts![0]!.text : format === 'dashscope_native' ? (messages[1]!.content as WirePart[])[0]!.text
    : format === 'openai_responses' || format === 'anthropic' ? messages[0]!.content : messages[1]!.content;
  const parts = (message: WireMessage) => { const value = message.content ?? message.parts; return Array.isArray(value) ? value : []; };
  const imageMessages = messages.filter(message => parts(message).some(part => part.type === 'input_image' || part.type === 'image_url' || part.type === 'image' || part.inlineData || part.image));
  return { base: JSON.parse(String(base)), imageMessages, parts: imageMessages.flatMap(parts) };
}
it.each(Object.keys(models) as AiApiFormat[])('sends real labeled pixels through %s once while preserving the original JSON user message and native history', async format => {
  const value = input(), fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), wire = transport(body, format);
    expect(wire.base.identity.self.name).toBe(self.name); expect(wire.base.identity.currentReply.addressee).toMatchObject({ id: 'user', name: player.name, description: player.description });
    expect(wire.base.publicProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'user', revision: 4 })]));
    expect(wire.base.visionManifest.filter((item: { delivery: string }) => item.delivery === 'image_provided')).toHaveLength(2);
    expect(wire.imageMessages).toHaveLength(1); expect(wire.parts).toHaveLength(4);
    const content = JSON.stringify(wire.parts); expect(content).toContain(pixels); expect(content).toContain(userPixels); expect(content).toContain(selfId); expect(content).toContain('orthographic');
    if (format === 'gemini_native') expect(wire.parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: pixels } });
    else if (format === 'anthropic') expect(wire.parts[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixels } });
    else if (format === 'openai_responses') expect(wire.parts[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,' + pixels, detail: 'high' });
    else if (format === 'dashscope_native') expect(wire.parts[1]).toEqual({ image: 'data:image/png;base64,' + pixels });
    else expect(wire.parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + pixels, detail: 'high' } });
    expect(JSON.stringify(body)).toContain('actual_tool_id'); return envelope(format);
  });
  const frozen = buildCompanionContext(value); expect(JSON.stringify(frozen)).not.toContain(pixels); expect(JSON.stringify(frozen)).not.toContain(userPixels);
  await generateCompanionReply(value, config(format), undefined, { fetchFn, loop: true, context: frozen,
    turns: [{ text: '', rawText: '', calls: [{ id: 'actual_tool_id', name: 'memory.search', arguments: '{}' }], results: [{ callId: 'actual_tool_id', content: '{"ok":true}' }] }] });
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('replaces withdrawn or edited public assets and names on a frozen resumed loop, without retaining old pixels', async () => {
  const value = input(), frozen = buildCompanionContext(value);
  const current = { ...player, name: '新公开名字', description: '新公开简介', revision: 5, avatar: undefined, orthographic: undefined };
  let observed!: ReturnType<typeof transport>;
  const fetchFn: typeof fetch = async (_url, init) => {
    observed = transport(JSON.parse(String(init?.body)), 'openai_chat'); return envelope('openai_chat');
  };
  await generateCompanionReply({ ...value, publicProfiles: [self, current] }, config(), undefined, { context: frozen, fetchFn });
  expect(observed.base.identity.currentReply.addressee.name).toBe(current.name);
  const user = observed.base.publicProfiles.find((item: { id: string }) => item.id === 'user'); expect(user).toMatchObject({ name: current.name, description: current.description, revision: 5 }); expect(user.avatar).toBeUndefined();
  expect(JSON.stringify(observed)).not.toContain('player-avatar.png'); expect(JSON.stringify(observed)).not.toContain(userPixels);
  expect(observed.base.visionManifest.some((item: { personId: string }) => item.personId === 'user')).toBe(false);
});
it('removes all player profile and pixel data from peer-only room input, including structured phone replies', async () => {
  const value = input(), peer = { ...self, id: peerId, name: '大肥鱼' }, source = { ...value.messages[0]!, authorId: peerId, content: '妹妹，你想听什么音乐？' };
  const conversation = { ...value.conversation, kind: 'group' as const, memberIds: [selfId, peerId] };
  const job: CompanionSocialJob = { id: 'job', companionId: selfId, conversationId: conversation.id, sourceMessageId: source.id, throughSequence: source.sequence, chainId: 'chain', remainingTurns: 3, memberIds: conversation.memberIds, channel: 'phone', status: 'running', attempts: 1, typingNotBefore: at, createdAt: at };
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), wire = transport(body, 'openai_chat'), content = JSON.stringify(body);
    expect(content).not.toContain(player.description); expect(content).not.toContain('player-avatar'); expect(content).not.toContain(userPixels);
    expect(wire.base.identity.currentReply.addressee.name).toBe('大肥鱼'); expect(wire.base.publicProfiles.every((item: { id: string }) => item.id !== 'user')).toBe(true);
    return envelope('openai_chat', { text: null, reason: '自然结束。' });
  };
  await generateCompanionSocialReply({ companion: value.companion, conversation, source, messages: [source], job, members: [value.companion, { ...value.companion, id: peerId, name: '大肥鱼' }],
    publicProfiles: [self, peer, player], visualInputs: value.visualInputs, world: { actors: [], events: [], relationships: [], residents: [], scenes: [], works: [], clock: {}, environment: {} } as unknown as CompanionWorldSnapshot }, config(), undefined, { fetchFn });
});
it('keeps the public NPC directory and actual remote-peer pixels for world decisions while excluding the player', async () => {
  const value = input(), peer = { ...self, id: peerId, name: '大肥鱼', description: '当前公开的NPC简介。' };
  const world = { actors: [], events: [], relationships: [], residents: [self, peer].map(profile => ({ companionId: profile.id, name: profile.name, homeSceneId: 'home_' + profile.id })),
    scenes: [], works: [], clock: {}, environment: {} } as unknown as CompanionWorldSnapshot;
  const job: CompanionWorldJob = { id: 'decision', conversationId: 'world_' + selfId, companionId: selfId, kind: 'decision', status: 'running', attempts: 1, throughEventSequence: 0, createdAt: at, sourceMemoryIds: [] };
  let observed!: ReturnType<typeof transport>;
  const fetchFn: typeof fetch = async (_url, init) => { observed = transport(JSON.parse(String(init?.body)), 'openai_chat'); return envelope('openai_chat', { action: null, reason: '当前没有必要打扰对方。' }); };
  await generateCompanionWorldDecision({ companion: value.companion, world, job, members: [], publicProfiles: [self, peer, player],
    visualInputs: [image(selfId, 'orthographic'), image(peerId, 'orthographic'), image('user', 'avatar', userPixels)] }, config(), undefined, { fetchFn });
  expect(observed.base.publicProfiles).toEqual([self, peer]); expect(observed.base.identity.self.name).toBe(self.name);
  expect(observed.base.identity.participants.map((person: { id: string }) => person.id)).toEqual([selfId]);
  expect(observed.parts).toHaveLength(4); expect(JSON.stringify(observed.parts)).toContain(peerId);
  expect(JSON.stringify(observed)).not.toContain(player.description); expect(JSON.stringify(observed)).not.toContain(userPixels);
});
it.each([400, 415])('retries explicit unsupported-image HTTP %i once, on the same model with truthful text-only manifest', async status => {
  const requests: Array<Record<string, unknown>> = [], connection = config();
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); requests.push(body); return requests.length === 1
    ? new Response(JSON.stringify({ error: { code: 'unsupported_image_input', message: 'Images unsupported for this model: SECRET_PROVIDER_BODY' } }), { status }) : envelope('openai_chat'); });
  await generateCompanionReply(input(), connection, undefined, { fetchFn }); expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(requests.every(body => body.model === connection.model)).toBe(true); expect(transport(requests[0]!, 'openai_chat').imageMessages).toHaveLength(1);
  const fallback = transport(requests[1]!, 'openai_chat'); expect(fallback.imageMessages).toHaveLength(0);
  expect(fallback.base.visionManifest.every((item: { delivery: string; reason: string }) => item.delivery === 'path_only' && item.reason === 'provider_rejected_images')).toBe(true);
  expect(JSON.stringify(requests[1])).not.toContain('SECRET_PROVIDER_BODY');
});
it.each([400, 401, 500])('does not hide unrelated HTTP %i errors or leak their provider body', async status => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid tool schema SECRET_BODY' } }), { status }));
  await expect(generateCompanionReply(input(), config(), undefined, { fetchFn })).rejects.not.toThrow('SECRET_BODY'); expect(fetchFn).toHaveBeenCalledOnce();
});
it('bounds unsupported-image fallback to one attempt and respects cancellation before text-only retry', async () => {
  const failure = () => new Response(JSON.stringify({ error: { code: 'unsupported_image' } }), { status: 400 });
  const twice = vi.fn<typeof fetch>(async () => failure());
  await expect(generateCompanionReply(input(), config(), undefined, { fetchFn: twice })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(twice).toHaveBeenCalledTimes(2);
  const controller = new AbortController(), cancelled = vi.fn<typeof fetch>(async () => { controller.abort(); return failure(); });
  await expect(generateCompanionReply(input(), config(), controller.signal, { fetchFn: cancelled })).rejects.toMatchObject({ code: 'CANCELLED' }); expect(cancelled).toHaveBeenCalledOnce();
});
it.each([['deepseek-flash', 'supported'], ['deepseek-v4-pro', 'unsupported'], ['custom-model', 'unknown']] as const)('uses exact DeepSeek/current model vision capability for %s', async (model, capability) => {
  const connection = { ...config(), baseUrl: model === 'custom-model' ? 'https://custom.invalid' : 'https://api.deepseek.com', model };
  expect(companionModelVisionCapability(connection)).toBe(capability);
  const fetchFn: typeof fetch = async (_url, init) => { const wire = transport(JSON.parse(String(init?.body)), 'openai_chat'); expect(wire.imageMessages.length).toBe(capability === 'supported' ? 1 : 0);
    expect(wire.base.publicProfiles[0].orthographic.absolutePath).toBe(self.orthographic!.absolutePath); return envelope('openai_chat'); };
  await generateCompanionReply(input(), connection, undefined, { fetchFn });
});
it('does not attach corrupt, over-budget, foreign or unavailable pixels', async () => {
  const value = input(), foreign = { ...self, id: 'outside_room', description: 'FOREIGN_PROFILE' };
  const inputs = [image('outside_room', 'orthographic'), { ...image(selfId, 'orthographic'), sha256: '0'.repeat(64) }, image('user', 'avatar', Buffer.alloc(1024 * 1024 + 1).toString('base64'))];
  const fetchFn: typeof fetch = async (_url, init) => { const wire = transport(JSON.parse(String(init?.body)), 'openai_chat'); expect(wire.imageMessages).toHaveLength(0); expect(JSON.stringify(wire)).not.toContain('FOREIGN_PROFILE');
    expect(wire.base.visionManifest.every((item: { delivery: string }) => item.delivery !== 'image_provided')).toBe(true); return envelope('openai_chat'); };
  await generateCompanionReply({ ...value, publicProfiles: [self, player, foreign], visualInputs: inputs }, config(), undefined, { fetchFn });
});
it('attaches at most four available public images and marks remaining assets as path-only', async () => {
  const value = input(), peer = { ...self, id: peerId, name: '大肥鱼' };
  let observed!: ReturnType<typeof transport>;
  const fetchFn: typeof fetch = async (_url, init) => { observed = transport(JSON.parse(String(init?.body)), 'openai_chat'); return envelope('openai_chat'); };
  await generateCompanionReply({ ...value, conversation: { ...value.conversation, kind: 'group', memberIds: [selfId, peerId] }, publicProfiles: [self, player, peer],
    visualInputs: [self, player, peer].flatMap(profile => [image(profile.id, 'avatar'), image(profile.id, 'orthographic')]) }, config(), undefined, { fetchFn });
  expect(observed.imageMessages).toHaveLength(1); expect(observed.parts).toHaveLength(8);
  expect(observed.base.visionManifest.filter((item: { delivery: string }) => item.delivery === 'image_provided')).toHaveLength(4);
  expect(observed.base.visionManifest.filter((item: { reason: string }) => item.reason === 'image_budget')).toHaveLength(2);
});
it('keeps ordinary structured memory requests image-free and recognizes only explicit image errors', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); expect(body.messages).toHaveLength(2); expect(JSON.stringify(body)).not.toContain(pixels); return envelope('openai_chat', { candidates: [] }); });
  await generateCompanionStructured({ system: 'memory', user: '{"purpose":"memory_extraction"}' }, config(), undefined, { fetchFn });
  expect(companionUnsupportedImageError({ error: { message: 'image_url has invalid base64' } })).toBe(false);
  expect(companionUnsupportedImageError({ error: { message: 'This model does not support image inputs' } })).toBe(true);
  expect(companionModelVisionCapability({ ...config(), model: 'claude-2.1' })).toBe('unknown');
  expect(companionModelVisionCapability({ ...config(), model: 'o1-mini' })).toBe('unknown');
});
it('preserves image-free structured text prompts without requiring a JSON input envelope', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); expect(body.messages[1].content).toBe('从真实来源提取。'); return envelope('openai_chat', { candidates: [] }); });
  await expect(generateCompanionStructured({ system: 'memory', user: '从真实来源提取。' }, config(), undefined, { fetchFn })).resolves.toEqual({ candidates: [] });
});
