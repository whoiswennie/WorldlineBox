import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import type {
  PluginInventoryListRequest,
  PluginInventoryMutationRequest,
  PluginInventorySnapshot,
  SkillInventoryMutationRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button,
  IconCordisPluginOutline14,
  IconFolderOpenOutline16,
  IconSearchOutline16,
  IconSkillOutline16,
  IconWarningOutline16,
  Modal,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './FunctionalityPage.module.css'
import type {} from './locales.ts'

export interface FunctionalityPageInjected {
  list(request: PluginInventoryListRequest): Promise<PluginInventorySnapshot>
  setPluginEnabled(request: PluginInventoryMutationRequest): Promise<PluginInventorySnapshot>
  deletePlugin(request: PluginInventoryMutationRequest): Promise<PluginInventorySnapshot>
  setSkillEnabled(request: SkillInventoryMutationRequest): Promise<PluginInventorySnapshot>
  deleteSkill(request: SkillInventoryMutationRequest): Promise<PluginInventorySnapshot>
  openDirectory(path: string): Promise<void>
  subscribe(listener: () => void): () => void
}

export type FunctionalityPageProps = PropsRuntime<'worldline.main.page'>
  & PropsLocale<'pluginCenter'>
  & InjectFace<FunctionalityPageInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message?: string }
  | { status: 'ready'; snapshot: PluginInventorySnapshot }
type Tab = 'plugins' | 'skills'
type PendingDelete =
  | { kind: 'plugin'; entryId: PluginInventoryMutationRequest['entryId'] }
  | { kind: 'skill'; name: SkillInventoryMutationRequest['name'] }

interface Ranked<T> {
  item: T
  score: number
}

function shortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@')
    ? moduleName.slice(moduleName.indexOf('/') + 1)
    : moduleName
  return unscoped
    .replace(/^cordis:/u, '')
    .replace(/^cordis-plugin-/u, '')
    .replace(/^(?:dsh|worldline)-(?:host-|client-)?/u, '')
}

function phase(
  value: PluginInventorySnapshot['entries'][number]['fiberPhase'],
  t: FunctionalityPageProps['t'],
): string {
  if (value === 'active') return t('running')
  if (value === 'pending' || value === 'loading' || value === 'unloading') return t('pending')
  if (value === 'failed') return t('failed')
  return t('inactive')
}

function normalize(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[\u0300-\u036f]/gu, '')
}

function subsequenceScore(needle: string, haystack: string): number | undefined {
  let cursor = 0
  let first = -1
  let last = -1
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor)
    if (index < 0) return undefined
    if (first < 0) first = index
    last = index
    cursor = index + 1
  }
  const span = last - first + 1
  // Typo-tolerant matching is useful for compact omissions such as `cmnt`
  // → `community`, but widely scattered letters turn every long module name
  // into a false positive. Require at least 40% character density.
  if (needle.length / span < 0.4) return undefined
  return 60 + (span - needle.length) * 4 + Math.min(haystack.length - needle.length, 24)
}

/** Rank a local inventory row without waiting for a Host request or a submit action. */
export function fuzzyScore(query: string, fields: readonly string[]): number | undefined {
  const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return 0
  let score = 0
  const normalizedFields = fields.map(normalize)
  for (const token of tokens) {
    let tokenScore: number | undefined
    for (const field of normalizedFields) {
      let candidate: number | undefined
      if (field === token) candidate = 0
      else if (field.startsWith(token)) candidate = 10 + field.length - token.length
      else {
        const substring = field.indexOf(token)
        candidate = substring >= 0
          ? 30 + substring + field.length - token.length
          : subsequenceScore(token, field)
      }
      if (candidate !== undefined && (tokenScore === undefined || candidate < tokenScore)) {
        tokenScore = candidate
      }
    }
    if (tokenScore === undefined) return undefined
    score += tokenScore
  }
  return score
}

function rank<T>(items: readonly T[], query: string, fields: (item: T) => readonly string[]): T[] {
  return items
    .map((item): Ranked<T> | undefined => {
      const score = fuzzyScore(query, fields(item))
      return score === undefined ? undefined : { item, score }
    })
    .filter((entry): entry is Ranked<T> => entry !== undefined)
    .sort((left, right) => left.score - right.score)
    .map(entry => entry.item)
}

