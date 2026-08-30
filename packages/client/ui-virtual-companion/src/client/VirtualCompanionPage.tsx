import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  VirtualCompanion,
  VirtualCompanionDraft,
} from '../contracts.ts'
import {
  DEFAULT_COMPANION_ART,
  DEFAULT_COMPANION_ART_DARK,
  randomDefaultCompanionArt,
} from '../contracts.ts'
import { companionStore, useCompanionStore } from './store.ts'
import css from './VirtualCompanionPage.module.css'

export interface VirtualCompanionPageInjected {
  launch(companionId: string): Promise<void>
  openKnowledgeDocument(companionId: string, path: string): void
}

interface SelfModuleView {
  id: string
  title: string
  enabled: boolean
  autonomous: boolean
  locked: boolean
  stability: 'core' | 'stable' | 'dynamic'
  summary: string
  details: readonly string[]
  updatedAt: number
  revision: string
}
interface SelfSnapshotView {
  agentId: string
  modules: readonly SelfModuleView[]
  compiled: string
  revision: string
}
interface VaultPolicyView {
  aiWriteMode: 'autonomous' | 'proposal' | 'readonly'
  domains: Record<'self' | 'memory' | 'procedure' | 'resource', 'autonomous' | 'proposal' | 'readonly'>
  userEditable: boolean
  fullyFrozen: boolean
}

async function vaultPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/virtual-companions/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const envelope = await response.json().catch(() => ({})) as { ok?: boolean; value?: T; error?: string }
  if (!response.ok || envelope.ok !== true || envelope.value === undefined) {
    throw new Error(envelope.error ?? `Agent Vault 请求失败（${String(response.status)}）`)
  }
  return envelope.value
}

export type VirtualCompanionPageProps = PropsRuntime<'worldline.main.page'>
  & PropsLocale<'virtualCompanion'>
  & InjectFace<VirtualCompanionPageInjected>

function emptyDraft(): VirtualCompanionDraft {
  const artwork = randomDefaultCompanionArt()
  return {
    name: '', handle: '', avatar: artwork, portrait: artwork, status: '', description: '',
    persona: '', style: '', speakingStyle: '', behaviorLogic: '',
  }
}

const DEFAULT_ARTWORK_OPTIONS = [
  { label: '白色形态', value: DEFAULT_COMPANION_ART },
  { label: '黑色形态', value: DEFAULT_COMPANION_ART_DARK },
] as const

const SELF_MODULE_META: Readonly<Record<string, {
  symbol: string
  kicker: string
  tone: 'rose' | 'sky' | 'violet' | 'mint' | 'amber'
}>> = {
  identity: { symbol: '✦', kicker: 'WHO I AM', tone: 'rose' },
  appearance: { symbol: '◇', kicker: 'APPEARANCE', tone: 'sky' },
  persona: { symbol: '♡', kicker: 'PERSONALITY', tone: 'violet' },
  voice: { symbol: '♪', kicker: 'VOICE', tone: 'rose' },
  worldview: { symbol: '◎', kicker: 'WORLDVIEW', tone: 'sky' },
  interests: { symbol: '☆', kicker: 'INTERESTS', tone: 'amber' },
  emotion: { symbol: '◌', kicker: 'MOOD', tone: 'rose' },
  state: { symbol: '◈', kicker: 'NOW', tone: 'mint' },
  relationships: { symbol: '∞', kicker: 'BONDS', tone: 'violet' },
  'common-memory': { symbol: '⌁', kicker: 'FAMILIAR', tone: 'sky' },
  capabilities: { symbol: '△', kicker: 'BOUNDARIES', tone: 'amber' },
}

const STABILITY_LABEL = {
  core: '核心设定',
  stable: '阶段印象',
  dynamic: '近期状态',
} as const

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

