import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import {
  launchWorldlineAuthorConversation,
  WORLDLINE_AUTHOR_PRESET,
} from '../src/client/launch-author.ts'

const sessionId = 'session:worldline-author' as SessionId
const project = {
  path: 'C:\\WorldlineLibrary\\灰烬王冠',
  manifest: {
    id: worldlineId<'project'>('project:ash-crown'),
  },
} as ProjectSummary

describe('Worldline author conversation launcher', () => {
  it('creates the dedicated composition and project cwd before binding and opening', async () => {
    const order: string[] = []
    const createSession = vi.fn(async () => { order.push('create'); return sessionId })
    const bind = vi.fn(async () => { order.push('bind'); return new Response('{}', { status: 200 }) })
    const openSession = vi.fn(() => { order.push('open') })
    const showConversation = vi.fn(() => { order.push('show') })

    await launchWorldlineAuthorConversation({
      createSession,
      deleteSession: vi.fn(async () => {}),
      bind,
      openSession,
      showConversation,
    }, project)

    expect(createSession).toHaveBeenCalledWith({
      cwd: project.path,
      agentPreset: WORLDLINE_AUTHOR_PRESET,
    })
    expect(bind).toHaveBeenCalledWith({
      sessionId,
      projectId: project.manifest.id,
    })
    expect(order).toEqual(['create', 'bind', 'open', 'show'])
  })

  it('deletes a blank Session when the immutable project binding fails', async () => {
    const deleteSession = vi.fn(async () => {})
    const openSession = vi.fn()

    await expect(launchWorldlineAuthorConversation({
      createSession: vi.fn(async () => sessionId),
      deleteSession,
      bind: vi.fn(async () => new Response(JSON.stringify({ error: 'binding refused' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })),
      openSession,
      showConversation: vi.fn(),
    }, project)).rejects.toThrow('binding refused')

    expect(deleteSession).toHaveBeenCalledWith(sessionId)
    expect(openSession).not.toHaveBeenCalled()
  })
})
