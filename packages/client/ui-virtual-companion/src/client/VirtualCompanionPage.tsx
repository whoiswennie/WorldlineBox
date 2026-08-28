import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  VirtualCompanion,
  VirtualCompanionDraft,
} from '../contracts.ts'
import { companionStore, useCompanionStore } from './store.ts'
import css from './VirtualCompanionPage.module.css'

export interface VirtualCompanionPageInjected {
  launch(companionId: string): Promise<void>
}

export type VirtualCompanionPageProps = PropsRuntime<'worldline.main.page'>
  & PropsLocale<'virtualCompanion'>
  & InjectFace<VirtualCompanionPageInjected>

const EMPTY_DRAFT: VirtualCompanionDraft = {
  name: '', handle: '', avatar: '', portrait: '', status: '', description: '',
  persona: '', style: '', speakingStyle: '', behaviorLogic: '',
}

function toDraft(companion: VirtualCompanion): VirtualCompanionDraft {
  const { name, handle, avatar, portrait, status, description, persona, style, speakingStyle, behaviorLogic } = companion
  return { name, handle, avatar, portrait, status, description, persona, style, speakingStyle, behaviorLogic }
}

function imageFromFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    return Promise.reject(new Error('请选择 PNG、JPEG 或 WebP 图片'))
  }
  if (file.size > 5 * 1_024 * 1_024) return Promise.reject(new Error('图片不能超过 5 MB'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('图片读取失败'))
    }
    reader.onerror = () => { reject(new Error('图片读取失败')) }
    reader.readAsDataURL(file)
  })
}

function PromptCard({ title, value }: { title: string; value: string }) {
  return <section className={css.promptCard}><h4>{title}</h4><p>{value}</p></section>
}

function ConfirmDialog(props: {
  title: string
  description: string
  confirmLabel: string
  tone: 'danger' | 'restore'
  busy?: boolean
  onCancel(): void
  onConfirm(): void
}) {
  return <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && props.busy !== true) props.onCancel()
  }}>
    <section className={css.confirmDialog} role="dialog" aria-modal="true" aria-labelledby="companion-confirm-title">
      <h2 id="companion-confirm-title">{props.title}</h2>
      <p>{props.description}</p>
      <footer>
        <button type="button" disabled={props.busy} onClick={() => { props.onCancel() }}>取消</button>
        <button type="button" data-tone={props.tone} disabled={props.busy} onClick={() => { props.onConfirm() }}>
          {props.busy === true ? '处理中…' : props.confirmLabel}
        </button>
      </footer>
    </section>
  </div>
}

