import { expect, it, vi } from 'vitest';
import { assembleCompanionAssetContext as compileAssetContext, companionAssetReplyIdentity } from '../../src/main/companions/asset-context';
import type { CompanionAssetProfileSnapshot } from '../../src/main/companions/asset-profile';
import { assembleCompanionRoleContext } from '../../src/main/companions/structured-agent';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { COMPANION_WORLD_PERCEPTION_RULES } from '../../src/main/companions/world-perception-context';
import { generateCompanionReply } from '../../src/main/companions/model';
import { createHash } from 'node:crypto';
import { initialCompanionPersonaFragments } from '../../src/main/companions/persona-fragments';
import { emptyCompanionCharacter, renderCompanionCharacter } from '../../src/shared/companion-character';

const oldPersona = 'OLD_BASE_PERSONA\n\n保留多段旧设定。', oldDomainPersona = 'OLDER_DOMAIN_PERSONA\n\n领域构建后，公共frame还可能再次刷新。';
const frame: CompanionReplyInput = {
  companion: { id: 'alice', name: 'OldAlice', persona: oldPersona, description: 'old description', avatar: 'sister', model: '', builtin: false, proactive: false, createdAt: '2026-10-26T00:00:00Z' },
  conversation: { id: 'room', kind: 'group', memberIds: ['alice', 'bob'], title: 'room', pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: '2026-10-26T00:00:00Z' },
  messages: [], memories: [], members: [{ id: 'alice', name: 'OldAlice', description: '' }, { id: 'bob', name: 'PeerBob', description: '' }],
};
const profileRevision = 'a'.repeat(64);
const snapshot: CompanionAssetProfileSnapshot = {
  companionId: 'alice', root: 'isolated-context-fixture', profile: { name: 'CurrentAlice', description: 'current description', persona: 'CURRENT_PERSONA', avatar: 'sister', proactive: false, inputMode: 'steer', avatarAttachmentId: null, appearanceAttachmentId: null },
  profileRevision, promptRevision: 'b'.repeat(64), manifestRevision: 'c'.repeat(64), revision: 'd'.repeat(64), fileRevisions: {}, modules: [], memoryPolicyRevision: 'e'.repeat(64),
  nativeFocusTemplate: 'NATIVE_TEMPLATE', tagMasterTemplate: 'TAG_TEMPLATE', nativeTimelineTemplate: 'TIMELINE_TEMPLATE', nativeSummaryTemplate: 'SUMMARY_TEMPLATE',
  personaFragments: initialCompanionPersonaFragments('alice', profileRevision, 'CURRENT_PERSONA'),
  prompts: Object.fromEntries(['default', 'companion_reply', 'companion_action_feedback', 'world_decision', 'activity_task_step', 'visit_peer_speech', 'companion_social_initiative', 'companion_internal_work', 'companion_dream_wave_narrative', 'vcp_experience_journal', 'vcp_focus_guidance'].map(purpose => [purpose, 'CURRENT_OWNER_GUIDANCE'])),
};
// Pure compiler tests supply a complete host-admitted version and its matching
// fragment ledger. Disk authority and forged fragments have separate Registry tests.
function assembleCompanionAssetContext(context: {system: string; user: string}, current: CompanionAssetProfileSnapshot, kind: 'reply'|'structured'|'text', explicitPurpose?: string) {
  const profileRevision = createHash('sha256').update(JSON.stringify(current.profile)).digest('hex');
  return compileAssetContext(context, { ...current, profileRevision, personaFragments: initialCompanionPersonaFragments(current.companionId, profileRevision, current.profile.persona) }, kind, explicitPurpose);
}

it('binds the main brain to the current standard sheet on each inference, including native tool continuations', async () => {
  let current = { ...snapshot, profile: { ...snapshot.profile,
    persona: renderCompanionCharacter({ ...emptyCompanionCharacter('CurrentAlice'), personality: '温和但坚持判断', voice: 'EDITED_VOICE_V1' }) } };
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '我会认真核对。' } }] })));
  const config = { apiFormat: 'openai_chat' as const, model: 'model', apiKey: 'test', baseUrl: 'https://provider.invalid',
    resolveAssetContext: async (context: { system: string; user: string }, kind: 'reply' | 'structured' | 'text') => assembleCompanionAssetContext(context, current, kind) };
  const context = buildCompanionContext(frame);
  await generateCompanionReply(frame, config, undefined, { fetchFn, loop: true, context });
  current = { ...current, profileRevision: 'c'.repeat(64), profile: { ...current.profile,
    persona: renderCompanionCharacter({ ...emptyCompanionCharacter('CurrentAlice'), personality: '温和但坚持判断', voice: 'EDITED_VOICE_V2' }) } };
  await generateCompanionReply(frame, config, undefined, { fetchFn, loop: true, context,
    turns: [{ text: '', rawText: '', calls: [{ id: 'observe-1', name: 'world', arguments: '{"action":"observe"}' }], results: [{ callId: 'observe-1', content: '{"ok":true}' }] }] });
  const wires = fetchFn.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
  expect(wires[0].messages[0].content).toContain('EDITED_VOICE_V1');
  expect(wires[1].messages[0].content).toContain('EDITED_VOICE_V2');
  expect(wires[1].messages[0].content).not.toContain('EDITED_VOICE_V1');
  expect(wires[1].messages[0].content.match(/【主脑角色扮演准则】/gu)).toHaveLength(1);
  const envelope = JSON.parse(wires[1].messages[1].content);
  expect(envelope.characterPerformance).toMatchObject({ profileRevision: createHash('sha256').update(JSON.stringify(current.profile)).digest('hex'), format: 'standard_character_sheet', source: 'profile.md' });
  expect(wires[1].messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'observe-1')).toBe(true);
});