function PortraitPreview(props: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close) }
  }, [props])
  return <div className={css.imagePreviewBackdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose()
  }}>
    <section className={css.imagePreview} role="dialog" aria-modal="true" aria-label={`${props.name}形象大图`}>
      <button type="button" className={css.imagePreviewClose} onClick={() => { props.onClose() }} aria-label="关闭大图预览">×</button>
      <img src={props.src} alt={`${props.name}的完整形象`} />
      <footer><span>CHARACTER PORTRAIT</span><strong>{props.name}</strong><small>按 Esc 或点击背景关闭</small></footer>
    </section>
  </div>
}

function ExportPackageOutline() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.45"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5zM3.8 6.7 10 10l6.2-3.3M10 10v7" />
    <path d="M12.5 4.35v3.1m0 0 1.35-1.35m-1.35 1.35-1.35-1.35" />
  </svg>
}

function FreezeOutline() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35"
    strokeLinecap="round" aria-hidden="true">
    <path d="M10 2.8v14.4M3.8 6.4l12.4 7.2M3.8 13.6l12.4-7.2" />
    <path d="m7.8 4.05 2.2 1.3 2.2-1.3M7.8 15.95l2.2-1.3 2.2 1.3M4.95 8.55l2.15-1.3-.05-2.5M15.05 11.45l-2.15 1.3.05 2.5M4.95 11.45l2.15 1.3-.05 2.5M15.05 8.55l-2.15-1.3.05-2.5" />
  </svg>
}

function RestoreOutline() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.2 6.7A6.5 6.5 0 1 1 3.8 12M4.2 6.7V3.5m0 3.2h3.2" />
    <path d="M10 6.5V10l2.4 1.45" />
  </svg>
}