function sourceLabel(source: string, t: FunctionalityPageProps['t']): string {
  if (source === 'project-worldline' || source === 'project-agents') return t('sourceProject')
  if (source === 'user-worldline' || source === 'user-agents') return t('sourceUser')
  if (source === 'bundled') return t('sourceBundled')
  if (source === 'runtime') return t('sourceRuntime')
  if (source === 'custom') return t('sourceCustom')
  return source
}

function forWorkspace(cwd: string | undefined): PluginInventoryListRequest {
  return cwd === undefined ? {} : { cwd }
}

export function FunctionalityPage(props: FunctionalityPageProps): ReactNode {
  const [tab, setTab] = useState<Tab>('plugins')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string>()
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>()
  const [notice, setNotice] = useState<{ seq: number; text: string }>()
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const requestGeneration = useRef(0)
  const noticeSequence = useRef(0)
  const currentCwd = props.useWorkspaces(snapshot => snapshot.items
    .find(workspace => workspace.workspaceId === snapshot.recentWorkspaceId)?.path)

  const load = useCallback(async (initial = false): Promise<void> => {
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    if (initial) setState({ status: 'loading' })
    try {
      const snapshot = await props.list(forWorkspace(currentCwd))
      if (requestGeneration.current === generation) setState({ status: 'ready', snapshot })
    } catch (error) {
      if (requestGeneration.current !== generation) return
      setState(current => current.status === 'ready'
        ? current
        : { status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [currentCwd, props])

  useEffect(() => {
    void load(true)
    const refresh = (): void => { void load() }
    const dispose = props.subscribe(refresh)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 10_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      requestGeneration.current += 1
      dispose()
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load, props])

  const plugins = useMemo(() => state.status !== 'ready' ? [] : rank(
    state.snapshot.entries,
    query,
    entry => [shortName(entry.moduleName), entry.moduleName],
  ), [query, state])
  const skills = useMemo(() => state.status !== 'ready' ? [] : rank(
    state.snapshot.skills,
    query,
    skill => [skill.name, skill.description, skill.source, skill.provider],
  ), [query, state])

  const mutate = async (
    key: string,
    action: () => Promise<PluginInventorySnapshot>,
  ): Promise<void> => {
    setBusy(key)
    try {
      setState({ status: 'ready', snapshot: await action() })
    } catch (error) {
      noticeSequence.current += 1
      setNotice({
        seq: noticeSequence.current,
        text: `${props.t('mutationError')} ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setBusy(undefined)
    }
  }

  const confirmDelete = (): void => {
    const target = pendingDelete
    if (target === undefined) return
    setPendingDelete(undefined)
    if (target.kind === 'plugin') {
      void mutate(`plugin:${target.entryId}`, () => props.deletePlugin({
        entryId: target.entryId,
        ...forWorkspace(currentCwd),
      }))
      return
    }
    void mutate(`skill:${target.name}`, () => props.deleteSkill({
      name: target.name,
      ...forWorkspace(currentCwd),
    }))
  }

  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const enabledPlugins = snapshot?.entries.filter(entry => entry.enabled).length ?? 0
  const enabledSkills = snapshot?.skills.filter(skill => skill.enabled).length ?? 0
  const visibleCount = tab === 'plugins' ? plugins.length : skills.length
  const totalCount = tab === 'plugins'
    ? snapshot?.entries.length ?? 0
    : snapshot?.skills.length ?? 0

  return <><main className={css.page} aria-label={props.t('title')}>
    <div className={css.shell}>
      <header className={css.header}>
        <div className={css.heroCopy}>
          <span className={css.kicker}>WORLDLINE CAPABILITY DECK</span>
          <div className={css.titleLine}>
            <h1>{props.t('title')}</h1>
            <span className={css.localBadge}>{props.t('localOnly')}</span>
          </div>
          <p>{props.t('intro')}</p>
          <div className={css.liveStatus} aria-label={props.t('liveUpdates')}>
            <span aria-hidden="true" />{props.t('liveUpdates')}
          </div>
        </div>
        <div className={css.heroEmblem} aria-hidden="true">
          <span>✦</span>
          <strong>{enabledPlugins + enabledSkills}</strong>
          <small>ACTIVE</small>
        </div>
      </header>

      <section className={css.summary} aria-label={props.t('summary')}>
        <div data-tone="sky"><i aria-hidden="true">◇</i><strong>{snapshot?.entries.length ?? '—'}</strong><span>{props.t('pluginCount')}</span></div>
        <div data-tone="mint"><i aria-hidden="true">✦</i><strong>{enabledPlugins}</strong><span>{props.t('enabledPlugins')}</span></div>
        <div data-tone="violet"><i aria-hidden="true">⌘</i><strong>{snapshot?.skills.length ?? '—'}</strong><span>{props.t('skillCount')}</span></div>
        <div data-tone="rose"><i aria-hidden="true">♡</i><strong>{enabledSkills}</strong><span>{props.t('enabledSkills')}</span></div>
      </section>

      <div className={css.toolbar}>
        <div className={css.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plugins'}
            onClick={() => { setTab('plugins'); setQuery('') }}
          >
            <IconCordisPluginOutline14 />
            {props.t('plugins')}
            <span>{snapshot?.entries.length ?? 0}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'skills'}
            onClick={() => { setTab('skills'); setQuery('') }}
          >
            <IconSkillOutline16 />
            {props.t('skills')}
            <span>{snapshot?.skills.length ?? 0}</span>
          </button>
        </div>
        <label className={css.search}>
          <IconSearchOutline16 />
          <input
            type="search"
            value={query}
            placeholder={props.t(tab === 'plugins' ? 'searchPlugins' : 'searchSkills')}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
          {query !== '' ? <output className={css.resultCount} aria-live="polite">
            {visibleCount}/{totalCount}
          </output> : null}
          {query !== '' ? <button
            type="button"
            aria-label={props.t('clearSearch')}
            onClick={() => { setQuery('') }}
          >×</button> : null}
        </label>
      </div>

      {state.status === 'loading' ? <p className={css.status}>{props.t('loading')}</p> : null}
      {state.status === 'error' ? <div className={css.failure} role="alert">
        <p>{props.t('error')}</p>
        <code>{state.message}</code>
        <button type="button" onClick={() => { void load(true) }}>{props.t('retry')}</button>
      </div> : null}

      {snapshot !== undefined ? <div className={css.deckHeading}>
        <div>
          <span>{tab === 'plugins' ? 'PLUGIN COLLECTION' : 'SKILL COLLECTION'}</span>
          <h2>{props.t(tab === 'plugins' ? 'plugins' : 'skills')}</h2>
        </div>
        <small>{visibleCount} / {totalCount}</small>
      </div> : null}

      {snapshot !== undefined && tab === 'plugins' ? <section
        className={css.grid}
        data-feature-list="plugins"
      >
        {snapshot.entries.length === 0
          ? <p className={css.status}>{props.t('emptyPlugins')}</p>
          : null}
        {snapshot.entries.length > 0 && plugins.length === 0
          ? <p className={css.status}>{props.t('noMatch')}</p>
          : null}
        {plugins.map((entry) => {
          const key = `plugin:${entry.entryId}`
          const displayName = shortName(entry.moduleName)
          return <article className={css.card} key={entry.entryId}>
            <div className={css.cardTop}>
              <div className={css.mark} aria-hidden="true">
                {displayName.slice(0, 1).toLocaleUpperCase()}
              </div>
              <div className={css.identity}>
                <strong>{displayName}</strong>
                <code>{entry.entryId}</code>
              </div>
              <div className={css.stateBadges}>
                <span data-enabled={entry.enabled}>
                  {entry.enabled ? props.t('enabled') : props.t('disabled')}
                </span>
                <span>{phase(entry.fiberPhase, props.t)}</span>
              </div>
            </div>
            <p className={css.moduleName} title={entry.moduleName}>{entry.moduleName}</p>
            <footer className={css.cardFooter}>
              {entry.protected
                ? <span className={css.protected} title={props.t('protectedHint')}>
                  {props.t('protected')}
                </span>
                : <div className={css.actions}>
                  <button
                    type="button"
                    disabled={busy !== undefined}
                    onClick={() => { void mutate(key, () => props.setPluginEnabled({
                      entryId: entry.entryId,
                      enabled: !entry.enabled,
                      ...forWorkspace(currentCwd),
                    })) }}
                  >
                    {busy === key ? props.t('updating') : props.t(entry.enabled ? 'disable' : 'enable')}
                  </button>
                  <button
                    type="button"
                    className={css.danger}
                    disabled={busy !== undefined}
                    onClick={() => { setPendingDelete({ kind: 'plugin', entryId: entry.entryId }) }}
                  >{props.t('delete')}</button>
                </div>}
            </footer>
          </article>
        })}
      </section> : null}

      {snapshot !== undefined && tab === 'skills' ? <section
        className={css.grid}
        data-feature-list="skills"
      >
        {snapshot.skills.length === 0 ? <div className={css.emptyState}>
          <IconSkillOutline16 />
          <strong>{props.t('emptySkills')}</strong>
          <span>{currentCwd === undefined ? props.t('emptySkillsNoWorkspace') : currentCwd}</span>
        </div> : null}
        {snapshot.skills.length > 0 && skills.length === 0
          ? <p className={css.status}>{props.t('noMatch')}</p>
          : null}
        {skills.map((skill) => {
          const key = `skill:${skill.name}`
          const directory = skill.directory
          return <article className={css.card} key={`${skill.provider}:${skill.name}`}>
            <div className={css.cardTop}>
              <div className={`${css.mark} ${css.skillMark}`} aria-hidden="true">
                <IconSkillOutline16 />
              </div>
              <div className={css.identity}>
                <strong>/{skill.name}</strong>
                <span>{sourceLabel(skill.source, props.t)}</span>
              </div>
              <div className={css.stateBadges}>
                <span data-enabled={skill.enabled}>
                  {skill.enabled ? props.t('enabled') : props.t('disabled')}
                </span>
              </div>
            </div>
            <p className={css.description}>{skill.description}</p>
            <div className={css.tags}>
              <span>{props.t('provider')} · {skill.provider}</span>
              {skill.modelInvocable ? <span>{props.t('modelInvocable')}</span> : null}
              {skill.userInvocable ? <span>{props.t('userInvocable')}</span> : null}
            </div>
            <footer className={css.cardFooter}>
              <div className={css.actions}>
                {directory !== undefined ? <button
                  type="button"
                  disabled={busy !== undefined}
                  title={directory}
                  onClick={() => { void props.openDirectory(directory) }}
                >
                  <IconFolderOpenOutline16 />{props.t('openDirectory')}
                </button> : null}
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => { void mutate(key, () => props.setSkillEnabled({
                    name: skill.name,
                    enabled: !skill.enabled,
                    ...forWorkspace(currentCwd),
                  })) }}
                >
                  {busy === key ? props.t('updating') : props.t(skill.enabled ? 'disable' : 'enable')}
                </button>
                {skill.canDelete ? <button
                  type="button"
                  className={css.danger}
                  disabled={busy !== undefined}
                  onClick={() => { setPendingDelete({ kind: 'skill', name: skill.name }) }}
                >{props.t('delete')}</button> : null}
              </div>
              {!skill.canDelete
                ? <span className={css.protected} title={props.t('protectedHint')}>
                  {props.t('protected')}
                </span>
                : null}
            </footer>
          </article>
        })}
      </section> : null}
    </div>
  </main>
  <Modal
    open={pendingDelete !== undefined}
    onClose={() => { setPendingDelete(undefined) }}
    title={props.t('deleteConfirmTitle')}
    description={pendingDelete?.kind === 'skill'
      ? props.t('skillDeleteConfirm')
      : props.t('pluginDeleteConfirm')}
    footer={<><Button variant="outline" onClick={() => { setPendingDelete(undefined) }}>{props.t('cancel')}</Button><Button variant="primary" onClick={confirmDelete}>{props.t('confirmDelete')}</Button></>}
  />
  {notice !== undefined ? <Toast
    key={notice.seq}
    text={notice.text}
    icon={<IconWarningOutline16 />}
    onDone={() => { setNotice(undefined) }}
  /> : null}
  </>
}
