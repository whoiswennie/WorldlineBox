/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import {
  conversationViewSelectionEvent, type ConversationViewSelection,
} from '../view-navigation.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

const DEFAULT_VIEW_ID = 'chat'

/** Resolve by id and keep stale persisted selections on the stable Chat fallback. */
function resolveActiveView(tabs: readonly ViewTab[], selectedId: string | null): ViewTab | undefined {
  const requestedId = selectedId ?? DEFAULT_VIEW_ID
  return tabs.find(view => view.id === requestedId)
    ?? tabs.find(view => view.id === DEFAULT_VIEW_ID)
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the session title and the always-available view tabs.
 */
export function ConversationSessionHeader({
  sessionId, useSession, useSessions, useStore, actions,
  renderSlot, views, open, toggleSidebar, toggleRightbar, t,
}: ConversationSessionHeaderProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  // The blank Hero does not need a duplicate session title row, but its view
  // tabs stay visible so auxiliary work surfaces can be opened before the
  // first prompt is sent.
  const hideTitle = blank && composerPhase === 'blank' && active?.id === DEFAULT_VIEW_ID

  useEffect(() => {
    const selectView = (event: Event) => {
      const detail = (event as CustomEvent<ConversationViewSelection>).detail
      if (detail.sessionId === sessionId) actions.setView(detail.viewId)
    }
    window.addEventListener(conversationViewSelectionEvent, selectView)
    return () => { window.removeEventListener(conversationViewSelectionEvent, selectView) }
  }, [actions, sessionId])

  return (
    <header className={css.header}>
      {!hideTitle && (
        <div className={css.titleRow}>
          <div className={css.titleCluster}>
            <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
              {ancestry.map((summary, index) => {
                const last = index === ancestry.length - 1
                const title = (
                  <button
                    type="button"
                    className={clsx(
                      css.crumb,
                      summary.subagent && css.crumbSubagent,
                      last && css.crumbCurrent,
                    )}
                    disabled={last}
                    onClick={() => { open(summary.id) }}
                  >
                    {summary.displayTitle}
                  </button>
                )
                const lineage = last || summary.subagent
                const lineageOwner = {
                  lineageSessionId: summary.id,
                  displayTitle: summary.displayTitle,
                  ...last ? {} : { openTitle: () => { open(summary.id) } },
                }
                return (
                  <span key={summary.id} className={css.crumbSeg}>
                    {index > 0 && <span className={css.crumbSep}>/</span>}
                    {lineage
                      ? summary.subagent
                        ? renderSlot(
                          'conversation.session.header.lineage',
                          lineageOwner,
                          { fallback: title },
                        )
                        : (
                          <>
                            {title}
                            {renderSlot(
                              'conversation.session.header.lineage',
                              lineageOwner,
                              { fallback: null },
                            )}
                          </>
                        )
                      : title}
                  </span>
                )
              })}
              {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
            </nav>
            <div className={css.headerActions}>
              {renderSlot('conversation.session.header.actions', {})}
            </div>
          </div>
          <div className={css.headerUtilities}>
            {renderSlot('conversation.session.header.utilities', {})}
          </div>
        </div>
      )}
      <div className={css.tabRow}>
        {tabs.length > 1 && (
          <div className={css.tabs} role="tablist">
            {tabs.map(viewTab => (
              <button
                key={viewTab.id}
                type="button"
                role="tab"
                aria-selected={viewTab.id === active?.id}
                className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                onClick={() => { actions.setView(viewTab.id) }}
              >
                {viewTab.label}
              </button>
            ))}
          </div>
        )}
        <div className={css.panelToggles} aria-label="对话布局">
          <button type="button" aria-label="展开或收起对话栏" onClick={toggleSidebar}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.75" y="4.25" width="16.5" height="15.5" rx="2" />
              <path d="M8.5 4.5v15" />
            </svg>
          </button>
          <button type="button" aria-label="展开或收起右侧工作区" onClick={toggleRightbar}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.75" y="4.25" width="16.5" height="15.5" rx="2" />
              <path d="M15.5 4.5v15" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  sessionId, useSession, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, releaseSessionImages,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
  const inspect = useStore(s => s.inspect ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  useEffect(() => () => {
    releaseSessionImages(sessionId)
  }, [releaseSessionImages, sessionId])

  // The blank-session Hero replaces only Chat. Registered auxiliary views are
  // independent work surfaces and may be opened before a conversation exists.
  if (blank && composerPhase === 'blank' && active?.id === DEFAULT_VIEW_ID) return null
  return (
    <div
      className={css.viewArea}
      data-conversation-view={active?.id ?? DEFAULT_VIEW_ID}
    >
      {active !== undefined && renderSlot('conversation.view', {
        inspect,
        onInspectDone: () => { actions.setInspect(null) },
      }, { only: active.id })}
    </div>
  )
}
