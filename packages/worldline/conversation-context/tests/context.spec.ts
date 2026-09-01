import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { resolveWorldlineConversationBinding } from '../src/index.ts'

describe('Worldline conversation binding', () => {
  it('folds the durable binding event without alternate formats', () => {
    const binding = {
      sessionId: SessionId('session-bound'),
      projectId: worldlineId<'project'>('project:bound01'),
      worldlineId: worldlineId<'worldline'>('worldline:bound01'),
      sourceRevision: 'digest-current' as never,
      boundAt: '2026-09-01T00:00:00.000Z',
    }
    const event = { type: 'worldline/context-bound', seq: 0, time: 0, data: binding } as SessionEvent
    expect(resolveWorldlineConversationBinding({ events: [event] })).toEqual(binding)
  })
})
