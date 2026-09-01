import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorldlineId } from './ids.ts'

/** Describes the json primitive value exchanged across the package boundary.
 */
export type JsonPrimitive = string | number | boolean | null
/** Describes the json value value exchanged across the package boundary.
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
/** Describes the json object value exchanged across the package boundary.
 */
export type JsonObject = { [key: string]: JsonValue }

/** Describes the project id value exchanged across the package boundary.
 */
export type ProjectId = WorldlineId<'project'>
/** Describes the world id value exchanged across the package boundary.
 */
export type WorldId = WorldlineId<'world'>
/** Describes the canon worldline id value exchanged across the package boundary.
 */
export type CanonWorldlineId = WorldlineId<'worldline'>
/** Describes the entity id value exchanged across the package boundary.
 */
export type EntityId = WorldlineId<'entity'>
/** Describes the document id value exchanged across the package boundary.
 */
export type DocumentId = WorldlineId<'document'>
/** Describes the asset id value exchanged across the package boundary.
 */
export type AssetId = WorldlineId<'asset'>
/** Describes the map id value exchanged across the package boundary.
 */
export type MapId = WorldlineId<'map'>
/** Describes the map node id value exchanged across the package boundary.
 */
export type MapNodeId = WorldlineId<'map-node'>
/** Describes the action id value exchanged across the package boundary.
 */
export type ActionId = WorldlineId<'action'>
/** Describes the process id value exchanged across the package boundary.
 */
export type ProcessId = WorldlineId<'process'>
/** Describes the event id value exchanged across the package boundary.
 */
export type EventId = WorldlineId<'event'>
/** Describes the run id value exchanged across the package boundary.
 */
export type RunId = WorldlineId<'run'>
/** Describes the checkpoint id value exchanged across the package boundary.
 */
export type CheckpointId = WorldlineId<'checkpoint'>
/** Describes the blueprint id value exchanged across the package boundary.
 */
export type BlueprintId = WorldlineId<'blueprint'>
/** Describes the revision value exchanged across the package boundary.
 */
export type Revision = Branded<'WorldlineRevision'>

/** Identifies the package-owned wws version value.
 */
export const WWS_VERSION = '0.1.0' as const
/** Identifies the package-owned project manifest value.
 */
export const PROJECT_MANIFEST = 'worldline.toml' as const

/** Describes the canon status value exchanged across the package boundary.
 */
export type CanonStatus = 'draft' | 'canon' | 'deprecated'
/** Describes the provenance kind value exchanged across the package boundary.
 */
export type ProvenanceKind =
  | 'author'
  | 'approved-supplement'
  | 'mechanism-pack'
  | 'import'
  | 'agent-proposal'
  | 'runtime-proposal'

/** Describes the source anchor value exchanged across the package boundary.
 */
export interface SourceAnchor {
  readonly id: WorldlineId<'source-anchor'>
  readonly documentId: DocumentId
  readonly revision: Revision
  readonly heading?: string
  readonly startOffset: number
  readonly endOffset: number
  readonly excerptHash: string
  readonly contextBefore?: string
  readonly contextAfter?: string
}

/** Describes the provenance value exchanged across the package boundary.
 */
export interface Provenance {
  readonly kind: ProvenanceKind
  readonly anchors: readonly SourceAnchor[]
  readonly mechanism?: { readonly id: string; readonly version: string }
  readonly proposalId?: WorldlineId<'proposal'>
  readonly compilerVersion?: string
  readonly modelRoute?: ModelRoute
  readonly approvedBy?: string
  readonly confidence?: number
}

/** Describes the project manifest value exchanged across the package boundary.
 */
export interface ProjectManifest {
  readonly format: typeof WWS_VERSION
  readonly id: ProjectId
  readonly name: string
  readonly description: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly defaultWorldId: WorldId
  readonly defaultWorldlineId: CanonWorldlineId
  readonly cover?: string
  readonly author?: string
  readonly license?: string
  readonly template: ProjectTemplate
  readonly tags: readonly string[]
  readonly dependencies: readonly MechanismDependency[]
}

/** Describes the project template value exchanged across the package boundary.
 */
