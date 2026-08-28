import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir, open, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import type { DesktopUpdateSnapshot } from './update-contract.ts'

export const WORLDLINE_UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/whoiswennie/WorldlineBox/main/latest.yml'

const MAX_MANIFEST_BYTES = 256 * 1024
const RELEASE_ASSET_PREFIX = '/whoiswennie/WorldlineBox/releases/download/'
const READY_RECORD = 'ready-update.json'

interface UpdateFile {
  readonly url: string
  readonly sha512: string
  readonly size: number
}

export interface WorldlineUpdateManifest {
  readonly version: string
  readonly files: readonly UpdateFile[]
  readonly path: string
  readonly sha512: string
  readonly releaseDate: string
  readonly releaseNotes: string
}

interface ReadyRecord {
  readonly manifest: WorldlineUpdateManifest
  readonly fileName: string
}

export interface UpdateManagerOptions {
  readonly currentVersion: string
  readonly storageDirectory: string
  readonly enabled: boolean
  readonly manifestUrl?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly publish?: (snapshot: DesktopUpdateSnapshot) => void
  readonly launchInstaller?: (installerPath: string) => void | Promise<void>
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('更新清单不是有效的对象。')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`更新清单缺少 ${field}。`)
  return value
}

function validVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
}

function validateReleaseUrl(value: string): void {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || !url.pathname.startsWith(RELEASE_ASSET_PREFIX)
  ) {
    throw new Error('更新包地址不是 WorldlineBox 的 GitHub Release 资产。')
  }
}

/** Parse and strictly validate the repository-owned latest.yml wire format. */
export function parseUpdateManifest(source: string): WorldlineUpdateManifest {
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('更新清单过大。')
  const root = record(loadYaml(source))
  const version = requiredString(root.version, 'version')
  if (!validVersion(version)) throw new Error('更新清单版本号格式无效。')
  if (!Array.isArray(root.files) || root.files.length !== 1) {
    throw new Error('更新清单必须且只能包含一个 Windows 安装包。')
  }
  const rawFile = record(root.files[0])
  const url = requiredString(rawFile.url, 'files[0].url')
  validateReleaseUrl(url)
  const sha512 = requiredString(rawFile.sha512, 'files[0].sha512')
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(sha512)) throw new Error('更新清单 SHA-512 格式无效。')
  const size = rawFile.size
  if (!Number.isSafeInteger(size) || (size as number) <= 0) throw new Error('更新清单文件大小无效。')
  const path = requiredString(root.path, 'path')
  if (basename(path) !== path || !/^WorldlineBox-Setup-[0-9A-Za-z.-]+\.exe$/u.test(path)) {
    throw new Error('更新清单安装包文件名无效。')
  }
  if (requiredString(root.sha512, 'sha512') !== sha512) throw new Error('更新清单摘要字段不一致。')
  const releaseDate = requiredString(root.releaseDate, 'releaseDate')
  if (Number.isNaN(Date.parse(releaseDate))) throw new Error('更新清单发布日期无效。')
  const releaseNotes = requiredString(root.releaseNotes, 'releaseNotes')
  return {
    version,
    files: [{ url, sha512, size: size as number }],
    path,
    sha512,
    releaseDate,
    releaseNotes,
  }
}

function versionParts(value: string): { stable: readonly number[]; prerelease: string | undefined } {
  const [stable = '', prerelease] = value.split('-', 2)
  return { stable: stable.split('.').map(Number), prerelease }
}

/** Compare repository versions without accepting loose or partial spellings. */
export function compareVersions(left: string, right: string): number {
  if (!validVersion(left) || !validVersion(right)) throw new Error('无法比较无效的版本号。')
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    const difference = (a.stable[index] ?? 0) - (b.stable[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true })
}

async function sha512Of(path: string): Promise<string> {
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('base64')
}

