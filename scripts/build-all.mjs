import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
const tsdown = resolve(root, 'node_modules/tsdown/dist/run.mjs')
const vite = resolve(root, 'apps/web/node_modules/vite/bin/vite.js')
const cleanTypeOrphans = resolve(root, 'scripts/clean-type-orphans.mjs')

const stages = [
  ['clean:type-orphans', cleanTypeOrphans, [], root],
  ['build:types:host', tsc, ['-b', 'tsconfig.host.json'], root],
  ['build:plugins:host', tsdown, ['--env.WORLDLINE_BUILD_FACE', 'host'], root],
  ['build:types:client', tsc, ['-b', 'tsconfig.client.json'], root],
  ['build:plugins:client', tsdown, ['--env.WORLDLINE_BUILD_FACE', 'client'], root],
  ['build:web', vite, ['build'], resolve(root, 'apps/web')],
  ['build:cli', tsc, ['-b', 'apps/cli'], root],
  ['build:desktop:types', tsc, ['-b', 'apps/desktop'], root],
  [
    'build:desktop:main',
    tsdown,
    ['-c', 'apps/desktop/tsdown.main.ts'],
    root,
  ],
]

for (const [stage, entrypoint, args, cwd] of stages) {
  console.log(`\n[worldline-build] ${stage}`)
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
