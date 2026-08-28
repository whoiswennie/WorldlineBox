import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPackageGraph } from './package-graph.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageJson(root: string, group: string, leaf: string, manifest: object): void {
  const directory = join(root, 'packages', group, leaf)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

describe('workspace package graph', () => {
  it('orders workspace peers while ignoring same-scope vendor packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'worldline-package-graph-'))
    roots.push(root)
    packageJson(root, 'core', 'base', {
      name: '@deepseek-ai/dsh-base',
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    })
    packageJson(root, 'feature', 'consumer', {
      name: '@deepseek-ai/dsh-consumer',
      peerDependencies: { '@deepseek-ai/dsh-base': 'workspace:^', '@deepseek-ai/schemastery': 'workspace:^' },
    })

    expect(collectPackageGraph(root, ['core', 'feature'], 'test').map(node => node.short))
      .toEqual(['base', 'consumer'])
  })
})
