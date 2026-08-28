/**
 * Settings shell root: the sidebar-foot trigger plus Worldline's full-workspace
 * settings page. The shell is a pure composition face — text and sections
 * arrive from registrants through slots, while accessible names resolve to
 * their rendered content. Page visibility and the active section id are
 * component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutline16 className={css.navIcon} size={14} />
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={14} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={14} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={14} />
  return <IconSettingsOutline16 className={css.navIcon} size={14} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * Settings is a workspace-sized page laid over the conversation columns. It
 * keeps the rail and status bar visible, matching Worldline's original
 * desktop information architecture instead of presenting Harness' modal.
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  return (
    <div className={css.overlay} role="presentation">
      <section className={css.panel} role="dialog" aria-modal="false" aria-labelledby={titleId}>
        <header className={css.pageHeader}>
          <div className={css.pageIcon}><IconSettingsOutline16 size={24} /></div>
          <div className={css.pageHeading} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
        </header>
        <div className={css.pageBody}>
          <nav className={css.nav} aria-label="设置分类">
            <div className={css.navList}>
              {rows.map(row => (
                <button
                  key={row.id}
                  type="button"
                  className={clsx(css.navCell, row.id === active && css.active)}
                  aria-label={row.label}
                  aria-current={row.id === active ? 'true' : undefined}
                  onClick={() => { onSelect(row.id) }}
                >
                  <span className={css.navIconBox}>{navIcon(row.id)}</span>
                  <span className={css.navCopy}>
                    <strong className={css.navLabel}>{row.label}</strong>
                    {row.description === undefined ? null : <small>{row.description}</small>}
                  </span>
                  <span className={css.navArrow}>›</span>
                </button>
              ))}
            </div>
            <p className={css.autoSave}>所有设置会自动保存并即时生效</p>
          </nav>
          <div className={css.content}>
            <div className={css.options}>
              {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { useSections, useOnboardingSteps, useSessions, renderSlot, navigation } = props
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const activePage = useSyncExternalStore(
    navigation.subscribePage,
    navigation.activePage,
    navigation.activePage,
  )
  const open = activePage === 'settings'
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    navigation.activatePage('conversation')
  }, [navigation])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    navigation.activatePage('settings')
  }, [navigation])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, css.rail)}
        aria-current={open ? 'page' : undefined}
        aria-expanded={open}
        data-active={open || undefined}
        onClick={() => { navigation.activatePage('settings') }}
      >
        {renderSlot('settings.trigger', { wide: false })}
      </button>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Onboarding chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding renders null. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
