import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** A bounded reading of the owner's source-backed VCP self-understanding diary. */
export const companionCharacterDevelopmentDraftSchema = z.strictObject({
  kind: z.enum(['preference', 'aversion', 'value', 'voice']),
  topic: z.string().trim().min(1).max(80), statement: z.string().trim().min(1).max(300),
  basis: z.enum(['self_expression', 'reflection']), qualification: z.string().trim().min(1).max(300).optional(),
  supersedesMemoryIds: z.array(id).max(8).default([]),
}).superRefine((value, context) => {
  if (value.basis === 'reflection' && !value.qualification) context.addIssue({ code: 'custom', path: ['qualification'], message: '反思形成的认识需要说明适用条件或不确定性。' });
  if (new Set(value.supersedesMemoryIds).size !== value.supersedesMemoryIds.length) context.addIssue({ code: 'custom', path: ['supersedesMemoryIds'], message: '替代的旧认识不能重复。' });
});
export type CompanionCharacterDevelopmentDraft = z.infer<typeof companionCharacterDevelopmentDraftSchema>;
export const companionCharacterDevelopmentCommand = z.strictObject({
  type: z.literal('character.development'), companionId: id, conversationId: id,
  beforeSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(24).default(12),
});
export const companionCharacterDevelopmentSchema = z.strictObject({
  companionId: id, conversationId: id, observedAt: z.iso.datetime(), truncated: z.boolean(),
  items: z.array(z.strictObject({
    memoryId: id, memoryVersion: z.number().int().positive(), kind: z.enum(['preference', 'aversion', 'value', 'voice']),
    topic: z.string().max(80), statement: z.string().max(300), basis: z.enum(['self_expression', 'reflection']),
    qualification: z.string().max(300).optional(), updatedAt: z.string(), sourceMessageIds: z.array(id).max(100),
  })).max(24),
});
export type CompanionCharacterDevelopment = z.infer<typeof companionCharacterDevelopmentSchema>;
export function companionVisibleCharacterDevelopment(value: CompanionCharacterDevelopment | undefined, companionId: string, conversationId: string): CompanionCharacterDevelopment | undefined {
  const parsed = companionCharacterDevelopmentSchema.safeParse(value);
  if (!parsed.success || parsed.data.companionId !== companionId || parsed.data.conversationId !== conversationId) return undefined;
  return parsed.data;
}
export function companionCharacterTopic(topic: string): string { return topic.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' '); }
/** Keep a verified structured stance in the same human-readable VCP document. */
export function normalizeCompanionCharacterDiary<T extends { content: string; diaryName?: string; metadata?: Record<string, unknown>; selfDevelopment?: { statement: string; qualification?: string } }>(candidate: T): T {
  if (!candidate.selfDevelopment) return candidate;
  const { statement, qualification } = candidate.selfDevelopment;
  const extra = [!candidate.content.includes(statement) ? `本人认识原文：${statement}` : '',
    qualification && !candidate.content.includes(qualification) ? `适用条件：${qualification}` : ''].filter(Boolean);
  const metadata = candidate.metadata ? { ...candidate.metadata } : undefined;
  // The explicit proposal is independently validated below. A copied metadata
  // version is never an alternate authority or a way around that validation.
  if (metadata) delete metadata.characterDevelopment;
  return { ...candidate, ...(metadata ? { metadata } : {}), diaryName: '自我认识', content: [candidate.content, ...extra].join('\n\n') };
}

/** The host verifies attribution, not just that a generated paragraph exists. */
export function validateCompanionCharacterDevelopment(input: {
  owner: string; diaryName?: string; content: string; development: CompanionCharacterDevelopmentDraft;
  evidence: ReadonlyArray<{ sourceMessageId: string; quote: string }>;
  sources: ReadonlyArray<{ id: string; authorId: string; content: string }>;
  dependencies: ReadonlyArray<{ id: string; companionId: string; sources: ReadonlyArray<{ messageId: string }> }>;
}): void {
  const { development, sources, evidence, owner } = input;
  if (input.diaryName !== '自我认识' || !input.content.includes(development.statement)
    || development.qualification && !input.content.includes(development.qualification)) throw new Error('成长档案必须来自自我认识日记的实际正文。');
  const selfEvidence = evidence.filter(item => sources.some(source => source.id === item.sourceMessageId && source.authorId === owner && source.content.includes(item.quote)));
  if (!/(?:我|\bI\b|\bfor me\b)/iu.test(development.statement)
    || /(?:我(?:知道|记得|听说|读到|看到|转述|引用)|\bI (?:know|remember|heard|read|quote)\b)/iu.test(development.statement)) throw new Error('成长档案需要本人的明确立场，不能只是转述别人。');
  if (development.basis === 'self_expression') {
    const literal = development.statement.replace(/[\s。.!！?？；;，,、]+$/gu, '');
    if (!literal || !selfEvidence.some(item => item.quote.includes(literal))
      || /(?:他说|她说|用户说|台词|角色扮演|假如|假设|例如|举例|he said|she said|roleplay|for example)/iu.test(development.statement))
      throw new Error('本人的明确偏好或表达必须逐字引用本人正式言行，不能将他人的话归给自己。');
  } else {
    if (!selfEvidence.length || !input.dependencies.length
      || !input.dependencies.every(note => note.companionId === owner && note.sources.some(source => sources.some(message => message.id === source.messageId))))
      throw new Error('反思形成的认识需要本人实际言行及已读取、贡献来源的本人记忆；阅读他人资料不等于认同。');
  }
}
