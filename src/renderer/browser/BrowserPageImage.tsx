import { useEffect, useRef, useState } from 'react';
import type { BrowserPageImage as ImageState } from '../../shared/browser-page-image';
import type { BrowserRequest, BrowserResponse } from '../../shared/browser';
import { useLocale } from '../i18n';
import { Icon } from '../Icons';
import { formatBytes } from '../format-file-meta';
import './browser-page-image.css';

type Run = (request: BrowserRequest) => Promise<BrowserResponse | undefined>;
export function BrowserPageImage({ state, run }: { state: ImageState; run: Run }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN', scroll = useRef<HTMLDivElement>(null);
  const busy = ['preparing', 'capturing', 'encoding'].includes(state.phase), preview = ['preview', 'saving', 'saved'].includes(state.phase);
  const label = ({ preparing: zh ? '正在准备网页和图片…' : 'Preparing the page and images…', capturing: zh ? '正在生成完整网页长图' : 'Capturing the full page', encoding: zh ? '正在完成长图编码…' : 'Finishing the image…', preview: zh ? '长图预览' : 'Image preview', saving: zh ? '正在保存…' : 'Saving…', saved: zh ? '已保存' : 'Saved', cancelled: zh ? '已取消' : 'Cancelled', failed: zh ? '长图生成失败' : 'Capture failed' })[state.phase];
  const close = () => { if (state.phase !== 'saving') void run({ type: 'page.image.close', jobId: state.id }); };
  return <div className="browser-image-backdrop" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); } }}><section className="browser-image-dialog" role="dialog" aria-modal="true" aria-label={zh ? '网页转长图' : 'Full-page image'}>
    <header><span className="browser-image-symbol"><Icon name="file" size={21} /></span><div><h2>{zh ? '网页转长图' : 'Full-page image'}</h2><p title={state.title}>{state.title}</p></div><button type="button" aria-label={zh ? '关闭长图预览' : 'Close image preview'} disabled={state.phase === 'saving'} onClick={close}><Icon name="close" size={18} /></button></header>
    <div className="browser-image-toolbar"><span role="status">{label}{state.phase === 'capturing' && ` · ${state.completed} / ${state.total}`}</span>{state.width && <small>{state.width.toLocaleString()} × {state.height?.toLocaleString()} px{state.bytes ? ' · ' + formatBytes(state.bytes) : ''}</small>}</div>
    {busy && <progress aria-label={zh ? '长图生成进度' : 'Image capture progress'} max={state.total || 1} value={state.total ? state.completed : undefined} />}
    {state.error && <div className="browser-image-error" role="alert"><Icon name="warning" size={18} /><div><strong>{zh ? '操作未完成' : 'Operation did not finish'}</strong><p>{state.error}</p></div></div>}
    {preview ? <div className="browser-image-scroll" ref={scroll} tabIndex={0} aria-label={zh ? '长图预览内容' : 'Image preview content'}><div className="browser-image-paper" style={{ width: Math.min(state.width!, 1000) }}>{Array.from({ length: state.bands! }, (_, index) => <PreviewBand key={state.id + ':' + index} state={state} index={index} run={run} root={scroll} />)}</div></div>
      : <div className="browser-image-empty"><Icon name={busy ? 'file' : 'info'} size={36} /><h3>{label}</h3><p>{busy ? zh ? '分块生成并在后台拼接，完成后可滚动预览整页。' : 'Capturing tiles and stitching in the background. Preview the whole page when ready.' : zh ? '可以关闭此窗口，或重新生成。' : 'Close this window or try again.'}</p></div>}
    <footer><span>{state.savedPath ? <span className="browser-image-saved" role="status" title={state.savedPath}>{zh ? '已保存到：' : 'Saved to: '}{state.savedPath}</span> : zh ? '预览确认后，再选择保存位置。' : 'Preview first, then choose where to save.'}</span>{busy ? <button type="button" onClick={() => void run({ type: 'page.image.cancel', jobId: state.id })}>{zh ? '取消生成' : 'Cancel capture'}</button> : preview ? <button type="button" className="is-primary" disabled={state.phase === 'saving'} onClick={() => void run({ type: 'page.image.save', jobId: state.id })}><Icon name="download" size={16} />{state.phase === 'saving' ? zh ? '正在保存…' : 'Saving…' : zh ? '确认保存…' : 'Save image…'}</button> : <button type="button" onClick={() => void run({ type: 'page.image', id: state.tabId })}>{zh ? '重新生成' : 'Try again'}</button>}</footer>
  </section></div>;
}

function PreviewBand({ state, index, run, root }: { state: ImageState; index: number; run: Run; root: React.RefObject<HTMLDivElement | null> }) {
  const node = useRef<HTMLDivElement>(null), [source, setSource] = useState(''), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!node.current) return;
    let current = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) { setSource(''); return; }
      void run({ type: 'page.image.tile', jobId: state.id, index }).then(result => { if (current) { setSource(result?.ok ? result.pageImageTile ?? '' : ''); setError(!result?.ok); } });
    }, { root: root.current, rootMargin: '600px' });
    observer.observe(node.current); return () => { current = false; observer.disconnect(); };
  }, [state.id, index, run, root, retry]);
  return <div className="browser-image-band" ref={node} style={{ aspectRatio: `${state.width} / ${Math.min(state.bandHeight!, state.height! - index * state.bandHeight!)}` }}>{source ? <img alt="" src={source} draggable={false} /> : error ? <button type="button" onClick={() => { setError(false); setRetry(value => value + 1); }}>↻</button> : null}</div>;
}
