import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '../src/index.ts'

describe('local real terminal', () => {
  it('runs an interactive shell through the platform PTY, accepts input, and resizes', async () => {
    const runtime = new LocalSubprocessRuntime(new Context())
    const windows = process.platform === 'win32'
    const terminal = await runtime.spawnTerminal({
      argv: windows
        ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/q']
        : ['/bin/bash', '--noprofile', '--norc'],
      cwd: process.cwd(),
      env: { TERM: 'xterm-256color' },
      rows: 24,
      cols: 80,
      graceMs: 1_000,
    })
    let output = ''
    const marker = `WORLDLINE_PTY_OK_${String(Date.now())}`
    const received = Promise.withResolvers<undefined>()
    terminal.output.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes(marker)) received.resolve(undefined)
    })

    await terminal.resize?.(120, 36)
    await terminal.write(windows
      ? `echo ${marker}\r`
      : `printf '%s\\n' '${marker}'\n`)
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        received.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`PTY output timed out: ${JSON.stringify(output)}`))
          }, 8_000)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    expect(output).toContain(marker)

    await terminal.write(windows ? 'exit\r' : 'exit\n')
    await terminal.done
    await terminal.terminate()
  }, 12_000)
})
