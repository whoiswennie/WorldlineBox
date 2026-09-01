import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SimulationPurpose } from '@deepseek-ai/dsh-worldline-standard'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorldlineCompiler from '../src/index.ts'

const roots: string[] = []

async function start(): Promise<{ ctx: Context; root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-compiler-'))
  roots.push(root)
  const ctx = new Context()
  const projects = ctx.plugin(LocalWorldlineProjects, {
    root,
    maxEntries: 5000,
    maxSearchFiles: 50_000,
  })
  await projects.await()
  const compiler = ctx.plugin(WorldlineCompiler)
  await compiler.await()
  return {
    ctx,
    root,
    dispose: async () => {
      await compiler.dispose()
      await projects.dispose()
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const purpose: SimulationPurpose = {
  summary: 'Run one day of an autonomous village.',
  scope: ['characters', 'space', 'actions'],
  duration: 86_400,
  resolution: 60,
  detail: 'L2',
  hardExpectations: ['A legal action can commit without violating safety.'],
  statisticalExpectations: [],
  antiPatterns: ['instant ordinary movement'],
}

const mechanismSource = `# Executable core

\
\`\`\`worldline-map
{
  "id": "map:village01",
  "name": "Village",
  "rootNodeId": "map-node:village01",
  "layers": [{ "id": "ground", "name": "Ground", "visible": true, "locked": false, "order": 0 }],
  "nodes": [{
    "id": "map-node:village01", "layerId": "ground", "kind": "world", "name": "Village",
    "position": { "x": 0, "y": 0 }, "permissions": [], "hazards": [], "entryNodeIds": []
  }],
  "edges": []
}
\`\`\`

\`\`\`worldline-action
{
  "id": "world.wait", "description": "Wait while time passes", "actorTypes": ["character"],
  "duration": 60, "maxWait": 300, "retryBudget": 2,
  "effects": [{ "op": "increment", "path": "state.elapsed", "amount": 60 }]
}
\`\`\`

\`\`\`worldline-system
{
  "id": "world.clock", "description": "Advance the world clock", "interval": 60,
  "effects": [{ "op": "increment", "path": "world.time", "amount": 60 }]
}
\`\`\`

\`\`\`worldline-invariant
{
  "id": "world.time.nonnegative", "description": "Time never becomes negative",
  "expression": { "op": "gte", "path": "world.time", "value": 0 }
}
\`\`\`
`

describe('WorldlineCompiler', () => {
  it('surfaces closure questions instead of inventing missing runtime mechanics', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Questions', template: 'blank' })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(false)
    expect(preview.questions.map(item => item.id)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^question:/u),
    ]))
    expect(preview.certificate.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'actions', status: 'blocking' }),
      expect.objectContaining({ category: 'space', status: 'blocking' }),
    ]))
    await expect(runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ code: 'closure-blocked' })
    await runtime.dispose()
  })

  it('compiles source-anchored mechanisms and freezes a content-addressed immutable Blueprint', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Runnable', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview).toMatchObject({
      canFreeze: true,
      sourceCoverage: 1,
      executableCounts: { maps: 1, actions: 1, systems: 1, invariants: 1 },
    })
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(frozen.blueprint.actions[0]?.provenance[0]?.anchors[0]?.documentId).toMatch(/^doc:/u)
    const active = await readFile(join(project.path, '.worldline', 'builds', 'active'), 'utf8')
    expect(active.trim()).toBe(frozen.blueprint.digest)
    const stored = JSON.parse(await readFile(join(
      project.path,
      '.worldline',
      'builds',
      frozen.blueprint.digest,
      'blueprint.json',
    ), 'utf8')) as { digest: string }
    expect(stored.digest).toBe(frozen.blueprint.digest)
    await runtime.dispose()
  })

  it('rejects freeze when any source changed after preview', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Race', template: 'blank' })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id })
    const charter = await runtime.ctx.worldlineProjects.read({
      projectId: project.manifest.id,
      path: 'canon/charter.md',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: charter.path,
      content: `${charter.content}\nA later edit.`,
      expectedRevision: charter.revision,
    })
    await expect(runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      expectedSourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ code: 'source-changed' })
    await runtime.dispose()
  })

  it('persists reviewable proposals with optimistic state revisions', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Review', template: 'blank' })
    const state = await runtime.ctx.worldlineCompiler.submitProposal({
      projectId: project.manifest.id,
      target: 'action',
      title: 'Add a bounded rest action',
      rationale: 'Characters need deterministic recovery.',
      risk: 'medium',
      payload: {
        id: 'character.rest', description: 'Rest', duration: 3600, maxWait: 600,
        effects: [{ op: 'increment', path: 'state.energy', amount: 1 }],
      },
      anchors: [],
    })
    const proposal = state.proposals[0]!
    if (state.revision === undefined) throw new Error('proposal state has no persisted revision')
    const reviewed = await runtime.ctx.worldlineCompiler.reviewProposal({
      projectId: project.manifest.id,
      proposalId: proposal.id,
      decision: 'approved',
      reviewedBy: 'test-author',
      expectedStateRevision: state.revision,
    })
    expect(reviewed.proposals[0]).toMatchObject({ status: 'approved', reviewedBy: 'test-author' })
    await expect(runtime.ctx.worldlineCompiler.reviewProposal({
      projectId: project.manifest.id,
      proposalId: proposal.id,
      decision: 'rejected',
      reviewedBy: 'stale-author',
      expectedStateRevision: state.revision,
    })).rejects.toMatchObject({ code: 'state-conflict' })
    await runtime.dispose()
  })
})
