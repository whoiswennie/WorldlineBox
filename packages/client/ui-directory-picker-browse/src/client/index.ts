/**
 * Browser half of the browse directory-picker backend: fills ui-workspace's
 * directory-flow holes with the in-app Select Workspace Directory dialog
 * (figma `Harness` 813-23126 family), driving the node half's
 * `host.listDirectory`/`host.createDirectory` primitives. Mounting this
 * package therefore composes both sides of the browse interaction with one
 * cordis.yml row; no client code branches on a capability kind. The dialog's
 * copy is locale-registered here — the flow package owns its own strings.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { BrowseFlowInjected } from './flow.ts'
import { BrowseDirectoryFlow } from './flow.ts'

/** Locale namespace owning the browser dialog's copy. */
const LOCALE_NS = 'directory-browser'

/** Required services (cordis fiber inject): the slot registry, the wire-facing workspace service, and locale. */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Client plugin body: register the dialog's dictionaries and the browse flow
 * into every directory-flow hole through `slots.inject()` because owners may
 * activate later or replace their declarations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // The two dictionaries land as a unit: if the second registration hits a
    // rival owner of the namespace, the first rolls back before the throw —
    // a failed activation must not squat the namespace's other locale.
    const disposers: (() => void)[] = []
    const dictionaries: [locale: string, dict: Record<string, string>][] = [
      ['zh', {
        'browser.title': '选择工作区目录',
        'browser.home': '主目录',
        'browser.newFolder': '新建文件夹',
        'browser.folderName': '文件夹名称',
        'browser.createIn': '在"{name}"中新建文件夹',
        'browser.untitledFolder': '未命名文件夹',
        'browser.create': '创建',
        'browser.cancel': '取消',
        'browser.open': '打开',
        'browser.editPath': '编辑路径',
        'browser.loading': '加载中…',
        'browser.truncated': '文件夹过多，仅显示开头部分。',
        'browser.showHidden': '显示隐藏文件',
        'path.openTitle': '选择归档文件',
        'path.saveTitle': '选择归档保存位置',
        'path.fileName': '文件名',
        'path.choose': '选择',
        'path.save': '保存到这里',
        'path.noFiles': '此文件夹中没有匹配的归档文件。',
        'path.extensionHint': '文件名需要以 {extensions} 结尾。',
      }],
      ['en', {
        'browser.title': 'Select Workspace Directory',
        'browser.home': 'Home',
        'browser.newFolder': 'New folder',
        'browser.folderName': 'Folder name',
        'browser.createIn': 'New folder in "{name}"',
        'browser.untitledFolder': 'Untitled folder',
        'browser.create': 'Create',
        'browser.cancel': 'Cancel',
        'browser.open': 'Open',
        'browser.editPath': 'Edit path',
        'browser.loading': 'Loading…',
        'browser.truncated': 'Too many folders to list; only the beginning is shown.',
        'browser.showHidden': 'Show hidden files',
        'path.openTitle': 'Select archive file',
        'path.saveTitle': 'Choose archive destination',
        'path.fileName': 'File name',
        'path.choose': 'Choose',
        'path.save': 'Save here',
        'path.noFiles': 'No matching archive files in this folder.',
        'path.extensionHint': 'File name must end in {extensions}.',
      }],
    ]
    try {
      for (const [locale, dict] of dictionaries) disposers.push(ctx.locale.register(LOCALE_NS, locale, dict))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'directory-picker-browse: dialog dictionaries')

  const injected = (): BrowseFlowInjected => ({
    listDirectory: (path, signal, includeFiles) => ctx.workspaces.listDirectory(
      path,
      signal,
      includeFiles ? { includeFiles: true, hostFilesystem: true } : undefined,
    ),
    createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),
    resolveFile: (path, name) => ctx.workspaces.resolveDirectoryFile(path, name),
    t: ctx.locale.bind(LOCALE_NS),
  })
  // All declaration lifetimes must be live before the group installs; the
  // generator makes the registrations one transactional effect. The nesting
  // order is arbitrary; no consumer hole has precedence.
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', () =>
      ctx.slots.inject('host.directoryFlow', function* () {
        yield ctx.slots.register({
          name: 'conversation.hero.workspace.directoryFlow', inject: injected,
        }, BrowseDirectoryFlow)
        yield ctx.slots.register({
          name: 'sidebar.workspaces.directoryFlow', inject: injected,
        }, BrowseDirectoryFlow)
        yield ctx.slots.register({
          name: 'host.directoryFlow', inject: injected,
        }, BrowseDirectoryFlow)
      })))
}
