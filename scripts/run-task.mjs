import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
const tsdown = resolve(root, 'node_modules/tsdown/dist/run.mjs')
const vite = resolve(root, 'apps/web/node_modules/vite/bin/vite.js')
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const electron = resolve(root, 'node_modules/electron/cli.js')
const cleanTypeOrphans = resolve(root, 'scripts/clean-type-orphans.mjs')

function run(label, entrypoint, args = [], cwd = root, env = process.env) {
  console.log(`\n[worldline-task] ${label}`)
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function buildDesktop() {
  run('build:desktop:types', tsc, ['-b', 'apps/desktop'])
  run('build:desktop:main', tsdown, ['-c', 'apps/desktop/tsdown.main.ts'])
}

const task = process.argv[2]

switch (task) {
  case 'build-types-host':
    run('clean:type-orphans', cleanTypeOrphans)
    run('build:types:host', tsc, ['-b', 'tsconfig.host.json'])
    break
  case 'build-types-client':
    run('clean:type-orphans', cleanTypeOrphans)
    run('build:types:client', tsc, ['-b', 'tsconfig.client.json'])
    break
  case 'build-desktop':
    buildDesktop()
    break
  case 'dev':
    run('build:web', vite, ['build'], resolve(root, 'apps/web'))
    run('build:cli', tsc, ['-b', 'apps/cli'])
    buildDesktop()
    run('electron', electron, ['.'])
    break
  case 'test-cli':
    run('build:cli', tsc, ['-b', 'apps/cli'])
    run('test:cli', vitest, ['run', '--config', 'vitest.runtime.config.ts', 'apps/cli/tests'])
    break
  case 'test-cli-live':
    run('build:cli', tsc, ['-b', 'apps/cli'])
    run('test:cli:live', vitest, ['run', '--config', 'vitest.live.config.ts'])
    break
  case 'test-desktop':
    buildDesktop()
    run('test:desktop', electron, ['apps/desktop/lib/main.mjs', '--desktop-smoke-test'])
    break
  default:
    console.error(`Unknown Worldline task: ${String(task)}`)
    process.exit(1)
}