function CompanionEditor(props: { companion?: VirtualCompanion; onClose(): void }) {
  const companion = props.companion
  const [draft, setDraft] = useState<VirtualCompanionDraft>(() => companion ? toDraft(companion) : EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key: keyof VirtualCompanionDraft, value: string): void => {
    setDraft(current => ({ ...current, [key]: value }))
  }
  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    if (file === undefined) return
    try {
      const avatar = await imageFromFile(file)
      setDraft(current => ({ ...current, avatar, portrait: avatar }))
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const save = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (companion === undefined) await companionStore.create(draft)
      else await companionStore.update(companion.id, draft)
      props.onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false)
    }
  }
  return <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose()
  }}>
    <section className={css.editor} role="dialog" aria-modal="true" aria-label={companion ? '编辑伙伴' : '新增伙伴'}>
      <header><div><span>COMPANION PROFILE</span><h2>{companion ? '编辑伙伴' : '新增伙伴'}</h2></div>
        <button type="button" onClick={() => { props.onClose() }} aria-label="关闭">×</button></header>
      <div className={css.editorGrid}>
        <aside className={css.avatarEditor}>
          <span className={css.editorAvatar}>{draft.avatar ? <img src={draft.avatar} alt="" /> : '伙'}</span>
          <label className={css.uploadButton}>上传并更换头像<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void upload(event) }} /></label>
          <small>PNG、JPEG 或 WebP，不超过 5 MB</small>
        </aside>
        <div className={css.editorFields}>
          <div className={css.twoFields}>
            <label>名称<input value={draft.name} onChange={(event) => { set('name', event.currentTarget.value) }} /></label>
            <label>身份标题<input value={draft.handle} onChange={(event) => { set('handle', event.currentTarget.value) }} /></label>
          </div>
          <label>在线状态<input value={draft.status} onChange={(event) => { set('status', event.currentTarget.value) }} /></label>
          <label>伙伴资料<textarea rows={3} value={draft.description} onChange={(event) => { set('description', event.currentTarget.value) }} /></label>
          <label>核心身份提示词<textarea rows={5} value={draft.persona} onChange={(event) => { set('persona', event.currentTarget.value) }} /></label>
          <label>人设与性格<textarea rows={4} value={draft.style} onChange={(event) => { set('style', event.currentTarget.value) }} /></label>
          <label>说话语气<textarea rows={4} value={draft.speakingStyle} onChange={(event) => { set('speakingStyle', event.currentTarget.value) }} /></label>
          <label>行为逻辑<textarea rows={5} value={draft.behaviorLogic} onChange={(event) => { set('behaviorLogic', event.currentTarget.value) }} /></label>
        </div>
      </div>
      {error && <p className={css.editorError} role="alert">{error}</p>}
      <footer><button type="button" className={css.cancel} onClick={() => { props.onClose() }}>取消</button>
        <button type="button" className={css.save} disabled={busy} onClick={() => { void save() }}>{busy ? '保存中…' : '保存伙伴'}</button></footer>
    </section>
  </div>
}

