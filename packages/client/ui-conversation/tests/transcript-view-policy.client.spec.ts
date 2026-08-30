import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationSettings } from '../src/submission-settings.ts'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'

describe('TranscriptViewPolicy', () => {
  it('defaults compact, persists changes, and adopts accepted Host values', () => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe('compact')

    policy.setMode('normal')
    expect(policy.mode.getSnapshot()).toBe('normal')
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'normal')

    host.publish({
      status: 'ready',
      value: { busyEnter: 'queue', transcriptView: 'compact' },
      revision: 1,
      writable: true,
    })
    expect(policy.mode.getSnapshot()).toBe('compact')
  })
})
