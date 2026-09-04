import { useEffect, useState, type ImgHTMLAttributes } from 'react'

interface ArtworkImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> {
  readonly sources: readonly (string | undefined)[]
}

/** Advance through authored art and shipped defaults without ever exposing a broken image icon. */
export function ArtworkImage({ sources: candidates, ...props }: ArtworkImageProps) {
  const sources = [...new Set(candidates.filter((source): source is string => (
    source !== undefined && source.trim() !== ''
  )))]
  const signature = sources.join('\u0000')
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0) }, [signature])
  const source = sources[index]
  if (source === undefined) return null
  return <img {...props} src={source} onError={() => { setIndex(current => current + 1) }} />
}
