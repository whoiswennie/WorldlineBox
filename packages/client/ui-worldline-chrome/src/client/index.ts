import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-browser/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ClockTopbar, RuntimeStatus, WorkspaceTopbar } from './ChromeSeats.tsx'
import { ProductStatus, type ProductStatusInjected } from './DesktopUpdate.tsx'
import { DesktopUpdateController } from './desktop-update-controller.ts'
import { WorkspaceEditor, workspaceEditor } from './WorkspaceEditor.tsx'
import { WorkspaceExplorer } from './WorkspaceExplorer.tsx'
import { TerminalWorkbench } from './TerminalWorkbench.tsx'
import { RuntimeLogsWorkbench } from './RuntimeLogsWorkbench.tsx'

export const inject = [
  'slots', 'layout', 'workspaces', 'remote', 'remote.pluginInventory',
  'conversation', 'browserNavigation', 'connection',
]

async function valueOf<T>(promise: Promise<{
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
}>): Promise<T> {
  const response = await promise
  if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const updates = new DesktopUpdateController()
  ctx.effect(() => updates.start(), 'worldline desktop update bridge')
  ctx.effect(() => {
    workspaceEditor.configure(mutation => ctx.workspaces.mutateTree(mutation))
    return () => { workspaceEditor.configure(undefined) }
  }, 'worldline workspace editor writer')
  ctx.slots.inject('worldline.topbar.leading', () => ctx.slots.register({
    name: 'worldline.topbar.leading', id: 'workspace', order: 0,
    inject: () => ({
      switchWorkspace: (workspaceId: Parameters<typeof ctx.workspaces.startSession>[0]) => {
        ctx.workspaces.startSession(workspaceId)
      },
    }),
  }, WorkspaceTopbar))
  ctx.slots.inject('worldline.topbar.trailing', () => ctx.slots.register({
    name: 'worldline.topbar.trailing', id: 'clock', order: 0,
  }, ClockTopbar))
  ctx.slots.inject('worldline.status.left', () => ctx.slots.register({
    name: 'worldline.status.left', id: 'runtime', order: 0,
    inject: () => ({
      loadToolchains: async () => {
        const result = await ctx.remote.pluginInventory.toolchains()
        if (!result.ok) {
          throw new Error(`${result.error.code}: ${result.error.message}`)
        }
        return result.value
      },
    }),
  }, RuntimeStatus))
  ctx.slots.inject('worldline.status.right', () => ctx.slots.register({
    name: 'worldline.status.right', id: 'product', order: 0,
    inject: (): ProductStatusInjected => ({
      hooks: { update: updates.store },
      checkUpdate: () => updates.check(),
      downloadUpdate: () => updates.download(),
      installUpdate: () => updates.install(),
    }),
  }, ProductStatus))
  // The workspace explorer is product chrome, not an optional UI plugin. The
  // Host service behind this boundary only transports sandboxed filesystem IO.
  ctx.slots.inject('worldline.workspace.right', () => ctx.slots.register({
    name: 'worldline.workspace.right', priority: 0,
    inject: () => ({
      listDirectory: (path: string, signal: AbortSignal) => ctx.workspaces.listDirectory(path, signal, true),
      searchFiles: (path: string, query: string, signal: AbortSignal) =>
        ctx.workspaces.searchFiles(path, query, signal),
      previewFile: (path: string, signal: AbortSignal) => ctx.workspaces.previewFile(path, signal),
      mutate: (mutation: Parameters<typeof ctx.workspaces.mutateTree>[0]) => ctx.workspaces.mutateTree(mutation),
      openPath: (path: string) => ctx.workspaces.openPath(path),
      openInBrowser: (sessionId: SessionId, workspaceRoot: string, path: string) => (
        ctx.browserNavigation.openLocal(sessionId, workspaceRoot, path)
      ),
      subscribeChanges: (listener: (root: string) => void) => ctx.remote.$on('workspace-tree/changed', listener),
      selectView: (sessionId: SessionId, viewId: string) => { ctx.conversation.selectView(sessionId, viewId) },
      close: () => { ctx.layout.closeDetails() },
    }),
  }, WorkspaceExplorer))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'workspace', order: 20, label: '文件',
    inject: (_sessionId: SessionId) => ({
      previewFile: (path: string, signal: AbortSignal) => ctx.workspaces.previewFile(path, signal),
      openPath: (path: string) => ctx.workspaces.openPath(path),
      subscribeChanges: (listener: (root: string) => void) => ctx.remote.$on('workspace-tree/changed', listener),
    }),
  }, WorkspaceEditor))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'terminal', order: 30, label: '终端',
    inject: (_sessionId: SessionId) => ({
      list: (sessionId: string) => valueOf(connection.api.host.listTerminals({ sessionId })),
      spawn: (sessionId: string, type: string, cwd?: string) => valueOf(
        connection.api.host.spawnTerminal({ sessionId, type, ...(cwd === undefined ? {} : { cwd }) }),
      ),
      readRaw: (sessionId: string, terminalId: string, cursor: number) => valueOf(
        connection.api.host.readTerminalRaw({ sessionId, terminalId, cursor }),
      ),
      write: async (sessionId: string, terminalId: string, data: string) => {
        await valueOf(connection.api.host.writeTerminal({ sessionId, terminalId, data }))
      },
      resize: async (sessionId: string, terminalId: string, cols: number, rows: number) => {
        await valueOf(connection.api.host.resizeTerminal({ sessionId, terminalId, cols, rows }))
      },
      interrupt: async (sessionId: string, terminalId: string) => {
        await valueOf(connection.api.host.interruptTerminal({ sessionId, terminalId }))
      },
      kill: async (sessionId: string, terminalId: string) => {
        await valueOf(connection.api.host.killTerminal({ sessionId, terminalId }))
      },
    }),
  }, TerminalWorkbench))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'runtime-logs', order: 40, label: '日志',
    inject: () => ({
      read: (cursor?: number) => valueOf(connection.api.host.readRuntimeLogs(
        cursor === undefined ? {} : { cursor, limit: 500 },
      )),
      startRecording: () => valueOf(connection.api.host.startRuntimeLogRecording({})),
      stopRecording: () => valueOf(connection.api.host.stopRuntimeLogRecording({})),
      openPath: async (path: string) => {
        await valueOf(connection.api.host.openPath({ path }))
      },
    }),
  }, RuntimeLogsWorkbench))
}
