import { parseCharacterDocument } from './companion-character-document';

/** Human-editable profile.md remains the only authored persona. These fields
 * provide an editor and model projection, never a second persisted identity. */
export const COMPANION_CHARACTER_SECTIONS = [
  { title: '基础', fields: [
    { key: 'names', label: '姓名/自称/别称' },
    { key: 'identity', label: '年龄/种族/身份' },
    { key: 'appearance', label: '外貌/服装/标志物' },
    { key: 'belongings', label: '常驻地/随身物' },
  ] },
  { title: '演法核心', fields: [
    { key: 'personality', label: '性格' }, { key: 'voice', label: '说话方式' },
    { key: 'mannerisms', label: '口癖/小动作' }, { key: 'preferences', label: '喜欢/讨厌及表现' },
    { key: 'boundaries', label: '底线/雷点' }, { key: 'flaws', label: '弱点/缺陷' },
    { key: 'goals', label: '目标/执念' }, { key: 'fears', label: '恐惧/秘密' },
  ] },
  { title: '关系', fields: [
    { key: 'player', label: '对玩家初始态度/称呼' }, { key: 'social', label: '对熟人/陌生人' },
    { key: 'contacts', label: '重要联系人及相处模式' },
  ] },
  { title: '能力', fields: [
    { key: 'skills', label: '擅长/不擅长' }, { key: 'costs', label: '能力限制/代价' },
  ] },
  { title: '背景与成长', fields: [
    { key: 'background', label: '背景/设定适用范围' },
    { key: 'growth', label: '成长方向/变化约定' },
  ] },
] as const;
export type CompanionCharacterField = typeof COMPANION_CHARACTER_SECTIONS[number]['fields'][number]['key'];
export type CompanionCharacterFields = Record<CompanionCharacterField, string>;
export interface CompanionCharacterSheet { fields: CompanionCharacterFields; extra: string; standardized: boolean }
const allFields = COMPANION_CHARACTER_SECTIONS.flatMap(section => [...section.fields]);

export function emptyCompanionCharacter(name = ''): CompanionCharacterFields {
  return Object.fromEntries(allFields.map(field => [field.key, field.key === 'names' ? name : ''])) as CompanionCharacterFields;
}

/** Only exact field headings are interpreted. All unrecognized authored text
 * stays intact in extra; conversion never guesses facts from legacy prose. */
export function parseCompanionCharacter(persona: string): CompanionCharacterSheet {
  const fields = emptyCompanionCharacter(), seen = new Set<string>(), extra: string[] = [];
  let active: CompanionCharacterField | undefined;
  let inExtra = false;
  for (const line of persona.replace(/\r\n/gu, '\n').split('\n')) {
    if (inExtra) { extra.push(line); continue; }
    if (active && line.startsWith('  ')) { fields[active] += '\n' + line.slice(2); continue; }
    const field = allFields.find(item => line.startsWith(item.label + '：') || line.startsWith(item.label + ':'));
    if (field && !seen.has(field.key)) {
      seen.add(field.key); active = field.key;
      fields[active] = line.slice(field.label.length + 1).trim(); continue;
    }
    if (/^【[^】]+】\s*$/u.test(line)) {
      active = undefined;
      if (!COMPANION_CHARACTER_SECTIONS.some(section => line.trim() === `【${section.title}】`)) { extra.push(line); inExtra = true; }
      continue;
    }
    if (active) fields[active] += '\n' + line;
    else extra.push(line);
  }
  for (const field of allFields) fields[field.key] = fields[field.key].trim();
  return { fields, extra: extra.join('\n').trim(), standardized: allFields.slice(0, 17).every(field => seen.has(field.key)) };
}

export function renderCompanionCharacter(fields: CompanionCharacterFields, extra = ''): string {
  const sheet = COMPANION_CHARACTER_SECTIONS.map(section => `【${section.title}】\n`
    + section.fields.map(field => `${field.label}：${fields[field.key].trim().replace(/\n/gu, '\n  ')}`).join('\n')).join('\n\n');
  return sheet + (extra.trim() ? '\n\n' + extra.trim() : '');
}

/** Lossless opt-in conversion for existing custom/free-text profiles. */
export function standardizeCompanionCharacter(persona: string, name: string): string {
  const parsed = parseCompanionCharacter(persona);
  if (parsed.standardized || parseCharacterDocument(persona).length) return persona;
  const fields = emptyCompanionCharacter(name);
  return renderCompanionCharacter(fields, persona.trim() ? `【补充设定】\n${persona.trim()}` : '');
}

/** The main brain applies the live sheet across speech, decisions and tool
 * continuations. Provenance and capability enforcement stay with the host. */
export const COMPANION_CHARACTER_PERFORMANCE_RULES = `【主脑角色扮演准则】
本轮当前伙伴目录的profile.md是作者可随时修改的完整人设。基础、演法核心、关系、能力是创建时的起始模板，作者可以新增、改名或删除任意章节和字段。严格按当前完整源文本中的设定扮演当前self；缺少或已删除的字段不从出厂模板补回，自定义设定同等有效。所有角色表达、世界决策、伙伴交流和任务结果反馈均使用本次读取的版本，不沿用旧循环、旧摘要或出厂人设覆盖当前资料。资料头中的当前名字确定本轮身份，别称只用于自然称呼，不改变真实ID。
把性格、表达、喜恶、底线、缺陷与目标落实为具体的措辞、选择和反应。严肃任务保留角色语气但先把事情做好；不逐项背诵模板，不每句触发口癖，不用统一客服语气，也不为了演缺陷而故意犯错。小动作只能是与当前身体状态一致的简短表达，不把描写冒充真实移动、持物或工具成功。
这是一份可成长的人设，不是永久冻结的标签。本轮characterDevelopment仅含本人有来源、仍有效且本入口可见的当前认识：可在对应主题和条件内演变喜好、厌恶、价值与表达；保留qualification。当前资料明确写出的修订或变化约定优先，不能因旧日记恢复已改设定；未明确冲突的成长自然融入人设，不把暂时心情改写成永久人格。普通聊天、别人偏好、引用和模型猜测不能自动改人设。
关系称呼以当前资料、真实参与者ID及实际相处为准。初始亲近不证明恋爱、信任或共同过去；重要联系人设定不授权共享私聊。年龄、恐惧、秘密或背景未设定就保留未知，不临场补造创伤、秘密和往事。故事能力、标志物与擅长只约束角色表现，不新增工具或保证熟练；世界、DSH、browser、memory按当前真实能力清单与回执使用。`;
