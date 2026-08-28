import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { NeteaseMusic } from '../src/client/NeteaseMusic.tsx'
import { PlaylistSettingsRow } from '../src/client/PlaylistSettingsRow.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('NetEase music client plugin', () => {
  it('declares its slot dependency and keeps the node half inert', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.neteaseMusic'])
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers one shared-store player and General-settings playlist row', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const slotsFiber = ctx.plugin(SlotRegistry)
    await slotsFiber.await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'worldline.topbar.trailing': { kind: 'list', scope: 'root' },
        'settings.general.item': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    const namespace = { catalog: vi.fn(), stream: vi.fn(), lyrics: vi.fn() }
    ctx.reflect.provide('remote', { neteaseMusic: namespace })
    ctx.reflect.provide('remote.neteaseMusic', namespace)

    const plugin = ctx.plugin({ apply, inject })
    await plugin.await()
    const [entry] = slots.entries('worldline.topbar.trailing')
    expect(entry?.options).toMatchObject({ id: 'netease-music', order: 100 })
    expect(entry?.component).toBe(NeteaseMusic)
    const [settingsEntry] = slots.entries('settings.general.item')
    expect(settingsEntry?.options).toMatchObject({ id: 'netease-playlist', order: 30 })
    expect(settingsEntry?.component).toBe(PlaylistSettingsRow)

    await plugin.dispose()
    expect(slots.entries('worldline.topbar.trailing')).toHaveLength(0)
    expect(slots.entries('settings.general.item')).toHaveLength(0)
  })
})
