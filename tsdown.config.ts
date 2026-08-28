import { defineConfig } from 'tsdown'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function buildable(project: string): boolean {
  return existsSync(join(project, 'tsdown.config.ts'))
    || ['index.js', 'invariant.js', 'startup.js'].some(file =>
      existsSync(join(project, 'lib', 'types', file)))
}

function directWorkspace(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(parent, entry.name))
    .filter(project => existsSync(join(project, 'package.json')) && buildable(project))
    .map(project => project.replaceAll('\\', '/'))
}

function hostWorkspace(): string[] {
  const packages = readdirSync('packages', { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => directWorkspace(join('packages', entry.name)))
  return [...directWorkspace('vendor'), ...packages, 'apps/cli']
}

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.WORLDLINE_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.WORLDLINE_BUILD_FACE)
  return {
    // Use explicit projects rather than tsdown's workspace globs: Worldline
    // carries private owned packages and tsdown 0.22.14 otherwise also tries
    // to build the repository root with the package entry glob.
    workspace: hostWorkspace(),
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