it.each([
  ['world_decision', `你是WorldlineBox中一个持续生活的伙伴，只控制自己的世界行为。完整稳定人格：\n${oldDomainPersona}\n\n${COMPANION_WORLD_PERCEPTION_RULES}\nWORLD_CONTRACT`],
  ['activity_task_step', `你是OlderAlice，只控制自己。稳定人格：\n${oldDomainPersona}\n${COMPANION_WORLD_PERCEPTION_RULES}\nACTIVITY_CONTRACT`],
  ['visit_peer_speech', `你是OlderAlice，稳定人格：\n${oldDomainPersona}\n${COMPANION_WORLD_PERCEPTION_RULES}\nVISIT_CONTRACT`],
  ['companion_social_initiative', `你是OlderAlice，不是玩家或其他伙伴。稳定人格：\n${oldDomainPersona}\n${COMPANION_WORLD_PERCEPTION_RULES}\nSOCIAL_CONTRACT`],
  ['companion_internal_work', `你是OlderAlice，只扮演自己。稳定人格：\n${oldDomainPersona}\n这是伙伴发布的内部认知工作，不能调用现实工具、访问文件/网络或继承玩家权限。WORK_CONTRACT`],
])('refreshes both common and independently captured %s roles without touching evidence or host contracts', (purpose, system) => {
  const evidence = { authorId: 'bob', content: oldPersona + '\n' + oldDomainPersona + '\nOlderAlice OldAlice PeerBob' };
  const context = assembleCompanionRoleContext(frame, { system, user: JSON.stringify({ purpose, self: { id: 'alice', name: 'OlderAlice' },
    target: { id: 'bob', name: 'PeerBob' }, quotedEvidence: evidence }) });
  const actual = assembleCompanionAssetContext(context, snapshot, 'reply'), data = JSON.parse(actual.user);
  expect(actual.system).not.toContain(oldPersona); expect(actual.system).not.toContain(oldDomainPersona);
  expect(actual.system).not.toContain('你是OlderAlice'); expect(actual.system).toContain('CURRENT_PERSONA');
  expect(actual.system).toContain(system.slice(system.lastIndexOf('\n') + 1));
  expect(data.quotedEvidence).toEqual(evidence); expect(data.target).toEqual({ id: 'bob', name: 'PeerBob' });
  expect(data.identity.self.name).toBe('CurrentAlice'); expect(data.identity.currentReply.author.name).toBe('CurrentAlice');
  expect(data.identity.participants.find((person: { id: string }) => person.id === 'alice').name).toBe('CurrentAlice');
  expect(data.identity.participants.find((person: { id: string }) => person.id === 'bob').name).toBe('PeerBob');
});

it('refreshes the raw DreamWave role while preserving its exact fiction and JSON contract', () => {
  const contract = '只返回严格JSON对象{text,relatedMemoryIds}或null。虚构梦不能变为真实来源。';
  const context = { system: `你是OlderAlice的梦境联想叙述职能。本次状态为rehearsal_dream；不能编造离线思考。稳定人格：\n${oldDomainPersona}\n${contract}`,
    user: JSON.stringify({ purpose: 'companion_dream_wave_narrative', self: { id: 'alice', name: 'OlderAlice' }, stages: { original: oldDomainPersona } }) };
  const actual = assembleCompanionAssetContext(context, snapshot, 'structured');
  expect(actual.system.startsWith('你是CurrentAlice的梦境联想叙述职能。')).toBe(true);
  expect(actual.system).not.toContain(oldDomainPersona); expect(actual.system).toContain(contract);
  expect(JSON.parse(actual.user).stages.original).toBe(oldDomainPersona);
});

it('does not rewrite another identity or the prepared native focus user template', () => {
  const context = { system: 'HOST_PROTOCOL', user: JSON.stringify({ companion: { id: 'bob', name: 'OldAlice', persona: oldPersona },
    self: { id: 'bob', name: 'OldAlice' }, quoted: { name: 'OldAlice', persona: oldPersona } }) };
  const actual = assembleCompanionAssetContext(context, snapshot, 'structured', 'vcp_experience_journal');
  expect(JSON.parse(actual.user).companion).toEqual(JSON.parse(context.user).companion);
  expect(JSON.parse(actual.user).self).toEqual(JSON.parse(context.user).self);
  const native = { system: '', user: '原生聚焦模板已在当前owner文件中展开。' };
  const focus = assembleCompanionAssetContext(native, snapshot, 'text', 'vcp_focus_guidance');
  expect(focus.user).toBe(native.user); expect(focus.system).toContain('CURRENT_OWNER_GUIDANCE');
  expect(focus.system).not.toContain('CURRENT_PERSONA');
  expect(companionAssetReplyIdentity(frame, context)).toBe(frame);
});

