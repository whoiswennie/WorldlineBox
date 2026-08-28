/** First-level local Feature management page. */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  PluginInventoryListRequest,
  PluginInventoryMutationRequest,
  SkillInventoryMutationRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import { FunctionalityPage, type FunctionalityPageInjected } from './FunctionalityPage.tsx'
import { PluginCenterNavItem, type PluginCenterNavInjected } from './PluginCenterNavItem.tsx'
import { en, zh } from './locales.ts'

export type { FunctionalityPageInjected, FunctionalityPageProps } from './FunctionalityPage.tsx'
export type { PluginCenterLocaleKey } from './locales.ts'

/** Locale namespace owned by the plugin-management surface. */
export const NS = 'pluginCenter'
export const inject = [
  'slots', 'layout', 'locale', 'remote', 'remote.pluginInventory', 'workspaces',
]
const FUNCTIONALITY_PAGE_ID = 'features'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-center: dictionaries')
  const invoke = async <T>(call: Promise<{ ok: boolean; value?: T; error?: { code: string; message: string } }>): Promise<T> => {
    const result = await call
    if (!result.ok) throw new Error(`${result.error?.code ?? 'REMOTE_ERROR'}: ${result.error?.message ?? 'unknown error'}`)
    return result.value as T
  }
  const pageInjected = (): FunctionalityPageInjected => ({
    list: async (request: PluginInventoryListRequest) =>
      await invoke(ctx.remote.pluginInventory.list(request)),
    setPluginEnabled: async (request: PluginInventoryMutationRequest) => await invoke(ctx.remote.pluginInventory.setPluginEnabled(request)),
    deletePlugin: async (request: PluginInventoryMutationRequest) => await invoke(ctx.remote.pluginInventory.deletePlugin(request)),
    setSkillEnabled: async (request: SkillInventoryMutationRequest) => await invoke(ctx.remote.pluginInventory.setSkillEnabled(request)),
    deleteSkill: async (request: SkillInventoryMutationRequest) => await invoke(ctx.remote.pluginInventory.deleteSkill(request)),
    openDirectory: async (path: string) => { await ctx.workspaces.openPath(path) },
    subscribe: (listener) => {
      const offInventory = ctx.remote.$on('plugin-inventory/change', listener)
      const offConnection = ctx.on('connection/reset', listener)
      return () => {
        offConnection()
        offInventory()
      }
    },
  })
  const navInjected = (): PluginCenterNavInjected => ({
    pageId: FUNCTIONALITY_PAGE_ID, open: () => { ctx.layout.activatePage(FUNCTIONALITY_PAGE_ID) },
    activePage: () => ctx.layout.activePage(), subscribePage: listener => ctx.layout.subscribePage(listener),
  })
  ctx.slots.inject('worldline.rail.primary', () => ctx.slots.register({
    name: 'worldline.rail.primary', id: FUNCTIONALITY_PAGE_ID, order: 10, locale: NS, inject: navInjected,
  }, PluginCenterNavItem))
  ctx.slots.inject('worldline.main.page', () => ctx.slots.register({
    name: 'worldline.main.page', priority: 10, select: owner => owner.activePage === FUNCTIONALITY_PAGE_ID ? {} : null,
    locale: NS, inject: pageInjected,
  }, FunctionalityPage))
  ctx.effect(() => () => {
    if (ctx.layout.activePage() === FUNCTIONALITY_PAGE_ID) ctx.layout.activatePage('conversation')
  }, 'ui-plugin-center: close selected page on teardown')
}
