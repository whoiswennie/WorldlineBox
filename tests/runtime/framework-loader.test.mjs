import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

test('a real YAML loader update rolls back when a candidate plugin fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worldline-loader-'))
  const configPath = join(directory, 'cordis.yml')
  const modulePath = join(directory, 'fixture-plugin.mjs')
  const stateKey = `worldline.loader.fixture.${process.pid}.${Date.now()}`
  globalThis[stateKey] = { active: null, mounts: [], disposals: [] }

  await writeFile(modulePath, [
    `const state = globalThis[${JSON.stringify(stateKey)}]`,
    'export default function apply(_ctx, config) {',
    '  state.mounts.push(config.value)',
    '  state.active = config.value',
    '  _ctx.effect(() => () => {',
    '      state.disposals.push(config.value)',
    '      if (state.active === config.value) state.active = null',
    '    })',
    '}',
    '',
  ].join('\n'))
  await writeFile(configPath, [
    '- id: fixture',
    '  name: ./fixture-plugin.mjs',
    '  config:',
    '    value: stable',
    '',
  ].join('\n'))

  const root = new Context()
  root.baseUrl = pathToFileURL(`${directory}/`).href
  let include
  class CapturedInclude extends Include {
    constructor(ctx, config) {
      super(ctx, config)
      include = this
    }
  }

  try {
    const loaderFiber = root.plugin(Loader, { baseUrl: root.baseUrl })
    await loaderFiber.await()
    const includeFiber = root.plugin(CapturedInclude, { path: './cordis.yml' })
    await includeFiber.await()
    assert.equal(globalThis[stateKey].active, 'stable')
    assert.equal(include.store.fixture.fiber._disposables.length, 1)

    await writeFile(configPath, [
      '- id: fixture',
      '  name: ./fixture-plugin.mjs',
      '  config:',
      '    value: candidate',
      '- id: broken',
      '  name: ./missing-plugin.mjs',
      '',
    ].join('\n'))
    await assert.rejects(() => include.refresh())
    assert.equal(globalThis[stateKey].active, 'stable')

    await includeFiber.dispose()
    assert.equal(globalThis[stateKey].active, null, JSON.stringify(globalThis[stateKey]))
    await loaderFiber.dispose()
  } finally {
    await root.fiber.dispose()
    delete globalThis[stateKey]
    await rm(directory, { recursive: true, force: true })
  }
})
