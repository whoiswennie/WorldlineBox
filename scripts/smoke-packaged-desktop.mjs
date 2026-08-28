import { spawn, spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const appDirectory = resolve(process.argv[2] ?? 'release/desktop/win-unpacked')
const desktopPackage = JSON.parse(await readFile(resolve(import.meta.dirname, '../apps/desktop/package.json'), 'utf8'))
const productName = desktopPackage.build?.productName
if (typeof productName !== 'string' || productName.length === 0) {
  throw new Error('apps/desktop/package.json must declare build.productName')
}
const executable = process.platform === 'win32'
  ? resolve(appDirectory, `${productName}.exe`)
  : process.platform === 'darwin'
    ? resolve(appDirectory, `${productName}.app/Contents/MacOS/${productName}`)
    : resolve(appDirectory, productName)

await access(executable)

if (process.platform === 'win32') {
  const packagedPty = resolve(appDirectory, 'resources/runtime/node_modules/node-pty')
  const ptyPrebuild = resolve(packagedPty, 'prebuilds/win32-x64/conpty.node')
  const packagedNode = resolve(appDirectory, 'resources/runtime/node_modules/node/bin/node.exe')
  await access(ptyPrebuild)
  await access(packagedNode)
  const probe = [
    `const pty = require(${JSON.stringify(packagedPty)});`,
    'let output = "";',
    'const child = pty.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "echo worldline-pty-smoke"], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });',
    'const timer = setTimeout(() => { child.kill(); process.exit(2); }, 10000);',
    'child.onData(data => { output += data; });',
    'child.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode === 0 && output.includes("worldline-pty-smoke") ? 0 : 1); });',
  ].join('')
  const result = spawnSync(packagedNode, ['-e', probe], {
    cwd: appDirectory,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  if (result.status !== 0 || result.error !== undefined) {
    throw result.error ?? new Error(`Packaged node-pty probe failed with status ${String(result.status)}: ${result.stderr}`)
  }
}

async function runProbe(args, marker, timeoutMilliseconds) {
  const child = spawn(executable, args, {
    cwd: appDirectory,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })

  const terminateTree = () => {
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill('SIGKILL')
    }
  }

  await new Promise((resolveProbe, rejectProbe) => {
    const timeout = setTimeout(() => {
      terminateTree()
      rejectProbe(new Error(`Packaged desktop smoke timed out: ${executable}\n${stdout}${stderr}`))
    }, timeoutMilliseconds)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectProbe(new Error(`Unable to start ${basename(executable)}: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0 || signal !== null || !stdout.includes(marker)) {
        rejectProbe(new Error([
          `Packaged desktop smoke failed (code=${String(code)}, signal=${String(signal)}).`,
          stdout,
          stderr,
        ].filter(Boolean).join('\n')))
        return
      }
      process.stdout.write(stdout)
      resolveProbe()
    })
  })
}

// This first probe exercises the exact early window used when the custom installer
// launches the installed application. The second probe verifies the full
// packaged runtime, native browser bridge, and renderer path.
await runProbe(
  ['--desktop-startup-smoke-test', '--noerrdialogs'],
  'worldline desktop startup smoke:',
  30_000,
)
await runProbe(
  ['--desktop-smoke-test', '--noerrdialogs'],
  'worldline desktop smoke:',
  90_000,
)
