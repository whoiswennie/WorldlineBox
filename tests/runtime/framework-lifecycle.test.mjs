import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'

class ProbeService extends Service {
  constructor(ctx) {
    super(ctx, 'probe')
  }
}

test('a consumer waits for its required service and unloads with the provider', async () => {
  const root = new Context()
  const events = []
  let releaseCleanup

  const consumer = Object.assign((ctx) => {
    events.push('activate')
    return async () => {
      events.push('cleanup:start')
      await new Promise(resolve => { releaseCleanup = resolve })
      events.push('cleanup:end')
    }
  }, { inject: ['probe'] })

  const consumerFiber = root.plugin(consumer)
  await consumerFiber.await()
  assert.deepEqual(events, [])

  const providerFiber = root.plugin(ProbeService)
  await providerFiber.await()
  await consumerFiber.await()
  assert.deepEqual(events, ['activate'])

  const disposing = providerFiber.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['activate', 'cleanup:start'])
  releaseCleanup()
  await disposing
  await consumerFiber.await()
  assert.deepEqual(events, ['activate', 'cleanup:start', 'cleanup:end'])

  await consumerFiber.dispose()
  await root.fiber.dispose()
})
test('startup failure rolls back effects owned by the failed fiber', async () => {
  const root = new Context()
  const events = []
  const failing = (ctx) => {
    ctx.effect(() => {
      events.push('effect:start')
      return () => events.push('effect:dispose')
    })
    throw new Error('fixture startup failure')
  }

  const fiber = root.plugin(failing)
  await assert.rejects(() => fiber.await(), /fixture startup failure/)
  assert.deepEqual(events, ['effect:start', 'effect:dispose'])
  await fiber.dispose()
  await root.fiber.dispose()
})

test('fiber disposal does not resolve before asynchronous cleanup is quiescent', async () => {
  const root = new Context()
  let cleanupFinished = false
  const fiber = root.plugin(() => async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    cleanupFinished = true
  })
  await fiber.await()
  await fiber.dispose()
  assert.equal(cleanupFinished, true)
  await root.fiber.dispose()
})
