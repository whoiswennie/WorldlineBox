import type { CompanionAssetProfileSnapshot } from './asset-profile';
import type { CompanionReplyInput } from './context';
import { COMPANION_WORLD_PERCEPTION_RULES } from './world-perception-context';
import { COMPANION_BEHAVIOR_FALLBACK_BEGIN, COMPANION_BEHAVIOR_FALLBACK_END, renderCompanionBehavior } from './asset-behavior-defaults';
import { COMPANION_CHARACTER_PERFORMANCE_RULES, parseCompanionCharacter } from '../../shared/companion-character';
import { parseCharacterDocument } from '../../shared/companion-character-document';

const domainBoundary = '\n【本次领域调用与最终交付】\n';
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

/** Replace only the host's actual role slots. A domain may have been created
 * before the common frame was refreshed, so its inline role cannot be assumed
 * to have the same old persona as the common frame. Never replace quotations,
 * source payloads or arbitrary occurrences of an old name/persona. */
function refreshRoleSlots(system: string, snapshot: CompanionAssetProfileSnapshot, purpose: string, ownContext: boolean): string {
  const { persona, name } = snapshot.profile;
  const replaceSlot = (text: string, start: string, end: string): string => {
    const from = text.indexOf(start); if (from < 0) return text;
    const through = text.indexOf(end, from + start.length); if (through < 0) return text;
    return text.slice(0, from + start.length) + persona + text.slice(through);
  };
  system = replaceSlot(system, '【稳定人格】\n', '\n\n【交互规则】');
  system = system.replace(/^当前角色标识：[^\n]*$/mu,
    `当前角色标识：${JSON.stringify(snapshot.companionId)}；名字：${JSON.stringify(name)}。`);
  const offset = system.indexOf(domainBoundary), from = offset < 0 ? 0 : offset + domainBoundary.length;
  let domain = system.slice(from);
  // These terminators are the exact adjoining host contracts used by world,
  // activity, visit, internal-work and DreamWave calls, not free-text patterns.
  if (offset >= 0 || ownContext && purpose === 'companion_dream_wave_narrative') {
    domain = replaceSlot(domain, '完整稳定人格：\n', '\n\n' + COMPANION_WORLD_PERCEPTION_RULES);
    domain = replaceSlot(domain, '稳定人格：\n', '\n' + COMPANION_WORLD_PERCEPTION_RULES);
    domain = replaceSlot(domain, '稳定人格：\n', '\n这是伙伴发布的内部认知工作，不能调用现实工具');
    if (purpose === 'companion_dream_wave_narrative') domain = replaceSlot(domain, '稳定人格：\n', '\n只返回严格JSON对象{text,relatedMemoryIds}或null。');
    for (const suffix of ['，只扮演自己。稳定人格：\n', '，不是玩家或其他伙伴。稳定人格：\n',
      '，只控制自己。稳定人格：\n', '，稳定人格：\n',
      ...(purpose === 'companion_dream_wave_narrative' ? ['的梦境联想叙述职能。'] : [])]) {
      if (!domain.startsWith('你是')) continue;
      const end = domain.indexOf(suffix, 2);
      if (end >= 2 && end - 2 <= 60) { domain = '你是' + name + domain.slice(end); break; }
    }
  }
  return system.slice(0, from) + domain;
}

/** Post-provider identity checks use the exact same current self name that
 * admission sent, even if the caller was waiting with an older input frame. */
export function companionAssetReplyIdentity(input: CompanionReplyInput, context: { user: string }): CompanionReplyInput {
  try {
    const data = object(JSON.parse(context.user));
    if (object(data?.assetContext)?.companionId !== input.companion.id) return input;
    const self = object(object(data?.identity)?.self) ?? object(data?.companion) ?? object(data?.self);
    if (self?.id !== input.companion.id || typeof self.name !== 'string' || !self.name.trim() || self.name.length > 60) return input;
    const name = self.name;
    return { ...input, companion: { ...input.companion, name },
      ...(input.publicProfiles ? { publicProfiles: input.publicProfiles.map(profile => profile.id === input.companion.id ? { ...profile, name } : profile) } : {}) };
  } catch { return input; }
}

/** Only role content comes from owner files. Source ACLs, output schemas and
 * actual tool authority remain enforced by the host. No built-in role fallback. */
