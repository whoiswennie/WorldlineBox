/** Only literal restrictive clauses may be added by the host; the user's other goals stay in the main brain. */
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
