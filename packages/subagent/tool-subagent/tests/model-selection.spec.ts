import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from '../src/model-selection.ts'
import SubagentModelSelectionConfig, {
  SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
} from '../src/model-selection-settings.ts'
import {
  recordSubagentModelSelection,
  subagentModelSelectionPolicy,
} from '../src/model-selection-state.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('subagent model selection', () => {
  it('rejects malformed and duplicate route policy entries', () => {
    expect(() => { assertAllowedModelRoutes({ provider: 'p', model: 'm' }) })
      .toThrow('requires an array of routes')
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'm' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => {
      assertAllowedModelRoutes([
        { provider: 'p', model: 'm' },
        { provider: 'p', model: 'm' },
      ])
    }).toThrow('repeats route "p/m"')
  })

  it('requires provider/model pairs and clears a stale effort after route changes', () => {
    const parent = {
      provider: 'parent',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
    }
    const configured = {
      provider: 'alpha',
      model: 'old-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 321,
    }
    expect(() => requestedAgentOptions(parent, configured, { provider: 'alpha' }, true))
      .toThrow('must be supplied together')
    expect(() => requestedAgentOptions(parent, configured, {
      provider: 'alpha',
      model: 'new-model',
    }, false)).toThrow('disabled')
    expect(requestedAgentOptions(parent, configured, {
      provider: 'alpha',
      model: 'new-model',
    }, true)).toEqual({
      provider: 'alpha',
      model: 'new-model',
      maxTokens: 321,
    })
    expect(requestedAgentOptions(parent, configured, {
      reasoning_effort: 'low',
    }, true)).toEqual({
      provider: 'alpha',
      model: 'old-model',
      reasoningEffort: 'low',
      maxTokens: 321,
    })
  })

  it('authorizes only explicit selections inside the session policy', () => {
    const policy = { routes: [{ provider: 'alpha', model: 'allowed' }] }
    const parent = { provider: 'alpha', model: 'parent-default' }
    expect(() =>{  assertAllowedModelSelection(policy, parent, undefined, {}) }).not.toThrow()
    expect(() =>{  assertAllowedModelSelection(
      policy,
      parent,
      { provider: 'alpha', model: 'allowed' },
      { provider: 'alpha', model: 'allowed' },
    ) }).not.toThrow()
    expect(() =>{  assertAllowedModelSelection(
      policy,
      parent,
      { provider: 'alpha', model: 'blocked' },
      { provider: 'alpha', model: 'blocked' },
    ) }).toThrow('not allowed for this Session')
  })

  it('preflights the exact route and does not carry effort across a route change', async () => {
    const resolveCallConfig = vi.fn(async (config: unknown) => config)
    const llm = { resolveCallConfig } as unknown as LlmRuntime
    await preflightChildLlmRoute(
      llm,
      {
        provider: 'parent',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      { provider: 'child', model: 'child-model' },
      new AbortController().signal,
    )
    expect(resolveCallConfig).toHaveBeenCalledWith({
      provider: 'child',
      model: 'child-model',
    }, expect.any(AbortSignal))
  })

  it('stores one detached durable policy per session', () => {
    const session = Session.create(SessionId('selection-state'))
    const routes = [{ provider: 'alpha', model: 'fast' }]
    recordSubagentModelSelection(session, routes)
    routes[0]!.model = 'mutated-after-record'
    expect(subagentModelSelectionPolicy(session)).toEqual([
      { provider: 'alpha', model: 'fast' },
    ])
    recordSubagentModelSelection(session, [{ provider: 'beta', model: 'other' }])
    expect(session.events.filter(event => event.type === 'subagent/model-selection-policy')).toHaveLength(1)
  })

  it('defaults off and validates settings updates before adopting them', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentModelSelectionConfig)
    expect(ctx.subagentModelSelection.current()).toEqual({ enabled: false, allowedModels: [] })
    await expect(ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: [],
    })).rejects.toThrow('requires at least one allowed model')
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: [{ provider: 'alpha', model: 'fast' }],
    })
    expect(ctx.subagentModelSelection.current()).toEqual({
      enabled: true,
      allowedModels: [{ provider: 'alpha', model: 'fast' }],
    })
    await ctx.fiber.dispose()
  })
})