/** Owns one updater transaction and its durable, verified installer cache. */
export class DesktopUpdateManager {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly manifestUrl: string
  private current: DesktopUpdateSnapshot
  private manifest: WorldlineUpdateManifest | undefined
  private checkOperation: Promise<DesktopUpdateSnapshot> | undefined
  private downloadOperation: Promise<DesktopUpdateSnapshot> | undefined

  constructor(private readonly options: UpdateManagerOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.manifestUrl = options.manifestUrl ?? WORLDLINE_UPDATE_MANIFEST_URL
    this.current = {
      revision: 0,
      phase: options.enabled ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
    }
  }

  get snapshot(): DesktopUpdateSnapshot { return this.current }

  private publish(patch: Omit<DesktopUpdateSnapshot, 'revision' | 'currentVersion'>): DesktopUpdateSnapshot {
    this.current = {
      revision: this.current.revision + 1,
      currentVersion: this.options.currentVersion,
      ...patch,
    }
    this.options.publish?.(this.current)
    return this.current
  }

  private manifestState(
    phase: DesktopUpdateSnapshot['phase'],
    manifest: WorldlineUpdateManifest,
    extra: Partial<DesktopUpdateSnapshot> = {},
  ): DesktopUpdateSnapshot {
    const file = manifest.files[0]
    if (file === undefined) throw new Error('更新清单没有安装包。')
    return this.publish({
      phase,
      latestVersion: manifest.version,
      releaseDate: manifest.releaseDate,
      releaseNotes: manifest.releaseNotes,
      totalBytes: file.size,
      ...extra,
    })
  }

  /** Recover a previously verified download before attempting any network request. */
  async initialize(): Promise<DesktopUpdateSnapshot> {
    if (!this.options.enabled) return this.current
    try {
      const raw = JSON.parse(await readFile(join(this.options.storageDirectory, READY_RECORD), 'utf8')) as ReadyRecord
      const manifest = parseUpdateManifest(JSON.stringify(raw.manifest))
      if (compareVersions(manifest.version, this.options.currentVersion) <= 0) return this.current
      const expectedName = basename(manifest.path)
      if (raw.fileName !== expectedName) throw new Error('缓存的更新包名称不一致。')
      const installerPath = join(this.options.storageDirectory, expectedName)
      const info = await stat(installerPath)
      const file = manifest.files[0]
      if (file === undefined || info.size !== file.size || await sha512Of(installerPath) !== manifest.sha512) {
        throw new Error('缓存的更新包校验失败。')
      }
      this.manifest = manifest
      return this.manifestState('ready', manifest, {
        downloadedBytes: info.size,
        percent: 100,
      })
    } catch {
      return this.current
    }
  }

  check(): Promise<DesktopUpdateSnapshot> {
    if (!this.options.enabled) return Promise.resolve(this.current)
    this.checkOperation ??= this.performCheck().finally(() => { this.checkOperation = undefined })
    return this.checkOperation
  }

