import { z } from 'zod';

export interface WorkingSummary { summary: string; stage: string }
export interface WorkingSummaryBudget {
  protocol: 'bounded_working_summary_v1';
  scope: 'summary_and_stage_only_not_persona_goal_authorization_or_original_sources';
  maxCombinedChars: number; maxStageChars: number;
  replacementInputChars: number; replacementInputUtf8Bytes: number;
  priorSummaryChars: number; newChunkJsonChars: number;
  providerMaxOutputTokens: number;
}

/** A bounded working set inside the existing provider's output allowance.
 * This is neither a lifetime reasoning quota nor a limit on source facts.
 * Original messages/steps and separate exact user canon remain untouched.
 * Tokenizers differ: bytes/chars are measured here, not called model tokens;
 * the actual provider output cap and explicit truncation remain authoritative. */
export function workingSummaryBudget(input: { previous?: Partial<WorkingSummary>; chunk: unknown;
  moduleWindowChars: number; retainedChars: number; providerMaxOutputTokens: number }): WorkingSummaryBudget {
  const previous = input.previous ? { summary: input.previous.summary ?? '', stage: input.previous.stage ?? '' } : null;
  const chunk = JSON.stringify(input.chunk), replacement = JSON.stringify({ previous, chunk: input.chunk });
  const available = input.moduleWindowChars - Math.max(0, input.retainedChars);
  if (available < 256) throw new Error('保留原文已占满当前工作模块窗口，摘要没有足够空间；需要按需读取原文或缩小端口，未推进水位。');
  const maxCombinedChars = Math.min(3000, available);
  return { protocol: 'bounded_working_summary_v1', scope: 'summary_and_stage_only_not_persona_goal_authorization_or_original_sources',
    maxCombinedChars, maxStageChars: Math.min(320, Math.floor(maxCombinedChars / 4)),
    replacementInputChars: replacement.length, replacementInputUtf8Bytes: Buffer.byteLength(replacement, 'utf8'),
    priorSummaryChars: (previous?.summary.length ?? 0) + (previous?.stage.length ?? 0), newChunkJsonChars: chunk.length,
    providerMaxOutputTokens: input.providerMaxOutputTokens };
}

export function workingSummarySchema(budget: WorkingSummaryBudget) {
  return z.strictObject({ summary: z.string().trim().min(1).max(budget.maxCombinedChars), stage: z.string().trim().max(budget.maxStageChars) })
    .superRefine((value, context) => {
      const serialized = JSON.stringify(value);
      if (value.summary.length + value.stage.length > budget.maxCombinedChars) context.addIssue({ code: 'custom',
        message: `summary与stage合计超过本工作摘要模块${budget.maxCombinedChars}字符预算，不能累加旧摘要。` });
      if (serialized.length >= budget.replacementInputChars || Buffer.byteLength(serialized, 'utf8') >= budget.replacementInputUtf8Bytes)
        context.addIssue({ code: 'custom', message: '新工作摘要没有减少被替换的旧摘要与本批原文的实际JSON字符/UTF8体积。' });
    });
}

/** Regeneration feedback carries constraints, never the entire rejected draft. */
export function workingSummaryFeedback(budget: WorkingSummaryBudget) {
  return `仅重新生成同一来源的summary/stage，合计不超过${budget.maxCombinedChars}字符、stage不超过${budget.maxStageChars}字符，`
    + `实际JSON字符与UTF8字节均须小于被替换输入（${budget.replacementInputChars}字符/${budget.replacementInputUtf8Bytes}字节）。`
    + '整合成当前可恢复状态，勿按章/逐步骤累加历史梗概、反复复制用户“继续”指令或输送技术元数据。'
    + '精确约束、更正、人物、时钟、未履行承诺与未解线索不能丢；独立userCanon原句与完整原消息/steps仍可查，不必在摘要全文复制。'
    + '若确实无法在该工作模块容纳关键状态，应明确需要按需读取原始来源，不能省掉关键事实假装压缩成功。返回完整JSON，不截断字符串。';
}
