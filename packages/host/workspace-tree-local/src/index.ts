import { copyFile, cp, mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch, type FSWatcher } from 'chokidar'
import { WorkspaceTree } from '@deepseek-ai/dsh-host-workspace-tree'
import type {
  WorkspaceTreeEntry, WorkspaceTreeListing, WorkspaceTreeMutation, WorkspaceTreePreview,
  WorkspaceTreeSearchListing, WorkspaceTreeSearchResult,
} from '@deepseek-ai/dsh-host-workspace-tree'

/** Bounds and watcher timing for the local Workspace-tree provider. */
export interface Config {
  /** Maximum entries returned by one directory listing. */
  maxEntries: number
  /** Maximum bytes loaded for one file preview. */
  maxPreviewBytes: number
  /** Delay used to coalesce filesystem watcher notifications. */
  watchDebounceMs: number
  /** Maximum filesystem entries inspected by one Workspace search. */
  maxSearchEntries: number
  /** Maximum matches returned by one Workspace search. */
  maxSearchResults: number
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.apng': 'image/apng', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg; codecs=opus', '.aac': 'audio/aac',
  '.m4a': 'audio/mp4', '.weba': 'audio/webm', '.wma': 'audio/x-ms-wma',
  '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.ogv': 'video/ogg', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.webm': 'video/webm', '.m4v': 'video/x-m4v',
}
const TEXT = new Set(['', '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.less', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.php', '.rb', '.sh', '.bat', '.ps1', '.yaml', '.yml', '.xml', '.sql', '.log', '.env', '.gitignore', '.csv', '.ini', '.conf', '.config', '.toml'])

function validName(name: string): string {
  const value = name.trim()
  if (value === '' || value === '.' || value === '..' || basename(value) !== value) throw new Error(`invalid workspace entry name: ${name}`)
  return value
}

/** Local filesystem implementation of the replaceable Workspace-tree seam. */
export default class LocalWorkspaceTree extends WorkspaceTree {
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(2000),
    maxPreviewBytes: z.natural().min(1024).default(20 * 1024 * 1024),
    watchDebounceMs: z.natural().min(50).default(350),
    maxSearchEntries: z.natural().min(1).default(20_000),
    maxSearchResults: z.natural().min(1).default(200),
  })

  private readonly watchers = new Map<string, FSWatcher>()
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.effect(() => async () => {
      for (const timer of this.changeTimers.values()) clearTimeout(timer)
      this.changeTimers.clear()
      const watchers = [...this.watchers.values()]
      this.watchers.clear()
      // A persistent Chokidar handle is what contains late native fs.watch
      // errors on Windows. Join every close before the plugin fiber settles so
      // neither a native handle nor its error channel can outlive this Cordis
      // service.
      await Promise.all(watchers.map(async (watcher) => {
        try {
          await watcher.close()
        } catch (error: unknown) {
          this.ctx.logger('workspace-tree').warn('watch close failed: %s', messageOf(error))
        }
      }))
    }, 'workspace-tree-local watchers')
  }

  private async rootOf(workspaceRoot: string): Promise<string> {
    const root = await realpath(resolve(workspaceRoot))
    this.ensureWatcher(root)
    return root
  }

  private ensureWatcher(root: string): void {
    if (this.watchers.has(root)) return
    const watcher = watch(root, {
      ignoreInitial: true,
      // Chokidar 4's non-persistent Windows path can leave the underlying
      // node:fs FSWatcher error event unowned. A late EPERM then bypasses this
      // watcher's public `error` listener and terminates the whole Agent
      // Runtime. Cordis owns and awaits close(), so keeping the handle
      // persistent is both safe and required for process-level containment.
      persistent: true,
      depth: 30,
      ignored: path => /(?:^|[\\/])(?:node_modules|\.git|\.worldline-fantasy-artifacts\.json)(?:[\\/]|$)/i.test(path),
      awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 },
    })
    watcher.on('all', () => {
      const current = this.changeTimers.get(root)
      if (current !== undefined) clearTimeout(current)
      this.changeTimers.set(root, setTimeout(() => {
        this.changeTimers.delete(root)
        this.ctx.emit('workspace-tree/changed', root)
      }, this.config.watchDebounceMs))
    })
    watcher.on('error', (error) => { this.ctx.logger('workspace-tree').warn('watch failed for %s: %s', root, messageOf(error)) })
    this.watchers.set(root, watcher)
  }

  private async existing(root: string, path: string): Promise<string> {
    const target = await realpath(resolve(path))
    if (!inside(root, target)) throw new Error(`workspace tree path is outside the registered workspace: ${path}`)
    return target
  }

  private async destination(root: string, parent: string, name: string): Promise<string> {
    const directory = await this.existing(root, parent)
    if (!(await stat(directory)).isDirectory()) throw new Error(`workspace tree parent is not a directory: ${parent}`)
    const target = resolve(directory, validName(name))
    if (!inside(root, target)) throw new Error(`workspace tree destination is outside the registered workspace: ${target}`)
    return target
  }

  async list(workspaceRoot: string, path: string, signal?: AbortSignal): Promise<WorkspaceTreeListing> {
    signal?.throwIfAborted()
    const root = await this.rootOf(workspaceRoot)
    const target = await this.existing(root, path)
    if (!inside(root, target) || !(await stat(target)).isDirectory()) {
      throw new Error(`workspace tree path is outside the registered workspace: ${path}`)
    }
    const entries: WorkspaceTreeEntry[] = []
    let truncated = false
    const directory = await opendir(target)
    try {
      for await (const dirent of directory) {
        signal?.throwIfAborted()
        if (entries.length >= this.config.maxEntries) {
          truncated = true
          break
        }
        const candidate = join(target, dirent.name)
        let kind: WorkspaceTreeEntry['kind'] | undefined
        if (dirent.isDirectory()) kind = 'directory'
        else if (dirent.isFile()) kind = 'file'
        else if (dirent.isSymbolicLink()) {
          try {
            const linked = await realpath(candidate)
            if (!inside(root, linked)) continue
            const info = await stat(linked)
            kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
          } catch {
            continue
          }
        }
        if (kind !== undefined) {
          const info = await stat(candidate).catch(() => undefined)
          entries.push({
            name: dirent.name,
            path: candidate,
            hidden: dirent.name.startsWith('.'),
            kind,
            ...(info === undefined ? {} : { size: info.size, modifiedAt: info.mtimeMs }),
          })
        }
      }
    } catch (reason: unknown) {
      signal?.throwIfAborted()
      throw new Error(`cannot read workspace tree at ${path}: ${messageOf(reason)}`)
    } finally {
      await directory.close().catch(() => undefined)
    }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1)
    return { path: target, entries, truncated }
  }

  async search(workspaceRoot: string, query: string, signal?: AbortSignal): Promise<WorkspaceTreeSearchListing> {
    signal?.throwIfAborted()
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (normalizedQuery === '') throw new Error('workspace search query must be non-blank')
    const root = await this.rootOf(workspaceRoot)
    const directories = [root]
    const matches: Array<WorkspaceTreeSearchResult & { score: number }> = []
    let scanned = 0
    let truncated = false
    const ignored = /^(?:\.git|node_modules|lib|dist|release)$/iu

    while (directories.length > 0) {
      signal?.throwIfAborted()
      const directoryPath = directories.shift()
      if (directoryPath === undefined) break
      const directory = await opendir(directoryPath)
      try {
        for await (const dirent of directory) {
          signal?.throwIfAborted()
          scanned += 1
          if (scanned > this.config.maxSearchEntries) {
            truncated = true
            break
          }
          if (ignored.test(dirent.name) || dirent.name === '.worldline-fantasy-artifacts.json') continue
          const candidate = join(directoryPath, dirent.name)
          if (dirent.isDirectory()) {
            directories.push(candidate)
            continue
          }
          // Search never follows symlinks: a directory link can loop and a file
          // link can change authority between traversal and preview.
          if (!dirent.isFile()) continue
          const relativePath = relative(root, candidate).split('\\').join('/')
          const name = dirent.name.toLocaleLowerCase()
          const relativeName = relativePath.toLocaleLowerCase()
          const index = relativeName.indexOf(normalizedQuery)
          if (index < 0) continue
          const info = await stat(candidate)
          const score = name === normalizedQuery ? 0
            : name.startsWith(normalizedQuery) ? 1
              : name.includes(normalizedQuery) ? 2 : 3 + index / 10_000
          matches.push({
            name: dirent.name,
            path: candidate,
            relativePath,
            size: info.size,
            modifiedAt: info.mtimeMs,
            score,
          })
        }
      } finally {
        await directory.close().catch(() => undefined)
      }
      if (truncated) break
    }

    matches.sort((left, right) => left.score - right.score
      || left.relativePath.localeCompare(right.relativePath))
    if (matches.length > this.config.maxSearchResults) truncated = true
    return {
      query: query.trim(),
      results: matches.slice(0, this.config.maxSearchResults).map(({ score: _score, ...result }) => result),
      scanned,
      truncated,
    }
  }

  async preview(workspaceRoot: string, path: string, signal?: AbortSignal): Promise<WorkspaceTreePreview> {
    signal?.throwIfAborted()
    const root = await this.rootOf(workspaceRoot)
    const target = await this.existing(root, path)
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`workspace preview target is not a file: ${path}`)
    const extension = extname(target).toLowerCase()
    const mimeType = MIME[extension] ?? (TEXT.has(extension) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
    const kind: WorkspaceTreePreview['kind'] = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('audio/') ? 'audio'
        : mimeType.startsWith('video/') ? 'video'
          : TEXT.has(extension) ? 'text' : 'binary'
    const base = { path: target, name: basename(target), size: info.size, modifiedAt: info.mtimeMs, kind, mimeType }
    if (info.size > this.config.maxPreviewBytes || kind === 'binary') return { ...base, tooLarge: info.size > this.config.maxPreviewBytes }
    const buffer = await readFile(target)
    signal?.throwIfAborted()
    return kind === 'text'
      ? { ...base, tooLarge: false, encoding: 'utf8', content: buffer.toString('utf8') }
      : { ...base, tooLarge: false, encoding: 'base64', content: buffer.toString('base64') }
  }

  async mutate(workspaceRoot: string, mutation: WorkspaceTreeMutation): Promise<{ path?: string }> {
    const root = await this.rootOf(workspaceRoot)
    if (mutation.operation === 'create-file') {
      const target = await this.destination(root, mutation.parent, mutation.name)
      await writeFile(target, mutation.content ?? '', { flag: 'wx' })
      return { path: target }
    }
    if (mutation.operation === 'create-directory') {
      const target = await this.destination(root, mutation.parent, mutation.name)
      await mkdir(target)
      return { path: target }
    }
    const source = await this.existing(root, mutation.path)
    if (mutation.operation === 'clear-workspace') {
      if (source !== root) throw new Error('only the registered workspace root can be cleared')
      if (!(await stat(source)).isDirectory()) throw new Error(`workspace root is not a directory: ${source}`)
      const directory = await opendir(source)
      const children: string[] = []
      try {
        for await (const entry of directory) children.push(join(source, entry.name))
      } finally {
        await directory.close().catch(() => undefined)
      }
      const failures: string[] = []
      for (const child of children) {
        try {
          await rm(child, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (reason: unknown) {
          failures.push(`${basename(child)}: ${messageOf(reason)}`)
        }
      }
      if (failures.length > 0) throw new Error(`workspace could not be cleared completely: ${failures.join('; ')}`)
      return {}
    }
    if (source === root && mutation.operation !== 'write') throw new Error('the workspace root cannot be changed by the explorer')
    if (mutation.operation === 'delete') {
      await rm(source, { recursive: true })
      return {}
    }
    if (mutation.operation === 'write') {
      if (!(await stat(source)).isFile()) throw new Error(`workspace write target is not a file: ${source}`)
      await writeFile(source, mutation.content)
      return { path: source }
    }
    if (mutation.operation === 'rename') {
      const target = await this.destination(root, dirname(source), mutation.name)
      await rename(source, target)
      return { path: target }
    }
    const targetDirectory = await this.existing(root, mutation.targetDirectory)
    if (!(await stat(targetDirectory)).isDirectory()) throw new Error(`workspace target is not a directory: ${targetDirectory}`)
    const target = resolve(targetDirectory, basename(source))
    if (!inside(root, target) || target === source || inside(source, target)) throw new Error('invalid workspace copy/move destination')
    if (mutation.operation === 'move') await rename(source, target)
    else if ((await stat(source)).isDirectory()) await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    else await copyFile(source, target, 1)
    return { path: target }
  }
}
