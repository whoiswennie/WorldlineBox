import type { CompanionMemoryDocument } from '../../shared/companion-memory-documents';

export function memoryDocumentLabel(document: CompanionMemoryDocument): string {
  if (document.path.startsWith('提示词/')) return '提示词模块';
  if (document.path.startsWith('来源/')) return '记录来源';
  if (document.path.startsWith('记忆历史/')) return '修订历史';
  return { diary: '日记', material: '学习资料', self: '自我认识', world: '世界经历', timeline: '时间线', profile: '角色资料', other: '文本' }[document.category];
}
export function memoryReadonlyDescription(document: CompanionMemoryDocument): string {
  if (document.path.startsWith('提示词/')) return '这是行为配置，不是已发生的记忆。每次按职责选用，聊天不会自动新增模块；请在“提示词与记忆规则”中编辑。';
  if (document.kind === 'profile') return '角色设定在“角色资料”中编辑，日记整理不会自动改写。';
  if (document.kind === 'timeline') return '这份时间线由已有记忆整理，不会再次当作新经历收录。需要补充时，可以另存为资料。';
  if (document.path.startsWith('记忆历史/')) return '这是记忆修订的历史记录，随实际修改保留，不作为新的经历重复收录。';
  if (document.path.startsWith('来源/')) return '这是记录的来源凭证，用于核对记忆依据，不作为新的经历重复收录。';
  return '这是用于管理与核对状态的文档，不作为伙伴的新经历收录。';
}

/** Friendly labels are projections; the original filename and body stay intact. */
export function memoryDocumentTitle(document: CompanionMemoryDocument): string {
  if (document.kind === 'profile') return '伙伴档案';
  if (document.kind === 'timeline') {
    const month = /(\d{4})-(\d{2})(?:\.summary)?\.(?:md|txt)$/iu.exec(document.name);
    if (month) return `${month[1]} 年 ${Number(month[2])} 月 · ${/\.summary\./iu.test(document.name) ? '月度摘要' : '生活时间线'}`;
  }
  if (document.captureMethod === 'automatic' && /^note_[a-f0-9]+\.(?:md|txt)$/iu.test(document.name)) {
    const title = [...document.title];
    return title.length > 32 ? title.slice(0, 32).join('') + '…' : document.title;
  }
  return document.title;
}

/** Render one bounded piece, including documents with a single very long line. */
export function memoryReadingEnd(content: string, offset: number, budget = 16_384): number {
  const target = Math.min(content.length, offset + budget);
  if (target === content.length) return target;
  const paragraph = content.lastIndexOf('\n\n', target - 2);
  let end = paragraph > offset + budget / 2 ? paragraph + 2 : target;
  if (end > offset && /[\uD800-\uDBFF]/u.test(content[end - 1]!) && /[\uDC00-\uDFFF]/u.test(content[end]!)) end--;
  return end;
}

export function memoryFilterDate(value: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return;
  const date = new Date(value + (end ? 'T23:59:59.999' : 'T00:00:00.000'));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
