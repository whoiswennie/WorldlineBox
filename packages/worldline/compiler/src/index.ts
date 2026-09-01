import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectSourceSnapshot } from '@deepseek-ai/dsh-worldline-project/types'
import type {} from '@deepseek-ai/dsh-worldline-project'
import { WWS_VERSION, stableStringify, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import type {
  Blueprint,
  ProjectId,
  Provenance,
  Revision,
} from '@deepseek-ai/dsh-worldline-standard/types'
import { compileSnapshot, type CompilationProduct } from './compile.ts'
import type {
  AnswerQuestionRequest,
  BuildPreview,
  CompileWorldRequest,
  CompilerProposal,
  CompilerState,
  ExplainSemanticsRequest,
  FreezeWorldRequest,
  FrozenBuild,
  ReviewProposalRequest,
  SemanticsExplanation,
  SubmitProposalRequest,
} from './types.ts'
import { WorldlineCompilerError } from './types.ts'

export * from './types.ts'
export { compileSnapshot } from './compile.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineCompiler: WorldlineCompiler }
}

interface StoredState {
  readonly questions: CompilerState['questions']
  readonly proposals: CompilerState['proposals']
}

function now(): string { return new Date().toISOString() }

function canFreeze(product: CompilationProduct): boolean {
  return !product.diagnostics.some(item => item.severity === 'blocking')
    && !product.certificate.results.some(item => item.status === 'blocking')
    && !product.questions.some(item => item.status === 'open' && item.impact === 'high')
    && !product.proposals.some(item => item.status === 'pending' && item.risk === 'high')
}

function previewOf(product: CompilationProduct): BuildPreview {
  const executable = product.maps.length + product.actions.length + product.systems.length
    + product.invariants.length
  const covered = [...product.maps, ...product.actions, ...product.systems, ...product.invariants]
    .filter(item => item.provenance.length > 0).length
  return {
    projectId: product.snapshot.projectId,
    phase: canFreeze(product) ? 'closure' : 'mechanisms',
    sourceDigest: product.snapshot.digest,
    purpose: product.purpose,
    canon: product.canon,
    executableCounts: {
      maps: product.maps.length,
      actions: product.actions.length,
      systems: product.systems.length,
      invariants: product.invariants.length,
    },
    sourceCoverage: executable === 0 ? 1 : covered / executable,
    diagnostics: product.diagnostics,
    questions: product.questions,
    proposals: product.proposals,
    certificate: product.certificate,
    canFreeze: canFreeze(product),
  }
}

/** Host compiler gateway. All model-generated semantics enter through reviewable proposals. */
export default class WorldlineCompiler extends TypertRemoteService {
  static inject = ['worldlineProjects']

  private readonly context: Context

  constructor(ctx: Context) {
    super(ctx, 'worldlineCompiler')
    this.context = ctx
  }

