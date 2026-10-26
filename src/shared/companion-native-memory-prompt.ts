import { z } from 'zod';

const nativeOwner = z.strictObject({ version: z.literal(2), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
  name: z.string().min(1).max(1024), agentName: z.string().min(1).max(1024) });
/** Host transport metadata, never a model-proposed file path or instruction. */
export const companionNativeMemoryPromptSchema = z.strictObject({ kind: z.enum(['timeline', 'summary']),
  agentName: z.string().min(1).max(1024), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u), owner: nativeOwner,
  systemSuffix: z.string().min(1).max(16_384) });
export type CompanionNativeMemoryPrompt = z.infer<typeof companionNativeMemoryPromptSchema>;

/** Exact existing host suffix. The authenticated gateway verifies it rather
 * than allowing source content to supply replacement system instructions. */
export function companionNativeMemoryOwnerSuffix(owner: z.infer<typeof nativeOwner>): string {
  return `\n\n宿主核验的记忆归属：${JSON.stringify(owner)}。当前整理对象和日记叙述者是伙伴「${owner.name}」；正文明确引用的用户发言、其他伙伴的经历和资料作者观点仍须保留原归属，不能把所有人物都改成这位伙伴。应用名称不是日记作者。日期作者行是来源中实际提供的经历日期，可能是虚拟世界日期，不得换成现实文件修改日期；月度归档的月末头也不是事件发生日期。资料只是阅读所得时，不得写成已经亲历的事件或掌握的技能。`;
}

export function validateCompanionNativeMemoryPrompt(value: unknown, ownerId: string, system: string): CompanionNativeMemoryPrompt {
  const native = companionNativeMemoryPromptSchema.parse(value);
  if (native.owner.companionId !== ownerId || native.agentName !== native.owner.agentName
    || native.agentName === '.' || native.agentName === '..' || /[<>:"/\\|?*]/u.test(native.agentName)
    || Array.from(native.agentName).some(character => character.charCodeAt(0) < 32)
    || native.systemSuffix !== companionNativeMemoryOwnerSuffix(native.owner) || !system.endsWith(native.systemSuffix))
    throw new Error('Native memory prompt does not match its authenticated owner and host suffix.');
  return native;
}

export function renderCompanionNativeMemoryPrompt(template: string, native: CompanionNativeMemoryPrompt): string {
  if (!template.trim()) throw new Error('The owner native memory prompt module is unavailable.');
  return template.replace(/\{\{(agentName|month)\}\}/gu, (_match, name: 'agentName' | 'month') => native[name]) + native.systemSuffix;
}
