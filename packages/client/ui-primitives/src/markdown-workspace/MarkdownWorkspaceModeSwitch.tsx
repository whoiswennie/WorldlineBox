import css from './MarkdownWorkspace.module.css'

export type MarkdownWorkspaceMode = 'edit' | 'preview' | 'split'

export interface MarkdownWorkspaceModeSwitchProps {
  readonly value: MarkdownWorkspaceMode
  readonly onChange: (mode: MarkdownWorkspaceMode) => void
  readonly labels?: Partial<Record<MarkdownWorkspaceMode, string>> | undefined
  readonly className?: string | undefined
}

const MODES: readonly MarkdownWorkspaceMode[] = ['edit', 'preview', 'split']

export function MarkdownWorkspaceModeSwitch({
  value,
  onChange,
  labels,
  className,
}: MarkdownWorkspaceModeSwitchProps) {
  return <div className={[css.modeSwitch, className].filter(Boolean).join(' ')} role="group"
    aria-label="Markdown 视图模式">
    {MODES.map(mode => <button type="button" key={mode} aria-pressed={value === mode}
      onClick={() => { onChange(mode) }}>
      {labels?.[mode] ?? (mode === 'edit' ? '编辑' : mode === 'preview' ? '预览' : '分屏')}
    </button>)}
  </div>
}
