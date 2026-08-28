// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-locale'
import { COMMON_NS, LocaleRuntime, inject } from '@deepseek-ai/dsh-client-locale/client'
import * as LocaleInvariant from '@deepseek-ai/dsh-client-locale/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(LocaleInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply tolerates a Host without settings', () => {
    nodeApply(new Context())
  })

  it('client apply declares its settings transport dependencies', () => {
    expect(inject).toEqual(['slots', 'connection', 'remote', 'settingsScope'])
  })

  it('the standalone runtime exposes both shipped locales', () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    locale.register(COMMON_NS, 'zh', {})
    locale.register(COMMON_NS, 'en', {})
    expect(locale.getLocale().locales.map(item => item.id)).toEqual(['zh', 'en'])
  })
})
