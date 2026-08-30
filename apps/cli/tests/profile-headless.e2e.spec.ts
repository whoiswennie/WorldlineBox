import { execFile } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
let server: Server | undefined
let home: string | undefined

afterEach(async () => {
  if (server !== undefined) await new Promise<void>(done => server!.close(() =>{  done() }))
  server = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function mockProvider(): Promise<{ url: string; requests: unknown[]; headers: IncomingHttpHeaders[] }> {
  const requests: unknown[] = []
  const headers: IncomingHttpHeaders[] = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":"inspect"}}]}',
        '{"choices":[{"delta":{"content":"verified"}}]}',
        '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        '[DONE]',
      ]) response.write(`data: ${event}\n\n`)
      response.end()
    })
  })
  server.requestTimeout = 30_000
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server has no TCP address')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

async function readTree(root: string): Promise<string> {
  const chunks: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else chunks.push(await readFile(path, 'utf8'))
    }
  }
  await visit(root)
  return chunks.join('\n')
}

describe('profile-driven headless CLI', () => {
  it('boots the shared Cordis bundle, runs the Agent, persists the log, and exits', async () => {
    const mock = await mockProvider()
    home = await mkdtemp(join(tmpdir(), 'worldline-profile-cli-'))
    await writeFile(join(home, 'settings.yaml'), `llm-deepseek:\n  baseURL: ${mock.url}\n`, 'utf8')
    await writeFile(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: test-secret\n', { mode: 0o600 })
    const patchPath = join(home, 'plaintext-sessions.patch.yml')
    await writeFile(patchPath, [
      '- id: session-persistence-jsonl',
      '  config:',
      "    root: !!js worldlineHomePath('sessions')",
      '    compression: none',
      '    packChunks: true',
      '',
    ].join('\n'), 'utf8')

    const result = await execFileAsync(process.execPath, [
      resolve('apps/cli/lib/bin.js'),
      '--profile',
      'headless',
      '--patch',
      patchPath,
      'prove the profile chain',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, WORLDLINE_HOME: home },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })

    expect(result.stderr).toBe('worldline: reasoning:\ninspect\n')
    expect(result.stdout).toBe('verified\n')
    expect(mock.requests).toHaveLength(2)
    expect(mock.headers.every(header => header.authorization === 'Bearer test-secret')).toBe(true)
    expect(mock.requests.some(request => JSON.stringify(request).includes('prove the profile chain'))).toBe(true)
    expect(mock.requests.every(request => JSON.stringify(request).includes('deepseek-v4-flash'))).toBe(true)

    const persisted = await readTree(join(home, 'sessions'))
    expect(persisted).toContain('assistant/message')
    expect(persisted).toContain('session/title')
    expect(persisted).toContain('deepseek-v4-flash')
  })
})
