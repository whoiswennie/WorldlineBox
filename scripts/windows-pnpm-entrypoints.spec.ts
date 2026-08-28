import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Windows pnpm entry points', () => {
  it('pins a workspace-local pnpm and disables recursive pre-script installs', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      packageManager?: string
      devDependencies?: Record<string, string>
    }

    expect(packageJson.packageManager).toBe('pnpm@11.7.0')
    expect(packageJson.devDependencies?.pnpm).toBe('11.7.0')
    expect(read('pnpm-workspace.yaml')).toContain('verifyDepsBeforeRun: false')
  })

  it.each(['start-electron.bat', 'deploy.bat', 'build-exe.bat'])(
    '%s exposes the workspace-local pnpm shim',
    (launcher) => {
      expect(read(launcher)).toContain('node_modules\\.bin')
    },
  )

  it('synchronizes dependencies before the desktop build', () => {
    expect(read('start-electron.bat')).toContain('call :pnpm install --frozen-lockfile')
  })

  it('runs the pre-push typecheck without a global pnpm command', () => {
    expect(read('lefthook.yml')).toContain('run: node_modules/.bin/pnpm run typecheck')
  })
})
