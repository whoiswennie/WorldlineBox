import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

interface WatchControl {
  readonly emitter: EventEmitter
  readonly options: Record<string, unknown>
  readonly close: PromiseWithResolvers<undefined>
  closeCalls: number
}

const harness = vi.hoisted(() => ({ controls: [] as WatchControl[] }))

vi.mock('chokidar', () => ({
  watch(_path: string, options: Record<string, unknown>) {
    const emitter = new EventEmitter() as EventEmitter & { close(): Promise<void> }
    const close = Promise.withResolvers<undefined>()
    const control: WatchControl = { emitter, options, close, closeCalls: 0 }
    emitter.close = () => {
      control.closeCalls += 1
      return close.promise
    }
    harness.controls.push(control)
    return emitter
  },
}))

const { default: LocalWorkspaceTree } = await import('../src/index.ts')

const roots: string[] = []

afterEach(async () => {
  for (const control of harness.controls.splice(0)) control.close.resolve(undefined)
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('LocalWorkspaceTree watcher lifecycle', () => {
  it('uses a persistent Windows-safe watcher and joins its Cordis disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-tree-watch-'))
    roots.push(root)
    const ctx = new Context()
    const fiber = ctx.plugin(LocalWorkspaceTree)
    await fiber.await()

    await ctx.workspaceTree.list(root, root)
    const control = harness.controls[0]
    if (control === undefined) throw new Error('expected a workspace watcher')
    expect(control.options.persistent).toBe(true)

    // The public error channel stays contained by the plugin.
    expect(() => { control.emitter.emit('error', Object.assign(new Error('watch denied'), { code: 'EPERM' })) }).not.toThrow()

    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(control.closeCalls).toBe(1)
    expect(disposed).toBe(false)

    control.close.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
  })
})
