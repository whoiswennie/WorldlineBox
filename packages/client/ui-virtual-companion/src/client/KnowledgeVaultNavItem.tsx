import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './VirtualCompanionNavItem.module.css'

export interface KnowledgeVaultNavInjected { open(): void; hooks: { activePage: HostObservable<string> } }
export type KnowledgeVaultNavProps = PropsRuntime<'worldline.rail.primary'> & InjectFace<KnowledgeVaultNavInjected>

export function KnowledgeVaultNavItem({ open, useActivePage }: KnowledgeVaultNavProps) {
  const selected = useActivePage(page => page === 'knowledge-vault')
  return <button type="button" className={css.button} aria-label="知识库" aria-current={selected ? 'page' : undefined}
    data-active={selected || undefined} title="知识库" onClick={open}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 4.5h6.3c1 0 1.7.4 1.7 1.4v13.6c0-1-.7-1.5-1.7-1.5H4.5Z" />
      <path d="M19.5 4.5h-6.3c-1 0-1.7.4-1.7 1.4v13.6c0-1 .7-1.5 1.7-1.5h6.3Z" />
    </svg>
  </button>
}
