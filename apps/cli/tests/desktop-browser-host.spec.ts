import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { describe, expect, it } from 'vitest'
import { resolveDesktopBrowserHostPatch } from '../src/profile-boot.ts'

function environment(values: Readonly<Record<string, string>>): LaunchEnvironmentSnapshot {
  const get = (name: string): { value: string; source: 'process' } | undefined => {
    const value = values[name]
    return value === undefined ? undefined : { value, source: 'process' }
  }
  return { get, getFrom: get }
}

const provider: EntryOptions = {
  id: 'browser-electron',
  name: 'dsh-builtin-browser/browser-electron',
  config: { viewHost: { __jsExpr: "ctx.get('electronViewHost')" } },
}

describe('Desktop embedded browser Host composition', () => {
  it('adds an ordering edge without changing the community provider config', () => {
    const patch = resolveDesktopBrowserHostPatch(environment({
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL: 'http://127.0.0.1:45678',
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN: 'a'.repeat(32),
    }), provider)

    expect(patch).toEqual({ id: 'browser-electron', inject: ['electronViewHost'] })
    expect(provider.config).toEqual({ viewHost: { __jsExpr: "ctx.get('electronViewHost')" } })
  })

  it('preserves existing row injections', () => {
    expect(resolveDesktopBrowserHostPatch(environment({
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL: 'http://127.0.0.1:45678',
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN: 'b'.repeat(32),
    }), { ...provider, inject: ['browser'] })).toEqual({
      id: 'browser-electron',
      inject: ['browser', 'electronViewHost'],
    })
  })

  it('keeps the ordering patch ready for a later marketplace install', () => {
    expect(resolveDesktopBrowserHostPatch(environment({
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL: 'http://127.0.0.1:45678',
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN: 'c'.repeat(32),
    }), undefined)).toEqual({ id: 'browser-electron', inject: ['electronViewHost'] })
  })

  it('does not change ordinary Web launches or unrelated providers', () => {
    expect(resolveDesktopBrowserHostPatch(environment({}), provider)).toBeUndefined()
    expect(resolveDesktopBrowserHostPatch(environment({
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL: 'http://127.0.0.1:45678',
      WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN: 'd'.repeat(32),
    }), { ...provider, name: 'another/browser-electron' })).toBeUndefined()
  })
})
