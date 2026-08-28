import { describe, expect, it } from 'vitest'
import { browserViewBounds } from '../src/browser-view-bounds.ts'

describe('native browser view bounds', () => {
  const surface = { x: 486, y: 204, width: 1535, height: 1125 }

  it('keeps ordinary pages inside the independent center-column surface', () => {
    expect(browserViewBounds(surface, false, { width: 2560, height: 1365 })).toEqual(surface)
  })

  it('fills the complete Electron content area for page-requested HTML fullscreen', () => {
    expect(browserViewBounds(surface, true, { width: 2560, height: 1365 })).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1365,
    })
  })
})
