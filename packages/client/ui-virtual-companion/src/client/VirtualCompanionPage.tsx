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
  const [self, setSelf] = useState<SelfSnapshotView>()
  const [policy, setPolicy] = useState<VaultPolicyView>()
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
  useEffect(() => {
    if (selectedId === undefined) { setSelf(undefined); setPolicy(undefined); return }
    let active = true
    void Promise.all([
      vaultPost<SelfSnapshotView>('vault/self', { scope: selectedId }),
      vaultPost<VaultPolicyView>('vault/policy', { scope: selectedId }),
    ]).then(([nextSelf, nextPolicy]) => { if (active) { setSelf(nextSelf); setPolicy(nextPolicy) } },
      (reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [selectedId])
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
      <header><div><h1>{t('title')}</h1><p>{t('intro')}</p></div>
        <label className={css.addFriend} aria-label="导入角色包" title="导入角色包">⇧<input type="file" accept=".wlvault" hidden onChange={(event) => { void importCompanion(event) }} /></label>
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
            <a className={css.secondary} href={`/api/virtual-companions/vault/export/${encodeURIComponent(selected.id)}`}>导出角色包</a>
            <button type="button" className={css.secondary} aria-pressed={policy?.fullyFrozen === true}
              onClick={() => { void toggleFreeze() }}>{policy?.fullyFrozen === true ? '解除知识冻结' : '冻结为只读'}</button>
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
        <article><h3>Agent Vault 印象卡</h3><p>只注入已启用的结构化模块；普通记忆检索与印象卡严格分域。稳定模块按阶段更新，动态状态也保留修订记录。</p></article>
        <div className={css.promptGrid}>
          {(self?.modules ?? []).map((item, index) => <section className={css.promptCard} key={item.id}>
            <h4>{String(index + 1).padStart(2, '0')} · {item.title}</h4>
            <p>{item.summary || '尚未形成稳定印象。'}</p>
            {item.details.length > 0 ? <p>{item.details.join('\n')}</p> : null}
            <button type="button" className={css.secondary} aria-pressed={item.enabled}
              onClick={() => { void toggleSelf(item) }}>{item.enabled ? '已启用 · 点击停用' : '已停用 · 点击启用'}</button>
          </section>)}
        </div>
        <p className={css.privacy}>伙伴只读取公共 Vault 与自己的私有 Vault；不会读取其他伙伴的私有认知。记忆、能力、资源和印象卡统一打包迁移，冻结后 Agent 的所有写入均会被 Host 拒绝。</p>
      </div>
    </section> : <section className={css.emptyProfile}>新增一位伙伴，开始你们的聊天。</section>}
    {editing !== undefined ? <CompanionEditor
      {...editingCompanion === undefined ? {} : { companion: editingCompanion }}
      onClose={() => { setEditing(undefined) }}
    /> : null}
    {confirmDelete && selected !== undefined && !selected.builtIn ? <ConfirmDialog
      title="删除伙伴"
      description={`确定删除伙伴“${selected.name}”吗？她的完整 Agent Vault 会移入可恢复的回收区。`}
      confirmLabel="确认删除"
      tone="danger"
      busy={busy}
      onCancel={() => { setConfirmDelete(false) }}
      onConfirm={() => { void remove() }}
    /> : null}
    {confirmRestore && selected !== undefined && selected.builtIn ? <ConfirmDialog
      title="恢复内置伙伴原版"
      description={`将“${selected.name}”的人物资料和私有 Agent Vault 全部恢复为当前版本的内置原版。现有版本会先移入可恢复的回收区，此操作不会使用阻塞弹窗。`}
      confirmLabel="恢复原版"
      tone="restore"
      busy={busy}
      onCancel={() => { setConfirmRestore(false) }}
      onConfirm={() => { void restore() }}
    /> : null}
  </main>
}
