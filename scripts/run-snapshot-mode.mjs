import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const [mode, ...rawForwarded] = process.argv.slice(2)
if (mode !== 'record' && mode !== 'refresh') {
  throw new Error('usage: node scripts/run-snapshot-mode.mjs <record|refresh> [...vitest args]')
}

const forwarded = [...rawForwarded]
const configIndex = forwarded.indexOf('--config-file')
const config = configIndex < 0
  ? 'vitest.snapshot.config.ts'
  : forwarded.splice(configIndex, 2)[1]
if (config === undefined || config.length === 0) {
  throw new Error('run-snapshot-mode: --config-file requires a path')
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const args = [vitest, 'run', '--config', config]
if (mode === 'record') args.push('--update')
args.push(...forwarded)

const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: { ...process.env, WORLDLINE_SNAPSHOT: mode },
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
