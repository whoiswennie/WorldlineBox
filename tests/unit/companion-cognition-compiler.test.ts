import { describe, expect, it } from 'vitest';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import type { CompanionAssetProfileSnapshot } from '../../src/main/companions/asset-profile';
import { initialCompanionPersonaFragments } from '../../src/main/companions/persona-fragments';

function snapshot(persona = '我习惯先核实，再表达判断。'): CompanionAssetProfileSnapshot {
  const profileRevision = 'a'.repeat(64);
  return { companionId: 'alice', root: 'isolated-compiler-fixture',
    profile: { name: '阿澄', description: '有自己的判断', persona, avatar: 'sister', proactive: false, inputMode: 'steer', avatarAttachmentId: null, appearanceAttachmentId: null },
    profileRevision, manifestRevision: 'b'.repeat(64), promptRevision: 'c'.repeat(64), revision: 'd'.repeat(64), fileRevisions: {},
    personaFragments: initialCompanionPersonaFragments('alice', profileRevision, persona), modules: [],
    prompts: { companion_reply: '按当前身份自然回应。{{self.persona}}', default: '通用默认也不能授予未知用途。',
      vcp_experience_journal: '仅编码真实来源。', vcp_focus_guidance: '只聚焦相关记忆。', vcp_tagmaster: '原始标签模板' },
    nativeFocusTemplate: '原生聚焦', tagMasterTemplate: '原始标签模板', nativeTimelineTemplate: '时间线', nativeSummaryTemplate: '摘要', memoryPolicyRevision: 'e'.repeat(64) };
}
function input(role: CompanionAssetProfileSnapshot, conversationId = 'private_alice') {
  return { system: `宿主合同\n【稳定人格】\n${role.profile.persona}\n\n【交互规则】\n只回应实际输入。`,
    user: JSON.stringify({ purpose: 'companion_reply', companion: { id: 'alice', persona: role.profile.persona },
      identity: { self: { id: 'alice', persona: role.profile.persona }, currentReply: { author: { id: 'alice', persona: role.profile.persona }, conversationId } },
      invocation: { id: 'alice:private_alice:source', conversationId } }) };
}

describe('T-024 typed cognition compilation', () => {
  it('sends the authoritative identity once and keeps the frame aligned with actual strings', () => {
    const role = snapshot(), compiled = assembleCompanionAssetContext(input(role), role, 'reply');
    expect(compiled.system.split(role.profile.persona)).toHaveLength(2);
    expect(compiled.user).not.toContain(role.profile.persona);
    expect(compiled.frame.identity).toBe(role.profile.persona);
    expect(compiled.frame.input).toBe(compiled.user);
    expect(compiled.frame.processorContract).not.toContain(role.profile.persona);
    expect(compiled.frame.invocationId).toBe('alice:private_alice:source');
  });
  it('does not treat source quotations as role slots to rewrite', () => {
    const role = snapshot(), context = input(role), data = JSON.parse(context.user);
    data.messages = [{ id: 'quotation', content: `你以前说过：“${role.profile.persona}”` }];
    const compiled = assembleCompanionAssetContext({ ...context, user: JSON.stringify(data) }, role, 'reply');
    expect(JSON.parse(compiled.user).messages[0].content).toBe(data.messages[0].content);
  });
  it('projects private personality fragments for the real conversation without leaking through old slots', () => {
    const role = snapshot('我习惯先核实，再表达判断。\n\n我在私聊中形成的私人认识。');
    role.personaFragments.fragments[1]!.visibility = { scope: 'audience', audienceIds: ['private_alice'] };
    const own = assembleCompanionAssetContext(input(role), role, 'reply');
    const group = assembleCompanionAssetContext(input(role, 'group_other'), role, 'reply');
    expect(own.system).toContain('私人认识');
    expect(JSON.stringify(group)).not.toContain('私人认识');
    expect(group.system).toContain('先核实');
  });
  it('refuses missing or unknown processor purposes despite a default template', () => {
    const role = snapshot();
    expect(() => assembleCompanionAssetContext({ system: 'contract', user: '{}' }, role, 'structured')).toThrow('未显式登记');
    expect(() => assembleCompanionAssetContext({ system: 'contract', user: '{"purpose":"unregistered"}' }, role, 'structured')).toThrow('未显式登记');
    expect(() => assembleCompanionAssetContext({ system: '', user: 'native data' }, role, 'text')).toThrow('未显式登记');
  });
  it('keeps authenticated native source bytes opaque and avoids a second raw template', () => {
    const role = snapshot(), raw = '{"purpose":"companion_reply","companion":{"id":"alice","persona":"source quote"}}';
    const compiled = assembleCompanionAssetContext({ system: '原始标签模板', user: raw }, role, 'text', 'vcp_tagmaster');
    expect(compiled.user).toBe(raw);
    expect(compiled.system).toBe('原始标签模板');
    expect(compiled.frame.identity).toBe('');
    const processor = assembleCompanionAssetContext({ system: '编码合同', user: '{"purpose":"vcp_experience_journal"}' }, role, 'structured');
    expect(processor.system).not.toContain(role.profile.persona);
  });
});