  /** Return the latest compiler state for a project.
   * @param projectId - The project id supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('state')
  async state(projectId: ProjectId): Promise<CompilerState> {
    const document = await this.context.worldlineProjects.readControl(projectId, 'compiler', 'state.json')
    if (document === undefined) return { questions: [], proposals: [] }
    const parsed = JSON.parse(document.content) as Partial<StoredState>
    return { revision: document.revision, questions: parsed.questions ?? [], proposals: parsed.proposals ?? [] }
  }

  /** Compile a project snapshot and persist its diagnostics and draft output.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('compile')
  async compile(request: CompileWorldRequest): Promise<BuildPreview> {
    const snapshot = await this.context.worldlineProjects.sourceSnapshot(request.projectId)
    const state = await this.state(request.projectId)
    const product = compileSnapshot(snapshot, request.purpose, state.questions, state.proposals)
    if (stableStringify(product.questions) !== stableStringify(state.questions)) {
      await this.saveState(request.projectId, { questions: product.questions, proposals: state.proposals }, state.revision)
    }
    return previewOf(product)
  }

  /** Perform answer question through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('answerQuestion')
  async answerQuestion(request: AnswerQuestionRequest): Promise<CompilerState> {
    const state = await this.state(request.projectId)
    this.assertStateRevision(state, request.expectedStateRevision)
    if (!state.questions.some(item => item.id === request.questionId)) {
      throw new WorldlineCompilerError('question-not-found', `creative question not found: ${request.questionId}`)
    }
    const answeredAt = now()
    return this.saveState(request.projectId, {
      questions: state.questions.map(item => item.id === request.questionId
        ? { ...item, status: 'answered' as const, answer: request.answer, answeredAt }
        : item),
      proposals: state.proposals,
    }, state.revision)
  }

  /** Apply submit proposal through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('submitProposal')
  async submitProposal(request: SubmitProposalRequest): Promise<CompilerState> {
    const state = await this.state(request.projectId)
    this.assertStateRevision(state, request.expectedStateRevision)
    const submittedAt = now()
    const proposal: CompilerProposal = {
      id: `proposal:${this.hash(`${request.title}:${submittedAt}:${stableStringify(request.payload)}`)}`,
      target: request.target,
      title: request.title,
      rationale: request.rationale,
      risk: request.risk,
      payload: request.payload,
      anchors: request.anchors,
      status: 'pending',
      submittedAt,
    }
    return this.saveState(request.projectId, {
      questions: state.questions,
      proposals: [...state.proposals, proposal],
    }, state.revision)
  }

  /** Perform review proposal through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('reviewProposal')
  async reviewProposal(request: ReviewProposalRequest): Promise<CompilerState> {
    const state = await this.state(request.projectId)
    this.assertStateRevision(state, request.expectedStateRevision)
    if (!state.proposals.some(item => item.id === request.proposalId)) {
      throw new WorldlineCompilerError('proposal-not-found', `compiler proposal not found: ${request.proposalId}`)
    }
    const reviewedAt = now()
    return this.saveState(request.projectId, {
      questions: state.questions,
      proposals: state.proposals.map(item => item.id === request.proposalId
        ? { ...item, status: request.decision, reviewedAt, reviewedBy: request.reviewedBy }
        : item),
    }, state.revision)
  }

  /** Freeze the latest valid draft into an immutable blueprint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('freeze')
  async freeze(request: FreezeWorldRequest): Promise<FrozenBuild> {
    const snapshot = await this.context.worldlineProjects.sourceSnapshot(request.projectId)
    if (snapshot.digest !== request.expectedSourceDigest) {
      throw new WorldlineCompilerError('source-changed', 'project sources changed after the build preview')
    }
    const state = await this.state(request.projectId)
    const product = compileSnapshot(snapshot, request.purpose, state.questions, state.proposals)
    if (!canFreeze(product)) {
      throw new WorldlineCompilerError('closure-blocked', 'Blueprint cannot freeze while closure blockers remain')
    }
    const blueprint = this.blueprintOf(product)
    await this.context.worldlineProjects.storeBuild({
      projectId: request.projectId,
      digest: blueprint.digest,
      blueprint: `${JSON.stringify(blueprint, null, 2)}\n`,
      certificate: `${JSON.stringify(blueprint.certificate, null, 2)}\n`,
      sourceSnapshot: `${JSON.stringify(this.snapshotManifest(snapshot), null, 2)}\n`,
    })
    return { blueprint, certificate: blueprint.certificate, activatedAt: now() }
  }

  /** Explain one compiler diagnostic using stable source references.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('explain')
  async explain(request: ExplainSemanticsRequest): Promise<SemanticsExplanation> {
    const snapshot = await this.context.worldlineProjects.sourceSnapshot(request.projectId)
    const state = await this.state(request.projectId)
    const product = compileSnapshot(snapshot, undefined, state.questions, state.proposals)
    const candidates = [
      ...product.canon,
      ...product.actions,
      ...product.systems,
      ...product.invariants,
      ...product.maps,
    ]
    const candidate = candidates.find(item => item.id === request.objectId)
    if (candidate === undefined) {
      return {
        objectId: request.objectId,
        summary: 'No compiled semantic node currently has this ID.',
        anchors: [],
        diagnostics: product.diagnostics.filter(item => item.objectId === request.objectId),
      }
    }
    const provenance = 'provenance' in candidate ? candidate.provenance : []
    return {
      objectId: request.objectId,
      summary: 'This semantic node was compiled from the listed author or approved sources.',
      anchors: provenance.flatMap(item => item.anchors),
      diagnostics: product.diagnostics.filter(item => item.objectId === request.objectId),
    }
  }

  private async saveState(
    projectId: ProjectId,
    state: StoredState,
    expectedRevision: Revision | undefined,
  ): Promise<CompilerState> {
    const document = await this.context.worldlineProjects.writeControl({
      projectId,
      namespace: 'compiler',
      path: 'state.json',
      content: `${JSON.stringify(state, null, 2)}\n`,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    })
    return { revision: document.revision, questions: state.questions, proposals: state.proposals }
  }

  private assertStateRevision(state: CompilerState, expected: Revision | undefined): void {
    if (expected !== undefined && state.revision !== expected) {
      throw new WorldlineCompilerError('state-conflict', 'compiler review state changed concurrently')
    }
  }

  private blueprintOf(product: CompilationProduct): Blueprint {
    const provenance: Provenance[] = [
      ...product.canon.flatMap(item => item.provenance),
      ...product.actions.flatMap(item => item.provenance),
      ...product.systems.flatMap(item => item.provenance),
      ...product.invariants.flatMap(item => item.provenance),
    ]
    return {
      id: worldlineId<'blueprint'>(`blueprint:${product.certificate.blueprintDigest}`),
      digest: product.certificate.blueprintDigest,
      format: WWS_VERSION,
      projectId: product.snapshot.projectId,
      worldId: product.snapshot.manifest.defaultWorldId,
      worldlineId: product.snapshot.manifest.defaultWorldlineId,
      projectRevision: product.snapshot.digest as Revision,
      createdAt: product.certificate.createdAt,
      purpose: product.purpose,
      canon: product.canon,
      links: product.links,
      maps: product.maps,
      entities: product.entities,
      actions: product.actions,
      systems: product.systems,
      invariants: product.invariants,
      provenance,
      modelPolicy: { routes: {}, aiEnabled: false, revision: product.snapshot.digest as Revision },
      certificate: product.certificate,
    }
  }

  private snapshotManifest(snapshot: ProjectSourceSnapshot): object {
    return {
      projectId: snapshot.projectId,
      capturedAt: snapshot.capturedAt,
      digest: snapshot.digest,
      files: snapshot.files.map(file => ({ id: file.id, path: file.path, revision: file.revision })),
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }
}

export { WorldlineCompiler }
