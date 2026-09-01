import type {
  Blueprint,
  CanonObject,
  ClosureCertificate,
  JsonObject,
  ProjectId,
  Revision,
  SimulationPurpose,
  SourceAnchor,
} from '@deepseek-ai/dsh-worldline-standard/types'

/** Describes the build diagnostic severity value exchanged across the package boundary.
 */
export type BuildDiagnosticSeverity = 'info' | 'warning' | 'blocking'
/** Describes the build phase value exchanged across the package boundary.
 */
export type BuildPhase = 'snapshot' | 'parse' | 'link' | 'mechanisms' | 'closure' | 'frozen'

/** Describes the build diagnostic value exchanged across the package boundary.
 */
export interface BuildDiagnostic {
  readonly code: string
  readonly severity: BuildDiagnosticSeverity
  readonly message: string
  readonly path?: string
  readonly objectId?: string
  readonly remediation?: string
}

/** Describes the creative question value exchanged across the package boundary.
 */
export interface CreativeQuestion {
  readonly id: string
  readonly prompt: string
  readonly rationale: string
  readonly impact: 'low' | 'medium' | 'high'
  readonly status: 'open' | 'answered' | 'dismissed'
  readonly sourcePaths: readonly string[]
  readonly answer?: string
  readonly answeredAt?: string
}

/** Describes the proposal target value exchanged across the package boundary.
 */
export type ProposalTarget = 'canon' | 'action' | 'system' | 'invariant' | 'map'
/** Describes the compiler proposal value exchanged across the package boundary.
 */
export interface CompilerProposal {
  readonly id: string
  readonly target: ProposalTarget
  readonly title: string
  readonly rationale: string
  readonly risk: 'low' | 'medium' | 'high'
  readonly payload: JsonObject
  readonly anchors: readonly SourceAnchor[]
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly submittedAt: string
  readonly reviewedAt?: string
  readonly reviewedBy?: string
}

/** Describes the compiler state value exchanged across the package boundary.
 */
export interface CompilerState {
  readonly revision?: Revision
  readonly questions: readonly CreativeQuestion[]
  readonly proposals: readonly CompilerProposal[]
}

/** Describes the compile world request value exchanged across the package boundary.
 */
export interface CompileWorldRequest {
  readonly projectId: ProjectId
  readonly purpose?: SimulationPurpose
}

/** Describes the build preview value exchanged across the package boundary.
 */
export interface BuildPreview {
  readonly projectId: ProjectId
  readonly phase: BuildPhase
  readonly sourceDigest: string
  readonly purpose: SimulationPurpose
  readonly canon: readonly CanonObject[]
  readonly executableCounts: {
    readonly maps: number
    readonly actions: number
    readonly systems: number
    readonly invariants: number
  }
  readonly sourceCoverage: number
  readonly diagnostics: readonly BuildDiagnostic[]
  readonly questions: readonly CreativeQuestion[]
  readonly proposals: readonly CompilerProposal[]
  readonly certificate: ClosureCertificate
  readonly canFreeze: boolean
}

/** Describes the answer question request value exchanged across the package boundary.
 */
export interface AnswerQuestionRequest {
  readonly projectId: ProjectId
  readonly questionId: string
  readonly answer: string
  readonly expectedStateRevision?: Revision
}

/** Describes the submit proposal request value exchanged across the package boundary.
 */
export interface SubmitProposalRequest {
  readonly projectId: ProjectId
  readonly target: ProposalTarget
  readonly title: string
  readonly rationale: string
  readonly risk: CompilerProposal['risk']
  readonly payload: JsonObject
  readonly anchors: readonly SourceAnchor[]
  readonly expectedStateRevision?: Revision
}

/** Describes the review proposal request value exchanged across the package boundary.
 */
export interface ReviewProposalRequest {
  readonly projectId: ProjectId
  readonly proposalId: string
  readonly decision: 'approved' | 'rejected'
  readonly reviewedBy: string
  readonly expectedStateRevision?: Revision
}

/** Describes the freeze world request value exchanged across the package boundary.
 */
export interface FreezeWorldRequest extends CompileWorldRequest {
  readonly expectedSourceDigest: string
}

/** Describes the frozen build value exchanged across the package boundary.
 */
export interface FrozenBuild {
  readonly blueprint: Blueprint
  readonly certificate: ClosureCertificate
  readonly activatedAt: string
}

/** Describes the explain semantics request value exchanged across the package boundary.
 */
export interface ExplainSemanticsRequest { readonly projectId: ProjectId; readonly objectId: string }
/** Describes the semantics explanation value exchanged across the package boundary.
 */
export interface SemanticsExplanation {
  readonly objectId: string
  readonly summary: string
  readonly anchors: readonly SourceAnchor[]
  readonly diagnostics: readonly BuildDiagnostic[]
}

/** Describes the worldline compiler error code value exchanged across the package boundary.
 */
export type WorldlineCompilerErrorCode =
  | 'question-not-found'
  | 'proposal-not-found'
  | 'source-changed'
  | 'closure-blocked'
  | 'state-conflict'

/** Owns the worldline compiler error capability and its lifecycle.
 */
export class WorldlineCompilerError extends Error {
  constructor(readonly code: WorldlineCompilerErrorCode, message: string) {
    super(message)
    this.name = 'WorldlineCompilerError'
  }
}
