import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  DesktopAssets,
  DesktopRuntimeBridge,
  DesktopWindows,
} from './desktop-services.ts'
import DesktopRuntimeSupervisor from './runtime-supervisor.ts'

/** Create the thin Electron host context around the shared Web Agent runtime. */
export async function createDesktopContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(DesktopRuntimeBridge)
  await ctx.plugin(DesktopAssets)
  await ctx.plugin(DesktopWindows)
  await ctx.plugin(DesktopRuntimeSupervisor)
  return ctx
}