function CompanionEditor(props: { companion?: VirtualCompanion; onClose(): void }) {
  const companion = props.companion
  const [draft, setDraft] = useState<VirtualCompanionDraft>(() => companion ? toDraft(companion) : emptyDraft())
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
          {companion === undefined ? <div className={css.defaultArtwork} aria-label="默认形象">
            {DEFAULT_ARTWORK_OPTIONS.map(option => <button type="button" key={option.value}
              aria-pressed={draft.avatar === option.value && draft.portrait === option.value}
              onClick={() => { setDraft(current => ({ ...current, avatar: option.value, portrait: option.value })) }}>
              <img src={option.value} alt="" /><span>{option.label}</span>
            </button>)}
          </div> : null}
          <label className={css.uploadButton}>上传并更换头像<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void upload(event) }} /></label>
          <small>{companion === undefined
            ? '可以手动选择形态；未指定时会随机采用白色或黑色形态，并在创建后固定。'
            : '上传新图片即可替换当前形象；已设定的形象不会显示默认候选。'}</small>
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
  const [previewPortrait, setPreviewPortrait] = useState(false)
  const actionMenuRef = useRef<HTMLDetailsElement>(null)
  const [self, setSelf] = useState<SelfSnapshotView>()
  const [policy, setPolicy] = useState<VaultPolicyView>()
  const hasWorkspace = useWorkspaces(state => state.items.length > 0)
  const closeActionMenu = (): void => {
    if (actionMenuRef.current !== null) actionMenuRef.current.open = false
  }
  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      const menu = actionMenuRef.current
      if (menu?.open === true && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false
      }
    }
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeActionMenu()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [])
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
  useEffect(() => {
    if (selectedId === undefined) { setSelf(undefined); setPolicy(undefined); return }
    let active = true
    void Promise.all([
      vaultPost<SelfSnapshotView>('vault/self', { scope: selectedId }),
      vaultPost<VaultPolicyView>('vault/policy', { scope: selectedId }),
    ]).then(([nextSelf, nextPolicy]) => { if (active) { setSelf(nextSelf); setPolicy(nextPolicy) } },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [selectedId])
  useEffect(() => {
    if (selectedId === undefined || typeof EventSource === 'undefined') return
    const events = new EventSource(`/api/virtual-companions/vault/events/${encodeURIComponent(selectedId)}`)
    let active = true
    events.onmessage = () => {
      void Promise.all([
        vaultPost<SelfSnapshotView>('vault/self', { scope: selectedId }),
        vaultPost<VaultPolicyView>('vault/policy', { scope: selectedId }),
        companionStore.load(true),
      ]).then(([nextSelf, nextPolicy]) => {
        if (active) { setSelf(nextSelf); setPolicy(nextPolicy) }
      }, (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    }
    return () => { active = false; events.close() }
  }, [selectedId])
  const identityModule = self?.modules.find(item => item.id === 'identity')
  const stateModule = self?.modules.find(item => item.id === 'state')
  const appearanceModule = self?.modules.find(item => item.id === 'appearance')
  const identityMatch = /^(.+?)（(.+)）$/u.exec(identityModule?.summary.trim() ?? '')
  const displayName = identityMatch?.[1]?.trim() || selected?.name || ''
  const displayHandle = identityMatch?.[2]?.trim() || identityModule?.summary.trim() || selected?.handle || ''
  const displayDescription = identityModule?.details[0] ?? selected?.description ?? ''
  const displayStatus = stateModule?.summary ?? selected?.status ?? ''
  const displayAvatar = appearanceModule?.details.find(item => item.startsWith('形象资源：'))
    ?.slice('形象资源：'.length).trim() || selected?.avatar || ''
  const displayPortrait = appearanceModule?.details.find(item => item.startsWith('立绘资源：'))
    ?.slice('立绘资源：'.length).trim() || selected?.portrait || displayAvatar
  const toggleSelf = async (item: SelfModuleView): Promise<void> => {
    if (selected === undefined) return
    try {
      const updated = await vaultPost<SelfModuleView>('vault/self/update', { scope: selected.id,
        module: { ...item, enabled: !item.enabled }, reason: '用户在伙伴印象卡中切换模块。' })
      setSelf(current => current === undefined ? current : { ...current,
        modules: current.modules.map(value => value.id === updated.id ? updated : value) })
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const toggleFreeze = async (): Promise<void> => {
    if (selected === undefined || policy === undefined) return
    try {
      setPolicy(await vaultPost<VaultPolicyView>('vault/policy/set', { scope: selected.id,
        policy: { ...policy, fullyFrozen: !policy.fullyFrozen } }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const importCompanion = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]; if (file === undefined) return
    setBusy(true); setError(undefined)
    try {
      const response = await fetch('/api/virtual-companions/vault/import', { method: 'POST', body: file })
      const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!response.ok || result.ok !== true) throw new Error(result.error ?? '角色包导入失败')
      await companionStore.load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false); event.currentTarget.value = '' }
  }
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
      <header>
        <div><span className={css.sidebarKicker}>COMPANION DECK</span><h1>{t('title')}</h1><p>{t('intro')}</p></div>
        <div className={css.companionActions}>
          <label className={css.importCompanion} aria-label="导入角色包" title="导入角色包">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 3.2v8.6m0-8.6L6.8 6.4M10 3.2l3.2 3.2M4 11.5v3.1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3.1" />
            </svg>
            <span><strong>导入角色</strong><small>.wlvault 角色包</small></span>
            <input type="file" accept=".wlvault" hidden onChange={(event) => { void importCompanion(event) }} />
          </label>
          <button type="button" className={css.newCompanion} onClick={() => { setEditing('new') }} aria-label="新增伙伴">
            <span aria-hidden="true">＋</span><strong>新建</strong>
          </button>
        </div>
      </header>
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
        <div className={css.portrait}>
          <span className={css.portraitHalo} aria-hidden="true" />
          <button type="button" className={css.portraitPreviewTrigger}
            onClick={() => { setPreviewPortrait(true) }} aria-label={`预览${displayName}的大图`}>
            <img src={displayPortrait} alt={displayName} />
            <span className={css.portraitCaption}><i />ONLINE · {displayHandle.split('·')[0]?.trim()}</span>
            <span className={css.previewHint}><b aria-hidden="true">⌗</b>查看完整形象</span>
          </button>
        </div>
        <div className={css.identity}>
          <div className={css.badges}>
            <span data-tone="identity">{selected.builtIn ? t('builtIn') : '自定义角色'}</span>
            <span data-tone="online"><i />{t('online')}</span>
            {policy?.fullyFrozen === true ? <span data-tone="frozen">只读保护</span> : null}
          </div>
          <p className={css.eyebrow}>{displayHandle}</p>
          <h2>{displayName}</h2>
          <p className={css.status}>“{displayStatus}”</p>
          <div className={css.profileActions}>
            <button type="button" className={css.launch} disabled={busy || !hasWorkspace} onClick={() => { void start() }}>
              <span aria-hidden="true">✦</span>{busy ? t('launching') : `和${displayName}聊天`}
            </button>
            <button type="button" className={css.editProfile} onClick={() => { setEditing(selected.id) }}>
              <span aria-hidden="true">✎</span>编辑资料
            </button>
            <details className={css.actionMenu} ref={actionMenuRef}>
              <summary aria-label="更多角色操作"><span aria-hidden="true">•••</span><b>更多</b></summary>
              <div>
                <a href={`/api/virtual-companions/vault/export/${encodeURIComponent(selected.id)}`}
                  onClick={closeActionMenu}>
                  <span aria-hidden="true"><ExportPackageOutline /></span><span><strong>导出角色包</strong><small>带走形象、记忆与资源</small></span>
                </a>
                <button type="button" aria-pressed={policy?.fullyFrozen === true} onClick={() => { closeActionMenu(); void toggleFreeze() }}>
                  <span aria-hidden="true"><FreezeOutline /></span><span><strong>{policy?.fullyFrozen === true ? '解除知识冻结' : '冻结为只读'}</strong><small>{policy?.fullyFrozen === true ? '恢复 Agent 自治写入' : '保护当前角色与知识'}</small></span>
                </button>
                {selected.builtIn
                  ? <button type="button" onClick={() => { closeActionMenu(); setConfirmRestore(true) }}><span aria-hidden="true"><RestoreOutline /></span><span><strong>恢复原版</strong><small>回到内置角色初始状态</small></span></button>
                  : <button type="button" data-danger onClick={() => { closeActionMenu(); setConfirmDelete(true) }}><span aria-hidden="true">×</span><span><strong>删除伙伴</strong><small>完整资料移入知识库回收站</small></span></button>}
              </div>
            </details>
          </div>
          {!hasWorkspace ? <p className={css.hint}>{t('noWorkspace')}</p> : null}
          {error !== undefined ? <p className={css.error} role="alert">{error}</p> : null}
        </div>
      </div>
      <div className={css.details}>
        <div className={css.overviewGrid}>
          <article className={css.introCard}>
            <span className={css.cardKicker}>PROFILE NOTE</span>
            <h3>关于 {displayName}</h3>
            <p>{displayDescription}</p>
            <footer><button type="button" className={css.cardDocumentLink}
              onClick={() => { props.openKnowledgeDocument(selected.id, 'self/identity.md') }}>
              <span>编辑身份 MD</span><b aria-hidden="true">↗</b>
            </button><i aria-hidden="true">♡</i></footer>
          </article>
          <article className={css.cognitionCard}>
            <span className={css.cardKicker}>COGNITIVE PULSE</span>
            <h3>此刻的她</h3>
            <div className={css.cognitionStats}>
              <span><strong>{self?.modules.filter(item => item.enabled).length ?? 0}</strong><small>启用印象</small></span>
              <span><strong>{self?.modules.filter(item => item.stability === 'dynamic').length ?? 0}</strong><small>近期状态</small></span>
              <span><strong>{policy?.fullyFrozen === true ? '只读' : '成长中'}</strong><small>记忆状态</small></span>
            </div>
            <p>印象卡只负责她是谁、现在怎样；知识与普通记忆仍由专门的召回工具按需寻找。</p>
          </article>
        </div>
        <header className={css.impressionHeader}>
          <div><span>IMPRESSION DECK</span><h3>角色印象</h3><p>这些片段共同塑造她在每次相遇中的语气、心境与边界。</p></div>
          <span className={css.impressionCount}>{self?.modules.length ?? 0} 张印象卡</span>
        </header>
        <div className={css.promptGrid}>
          {(self?.modules ?? []).map((item) => {
            const meta = SELF_MODULE_META[item.id] ?? { symbol: '✦', kicker: 'IMPRESSION', tone: 'sky' as const }
            return <section className={css.promptCard} data-tone={meta.tone} data-enabled={item.enabled || undefined} key={item.id}>
              <header>
                <span className={css.moduleIcon} aria-hidden="true">{meta.symbol}</span>
                <span className={css.moduleTitle}><small>{meta.kicker}</small><h4>{item.title}</h4></span>
                <button
                  type="button"
                  className={css.moduleSwitch}
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={`${item.title}${item.enabled ? '已启用，点击停用' : '已停用，点击启用'}`}
                  onClick={() => { void toggleSelf(item) }}
                ><span /><b>{item.enabled ? '启用中' : '已停用'}</b></button>
              </header>
              <p className={css.moduleSummary}>{item.summary || '这部分印象还留着空白，等待未来慢慢形成。'}</p>
              {item.details.length > 0
                ? <ul>{item.details.slice(0, 4).map(detail => <li key={detail}>{detail}</li>)}</ul>
                : null}
              <footer>
                <span>{STABILITY_LABEL[item.stability]}</span>
                <span className={css.moduleGovernance}>{item.locked
                  ? '用户锁定'
                  : item.autonomous ? '可阶段成长' : '需明确确认'}</span>
                <button type="button" className={css.cardDocumentLink}
                  onClick={() => { props.openKnowledgeDocument(selected.id, `self/${item.id}.md`) }}>
                  编辑 {item.id}.md <b aria-hidden="true">↗</b>
                </button>
              </footer>
            </section>
          })}
        </div>
        <p className={css.privacy}>
          <span aria-hidden="true">◇</span>
          <span><strong>属于她自己的记忆边界</strong>
            伙伴只读取公共 Vault 与自己的私有 Vault，不会触碰其他伙伴的私有认知。
            角色包会统一携带形象、记忆、能力、资源和印象卡。
          </span>
        </p>
      </div>
    </section> : <section className={css.emptyProfile}>新增一位伙伴，开始你们的聊天。</section>}
    {previewPortrait && selected !== undefined ? <PortraitPreview
      src={displayPortrait} name={displayName} onClose={() => { setPreviewPortrait(false) }} /> : null}
    {editing !== undefined ? <CompanionEditor
      {...editingCompanion === undefined ? {} : { companion: editingCompanion }}
      onClose={() => { setEditing(undefined) }}
    /> : null}
    {confirmDelete && selected !== undefined && !selected.builtIn ? <ConfirmDialog
      title="删除伙伴"
      description={`确定删除伙伴“${selected.name}”吗？她的完整 Agent Vault 会移入“知识库 > 回收站”，之后仍可恢复。`}
      confirmLabel="确认删除"
      tone="danger"
      busy={busy}
      onCancel={() => { setConfirmDelete(false) }}
      onConfirm={() => { void remove() }}
    /> : null}
    {confirmRestore && selected !== undefined && selected.builtIn ? <ConfirmDialog
      title="恢复内置伙伴原版"
      description={`将“${selected.name}”的人物资料和私有 Agent Vault 全部恢复为当前版本的内置原版。现有版本会先移入“知识库 > 回收站”，此操作不会使用阻塞弹窗。`}
      confirmLabel="恢复原版"
      tone="restore"
      busy={busy}
      onCancel={() => { setConfirmRestore(false) }}
      onConfirm={() => { void restore() }}
    /> : null}
  </main>
}
