import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('root update manifest generator', () => {
  it('writes latest.yml for the prescribed 0.1.0 release asset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldline-manifest-'))
    temporaryDirectories.push(directory)
    const installer = join(directory, 'WorldlineBox-Setup-0.1.0.exe')
    const output = join(directory, 'latest.yml')
    const payload = Buffer.from('worldline-box-installer')
    await writeFile(installer, payload)

    const result = spawnSync(process.execPath, [
      resolve(root, 'scripts/generate-update-manifest.mjs'),
      '--installer', installer,
      '--output', output,
      '--version', '0.1.0',
    ], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)

    const manifest = loadYaml(await readFile(output, 'utf8')) as {
      version: string
      files: Array<{ url: string; sha512: string; size: number }>
      path: string
      sha512: string
      releaseNotes: string
    }
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.path).toBe('WorldlineBox-Setup-0.1.0.exe')
    expect(manifest.files[0]).toEqual({
      url: 'https://github.com/whoiswennie/WorldlineBox/releases/download/v0.1.0/WorldlineBox-Setup-0.1.0.exe',
      sha512: createHash('sha512').update(payload).digest('base64'),
      size: payload.byteLength,
    })
    expect(manifest.sha512).toBe(manifest.files[0]?.sha512)
    expect(manifest.releaseNotes).toContain('WorldlineBox 0.1.0')
  })
})