export type ProjectTemplate =
  | 'blank'
  | 'world-encyclopedia'
  | 'character-story'
  | 'social-simulation'
  | 'civilization-sandbox'
  | 'playable-scenario'

/** Describes the mechanism dependency value exchanged across the package boundary.
 */
export interface MechanismDependency {
  readonly id: string
  readonly version: string
  readonly required: boolean
}

/** Describes the canon object kind value exchanged across the package boundary.
 */
export type CanonObjectKind =
  | 'charter'
  | 'character'
  | 'place'
  | 'organization'
  | 'species'
  | 'item'
  | 'concept'
  | 'rule'
  | 'relation'
  | 'fact'
  | 'timeline-event'
  | 'scenario'
  | 'asset'
  | 'custom'

/** Describes the canon object value exchanged across the package boundary.
 */
export interface CanonObject {
  readonly id: EntityId
  readonly kind: CanonObjectKind
  /** Application-defined name when `kind` is `custom`. */
  readonly customKind?: string
  readonly documentId: DocumentId
  readonly title: string
  readonly aliases: readonly string[]
  readonly tags: readonly string[]
  readonly status: CanonStatus
  readonly worldIds: readonly WorldId[]
  readonly worldlineIds: readonly CanonWorldlineId[]
  readonly validFrom?: number
  readonly validTo?: number
  readonly facets: Readonly<Record<string, JsonValue>>
  readonly provenance: readonly Provenance[]
}

/** Describes the canon link value exchanged across the package boundary.
 */
export interface CanonLink {
  readonly id: WorldlineId<'link'>
  readonly from: EntityId
  readonly to: EntityId
  readonly predicate: string
  readonly directed: boolean
  readonly provenance: readonly Provenance[]
}

/** Describes the world map value exchanged across the package boundary.
 */
export interface WorldMap {
  readonly id: MapId
  readonly version: 1
  readonly name: string
  readonly rootNodeId: MapNodeId
  readonly backgroundAssetId?: AssetId
  readonly layers: readonly MapLayer[]
  readonly nodes: readonly MapNode[]
  readonly edges: readonly MapEdge[]
  readonly provenance: readonly Provenance[]
}

/** Describes the map layer value exchanged across the package boundary.
 */
export interface MapLayer {
  readonly id: string
  readonly name: string
  readonly visible: boolean
  readonly locked: boolean
  readonly order: number
}

/** Describes the map node kind value exchanged across the package boundary.
 */
export type MapNodeKind = 'world' | 'plane' | 'region' | 'city' | 'building' | 'room' | 'slot'

/** Describes the map point value exchanged across the package boundary.
 */
export interface MapPoint { readonly x: number; readonly y: number }

/** Describes the map node value exchanged across the package boundary.
 */
export interface MapNode {
  readonly id: MapNodeId
  readonly entityId?: EntityId
  readonly parentId?: MapNodeId
  readonly layerId: string
  readonly kind: MapNodeKind
  readonly name: string
  readonly position: MapPoint
  readonly polygon?: readonly MapPoint[]
  readonly capacity?: number
  readonly permissions: readonly string[]
  readonly hazards: readonly string[]
  readonly entryNodeIds: readonly MapNodeId[]
}

/** Describes the map edge value exchanged across the package boundary.
 */
export interface MapEdge {
  readonly id: WorldlineId<'map-edge'>
  readonly from: MapNodeId
  readonly to: MapNodeId
  readonly bidirectional: boolean
  readonly distance: number
  readonly baseDuration: number
  readonly capacity?: number
  readonly modes: readonly string[]
  readonly permissions: readonly string[]
  readonly hazards: readonly string[]
  readonly dynamicCondition?: string
}

/** Describes the model purpose value exchanged across the package boundary.
 */
export type ModelPurpose = 'compiler' | 'character' | 'creative' | 'narrator' | 'summary'

/** Describes the model route value exchanged across the package boundary.
 */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Describes the model policy value exchanged across the package boundary.
 */
export interface ModelPolicy {
  readonly routes: Readonly<Partial<Record<ModelPurpose, ModelRoute>>>
  readonly aiEnabled: boolean
  readonly revision: Revision
}

/** Describes the ai budget value exchanged across the package boundary.
 */
