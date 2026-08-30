import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
} from '@agentclientprotocol/sdk'

/**
 * Source-path Loader smoke through the package's own bin, covering the
 * automation server's initialize and fresh-session path across the
 * `unwrapExports` shape implicated by the loader-export regression. Session creation reaches
 * the factory but not the model, so a dummy key is sufficient.
 */

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Repo root is four levels up from packages/examples/acp-demo/tests.
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// A minimal opt-in leaf that loads this app + the two backends and the optional
// session-query consumer/policies, inlined so the package test owns its fixture.
const CORDIS_YML = `
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    persona: 'You are a test agent.'
    workspaceContext: false
- id: tool-session-query
  name: '@deepseek-ai/dsh-tool-session-query'
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'
- id: spill-local
  name: '@deepseek-ai/dsh-spill-local'
- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
`

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientContext
  stderr: string[]
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned !== undefined) {
    const child = spawned.child
    child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => child.once('exit', () => { resolve() }))
    }
    spawned = undefined
  }
  if (workdir !== undefined) {
    await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  workdir = undefined
})

async function boot(): Promise<Spawned & { cwd: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'acp-agent-pkg-'))
  const cwd = workdir
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, CORDIS_YML)
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(tsxLoader).href, binScript, '--config', configPath],
    {
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: repoTsconfig,
        // Key-present check only; no prompt is sent, so the model is never called.
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'keyless-acp-agent-smoke',
        WORLDLINE_HOME: join(cwd, '.worldline'),
        WORLDLINE_AGENTS_HOME: join(cwd, '.agents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const client = createAcpClientApp({ name: 'worldline-acp-demo-source-test' })
    .onNotification(methods.client.session.update, () => Promise.resolve())
    .onRequest(methods.client.session.requestPermission, () => (
      Promise.resolve({ outcome: { outcome: 'cancelled' as const } })
    ))
    .connect(stream)
    .agent
  spawned = { child, client, stderr }
  return { ...spawned, cwd }
}

describe('worldline-acp-demo real-load-path smoke (bin + Loader, keyless)', () => {
  it('boots via its bin and exposes only fresh text sessions', async () => {
    const { client, cwd, stderr } = await boot()
    // initialize: a broken export shape (collapsed bridge plugin, dropped inject)
    // crashes the tree on the first service read here — see the loader-export regression.
    let init
    try {
      init = await client.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })
    } catch (error: unknown) {
      throw new Error(`ACP source-path process closed during initialize:\n${stderr.join('')}`, {
        cause: error,
      })
    }
    expect(init.agentCapabilities).toEqual({
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: true },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    })

    // session/new reaches the agent FACTORY (create) without the model.
    const { sessionId } = await client.request(methods.agent.session.new, { cwd, mcpServers: [] })
    expect(sessionId).toBeTruthy()

    expect(stderr.join('')).not.toContain('without inject')
  }, 30_000)
})
