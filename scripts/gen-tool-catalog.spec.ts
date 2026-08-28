import { describe, expect, it } from 'vitest'
import { toolPackageAnchor } from './gen-tool-catalog.ts'

describe('tool catalog anchors', () => {
  it('keeps the DSH scope and package name separated', () => {
    expect(toolPackageAnchor('@deepseek-ai/dsh-tool-ask-user')).toBe('deepseek-ai-dsh-tool-ask-user')
  })
})
