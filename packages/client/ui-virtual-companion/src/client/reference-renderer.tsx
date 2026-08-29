import type { ReactNode, SyntheticEvent } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './reference-renderer.module.css'

/** The rendering contract shared by vault cards, previews, and conversation events. */
export interface ReferenceRenderable {
  readonly id?: string
  readonly title: string
  readonly url?: string | undefined
  readonly mimeType: string
  readonly text?: string | undefined
  readonly description?: string | undefined
  readonly tags?: readonly string[] | undefined
}

export interface ReferenceRendererProps {
  readonly resource: ReferenceRenderable
  readonly mode?: 'card' | 'preview' | 'conversation' | undefined
  readonly onDuration?: ((milliseconds: number) => void) | undefined
}

/** One independently installable renderer. MIME wildcards avoid central parser changes. */
export interface ReferenceRendererDefinition {
  readonly id: string
  readonly mediaTypes: readonly string[]
  readonly render: (props: ReferenceRendererProps) => ReactNode
}

function matches(pattern: string, mediaType: string): boolean {
  const normalizedPattern = pattern.trim().toLocaleLowerCase('en-US')
  const normalizedType = mediaType.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') ?? ''
  if (normalizedPattern === '*/*') return true
  if (normalizedPattern.endsWith('/*'))
    return normalizedType.startsWith(normalizedPattern.slice(0, -1))
  return normalizedPattern === normalizedType
}

/** Open registry: extensions register a MIME renderer once and every surface can use it. */
export class ReferenceRendererRegistry {
  private readonly definitions: ReferenceRendererDefinition[] = []

  register(definition: ReferenceRendererDefinition): () => void {
    if (this.definitions.some(item => item.id === definition.id))
      throw new Error(`reference renderer already registered: ${definition.id}`)
    this.definitions.unshift(definition)
    return () => {
      const index = this.definitions.indexOf(definition)
      if (index >= 0) this.definitions.splice(index, 1)
    }
  }

  resolve(mediaType: string): ReferenceRendererDefinition | undefined {
    return this.definitions.find(definition => definition.mediaTypes.some(pattern =>
      !pattern.includes('*') && matches(pattern, mediaType)))
      ?? this.definitions.find(definition =>
        definition.mediaTypes.some(pattern => matches(pattern, mediaType)))
  }
}

export const referenceRenderers = new ReferenceRendererRegistry()

const captureDuration = (
  event: SyntheticEvent<HTMLAudioElement | HTMLVideoElement>,
  callback: ((milliseconds: number) => void) | undefined,
): void => {
  const seconds = event.currentTarget.duration
  if (callback !== undefined && Number.isFinite(seconds) && seconds > 0)
    callback(Math.round(seconds * 1_000))
}

referenceRenderers.register({
  id: 'builtin:image',
  mediaTypes: ['image/*'],
  render: ({ resource }) => <img src={resource.url} alt={resource.title} loading="lazy" />,
})
referenceRenderers.register({
  id: 'builtin:audio',
  mediaTypes: ['audio/*'],
  render: ({ resource, mode, onDuration }) => <audio
    src={resource.url}
    controls
    preload={mode === 'preview' ? 'metadata' : 'none'}
    onLoadedMetadata={(event) => { captureDuration(event, onDuration) }}
  />,
})
referenceRenderers.register({
  id: 'builtin:video',
  mediaTypes: ['video/*'],
  render: ({ resource, mode, onDuration }) => <video
    src={resource.url}
    controls
    playsInline
    preload={mode === 'preview' ? 'metadata' : 'none'}
    onLoadedMetadata={(event) => { captureDuration(event, onDuration) }}
  />,
})
referenceRenderers.register({
  id: 'builtin:markdown',
  mediaTypes: ['text/markdown'],
  render: ({ resource, mode }) => {
    const text = resource.text ?? resource.description ?? ''
    const visible = mode === 'card' ? text.slice(0, 800) : text
    return text === '' && resource.url !== undefined
      ? <a href={resource.url} target="_blank" rel="noreferrer">打开“{resource.title}”</a>
      : <MarkdownText text={visible} streaming={false} />
  },
})
referenceRenderers.register({
  id: 'builtin:text',
  mediaTypes: ['text/*'],
  render: ({ resource, mode }) => {
    const text = resource.text ?? resource.description ?? ''
    const visible = mode === 'card' ? text.slice(0, 800) : text
    return text === '' && resource.url !== undefined
      ? <a href={resource.url} target="_blank" rel="noreferrer">打开“{resource.title}”</a>
      : <pre>{visible}</pre>
  },
})

export function ReferenceContent({
  resource,
  mode = 'conversation',
  onDuration,
}: ReferenceRendererProps) {
  const definition = referenceRenderers.resolve(resource.mimeType)
  if (definition !== undefined)
    return <div
      className={css.reference}
      data-reference-renderer={definition.id}
      data-reference-mode={mode}
      data-reference-layout="bounded"
      data-reference-interactive={definition.id === 'builtin:video' || definition.id === 'builtin:audio'
        ? 'true'
        : undefined}
    >
      {definition.render({ resource, mode, onDuration })}
    </div>
  return <div
    className={css.reference}
    data-reference-renderer="fallback:attachment"
    data-reference-mode={mode}
    data-reference-layout="bounded"
  >
    {resource.url !== undefined && resource.url !== ''
      ? <a href={resource.url} target="_blank" rel="noreferrer">打开“{resource.title}”</a>
      : <>
        <strong>{resource.title}</strong>
        {resource.description === undefined || resource.description === ''
          ? null
          : <p>{resource.description}</p>}
      </>}
  </div>
}
