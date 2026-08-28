import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORLDLINE_HOME_DISPLAY,
  WORLDLINE_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultWorldlineHome,
  worldlineHomeDisplay,
  worldlineHomePath,
  expandHomePath,
  resolveWorldlineHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('worldline path helpers', () => {
  it('owns the shared default Worldline home directory name', () => {
    expect(WORLDLINE_HOME_DIR_NAME).toBe('.worldline')
    expect(DEFAULT_WORLDLINE_HOME_DISPLAY).toBe('~/.worldline')
    expect(defaultWorldlineHome()).toBe(join(homedir(), '.worldline'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.worldline')).toBe(join(homedir(), '.worldline'))
    expect(expandHomePath('~\\.worldline')).toBe(join(homedir(), '.worldline'))
    expect(expandHomePath('/tmp/.worldline')).toBe('/tmp/.worldline')
    expect(expandHomePath('~other/.worldline')).toBe('~other/.worldline')
  })

  it('resolves explicit path before WORLDLINE_HOME and the default', () => {
    const envHome = join(homedir(), 'env-worldline')

    expect(resolveWorldlineHome('/tmp/explicit-worldline', { WORLDLINE_HOME: '~/env-worldline' })).toBe(resolve('/tmp/explicit-worldline'))
    expect(resolveWorldlineHome(undefined, { WORLDLINE_HOME: '~/env-worldline' })).toBe(envHome)
    expect(resolveWorldlineHome(undefined, {})).toBe(defaultWorldlineHome())
  })

  it('treats an empty or whitespace-only WORLDLINE_HOME as unset', () => {
    expect(resolveWorldlineHome(undefined, { WORLDLINE_HOME: '' })).toBe(defaultWorldlineHome())
    expect(resolveWorldlineHome(undefined, { WORLDLINE_HOME: '   ' })).toBe(defaultWorldlineHome())
  })

  it('joins child segments onto the resolved WORLDLINE_HOME', () => {
    vi.stubEnv('WORLDLINE_HOME', '~/env-worldline')
    expect(worldlineHomePath()).toBe(join(homedir(), 'env-worldline'))
    expect(worldlineHomePath('storages', 'cache')).toBe(join(homedir(), 'env-worldline', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(worldlineHomeDisplay(resolve(defaultWorldlineHome()))).toBe('~/.worldline')
    expect(worldlineHomeDisplay('/some/other/root')).toBe('$WORLDLINE_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
