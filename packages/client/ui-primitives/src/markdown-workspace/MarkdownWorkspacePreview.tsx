import { MarkdownText } from '../markdown/MarkdownText.tsx'
import css from './MarkdownWorkspace.module.css'

export interface MarkdownWorkspacePreviewProps {
  readonly content: string
  readonly ariaLabel?: string | undefined
  readonly className?: string | undefined
}

/** Shared scrollable Markdown reading surface used by every document workspace. */
export function MarkdownWorkspacePreview({
  content,
  ariaLabel = 'Markdown 预览',
  className,
}: MarkdownWorkspacePreviewProps) {
  return <article
    className={[css.preview, className].filter(Boolean).join(' ')}
    data-markdown-preview=""
    aria-label={ariaLabel}
  ><div className={css.previewContent}><MarkdownText text={content} /></div></article>
}
