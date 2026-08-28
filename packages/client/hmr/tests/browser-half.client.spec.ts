/** Browser-side HMR activation boundary. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/client/index.ts'

describe('hmr browser half', () => {
  it('creates no EventSource when development mode is disabled', () => {
    const eventSource = vi.fn()
    vi.stubGlobal('EventSource', eventSource)
    expect(() => {
      apply({} as Context, new Config({ enabled: false }))
    }).not.toThrow()
    expect(eventSource).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('defaults the development gate to disabled', () => {
    expect(new Config({}).enabled).toBe(false)
  })
})
