/** Bounded, domain-separated model tools over `ctx.agentVaults`. */

import type { Context } from '@deepseek-ai/cordis'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { AgentVaultError } from '@deepseek-ai/dsh-agent-vault'
import type { MemoryStage, SelfModule, VaultUri } from '@deepseek-ai/dsh-agent-vault'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-agent-vault'
export const inject = ['agentVaults', 'tools', 'systemPrompt']

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const array = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').slice(0, 32) : []
const integer = (value: unknown, fallback: number): number => Number.isSafeInteger(value) ? Number(value) : fallback
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const encode = (value: unknown): string => JSON.stringify(value)

const sharedUri = (uri: VaultUri): VaultUri => uri.startsWith('vault://')
  ? `shared://${uri.slice('vault://'.length)}` : uri

async function combinedRecall(ctx: Context, input: Parameters<Context['agentVaults']['recall']>[0]) {
  const [own, shared] = await Promise.all([
    ctx.agentVaults.recall(input),
    input.agentId === 'public'
      ? Promise.resolve(undefined)
      : ctx.agentVaults.recall({ ...input, agentId: 'public' }).catch(() => undefined),
  ])
  const cards = [...own.cards, ...(shared?.cards ?? []).map(card => ({ ...card, uri: sharedUri(card.uri) }))]
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, input.budget?.maxResults ?? 5)
  return { cards, elapsedMs: Math.max(own.elapsedMs, shared?.elapsedMs ?? 0),
    indexRevision: Math.max(own.indexRevision, shared?.indexRevision ?? 0) }
}

function runtimeAgentId(exec: { readonly agent?: { readonly id: unknown } }): string {
  if (exec.agent === undefined) throw new AgentVaultError('Agent Vault tools require an Agent execution.', 'VAULT_NOT_FOUND')
  return String(exec.agent.id)
}

function authorizedAgentId(ctx: Context, runtimeAgentId: string): string {
  const agentId = ctx.agentVaults.resolveRuntimeAgent(runtimeAgentId)
  if (agentId === undefined) throw new AgentVaultError('This runtime Agent has no authorized private Vault.', 'VAULT_NOT_FOUND')
  return agentId
}

function writeContext(runtimeAgentId: string, reason: string, expectedRevision?: string) {
  return { actor: { type: 'agent' as const, id: runtimeAgentId }, reason,
    ...(expectedRevision === undefined ? {} : { expectedRevision }) }
}