export function VirtualCompanionPage(props: VirtualCompanionPageProps) {
  const { useWorkspaces, t } = props
  const directory = useCompanionStore()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const hasWorkspace = useWorkspaces(state => state.items.length > 0)
  useEffect(() => { void companionStore.load() }, [])
  useEffect(() => {
    if (selectedId === undefined || !directory.companions.some(item => item.id === selectedId)) {
      setSelectedId(directory.companions[0]?.id)
    }
  }, [directory.companions, selectedId])
  const visible = useMemo(() => {
    const key = query.trim().toLocaleLowerCase('zh-CN')
    return directory.companions.filter(companion => key === ''
      || `${companion.name} ${companion.handle}`.toLocaleLowerCase('zh-CN').includes(key))
  }, [directory.companions, query])
  const selected = directory.companions.find(companion => companion.id === selectedId)
  const editingCompanion = editing === undefined || editing === 'new'
    ? undefined
    : directory.companions.find(item => item.id === editing)
  const start = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true); setError(undefined)
    try { await props.launch(selected.id) } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (selected === undefined || selected.builtIn) return
    setBusy(true)
    try {
      await companionStore.remove(selected.id)
      setConfirmDelete(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  const restore = async (): Promise<void> => {
    if (selected === undefined || !selected.builtIn) return
    setBusy(true); setError(undefined)
    try {
      await companionStore.restore(selected.id)
      setConfirmRestore(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <main className={css.page} aria-label={t('title')}>
    <aside className={css.friends}>
      <header><div><h1>{t('title')}</h1><p>{t('intro')}</p></div>
        <button type="button" className={css.addFriend} onClick={() => { setEditing('new') }} aria-label="新增伙伴">+</button></header>
      <label className={css.search}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.75" /><path d="m15 15 4.25 4.25" /></svg>
        <input value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} placeholder={t('search')} />
      </label>
      <h2>我的伙伴 <span>{directory.companions.length}</span></h2>
      <div className={css.friendList}>{visible.map(companion => <button type="button" className={css.friend} aria-current={companion.id === selectedId} key={companion.id} onClick={() => { setSelectedId(companion.id) }}>
        <span className={css.avatar}><img src={companion.avatar} alt="" /><i /></span>
        <span><strong>{companion.name}</strong><small>{companion.status}</small></span>
      </button>)}</div>
      {directory.phase === 'loading' ? <p className={css.noMatch}>正在读取伙伴…</p> : null}
      {directory.phase === 'error' ? <p className={css.error}>{directory.error}</p> : null}
    </aside>

    {selected ? <section className={css.profile}>
      <div className={css.ambient} aria-hidden="true" />
      <div className={css.hero}>
        <div className={css.portrait}><img src={selected.portrait || selected.avatar} alt={selected.name} /></div>
        <div className={css.identity}>
          <div className={css.badges}>{selected.builtIn ? <span>{t('builtIn')}</span> : <span>自定义</span>}<span>{t('online')}</span></div>
          <p className={css.eyebrow}>{selected.handle}</p><h2>{selected.name}</h2><p className={css.status}>“{selected.status}”</p>
          <div className={css.profileActions}>
            <button type="button" className={css.launch} disabled={busy || !hasWorkspace} onClick={() => { void start() }}>{busy ? t('launching') : `和${selected.name}聊天`}</button>
            <button type="button" className={css.secondary} onClick={() => { setEditing(selected.id) }}>编辑资料</button>
            {selected.builtIn
              ? <button type="button" className={css.secondary} onClick={() => { setConfirmRestore(true) }}>恢复原版</button>
              : <button type="button" className={css.danger} onClick={() => { setConfirmDelete(true) }}>删除</button>}
          </div>
          {!hasWorkspace ? <p className={css.hint}>{t('noWorkspace')}</p> : null}
          {error !== undefined ? <p className={css.error} role="alert">{error}</p> : null}
        </div>
      </div>
      <div className={css.details}>
        <article><h3>伙伴资料</h3><p>{selected.description}</p></article>
        <article><h3>完整 Agent 人设提示词</h3><p>以下四部分只注入这位伙伴自己的独立 Agent，并与用户公开资料、当前房间记录共同构成她的上下文。</p></article>
        <div className={css.promptGrid}>
          <PromptCard title="01 · 核心身份" value={selected.persona} />
          <PromptCard title="02 · 人设与性格" value={selected.style} />
          <PromptCard title="03 · 说话语气" value={selected.speakingStyle} />
          <PromptCard title="04 · 行为逻辑" value={selected.behaviorLogic} />
        </div>
        <p className={css.privacy}>伙伴会读取公共知识库与自己的私有知识库；不会读取其他伙伴的私有知识。知识与引用资料统一在左侧“知识库”中维护，密码或凭据永不注入。</p>
      </div>
    </section> : <section className={css.emptyProfile}>新增一位伙伴，开始你们的聊天。</section>}
    {editing !== undefined ? <CompanionEditor
      {...editingCompanion === undefined ? {} : { companion: editingCompanion }}
      onClose={() => { setEditing(undefined) }}
    /> : null}
    {confirmDelete && selected !== undefined && !selected.builtIn ? <ConfirmDialog
      title="删除伙伴"
      description={`确定删除伙伴“${selected.name}”吗？她的私有记忆、知识和自定义表情也会一并移除。`}
      confirmLabel="确认删除"
      tone="danger"
      busy={busy}
      onCancel={() => { setConfirmDelete(false) }}
      onConfirm={() => { void remove() }}
    /> : null}
    {confirmRestore && selected !== undefined && selected.builtIn ? <ConfirmDialog
      title="恢复内置伙伴原版"
      description={`将“${selected.name}”的人物资料、私有知识库和私有引用库全部恢复为当前版本的内置原版。用户编辑的设定、自定义知识和自定义引用会被移除，此操作不会使用阻塞弹窗。`}
      confirmLabel="恢复原版"
      tone="restore"
      busy={busy}
      onCancel={() => { setConfirmRestore(false) }}
      onConfirm={() => { void restore() }}
    /> : null}
  </main>
}