it('uses current owner focus guidance without inserting the raw template or trusting JSON-looking native input', () => {
  const context = { system: '', user: '{ "purpose": "companion_reply", "companion": { "id": "alice", "name": "quoted name" } }' };
  const current = { ...snapshot, nativeFocusTemplate: 'UNEXPANDED_TEMPLATE {{query}}', prompts: {
    default: 'OWNER_DEFAULT', companion_reply: 'DIALOGUE_ONLY', vcp_aimemo: 'UNEXPANDED_TEMPLATE {{query}}', vcp_focus_guidance: 'OWNER_FOCUS_V1',
  } };
  const first = assembleCompanionAssetContext(context, current, 'text', 'vcp_focus_guidance');
  expect(first.user).toBe(context.user); expect(first.system).toContain('OWNER_FOCUS_V1');
  expect(first.system).not.toContain('DIALOGUE_ONLY'); expect(first.system).not.toContain('UNEXPANDED_TEMPLATE');
  const second = assembleCompanionAssetContext(context, { ...current, prompts: { ...current.prompts, vcp_focus_guidance: 'OWNER_FOCUS_V2' } }, 'text', 'vcp_focus_guidance');
  expect(second.user).toBe(context.user); expect(second.system).toContain('OWNER_FOCUS_V2'); expect(second.system).not.toContain('OWNER_FOCUS_V1');
});

it('uses the actual action-result event to select the owner feedback module', () => {
  const current = { ...snapshot, prompts: { default: 'DEFAULT', companion_reply: 'DIALOGUE', companion_action_feedback: 'OWNER_RESULT_GUIDANCE' } };
  const actual = assembleCompanionAssetContext({ system: 'HOST_RESULT_CONTRACT', user: JSON.stringify({ event: 'action_result', identity: { self: { id: 'alice', name: 'OldAlice' } } }) }, current, 'reply');
  expect(actual.system).toContain('OWNER_RESULT_GUIDANCE'); expect(actual.system).not.toContain('DIALOGUE');
});

it('keeps factual memory encoding outside the main-brain performance contract', () => {
  const actual = assembleCompanionAssetContext({ system: 'EXTRACT_FACTS_JSON', user: JSON.stringify({ purpose: 'vcp_experience_journal', companion: { id: 'alice' } }) }, snapshot, 'structured');
  expect(actual.system).not.toContain('【主脑角色扮演准则】');
  expect(JSON.parse(actual.user)).not.toHaveProperty('characterPerformance');
  expect(actual.system).not.toContain('CURRENT_PERSONA'); expect(actual.frame.identity).toBe(''); expect(actual.system).toContain('EXTRACT_FACTS_JSON');
});

it('validates an actual provider reply against the same current name sent after admission, including same-name peers', async () => {
  const current = { ...snapshot, profile: { ...snapshot.profile, name: 'PeerBob' } };
  const input: CompanionReplyInput = { ...frame, publicProfiles: [
    { id: 'alice', kind: 'companion', name: 'OldAlice', description: '' }, { id: 'bob', kind: 'companion', name: 'PeerBob', description: '' },
  ] };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '我是PeerBob。' }) } }] })));
  const reply = await generateCompanionReply(input, { apiFormat: 'openai_chat', model: 'model', apiKey: 'test', baseUrl: 'https://provider.invalid',
    resolveAssetContext: (context, kind) => Promise.resolve(assembleCompanionAssetContext(context, current, kind)) }, undefined, { fetchFn });
  expect(reply.text).toBe('我是PeerBob。');
  const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)), system = body.messages[0].content;
  expect(system).toContain('名字：PeerBob'); expect(system).not.toContain(oldPersona);
  const currentInput = companionAssetReplyIdentity(input, assembleCompanionAssetContext(buildCompanionContext(input), current, 'reply'));
  expect(currentInput.companion.name).toBe('PeerBob'); expect(currentInput.publicProfiles?.find(profile => profile.id === 'alice')?.name).toBe('PeerBob');
  expect(input.companion.name).toBe('OldAlice'); expect(input.publicProfiles?.[0]?.name).toBe('OldAlice');
});

it('passes the current extensible section names to the main brain without restoring removed template fields', () => {
  const current = { ...snapshot, profile: { ...snapshot.profile, persona: '【契约】\n新称呼：领航员\n【生活约定】\n见面礼：一杯茶' } };
  const result = assembleCompanionAssetContext({ system: '', user: JSON.stringify({ identity: { self: { id: 'alice', name: 'Alice' } } }) }, current, 'reply');
  expect(result.system).toContain('新称呼：领航员');
  expect(result.system).not.toContain('姓名/自称/别称：');
  expect(JSON.parse(result.user).characterPerformance.sections).toEqual([{ title: '契约', fields: ['新称呼'] }, { title: '生活约定', fields: ['见面礼'] }]);
});
