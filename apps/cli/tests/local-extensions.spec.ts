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
      disabledPlugins: ['feature-a', 'feature-a', 'include:gal-view', 'removed-one', '../unsafe'],
      removedPlugins: ['removed-one', 'removed-one', 'include:agent-presets:tool-goal'],
      disabledSkills: ['my-skill', 'my-skill', 'Not Valid'],
    })).toEqual({
      disabledPlugins: ['feature-a', 'include:gal-view'],
      removedPlugins: ['include:agent-presets:tool-goal', 'removed-one'],
      disabledSkills: ['my-skill'],
    })
  })

  it('reads the local file and composes durable disable and delete patches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldline-local-extensions-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, LOCAL_EXTENSIONS_FILENAME), JSON.stringify({
      disabledPlugins: ['optional-a', 'include:gal-view'],
      removedPlugins: ['optional-b', 'include:agent-presets:tool-goal'],
      disabledSkills: [],
    }))

    const state = readLocalExtensionState(directory)
    const result = applyEntryPatches([
      { id: 'core', name: '@deepseek-ai/dsh-core' },
      { id: 'optional-a', name: 'community-a' },
      { id: 'optional-b', name: 'community-b' },
      { id: 'gal-view', name: 'gal-view' },
      {
        id: 'agent-presets', name: 'cordis:group', group: true,
        config: [{ id: 'tool-goal', name: 'nested-tool-goal' }],
      },
      { id: 'tool-goal', name: 'top-level-tool-goal' },
    ], localExtensionPatches(state), () => {})

    expect(result).toEqual([
      { id: 'core', name: '@deepseek-ai/dsh-core' },
      { id: 'optional-a', name: 'community-a', disabled: true },
      { id: 'gal-view', name: 'gal-view', disabled: true },
      { id: 'agent-presets', name: 'cordis:group', group: true, config: [] },
      { id: 'tool-goal', name: 'top-level-tool-goal' },
    ])
  })

  it('applies local overrides to rows inserted by Profile Bundles', () => {
    const result = applyEntryPatches([], [
      {
        insert: [
          { id: 'gal-view', name: 'gal-view' },
          { id: 'community-widget', name: 'community-widget' },
          {
            id: 'community-tools', name: 'cordis:group', group: true,
            config: [],
          },
        ],
      },
      {
        id: 'community-tools',
        insert: [{ id: 'nested-view', name: 'nested-view' }],
      },
      ...localExtensionPatches({
        disabledPlugins: ['include:community-widget'],
        removedPlugins: ['include:gal-view', 'include:community-tools:nested-view'],
        disabledSkills: [],
      }),
    ], () => {})

    expect(result).toEqual([
      { id: 'community-widget', name: 'community-widget', disabled: true },
      {
        id: 'community-tools', name: 'cordis:group', group: true,
        config: [],
      },
    ])
  })
})
