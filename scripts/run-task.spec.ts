import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('development task artifact order', () => {
  it('emits fresh types before each plugin face and then builds the shells', async () => {
    const source = await readFile(new URL('./run-task.mjs', import.meta.url), 'utf8')
    const dev = source.slice(source.indexOf("case 'dev':"), source.indexOf("case 'test-cli':"))

    const clean = dev.indexOf("run('clean:type-orphans'")
    const hostTypes = dev.indexOf("run('build:types:host'")
    const host = dev.indexOf("run('build:plugins:host'")
    const clientTypes = dev.indexOf("run('build:types:client'")
    const client = dev.indexOf("run('build:plugins:client'")
    const web = dev.indexOf("run('build:web'")
    const desktop = dev.indexOf('buildDesktop()')

    expect(clean).toBeGreaterThanOrEqual(0)
    expect(hostTypes).toBeGreaterThan(clean)
    expect(host).toBeGreaterThan(hostTypes)
    expect(clientTypes).toBeGreaterThan(host)
    expect(client).toBeGreaterThan(clientTypes)
    expect(web).toBeGreaterThan(client)
    expect(desktop).toBeGreaterThan(web)
  })
})
