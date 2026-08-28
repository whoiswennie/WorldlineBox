import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntimeProcess } from '../src/runtime-process.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

describe('desktop runtime process', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it('starts the shared Web profile without opening a second browser window', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(child as never)

    const runtime = startRuntimeProcess({
      cwd: 'C:\\workspace',
      cliEntry: 'C:\\worldline\\cli.mjs',
    })
    child.stdout.emit('data', Buffer.from('worldline web: http://127.0.0.1:43123\n'))

    await expect(runtime.ready).resolves.toBe('http://127.0.0.1:43123')
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        '--expose-internals',
        'C:\\worldline\\cli.mjs',
        'web',
        '--port',
        '0',
        '--no-open',
      ],
      expect.objectContaining({
        cwd: 'C:\\workspace',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
  })
})
