import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
} from './icons/index.tsx'
import css from './WorkspaceFileTreeRow.module.css'

export interface WorkspaceFileTreeRowProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly kind: 'directory' | 'document' | 'asset'
  readonly name: string
  readonly depth?: number
  readonly open?: boolean
  readonly active?: boolean
  readonly selected?: boolean
  readonly badge?: ReactNode
}

function DocumentIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
    <path d="M9.25 1.75v3h3M5.75 8h4.5M5.75 10.5h4.5" /></svg>
}

export function WorkspaceFileTreeRow({
  kind,
  name,
  depth = 0,
  open = false,
  active = false,
  selected = false,
  badge,
  className,
  style,
  ...buttonProps
}: WorkspaceFileTreeRowProps) {
  const rowStyle = {
    ...style,
    '--workspace-tree-depth': depth,
  } as CSSProperties
  return <button {...buttonProps} type="button"
    className={[css.row, className].filter(Boolean).join(' ')}
    style={rowStyle}
    data-kind={kind}
    data-active={active || undefined}
    data-selected={selected || undefined}
    aria-current={kind !== 'directory' && active ? 'page' : undefined}>
    <span className={css.chevron}>{kind === 'directory'
      ? open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />
      : null}</span>
    <span className={css.glyph}>{kind === 'directory'
      ? open ? <IconFolderOpen16 /> : <IconFolderClose16 />
      : <DocumentIcon />}</span>
    <span className={css.name}>{name}</span>
    {badge === undefined ? null : <small className={css.badge}>{badge}</small>}
  </button>
}
