// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeAuthBootstrapToken,
  reloadAfterManagedRestart,
} from '../src/client/auth-store.ts'

afterEach(() => {
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('cross-entry authentication handoff', () => {
  it('consumes the proof from the fragment while preserving unrelated fragment state', () => {
    const token = 'cd'.repeat(32)
    history.replaceState(null, '', `/#panel=settings&worldline-auth-bootstrap=${token}`)
    expect(consumeAuthBootstrapToken()).toBe(token)
    expect(location.hash).toBe('#panel=settings')
    expect(consumeAuthBootstrapToken()).toBeUndefined()
  })

  it('waits through an offline generation and reloads only after the replacement responds', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const reload = vi.fn()
    await reloadAfterManagedRestart({
      attempts: 2,
      initialDelayMs: 0,
      retryDelayMs: 0,
      request,
      wait: async () => {},
      reload,
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledOnce()
  })
})
