/**
 * Registry tests for `@deepseek-ai/dsh-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: CallId('bash-env-call'),
    rootCallId: CallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : { agent: { session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as Agent }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { worldlineHome: './test-worldline-home' })

    expect(registry.collect(execution())).toEqual({
      WORLDLINE_HOME: resolve('./test-worldline-home'),
      WORLDLINE_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      WORLDLINE_HOME: resolve('./test-worldline-home'),
      WORLDLINE_SESSION_ID: 'session-a',
      WORLDLINE_SHELL: '1',
    })
  })

  it('resolves WORLDLINE_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('WORLDLINE_HOME', './ambient-worldline-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).WORLDLINE_HOME).toBe(resolve('./ambient-worldline-home'))

    vi.stubEnv('WORLDLINE_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).WORLDLINE_HOME).toBe(join(homedir(), '.worldline'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { worldlineHome: './test-worldline-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        WORLDLINE_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { WORLDLINE_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        WORLDLINE_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ WORLDLINE_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('WORLDLINE_SESSION_OPTIONAL')
    expect(registry.collect(execution()).WORLDLINE_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).WORLDLINE_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'WORLDLINE_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'WORLDLINE_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { worldlineHome: './test-worldline-home' })
    registry.register({
      name: 'first',
      variables: { WORLDLINE_SHARED: { description: 'First owner.' } },
      resolve: () => ({ WORLDLINE_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { WORLDLINE_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ WORLDLINE_SHARED: 'second' }),
    })).toThrow(/WORLDLINE_SHARED.*first.*second|WORLDLINE_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { worldlineHome: './test-worldline-home' })
    registry.register({
      name: 'declared',
      variables: { WORLDLINE_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { WORLDLINE_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { WORLDLINE_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { worldline_invalid: { description: 'Invalid key.' } } as unknown as Record<'WORLDLINE_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { WORLDLINE_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { WORLDLINE_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { worldlineHome: './test-worldline-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { WORLDLINE_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ WORLDLINE_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*WORLDLINE_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { worldlineHome: './test-worldline-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { WORLDLINE_STRING: { description: 'String fact.' } },
      resolve: () => ({ WORLDLINE_STRING: 42 }) as unknown as Record<'WORLDLINE_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*WORLDLINE_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { worldlineHome: './test-worldline-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { WORLDLINE_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ WORLDLINE_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).WORLDLINE_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('WORLDLINE_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { worldlineHome: './test-worldline-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { WORLDLINE_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ WORLDLINE_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).WORLDLINE_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('WORLDLINE_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service and the persistence contributor on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([
      {
        contributor: 'session-persistence',
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
        key: 'WORLDLINE_SESSION_JSONL',
      },
    ])
  })

  it('the persistence contributor resolves WORLDLINE_SESSION_JSONL only for a jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p')).WORLDLINE_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
  })

  it('the persistence contributor omits the variable for a non-jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'sqlite' as const, path: 'C:\\sessions\\s.db' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('WORLDLINE_SESSION_JSONL')
  })

  it('the persistence contributor omits the variable without a persistence backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('WORLDLINE_SESSION_JSONL')
  })
})