export interface AiBudget {
  readonly maxCalls: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxConcurrent: number
  readonly maxCallsPerLogicalDay: number
  readonly maxCallsPerRealHour: number
  readonly maxEstimatedCost: number
  readonly currency: string
}

/** Describes the ai usage value exchanged across the package boundary.
 */
export interface AiUsage {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly estimatedCost: number
  readonly cacheHits: number
  readonly degradedReason?: string
}

/** Describes the context pack section value exchanged across the package boundary.
 */
export interface ContextPackSection {
  readonly kind: 'identity' | 'constraints' | 'observation' | 'goal' | 'memory' | 'background' | 'actions'
  readonly text: string
  readonly tokens: number
  readonly sourceIds: readonly string[]
  readonly priority: number
}

/** Describes the context pack value exchanged across the package boundary.
 */
export interface ContextPack {
  readonly actorId: EntityId
  readonly model: ModelRoute
  readonly contextWindow: number
  readonly inputLimit: number
  readonly reservedOutputTokens: number
  readonly reservedToolTokens: number
  readonly sections: readonly ContextPackSection[]
  readonly totalTokens: number
  readonly droppedSourceIds: readonly string[]
}

/** Describes the character memory value exchanged across the package boundary.
 */
export interface CharacterMemory {
  readonly episodic: readonly EpisodicMemory[]
  readonly beliefs: readonly Belief[]
  readonly goals: readonly GoalCommitment[]
  readonly relationships: readonly RelationshipEvidence[]
  readonly experience: readonly ActionExperience[]
  readonly skills: readonly SkillExperience[]
  readonly reflections: readonly Reflection[]
}

/** Describes the memory base value exchanged across the package boundary.
 */
export interface MemoryBase {
  readonly id: WorldlineId<'memory'>
  readonly actorId: EntityId
  readonly logicalTime: number
  readonly sourceEventIds: readonly EventId[]
  readonly importance: number
}

/** Describes the episodic memory value exchanged across the package boundary.
 */
export interface EpisodicMemory extends MemoryBase {
  readonly summary: string
  readonly participants: readonly EntityId[]
  readonly placeId?: MapNodeId
}
/** Describes the belief value exchanged across the package boundary.
 */
export interface Belief extends MemoryBase {
  readonly subject: string
  readonly value: JsonValue
  readonly confidence: number
  readonly contradictedBy: readonly EventId[]
}
/** Describes the goal commitment value exchanged across the package boundary.
 */
export interface GoalCommitment extends MemoryBase {
  readonly goal: string
  readonly status: 'active' | 'met' | 'failed' | 'abandoned'
  readonly deadline?: number
  readonly promisedTo?: EntityId
}
/** Describes the relationship evidence value exchanged across the package boundary.
 */
export interface RelationshipEvidence extends MemoryBase {
  readonly otherId: EntityId
  readonly dimensions: Readonly<Record<string, number>>
}
/** Describes the action experience value exchanged across the package boundary.
 */
export interface ActionExperience extends MemoryBase {
  readonly actionType: string
  readonly outcome: ActionTerminalState
  readonly conditions: JsonObject
}
/** Describes the skill experience value exchanged across the package boundary.
 */
export interface SkillExperience extends MemoryBase {
  readonly skill: string
  readonly level: number
  readonly evidence: readonly EventId[]
}
/** Describes the reflection value exchanged across the package boundary.
 */
export interface Reflection extends MemoryBase {
  readonly text: string
  readonly modelRoute?: ModelRoute
}

/** Describes the action lifecycle state value exchanged across the package boundary.
 */
export type ActionLifecycleState = 'proposed' | 'admitted' | 'reserved' | 'started' | 'progressing' | ActionTerminalState
/** Describes the action terminal state value exchanged across the package boundary.
 */
export type ActionTerminalState = 'completed' | 'failed' | 'cancelled'

/** Describes the action request value exchanged across the package boundary.
 */
export interface ActionRequest {
  readonly id: ActionId
  readonly type: string
  readonly actorId: EntityId
  readonly targetIds: readonly string[]
  readonly parameters: JsonObject
  readonly requestedAt: number
  readonly control: 'policy' | 'player' | 'director' | 'external'
  readonly idempotencyKey: string
}

/** Describes the resource claim value exchanged across the package boundary.
 */