export function assembleCompanionAssetContext(context: { system: string; user: string }, snapshot: CompanionAssetProfileSnapshot,
  kind: 'reply' | 'structured' | 'text'): { system: string; user: string } {
  // Only the authenticated native transport sends an empty system slot. Its
  // already rendered user template stays byte-for-byte opaque, even if an
  // editable template happens to produce JSON. Guidance is a separate live
  // owner module, not another copy of the unexpanded native template.
  const nativeFocus = kind === 'text' && !context.system.trim();
  let data: Record<string, unknown> | undefined;
  if (!nativeFocus) try { const parsed: unknown = JSON.parse(context.user); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* Some text contracts use plain input. */ }
  const purpose = nativeFocus ? 'vcp_focus_guidance' : typeof data?.purpose === 'string' ? data.purpose : kind === 'reply'
    ? data?.event === 'action_result' ? 'companion_action_feedback' : 'companion_reply' : 'default';
  const promptTemplate = snapshot.prompts[purpose] ?? snapshot.prompts.default;
  const prompt = promptTemplate && renderCompanionBehavior(promptTemplate, { ...snapshot.profile, id: snapshot.companionId,
    mode: typeof data?.mode === 'string' ? data.mode : undefined });
  if (!prompt) throw new Error('伙伴提示词文件未提供当前用途或default模块。');
  const profile = snapshot.profile;
  const own = (value: unknown) => object(value)?.id === snapshot.companionId;
  // buildCompanionContext also serves direct noncanonical unit fixtures. Its
  // tagged defaults must never survive a canonical provider admission.
  let canonicalSystem = context.system;
  const fallbackStart = canonicalSystem.indexOf(COMPANION_BEHAVIOR_FALLBACK_BEGIN), fallbackEnd = canonicalSystem.indexOf(COMPANION_BEHAVIOR_FALLBACK_END, fallbackStart);
  if (fallbackStart >= 0) {
    if (fallbackEnd < 0) throw new Error('非canonical默认行为块不完整，未发送模型。');
    canonicalSystem = canonicalSystem.slice(0, fallbackStart) + canonicalSystem.slice(fallbackEnd + COMPANION_BEHAVIOR_FALLBACK_END.length);
  }
  let system = refreshRoleSlots(canonicalSystem, snapshot, purpose,
    own(data?.companion) || own(data?.self) || own(object(data?.identity)?.self));
  system += `\n【当前伙伴目录中的身份与可编辑行为指导】\n角色标识：${snapshot.companionId}\n名字：${profile.name}\n简介：${profile.description}\n完整人格：\n${profile.persona}\n\n${prompt}\n角色身份与行为偏好依据本次实际文件内容；技术输出格式、真实来源与工具授权仍按宿主合同核验。`;
  // Acting belongs to the main brain, including its world/social domains.
  // Journal extraction and other memory processors retain their own output
  // contract and do not turn evidence into an in-character performance.
  const acting = kind === 'reply' || purpose === 'world_attention' || purpose === 'companion_dream_wave_narrative';
  if (acting) system += '\n' + COMPANION_CHARACTER_PERFORMANCE_RULES;
  if (data) {
    const companion = data.companion;
    if (companion && typeof companion === 'object' && !Array.isArray(companion)
      && (companion as Record<string, unknown>).id === snapshot.companionId) data.companion = { ...companion, ...profile };
    const currentSelf = (value: unknown) => own(value) ? { ...object(value), name: profile.name, description: profile.description,
      ...(object(value)?.persona !== undefined ? { persona: profile.persona } : {}) } : value;
    data.self = currentSelf(data.self);
    const identity = object(data.identity);
    if (identity) {
      const reply = object(identity.currentReply);
      data.identity = { ...identity, self: currentSelf(identity.self),
        ...(Array.isArray(identity.participants) ? { participants: identity.participants.map(currentSelf) } : {}),
        ...(reply ? { currentReply: { ...reply, author: currentSelf(reply.author) } } : {}) };
    }
    data.assetContext = { companionId: snapshot.companionId, profileRevision: snapshot.profileRevision, promptRevision: snapshot.promptRevision };
    if (acting) data.characterPerformance = { schema: 'worldlinebox.character-performance-v1', companionId: snapshot.companionId,
      profileRevision: snapshot.profileRevision, source: 'profile.md',
      format: parseCompanionCharacter(profile.persona).standardized ? 'standard_character_sheet' : 'authored_free_text',
      sections: parseCharacterDocument(profile.persona).map(section => ({ title: section.title, fields: section.fields.map(field => field.label) })),
      growthSource: 'current_visible_characterDevelopment', stateSource: 'current_host_runtimeState' };
  }
  return { system, user: data ? JSON.stringify(data) : context.user };
}
