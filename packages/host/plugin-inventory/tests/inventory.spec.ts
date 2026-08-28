import { afterEach, describe, expect, it } from 'vitest'
import type { PluginEntryId } from '../src/types.ts'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ClientModuleRegistry from '@deepseek-ai/dsh-client-modules'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import PluginInventoryGateway, { detectToolchains } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = new URL('../package.json', import.meta.url).href
  ctx.provide('webServer', {
    register: () => () => {},
    tapIndex: () => () => {},
  } as unknown as Context['webServer'])
  await ctx.plugin(Loader)
  await ctx.plugin(ClientModuleRegistry)
  await ctx.plugin(SkillRegistry)
  ctx.provide('agentPresets', {
    standingKeyFor: () => Promise.resolve({ agentPreset: 'test' }),
  } as never)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway', () => {
  it('publishes local management methods under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'toolchains', invocation: { kind: 'direct' } },
      { method: 'setPluginEnabled', invocation: { kind: 'direct' } },
      { method: 'deletePlugin', invocation: { kind: 'direct' } },
      { method: 'setSkillEnabled', invocation: { kind: 'direct' } },
      { method: 'deleteSkill', invocation: { kind: 'direct' } },
    ])
  })

  it('captures version-only toolchain readiness without exposing executable paths', async () => {
    const probe = async (command: string): Promise<string | undefined> => ({
      py: 'Python 3.13.7', python3: 'Python 3.13.7', python: 'Python 3.13.7',
      node: undefined, git: 'git version 2.50.1.windows.1',
    })[command]

    const snapshot = await detectToolchains(probe, 'v22.19.0')

    expect(snapshot).toMatchObject({
      python: { ready: true, version: '3.13.7' },
      node: { ready: true, version: '22.19.0' },
      git: { ready: true, version: '2.50.1.windows.1' },
    })
    expect(snapshot.detectedAt).toEqual(expect.any(Number))
    expect(JSON.stringify(snapshot)).not.toMatch(/[\\/](?:bin|usr|Users)[\\/]/i)
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = await inventory.list({})
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
        protected: true,
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
        protected: true,
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
        protected: true,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list({})).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
      protected: true,
    })

    await ctx.loader.remove(pendingId)
    expect((await inventory.list({})).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('rejects enablement and deletion for framework plugins at the Host boundary', async () => {
    const { ctx, inventory } = await harness()
    const entryId = await ctx.loader.create({ name: 'cordis:active' }) as PluginEntryId

    await expect(inventory.setPluginEnabled({ entryId, enabled: false }))
      .rejects.toThrow('核心插件受保护')
    await expect(inventory.deletePlugin({ entryId }))
      .rejects.toThrow('核心插件受保护')

    expect((await inventory.list({})).entries.find(entry => entry.entryId === entryId)).toMatchObject({
      enabled: true,
      protected: true,
    })
  })

  it('projects Skills through the default preset scope with their resource directory', async () => {
    const { ctx, inventory } = await harness()
    ctx.skills.register({
      name: 'project-helper',
      description: 'Project helper',
      source: 'project-worldline',
      resourceBase: { kind: 'directory', path: '/workspace/.worldline/skills/project-helper' },
      content: 'Help the project.',
    })

    const snapshot = await inventory.list({ cwd: '/workspace' })

    expect(snapshot.skills).toContainEqual(expect.objectContaining({
      name: 'project-helper',
      directory: '/workspace/.worldline/skills/project-helper',
      enabled: true,
    }))
  })
})