export interface ResourceClaim {
  readonly resourceId: string
  readonly quantity: number
  readonly mode: 'shared' | 'exclusive' | 'capacity'
  readonly start: number
  readonly end: number
}

/** Describes the reservation value exchanged across the package boundary.
 */
export interface Reservation {
  readonly id: WorldlineId<'reservation'>
  readonly processId: ProcessId
  readonly claims: readonly ResourceClaim[]
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly queuePosition: number
}

/** Describes the movement progress value exchanged across the package boundary.
 */
export interface MovementProgress {
  readonly origin: MapNodeId
  readonly destination: MapNodeId
  readonly route: readonly MapNodeId[]
  readonly edgeIndex: number
  readonly edgeFraction: number
  readonly departedAt: number
  readonly estimatedArrival: number
  readonly remainingDuration: number
  readonly mode: string
}

/** Describes the process value exchanged across the package boundary.
 */
export interface Process {
  readonly id: ProcessId
  readonly action: ActionRequest
  readonly state: ActionLifecycleState
  readonly startedAt?: number
  readonly nextWakeAt?: number
  readonly deadline?: number
  readonly progress: number
  readonly progressMeasure: number
  readonly movement?: MovementProgress
  readonly reservationIds: readonly WorldlineId<'reservation'>[]
  readonly retryBudget: number
  readonly retryCount: number
  readonly blockedReason?: string
  readonly wakeConditions: readonly string[]
  readonly fallbacks: readonly string[]
  readonly failure?: string
}

/** Describes the state delta value exchanged across the package boundary.
 */
export interface StateDelta {
  readonly path: string
  readonly before?: JsonValue
  readonly after?: JsonValue
}

/** Describes the world event value exchanged across the package boundary.
 */
export interface WorldEvent {
  readonly id: EventId
  readonly sequence: number
  readonly logicalTime: number
  readonly type: string
  readonly actorId?: EntityId
  readonly participantIds: readonly string[]
  readonly causedBy: readonly EventId[]
  readonly actionId?: ActionId
  readonly processId?: ProcessId
  readonly ruleId?: string
  readonly deltas: readonly StateDelta[]
  readonly persistentFacts: readonly JsonObject[]
  readonly cognitionChanges: readonly JsonObject[]
  readonly processMilestone?: ActionLifecycleState
  readonly visibleTo: readonly string[]
  readonly provenance: readonly Provenance[]
  readonly data: JsonObject
}

/** Describes the decision trace value exchanged across the package boundary.
 */
export interface DecisionTrace {
  readonly id: WorldlineId<'decision-trace'>
  readonly logicalTime: number
  readonly actorId?: EntityId
  readonly actionId?: ActionId
  readonly type: 'proposed' | 'rejected' | 'waiting' | 'replanned' | 'deadlock-resolved' | 'livelock-resolved'
  readonly reason: string
  readonly details: JsonObject
}

/** Persisted model-produced intent. It is advisory until Runtime validates and commits an Action. */
export interface AiIntent {
  readonly id: WorldlineId<'intent'>
  readonly invocationId: WorldlineId<'ai-invocation'>
  readonly actorId: EntityId
  readonly logicalTime: number
  readonly choiceId: string
  readonly actionType: string
  readonly parameters: JsonObject
  readonly rationale: string
  readonly confidence: number
  readonly modelRoute: ModelRoute
  readonly contextSourceIds: readonly string[]
  readonly recordedAt: string
}

