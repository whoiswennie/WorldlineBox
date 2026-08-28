import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ReferenceAsset } from '../contracts.ts'
import { companionStore, useCompanionStore } from './store.ts'
import { searchReferences } from './reference-client.ts'
import css from './CompanionMemePicker.module.css'

export interface CompanionMemePickerInjected {
  readonly stageMeme: (meme: ReferenceAsset) => boolean
}

type PickerProps = PropsRuntime<'conversation.input.left'> & InjectFace<CompanionMemePickerInjected>
const MEME_PAGE_SIZE = 24

/** QQ-style sticker picker: every choice is staged as a removable, serializable draft chip. */
export function CompanionMemePicker({ input, stageMeme }: PickerProps) {
  const directory = useCompanionStore()
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [page, setPage] = useState(1)
  const [memes, setMemes] = useState<readonly ReferenceAsset[]>([])
  const [nextCursor, setNextCursor] = useState(-1)
  const [error, setError] = useState('')
  const deferredQuery = useDeferredValue(query)
  const scopes = useMemo(() => scope === 'all'
    ? ['public', ...directory.companions.map(item => item.id)]
    : [scope], [directory.companions, scope])
  useEffect(() => { void companionStore.load() }, [])
  useEffect(() => { setPage(1) }, [query, scope])
  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      const details = detailsRef.current
      if (details?.open === true && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    const timer = window.setTimeout(() => {
      void searchReferences({ scopes, query: deferredQuery, tags: ['表情包'], limit: 96 })
        .then((page) => { if (!abort.signal.aborted) { setMemes(page.items); setNextCursor(page.nextCursor); setError('') } })
        .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    }, 120)
    return () => { abort.abort(); window.clearTimeout(timer) }
  }, [deferredQuery, scopes])
  const pageCount = Math.max(1, Math.ceil(memes.length / MEME_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageMemes = memes.slice((currentPage - 1) * MEME_PAGE_SIZE, currentPage * MEME_PAGE_SIZE)
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  const locked = input.phase !== 'plain'

  const choose = (meme: ReferenceAsset): void => {
    if (locked) return
    stageMeme(meme)
  }
  const nextPage = async (): Promise<void> => {
    if (currentPage < pageCount) { setPage(value => value + 1); return }
    if (nextCursor < 0) return
    try {
      const result = await searchReferences({ scopes, query: deferredQuery, tags: ['表情包'], cursor: nextCursor, limit: 96 })
      setMemes(current => [...current, ...result.items])
      setNextCursor(result.nextCursor)
      setPage(value => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return <details className={css.picker} ref={detailsRef}>
    <summary
      aria-label="选择表情包"
      aria-disabled={locked}
      title={locked ? '消息正在发送，请稍候' : '添加表情包到消息'}
      onClick={(event) => { if (locked) event.preventDefault() }}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M3.25 6.25A3 3 0 0 1 6.25 3.25h7.5a3 3 0 0 1 3 3v5.38a3 3 0 0 1-.88 2.12l-2.12 2.12a3 3 0 0 1-2.12.88H6.25a3 3 0 0 1-3-3v-7.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M12.25 16.68v-2.43a2 2 0 0 1 2-2h2.43" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="7.25" cy="8" r=".9" fill="currentColor" />
        <circle cx="12.75" cy="8" r=".9" fill="currentColor" />
        <path d="M7.2 11.15c.7.83 1.63 1.25 2.8 1.25s2.1-.42 2.8-1.25" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </summary>
    <div className={css.panel}>
      <header>
        <strong>表情包</strong>
        <span>{memes.length} 张</span>
      </header>
      <div className={css.filters}>
        <input
          aria-label="搜索表情包"
          value={query}
          placeholder="搜索情绪、动作或名称"
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <select aria-label="表情包分组" value={scope} onChange={(event) => { setScope(event.target.value) }}>
          <option value="all">全部角色</option>
          <option value="public">公共</option>
          {directory.companions.map(companion => <option value={companion.id} key={companion.id}>
            {companion.name}
          </option>)}
        </select>
      </div>
      <div className={css.grid} role="listbox" aria-label="可选择的表情包">
        {pageMemes.map(meme => <button
          type="button"
          role="option"
          aria-selected="false"
          title={`${meme.title} · ${meme.tags.join(' · ')}`}
          onClick={() => { choose(meme) }}
          key={meme.id}
        >
          <img src={meme.url} alt={meme.title} loading="lazy" />
          <span>{meme.title}</span>
        </button>)}
        {memes.length === 0 && <p>{error === '' ? '没有匹配的表情' : error}</p>}
      </div>
      <footer>
        <span>点击加入输入框，可连续选择多张并与文字一起发送。</span>
        {memes.length > 0 ? <nav aria-label="表情包分页">
          <button type="button" aria-label="上一页" disabled={currentPage === 1} onClick={() => { setPage(value => Math.max(1, value - 1)) }}>‹</button>
          <b>{currentPage} / {pageCount}</b>
          <button type="button" aria-label="下一页" disabled={currentPage === pageCount && nextCursor < 0} onClick={() => { void nextPage() }}>›</button>
        </nav> : null}
      </footer>
    </div>
  </details>
}
