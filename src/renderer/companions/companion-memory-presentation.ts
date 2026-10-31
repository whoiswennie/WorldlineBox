import type { CompanionMemoryDocument } from '../../shared/companion-memory-documents';

export function memoryDocumentLabel(document: CompanionMemoryDocument): string {
  if (document.path.startsWith('提示词/')) return '提示词模块';
  if (document.path.startsWith('证据/来源/')) return '记录来源';
  if (document.path.startsWith('证据/历史/')) return '修订历史';
  return { diary: '日记', material: '学习资料', self: '自我认识', world: '世界经历', timeline: '时间线', profile: '角色资料', other: '文本' }[document.category];
}
export function memoryReadonlyDescription(document: CompanionMemoryDocument): string {
  if (document.path.startsWith('提示词/')) return '这是按职能选用的系统指导。创建后只读，可在认知档案中查看完整正文、用途和版本。';
  if (document.kind === 'profile') return '这是当前已发布人格。起点只在创建时准备，后续变化通过有来源的系统发布形成。';
  if (document.kind === 'timeline') return '这份导航由已有记忆整理，不作为新的经历、知识或人格依据重复收录。';
  if (document.path.startsWith('证据/历史/')) return '这是记忆修订的历史证据，不作为新的经历重复收录。';
  if (document.path.startsWith('证据/来源/')) return '这是原始来源的只读凭证，不会因复制、改名或改写产生新的经历。';
  if (document.kind === 'note') return '这是伙伴按正式来源整理的当前记忆，正文只读；更正和反馈通过交流参与后续整理。';
  return '这是用于管理与核对状态的文档，不作为伙伴的新经历收录。';
}

/** Friendly labels are projections; the original filename and body stay intact. */
export function memoryDocumentTitle(document: CompanionMemoryDocument): string {
  if (document.kind === 'profile') return '伙伴档案';
  if (document.kind === 'timeline') {
    const month = /(\d{4})-(\d{2})-(timeline|summary)-[a-f0-9]{16}\.(?:md|txt)$/iu.exec(document.name);
    if (month) return `${month[1]} 年 ${Number(month[2])} 月 · ${month[3] === 'summary' ? '月度摘要' : '生活时间线'}`;
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
