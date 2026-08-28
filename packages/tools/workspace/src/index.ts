import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'tool-workspace'
export const inject = ['tools', 'systemPrompt']

/** Workspace tool roots and result-size bounds. */
export interface Config {
  /** Default workspace root when a session does not provide one. */
  cwd?: string
  /** Maximum bytes returned by a file read. */
  maxReadBytes?: number
  /** Maximum bytes retained from command or search output. */
  maxOutputBytes?: number
  /** Maximum matches returned by one workspace search. */
  maxSearchResults?: number
}

interface ResolvedConfig {
  cwd: string
  maxReadBytes: number
  maxOutputBytes: number
  maxSearchResults: number
}

const textOutput = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: import('@deepseek-ai/dsh-session').JsonValue) => [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`)
  return resolved
}

function workspaceRoot(config: ResolvedConfig, exec: ToolRunContext): string {
  return resolve(exec.agent?.session.header.cwd ?? config.cwd)
}

function workspacePath(root: string, input: string): string {
  if (!input.trim()) throw new Error('path must be a non-empty string')
  const candidate = resolve(root, input)
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`path escapes the workspace root: ${input}`)
  }
  return candidate
}

function relativePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/') || '.'
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let start = Math.max(0, text.length - maxBytes)
  while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > maxBytes) start += 1
  return { text: text.slice(start), truncated: true }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function globRegex(pattern: string): RegExp {
  const source = pattern.replaceAll('\\', '/')
  let output = '^'
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === undefined) break
    if (character === '*' && source[index + 1] === '*') {
      index += 1
      if (source[index + 1] === '/') {
        index += 1
        output += '(?:.*/)?'
      } else {
        output += '.*'
      }
    } else if (character === '*') {
      output += '[^/]*'
    } else if (character === '?') {
      output += '[^/]'
    } else {
      output += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`${output}$`, process.platform === 'win32' ? 'i' : '')
}

async function listFiles(root: string, signal: AbortSignal, cap: number): Promise<string[]> {
  const files: string[] = []
  const pending = [root]
  while (pending.length && files.length < cap) {
    if (signal.aborted) throw signal.reason ?? new Error('operation cancelled')
    const directory = pending.pop()
    if (directory === undefined) break
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
      if (files.length >= cap) break
    }
  }
  return files
}

async function runPowerShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, maxOutputBytes: number) {
  if (!command.trim()) throw new Error('command must be a non-empty string')
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  return new Promise<import('@deepseek-ai/dsh-session').JsonValue>((resolvePromise, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const abort = () => child.kill()
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (exitCode, closeSignal) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      const output = truncate(stdout, maxOutputBytes)
      const errorOutput = truncate(stderr, maxOutputBytes)
      resolvePromise({
        exitCode,
        signal: closeSignal,
        timedOut,
        aborted: signal.aborted,
        stdout: output,
        stderr: errorOutput,
      })
    })
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    cwd: resolve(config.cwd ?? process.cwd()),
    maxReadBytes: positiveInteger(config.maxReadBytes, 256 * 1024, 'maxReadBytes'),
    maxOutputBytes: positiveInteger(config.maxOutputBytes, 128 * 1024, 'maxOutputBytes'),
    maxSearchResults: positiveInteger(config.maxSearchResults, 500, 'maxSearchResults'),
  }

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file from the current workspace. Use offset and limit for large files.',
    parameters: {
      path: { type: 'string', required: true },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = workspaceRoot(resolved, exec)
      const path = workspacePath(root, args.path)
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`not a file: ${args.path}`)
      if (info.size > resolved.maxReadBytes * 8) throw new Error(`file is too large to read safely: ${args.path}`)
      const source = await readFile(path, 'utf8')
      const lines = source.split(/\r?\n/)
      const offset = Math.max(1, args.offset ?? 1)
      const limit = Math.min(2000, Math.max(1, args.limit ?? 500))
      const selected = lines.slice(offset - 1, offset - 1 + limit).join('\n')
      const clipped = truncate(selected, resolved.maxReadBytes)
      return {
        path: relativePath(root, path),
        text: clipped.text,
        startLine: offset,
        endLine: Math.min(lines.length, offset - 1 + limit),
        totalLines: lines.length,
        truncated: clipped.truncated || offset - 1 + limit < lines.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Create or replace a UTF-8 text file inside the current workspace.',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: textOutput,
    async execute(args, exec) {
      const root = workspaceRoot(resolved, exec)
      const path = workspacePath(root, args.path)
      await atomicWrite(path, args.content)
      return { path: relativePath(root, path), bytes: Buffer.byteLength(args.content, 'utf8') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Replace an exact text fragment in one workspace file. By default the fragment must occur exactly once.',
    parameters: {
      path: { type: 'string', required: true },
      old_string: { type: 'string', required: true },
      new_string: { type: 'string', required: true },
      replace_all: { type: 'boolean' },
    },
    output: textOutput,
    async execute(args, exec) {
      if (!args.old_string) throw new Error('old_string must be non-empty')
      const root = workspaceRoot(resolved, exec)
      const path = workspacePath(root, args.path)
      const source = await readFile(path, 'utf8')
      const occurrences = source.split(args.old_string).length - 1
      if (occurrences === 0) throw new Error('old_string was not found')
      if (occurrences > 1 && args.replace_all !== true) throw new Error(`old_string occurs ${occurrences} times; set replace_all or provide more context`)
      const content = args.replace_all === true
        ? source.replaceAll(args.old_string, args.new_string)
        : source.replace(args.old_string, args.new_string)
      await atomicWrite(path, content)
      return { path: relativePath(root, path), replacements: args.replace_all === true ? occurrences : 1 }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'glob',
    description: 'List workspace files matching a glob pattern. Examples: **/*.ts, src/**, README.md.',
    parameters: {
      pattern: { type: 'string', required: true },
      path: { type: 'string' },
      max_results: { type: 'integer' },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = workspaceRoot(resolved, exec)
      const searchRoot = workspacePath(root, args.path ?? '.')
      const cap = Math.min(resolved.maxSearchResults, Math.max(1, args.max_results ?? resolved.maxSearchResults))
      const matcher = globRegex(args.pattern)
      const files = await listFiles(searchRoot, exec.signal, cap * 10)
      const matches = files
        .map(path => relativePath(root, path))
        .filter(path => matcher.test(relativePath(searchRoot, workspacePath(root, path))))
        .slice(0, cap)
      return { matches, truncated: matches.length === cap }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Search UTF-8 workspace files with a regular expression and return matching path, line, and text.',
    parameters: {
      pattern: { type: 'string', required: true },
      path: { type: 'string' },
      glob: { type: 'string' },
      max_results: { type: 'integer' },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = workspaceRoot(resolved, exec)
      const searchRoot = workspacePath(root, args.path ?? '.')
      const cap = Math.min(resolved.maxSearchResults, Math.max(1, args.max_results ?? resolved.maxSearchResults))
      const matcher = args.glob ? globRegex(args.glob) : undefined
      const expression = new RegExp(args.pattern, 'i')
      const files = await listFiles(searchRoot, exec.signal, cap * 20)
      const matches: import('@deepseek-ai/dsh-session').JsonValue[] = []
      for (const file of files) {
        if (matcher && !matcher.test(relativePath(searchRoot, file))) continue
        if (exec.signal.aborted) throw exec.signal.reason ?? new Error('operation cancelled')
        const info = await stat(file)
        if (info.size > resolved.maxReadBytes) continue
        const lines = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (line === undefined || !expression.test(line)) continue
          matches.push({ path: relativePath(root, file), line: index + 1, text: line.slice(0, 1000) })
          if (matches.length >= cap) return { matches, truncated: true }
        }
      }
      return { matches, truncated: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pwsh',
    description: 'Execute one PowerShell command in the current workspace and return exit status, stdout, and stderr. Each call uses a fresh process.',
    parameters: {
      command: { type: 'string', required: true },
      workdir: { type: 'string' },
      timeout_ms: { type: 'integer' },
    },
    output: textOutput,
    async execute(args, exec) {
      const root = workspaceRoot(resolved, exec)
      const cwd = workspacePath(root, args.workdir ?? '.')
      const timeoutMs = Math.min(10 * 60_000, Math.max(100, args.timeout_ms ?? 120_000))
      return runPowerShell(args.command, cwd, timeoutMs, exec.signal, resolved.maxOutputBytes)
    },
  }))
}
