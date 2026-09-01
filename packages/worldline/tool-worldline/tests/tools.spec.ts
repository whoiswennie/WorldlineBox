import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, applyUniqueReplacement, requireConfirmation, WORLDLINE_TOOL_NAMES } from '../src/index.ts'

describe('Worldline tools', () => {
  it('registers the complete bounded business surface', () => {
    const names: string[] = []
    const ctx = {
      systemPrompt: { section() {} },
      tools: { register(tool: { name: string }) { names.push(tool.name) } },
    } as unknown as Context
    apply(ctx)
    expect(names).toEqual(WORLDLINE_TOOL_NAMES)
  })

  it('requires explicit confirmation and an unambiguous text patch', () => {
    expect(() => requireConfirmation(false, 'freeze build')).toThrow('confirm=true')
    expect(applyUniqueReplacement('one two', 'two', 'three')).toBe('one three')
    expect(() => applyUniqueReplacement('one one', 'one', 'two')).toThrow('not unique')
  })
})
