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

  it('keeps independent Sessions isolated and resolves the latest active project', () => {
    const first = {
      sessionId: SessionId('session-first'),
      projectId: worldlineId<'project'>('project:first01'),
      worldlineId: worldlineId<'worldline'>('worldline:first01'),
      sourceRevision: 'digest-first' as never,
      boundAt: '2026-09-01T00:00:00.000Z',
    }
    const second = {
      sessionId: SessionId('session-second'),
      projectId: worldlineId<'project'>('project:second01'),
      worldlineId: worldlineId<'worldline'>('worldline:second01'),
      sourceRevision: 'digest-second' as never,
      boundAt: '2026-09-01T00:00:01.000Z',
    }
    const firstEvent = { type: 'worldline/context-bound', seq: 0, time: 0, data: first } as SessionEvent
    const secondEvent = { type: 'worldline/context-bound', seq: 0, time: 0, data: second } as SessionEvent
    expect(resolveWorldlineConversationBinding({ events: [firstEvent] })).toEqual(first)
    expect(resolveWorldlineConversationBinding({ events: [secondEvent] })).toEqual(second)
    expect(resolveWorldlineConversationBinding({ events: [firstEvent, secondEvent] })).toEqual(second)
  })
})