/** Actual routed model call accounting, shared by character, narrator, summary and compiler uses. */
export interface AiInvocation {
  readonly id: WorldlineId<'ai-invocation'>
  readonly purpose: ModelPurpose
  readonly actorId?: EntityId
  readonly logicalTime: number
  readonly modelRoute: ModelRoute
  readonly contextSourceIds: readonly string[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly estimatedCost: number
  readonly outputDigest: string
  readonly outcome: 'completed' | 'failed' | 'aborted'
  readonly recordedAt: string
}

/** Describes the observation value exchanged across the package boundary.
 */
export interface Observation {
  readonly id: WorldlineId<'observation'>
  readonly observerId: EntityId
  readonly eventId: EventId
  readonly logicalTime: number
  readonly channel: string
  readonly confidence: number
  readonly perceived: JsonObject
}

/** Describes the narrative beat value exchanged across the package boundary.
 */
export interface NarrativeBeat {
  readonly id: WorldlineId<'narrative-beat'>
  readonly invocationId?: WorldlineId<'ai-invocation'>
  readonly eventIds: readonly EventId[]
  readonly observationIds: readonly WorldlineId<'observation'>[]
  readonly camera: string
  readonly speakerId?: EntityId
  readonly text: string
  readonly media: readonly MediaCue[]
  readonly style: 'template' | 'llm'
  readonly modelRoute?: ModelRoute
}

/** Describes the media cue value exchanged across the package boundary.
 */
export interface MediaCue {
  readonly type: 'background' | 'portrait' | 'expression' | 'bgm' | 'sfx' | 'voice' | 'transition'
  readonly assetId?: AssetId
  readonly entityId?: EntityId
  readonly variant?: string
}

/** Describes the telemetry value exchanged across the package boundary.
 */
export interface Telemetry {
  readonly logicalTime: number
  readonly queueDepth: number
  readonly activeProcesses: number
  readonly longestWait: number
  readonly eventRate: number
  readonly ai: AiUsage
}

/** Describes the future event value exchanged across the package boundary.
 */
export interface FutureEvent {
  readonly id: string
  readonly due: number
  readonly order: number
  readonly kind: string
  readonly payload: JsonObject
  readonly dedupeKey?: string
}

/** Describes the blueprint value exchanged across the package boundary.
 */
export interface Blueprint {
  readonly id: BlueprintId
  readonly digest: string
  readonly format: typeof WWS_VERSION
  readonly projectId: ProjectId
  readonly worldId: WorldId
  readonly worldlineId: CanonWorldlineId
  readonly projectRevision: Revision
  readonly createdAt: string
  readonly purpose: SimulationPurpose
  readonly canon: readonly CanonObject[]
  readonly links: readonly CanonLink[]
  readonly maps: readonly WorldMap[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
  readonly provenance: readonly Provenance[]
  readonly modelPolicy: ModelPolicy
  readonly certificate: ClosureCertificate
}

/** Describes the simulation purpose value exchanged across the package boundary.
 */
export interface SimulationPurpose {
  readonly summary: string
  readonly scope: readonly string[]
  readonly duration: number
  readonly resolution: number
  readonly detail: 'L0' | 'L1' | 'L2' | 'L3'
  readonly hardExpectations: readonly string[]
  readonly statisticalExpectations: readonly string[]
  readonly antiPatterns: readonly string[]
}

/** Describes the runtime entity seed value exchanged across the package boundary.
 */
export interface RuntimeEntitySeed {
  readonly id: EntityId
  readonly type: string
  readonly facets: Readonly<Record<string, JsonValue>>
  readonly state: JsonObject
  readonly lod: 'L0' | 'L1' | 'L2' | 'L3'
  readonly policyIds: readonly string[]
  readonly memory: CharacterMemory
}

/** Describes the action definition value exchanged across the package boundary.
 */
export interface ActionDefinition {
  readonly id: string
  readonly description: string
  /** Core execution family; ordinary movement must use `move`, never a generic position write. */
  readonly operator?: 'generic' | 'move' | 'teleport'
  readonly actorTypes: readonly string[]
  readonly preconditions: readonly Expression[]
  readonly claims: readonly ClaimTemplate[]
  readonly duration: number
  readonly effects: readonly Effect[]
  readonly interruptible: boolean
  readonly maxWait: number
  readonly retryBudget: number
  readonly fallbacks: readonly string[]
  readonly provenance: readonly Provenance[]
}

/** Describes the claim template value exchanged across the package boundary.
 */
export interface ClaimTemplate {
  readonly resource: string
  readonly quantity: number
  readonly mode: ResourceClaim['mode']
  readonly duration: number
}

/** Describes the expression value exchanged across the package boundary.
 */
export type Expression =
  | { readonly op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; readonly path: string; readonly value: JsonValue }
  | { readonly op: 'exists'; readonly path: string }
  | { readonly op: 'and' | 'or'; readonly items: readonly Expression[] }
  | { readonly op: 'not'; readonly item: Expression }

/** Describes the effect value exchanged across the package boundary.
 */
export type Effect =
  | { readonly op: 'set'; readonly path: string; readonly value: JsonValue }
  | { readonly op: 'increment'; readonly path: string; readonly amount: number; readonly min?: number; readonly max?: number }
  | { readonly op: 'transfer'; readonly resource: string; readonly from: string; readonly to: string; readonly amount: number }
  | { readonly op: 'observe'; readonly observer: string; readonly fact: JsonObject }

/** Describes the system definition value exchanged across the package boundary.
 */
export interface SystemDefinition {
  readonly id: string
  readonly description: string
  readonly nextWake: number
  readonly interval?: number
  readonly preconditions: readonly Expression[]
  readonly effects: readonly Effect[]
  readonly provenance: readonly Provenance[]
}

/** Describes the invariant definition value exchanged across the package boundary.
 */
export interface InvariantDefinition {
  readonly id: string
  readonly description: string
  readonly expression: Expression
  readonly provenance: readonly Provenance[]
}

/** Describes the certificate category value exchanged across the package boundary.
 */
export type CertificateCategory =
  | 'state'
  | 'time'
  | 'space'
  | 'actions'
  | 'cognition'
  | 'causality'
  | 'safety'
  | 'liveness'
  | 'fairness'
  | 'event-validity'
  | 'behavioral-validity'
  | 'replay'
  | 'provenance'

/** Describes the certificate result value exchanged across the package boundary.
 */
export interface CertificateResult {
  readonly category: CertificateCategory
  readonly status: 'pass' | 'warning' | 'blocking'
  readonly summary: string
  readonly evidence: readonly string[]
  readonly reproduction?: string
}

/** Describes the closure certificate value exchanged across the package boundary.
 */
export interface ClosureCertificate {
  readonly blueprintDigest: string
  readonly createdAt: string
  readonly sourceCoverage: Readonly<Record<ProvenanceKind, number>>
  readonly results: readonly CertificateResult[]
  readonly deterministicWithoutAi: boolean
  readonly knownLimits: readonly string[]
  readonly performance: JsonObject
}

/** Describes the run snapshot value exchanged across the package boundary.
 */
export interface RunSnapshot {
  readonly runId: RunId
  readonly blueprintId: BlueprintId
  readonly blueprintDigest: string
  readonly branchId: CanonWorldlineId
  readonly parentRunId?: RunId
  readonly forkSequence?: number
  readonly seed: string
  readonly logicalTime: number
  readonly sequence: number
  readonly state: JsonObject
  readonly processes: readonly Process[]
  readonly reservations: readonly Reservation[]
  readonly futureEvents: readonly FutureEvent[]
  readonly randomState: string
  readonly modelPolicy: ModelPolicy
  readonly aiBudget: AiBudget
  readonly aiUsage: AiUsage
}

/** Describes the checkpoint value exchanged across the package boundary.
 */
export interface Checkpoint {
  readonly id: CheckpointId
  readonly runId: RunId
  readonly sequence: number
  readonly createdAt: string
  readonly snapshot: RunSnapshot
  readonly digest: string
}

/** Describes the scene frame value exchanged across the package boundary.
 */
export interface SceneFrame {
  readonly logicalTime: number
  readonly placeId?: MapNodeId
  readonly presentEntityIds: readonly EntityId[]
  readonly visibleState: JsonObject
  readonly activeProcesses: readonly Process[]
  readonly media: readonly MediaCue[]
}

/** Describes the choice projection value exchanged across the package boundary.
 */
export interface ChoiceProjection {
  readonly id: string
  readonly actionType: string
  /** Exact Runtime-validated parameters represented by this choice. */
  readonly parameters: JsonObject
  readonly label: string
  readonly description: string
  readonly targetIds: readonly string[]
  readonly estimatedDuration: number
  readonly costs: readonly string[]
  readonly risks: readonly string[]
}

/** Describes the story stage renderer value exchanged across the package boundary.
 */
export interface StoryStageRenderer {
  readonly id: string
  readonly name: string
  readonly capabilities: readonly MediaCue['type'][]
  render(frame: SceneFrame, beats: readonly NarrativeBeat[]): unknown
}
