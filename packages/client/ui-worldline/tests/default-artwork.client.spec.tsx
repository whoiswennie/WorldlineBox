// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ArtworkImage } from '../src/client/ArtworkImage.tsx'
import {
  DEFAULT_ARTWORK,
  DEFAULT_CHARACTER_ART,
  artworkSources,
  defaultCharacterArtwork,
} from '../src/client/default-artwork.ts'

describe('Worldline default artwork', () => {
  it('covers every supported canon object kind', () => {
    expect(Object.keys(DEFAULT_ARTWORK).sort()).toEqual([
      'asset',
      'character',
      'charter',
      'concept',
      'custom',
      'fact',
      'item',
      'organization',
      'place',
      'relation',
      'rule',
      'scenario',
      'species',
      'timeline-event',
    ])
    expect(Object.values(DEFAULT_ARTWORK).every(source => source.endsWith('.png'))).toBe(true)
  })

  it('keeps one Huan form stable for the same character identity', () => {
    const source = defaultCharacterArtwork('characters/lin-che.md')
    expect(defaultCharacterArtwork('characters/lin-che.md')).toBe(source)
    expect(DEFAULT_CHARACTER_ART.map(item => item.value)).toContain(source)
  })

  it('adds an object-kind fallback after authored artwork', () => {
    expect(artworkSources('assets/items/missing.png', 'item', 'items/clock.md')).toEqual([
      'assets/items/missing.png',
      DEFAULT_ARTWORK.item,
    ])
  })

  it('replaces a broken authored image instead of exposing a broken icon', () => {
    render(<ArtworkImage sources={['/missing.png', DEFAULT_ARTWORK.place]} alt="地点图" />)
    const image = screen.getByRole('img', { name: '地点图' })
    expect(image.getAttribute('src')).toBe('/missing.png')
    fireEvent.error(image)
    expect(screen.getByRole('img', { name: '地点图' }).getAttribute('src')).toBe(DEFAULT_ARTWORK.place)
  })
})