/** Register the Vault orientation, recall, exploration, memory, self, procedure, and resource tools. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:agent-vault', order: FIRST_PARTY_SECTION_ORDER.TOOL_AGENT_VAULT, text:
    'Your private Agent Vault is accessed only through the dedicated tools. Start with bounded recall; follow useful vault:// results progressively. memory tools never inspect self, procedure recall never certifies a new capability, and self changes require self_update plus Host policy. Never persist resolved host paths.' })

  ctx.tools.register(defineTool({
    name: 'memory_recall', description: 'Quickly retrieve at most five directional cards from your declarative memory without reading self or full documents.',
    parameters: { query: { type: 'string', required: true }, tags: { type: 'array', items: { type: 'string' } },
      stage: { type: 'string', enum: ['short', 'medium', 'long'] } }, output: OUTPUT, isConcurrencySafe: () => true,
    execute: async (args, exec) => encode(await combinedRecall(ctx, { agentId: authorizedAgentId(ctx, runtimeAgentId(exec)),
      domain: 'memory', query: text(args.query), tags: array(args.tags),
      ...(args.stage === 'short' || args.stage === 'medium' || args.stage === 'long' ? { stage: args.stage } : {}),
      budget: { maxResults: 5, maxChars: 4_000, maxMillis: 80 } })),
  }))

  ctx.tools.register(defineTool({
    name: 'procedure_recall', description: 'Find saved capabilities, methods, and experience cards by task terms, aliases, and tags; results do not imply current tool availability.',
    parameters: { query: { type: 'string', required: true }, tags: { type: 'array', items: { type: 'string' } } }, output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => encode(await combinedRecall(ctx, { agentId: authorizedAgentId(ctx, runtimeAgentId(exec)),
      domain: 'procedure', query: text(args.query), tags: array(args.tags), budget: { maxResults: 5, maxChars: 4_000, maxMillis: 80 } })),
  }))

  ctx.tools.register(defineTool({
    name: 'resource_find', description: 'Find enabled expression, appearance, source, or attachment resources in your Vault without loading binary content.',
    parameters: { query: { type: 'string', required: true }, tags: { type: 'array', items: { type: 'string' } },
      roles: { type: 'array', items: { type: 'string', enum: ['expression', 'appearance', 'source', 'attachment'] } } }, output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const agentId = authorizedAgentId(ctx, runtimeAgentId(exec)); const query = text(args.query)
      const roles = array(args.roles) as Array<'expression' | 'appearance' | 'source' | 'attachment'>
      const options = { query, tags: array(args.tags), limit: 12 }
      const search = async (scope: string) => {
        if (roles.length === 0) return await ctx.agentVaults.searchResources({ agentId: scope, ...options })
        const pages = await Promise.all(roles.map(role => ctx.agentVaults.searchResources({
          agentId: scope, ...options, roles: [role],
        })))
        return {
          items: [...new Map(pages.flatMap(page => page.items)
            .map(item => [`${item.agentId}:${item.id}`, item])).values()],
          nextCursor: -1,
        }
      }
      const [own, shared] = await Promise.all([
        search(agentId),
        agentId === 'public'
          ? Promise.resolve({ items: [], nextCursor: -1 })
          : search('public').catch(() => ({ items: [], nextCursor: -1 })),
      ])
      return encode({ items: [...own.items, ...shared.items].slice(0, 12), nextCursor: -1 })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_inspect', description: 'Inspect your structured enabled and disabled self modules, including identity, appearance, persona, state, relationships, and capability boundaries.',
    parameters: {}, output: OUTPUT, isConcurrencySafe: () => true,
    execute: async (_args, exec) => encode(await ctx.agentVaults.inspectSelf(authorizedAgentId(ctx, runtimeAgentId(exec)))),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_read', description: 'Progressively read one exact vault:// Markdown result using top, section, grep, or full view.',
    parameters: { uri: { type: 'string', required: true }, view: { type: 'string', enum: ['top', 'section', 'grep', 'full'] }, selector: { type: 'string' } },
    output: OUTPUT, isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const raw = text(args.uri); const shared = raw.startsWith('shared://')
      const uri = (shared ? `vault://${raw.slice('shared://'.length)}` : raw) as VaultUri
      return encode(await ctx.agentVaults.read(shared ? 'public' : authorizedAgentId(ctx, runtimeAgentId(exec)), uri,
        args.view === 'section' || args.view === 'grep' || args.view === 'full' ? args.view : 'top', text(args.selector)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_explore', description: 'Follow a bounded Wiki neighborhood from previously recalled vault:// origins.',
    parameters: { origins: { type: 'array', required: true, items: { type: 'string' } }, max_pages: { type: 'integer' }, max_chars: { type: 'integer' } },
    output: OUTPUT, isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const origins = array(args.origins); const maxPages = Math.min(12, Math.max(1, integer(args.max_pages, 6)))
      const maxChars = Math.min(32_000, Math.max(1_000, integer(args.max_chars, 16_000)))
      const ownOrigins = origins.filter((uri): uri is VaultUri => uri.startsWith('vault://'))
      const sharedOrigins = origins.filter(uri => uri.startsWith('shared://'))
        .map((uri): VaultUri => `vault://${uri.slice('shared://'.length)}`)
      const [own, shared] = await Promise.all([
        ctx.agentVaults.explore(authorizedAgentId(ctx, runtimeAgentId(exec)), ownOrigins, maxPages, maxChars),
        sharedOrigins.length === 0 ? Promise.resolve([]) : ctx.agentVaults.explore('public', sharedOrigins, maxPages, maxChars),
      ])
      return encode([...own, ...shared.map(doc => ({ ...doc, uri: sharedUri(doc.uri) }))].slice(0, maxPages))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_resolve_path',
    description: 'Resolve one exact memory or procedure vault:// URI to a temporary Host path only when a non-Vault tool genuinely requires it. A write result includes a lease that must be reconciled; never save the Host path in Vault content.',
    parameters: { uri: { type: 'string', required: true }, mode: { type: 'string', required: true,
      enum: ['read', 'write'] }, reason: { type: 'string', required: true } }, output: OUTPUT,
    execute: async (args, exec) => {
      const uri = text(args.uri) as VaultUri
      if (!uri.startsWith('vault://memory/') && !uri.startsWith('vault://procedures/')) {
        throw new AgentVaultError('Physical path leases are limited to memory and procedure documents.', 'DOMAIN_VIOLATION')
      }
      const runtimeId = runtimeAgentId(exec); const agentId = authorizedAgentId(ctx, runtimeId)
      const mode = args.mode === 'write' ? 'write' : 'read'
      return encode(await ctx.agentVaults.resolvePath(agentId, uri, mode,
        mode === 'write' ? writeContext(runtimeId, text(args.reason).slice(0, 500)) : undefined))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_reconcile',
    description: 'Close a vault_resolve_path write lease and immediately reconcile the externally edited Markdown file into the derived index.',
    parameters: { lease_id: { type: 'string', required: true } }, output: OUTPUT,
    execute: async (args, exec) => encode(await ctx.agentVaults.reconcile(
      authorizedAgentId(ctx, runtimeAgentId(exec)), text(args.lease_id))),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_remember', description: 'Immediately save one bounded user-requested fact, preference, commitment, or event into short-term memory so the next turn can recall it.',
    parameters: { title: { type: 'string', required: true }, content: { type: 'string', required: true },
      tags: { type: 'array', items: { type: 'string' } }, aliases: { type: 'array', items: { type: 'string' } },
      sources: { type: 'array', items: { type: 'string' } }, importance: { type: 'integer' } }, output: OUTPUT,
    execute: async (args, exec) => {
      const runtimeId = runtimeAgentId(exec); const agentId = authorizedAgentId(ctx, runtimeId)
      return encode(await ctx.agentVaults.captureMemory({ agentId, title: text(args.title).slice(0, 200),
        content: text(args.content).slice(0, 64_000), tags: array(args.tags), aliases: array(args.aliases), sources: array(args.sources),
        importance: Math.min(5, Math.max(1, integer(args.importance, 3))) as 1 | 2 | 3 | 4 | 5 },
      writeContext(runtimeId, 'Agent saved a user-requested memory.')))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_update', description: 'Create or revision-update one memory or procedure Markdown document. This tool refuses self and resource paths.',
    parameters: { uri: { type: 'string', required: true }, content: { type: 'string', required: true }, expected_revision: { type: 'string' }, reason: { type: 'string', required: true } }, output: OUTPUT,
    execute: async (args, exec) => {
      const uri = text(args.uri) as VaultUri
      if (!uri.startsWith('vault://memory/') && !uri.startsWith('vault://procedures/')) {
        throw new AgentVaultError('vault_update accepts only memory and procedures paths.', 'DOMAIN_VIOLATION')
      }
      const runtimeId = runtimeAgentId(exec)
      return encode(await ctx.agentVaults.write(authorizedAgentId(ctx, runtimeId), uri, text(args.content).slice(0, 1_000_000),
        writeContext(runtimeId, text(args.reason).slice(0, 500), text(args.expected_revision) || undefined)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_update', description: 'Propose or apply one explicit structured self-module update. Host policy, stability, user locks, and revision are authoritative.',
    parameters: { module: { type: 'object', required: true, additionalProperties: false, properties: {
      id: { type: 'string', required: true }, title: { type: 'string', required: true }, enabled: { type: 'boolean', required: true },
      autonomous: { type: 'boolean', required: true }, locked: { type: 'boolean', required: true },
      stability: { type: 'string', required: true, enum: ['core', 'stable', 'dynamic'] }, summary: { type: 'string', required: true },
      details: { type: 'array', required: true, items: { type: 'string' } }, revision: { type: 'string', required: true }, updatedAt: { type: 'number', required: true },
    } }, reason: { type: 'string', required: true } }, output: OUTPUT,
    execute: async (args, exec) => {
      const runtimeId = runtimeAgentId(exec); const module = args.module as unknown as SelfModule
      return encode(await ctx.agentVaults.updateSelf(authorizedAgentId(ctx, runtimeId), module,
        writeContext(runtimeId, text(args.reason).slice(0, 500), module.revision)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_consolidate', description: 'Queue and execute one bounded, checkpointed memory-stage consolidation batch. Never processes the complete backlog in one call.',
    parameters: { source: { type: 'string', required: true, enum: ['short', 'medium'] },
      target: { type: 'string', required: true, enum: ['medium', 'long'] }, batch_size: { type: 'integer' } }, output: OUTPUT,
    execute: async (args, exec) => {
      const runtimeId = runtimeAgentId(exec); const agentId = authorizedAgentId(ctx, runtimeId)
      const source = text(args.source) as MemoryStage; const target = text(args.target) as MemoryStage
      const job = await ctx.agentVaults.queueConsolidation(agentId, source, target,
        writeContext(runtimeId, 'Agent initiated bounded memory consolidation.'))
      return encode(await ctx.agentVaults.runConsolidation(job.id, Math.min(200, Math.max(1, integer(args.batch_size, 50)))))
    },
  }))
}
