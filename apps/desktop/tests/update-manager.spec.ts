import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  DesktopUpdateManager,
  parseUpdateManifest,
} from '../src/update-manager.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function manifest(version: string, payload: Uint8Array, sha512 = createHash('sha512').update(payload).digest('base64')): string {
  const fileName = `WorldlineBox-Setup-${version}.exe`
  return [
    `version: "${version}"`,
    'files:',
    `  - url: "https://github.com/whoiswennie/WorldlineBox/releases/download/v${version}/${fileName}"`,
    `    sha512: "${sha512}"`,
    `    size: ${String(payload.byteLength)}`,
    `path: "${fileName}"`,
    `sha512: "${sha512}"`,
    'releaseDate: "2026-08-28T12:00:00.000Z"',
    'releaseNotes: |-',
    `  WorldlineBox ${version}`,
    '  - 更新测试',
    '',
  ].join('\n')
}

async function storage(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'worldline-update-'))
  temporaryDirectories.push(value)
  return value
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('Worldline desktop updater', () => {
  it('keeps 0.1.0 current and compares later stable versions strictly', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1)
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(-1)
  })

  it('rejects non-Worldline assets and inconsistent hashes', () => {
    const payload = Uint8Array.from([1, 2, 3])
    expect(() => parseUpdateManifest(manifest('0.2.0', payload).replace(
      'https://github.com/whoiswennie/WorldlineBox/releases/download/',
      'https://example.com/',
    ))).toThrow(/GitHub Release/u)
    expect(() => parseUpdateManifest(manifest('0.2.0', payload).replace(
      /sha512: "[^"]+"/u,
      `sha512: "${Buffer.alloc(64).toString('base64')}"`,
    ))).toThrow(/摘要字段不一致/u)
  })

  it('reports the prescribed 0.1.0 manifest as current without downloading', async () => {
    const payload = Uint8Array.from([1, 2, 3])
    const fetchMock = vi.fn(async () => new Response(manifest('0.1.0', payload)))
    const updates = new DesktopUpdateManager({
      currentVersion: '0.1.0', storageDirectory: await storage(), enabled: true, fetch: fetchMock,
    })

    await expect(updates.check()).resolves.toMatchObject({ phase: 'current', latestVersion: '0.1.0' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('downloads with progress, persists verification, and reuses the complete installer', async () => {
    const payload = new TextEncoder().encode('worldline installer payload')
    const source = manifest('0.2.0', payload)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      return url.endsWith('latest.yml')
        ? new Response(source, { status: 200 })
        : new Response(payload, { status: 200 })
    }) as typeof fetch
    const directory = await storage()
    let now = 0
    const published: string[] = []
    const first = new DesktopUpdateManager({
      currentVersion: '0.1.0',
      storageDirectory: directory,
      enabled: true,
      manifestUrl: 'https://raw.githubusercontent.com/whoiswennie/WorldlineBox/main/latest.yml',
      fetch: fetchMock,
      now: () => { now += 150; return now },
      publish: (snapshot) => { published.push(snapshot.phase) },
    })

    await expect(first.check()).resolves.toMatchObject({ phase: 'available', latestVersion: '0.2.0' })
    await expect(first.download()).resolves.toMatchObject({ phase: 'ready', percent: 100 })
    expect(published).toContain('downloading')
    expect(await readFile(join(directory, 'WorldlineBox-Setup-0.2.0.exe'))).toEqual(Buffer.from(payload))

    const offlineFetch = vi.fn(async () => { throw new Error('offline') }) as typeof fetch
    const second = new DesktopUpdateManager({
      currentVersion: '0.1.0', storageDirectory: directory, enabled: true, fetch: offlineFetch,
    })
    await expect(second.initialize()).resolves.toMatchObject({
      phase: 'ready', latestVersion: '0.2.0', percent: 100,
    })
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('launches only a verified ready installer', async () => {
    const payload = new TextEncoder().encode('installer')
    const source = manifest('0.2.0', payload)
    const fetchMock = vi.fn(async (input: string | URL | Request) => requestUrl(input).endsWith('latest.yml')
      ? new Response(source)
      : new Response(payload)) as typeof fetch
    const launchInstaller = vi.fn(async () => {})
    const updates = new DesktopUpdateManager({
      currentVersion: '0.1.0', storageDirectory: await storage(), enabled: true,
      manifestUrl: 'https://raw.githubusercontent.com/whoiswennie/WorldlineBox/main/latest.yml',
      fetch: fetchMock, launchInstaller,
    })
    await updates.check()
    await updates.download()
    await updates.install()
    expect(launchInstaller).toHaveBeenCalledWith(expect.stringMatching(/WorldlineBox-Setup-0\.2\.0\.exe$/u))
  })
})
