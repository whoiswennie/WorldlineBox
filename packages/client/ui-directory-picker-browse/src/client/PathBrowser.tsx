import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronRightOutline14, IconFolderClose16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryEntry, DirectoryListing, PathPickerRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import css from './PathBrowser.module.css'

type FilePathRequest = Exclude<PathPickerRequest, { mode: 'directory' }>

export interface PathBrowserProps {
  open: boolean
  busy: boolean
  request: FilePathRequest
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  resolveFile: (path: string, name: string) => Promise<string>
  onOpen: (path: string) => void
  onClose: () => void
  t: Translate
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accepts(name: string, extensions: readonly string[]): boolean {
  if (extensions.length === 0) return true
  const lower = name.toLocaleLowerCase()
  return extensions.some(extension => lower.endsWith(`.${extension.toLocaleLowerCase()}`))
}

export function PathBrowser(props: PathBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing>()
  const [selected, setSelected] = useState<DirectoryEntry>()
  const [fileName, setFileName] = useState('')
  const [directoryDraft, setDirectoryDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const requestSequence = useRef(0)

  const load = (path?: string): void => {
    const sequence = ++requestSequence.current
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    void props.listDirectory(path, controller.signal).then(
      (next) => {
        if (sequence !== requestSequence.current) return
        setListing(next)
        setDirectoryDraft(next.path)
        setSelected(undefined)
        setLoading(false)
      },
      (reason: unknown) => {
        if (sequence !== requestSequence.current) return
        setError(messageOf(reason))
        setLoading(false)
      },
    )
  }

  useEffect(() => {
    if (!props.open) {
      requestSequence.current += 1
      return
    }
    setListing(undefined)
    setSelected(undefined)
    setFileName(props.request.mode === 'save-file' ? props.request.suggestedName : '')
    load()
  }, [props.open, props.request.mode, props.request.mode === 'save-file' ? props.request.suggestedName : ''])

  const entries = useMemo(() => (listing?.entries ?? []).filter(entry =>
    entry.kind !== 'file' || accepts(entry.name, props.request.extensions)), [listing, props.request.extensions])
  const validSaveName = props.request.mode !== 'save-file'
    || (fileName.trim() !== '' && !/[/\\]/.test(fileName) && accepts(fileName, props.request.extensions))

  const commit = async (): Promise<void> => {
    if (props.busy || loading || listing === undefined) return
    if (props.request.mode === 'open-file') {
      if (selected?.kind === 'file') props.onOpen(selected.path)
      return
    }
    if (!validSaveName) return
    try {
      props.onOpen(await props.resolveFile(listing.path, fileName))
    } catch (reason: unknown) {
      setError(messageOf(reason))
    }
  }

  if (!props.open) return null
  return <Modal
    open
    title={props.request.title}
    onClose={() => { if (!props.busy) props.onClose() }}
    rootClassName={css.modalLayer as string}
    headless
  >
    <section className={css.card}>
      <header><div><span>✦</span><h2>{props.request.title}</h2></div><button type="button" aria-label={props.t('browser.cancel')} onClick={props.onClose}>×</button></header>
      <nav aria-label={props.request.title}>
        <input
          aria-label={props.t('browser.editPath')}
          value={directoryDraft}
          disabled={loading || props.busy}
          onChange={(event) => { setDirectoryDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && directoryDraft.trim() !== '') { event.preventDefault(); load(directoryDraft) } }}
        />
        <div>{listing?.crumbs.map((crumb, index) => <span key={crumb.path}>
          {index > 0 && <IconChevronRightOutline14 size={12} />}
          <button type="button" disabled={loading || props.busy} onClick={() => { load(crumb.path) }}>{crumb.name}</button>
        </span>)}</div>
      </nav>
      <div className={css.list} role="listbox" aria-busy={loading}>
        {entries.map(entry => <button
          type="button"
          key={entry.path}
          role="option"
          aria-selected={selected?.path === entry.path}
          data-kind={entry.kind ?? 'directory'}
          onClick={() => {
            if (entry.kind === 'file') setSelected(entry)
            else load(entry.path)
          }}
          onDoubleClick={() => { if (entry.kind === 'file' && props.request.mode === 'open-file') props.onOpen(entry.path) }}
        >
          <i>{entry.kind === 'file' ? '归档' : <IconFolderClose16 size={18} />}</i>
          <span>{entry.name}</span>
          <b>{entry.kind === 'file' ? props.t('path.choose') : '›'}</b>
        </button>)}
        {!loading && entries.length === 0 && <p>{props.t('path.noFiles')}</p>}
        {loading && <p>{props.t('browser.loading')}</p>}
      </div>
      {props.request.mode === 'save-file' && <label className={css.nameField}>
        <span>{props.t('path.fileName')}</span>
        <input autoFocus value={fileName} onChange={(event) => { setFileName(event.target.value); setError(undefined) }} />
        {!validSaveName && <small>{props.t('path.extensionHint', { extensions: props.request.extensions.join('、') })}</small>}
      </label>}
      {listing?.truncated === true && <p className={css.note}>{props.t('browser.truncated')}</p>}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <footer>
        <Button variant="outline" disabled={props.busy} onClick={props.onClose}>{props.t('browser.cancel')}</Button>
        <Button
          variant="primary"
          disabled={props.busy || loading || listing === undefined || (props.request.mode === 'open-file' ? selected?.kind !== 'file' : !validSaveName)}
          onClick={() => { void commit() }}
        >
          {props.request.mode === 'open-file' ? props.t('path.choose') : props.t('path.save')}
        </Button>
      </footer>
    </section>
  </Modal>
}
