import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bin = resolve(root, 'dist/runtime/lib/bin.js')
const companionMemes = resolve(
  root,
  'dist/runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/worldline-experience/companion-memes',
)
const sourceCompanionMemes = resolve(
  root,
  'apps/web/public/worldline-experience/companion-memes',
)

function assetStats(directory) {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = assetStats(path)
      files += nested.files
      bytes += nested.bytes
    } else if (entry.isFile()) {
      files += 1
      bytes += statSync(path).size
    }
  }
  return { files, bytes }
}

const expectedMemes = assetStats(sourceCompanionMemes)
const packagedMemes = assetStats(companionMemes)
if (packagedMemes.files !== expectedMemes.files || packagedMemes.bytes !== expectedMemes.bytes) {
  throw new Error(
    `deployed companion memes are incomplete: expected ${expectedMemes.files} files / `
      + `${expectedMemes.bytes} bytes, received ${packagedMemes.files} files / ${packagedMemes.bytes} bytes`,
  )
}
const defaultStartupTimeoutMs = process.platform === 'win32' ? 180_000 : 60_000
const configuredStartupTimeoutMs = process.env.WORLDLINE_DEPLOYED_RUNTIME_START_TIMEOUT_MS
const startupTimeoutMs = configuredStartupTimeoutMs === undefined
  ? defaultStartupTimeoutMs
  : Number(configuredStartupTimeoutMs)
if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
  throw new Error('WORLDLINE_DEPLOYED_RUNTIME_START_TIMEOUT_MS must be a positive integer')
}
const cwd = mkdtempSync(resolve(tmpdir(), 'worldline-deployed-'))
let output = ''
const child = spawn(process.execPath, [bin, 'web', '--port', '0', '--no-open'], {
  cwd,
  env: {
    ...process.env,
    WORLDLINE_HOME: resolve(cwd, '.worldline'),
    WORLDLINE_AGENTS_HOME: resolve(cwd, '.agents'),
    DEEPSEEK_API_KEY: 'keyless-deployed-runtime-check',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

function readyUrl() {
  return new Promise((resolveReady, reject) => {
    const progress = startupTimeoutMs > 30_000
      ? setTimeout(() => {
          console.warn(
            `worldline deployed runtime: still waiting for Web startup `
              + `(pid ${child.pid ?? 'unknown'}, timeout ${startupTimeoutMs}ms)`,
          )
        }, 30_000)
      : undefined
    const timeout = setTimeout(
      () => reject(new Error(
        `deployed Web profile did not start within ${startupTimeoutMs}ms\n`
          + `pid: ${child.pid ?? 'unknown'}\n`
          + `node: ${process.execPath}\n`
          + `entry: ${bin}\n`
          + `output:\n${output || '<no stdout or stderr; process remained alive>'}`,
      )),
      startupTimeoutMs,
    )
    const clearTimers = () => {
      clearTimeout(timeout)
      if (progress !== undefined) clearTimeout(progress)
    }
    const inspect = (chunk) => {
      output += chunk.toString()
      const url = /worldline web: (http:\/\/[^\s]+)/.exec(output)?.[1]
      if (url !== undefined) {
        clearTimers()
        resolveReady(url)
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', error => {
      clearTimers()
      reject(new Error(`deployed Web profile could not be spawned: ${error.message}`))
    })
    child.once('exit', code => {
      clearTimers()
      reject(new Error(`deployed Web profile exited with ${String(code)}:\n${output}`))
    })
  })
}

async function stop() {
  if (child.exitCode !== null) return
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child.kill()
  }
  await exited
}

async function removeTemporaryDirectory() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(cwd, { recursive: true, force: true })
      return
    } catch (error) {
      const retryable = process.platform === 'win32'
        && (error?.code === 'EPERM' || error?.code === 'EBUSY')
      if (!retryable || attempt >= 39) throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
}

try {
  const url = await readyUrl()
  const html = await (await fetch(url)).text()
  if (!html.includes('__WORLDLINE_BOOT__')) throw new Error('deployed frontend boot payload is absent')
  const meme = await fetch(new URL(
    '/worldline-experience/companion-memes/yachiyo-runami/001.gif',
    url,
  ))
  if (!meme.ok || (await meme.arrayBuffer()).byteLength === 0) {
    throw new Error(`deployed companion meme route failed with ${String(meme.status)}`)
  }
  console.log(`worldline deployed runtime: ok (${url})`)
} finally {
  await stop()
  // Windows can release executable/module handles a moment after the child
  // exit notification. Let fs.rm apply its bounded EPERM/EBUSY retry policy
  // so a successful runtime probe is not reported as a packaging failure.
  await removeTemporaryDirectory()
}