  private async performCheck(): Promise<DesktopUpdateSnapshot> {
    const hadReadyInstaller = this.current.phase === 'ready'
    if (!hadReadyInstaller) this.publish({ phase: 'checking' })
    try {
      const response = await this.fetchImpl(this.manifestUrl, {
        cache: 'no-store',
        headers: { accept: 'text/yaml, text/plain;q=0.9' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${String(response.status)}`)
      const source = await response.text()
      const manifest = parseUpdateManifest(source)
      if (compareVersions(manifest.version, this.options.currentVersion) <= 0) {
        this.manifest = undefined
        return this.publish({ phase: 'current', latestVersion: manifest.version })
      }
      if (hadReadyInstaller && this.manifest?.version === manifest.version) return this.current
      this.manifest = manifest
      if (await this.restoreMatchingInstaller(manifest)) {
        const file = manifest.files[0]
        if (file === undefined) throw new Error('更新清单没有安装包。')
        return this.manifestState('ready', manifest, {
          downloadedBytes: file.size,
          percent: 100,
        })
      }
      return this.manifestState('available', manifest)
    } catch (error) {
      if (hadReadyInstaller) return this.current
      return this.publish({
        phase: 'error',
        message: `检查更新失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private async restoreMatchingInstaller(manifest: WorldlineUpdateManifest): Promise<boolean> {
    const installerPath = join(this.options.storageDirectory, basename(manifest.path))
    try {
      const info = await stat(installerPath)
      const file = manifest.files[0]
      return file !== undefined && info.size === file.size && await sha512Of(installerPath) === manifest.sha512
    } catch {
      return false
    }
  }

  download(): Promise<DesktopUpdateSnapshot> {
    if (!this.options.enabled) return Promise.resolve(this.current)
    if (this.current.phase === 'ready') return Promise.resolve(this.current)
    if (this.manifest === undefined) return this.check().then(() => {
      if (this.manifest === undefined) throw new Error('当前没有可下载的新版本。')
      return this.download()
    })
    this.downloadOperation ??= this.performDownload(this.manifest)
      .finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  private async performDownload(manifest: WorldlineUpdateManifest): Promise<DesktopUpdateSnapshot> {
    const file = manifest.files[0]
    if (file === undefined) throw new Error('更新清单没有安装包。')
    await mkdir(this.options.storageDirectory, { recursive: true })
    const installerPath = join(this.options.storageDirectory, basename(manifest.path))
    const partialPath = `${installerPath}.part`
    await rm(partialPath, { force: true })
    this.manifestState('downloading', manifest, { downloadedBytes: 0, percent: 0 })
    const startedAt = this.now()
    let downloaded = 0
    let lastPublishedAt = startedAt
    const digest = createHash('sha512')
    try {
      const response = await this.fetchImpl(file.url, {
        cache: 'no-store',
        headers: { accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(30 * 60_000),
      })
      if (!response.ok || response.body === null) {
        throw new Error(`GitHub 下载返回 HTTP ${String(response.status)}`)
      }
      const destination = await open(partialPath, 'w')
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await destination.write(chunk)
          digest.update(chunk)
          downloaded += chunk.byteLength
          const at = this.now()
          if (at - lastPublishedAt >= 100 || downloaded === file.size) {
            lastPublishedAt = at
            this.manifestState('downloading', manifest, {
              downloadedBytes: downloaded,
              percent: Math.min(100, downloaded * 100 / file.size),
              bytesPerSecond: downloaded * 1000 / Math.max(1, at - startedAt),
            })
          }
        }
      } finally {
        await destination.close()
      }
      if (downloaded !== file.size) throw new Error('下载大小与更新清单不一致。')
      if (digest.digest('base64') !== file.sha512) throw new Error('更新包 SHA-512 校验失败。')
      await rm(installerPath, { force: true })
      await rename(partialPath, installerPath)
      const record: ReadyRecord = { manifest, fileName: basename(manifest.path) }
      const recordPath = join(this.options.storageDirectory, READY_RECORD)
      const temporaryRecord = `${recordPath}.tmp`
      await writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await rename(temporaryRecord, recordPath)
      return this.manifestState('ready', manifest, {
        downloadedBytes: downloaded,
        percent: 100,
      })
    } catch (error) {
      await rm(partialPath, { force: true })
      return this.manifestState('error', manifest, {
        downloadedBytes: downloaded,
        percent: Math.min(100, downloaded * 100 / file.size),
        message: `下载更新失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /** Launch only a cached installer that is still represented by the ready state. */
  async install(): Promise<void> {
    if (this.current.phase !== 'ready' || this.manifest === undefined) {
      throw new Error('更新包尚未下载并校验完成。')
    }
    const installerPath = join(this.options.storageDirectory, basename(this.manifest.path))
    if (!await this.restoreMatchingInstaller(this.manifest)) throw new Error('更新包已损坏，请重新下载。')
    if (this.options.launchInstaller === undefined) throw new Error('当前平台无法启动更新安装程序。')
    await this.options.launchInstaller(installerPath)
  }
}
