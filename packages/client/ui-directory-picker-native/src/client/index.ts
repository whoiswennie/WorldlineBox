/**
 * Browser half of the native directory-picker backend: fills ui-workspace's
 * directory-flow holes with a renderless occupant that answers each
 * `open` by driving `host.pickPath` (the node half's OS chooser) and
 * reporting the one outcome — picked path, cancellation, or failure — back
 * through the owner conversation. Mounting this package therefore composes
 * both sides of the native interaction with one cordis.yml row; no client
 * code branches on a capability kind.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { NativeFlowInjected } from './flow.ts'
import { NativeDirectoryFlow } from './flow.ts'


/** Required services (cordis fiber inject): the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces']

/**
 * Client plugin body: register the renderless native flow into every
 * directory-flow hole through `slots.inject()` because owners may activate
 * later or replace their declarations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): NativeFlowInjected => ({ pick: request => ctx.workspaces.pickPath(request) })
  // All declaration lifetimes must be live before the group installs; the
  // generator makes the registrations one transactional effect. The nesting
  // order is arbitrary; no consumer hole has precedence.
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', () =>
      ctx.slots.inject('host.directoryFlow', function* () {
        yield ctx.slots.register({
          name: 'conversation.hero.workspace.directoryFlow', inject: injected,
        }, NativeDirectoryFlow)
        yield ctx.slots.register({
          name: 'sidebar.workspaces.directoryFlow', inject: injected,
        }, NativeDirectoryFlow)
        yield ctx.slots.register({
          name: 'host.directoryFlow', inject: injected,
        }, NativeDirectoryFlow)
      })))
}
