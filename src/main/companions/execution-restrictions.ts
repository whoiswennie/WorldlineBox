import { createHash } from 'node:crypto';
import type { CompanionMessage } from '../../shared/companions';
import type { DshExecutionConstraint } from '../../shared/dsh-task-spec';

/** Original source clauses are durable evidence, including positive, conditional
 * and scope requirements. They are not a second task or model-made authority. */
export function companionExecutionConstraintLedger(sources: readonly (Pick<CompanionMessage, 'id' | 'content'> & { revision?: number })[]): DshExecutionConstraint[] {
  return sources.flatMap(source => {
    const sourceDigest = createHash('sha256').update(source.content).digest('hex');
    const entries: DshExecutionConstraint[] = [];
    for (let offset = 0; offset < source.content.length;) {
      let end = Math.min(source.content.length, offset + 16000);
      if (end < source.content.length && /[\uD800-\uDBFF]/u.test(source.content[end - 1]!)) end--;
      entries.push({ id: createHash('sha256').update(JSON.stringify([source.id, source.revision, sourceDigest, offset])).digest('hex'),
        sourceMessageId: source.id, sourceDigest, revision: source.revision, kind: 'source_requirements', text: source.content.slice(offset, end) });
      offset = end;
    }
    return entries;
  });
}

/** Literal negatives remain a prompt hint; the source ledger is authoritative. */
export function companionExecutionRestrictions(source: string): string[] {
  const restrictions = new Set<string>();
  for (const clause of source.split(/[。；;！？!?\r\n]|\.(?:\s+|$)/u)) {
    const starts = [...clause.matchAll(/只读|禁止|不得|不可|不许|不能|不要|不准|不(?:修改|写入|删除|移动|上传|分享|联网|访问|运行|执行)|仅限|只能在|只允许|(?:do\s+not|don't|must\s+not|read[ -]?only|without\s+(?:changing|writing|deleting|uploading))\b/giu)];
    for (const start of starts) {
      const text = clause.slice(start.index).split(/[，,]|(?:然后|之后|接着|再让|并请|并让|交给)|\band\s+(?:ask|let|have|then)\b/iu)[0]?.trim();
      if (text) restrictions.add(text);
    }
  }
  return [...restrictions];
}
