import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as MusicInvariant from '../src/invariant.ts'

describe('NetEase music invariant companion', () => {
  it('reserves the package name with its audited empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(MusicInvariant).await()).resolves.toBeDefined()
  })
})
