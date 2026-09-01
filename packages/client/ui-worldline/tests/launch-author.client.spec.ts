import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import {
  launchWorldlineAuthorConversation,
  WORLDLINE_AUTHOR_PRESET,
} from '../src/client/launch-author.ts'

const sessionId = 'session:worldline-author' as SessionId
const workspaceId = 'workspace:ash-crown' as WorkspaceId
const project = {
  path: 'C:\\WorldlineLibrary\\灰烬王冠',
  manifest: {
    id: worldlineId<'project'>('project:ash-crown'),
  },
} as ProjectSummary

describe('Worldline author conversation launcher', () => {
  it('registers the project workspace before creating, binding, and opening the author', async () => {
    const order: string[] = []
    const registerWorkspace = vi.fn(async () => {
      order.push('register')
      return { workspaceId } as WorkspaceView
    })
    const createSession = vi.fn(async () => { order.push('create'); return sessionId })
    const bind = vi.fn(async () => { order.push('bind'); return new Response('{}', { status: 200 }) })
    const openSession = vi.fn(() => { order.push('open') })
    const showConversation = vi.fn(() => { order.push('show') })

    await launchWorldlineAuthorConversation({
      registerWorkspace,
      createSession,
      deleteSession: vi.fn(async () => {}),
      bind,
      openSession,
      showConversation,
    }, project)

    expect(registerWorkspace).toHaveBeenCalledWith({ path: project.path })
    expect(createSession).toHaveBeenCalledWith({
      workspaceId,
      agentPreset: WORLDLINE_AUTHOR_PRESET,
    })
    expect(bind).toHaveBeenCalledWith({
      sessionId,
      projectId: project.manifest.id,
    })
    expect(order).toEqual(['register', 'create', 'bind', 'open', 'show'])
  })

  it('deletes a blank Session when the initial project selection fails', async () => {
    const deleteSession = vi.fn(async () => {})
    const openSession = vi.fn()

    await expect(launchWorldlineAuthorConversation({
      registerWorkspace: vi.fn(async () => ({ workspaceId }) as WorkspaceView),
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

  it('does not publish a Session when Workspace registration fails', async () => {
    const createSession = vi.fn(async () => sessionId)

    await expect(launchWorldlineAuthorConversation({
      registerWorkspace: vi.fn(async () => { throw new Error('workspace unavailable') }),
      createSession,
      deleteSession: vi.fn(async () => {}),
      bind: vi.fn(),
      openSession: vi.fn(),
      showConversation: vi.fn(),
    }, project)).rejects.toThrow('workspace unavailable')

    expect(createSession).not.toHaveBeenCalled()
  })
})
