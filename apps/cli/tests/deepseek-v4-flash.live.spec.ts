import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const worldlineHome = process.env.WORLDLINE_HOME ?? join(homedir(), '.worldline')
let temporaryRoot: string | undefined

afterEach(async () => {
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

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

describe('saved DeepSeek-V4-Flash CLI chain', () => {
  it('uses the preserved account configuration, streams an answer, and records its trajectory', async () => {
    await access(join(worldlineHome, 'settings.yaml'))
    await access(join(worldlineHome, '.credentials.yaml'))

    temporaryRoot = await mkdtemp(join(tmpdir(), 'worldline-live-cli-'))
    const sessionsRoot = join(temporaryRoot, 'sessions')
    const patchPath = join(temporaryRoot, 'plaintext-sessions.patch.yml')
    await writeFile(patchPath, [
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: ${JSON.stringify(sessionsRoot.replaceAll('\\', '/'))}`,
      '    compression: none',
      '    packChunks: true',
      '',
    ].join('\n'), 'utf8')

    const prompt = '只回复：WORLDLINE_LIVE_OK'
    const result = await execFileAsync(process.execPath, [
      resolve('apps/cli/lib/bin.js'),
      '--profile',
      'headless',
      '--patch',
      patchPath,
      prompt,
    ], {
      cwd: resolve('.'),
      env: { ...process.env, WORLDLINE_HOME: worldlineHome },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })

    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('WORLDLINE_LIVE_OK')

    const trajectory = await readTree(sessionsRoot)
    expect(trajectory).toContain('assistant/message')
    expect(trajectory).toContain('session/title')
    expect(trajectory).toContain('deepseek-v4-flash')
    expect(trajectory).toContain('WORLDLINE_LIVE_OK')
  }, 120_000)
})
