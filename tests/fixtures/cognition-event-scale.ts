import { createHash } from 'node:crypto';

export const COGNITION_EVENT_SCALE_STAGES = [1000, 10000, 100000] as const;
export const cognitionScaleOriginalEvent = (index: number) => `EVENT_SCALE_ORIGINAL_${String(index).padStart(6, '0')}：这是本次隔离验收真正提交的第${index}条独立聊天事件；原始记录保留，不代表已经编码成日记、知识或本人认识。`;
/** HTTP chunks are byte boundaries, not Unicode boundaries. This is the
 * actual-wire observer, separate from the production snapshot writer. */
export function cognitionHttpWireInput(chunks: readonly Uint8Array[]) {
  const bytes = Buffer.concat(chunks);
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
