import { useEffect, useMemo, useState } from 'react';
import { officeFormat, type BotMediaRef, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';

const elements = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS('*', name));
function parse(xml?: string) {
  if (!xml) throw Error('Document part missing');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (elements(doc, 'parsererror').length) throw Error('Invalid XML');
  return doc;
}
type Section = { title: string; path: string };
function sections(parts: Record<string, string>, format: string, zh: boolean): Section[] {
  if (format === 'docx') return [{ title: zh ? '正文' : 'Document', path: 'word/document.xml' }];
  const slides = format === 'pptx', dir = slides ? 'ppt' : 'xl', file = slides ? 'presentation' : 'workbook';
  const rels = parse(parts[dir + '/_rels/' + file + '.xml.rels']);
  const paths = new Map(elements(rels, 'Relationship').map(el => [el.getAttribute('Id'), el.getAttribute('Target') || '']));
  return elements(parse(parts[dir + '/' + file + '.xml']), slides ? 'sldId' : 'sheet').map((el, index) => {
    const id = el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? el.getAttribute('r:id');
    const target = paths.get(id) || '';
    return { title: el.getAttribute('name') || (zh ? '幻灯片 ' : 'Slide ') + (index + 1), path: target.startsWith('/') ? target.slice(1) : dir + '/' + target };
  });
}
function cellColumn(ref: string) {
  let n = 0;
  for (const letter of ref.match(/^[A-Z]+/)?.[0] || '') n = n * 26 + letter.charCodeAt(0) - 64;
  return n - 1;
}
function columnName(index: number): string {
  return (index >= 26 ? columnName(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + index % 26);
}

export function BotOfficeReader({ media, api, conversationId, zh }: { media: BotMediaRef; api?: WorldlineBoxBotMediaApi; conversationId: string; zh: boolean }) {
  const [parts, setParts] = useState<Record<string, string>>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [section, setSection] = useState(0), [page, setPage] = useState(0);
  const format = officeFormat(media.originalName || media.name)!;
  useEffect(() => {
    let active = true;
    async function read() {
      try {
        const response = await api?.request({ type: 'media.office.read', conversationId, id: media.id });
        if (!response?.ok || !response.officeParts) throw Error(response?.error || (zh ? '文档读取失败。' : 'Could not read document.'));
        if (active) setParts(response.officeParts);
      } catch (e) { if (active) setError(String(e instanceof Error ? e.message : e)); }
    }
    void read();
    return () => { active = false; };
  }, [api, conversationId, media.id, attempt, zh]);
  const model = useMemo(() => {
    if (!parts) return;
    try {
      const list = sections(parts, format, zh);
      const doc = parse(parts[list[section]?.path || '']);
      return { list, items: elements(doc, format === 'xlsx' ? 'row' : 'p') };
    } catch { return null; }
  }, [parts, format, section, zh]);
  const strings = useMemo(() => {
    if (!parts?.['xl/sharedStrings.xml']) return [];
    try { return elements(parse(parts['xl/sharedStrings.xml']), 'si').map(si => elements(si, 't').map(t => t.textContent).join('')); }
    catch { return undefined; }
  }, [parts]);
  if (!model || !strings || error) return <div className="bot-attachment-viewer-empty" role="status">{error || (model === null || !strings ? zh ? '无法解析文档，请使用系统应用打开。' : 'Unable to parse document. Open it in your system app.' : zh ? '正在读取文档…' : 'Reading document…')}{error && <button onClick={() => { setError(''); setAttempt(n => n + 1); }}>{zh ? '重试' : 'Retry'}</button>}</div>;
  const size = 80, pages = Math.max(1, Math.ceil(model.items.length / size)), visible = model.items.slice(page * size, (page + 1) * size);
  let columns = 1, clipped = false;
  const rows = format === 'xlsx' ? visible.map(row => {
    const cells: string[] = [];
    let next = 0;
    for (const cell of elements(row, 'c')) {
      const at = cell.hasAttribute('r') ? cellColumn(cell.getAttribute('r')!) : next;
      if (at < 0 || at > 99) { clipped = true; continue; }
      next = at + 1;
      const type = cell.getAttribute('t'), value = elements(cell, 'v')[0]?.textContent ?? '';
      cells[at] = type === 's' ? strings[Number(value)] || '' : type === 'inlineStr' ? elements(cell, 't').map(t => t.textContent).join('') : value;
      columns = Math.max(columns, next);
    }
    return { index: row.getAttribute('r'), cells };
  }) : [];
  return <>
    <div className="attachment-tools"><strong>{format.toUpperCase()}</strong><span>{zh ? '内容预览' : 'Content preview'}</span>
      {format !== 'docx' && <select aria-label={zh ? '文档章节' : 'Document section'} value={section} onChange={e => { setSection(Number(e.target.value)); setPage(0); }}>{model.list.map((item, i) => <option key={i} value={i}>{item.title}</option>)}</select>}
    </div>
    <div key={section + '/' + page} className="attachment-office-stage" tabIndex={0}>
      {format === 'xlsx' ? <table><thead><tr><th>#</th>{Array.from({ length: columns }, (_, i) => <th key={i}>{columnName(i)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}><th>{row.index || page * size + i + 1}</th>{Array.from({ length: columns }, (_, j) => <td key={j}>{row.cells[j]}</td>)}</tr>)}</tbody></table>
        : <article>{visible.map((p, i) => <p key={i}>{elements(p, 't').map(t => t.textContent).join('') || '\u00a0'}</p>)}</article>}
    </div>
    <footer className="attachment-tools"><span>{clipped ? zh ? '显示前 100 列' : 'First 100 columns' : zh ? '只读' : 'Read only'}</span><div className="attachment-spacer"/><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>{zh ? '上一段' : 'Previous'}</button>{page + 1} / {pages}<button disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>{zh ? '下一段' : 'Next'}</button></footer>
  </>;
}

