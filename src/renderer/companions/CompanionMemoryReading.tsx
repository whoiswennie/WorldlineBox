import { useState } from 'react';
import type { CompanionMemoryDocumentRead } from '../../shared/companion-memory-documents';
import { companionTimestamp } from '../../shared/companion-time';
import { MessageContent } from './MessageContent';
import { Icon } from '../Icons';
import { memoryReadingEnd } from './companion-memory-presentation';

export function MemoryReading({ content, onPageChange }: { content: string; onPageChange(): void }) {
  const [offsets, setOffsets] = useState([0]), [page, setPage] = useState(0);
  const offset = offsets[page] ?? 0, end = memoryReadingEnd(content, offset);
  const change = (next: number) => { setPage(next); onPageChange(); };
  return <>
    {content.length > 16_384 && <p className="memory-library-reading-hint"><Icon name="file-text" />长文分段阅读 · 第 {page + 1} 段 · 原始文档完整保留</p>}
    <div className="memory-library-markdown" data-reading-characters={end - offset}><MessageContent key={offset} content={content.slice(offset, end)} /></div>
    {(page > 0 || end < content.length) && <nav className="memory-library-reading-pagination" aria-label="长文阅读分页">
      <button className="memory-library-quiet" disabled={page === 0} onClick={() => change(page - 1)}><Icon name="chevron-left" />上一段</button>
      <span>第 {page + 1} 段</span>
      <button className="memory-library-quiet" disabled={end === content.length} onClick={() => { setOffsets(current => [...current.slice(0, page + 1), end]); change(page + 1); }}>下一段<Icon name="chevron-right" /></button>
    </nav>}
  </>;
}

const shortTimestamp = (value: string) => companionTimestamp(value).replace(/\.\d{3}$/u, '');
export function MemoryDocumentTimes({ read }: { read: CompanionMemoryDocumentRead }) {
  const created = read.document.createdAt ?? read.memory?.createdAt;
  const occurred = read.document.occurredAt ?? read.memory?.occurredAt;
  return <div className="memory-library-document-times" aria-label="文档时间信息">
    <span><Icon name="clock" />{read.document.createdAtSource === 'file_birthtime' ? '文件创建' : '创建'} {created ? <time dateTime={created} title={(read.document.createdAtSource === 'file_birthtime' ? '文件系统记录，原始写作时间不一定已知 · ' : '') + companionTimestamp(created)}>{shortTimestamp(created)}</time> : '未记录'}</span>
    <span>修改 <time dateTime={read.document.updatedAt} title={companionTimestamp(read.document.updatedAt)}>{shortTimestamp(read.document.updatedAt)}</time></span>
    {occurred && <span>经历 <time dateTime={occurred} title={companionTimestamp(occurred)}>{shortTimestamp(occurred)}</time></span>}
  </div>;
}

export function MemoryDocumentProcessing({ read, onOpen }: { read: CompanionMemoryDocumentRead; onOpen(): void }) {
  if (read.document.readOnly) return <p className="memory-library-document-processing-note"><Icon name="info" />{read.document.kind === 'timeline' ? '由已有记忆整理，日期沿用来源经历的时间，可能与文件创建时间不同。内容不会再次当作新经历收录。' : read.document.kind === 'profile' ? '伙伴设定单独管理，日记整理不会自动改写。' : '系统生成的管理文档。'}</p>;
  const tags = read.tagStatus?.note?.state;
  const tagText = read.document.autoTagsEnabled === false ? '标签手动管理' : tags === 'completed' ? '标签已整理' : tags === 'running' ? '正在整理标签' : tags === 'waiting_model' ? '标签等待模型' : tags === 'failed' ? '标签整理失败' : tags === 'pending' ? '标签待整理' : tags === 'cancelled' ? '标签已取消' : tags === 'stale' ? '标签需要更新' : '标签未安排';
  const indexReady = read.document.syncState === 'indexed';
  return <section className="memory-library-document-processing" aria-label="本文档处理状态">
    <div><span><Icon name="check" />正文已保存</span><span data-state={tags}><Icon name={tags === 'failed' ? 'alert-circle' : tags === 'completed' ? 'check' : 'tag'} />{tagText}</span><span data-state={read.document.syncState}><Icon name={indexReady ? 'check' : 'clock'} />{indexReady ? '向量索引已就绪' : read.document.syncState === 'conflict' ? '修订需要核对' : '记忆索引待处理'}</span></div>
    <p>{indexReady ? '此修订已进入记忆检索，相关话题下可参与召回。' : '保存成功与记忆可召回是两个阶段，后台完成后会更新状态。'}<button onClick={onOpen}>查看处理记录<Icon name="chevron-right" /></button></p>
  </section>;
}
