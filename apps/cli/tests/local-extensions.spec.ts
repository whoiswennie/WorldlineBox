import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import {
  LOCAL_EXTENSIONS_FILENAME,
  localExtensionPatches,
  normalizeLocalExtensionState,
  readLocalExtensionState,
} from '../src/profile-boot.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local extension state', () => {
  it('normalizes ids and lets removal outrank disablement', () => {
    expect(normalizeLocalExtensionState({
      disabledPlugins: ['feature-a', 'feature-a', 'removed-one', '../unsafe'],
      removedPlugins: ['removed-one', 'removed-one'],
      disabledSkills: ['my-skill', 'my-skill', 'Not Valid'],
    })).toEqual({
      disabledPlugins: ['feature-a'],
      removedPlugins: ['removed-one'],
      disabledSkills: ['my-skill'],
    })
  })

  it('reads the local file and composes durable disable and delete patches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldline-local-extensions-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, LOCAL_EXTENSIONS_FILENAME), JSON.stringify({
      disabledPlugins: ['optional-a'],
      removedPlugins: ['optional-b'],
      disabledSkills: [],
    }))

    const state = readLocalExtensionState(directory)
    const result = applyEntryPatches([
      { id: 'core', name: '@deepseek-ai/dsh-core' },
      { id: 'optional-a', name: 'community-a' },
      { id: 'optional-b', name: 'community-b' },
    ], localExtensionPatches(state), () => {})

    expect(result).toEqual([
      { id: 'core', name: '@deepseek-ai/dsh-core' },
      { id: 'optional-a', name: 'community-a', disabled: true },
    ])
  })
})
