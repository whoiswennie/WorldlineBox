import { createHash, randomUUID } from 'node:crypto';
import type { CompanionContactState, CompanionInteraction } from '../shared/companion-contact';
import { companionHomeAddressSchema, type CompanionHomeAddress } from '../shared/companion-world-address';
import { COMPANION_WORLD_DEFAULT_SETTINGS, companionWorldSnapshotSchema, type CompanionWorldActor, type CompanionWorldEvent, type CompanionWorldJob, type CompanionWorldRelationship,
  type CompanionWorldScene, type CompanionWorldScope, type CompanionWorldSettings, type CompanionWorldSnapshot, type CompanionWorldVisit, type CompanionWorldWork } from '../shared/companion-world';
import type { CompanionWorldOccupancy } from '../shared/companion-world';
import { advanceCompanionWorldActor, companionWorldEnvironment, companionWorldRealAt, companionWorldSpeed, companionWorldVirtualAt,
  COMPANION_WORLD_SEATING_MS, COMPANION_WORLD_ACTION_TIMINGS, COMPANION_WORLD_WALK_TILES_PER_SECOND, createCompanionWorldPark, createCompanionWorldHome, routeCompanionWorldActor } from '../shared/companion-world-engine';
import { companionWorldCellWalkable, findCompanionWorldPath } from '../shared/companion-world-engine';
import { companionWorldEnergyRate } from '../shared/companion-world-engine';
import { COMPANION_WORLD_RECOVERY, companionWorldNeedsRecovery } from '../shared/companion-world-recovery';
import { defaultCompanionRoutineConfig, evaluateCompanionRoutine } from '../shared/companion-routine-time';
import type { CompanionWorldSleepPlan } from '../shared/companion-life-plan';
import type { CompanionLearningGrant } from '../shared/companion-learning';
import { readCompanionLifeOverviewPage } from './life-overview-store';
import { resolveCompanionScheduleTimeZone, isCompanionScheduleTimeZone } from '../shared/companion-schedule-time';
import { applyCompanionAppraisal } from '../shared/companion-affect';
import { companionWorldExpression } from '../shared/companion-world-expression';
import type { CompanionRoutineConfig } from '../shared/companion-routine';
import type { CompanionWorldArguments } from '../shared/companion-world-tool';
import type { CompanionMessage, CompanionMemory } from '../shared/companions';
import type { CompanionRuntimeState, CompanionStateProposal } from '../shared/companion-state';
import { companionMemoryConsolidateSchema, type CompanionMemoryCandidate, type CompanionMemoryConsolidation } from '../shared/companion-memory';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionSocialMessage } from '../shared/companion-social';
import type { CompanionSocialStore } from './social-store';
import type { CompanionWorkOrderStore } from './work-order-store';
import { companionTimeInZone } from '../shared/companion-schedule-time';
import { companionWorldParkCircuit, companionWorldParkContains, companionWorldParkLayout, companionWorldParkSuitable } from '../shared/companion-world-park';
import { companionLifeHazard, companionLifeMultiplier, companionLifeThreshold } from '../shared/companion-life-event';
import { COMPANION_WORLD_PERCEPTION_INTERVAL_MS, sampleCompanionWorldPerception, companionWorldPerceptionSignature,
  type CompanionWorldPerception } from '../shared/companion-world-perception';
import { COMPANION_SLEEP_DREAM_PROBABILITY, COMPANION_SLEEP_DREAM_COOLDOWN_MS, COMPANION_SLEEP_MINIMUM_REAL_MS,
  COMPANION_SLEEP_MAX_ATTEMPTS, COMPANION_SLEEP_SEED_LIMIT } from '../shared/companion-sleep';
import { companionAutomaticConsolidationHasNovelty } from '../shared/companion-memory-novelty';
import { companionSocialGoalOrigin } from './social-goal-origin';

type Row = Record<string, string | number | null>;
type GoalGamePort = { companionId: string; sourceChecksum: string; topicId: string; conversationId: string; recipientIds: string[];
  includePlayer: boolean; send: Omit<Extract<CompanionStorageCommand, { type: 'social.send' }>, 'type'> };
type SceneJourney = { visitId?: string; targetSceneId: string; exitId: string; entryId: string; destination: { x: number; y: number }; destinationId: string; activity: CompanionWorldActor['activity'] };
type StoredActor = Omit<CompanionWorldActor, 'parkWalk'> & { socialPause?: { sourceId: string; authorId: string; route: CompanionWorldActor['route']; journey?: SceneJourney; activity: CompanionWorldActor['activity'] };  arrivalActivity?: CompanionWorldActor['activity']; lastDecisionAt: number; lastDreamDay?: number;
  recovery?: { id: string; requestedAt: number; furnitureId?: string; retryAfter?: number };
  journey?: SceneJourney; navigationTaskId?: string;
  parkWalk?: NonNullable<CompanionWorldActor['parkWalk']> & { waypointIndex: number; comfortTicks: number; occurrenceId?: string };
  meetingHold?: { jobId: string; memberIds: string[]; untilReal: number }; meetingResume?: CompanionWorldActor['activity'];
  phoneResume?: { activity: CompanionWorldActor['activity'] };
  afterWork?: { scope: CompanionWorldScope; args: CompanionWorldArguments; sourceMessageId?: string }; lastClimateKey?: string;
  transition?: { eventId?: string; action?: CompanionWorldActor['activity']; until: number; after: CompanionWorldActor['activity'] }; manualActivityUntil?: number; manualArtAction?: CompanionWorldActor['artAction'];  };
type LearningWorkProof = { learningGrantId?: string; learningLeaseToken?: string };
type CollaborationWorkProof = { authorizationGrantId?: string; invocationId?: string };
type WorkProof = LearningWorkProof & CollaborationWorkProof;
type StoredWork = CompanionWorldWork & WorkProof & { conversationId: string; sourceMessageId?: string; urgent: boolean; fixed: boolean; requestedAtReal: number; workOrderId?: string };
type StoredVisit = CompanionWorldVisit & { settledAt?: number };
type StoredJob = CompanionWorldJob & { memoryVersions?: Array<{ id: string; version: number }>; seedMemoryVersions?: Array<{ id: string; version: number }>;
  maintenanceMemoryVersions?: Array<{ id: string; version: number }>;
  readSet?: Array<{ eventId: string; checksum: string; sourceChecksum?: string; sourceRevision?: number }> };
type StoredEvent = CompanionWorldEvent & { visitId?: string; visitDecision?: 'allow' | 'deny'; privateOwner?: string; witnessIds?: string[]; sourceMemoryIds?: string[]; sourceMessageIds?: string[]; evidence?: Array<{ sourceMessageId: string; quote: string }>; positiveChange?: number; appraisalDay?: string;
  memoryVersions?: Array<{ id: string; version: number }>; relationshipDelta?: { affinity: number; trust: number }; withdrawn?: boolean };
type ClockSegment = { realAt: number; virtualAt: number; settings: CompanionWorldSettings };
type StoredWorld = { sceneVersion?: 2; settings: CompanionWorldSettings; anchors: ClockSegment[]; cursor: number; slots: string[]; actors: StoredActor[];
  works: StoredWork[]; visits: StoredVisit[]; relationships: CompanionWorldRelationship[] };
const iso = (at = Date.now()) => new Date(at).toISOString();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const row = (value: unknown) => value as Row;
// The host normally ticks and persists every 500ms. Read-only management views
// tolerate ten missed cycles before calling a persisted observation a backlog;
// ordinary time between ticks must not claim the world is still catching up.
const OBSERVATION_BACKLOG_GRACE_MS = 5_000;
const observationBacklog = (observedAt: number, now: number) => now - observedAt > OBSERVATION_BACKLOG_GRACE_MS;
const privateRoom = (id: string) => 'world_' + id;
const activeVisit = (visit: StoredVisit) => visit.status === 'requested' || visit.status === 'allowed';
const RECENT_SETTLED_VISITS = 100;
export type CompanionWorldExperienceReceipt = { companionId: string; event: CompanionWorldEvent };

/** World authority lives on the existing UtilityProcess connection. Tick is deterministic, not a second timer or database owner. */
export class CompanionWorldStore {
  private advancing = false;
  private dirty = true;
  private clockAnchors?: ClockSegment[];
  private through = 0;
  private actorProjection: StoredActor[] = [];
  private activeWorld?: StoredWorld;
  private perceptionNextAt = 0;
  private social?: CompanionSocialStore;
  private orders?: CompanionWorkOrderStore;
  private collaborationAllowed?: (input: CompanionWorldScope & { authorizationGrantId: string; sourceMessageId: string; invocationId?: string }) => void;
  private knowledge?: (scope: CompanionWorldScope, args: Extract<CompanionWorldArguments, { action: 'query' }>) => CompanionStorageResponse;
  private topicCommand?: (command: CompanionStorageCommand) => CompanionStorageResponse | undefined;
  private life?: { completePhysical(id: string, companionId: string, outcome: 'done' | 'cancelled', result: string): void };
  private startActivityTask?: (companionId: string, jobId: string, task: { title: string; goal: string }) => void;
  private captureExperience?: (receipt: CompanionWorldExperienceReceipt) => void;
  private atomic<T>(fn: () => T): T {
    try { return this.db.transaction(fn).immediate(); } catch (error) { this.clockAnchors = undefined; this.actorProjection = []; this.activeWorld = undefined; this.through = 0; this.perceptionNextAt = 0; this.dirty = true; throw error; }
  }
  constructor(private readonly db: CompanionConnection, private readonly routineConfig: (id: string) => CompanionRoutineConfig,
    private readonly visibleSources: (scope: CompanionWorldScope, ids: string[]) => CompanionMessage[],
    private readonly runtime: (id: string) => Pick<CompanionRuntimeState, 'energy' | 'mood' | 'expression' | 'affect'>,
    private readonly applyEffect: (event: CompanionWorldEvent) => void,
    private readonly recordMemory: (scope: CompanionWorldScope, candidate: CompanionMemoryCandidate) => CompanionMemory | undefined,
    private readonly memoryRevision: (scope: CompanionWorldScope) => string,
    private readonly prohibitionRevision: (scope: CompanionWorldScope, noteIds?: readonly string[]) => string,
    private readonly integrateMemory?: (scope: CompanionWorldScope, notes: readonly CompanionMemory[], proposal: CompanionStateProposal,
      event: { eventKey: string; kind: 'sleep'; expectedRevision?: number }) => void,
    private readonly recordPrivateMemory?: (scope: CompanionWorldScope, candidate: CompanionMemoryCandidate, worldJobId: string, leaseToken: string) => CompanionMemory | undefined,
    private readonly consolidateMemory?: (scope: CompanionWorldScope, plan: CompanionMemoryConsolidation, worldJobId: string, leaseToken: string) => CompanionMemory | undefined) {}

  connectKnowledge(query: NonNullable<CompanionWorldStore['knowledge']>): void { this.knowledge = query; }
  connectTopics(execute: NonNullable<CompanionWorldStore['topicCommand']>): void { this.topicCommand = execute; }
  queryKnowledge(scope: CompanionWorldScope, args: Extract<CompanionWorldArguments, { action: 'query' }>): CompanionStorageResponse {
    if (!this.knowledge) throw new Error('世界知识查询尚未连接。');
    return this.knowledge(scope, args);
  }
  connectSocial(social: CompanionSocialStore): void { this.social = social; }
  connectWorkOrders(orders: CompanionWorkOrderStore): void { this.orders = orders; }
  connectCollaboration(validate: NonNullable<CompanionWorldStore['collaborationAllowed']>): void { this.collaborationAllowed = validate; }
  connectLife(life: NonNullable<CompanionWorldStore['life']>): void { this.life = life; }
  connectActivity(start: NonNullable<CompanionWorldStore['startActivityTask']>): void { this.startActivityTask = start; }
  /** Synchronous evidence and capture intent share the world event's SQLite transaction. */
  connectExperience(capture: NonNullable<CompanionWorldStore['captureExperience']>): void { this.captureExperience = capture; }
  private ownAddress(owner: string, state = this.load()): CompanionHomeAddress {
    if (!state.slots.includes(owner)) throw new Error('伙伴入口不存在。');
    return { companionId: owner, homeSceneId: 'home_' + owner, entrance: { sceneId: 'home_' + owner, portalId: 'entrance' },
      learnedAt: iso(this.virtualFor(state, state.cursor)), source: 'own_home' };
  }
  homeKnowledge(owner: string, state = this.load()): CompanionHomeAddress[] {
    const own = this.ownAddress(owner, state);
    const learned = (this.db.prepare("SELECT e.data,n.data AS note FROM companion_world_known_entrances e JOIN vcp_memory_notes n ON n.id=e.note_id WHERE e.companion_id=? AND json_extract(n.data,'$.status') IN('queued','indexed') ORDER BY e.rowid DESC LIMIT 50").all(owner) as Row[]).flatMap(found => {
      const address = companionHomeAddressSchema.parse(JSON.parse(String(found.data)));
      const note = parse<CompanionMemory>(found.note);
      if (!note.sources.length || note.sources.some(source => !this.visibleSources({ companionId: owner, conversationId: source.conversationId }, [source.messageId]).length)) return [];
      return [address];
    });
    return [own, ...learned.filter(address => address.companionId !== owner)];
  }
  /** Typed spatial projection from an actual owner-shared receipt, never a general fact engine. */
  learnEntrance(note: CompanionMemory): void {
    this.db.prepare('DELETE FROM companion_world_known_entrances WHERE note_id=?').run(note.id);
    const requested = note.metadata?.learnedEntranceSourceId;
    if (typeof requested !== 'string') return;
    const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('scene-entry-source/' + requested);
    if (!found) throw new Error('入口凭证不存在。');
    const receipt = parse<{ address: unknown; recipients: string[] }>(row(found).value);
    const address = companionHomeAddressSchema.parse(receipt.address);
    const cites = note.sources.some(source => source.messageId === requested || (() => {
      const observation = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + source.messageId);
      return observation && parse<{ sources: Array<{ id: string }> }>(row(observation).value).sources.some(source => source.id === requested);
    })());
    if (!receipt.recipients.includes(note.companionId) || !cites || address.source !== 'owner_shared') throw new Error('不能学习未实际分享给本人的入口。');
    this.db.prepare('INSERT OR REPLACE INTO companion_world_known_entrances(companion_id,target_id,note_id,source_message_id,data) VALUES(?,?,?,?,?)')
      .run(note.companionId, address.companionId, note.id, requested, JSON.stringify(address));
  }
  addressText(owner: string): string {
    const address = this.ownAddress(owner);
    return `我的小屋入口：场景 ${address.entrance.sceneId}，入口 ${address.entrance.portalId}。这是入口信息，不代表拜访邀请；想来时先问我是否方便。`;
  }
  shareHome(owner: string, recipients: string[], source: CompanionMessage): void {
    if (source.authorId !== owner || source.status !== 'sent') throw new Error('住址只能由房主本人的正式消息分享。');
    const address = { ...this.ownAddress(owner), source: 'owner_shared' as const, sourceMessageId: source.id, sourceConversationId: source.conversationId };
    for (const recipient of recipients) if (recipient !== 'user' && recipient !== owner
      && !this.visibleSources({ companionId: recipient, conversationId: source.conversationId }, [source.id]).length) throw new Error('入口接收者不在真实消息范围内。');
    // Sharing produces verifiable external evidence; it does not teach the recipients.
    this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('scene-entry-source/' + source.id, JSON.stringify({ address, recipients }));
  }
  tagTaskMovement(companionId: string, taskId: string): void {
    const state = this.load(), actor = state.actors.find(actor => actor.companionId === companionId);
    if (actor && (actor.route.length || actor.journey)) { actor.navigationTaskId = taskId; this.save(state); }
  }
  stopTaskMovement(scope: CompanionWorldScope, destination: { sceneId?: string; x?: number; y?: number }, taskId: string): void {
    this.atomic(() => {
      const state = this.load(), actor = state.actors.find(actor => actor.companionId === scope.companionId), end = actor?.route.at(-1);
      if (!actor || actor.navigationTaskId !== taskId || !(actor.journey?.targetSceneId === destination.sceneId || end && end.sceneId === destination.sceneId && end.x === destination.x && end.y === destination.y)) return;
      delete actor.navigationTaskId;
      actor.route = []; delete actor.journey; delete actor.destinationId; delete actor.arrivalActivity; delete actor.manualActivityUntil;
      if (actor.activity === 'walking') actor.activity = 'idle';
      if (actor.phoneResume?.activity === 'walking') actor.phoneResume.activity = 'idle';
      if (actor.transition?.after === 'walking') actor.transition.after = 'idle';
      this.event(state, { kind: 'navigation_cancelled', actorId: actor.companionId, sceneId: actor.sceneId, conversationId: scope.conversationId, text: '所属行动任务停止，取消剩余路径并保留当前位置。' }); this.save(state);
    });
  }
  perception(companionId: string): CompanionWorldPerception | undefined {
    const found = this.db.prepare('SELECT data FROM companion_world_perceptions WHERE companion_id=?').get(companionId);
    return found ? parse<CompanionWorldPerception>(row(found).data) : undefined;
  }
  private refreshPerceptions(state: StoredWorld, target: number, observingCompanionId?: string): void {
    // Perception samples the reached present once, never invents observations
    // along an unobserved offline route or scales with observer window count.
    if (state.cursor + 1 < target) return;
    const periodicDue = state.cursor >= this.perceptionNextAt;
    const observingActor = observingCompanionId ? state.actors.find(actor => actor.companionId === observingCompanionId) : undefined;
    const priorObservation = observingActor ? this.perception(observingActor.companionId) : undefined;
    const observerMoved = !!observingActor && (!priorObservation || priorObservation.sceneId !== observingActor.sceneId
      || priorObservation.activity !== observingActor.activity || Math.hypot(priorObservation.position.x - observingActor.position.x, priorObservation.position.y - observingActor.position.y) > .000001);
    if (!periodicDue && !observerMoved) return;
    const scenes = this.scenes(state), virtualAt = this.virtualFor(state, state.cursor), climate = companionWorldEnvironment(virtualAt, state.settings.timeZone);
    let nextSampleAt = state.cursor + COMPANION_WORLD_PERCEPTION_INTERVAL_MS;
    for (const actor of state.actors) {
      if (!periodicDue && actor.companionId !== observingCompanionId) continue;
      const saved = this.db.prepare('SELECT data,last_event_at,last_signature FROM companion_world_perceptions WHERE companion_id=?').get(actor.companionId), previous = saved ? parse<CompanionWorldPerception>(row(saved).data) : undefined;
      if ((actor.companionId !== observingCompanionId || !observerMoved) && previous && previous.sceneId === actor.sceneId && previous.awake === (actor.activity !== 'sleeping')
        && state.cursor < Date.parse(previous.observedAtReal) + COMPANION_WORLD_PERCEPTION_INTERVAL_MS) {
        nextSampleAt = Math.min(nextSampleAt, Date.parse(previous.observedAtReal) + COMPANION_WORLD_PERCEPTION_INTERVAL_MS); continue;
      }
      const perception = sampleCompanionWorldPerception({ self: actor, scenes, actors: state.actors, environment: { ...climate.environment, daylight: climate.clock.daylight },
        virtualAt: iso(virtualAt), realAt: iso(state.cursor), previous });
      let lastEvent = saved ? Number(row(saved).last_event_at) : 0;
      let lastSignature = saved ? String(row(saved).last_signature) : '';
      const signature = companionWorldPerceptionSignature(perception), changed = signature !== lastSignature;
      if (changed && (!previous || previous.sceneId !== perception.sceneId || previous.awake !== perception.awake || state.cursor - lastEvent >= 10000)) {
        this.event(state, { kind: 'perception', actorId: actor.companionId, privateOwner: actor.companionId, sceneId: actor.sceneId,
          text: perception.awake ? `观察周围：范围${Math.round(perception.radius)}格，看到${perception.visibleObjectIds.length}件物体、${perception.visibleCompanionIds.length}位伙伴，更新自己的环境认知。` : '进入睡眠，停止视觉感知，先前观察仅保留为历史认知。',
          perception: { revision: perception.revision, radius: perception.radius, visibleObjectIds: perception.visibleObjectIds, visibleCompanionIds: perception.visibleCompanionIds, environment: perception.environment } });
        lastEvent = state.cursor;
        lastSignature = signature;
      }
      this.db.prepare('INSERT INTO companion_world_perceptions(companion_id,last_event_at,last_signature,samples,data) VALUES(?,?,?,1,?) ON CONFLICT(companion_id) DO UPDATE SET last_event_at=excluded.last_event_at,last_signature=excluded.last_signature,samples=samples+1,data=excluded.data')
        .run(actor.companionId, lastEvent, lastSignature, JSON.stringify(perception));
    }
    this.perceptionNextAt = periodicDue ? nextSampleAt : Math.min(this.perceptionNextAt, nextSampleAt);
  }
  socialContext(observeOnly = false): { timeZone: string; virtualNow: string; observedDay: string; backlog: boolean } {
    const now = Date.now(); if (!observeOnly) this.ensureThrough(now); const state = this.load(), at = this.virtualFor(state, observeOnly ? now : state.cursor), day = companionTimeInZone(at, state.settings.timeZone);
    return { timeZone: state.settings.timeZone, virtualNow: iso(at), observedDay: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`, backlog: state.cursor + 1 < now };
  }
  contactState(owner: string): CompanionContactState {
    if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1").get(owner)) return 'dormant';
    const state = this.load(), actor = state.actors.find(actor => actor.companionId === owner);
    if (!actor) return 'busy';
    if (actor.socialPause || this.socialInterrupt(owner, state.cursor)) return 'busy';
    const planned = evaluateCompanionRoutine(this.routineConfig(owner), iso(this.virtualFor(state, state.cursor))).phase;
    if (actor.activity === 'working' || state.works.some(work => work.companionId === owner && work.kind !== 'chat' && work.status !== 'ended')) return 'working';
    if (['sleeping', 'lyingDown', 'waking'].includes(actor.activity) || planned === 'sleeping') return 'sleeping';
    if (actor.activity === 'eating' || planned === 'eating') return 'eating';
    return this.phoneAvailable(state, actor) ? 'available' : 'busy';
  }
  private status(ids: string[]) {
    const clock = this.clock(), state = this.load();
    const contacts = [...new Set(ids)].map(companionId => ({ companionId, state: this.contactState(companionId) }));
    const interactions: CompanionInteraction[] = [];
    const add = (companionId: string, conversationId: string, recipientIds: string[], phase: CompanionInteraction['phase'], channel: CompanionInteraction['channel']) => {
      if (interactions.some(item => item.companionId === companionId && item.conversationId === conversationId)) return;
      interactions.push({ companionId, conversationId, recipientIds, phase, channel,
        recipients: recipientIds.filter(id => id !== 'user').map(companionId => ({ companionId, state: this.contactState(companionId) })) });
    };
    for (const contact of contacts) {
      if (contact.state === 'dormant') continue;
      const id = contact.companionId, chat = state.works.find(work => work.companionId === id && work.kind === 'chat' && work.status === 'ready');
      if (chat) add(id, chat.conversationId, ['user'], 'responding', 'phone');
      const current = this.db.prepare('SELECT data FROM companion_social_communication WHERE companion_id=? AND until_real>?').get(id, iso());
      if (current) { const comm = parse<NonNullable<CompanionWorldActor['communication']>>(row(current).data); add(id, comm.conversationId, comm.recipientIds, comm.phase, comm.channel); }
      for (const value of this.db.prepare("SELECT data FROM companion_social_outbox WHERE companion_id=? AND status='pending' ORDER BY rowid DESC LIMIT 3").all(id) as Row[]) {
        const send = parse<{ conversationId: string; channel: 'phone' | 'face_to_face' }>(value.data);
        const recipients = (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? AND companion_id<>?').all(send.conversationId, id) as Row[]).map(member => String(member.companion_id));
        add(id, send.conversationId, recipients, 'queued', send.channel);
      }
      for (const value of this.db.prepare("SELECT j.data FROM companion_social_jobs j JOIN messages m ON m.id=json_extract(j.data,'$.sourceMessageId') WHERE m.author_id=? AND j.status IN('pending','running','failed') AND COALESCE(json_extract(j.data,'$.terminal'),0)=0 ORDER BY j.rowid DESC LIMIT 3").all(id) as Row[]) {
        const job = parse<{ companionId: string; conversationId: string; channel: 'phone' | 'face_to_face' }>(value.data);
        add(id, job.conversationId, [job.companionId], 'waiting', job.channel);
      }
    }
    return { clock, environment: companionWorldEnvironment(Date.parse(clock.virtualNow), clock.timeZone).environment, contacts, interactions: interactions.slice(0, 60) };
  }
  recordPriorityEvent(kind: 'social_interrupt' | 'social_resume', owner: string, sourceId: string): void {
    const source = this.db.prepare('SELECT author_id,conversation_id FROM messages WHERE id=?').get(sourceId) as { author_id: string; conversation_id: string } | undefined;
    if (source?.author_id !== 'user') return;
    const state = this.load();
    const event = this.event(state, { kind, actorId: kind === 'social_interrupt' ? 'user' : owner, targetId: kind === 'social_interrupt' ? owner : 'user',
      sourceMessageId: sourceId, conversationId: source.conversation_id, privateOwner: owner,
      text: kind === 'social_interrupt' ? '开始优先处理玩家的真实紧急联系。' : '紧急处理结束，恢复保留的原有安排。' });
    if (kind === 'social_interrupt') this.applyEffect(event);
    this.save(state);
  }
  interruptSocial(owner: string, source: CompanionSocialMessage): void {
    const state = this.load(), actor = state.actors.find(actor => actor.companionId === owner);
    if (!actor || source.message.authorId === owner || !source.recipientIds.includes(owner)) return;
    const existing = this.db.prepare('SELECT 1 FROM companion_social_interruptions WHERE companion_id=? AND source_id=?').get(owner, source.message.id);
    if (existing) return;
    if (this.db.prepare('SELECT 1 FROM companion_social_interruptions WHERE companion_id=? AND author_id=? AND starts_at>? LIMIT 1').get(owner, source.message.authorId, state.cursor - 120000)) return;
    this.db.prepare("INSERT INTO companion_social_interruptions VALUES(?,?,?,?,?,?,'active',?)").run(owner, source.message.id, source.message.authorId, source.message.conversationId, state.cursor, state.cursor + 120000, createHash('sha256').update(source.message.content).digest('hex'));
    const event = this.event(state, { kind: 'social_interrupt', actorId: source.message.authorId, targetId: owner, text: '收到真实伙伴的紧急联系，暂缓当前活动以处理来信。', sourceMessageId: source.message.id, conversationId: source.message.conversationId });
    this.applyEffect(event);
    this.planRoutine(state, actor); this.dirty = true; this.save(state);
  }
  endSocialInterrupt(owner: string, sourceId: string): void {
    this.db.prepare("UPDATE companion_social_interruptions SET status='done' WHERE companion_id=? AND source_id=?").run(owner, sourceId);
    this.dirty = true;
  }
  private socialInterrupt(owner: string, at: number): { source_id: string; author_id: string; conversation_id: string } | undefined {
    const found = this.db.prepare("SELECT i.*,m.content,m.status AS message_status FROM companion_social_interruptions i JOIN messages m ON m.id=i.source_id WHERE i.companion_id=? AND i.status='active' AND i.until_real>? ORDER BY i.starts_at LIMIT 1").get(owner, at);
    if (!found) return undefined; const value = row(found);
    if (value.message_status !== 'sent' || createHash('sha256').update(String(value.content)).digest('hex') !== value.checksum) { this.endSocialInterrupt(owner, String(value.source_id)); return undefined; }
    return { source_id: String(value.source_id), author_id: String(value.author_id), conversation_id: String(value.conversation_id) };
  }
  socialAvailable(owner: string, channel: 'phone' | 'face_to_face', recipients: string[]): boolean {
    if (![owner, ...recipients].every(id => this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1").get(id))) return false;
    const state = this.load(), actor = state.actors.find(actor => actor.companionId === owner);
    if (!actor) return false;
    // Message processing is independent of the single rendered body. Actual
    // visits and face-to-face speech still require physical admission below.
    if (channel === 'phone') return true;
    return this.faceGroupAvailable(state, [owner, ...recipients]);
  }
  private faceMemberAvailable(state: StoredWorld, actor: StoredActor): boolean {
    const owner = state.slots.find(id => 'home_' + id === actor.sceneId);
    if (owner && !this.permitted(state, actor.companionId, owner)) return false;
    return !actor.transition && !['working', 'eating', 'sleeping', 'lyingDown', 'waking', 'seating', 'standingUp'].includes(actor.activity)
      && !['eating', 'sleeping'].includes(evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor))).phase)
      && !state.works.some(work => work.companionId === actor.companionId && work.status !== 'ended' && (work.kind !== 'chat' || work.status === 'ready'))
      && !this.peerPhoneActive(actor.companionId, state.cursor)
      && !this.db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status IN('queued','running') LIMIT 1").get(actor.companionId);
  }
  private faceGroupAvailable(state: StoredWorld, ids: string[]): boolean {
    if (ids.length < 2 || new Set(ids).size !== ids.length) return false;
    const actors = ids.map(id => state.actors.find(actor => actor.companionId === id));
    return actors.every(actor => actor && this.faceMemberAvailable(state, actor) && (() => {
      const sense = this.perception(actor.companionId);
      return sense?.awake && sense.sceneId === actor.sceneId && state.cursor - Date.parse(sense.observedAtReal) <= 2000
        && ids.every(id => id === actor.companionId || sense.visibleCompanionIds.includes(id));
    })() && (() => { const communication = this.faceCommunication(actor.companionId, state.cursor);
      return !communication || communication.recipientIds.length === ids.length - 1 && communication.recipientIds.every(id => ids.includes(id)); })() && actors.every(peer => peer && peer.sceneId === actor.sceneId
      && Math.hypot(peer.position.x - actor.position.x, peer.position.y - actor.position.y) <= 5));
  }
  private faceCommunication(owner: string, now: number): CompanionWorldActor['communication'] {
    const found = this.db.prepare("SELECT data FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.channel')='face_to_face'").get(owner, iso(now));
    return found ? parse<NonNullable<CompanionWorldActor['communication']>>(row(found).data) : undefined;
  }
  routineCanRespond(owner: string, allowWake: boolean): boolean {
    const state = this.advancing && this.activeWorld ? this.activeWorld : this.load(), actor = state.actors.find(actor => actor.companionId === owner);
    void allowWake;
    return !!actor && !!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1").get(owner);
  }
  private phoneAvailable(state: StoredWorld, actor: StoredActor, allowWake = false): boolean {
    const urgent = !!this.socialInterrupt(actor.companionId, state.cursor); allowWake ||= urgent;
    const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
    return (!urgent || !actor.transition && !['sleeping','lyingDown','waking','eating','working'].includes(actor.activity)) && (allowWake || !['sleeping', 'eating'].includes(phase.phase)) && (allowWake ? urgent || actor.activity !== 'working' : !['sleeping', 'lyingDown', 'waking', 'eating', 'working'].includes(actor.activity))
      && !(actor.meetingHold && actor.meetingHold.untilReal > state.cursor) && !this.faceCommunication(actor.companionId, state.cursor)
      && (urgent || !state.works.some(work => work.companionId === actor.companionId && work.kind !== 'chat' && work.status !== 'ended'))
      && (urgent || !this.db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status IN('queued','running') LIMIT 1").get(actor.companionId));
  }
  private peerPhoneActive(owner: string, now: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing' UNION ALL SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(owner, iso(now), owner, iso(now));
  }
  recordSocialSpeech(message: CompanionSocialMessage, channel: 'phone' | 'face_to_face'): void {
    const state = this.load(), owner = message.message.authorId, actor = state.actors.find(actor => actor.companionId === owner);
    for (const recipient of message.recipientIds) this.event(state, { kind: channel === 'phone' ? 'social_phone' : 'social_talk', actorId: owner, targetId: recipient, sceneId: channel === 'phone' ? undefined : actor?.sceneId,
      text: message.message.content, sourceMessageId: message.message.id, conversationId: message.message.conversationId });
    for (const peer of message.recipientIds) for (const [from, to] of [[owner, peer], [peer, owner]]) {
      let relation = state.relationships.find(item => item.companionId === from && item.targetCompanionId === to);
      if (!relation) { relation = { companionId: from!, targetCompanionId: to!, affinity: 50, trust: 50, interactions: 0, updatedAt: message.virtualCreatedAt }; state.relationships.push(relation); }
      relation.interactions++; relation.updatedAt = message.virtualCreatedAt;
    }
    this.save(state);
  }

  initialize(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_world_suspended(companion_id TEXT PRIMARY KEY REFERENCES companions(id),data TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_world_known_entrances(companion_id TEXT NOT NULL,target_id TEXT NOT NULL,note_id TEXT NOT NULL,source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,data TEXT NOT NULL,PRIMARY KEY(companion_id,target_id))');
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_world_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_world_jobs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),kind TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_job_status ON companion_world_jobs(kind,status,lease_until);`);
    this.db.exec("CREATE TABLE IF NOT EXISTS companion_world_perceptions(companion_id TEXT PRIMARY KEY REFERENCES companions(id),last_event_at INTEGER NOT NULL,last_signature TEXT NOT NULL DEFAULT '',samples INTEGER NOT NULL,data TEXT NOT NULL)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world_occupancy(id INTEGER PRIMARY KEY AUTOINCREMENT,companion_id TEXT NOT NULL,phase TEXT NOT NULL,habit_id TEXT,habit_kind TEXT,starts_at INTEGER NOT NULL,ends_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS companion_world_occupancy_open ON companion_world_occupancy(companion_id) WHERE ends_at IS NULL;
      CREATE INDEX IF NOT EXISTS companion_world_occupancy_time ON companion_world_occupancy(companion_id,starts_at);
      CREATE TABLE IF NOT EXISTS companion_world_attention(companion_id TEXT NOT NULL,source_message_id TEXT NOT NULL,checksum TEXT NOT NULL,urgency TEXT NOT NULL,confidence REAL NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(companion_id,source_message_id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world_work_records(work_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_work_status ON companion_world_work_records(companion_id,status);
      CREATE TABLE IF NOT EXISTS companion_world_peer_appraisals(companion_id TEXT NOT NULL,event_id TEXT NOT NULL,target_id TEXT NOT NULL,source_message_id TEXT,day TEXT NOT NULL,positive_change REAL NOT NULL,affinity_delta REAL NOT NULL,trust_delta REAL NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(companion_id,event_id));
      CREATE INDEX IF NOT EXISTS companion_world_peer_budget ON companion_world_peer_appraisals(companion_id,day,active);
      CREATE INDEX IF NOT EXISTS companion_world_peer_source ON companion_world_peer_appraisals(companion_id,source_message_id,active);
      CREATE INDEX IF NOT EXISTS companion_world_event_effects ON companion_world_events(sequence) WHERE json_extract(data,'$.effect') IS NOT NULL;`);
    this.db.exec("CREATE TABLE IF NOT EXISTS companion_social_interruptions(companion_id TEXT NOT NULL,source_id TEXT NOT NULL,author_id TEXT NOT NULL,conversation_id TEXT NOT NULL,starts_at INTEGER NOT NULL,until_real INTEGER NOT NULL,status TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(companion_id,source_id)); CREATE INDEX IF NOT EXISTS companion_social_interrupt_active ON companion_social_interruptions(companion_id,status,until_real)");
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_world_dream_watermark(companion_id TEXT NOT NULL,memory_id TEXT NOT NULL,version INTEGER NOT NULL,processed_at TEXT NOT NULL,PRIMARY KEY(companion_id,memory_id,version))');
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world_sleep_episodes(companion_id TEXT NOT NULL,episode_id TEXT NOT NULL,virtual_at INTEGER NOT NULL,
      roll REAL NOT NULL,admitted INTEGER NOT NULL,job_id TEXT,PRIMARY KEY(companion_id,episode_id));
      CREATE INDEX IF NOT EXISTS companion_world_sleep_recent ON companion_world_sleep_episodes(companion_id,admitted,virtual_at DESC)`);
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_world_encounters(pair_key TEXT PRIMARY KEY,left_id TEXT NOT NULL,right_id TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS companion_world_encounter_left ON companion_world_encounters(left_id); CREATE INDEX IF NOT EXISTS companion_world_encounter_right ON companion_world_encounters(right_id)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world_visit_records(id TEXT PRIMARY KEY,guest_id TEXT NOT NULL,host_id TEXT NOT NULL,status TEXT NOT NULL,settled_at INTEGER,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_visit_history ON companion_world_visit_records(guest_id,host_id,status,settled_at DESC);
      CREATE TABLE IF NOT EXISTS companion_world_clock_segments(revision INTEGER PRIMARY KEY,real_at INTEGER NOT NULL,virtual_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_clock_real ON companion_world_clock_segments(real_at DESC,revision DESC);
      CREATE INDEX IF NOT EXISTS companion_world_clock_virtual ON companion_world_clock_segments(virtual_at DESC,revision DESC);`);
    this.atomic(() => { const state = this.load(); this.sync(state);
    // The stopped process did no external work during its absence. Keep positions
    // and routes; close only computer reservations belonging to that process.
    for (const work of state.works) if (work.status !== 'ended') work.status = 'ended';
    for (const actor of state.actors) this.releasePhone(actor, state.cursor);
    for (const actor of state.actors) if (actor.activity === 'working' || actor.activity === 'seating' && actor.transition?.after === 'working') {
      if (actor.transition?.eventId) this.event(state, { kind: 'behavior_interrupted', actorId: actor.companionId, sceneId: actor.sceneId,
        text: '执行进程已经停止，结束未完成的电脑就座动作', behavior: { id: actor.transition.eventId, kind: actor.transition.action ?? 'seating', phase: 'interrupted', targetId: actor.furnitureId } });
      delete actor.transition; actor.activity = 'idle'; actor.route = []; delete actor.furnitureId; delete actor.destinationId;
    }
    this.repairObstructedRoutes(state);
    this.save(state); });
  }
  private load(): StoredWorld {
    const existing = this.db.prepare('SELECT data FROM companion_world WHERE id=1').get();
    if (existing) {
      const state = parse<StoredWorld>(row(existing).data);
      if (state.sceneVersion !== 2) {
        state.sceneVersion = 2; state.actors = []; state.works = []; state.visits = [];
        this.db.exec('DELETE FROM companion_world_suspended; DELETE FROM companion_world_perceptions; DELETE FROM companion_world_encounters;');
        this.db.prepare("UPDATE companion_world_work_records SET status='ended',data=json_set(data,'$.status','ended')").run();
        this.save(state);
      }
      this.rememberClock(state); return state;
    }
    const now = Date.now(), settings: CompanionWorldSettings = { ...COMPANION_WORLD_DEFAULT_SETTINGS, revision: 1, timeZone: resolveCompanionScheduleTimeZone('system') };
    const fresh: StoredWorld = { sceneVersion: 2, settings, anchors: [{ realAt: now, virtualAt: now, settings }], cursor: now, slots: [], actors: [], works: [], visits: [], relationships: [] };
    this.save(fresh); return fresh;
  }
  private rememberClock(state: StoredWorld): void { this.clockAnchors = state.anchors; this.through = state.cursor; this.actorProjection = state.actors; this.activeWorld = state; }
  changed(): void { this.dirty = true; this.perceptionNextAt = 0; }
  resetCompanion(id: string): void {
    this.db.prepare('DELETE FROM companion_world_perceptions WHERE companion_id=?').run(id); this.perceptionNextAt = 0;
    this.db.prepare('DELETE FROM companion_world_encounters WHERE left_id=? OR right_id=?').run(id, id);
    const state = this.load();
    state.actors = state.actors.filter(actor => actor.companionId !== id);
    this.db.prepare('DELETE FROM companion_world_suspended WHERE companion_id=?').run(id);
    // Dormant visitors must not resume an obsolete visit when later activated.
    this.db.prepare(`UPDATE companion_world_suspended SET data=json_remove(json_set(data,
      '$.actor.sceneId',json_extract(data,'$.actor.homeSceneId'),'$.actor.position',json('{"x":10,"y":13}'),
      '$.actor.route',json('[]'),'$.actor.activity','idle'),
      '$.actor.journey','$.actor.transition','$.actor.furnitureId','$.actor.destinationId','$.actor.arrivalActivity',
      '$.actor.meetingHold','$.actor.meetingResume','$.actor.socialPause','$.actor.afterWork')
      WHERE json_extract(data,'$.actor.sceneId')=? OR json_extract(data,'$.actor.journey.targetSceneId')=?`).run('home_' + id, 'home_' + id);
    state.works = state.works.filter(work => work.companionId !== id);
    state.visits = state.visits.filter(visit => visit.guestId !== id && visit.hostId !== id);
    state.relationships = state.relationships.filter(relation => relation.companionId !== id && relation.targetCompanionId !== id);
    for (const actor of state.actors) {
      if (actor.meetingHold?.memberIds.includes(id)) this.releaseMeeting(actor, true);
      if (actor.socialPause?.authorId === id) { delete actor.socialPause; actor.route = []; actor.activity = 'idle'; }
      const after = actor.afterWork?.args;
      if (after && ('targetCompanionId' in after && after.targetCompanionId === id || 'recipientIds' in after && after.recipientIds?.includes(id))) delete actor.afterWork;
      if (actor.sceneId !== 'home_' + id && !actor.route.some(point => point.sceneId === 'home_' + id) && actor.journey?.targetSceneId !== 'home_' + id) continue;
      const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId);
      if (home) this.move(state, actor, home, { x: 10, y: 13 }, actor.homeSceneId, 'idle');
      for (const work of state.works) if (work.companionId === actor.companionId) { work.status = 'waiting'; delete work.computerId; }
    }
    this.syncOccupancy(state); this.save(state); this.dirty = true;
  }
  private save(state: StoredWorld): void {
    this.atomic(() => {
      const upsert = this.db.prepare('INSERT INTO companion_world_work_records(work_id,companion_id,status,data) VALUES(?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET status=excluded.status,data=excluded.data WHERE data!=excluded.data');
      for (const work of state.works) upsert.run(work.workId, work.companionId, work.status, JSON.stringify(work));
      state.works = state.works.filter(work => work.status !== 'ended');
      // Retain the complete audit trail on disk, while every physics tick reads
      // only current permissions and a bounded window of recently settled visits.
      const visits = this.db.prepare('INSERT INTO companion_world_visit_records(id,guest_id,host_id,status,settled_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,settled_at=excluded.settled_at,data=excluded.data WHERE data!=excluded.data');
      for (const visit of state.visits) {
        if (!activeVisit(visit)) visit.settledAt ??= state.cursor;
        visits.run(visit.id, visit.guestId, visit.hostId, visit.status, visit.settledAt ?? null, JSON.stringify(visit));
      }
      const recent = new Set(state.visits.filter(visit => !activeVisit(visit))
        .sort((a, b) => a.settledAt! - b.settledAt! || Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-RECENT_SETTLED_VISITS).map(visit => visit.id));
      state.visits = state.visits.filter(visit => activeVisit(visit) || recent.has(visit.id));
      // Historical conversions are still needed by physical energy/habit
      // accounting. Indexed segments preserve those conversions without keeping
      // all past mode edits in the hot world JSON or copying them on every lookup.
      const clocks = this.db.prepare('INSERT OR IGNORE INTO companion_world_clock_segments(revision,real_at,virtual_at,data) VALUES(?,?,?,?)');
      for (const anchor of state.anchors) clocks.run(anchor.settings.revision, anchor.realAt, anchor.virtualAt, JSON.stringify(anchor));
      state.anchors = state.anchors.slice(-1);
      this.db.prepare('INSERT INTO companion_world(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(state));
    });
    this.rememberClock(state);
  }
  ensureThrough(now: number): number {
    if (!this.clockAnchors) this.load();
    if (!this.advancing && (this.through < now || this.dirty)) this.advance(now);
    return Math.min(now, this.through);
  }
  occupancy(companionId: string, from: number, to: number): CompanionWorldOccupancy[] {
    const end = Math.min(to, this.through);
    return (this.db.prepare('SELECT * FROM companion_world_occupancy WHERE companion_id=? AND COALESCE(ends_at,?)>? AND starts_at<? ORDER BY starts_at').all(companionId, end, from, end) as Row[]).map(value => ({
      start: Math.max(from, Number(value.starts_at)), end: Math.min(end, Number(value.ends_at ?? end)), phase: value.phase as CompanionWorldOccupancy['phase'],
      ...(value.habit_id ? { habitId: String(value.habit_id) } : {}), ...(value.habit_kind ? { habitKind: String(value.habit_kind) as CompanionWorldOccupancy['habitKind'] } : {}),
    }));
  }
  actual(companionId: string, now: number): { phase: 'awake' | 'sleeping' | 'eating' | 'resting' | 'habit'; activity?: string; activeHabitId?: string } {
    this.ensureThrough(now); const actor = this.actorProjection.find(actor => actor.companionId === companionId);
    if (!actor) return { phase: 'awake' };
    if (actor.parkWalk && actor.activity === 'walking') return { phase: actor.parkWalk.stage === 'strolling' ? 'habit' : 'awake',
      activity: actor.parkWalk.stage === 'travelling' ? '正在步行前往公共花园' : actor.parkWalk.stage === 'returning' ? '散步后正在步行回家' : '在公共花园散步放松' };
    if (actor.transition) return { phase: 'awake', activity: actor.activity === 'lyingDown' ? '正在床上躺下，尚未入睡' : actor.activity === 'waking' ? '正在醒来起床' : actor.activity === 'standingUp' ? '正在起身准备行动' : actor.activity === 'seating' ? '正在家具前坐下' : '正在转身' };
    if (actor.activity === 'walking') return { phase: 'awake', activity: '正在前往' + (actor.destinationId?.endsWith('_bed') ? '床边准备睡觉' : actor.destinationId?.endsWith('_dining') ? '餐桌准备吃饭' : actor.destinationId?.endsWith('_sofa') ? '沙发准备休息' : actor.destinationId?.endsWith('_computer') ? '电脑前' : '日常活动地点') };
    if (['sleeping', 'eating', 'resting', 'habit'].includes(actor.activity)) {
      const planned = evaluateCompanionRoutine(this.routineConfig(companionId), iso(this.virtualAt(this.through)));
      return { phase: actor.activity as 'sleeping' | 'eating' | 'resting' | 'habit', activity: actor.activity === 'habit' ? planned.activity : actor.activity === 'sleeping' ? '在床上睡眠' : actor.activity === 'eating' ? '在餐桌用餐' : actor.recovery ? '精力不足，正在沙发上恢复' : '在家具旁休息', ...(actor.activity === 'habit' && planned.activeHabitId ? { activeHabitId: planned.activeHabitId } : {}) };
    }
    return { phase: 'awake', ...(actor.activity === 'working' ? { activity: '正在电脑前处理已答应的事' } : actor.activity === 'seating' ? { activity: '正在电脑前坐稳' } : {}) };
  }
  private syncOccupancy(state: StoredWorld): void {
    const present = new Set(state.actors.map(actor => actor.companionId));
    for (const open of this.db.prepare('SELECT id,companion_id FROM companion_world_occupancy WHERE ends_at IS NULL').all() as Row[]) if (!present.has(String(open.companion_id))) this.db.prepare('UPDATE companion_world_occupancy SET ends_at=? WHERE id=?').run(state.cursor, open.id);
    for (const actor of state.actors) {
      const strolling = actor.parkWalk?.stage === 'strolling' && actor.sceneId === 'park' && actor.activity === 'walking' && actor.route.length > 0;
      const phase = strolling ? 'habit' : ['sleeping', 'eating', 'resting', 'habit'].includes(actor.activity) && !actor.route.length && actor.furnitureId ? actor.activity : undefined;
      const config = this.routineConfig(actor.companionId), planned = evaluateCompanionRoutine(config, iso(this.virtualFor(state, state.cursor)));
      const habitId = strolling ? undefined : phase === 'habit' || phase === 'resting' ? planned.activeHabitId : undefined,
        habitKind = strolling ? 'exercise' : config.habits.find(habit => habit.id === habitId)?.kind;
      const open = this.db.prepare('SELECT * FROM companion_world_occupancy WHERE companion_id=? AND ends_at IS NULL').get(actor.companionId);
      if (open && row(open).phase === phase && (row(open).habit_id ?? undefined) === habitId && (row(open).habit_kind ?? undefined) === habitKind) continue;
      if (open) this.db.prepare('UPDATE companion_world_occupancy SET ends_at=? WHERE id=?').run(state.cursor, row(open).id);
      if (phase) this.db.prepare('INSERT INTO companion_world_occupancy(companion_id,phase,habit_id,habit_kind,starts_at) VALUES(?,?,?,?,?)').run(actor.companionId, phase, habitId ?? null, habitKind ?? null, state.cursor);
    }
  }
  urgent(companionId: string, sourceMessageId: string, now = Date.now()): boolean {
    const saved = this.db.prepare("SELECT a.*,m.content,m.created_at FROM companion_world_attention a JOIN messages m ON m.id=a.source_message_id WHERE a.companion_id=? AND a.source_message_id=?").get(companionId, sourceMessageId);
    if (!saved) return false; const value = row(saved);
    return value.urgency === 'urgent' && Number(value.confidence) >= .85 && now >= Number(value.at) && now - Number(value.at) < 1800000 && now >= Date.parse(String(value.created_at)) && now - Date.parse(String(value.created_at)) < 1800000 &&
      value.checksum === createHash('sha256').update(String(value.content)).digest('hex');
  }
  private recordAttention(command: Extract<CompanionStorageCommand, { type: 'world.attention.record' }>): void {
    this.requireScope(command); const source = this.visibleSources(command, [command.sourceMessageId])[0];
    if (!source || source.authorId !== 'user' || source.conversationId !== command.conversationId || createHash('sha256').update(source.content).digest('hex') !== command.sourceChecksum || command.evidence.some(quote => !source.content.includes(quote))) throw new Error('通知判断缺少真实用户原话证据。');
    const previous = this.db.prepare('SELECT * FROM companion_world_attention WHERE companion_id=? AND source_message_id=?').get(command.companionId, source.id);
    if (previous && row(previous).checksum !== command.sourceChecksum) throw new Error('通知来源已经修改。');
    if (previous && Number(row(previous).confidence) >= command.confidence) return;
    this.db.prepare('INSERT INTO companion_world_attention(companion_id,source_message_id,checksum,urgency,confidence,at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(companion_id,source_message_id) DO UPDATE SET urgency=excluded.urgency,confidence=excluded.confidence,data=excluded.data').run(command.companionId, source.id, command.sourceChecksum, command.urgency, command.confidence, Date.now(), JSON.stringify(command));
    const state = this.load(); for (const work of state.works) if (work.companionId === command.companionId && work.sourceMessageId === source.id && work.status !== 'ended') work.urgent = this.urgent(command.companionId, source.id);
    this.dirty = true; this.save(state);
  }
  private clockAnchor(anchors: ClockSegment[], at: number): ClockSegment {
    const latest = anchors.at(-1)!;
    if (latest.realAt <= at) return latest;
    const found = this.db.prepare('SELECT data FROM companion_world_clock_segments WHERE real_at<=? ORDER BY real_at DESC,revision DESC LIMIT 1').get(at)
      ?? this.db.prepare('SELECT data FROM companion_world_clock_segments ORDER BY real_at,revision LIMIT 1').get();
    return found ? parse<ClockSegment>(row(found).data) : anchors[0]!;
  }
  virtualAt(realAt = Date.now(), referenceRealAt = realAt): number { if (!this.clockAnchors) this.load(); const anchor = this.clockAnchor(this.clockAnchors!, referenceRealAt); return companionWorldVirtualAt(anchor, anchor.settings, realAt); }
  realAt(virtualAt: number, referenceRealAt = this.through): number { if (!this.clockAnchors) this.load(); const anchor = this.clockAnchor(this.clockAnchors!, referenceRealAt); return companionWorldRealAt(anchor, anchor.settings, virtualAt); }
  clockBoundaries(from: number, to: number): number[] { return (this.db.prepare('SELECT real_at FROM companion_world_clock_segments WHERE real_at>? AND real_at<? ORDER BY real_at,revision').all(from, to) as Row[]).map(value => Number(value.real_at)); }
  timeZone(): string { if (!this.clockAnchors) this.load(); return this.clockAnchors!.at(-1)!.settings.timeZone; }
  elapsedVirtual(from: number, to: number): number {
    let cursor = from, elapsed = 0;
    for (const end of [...this.clockBoundaries(from, to), to]) { if (end > cursor) elapsed += Math.max(0, this.virtualAt(end, cursor) - this.virtualAt(cursor)); cursor = end; }
    return elapsed;
  }
  clock(since?: string[]) {
    const now = Date.now(), observedAt = this.ensureThrough(now), state = this.load();
    return { realNow: iso(now), virtualNow: iso(this.virtualFor(state, observedAt)), timeZone: state.settings.timeZone,
      mode: state.settings.mode, speed: companionWorldSpeed(state.settings), backlog: observedAt < now,
      ...(since ? { elapsed: since.map(realAt => ({ realAt, milliseconds: this.elapsedVirtual(Date.parse(realAt), observedAt) })) } : {}) };
  }
  /** Persisted clock observation only. Do not load, initialize, advance actors or draw events when a management page polls. */
  private clockPeek() {
    const now = Date.now(), saved = this.db.prepare('SELECT data FROM companion_world WHERE id=1').get();
    const state = saved ? parse<StoredWorld>(row(saved).data) : undefined;
    const settings = state?.settings ?? { ...COMPANION_WORLD_DEFAULT_SETTINGS, revision: 1, timeZone: resolveCompanionScheduleTimeZone('system') };
    const observedAt = state?.cursor ?? now;
    return { realNow: iso(now), virtualNow: iso(state ? this.virtualFor(state, observedAt) : observedAt), timeZone: settings.timeZone,
      mode: settings.mode, speed: companionWorldSpeed(settings), backlog: observationBacklog(observedAt, now) };
  }
  private virtualFor(state: StoredWorld, realAt: number): number {
    const anchor = this.clockAnchor(state.anchors, realAt);
    return companionWorldVirtualAt(anchor, anchor.settings, realAt);
  }
  private realFor(state: StoredWorld, virtualAt: number): number {
    const anchor = this.clockAnchor(state.anchors, state.cursor);
    return companionWorldRealAt(anchor, anchor.settings, virtualAt);
  }
  private scenes(state: StoredWorld): CompanionWorldScene[] {
    // Dormant homes have only a cheap permanent map footprint. No interior,
    // furniture, runtime actor, perception or render assets are instantiated.
    const activeIds = new Set(state.actors.map(actor => actor.companionId));
    const homes = state.slots.flatMap(id => activeIds.has(id) ? [createCompanionWorldHome(id)] : []);
    const scenes = [...homes, createCompanionWorldPark()];
    for (const work of state.works.filter(work => work.status !== 'ended')) for (const scene of scenes) {
      const computer = scene.objects.find(object => object.id === work.computerId);
      if (computer) { computer.reservedBy = work.companionId; if (work.status === 'ready' || work.status === 'seating') computer.occupantId = work.companionId; }
    }
    for (const actor of state.actors) if (actor.furnitureId && !actor.route.length && ['seating', 'sitting', 'working', 'standingUp'].includes(actor.activity)) {
      const computer = scenes.flatMap(scene => scene.objects).find(object => object.id === actor.furnitureId && object.kind === 'computer');
      if (computer) { computer.occupantId = actor.companionId; computer.reservedBy = actor.companionId; }
    }
    for (const actor of state.actors) {
      const bench = scenes.find(scene => scene.kind === 'park')!.objects.find(object => object.kind === 'bench' && object.id === actor.furnitureId);
      if (bench && ((!actor.route.length && ['seating', 'sitting', 'resting'].includes(actor.activity)) || actor.activity === 'standingUp')) {
        bench.occupantId = actor.companionId; bench.reservedBy = actor.companionId;
      }
    }
    for (const actor of state.actors) if (actor.route.length) {
      const bench = scenes.find(scene => scene.kind === 'park')!.objects.find(object => object.kind === 'bench' && object.id === actor.destinationId);
      if (bench && !bench.reservedBy) bench.reservedBy = actor.companionId;
    }
    return scenes;
  }
  private sync(state: StoredWorld): void {
    const contacts = this.db.prepare("SELECT id,json_extract(data,'$.active') AS active FROM companions c WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed') ORDER BY rowid").all() as Row[];
    const ids = contacts.filter(contact => contact.active === 1).map(contact => String(contact.id));
    const slots = new Set(state.slots), activeIds = new Set(ids), contactIds = new Set(contacts.map(contact => String(contact.id)));
    for (const contact of contacts) if (!slots.has(String(contact.id))) { state.slots.push(String(contact.id)); slots.add(String(contact.id)); }
    // Suspended actors live only in SQLite, outside the hot simulation JSON.
    for (const actor of state.actors) if (!activeIds.has(actor.companionId) && contactIds.has(actor.companionId)) {
      delete actor.meetingHold; delete actor.meetingResume; delete actor.phoneResume; delete actor.afterWork;
      this.db.prepare('INSERT OR REPLACE INTO companion_world_suspended(companion_id,data) VALUES(?,?)').run(actor.companionId, JSON.stringify({ actor, since: state.cursor }));
      this.db.prepare('DELETE FROM companion_world_perceptions WHERE companion_id=?').run(actor.companionId);
    }
    state.actors = state.actors.filter(actor => activeIds.has(actor.companionId));
    for (const actor of state.actors) if (actor.sceneId.startsWith('home_') && !activeIds.has(actor.sceneId.slice(5))) {
      actor.sceneId = actor.homeSceneId; actor.position = { x: 10, y: 15 }; actor.route = []; actor.activity = 'idle';
      delete actor.journey; delete actor.transition; delete actor.furnitureId; delete actor.destinationId; delete actor.arrivalActivity;
      this.event(state, { kind: 'visit_suspended', actorId: actor.companionId, text: '房主休眠，拜访结束，通过入口返回自己的小屋。' });
    }
    for (const id of ids) {
      if (state.actors.some(actor => actor.companionId === id)) continue;
      const found = this.db.prepare('SELECT data FROM companion_world_suspended WHERE companion_id=?').get(id);
      if (!found) continue;
      const saved = parse<{ actor: StoredActor; since: number }>(row(found).data);
      const actor = saved.actor, elapsed = state.cursor - saved.since;
      actor.activityStartedAtReal = iso(Date.parse(actor.activityStartedAtReal) + elapsed);
      if (actor.transition) actor.transition.until += elapsed;
      if (actor.manualActivityUntil) actor.manualActivityUntil += this.elapsedVirtual(saved.since, state.cursor);
      if (actor.recovery?.retryAfter) actor.recovery.retryAfter += elapsed;
      if (actor.activity === 'working') { actor.activity = 'sitting'; delete actor.transition; }
      if (actor.sceneId.startsWith('home_') && !activeIds.has(actor.sceneId.slice(5))) {
        actor.sceneId = actor.homeSceneId; actor.position = { x: 10, y: 15 }; actor.route = []; actor.activity = 'idle';
        delete actor.journey; delete actor.transition; delete actor.furnitureId; delete actor.destinationId; delete actor.arrivalActivity;
      }
      actor.lastDecisionAt = this.virtualFor(state, state.cursor);
      state.actors.push(actor);
      this.db.prepare('DELETE FROM companion_world_suspended WHERE companion_id=?').run(id);
    }
    for (const id of ids) {
      if (!slots.has(id)) { state.slots.push(id); slots.add(id); }
      if (!state.actors.some(actor => actor.companionId === id)) state.actors.push({ companionId: id, sceneId: 'home_' + id, homeSceneId: 'home_' + id,
        position: { x: 10, y: 13 }, facing: 'south', frame: 0, activity: 'idle', artAction: 'idle', locomotion: 'walk', movementSpeed: COMPANION_WORLD_WALK_TILES_PER_SECOND,
        state: { energy: 100, mood: 'calm', expression: 'gentle', affect: { pleasure: 0, arousal: 0, dominance: 0 }, thermalComfort: 1 },
        activityStartedAtReal: iso(state.cursor), route: [], routinePhase: 'awake', lastDecisionAt: this.virtualFor(state, state.cursor) });
      if (!this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(privateRoom(id))) {
        this.db.prepare("INSERT INTO conversations(id,kind,title,private_companion_id,updated_at,hidden_at) VALUES(?,'group','伙伴世界',NULL,?,?)").run(privateRoom(id), iso(), iso());
        this.db.prepare('INSERT INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(privateRoom(id), id);
      }
      this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('world-room/' + privateRoom(id), 'true');
    }
    state.actors = state.actors.filter(actor => activeIds.has(actor.companionId));
    for (const work of state.works) if (!activeIds.has(work.companionId) || !this.db.prepare('SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.dissolved_at IS NULL AND m.companion_id=?').get(work.conversationId, work.companionId) ||
      (work.sourceMessageId || work.authorizationGrantId) && !this.workSourceAllowed(work)) work.status = 'ended';
    this.expireLearningWorks(state);
    for (const visit of state.visits) if (!ids.includes(visit.guestId) || !ids.includes(visit.hostId)) visit.status = 'expired';
  }
  private workSourceAllowed(work: StoredWork): boolean {
    try {
      if (work.authorizationGrantId) {
        if (!this.collaborationAllowed || !work.sourceMessageId || !work.invocationId || work.kind !== 'action' || work.fixed || work.urgent) return false;
        this.collaborationAllowed({ companionId: work.companionId, conversationId: work.conversationId,
          authorizationGrantId: work.authorizationGrantId, sourceMessageId: work.sourceMessageId, invocationId: work.invocationId });
        return true;
      }
      return !!work.sourceMessageId && this.visibleSources(work, [work.sourceMessageId]).some(source => source.authorId === 'user');
    } catch { return false; }
  }
  private learningWorkAllowed(work: Pick<StoredWork, 'companionId' | 'conversationId'> & LearningWorkProof): boolean {
    if (work.conversationId !== privateRoom(work.companionId) || !work.learningGrantId || !work.learningLeaseToken) return false;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_learning_grants'").get()) return false;
    return !!this.db.prepare(`SELECT 1 FROM companion_learning_grants g JOIN companions c ON c.id=g.companion_id
      WHERE g.id=? AND g.companion_id=? AND g.enabled=1 AND g.lease_token=? AND g.lease_until>?
      AND c.deleted_at IS NULL AND COALESCE(json_extract(c.data,'$.active'),1)=1
      AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=g.companion_id AND r.status!='completed')`)
      .get(work.learningGrantId, work.companionId, work.learningLeaseToken, Date.now());
  }
  private expireLearningWorks(state: StoredWorld): void {
    for (const work of state.works) if (work.kind === 'learning' && work.status !== 'ended' && !this.learningWorkAllowed(work)) {
      work.status = 'ended'; work.reason = '学习来源授权已撤销或本次读取租约已结束。';
      const actor = state.actors.find(actor => actor.companionId === work.companionId);
      if (actor && !state.works.some(other => other.companionId === actor.companionId && other.kind !== 'chat' && other.status !== 'ended')) {
        actor.route = []; delete actor.destinationId;
        if (['working', 'sitting', 'seating'].includes(actor.activity)) this.startTransition(state, actor, 'standingUp', 'idle', state.cursor);
        else if (actor.transition) actor.transition.after = 'idle';
        else { actor.activity = 'idle'; delete actor.furnitureId; }
        if (actor.phoneResume?.activity === 'working') actor.phoneResume.activity = 'sitting';
      }
      this.event(state, { kind: 'work_end', actorId: work.companionId, text: '结束已失效的资料阅读并释放预约' });
    }
  }
  private requireScope(scope: CompanionWorldScope): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(scope.companionId) ||
      !this.db.prepare('SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.dissolved_at IS NULL AND m.companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('世界操作不属于当前伙伴或聊天。');
  }
  private permitted(state: StoredWorld, actorId: string, ownerId: string): boolean {
    return ownerId === actorId || state.visits.some(visit => visit.hostId === ownerId && visit.guestId === actorId && visit.status === 'allowed' && Date.parse(visit.expiresAt) > this.virtualFor(state, state.cursor));
  }
  private event(state: StoredWorld, input: Omit<StoredEvent, 'id' | 'sequence' | 'at' | 'realAt' | 'simulation'>, at = state.cursor): StoredEvent {
    const witnessIds = input.actorId && input.sceneId && !input.privateOwner ? state.actors.filter(actor => actor.companionId !== input.actorId && (() => {
      const perception = this.perception(actor.companionId);
      return perception?.awake && perception.sceneId === input.sceneId && at >= Date.parse(perception.observedAtReal) && at - Date.parse(perception.observedAtReal) <= 2000 && perception.visibleCompanionIds.includes(input.actorId!);
    })()).map(actor => actor.companionId) : undefined;
    const sourceIds = [...new Set([...(input.sourceMessageId ? [input.sourceMessageId] : []), ...input.sourceMessageIds ?? []])];
    const sourceReads = sourceIds.map(id => this.sourceRead(id)).filter((source): source is NonNullable<typeof source> => !!source);
    const event = { ...input, ...(sourceIds.length ? { sourceReads } : {}), ...(witnessIds?.length ? { witnessIds } : {}), id: randomUUID(), sequence: 1, at: iso(this.virtualFor(state, at)), realAt: iso(at), simulation: true as const };
    const result = this.db.prepare('INSERT INTO companion_world_events(id,data) VALUES(?,?)').run(event.id, JSON.stringify(event)); event.sequence = Number(result.lastInsertRowid);
    this.db.prepare('UPDATE companion_world_events SET data=? WHERE id=?').run(JSON.stringify(event), event.id);
    // A pose, a plan, a movement tick or an interrupted walk cannot establish learned knowledge.
    if (event.actorId && (event.kind === 'park_walk_complete'
      || event.kind === 'scene_enter' && event.targetId && event.targetId !== event.actorId)) {
      this.captureExperience?.({ companionId: event.actorId, event });
    }
    return event;
  }
  private sourceRead(id?: string): NonNullable<CompanionWorldVisit['sourceRead']> | undefined {
    const source = id ? this.db.prepare('SELECT id,conversation_id,content FROM messages WHERE id=?').get(id) : undefined;
    if (!source) return undefined;
    const value = row(source);
    return { id: String(value.id), conversationId: String(value.conversation_id), checksum: createHash('sha256').update(String(value.content)).digest('hex') };
  }
  private sourceReadValid(reference: CompanionWorldVisit['sourceRead'], id: string, conversationId?: string): boolean {
    const current = this.sourceRead(id);
    return !!reference && reference.id === id && reference.conversationId === conversationId && current?.conversationId === reference.conversationId && current.checksum === reference.checksum;
  }
  private move(state: StoredWorld, actor: StoredActor, scene: CompanionWorldScene, destination: { x: number; y: number }, destinationId: string, activity: CompanionWorldActor['activity']): void {
    delete actor.navigationTaskId;
    const current = this.scenes(state).find(current => current.id === actor.sceneId);
    if (!current || scene.ownerId && !this.permitted(state, actor.companionId, scene.ownerId)) throw new Error('目的场景未开放或缺少房主邀请。');
    const exit = current.portals?.find(portal => portal.direction !== 'entry'), entry = scene.portals?.find(portal => portal.direction !== 'exit');
    if (!exit || !entry) throw new Error('场景缺少有效出入口。');
    const crossing = current.id !== scene.id;
    const route = findCompanionWorldPath(current, actor.position, crossing ? exit.position : destination);
    if (!route || !findCompanionWorldPath(scene, crossing ? entry.position : actor.position, destination)) throw new Error('场景内部的出入口或目的地不可达。');
    if (crossing) actor.journey = { targetSceneId: scene.id, exitId: exit.id, entryId: entry.id, destination, destinationId, activity };
    else delete actor.journey;
    const previous = actor.activity, transition = actor.transition;
    delete actor.manualActivityUntil; delete actor.manualArtAction;
    actor.route = route; actor.destinationId = destinationId; actor.arrivalActivity = activity; actor.activity = route.length ? 'walking' : actor.journey ? 'idle' : activity;
    // A phone lease predates this new movement. Releasing it must resume the
    // accepted route, not restore the idle/sitting pose saved before navigation.
    if (actor.phoneResume) actor.phoneResume.activity = route.length ? 'walking' : activity;
    const running = state.works.some(work => work.companionId === actor.companionId && work.urgent && work.status !== 'ended');
    actor.locomotion = running ? 'run' : 'walk'; actor.movementSpeed = running ? 4.8 : COMPANION_WORLD_WALK_TILES_PER_SECOND;
    actor.activityStartedAtReal = iso(state.cursor);
    if (transition && transition.until > state.cursor && previous === 'seating') this.startTransition(state, actor, 'standingUp', route.length ? 'walking' : activity, state.cursor);
    else if (transition && transition.until > state.cursor) { actor.activity = previous; transition.after = route.length ? 'walking' : activity; }
    else if (['sleeping', 'lyingDown'].includes(previous)) this.startTransition(state, actor, 'waking', 'walking', state.cursor);
    else if (['sitting', 'working', 'eating', 'resting', 'seating'].includes(previous)) this.startTransition(state, actor, 'standingUp', 'walking', state.cursor);
    else if (route.length) {
      const first = route.find(point => point.sceneId === actor.sceneId && Math.hypot(point.x - actor.position.x, point.y - actor.position.y) > .01);
      const facing = first ? Math.abs(first.x - actor.position.x) > Math.abs(first.y - actor.position.y) ? first.x > actor.position.x ? 'east' : 'west' : first.y > actor.position.y ? 'south' : 'north' : actor.facing;
      if (facing !== actor.facing) { actor.facing = facing; this.startTransition(state, actor, 'turning', 'walking', state.cursor); }
    }
    if (!actor.transition) delete actor.furnitureId;
    if (!actor.journey && !route.length && !actor.transition && activity === 'sleeping') { actor.furnitureId = destinationId; this.startTransition(state, actor, 'lyingDown', 'sleeping', state.cursor); }
    else if (!actor.journey && !route.length && !actor.transition && (activity === 'eating' || activity === 'resting')) { actor.furnitureId = destinationId; this.startTransition(state, actor, 'seating', activity, state.cursor); }
    this.event(state, { kind: 'move', actorId: actor.companionId, sceneId: actor.sceneId, text: '开始步行前往' + destinationId });
  }
  private finishJourneys(state: StoredWorld): void {
    for (const actor of state.actors) {
      const journey = actor.journey;
      if (!journey || actor.route.length || actor.transition) continue;
      const scenes = this.scenes(state), current = scenes.find(scene => scene.id === actor.sceneId), target = scenes.find(scene => scene.id === journey.targetSceneId);
      const exit = current?.portals?.find(portal => portal.id === journey.exitId && portal.direction !== 'entry');
      const entry = target?.portals?.find(portal => portal.id === journey.entryId && portal.direction !== 'exit');
      const allowed = target && entry && exit && Math.hypot(actor.position.x - exit.position.x, actor.position.y - exit.position.y) <= .2
        && (!target.ownerId || this.permitted(state, actor.companionId, target.ownerId))
        && (!target.ownerId || target.ownerId === actor.companionId || !['dormant', 'sleeping', 'eating', 'working'].includes(this.contactState(target.ownerId)));
      delete actor.journey;
      if (!allowed || !target || !entry) {
        actor.activity = 'idle'; delete actor.destinationId; delete actor.arrivalActivity;
        this.event(state, { kind: 'travel_blocked', actorId: actor.companionId, ...(target?.ownerId ? { targetId: target.ownerId } : {}), ...(journey.visitId ? { visitId: journey.visitId } : {}), text: '场景入口暂不可用、邀请失效或房主正在忙碌，留在当前场景，未进入对方小屋。' }); continue;
      }
      const route = findCompanionWorldPath(target, entry.position, journey.destination);
      if (!route) { actor.activity = 'idle'; delete actor.destinationId; continue; }
      const fromSceneId = actor.sceneId;
      actor.sceneId = target.id; actor.position = { ...entry.position }; actor.route = route; actor.activity = route.length ? 'walking' : 'idle'; actor.activityStartedAtReal = iso(state.cursor);
      actor.destinationId = journey.destinationId; actor.arrivalActivity = journey.activity; delete actor.furnitureId;
      this.event(state, { kind: 'scene_enter', actorId: actor.companionId, ...(target.ownerId ? { targetId: target.ownerId } : {}), sceneId: target.id, ...(journey.visitId ? { visitId: journey.visitId } : {}),
        text: `从 ${fromSceneId} 的出口通行到 ${target.id} 的 ${entry.id} 入口。` });
      if (!route.length) this.enterFurniture(state, actor, journey.activity, state.cursor);
    }
  }
  private startTransition(state: StoredWorld, actor: StoredActor, action: 'seating' | 'standingUp' | 'lyingDown' | 'waking' | 'turning', after: CompanionWorldActor['activity'], at: number): void {
    if (actor.transition && actor.activity === action && actor.transition.after === after && actor.transition.until > at) return;
    const labels = { seating: '坐下', standingUp: '起身', lyingDown: '躺下', waking: '醒来起床', turning: '转身' };
    if (actor.transition && actor.transition.until > at) this.event(state, { kind: 'behavior_interrupted', actorId: actor.companionId, sceneId: actor.sceneId,
      text: '先前的姿态动作被新的实际安排中断', behavior: actor.transition.eventId ? { id: actor.transition.eventId, kind: actor.transition.action ?? actor.activity, phase: 'interrupted', targetId: actor.furnitureId } : undefined }, at);
    const duration = action === 'seating' ? COMPANION_WORLD_SEATING_MS : action === 'standingUp' ? COMPANION_WORLD_ACTION_TIMINGS.standUp : action === 'lyingDown' ? COMPANION_WORLD_ACTION_TIMINGS.lieDown : action === 'waking' ? COMPANION_WORLD_ACTION_TIMINGS.wake : COMPANION_WORLD_ACTION_TIMINGS.turn;
    const eventId = randomUUID();
    actor.activity = action; actor.activityStartedAtReal = iso(at); actor.transition = { eventId, action, until: at + duration, after };
    this.event(state, { kind: 'behavior_started', actorId: actor.companionId, sceneId: actor.sceneId, text: '开始' + labels[action],
      behavior: { id: eventId, kind: action, phase: 'started', targetId: actor.furnitureId,
        parentId: actor.parkWalk?.occurrenceId ?? state.works.find(work => work.companionId === actor.companionId && work.status !== 'ended')?.workId } }, at);
  }
  private finishTransitions(state: StoredWorld): void {
    for (const actor of state.actors) if (actor.transition && actor.transition.until <= state.cursor) {
      const transition = actor.transition, completedAction = transition.action ?? actor.activity; actor.activity = transition.after; actor.activityStartedAtReal = iso(transition.until); delete actor.transition;
      this.event(state, { kind: 'behavior_completed', actorId: actor.companionId, sceneId: actor.sceneId, text: '姿态动作已实际完成，进入' + transition.after,
        behavior: transition.eventId ? { id: transition.eventId, kind: completedAction, phase: 'completed', targetId: actor.furnitureId } : undefined }, transition.until);
      if (actor.activity === 'walking' || actor.activity === 'idle') delete actor.furnitureId;
    }
  }
  private enterFurniture(state: StoredWorld, actor: StoredActor, activity: CompanionWorldActor['activity'], at: number): void {
    if (actor.activity === activity) return;
    if (activity === 'sleeping') this.startTransition(state, actor, 'lyingDown', 'sleeping', at);
    else if (activity === 'seating') this.startTransition(state, actor, 'seating', 'working', at);
    else if (['eating', 'resting', 'sitting'].includes(activity)) this.startTransition(state, actor, 'seating', activity, at);
    else if (activity === 'idle' && ['sleeping', 'lyingDown'].includes(actor.activity)) this.startTransition(state, actor, 'waking', 'idle', at);
    else if (activity === 'idle' && ['sitting', 'seating', 'resting', 'eating', 'working'].includes(actor.activity)) this.startTransition(state, actor, 'standingUp', 'idle', at);
    else {
      actor.activity = activity; actor.activityStartedAtReal = iso(at);
      this.event(state, { kind: 'activity_entered', actorId: actor.companionId, sceneId: actor.sceneId, text: '实际进入' + activity + '状态' }, at);
    }
  }
  private planRoutine(state: StoredWorld, actor: StoredActor): void {
    // rememberClock exposes exactly this simulation cursor, not the wall clock,
    // to the shared energy integrator. Physical occupancy is the only recovery.
    actor.state = { ...actor.state, ...this.runtime(actor.companionId) };
    const focus = this.orders?.focus(actor.companionId);
    for (const held of state.works.filter(work => work.companionId === actor.companionId && work.workOrderId && work.status !== 'ended')) {
      if (held.workOrderId !== focus?.id) held.status = 'ended';
      else if (focus) held.sourceMessageId = focus.sourceMessageId;
    }
    if (focus && !state.works.some(work => work.companionId === actor.companionId && work.workOrderId === focus.id && work.status !== 'ended')) {
      state.works.push({ workId: 'order_hold_' + focus.id, workOrderId: focus.id, companionId: actor.companionId, conversationId: focus.conversationId, sourceMessageId: focus.sourceMessageId, kind: 'action', urgent: false, fixed: true, requestedAtReal: Date.parse(focus.createdAt), status: 'waiting', reason: '已受理工作尚未结束，保持集中工作' });
    }
    const active = state.works.filter(work => work.companionId === actor.companionId && work.status !== 'ended');
    const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
    actor.routinePhase = phase.phase;
    const computer = active.filter(work => work.kind !== 'chat'), phone = active.filter(work => work.kind === 'chat');
    if (phone.length) this.planPhone(state, actor, phone, computer);
    const interruption = this.socialInterrupt(actor.companionId, state.cursor);
    if (interruption && !active.some(work => work.urgent)) {
      if (!actor.socialPause) actor.socialPause = { sourceId: interruption.source_id, authorId: interruption.author_id, route: actor.route, journey: actor.journey, activity: actor.activity };
      actor.route = []; delete actor.journey; this.releaseMeeting(actor, true);
      for (const work of computer) { work.status = 'waiting'; work.reason = '正在处理紧急联系，原工作保留'; }
      if (['sleeping', 'lyingDown', 'eating'].includes(actor.activity)) this.enterFurniture(state, actor, 'idle', state.cursor);
      if (!actor.transition || actor.transition.until <= state.cursor) { this.holdPhone(actor, state.cursor); if (actor.activity === 'working') actor.activity = 'sitting'; }
      return;
    }
    if (actor.socialPause) {
      const paused = actor.socialPause; delete actor.socialPause; this.releasePhone(actor, state.cursor);
      actor.route = paused.route; actor.journey = paused.journey; actor.activity = paused.route.length ? 'walking' : paused.activity;
      this.event(state, { kind: 'social_resume', actorId: actor.companionId, targetId: paused.authorId, text: '紧急联系结束，恢复保留的活动或当前作息。' });
    }

    if (actor.meetingResume && (computer.length || ['sleeping', 'eating'].includes(phase.phase) || phone.some(work => work.urgent))) this.releaseMeeting(actor, true);
    if (actor.parkWalk && (computer.length || ['sleeping', 'eating'].includes(phase.phase))) {
      this.finishParkWalk(state, actor, computer.length ? '开始集中工作，结束这次散步' : '到了用餐或睡眠时间，结束这次散步', false);
    }
    const peerPhone = this.peerPhoneActive(actor.companionId, state.cursor);
    if (!computer.length && actor.phoneResume?.activity === 'working') actor.phoneResume.activity = 'sitting';
    if (!computer.length && (actor.activity === 'working' || actor.activity === 'seating' && actor.transition?.after === 'working')) {
      delete actor.destinationId;
      this.startTransition(state, actor, 'standingUp', 'idle', state.cursor);
    }
    if (actor.phoneResume && (computer.length || !phone.some(work => work.status === 'ready') && !(peerPhone && this.phoneAvailable(state, actor)))) this.releasePhone(actor, state.cursor);
    if (computer.length) this.planComputer(state, actor, computer);
    const recovering = this.planRecovery(state, actor, phase.phase, computer.length > 0);
    if (recovering) return;
    if (computer.some(work => work.status !== 'waiting')) return;
    if (phone.some(work => work.status === 'ready') && this.phoneAvailable(state, actor)
      && !['sleeping', 'eating'].includes(phase.phase)) return;
    if (peerPhone && this.phoneAvailable(state, actor)) {
      if (!actor.transition) this.holdPhone(actor, state.cursor);
      return;
    }
    if (actor.transition && actor.transition.until > state.cursor) return;
    if (this.holdMeeting(state, actor)) return;
    if (this.planParkWalk(state, actor)) return;
    const currentScene = this.scenes(state).find(scene => scene.id === actor.sceneId);
    if (currentScene?.ownerId && !this.permitted(state, actor.companionId, currentScene.ownerId)) {
      const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId)!;
      if (actor.destinationId !== home.id) this.move(state, actor, home, { x: 10, y: 12 }, home.id, 'idle');
      return;
    }
    if (actor.manualActivityUntil && actor.manualActivityUntil > this.virtualFor(state, state.cursor) && !['sleeping', 'eating'].includes(phase.phase)) return;
    delete actor.manualActivityUntil; delete actor.manualArtAction;
    const kind = phase.phase === 'sleeping' ? 'bed' : phase.phase === 'eating' ? 'dining' : phase.phase === 'resting' ? 'sofa' : phase.phase === 'habit' ? 'habit' : undefined;
    if (!kind) {
      if (actor.activity === 'sleeping') this.startTransition(state, actor, 'waking', 'idle', state.cursor);
      else if (['eating', 'resting'].includes(actor.activity)) this.startTransition(state, actor, 'standingUp', 'idle', state.cursor);
      else if (actor.activity === 'habit') { actor.activity = 'idle'; delete actor.furnitureId; }
      if (actor.activity !== 'walking') delete actor.destinationId;
      this.queueDecision(state, actor); return;
    }
    const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId)!, furniture = home.objects.find(object => object.kind === kind)!;
    const activity = phase.phase === 'sleeping' ? 'sleeping' : phase.phase === 'eating' ? 'eating' : phase.phase === 'resting' ? 'resting' : 'habit';
    if (actor.destinationId !== furniture.id) {
      this.move(state, actor, home, furniture.anchor, furniture.id, activity);
      this.event(state, { kind: 'routine', actorId: actor.companionId, text: '依照世界作息前往' + furniture.name, privateOwner: actor.companionId });
    }
    actor.arrivalActivity = activity;
    if (!actor.route.length && actor.destinationId === furniture.id && actor.activity !== activity) {
      actor.furnitureId = furniture.id;
      this.enterFurniture(state, actor, activity, state.cursor);
    }
  }
  private planRecovery(state: StoredWorld, actor: StoredActor, phase: StoredActor['routinePhase'], working: boolean): boolean {
    const energy = actor.state.energy;
    if (!companionWorldNeedsRecovery(energy, !!actor.recovery)) {
      if (actor.recovery) {
        this.event(state, { kind: 'recovery_completed', actorId: actor.companionId, sceneId: actor.sceneId,
          text: `实际休息后精力恢复到${Math.round(energy)}%，结束这次疲劳恢复。`, privateOwner: actor.companionId });
        delete actor.recovery;
      }
      return false;
    }
    if (!actor.recovery) {
      actor.recovery = { id: randomUUID(), requestedAt: state.cursor };
      this.event(state, { kind: 'recovery_needed', actorId: actor.companionId, sceneId: actor.sceneId,
        text: `精力降至${Math.round(energy)}%，需要实际坐下休息；集中工作、睡眠、用餐和已受理路线先完成。`, privateOwner: actor.companionId });
    }
    // Keep accepted work and actual routes intact. A queued need is durable and
    // evaluated again as soon as the higher-priority body activity releases it.
    if (working || ['sleeping', 'eating'].includes(phase) || actor.parkWalk) return false;
    const scenes = this.scenes(state), current = scenes.find(scene => scene.id === actor.sceneId), mayRemain = !current?.ownerId || this.permitted(state, actor.companionId, current.ownerId);
    if (mayRemain && actor.route.length && actor.destinationId !== actor.recovery.furnitureId) return false;
    if (mayRemain && actor.transition) return !!actor.recovery.furnitureId;
    if (mayRemain && ['sleeping', 'eating'].includes(actor.activity) && actor.manualActivityUntil && actor.manualActivityUntil > this.virtualFor(state, state.cursor)) return false;
    this.releaseMeeting(actor, true);
    if (mayRemain && actor.activity === 'resting' && actor.furnitureId && !actor.route.length) {
      actor.recovery.furnitureId = actor.furnitureId;
      return true;
    }
    const home = scenes.find(scene => scene.id === actor.homeSceneId)!, sofa = home.objects.find(object => object.kind === 'sofa')!;
    // Recovery never extends a host's permission. Leave expired foreign
    // furniture immediately, but keep the accepted outbound route intact while
    // it crosses that home's doorway and continues to our own sofa.
    if (actor.recovery.furnitureId && actor.route.length && (mayRemain || actor.destinationId === sofa.id && actor.recovery.furnitureId === sofa.id)) return true;
    if (mayRemain && actor.recovery.retryAfter && actor.recovery.retryAfter > state.cursor) return true;
    // No teleport, no guessed foreign furniture, and no repeated failed route
    // every frame when a layout temporarily blocks the reachable rest anchor.
    const currentScene = scenes.find(scene => scene.id === actor.sceneId)!;
    const route = findCompanionWorldPath(currentScene, actor.position, currentScene.id === home.id ? sofa.anchor : currentScene.door);
    if (!route) {
      actor.recovery.retryAfter = state.cursor + 30000;
      this.event(state, { kind: 'recovery_blocked', actorId: actor.companionId, sceneId: actor.sceneId,
        text: '当前回家休息的路线不可达，保留疲劳恢复需求，稍后按真实场景重试。', privateOwner: actor.companionId });
      return true;
    }
    delete actor.recovery.retryAfter;
    actor.recovery.furnitureId = sofa.id;
    this.move(state, actor, home, sofa.anchor, sofa.id, 'resting');
    this.event(state, { kind: 'recovery_started', actorId: actor.companionId, sceneId: actor.sceneId,
      text: `因精力不足前往自己的沙发休息，实际恢复至${COMPANION_WORLD_RECOVERY.resumeEnergy}%后再自由活动；可坐着使用手机。`, privateOwner: actor.companionId });
    return true;
  }
  private releasePhone(actor: StoredActor, now: number): void {
    if (!actor.phoneResume) return;
    if (!actor.transition || actor.transition.until <= now) {
      actor.activity = actor.phoneResume.activity === 'walking' && !actor.route.length ? actor.arrivalActivity ?? 'idle' : actor.phoneResume.activity;
      actor.activityStartedAtReal = iso(now);
    }
    delete actor.phoneResume;
  }
  private releaseMeeting(actor: StoredActor, clear = false): void {
    if (actor.meetingResume) {
      actor.activity = actor.route.length ? 'walking' : actor.meetingResume; delete actor.meetingResume;
    }
    if (clear) { delete actor.meetingHold; this.db.prepare("DELETE FROM companion_social_communication WHERE companion_id=? AND json_extract(data,'$.channel')='face_to_face'").run(actor.companionId); }
  }
  private holdMeeting(state: StoredWorld, actor: StoredActor): boolean {
    if (actor.meetingHold && actor.meetingHold.untilReal <= state.cursor) delete actor.meetingHold;
    const communication = this.faceCommunication(actor.companionId, state.cursor), members = communication ? [actor.companionId, ...communication.recipientIds] : actor.meetingHold?.memberIds;
    if (!members || !this.faceGroupAvailable(state, members)) { this.releaseMeeting(actor, true); return false; }
    actor.meetingResume ??= actor.activity;
    if (actor.activity === 'walking' || actor.activity === 'habit') { actor.activity = 'idle'; actor.activityStartedAtReal = iso(state.cursor); }
    return true;
  }
  private observeEncounters(state: StoredWorld, target: number): void {
    if (state.cursor + 1 < target) return;
    type Clock = { present: boolean; hazard: number; threshold: number; lastRealAt: number; triggeredAt?: number };
    const saved = new Map((this.db.prepare('SELECT pair_key,data FROM companion_world_encounters').all() as Row[]).map(value => [String(value.pair_key), parse<Clock>(value.data)]));
    const enabled = new Set((this.db.prepare("SELECT id FROM companions WHERE deleted_at IS NULL AND COALESCE(json_extract(data,'$.proactive'),1)!=0").all() as Row[]).map(value => String(value.id)));
    const pendingMembers = new Set((this.db.prepare("SELECT data FROM companion_world_jobs WHERE kind='decision' AND status IN('pending','running','failed') AND COALESCE(json_extract(data,'$.terminal'),0)=0 AND json_extract(data,'$.encounterMemberIds') IS NOT NULL").all() as Row[])
      .flatMap(value => parse<CompanionWorldJob>(value.data).encounterMemberIds ?? []));
    const actors = state.actors.filter(actor => !pendingMembers.has(actor.companionId) && this.faceMemberAvailable(state, actor)).sort((a, b) => a.companionId.localeCompare(b.companionId));
    const near = new Set<string>(), upsert = this.db.prepare('INSERT INTO companion_world_encounters(pair_key,left_id,right_id,data) VALUES(?,?,?,?) ON CONFLICT(pair_key) DO UPDATE SET data=excluded.data');
    for (let left = 0; left < actors.length; left++) for (let right = left + 1; right < actors.length; right++) {
      const first = actors[left]!, second = actors[right]!, key = first.companionId + '|' + second.companionId;
      if (first.sceneId !== second.sceneId || Math.hypot(first.position.x - second.position.x, first.position.y - second.position.y) > 5) continue;
      const firstSense = this.perception(first.companionId), secondSense = this.perception(second.companionId);
      const sees = (sense: CompanionWorldPerception | undefined, id: string) => sense?.awake && state.cursor - Date.parse(sense.observedAtReal) <= 2000 && sense.visibleCompanionIds.includes(id);
      if (!sees(firstSense, second.companionId) || !sees(secondSense, first.companionId)) continue;
      near.add(key); const clock = saved.get(key) ?? { present: false, hazard: 0, threshold: 1, lastRealAt: state.cursor };
      if (!clock.present || state.cursor - clock.lastRealAt > 120000) { clock.hazard = 0; clock.threshold = companionLifeThreshold(key + '/' + state.cursor); }
      const elapsed = clock.present && state.cursor - clock.lastRealAt <= 120000 ? this.elapsedVirtual(clock.lastRealAt, state.cursor) : 0;
      clock.present = true; clock.lastRealAt = state.cursor;
      const virtualNow = iso(this.virtualFor(state, state.cursor));
      const mayInitiate = (actor: StoredActor) => enabled.has(actor.companionId) && !!this.social?.canInitiate(actor.companionId, virtualNow, state.settings.timeZone);
      const owner = mayInitiate(first) ? first : mayInitiate(second) ? second : undefined;
      if (!owner) { upsert.run(key, first.companionId, second.companionId, JSON.stringify(clock)); continue; }
      const peer = owner === first ? second : first, relation = state.relationships.find(edge => edge.companionId === owner.companionId && edge.targetCompanionId === peer.companionId);
      const runtime = this.runtime(owner.companionId), multiplier = companionLifeMultiplier({ energy: runtime.energy, pleasure: runtime.affect.pleasure, arousal: runtime.affect.arousal,
        affinity: relation?.affinity ?? 50, trust: relation?.trust ?? 50, expression: runtime.expression, action: 'message', available: true });
      const cooling = clock.triggeredAt !== undefined && (state.cursor - clock.triggeredAt < 120000 || this.elapsedVirtual(clock.triggeredAt, state.cursor) < 3600000);
      if (!cooling) clock.hazard += companionLifeHazard(.7, 60000, elapsed, multiplier);
      if (!cooling && clock.hazard >= clock.threshold && !owner.meetingHold && !this.faceCommunication(owner.companionId, state.cursor)) {
        const group = [owner, peer];
        for (const candidate of actors) if (group.length < 4 && !group.includes(candidate) && !candidate.meetingHold && !this.faceCommunication(candidate.companionId, state.cursor)
          && group.every(member => member.sceneId === candidate.sceneId && Math.hypot(member.position.x - candidate.position.x, member.position.y - candidate.position.y) <= 5
            && sees(this.perception(member.companionId), candidate.companionId) && sees(this.perception(candidate.companionId), member.companionId))) group.push(candidate);
        const memberIds = group.map(member => member.companionId).sort();
        if (group.every(member => !member.meetingHold && !this.faceCommunication(member.companionId, state.cursor))) {
          const job = this.queueJob(state, owner.companionId, 'decision', memberIds);
          if (job) {
            for (const member of group) { member.meetingHold = { jobId: job.id, memberIds, untilReal: state.cursor + 60000 }; this.holdMeeting(state, member); }
            for (let a = 0; a < memberIds.length; a++) for (let b = a + 1; b < memberIds.length; b++) {
              const pair = memberIds[a]! + '|' + memberIds[b]!, prior = saved.get(pair) ?? { present: true, hazard: 0, threshold: 1, lastRealAt: state.cursor };
              prior.triggeredAt = state.cursor; prior.hazard = 0; saved.set(pair, prior); upsert.run(pair, memberIds[a], memberIds[b], JSON.stringify(prior));
            }
            clock.triggeredAt = state.cursor; clock.hazard = 0;
            this.event(state, { kind: 'encounter_opportunity', actorId: owner.companionId, sceneId: owner.sceneId, text: '与' + memberIds.filter(id => id !== owner.companionId).join('、') + '实际相遇，停步考虑当面交流。' });
          }
        }
      }
      saved.set(key, clock); upsert.run(key, first.companionId, second.companionId, JSON.stringify(clock));
    }
    for (const [key, clock] of saved) if (clock.present && !near.has(key)) { clock.present = false; clock.hazard = 0; const members = key.split('|'); upsert.run(key, members[0], members[1], JSON.stringify(clock)); }
  }
  private finishParkWalk(state: StoredWorld, actor: StoredActor, reason: string, returnHome: boolean): void {
    const walk = actor.parkWalk; if (!walk) return;
    const completed = walk.participatedMinutes + .000001 >= walk.durationMinutes;
    if (walk.occurrenceId && (!completed || !returnHome)) this.life?.completePhysical(walk.occurrenceId, actor.companionId, 'cancelled', `${reason}；实际散步${Math.round(walk.participatedMinutes * 10) / 10}分钟。`);
    if (walk.stage !== 'returning') this.event(state, { kind: walk.participatedMinutes + .000001 >= walk.durationMinutes ? 'park_walk_complete' : 'park_walk_interrupted',
      actorId: actor.companionId, sceneId: actor.sceneId,
      text: `${reason}；实际在园中散步${Math.round(walk.participatedMinutes * 10) / 10}分钟。` });
    if (returnHome) {
      const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId)!;
      walk.stage = 'returning'; this.move(state, actor, home, { x: 10, y: 12 }, home.id, 'idle');
    } else {
      delete actor.parkWalk;
      actor.route = []; if (actor.activity === 'walking') actor.activity = 'idle';
      delete actor.destinationId; delete actor.arrivalActivity;
    }
  }
  private planParkWalk(state: StoredWorld, actor: StoredActor): boolean {
    const walk = actor.parkWalk; if (!walk) return false;
    if (walk.stage === 'returning') {
      if (actor.route.length || actor.transition) return true;
      if (walk.occurrenceId && walk.participatedMinutes + .000001 >= walk.durationMinutes) this.life?.completePhysical(walk.occurrenceId, actor.companionId, 'done', `实际在公园散步${Math.round(walk.participatedMinutes)}分钟，并已步行回到自己的家。`);
      delete actor.parkWalk; delete actor.destinationId; return false;
    }
    const climate = companionWorldEnvironment(this.virtualFor(state, state.cursor), state.settings.timeZone).environment;
    if (this.runtime(actor.companionId).energy <= 25 || actor.sceneId === 'park' && !companionWorldParkSuitable(climate)) {
      this.finishParkWalk(state, actor, '户外天气或当前精力不再适合散步，准备回家', true); return true;
    }
    if (walk.participatedMinutes + .000001 >= walk.durationMinutes) {
      this.finishParkWalk(state, actor, '完成这次花园散步，准备回家', true); return true;
    }
    if (actor.route.length) return true;
    const park = this.scenes(state).find(scene => scene.kind === 'park')!, circuit = companionWorldParkCircuit(park);
    if (!circuit.length) { this.finishParkWalk(state, actor, '散步步道暂时不可达，准备回家', true); return true; }
    if (walk.stage === 'travelling') {
      walk.stage = 'strolling';
      this.event(state, { kind: 'park_walk_enter', actorId: actor.companionId, sceneId: park.id, text: `实际抵达公共花园，开始${walk.durationMinutes}分钟的散步放松。` });
    }
    walk.waypointIndex = (walk.waypointIndex + 1) % circuit.length;
    this.move(state, actor, park, circuit[walk.waypointIndex]!, 'park_promenade_' + walk.waypointIndex, 'idle');
    return true;
  }
  private repairObstructedRoutes(state: StoredWorld): void {
    const scenes = this.scenes(state), byId = new Map(scenes.map(scene => [scene.id, scene]));
    for (const actor of state.actors) {
      const current = byId.get(actor.sceneId); if (!current) continue;
      const obstructedStart = !companionWorldCellWalkable(current, actor.position);
      if (!obstructedStart && !actor.route.some(point => { const scene = byId.get(point.sceneId); return !scene || !companionWorldCellWalkable(scene, point); })) continue;
      let destination = actor.route.at(-1);
      if (!destination && obstructedStart) {
        const start = { x: Math.round(actor.position.x), y: Math.round(actor.position.y) };
        for (let radius = 1; radius <= 8 && !destination; radius++) for (let dx = -radius; dx <= radius && !destination; dx++) for (const dy of [-1, 1].map(sign => sign * (radius - Math.abs(dx)))) {
          const point = { x: start.x + dx, y: start.y + dy };
          if (companionWorldCellWalkable(current, point) && findCompanionWorldPath(current, actor.position, point, true)) { destination = { ...point, sceneId: current.id }; break; }
        }
      }
      const route = destination && routeCompanionWorldActor(scenes, actor, destination.sceneId, destination, owner => this.permitted(state, actor.companionId, owner), obstructedStart);
      if (route) {
        actor.route = route;
        if (route.length && !actor.transition && !actor.phoneResume) actor.activity = 'walking';
        this.event(state, { kind: 'route_replanned', actorId: actor.companionId, sceneId: actor.sceneId, text: '根据当前真实场景重新规划步行路线，避开新增障碍。' });
      } else {
        if (actor.parkWalk) this.finishParkWalk(state, actor, '步道发生变化且目的地不可达，停止这次散步', false);
        actor.route = []; if (actor.activity === 'walking') actor.activity = 'idle'; delete actor.destinationId; delete actor.arrivalActivity;
        this.event(state, { kind: 'route_unavailable', actorId: actor.companionId, sceneId: actor.sceneId, text: '当前真实障碍使目的地不可达，已停止旧路线。' });
      }
    }
  }
  private holdPhone(actor: StoredActor, now: number): void {
    if (actor.phoneResume) return;
    actor.phoneResume = { activity: actor.activity };
    if (!['working', 'sitting', 'resting'].includes(actor.activity)) actor.activity = 'idle';
    actor.activityStartedAtReal = iso(now);
  }
  private planPhone(state: StoredWorld, actor: StoredActor, phones: StoredWork[], computers: StoredWork[]): void {
    // All admitted replies are independent durable jobs. A physical animation
    // is optional and must never hold up a different conversation or task.
    const eligible = phones.filter(work => work.requestedAtReal <= state.cursor);
    for (const work of phones) {
      delete work.computerId; work.nextCheckAt = iso(Math.max(state.cursor + 500, work.requestedAtReal));
      if (!eligible.includes(work)) { work.status = 'waiting'; work.reason = '正在补算世界存档'; }
    }
    if (!eligible.length) { if (!this.peerPhoneActive(actor.companionId, state.cursor) || !this.phoneAvailable(state, actor)) this.releasePhone(actor, state.cursor); return; }
    if (!computers.length && this.phoneAvailable(state, actor) && !actor.transition && !actor.route.length) this.holdPhone(actor, state.cursor);
    for (const work of eligible) { work.status = 'ready'; delete work.reason; }
  }
  private planComputer(state: StoredWorld, actor: StoredActor, works: StoredWork[]): void {
    // Admission already verified the source or scheduled commitment. Work may
    // start during a routine; only actual travel and shared computer capacity
    // constrain execution. A long sleep window is not a global task mutex.
    const eligible = works.filter(work => work.requestedAtReal <= state.cursor);
    for (const work of works.filter(work => !eligible.includes(work))) { work.status = 'waiting'; work.reason = '正在补算世界存档，尚未到达这次请求的实际时刻'; work.nextCheckAt = iso(work.requestedAtReal); delete work.computerId; }
    if (!eligible.length) return;
    const scenes = this.scenes(state), current = scenes.find(scene => scene.id === actor.sceneId)!;
    const foreign = current.kind === 'home' && current.ownerId !== actor.companionId && current.ownerId && this.permitted(state, actor.companionId, current.ownerId) ? current : undefined;
    const available = (scene: CompanionWorldScene) => scene.objects.find(object => object.kind === 'computer' && (!object.reservedBy || object.reservedBy === actor.companionId));
    const home = scenes.find(scene => scene.id === actor.homeSceneId)!;
    const scene = foreign && available(foreign) ? foreign : home, computer = available(scene);
    if (!computer) { for (const work of eligible) { work.status = 'waiting'; work.reason = '电脑正在被使用'; work.nextCheckAt = iso(state.cursor + 1000); } return; }
    for (const work of eligible) { work.computerId = computer.id; delete work.reason; work.nextCheckAt = iso(state.cursor + 500); }
    if (actor.destinationId !== computer.id) this.move(state, actor, scene, computer.anchor, computer.id, 'seating');
    if (actor.route.length) {
      const running = eligible.some(work => work.urgent && work.sourceMessageId && this.urgent(actor.companionId, work.sourceMessageId, state.cursor));
      const locomotion = running ? 'run' : 'walk';
      if (actor.locomotion !== locomotion && actor.activity === 'walking') actor.activityStartedAtReal = iso(state.cursor);
      actor.locomotion = locomotion; actor.movementSpeed = running ? 4.8 : COMPANION_WORLD_WALK_TILES_PER_SECOND;
    }
    if (actor.transition && actor.transition.until > state.cursor) {
      for (const work of eligible) work.status = actor.transition.action === 'seating' && actor.transition.after === 'working' && actor.furnitureId === computer.id ? 'seating' : 'moving';
      return;
    }
    if (!actor.route.length && actor.sceneId === scene.id && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01) {
      actor.furnitureId = computer.id;
      if (actor.activity === 'working') for (const work of eligible) work.status = 'ready';
      else { this.startTransition(state, actor, 'seating', 'working', state.cursor); for (const work of eligible) work.status = 'seating'; }
    } else for (const work of eligible) work.status = 'moving';
  }
  tick(now = Date.now()): CompanionWorldSnapshot { this.advance(now); return this.snapshotValue(this.load(), now); }
  private advance(now = Date.now()): void {
    if (this.advancing) return;
    if (this.clockAnchors && now <= this.through && !this.dirty && !this.activeWorld?.works.some(work => work.kind === 'learning' && work.status !== 'ended' && !this.learningWorkAllowed(work))) return;
    this.advancing = true;
    try { this.db.transaction(() => {
      const state = this.load(); this.sync(state); const target = Math.max(state.cursor, now); let steps = 0;
      while (state.cursor < target && steps++ < 1000) {
        this.rememberClock(state);
        this.finishTransitions(state); this.finishJourneys(state);
        for (const visit of state.visits) if (['allowed', 'requested'].includes(visit.status) && Date.parse(visit.expiresAt) <= this.virtualFor(state, state.cursor)) visit.status = 'expired';
        for (const actor of state.actors) this.planRoutine(state, actor);
        this.repairObstructedRoutes(state);
        this.syncOccupancy(state);
        let next = target;
        const segment = this.db.prepare('SELECT real_at FROM companion_world_clock_segments WHERE real_at>? AND real_at<=? ORDER BY real_at,revision LIMIT 1').get(state.cursor, target);
        if (segment) next = Math.min(next, Number(row(segment).real_at));
        for (const work of state.works) if (work.status !== 'ended' && work.requestedAtReal > state.cursor) next = Math.min(next, work.requestedAtReal);
        for (const visit of state.visits) if (['allowed', 'requested'].includes(visit.status)) {
          const expires = this.realFor(state, Date.parse(visit.expiresAt)); if (expires > state.cursor) next = Math.min(next, expires);
        }
        for (const actor of state.actors) {
          const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
          next = Math.min(next, Math.max(state.cursor + 1, this.realFor(state, Date.parse(phase.nextTransitionAt))));
          // Split at a real energy threshold during offline catch-up. Otherwise
          // a long idle interval could skip the very need which should end it.
          const open = this.db.prepare('SELECT phase,habit_kind FROM companion_world_occupancy WHERE companion_id=? AND ends_at IS NULL').get(actor.companionId) as Row | undefined;
          const rate = companionWorldEnergyRate(open ? { phase: String(open.phase) as CompanionWorldOccupancy['phase'], habitKind: open.habit_kind ? String(open.habit_kind) as CompanionWorldOccupancy['habitKind'] : undefined } : undefined);
          const threshold = actor.recovery ? COMPANION_WORLD_RECOVERY.resumeEnergy : COMPANION_WORLD_RECOVERY.enterEnergy;
          if (rate < 0 && !actor.recovery && actor.state.energy > threshold || rate > 0 && actor.recovery && actor.state.energy < threshold) {
            const virtualMinutes = (threshold - actor.state.energy) / rate;
            next = Math.min(next, state.cursor + Math.max(1, Math.ceil(virtualMinutes * 60000 / companionWorldSpeed(this.clockAnchor(state.anchors, state.cursor).settings))));
          }
          if (actor.recovery?.retryAfter && actor.recovery.retryAfter > state.cursor) next = Math.min(next, actor.recovery.retryAfter);
          if (actor.route.length && actor.activity === 'walking') {
            const distance = actor.route.reduce((sum, point, index) => { const prior = index ? actor.route[index - 1]! : { ...actor.position, sceneId: actor.sceneId };
              return sum + (prior.sceneId === point.sceneId ? Math.hypot(point.x - prior.x, point.y - prior.y) : 1); }, 0);
            next = Math.min(next, state.cursor + Math.max(1, distance / actor.movementSpeed * 1000));
            if (actor.parkWalk?.stage === 'strolling') next = Math.min(next, state.cursor + Math.max(1,
              (actor.parkWalk.durationMinutes - actor.parkWalk.participatedMinutes) * 60000 / companionWorldSpeed(this.clockAnchor(state.anchors, state.cursor).settings)));
          }
          if (actor.journey && !actor.route.length && !actor.transition) next = Math.min(next, state.cursor + 1);
          if (actor.transition && actor.transition.until > state.cursor) next = Math.min(next, actor.transition.until);
        }
        const elapsed = next - state.cursor;
        for (let index = 0; index < state.actors.length; index++) {
          const actor = state.actors[index]!; if (!actor.route.length || actor.activity !== 'walking') continue;
          if (actor.route.some(point => point.sceneId !== actor.sceneId)) throw new Error('局部寻路中出现跨场景坐标。');
          const advanced = advanceCompanionWorldActor(actor, elapsed); state.actors[index] = { ...actor, ...advanced.actor, parkWalk: actor.parkWalk };
          const walk = actor.parkWalk;
          if (walk?.stage === 'strolling' && actor.sceneId === 'park') {
            const park = this.scenes(state).find(scene => scene.kind === 'park')!, bounds = companionWorldParkLayout(park);
            if (bounds && companionWorldParkContains(bounds, actor.position)) {
              const actualEnd = Math.min(next, state.cursor + advanced.usedMs);
              walk.participatedMinutes = Math.min(walk.durationMinutes, walk.participatedMinutes + this.elapsedVirtual(state.cursor, actualEnd) / 60000);
              const ticks = Math.floor((walk.participatedMinutes + .000001) / 10);
              if (ticks > walk.comfortTicks) {
                this.event(state, { kind: 'park_walk_relax', actorId: actor.companionId, sceneId: park.id,
                  text: `在花园中实际散步${Math.round(walk.participatedMinutes)}分钟，感受自然环境，逐渐放松。`,
                  effect: { type: 'comfort', intensity: Math.min(.2, (ticks - walk.comfortTicks) * .04) } }, actualEnd);
                walk.comfortTicks = ticks;
              }
            }
          }
          if (advanced.arrived) { const arrived = state.actors[index]!; if (arrived.journey) { arrived.activity = 'idle'; continue; } arrived.activity = arrived.arrivalActivity ?? 'idle'; arrived.activityStartedAtReal = iso(next); arrived.furnitureId = arrived.destinationId;
            const activity = arrived.activity; arrived.activity = 'idle'; this.enterFurniture(state, arrived, activity, next);
            this.event(state, { kind: 'arrive', actorId: actor.companionId, sceneId: arrived.sceneId, text: '步行到达' + arrived.destinationId }, next); }
        }
        state.cursor = next;
      }
      this.rememberClock(state);
      for (const visit of state.visits) if (['allowed', 'requested'].includes(visit.status) && Date.parse(visit.expiresAt) <= this.virtualFor(state, state.cursor)) visit.status = 'expired';
      this.finishTransitions(state); this.finishJourneys(state); for (const actor of state.actors) this.planRoutine(state, actor);
      this.syncOccupancy(state);
      this.expireSleepJobs(state);
      for (const actor of state.actors) if (actor.activity === 'sleeping' && !actor.route.length && state.cursor - Date.parse(actor.activityStartedAtReal) >= COMPANION_SLEEP_MINIMUM_REAL_MS &&
        !state.works.some(work => work.companionId === actor.companionId && work.status !== 'ended')) {
        this.queueJob(state, actor.companionId, 'dream');
        if (actor.lastDreamDay !== Math.floor(this.virtualFor(state, state.cursor) / 86400000)) { actor.lastDreamDay = Math.floor(this.virtualFor(state, state.cursor) / 86400000);
          this.event(state, { kind: 'sleep_rest', actorId: actor.companionId, sceneId: actor.sceneId, text: '在自己的床上安静休息', effect: { type: 'rest', intensity: .15 } }); }
      }
      const climate = companionWorldEnvironment(this.virtualFor(state, state.cursor), state.settings.timeZone);
      for (const actor of state.actors) {
        const outside = actor.sceneId === 'park', band = climate.environment.outdoorTemperature < 10 ? 'cold' : climate.environment.outdoorTemperature > 30 ? 'hot' : 'mild';
        const key = [climate.clock.day, climate.clock.daylight, climate.environment.weather, band, outside].join('_');
        if (key === actor.lastClimateKey) continue; actor.lastClimateKey = key;
        if (!outside) continue;
        const stressed = band !== 'mild' || ['rain', 'snow'].includes(climate.environment.weather);
        this.event(state, { kind: 'environment', actorId: actor.companionId, sceneId: actor.sceneId, text: stressed ? '感受到户外的降水或偏冷偏热天气' : '感受到花园的自然光线与空气', effect: { type: stressed ? 'stress' : 'comfort', intensity: stressed ? .15 : .08 } });
      }
      this.refreshPerceptions(state, target);
      this.observeEncounters(state, target);
      this.save(state); this.dirty = false; this.flushEffects();
    }).immediate(); } catch (error) { this.clockAnchors = undefined; this.actorProjection = []; this.activeWorld = undefined; this.through = 0; this.perceptionNextAt = 0; throw error; } finally { this.advancing = false; }
  }
  private flushEffects(): void {
    const through = Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='world-effects-through'").get() ?? { value: 0 }).value);
    const found = this.db.prepare("SELECT data FROM companion_world_events WHERE sequence>? AND json_extract(data,'$.effect') IS NOT NULL ORDER BY sequence").all(through) as Row[];
    for (const value of found) { const event = parse<StoredEvent>(value.data); if (event.effect && this.visibleEvent(event)) this.applyEffect(event); }
    if (found.length) this.db.prepare("INSERT INTO metadata(key,value) VALUES('world-effects-through',?) ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(metadata.value AS INTEGER),CAST(excluded.value AS INTEGER))").run(String(parse<StoredEvent>(found.at(-1)!.data).sequence));
  }
  private queueDecision(state: StoredWorld, actor: StoredActor): void {
    const now = this.virtualFor(state, state.cursor);
    if (now - actor.lastDecisionAt < 3 * 3600000 || actor.route.length) return;
    if (this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','running','waiting') LIMIT 1").get(actor.companionId)) return;
    actor.lastDecisionAt = now; this.queueJob(state, actor.companionId, 'decision');
  }
  private queueJob(state: StoredWorld, companionId: string, kind: CompanionWorldJob['kind'], encounterMemberIds?: string[]): CompanionWorldJob | undefined {
    const unfinished = (this.db.prepare("SELECT data FROM companion_world_jobs WHERE companion_id=? AND kind=? AND status IN ('pending','running','failed')").all(companionId, kind) as Row[])
      .map(value => parse<StoredJob>(value.data));
    if (unfinished.some(job => !job.terminal)) return;
    if (unfinished.length) {
      if (kind === 'dream') {
        const actor = state.actors.find(actor => actor.companionId === companionId);
        if (!actor || unfinished.some(job => job.sleepEpisodeId === this.sleepEpisode(actor))) return;
      } else {
        const through = Math.max(...unfinished.map(job => job.throughEventSequence));
        // A new actual communication/visit can justify a new background job.
        // Clock ticks and regenerated observations cannot restart the failure.
        const changed = this.db.prepare(`SELECT 1 FROM companion_world_events WHERE sequence>?
          AND (json_extract(data,'$.sourceMessageId') IS NOT NULL OR json_extract(data,'$.kind') IN('visit_request','visit_response','social_phone','social_face_to_face'))
          AND (json_extract(data,'$.actorId')=? OR json_extract(data,'$.targetId')=? OR EXISTS(SELECT 1 FROM json_each(data,'$.witnessIds') WHERE value=?)) LIMIT 1`)
          .get(through, companionId, companionId, companionId);
        if (!changed) return;
      }
    }
    if (kind === 'dream' && !this.unseenNotes(companionId, 1).length) return;
    const last = row(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM companion_world_events').get()).n;
    let conversationId = privateRoom(companionId);
    if (kind === 'dream') {
      const existing = this.db.prepare("SELECT id FROM conversations WHERE private_companion_id=? AND dissolved_at IS NULL").get(companionId);
      if (existing) conversationId = String(row(existing).id);
      else {
        conversationId = 'private-' + companionId;
        this.db.prepare("INSERT INTO conversations(id,kind,title,private_companion_id,updated_at,hidden_at) VALUES(?,'private','伙伴私聊',?,?,?)").run(conversationId, companionId, iso(), iso());
        this.db.prepare('INSERT INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(conversationId, companionId);
      }
    }
    const job: CompanionWorldJob = { id: randomUUID(), companionId, conversationId, kind, status: 'pending', throughEventSequence: Number(last), createdAt: iso(state.cursor), attempts: 0, sourceMemoryIds: [], ...(encounterMemberIds ? { encounterMemberIds } : {}) };
    if (kind === 'dream') {
      const actor = state.actors.find(actor => actor.companionId === companionId)!;
      job.sleepEpisodeId = this.sleepEpisode(actor);
      if (this.db.prepare("SELECT 1 FROM companion_world_jobs WHERE companion_id=? AND kind='dream' AND status='done' AND json_extract(data,'$.sleepEpisodeId')=? AND json_extract(data,'$.attempts')>=? LIMIT 1")
        .get(companionId, job.sleepEpisodeId, COMPANION_SLEEP_MAX_ATTEMPTS)) return;
      let episode = this.db.prepare('SELECT * FROM companion_world_sleep_episodes WHERE companion_id=? AND episode_id=?').get(companionId, job.sleepEpisodeId);
      if (!episode) {
        const virtualAt = this.virtualFor(state, state.cursor);
        const previous = this.db.prepare('SELECT virtual_at FROM companion_world_sleep_episodes WHERE companion_id=? AND admitted=1 ORDER BY virtual_at DESC LIMIT 1').get(companionId);
        const roll = Math.random();
        const admitted = (!previous || virtualAt - Number(row(previous).virtual_at) >= COMPANION_SLEEP_DREAM_COOLDOWN_MS)
          && roll < COMPANION_SLEEP_DREAM_PROBABILITY;
        this.db.prepare('INSERT INTO companion_world_sleep_episodes(companion_id,episode_id,virtual_at,roll,admitted) VALUES(?,?,?,?,?)')
          .run(companionId, job.sleepEpisodeId, virtualAt, roll, admitted ? 1 : 0);
        episode = this.db.prepare('SELECT * FROM companion_world_sleep_episodes WHERE companion_id=? AND episode_id=?').get(companionId, job.sleepEpisodeId);
      }
      job.dreamAllowed = Number(row(episode).admitted) === 1 && row(episode).job_id === null;
      if (job.dreamAllowed) this.db.prepare('UPDATE companion_world_sleep_episodes SET job_id=? WHERE companion_id=? AND episode_id=?')
        .run(job.id, companionId, job.sleepEpisodeId);
    }
    this.db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run(job.id, companionId, kind, job.status, JSON.stringify(job));
    return job;
  }
  private sleepEpisode(actor: StoredActor): string {
    return createHash('sha256').update(actor.companionId + '\n' + actor.activityStartedAtReal).digest('hex').slice(0, 48);
  }
  private sleepingForJob(state: StoredWorld, job: StoredJob): boolean {
    const actor = state.actors.find(actor => actor.companionId === job.companionId);
    return Boolean(actor && actor.activity === 'sleeping' && !actor.route.length
      && state.cursor - Date.parse(actor.activityStartedAtReal) >= COMPANION_SLEEP_MINIMUM_REAL_MS
      && (!job.sleepEpisodeId || job.sleepEpisodeId === this.sleepEpisode(actor))
      && !state.works.some(work => work.companionId === job.companionId && work.status !== 'ended'));
  }
  private expireSleepJobs(state: StoredWorld): void {
    for (const found of this.db.prepare("SELECT data FROM companion_world_jobs WHERE kind='dream' AND status IN('pending','running','failed')").all() as Row[]) {
      const job = parse<StoredJob>(found.data);
      if (job.terminal) continue; // A failed review is not a completed review after waking.
      if (this.sleepingForJob(state, job)) continue;
      job.status = 'done'; delete job.leaseToken;
      this.db.prepare("UPDATE companion_world_jobs SET status='done',lease_until=NULL,data=? WHERE id=?").run(JSON.stringify(job), job.id);
    }
  }
  private unseenNotes(companionId: string, limit: number): Array<{ id: string; version: number }> {
    return (this.db.prepare(`SELECT n.id,json_extract(n.data,'$.version') AS version FROM vcp_memory_notes n
      WHERE n.companion_id=? AND json_extract(n.data,'$.status')='indexed' AND json_array_length(json_extract(n.data,'$.sources'))>0
      AND json_extract(n.data,'$.archivedAt') IS NULL
      AND COALESCE(json_extract(n.data,'$.metadata.consolidation'),0)=0
      AND COALESCE(json_extract(n.data,'$.metadata.dream'),0)=0 AND COALESCE(json_extract(n.data,'$.metadata.simulation'),0)=0
      AND NOT EXISTS(SELECT 1 FROM companion_world_dream_watermark w WHERE w.companion_id=n.companion_id AND w.memory_id=n.id AND w.version=json_extract(n.data,'$.version'))
      AND n.conversation_id=(SELECT first.conversation_id FROM vcp_memory_notes first
        WHERE first.companion_id=n.companion_id AND json_extract(first.data,'$.status')='indexed'
        AND json_extract(first.data,'$.archivedAt') IS NULL
        AND json_array_length(json_extract(first.data,'$.sources'))>0 AND COALESCE(json_extract(first.data,'$.metadata.consolidation'),0)=0
        AND COALESCE(json_extract(first.data,'$.metadata.dream'),0)=0 AND COALESCE(json_extract(first.data,'$.metadata.simulation'),0)=0
        AND NOT EXISTS(SELECT 1 FROM companion_world_dream_watermark done WHERE done.companion_id=first.companion_id AND done.memory_id=first.id AND done.version=json_extract(first.data,'$.version'))
        ORDER BY first.rowid LIMIT 1)
      ORDER BY n.rowid LIMIT ?`).all(companionId, limit) as Row[]).map(value => ({ id: String(value.id), version: Number(value.version) }));
  }
  /** A fresh original batch may explicitly read one prior merge from the same
   * source domain. Derived material alone never starts another sleep job. */
  private sleepSeeds(companionId: string): Array<{ id: string; version: number }> {
    const fresh = this.unseenNotes(companionId, COMPANION_SLEEP_SEED_LIMIT);
    if (!fresh.length) return fresh;
    const originals = fresh.map(note => parse<CompanionMemory>(row(this.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note.id)).data));
    const previous = (this.db.prepare(`SELECT data FROM vcp_memory_notes WHERE companion_id=?
      AND json_extract(data,'$.status')='indexed' AND json_extract(data,'$.archivedAt') IS NULL
      AND json_extract(data,'$.metadata.automaticConsolidation')=1 AND json_extract(data,'$.sourceConversationId')=?
      ORDER BY rowid DESC LIMIT ?`).all(companionId, originals[0]!.sourceConversationId, COMPANION_SLEEP_SEED_LIMIT) as Row[])
      .map(value => parse<CompanionMemory>(value.data)).find(note => companionAutomaticConsolidationHasNovelty([...originals, note]));
    return previous ? [...fresh.slice(0, COMPANION_SLEEP_SEED_LIMIT - 1), { id: previous.id, version: previous.version }] : fresh;
  }
  /** New original experience may justify maintaining older, still-live originals.
   * These are an independent readset, never extra reflection/watermark seeds. */
  private maintenanceSeeds(companionId: string, seeds: readonly { id: string; version: number }[]): Array<{ id: string; version: number }> {
    if (!seeds.length) return [];
    if (seeds.length >= COMPANION_SLEEP_SEED_LIMIT) return [...seeds];
    const first = parse<CompanionMemory>(row(this.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(seeds[0]!.id)).data);
    const cursorKey = 'world-maintenance-original-cursor/' + createHash('sha256').update(JSON.stringify([companionId, first.sourceConversationId])).digest('hex');
    const storedCursor = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(cursorKey);
    const cursor = storedCursor ? Number(row(storedCursor).value) : 0;
    const candidates = this.db.prepare(`SELECT n.rowid AS ordinal,n.data FROM vcp_memory_notes n WHERE n.companion_id=?
      AND json_extract(n.data,'$.status')='indexed' AND json_extract(n.data,'$.archivedAt') IS NULL
      AND json_extract(n.data,'$.sourceConversationId')=? AND json_array_length(json_extract(n.data,'$.sources'))>0
      AND json_type(n.data,'$.metadata.consolidation') IS NULL
      AND COALESCE(json_extract(n.data,'$.metadata.automaticConsolidation'),0)=0
      AND COALESCE(json_extract(n.data,'$.metadata.sleepReflection'),0)=0
      AND COALESCE(json_extract(n.data,'$.metadata.dream'),0)=0 AND COALESCE(json_extract(n.data,'$.metadata.simulation'),0)=0
      AND json_type(n.data,'$.metadata.characterDevelopment') IS NULL
      AND n.id NOT IN(SELECT value FROM json_each(?))
      AND EXISTS(SELECT 1 FROM companion_world_dream_watermark w WHERE w.companion_id=n.companion_id AND w.memory_id=n.id AND w.version=json_extract(n.data,'$.version'))
      ORDER BY (n.rowid<=?),n.rowid LIMIT ?`).all(companionId, first.sourceConversationId, JSON.stringify(seeds.map(note => note.id)),
      Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0, COMPANION_SLEEP_SEED_LIMIT) as Row[];
    const selected = [...seeds];
    for (const value of candidates) {
      const note = parse<CompanionMemory>(value.data);
      const sources = this.visibleSources({ companionId, conversationId: note.sourceConversationId }, note.sources.map(source => source.messageId));
      const valid = sources.length === note.sources.length && note.sources.every(source => sources.some(actual => actual.id === source.messageId
        && actual.conversationId === source.conversationId
        && Number(row(this.db.prepare('SELECT revision FROM messages WHERE id=? AND conversation_id=?').get(actual.id, actual.conversationId) ?? {}).revision ?? 1) === source.revision
        && createHash('sha256').update(actual.content).digest('hex') === source.checksum));
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(cursorKey, String(value.ordinal));
      if (valid) selected.push({ id: note.id, version: note.version });
      if (selected.length >= COMPANION_SLEEP_SEED_LIMIT) break;
    }
    return selected;
  }
  /** Observe persisted scheduling state without ticking the world or drawing a dream. */
  private sleepPlan(companionId: string): CompanionWorldSleepPlan {
    const owner = this.db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(companionId);
    if (!owner) throw new Error('伙伴不存在或已移除。');
    const now = Date.now(), checkedAt = iso(now), saved = this.db.prepare('SELECT data FROM companion_world WHERE id=1').get();
    const state = saved ? parse<StoredWorld>(row(saved).data) : undefined;
    const settings = state?.settings ?? { ...COMPANION_WORLD_DEFAULT_SETTINGS, revision: 1, timeZone: resolveCompanionScheduleTimeZone('system') };
    const observedAt = state?.cursor ?? now, virtualNow = state ? this.virtualFor(state, observedAt) : now;
    const actor = state?.actors.find(actor => actor.companionId === companionId);
    let routine = defaultCompanionRoutineConfig(companionId);
    const storedRoutine = this.db.prepare('SELECT data FROM companion_routines WHERE companion_id=?').get(companionId);
    if (storedRoutine) {
      const value = parse<{ config: CompanionRoutineConfig; configurationSources?: Array<{ conversationId: string; messageId: string }> }>(row(storedRoutine).data);
      let visible = true;
      for (const source of value.configurationSources ?? []) try {
        if (!this.visibleSources({ companionId, conversationId: source.conversationId }, [source.messageId]).some(message => message.authorId === 'user')) visible = false;
      } catch { visible = false; }
      if (visible) routine = value.config;
    }
    // The world owns civil time; do not reintroduce a stale per-routine timezone.
    routine = { ...routine, timeZone: settings.timeZone };
    const episodeId = actor?.activity === 'sleeping' ? this.sleepEpisode(actor) : undefined;
    const episode = episodeId ? this.db.prepare('SELECT admitted FROM companion_world_sleep_episodes WHERE companion_id=? AND episode_id=?').get(companionId, episodeId) : undefined;
    const prior = this.db.prepare('SELECT MAX(virtual_at) AS at FROM companion_world_sleep_episodes WHERE companion_id=? AND admitted=1').get(companionId);
    const cooldown = prior && row(prior).at !== null ? Number(row(prior).at) + COMPANION_SLEEP_DREAM_COOLDOWN_MS : undefined;
    const foundJob = episodeId ? this.db.prepare("SELECT data,lease_until FROM companion_world_jobs WHERE companion_id=? AND kind='dream' AND status IN('pending','running','failed') AND json_extract(data,'$.sleepEpisodeId')=? ORDER BY rowid DESC LIMIT 1").get(companionId, episodeId) : undefined;
    const job = foundJob ? parse<StoredJob>(row(foundJob).data) : undefined;
    const capture = row(this.db.prepare(`SELECT
      COALESCE(SUM(status='pending'),0) AS pending,COALESCE(SUM(status='running'),0) AS running,COALESCE(SUM(status='failed'),0) AS failed,
      COALESCE(SUM(status='running' AND lease_until>?),0) AS live,COALESCE(SUM(status='running' AND (lease_until IS NULL OR lease_until<=?)),0) AS expired,
      COALESCE(SUM(status IN('pending','failed') AND attempts>=8),0) AS exhausted,
      COALESCE(SUM(status IN('pending','failed') AND EXISTS(SELECT 1 FROM vcp_source_policy_holds h WHERE h.companion_id=j.companion_id AND h.conversation_id IN(j.conversation_id,'*') AND h.released_at IS NULL)),0) AS held,
      COALESCE(SUM(status IN('pending','failed') AND attempts<8 AND next_attempt<=? AND NOT EXISTS(SELECT 1 FROM vcp_source_policy_holds h WHERE h.companion_id=j.companion_id AND h.conversation_id IN(j.conversation_id,'*') AND h.released_at IS NULL)),0) AS eligible,
      MIN(CASE WHEN status IN('pending','failed') AND attempts<8 AND NOT EXISTS(SELECT 1 FROM vcp_source_policy_holds h WHERE h.companion_id=j.companion_id AND h.conversation_id IN(j.conversation_id,'*') AND h.released_at IS NULL) THEN next_attempt END) AS next
      FROM vcp_capture_jobs j WHERE companion_id=? AND status IN('pending','running','failed')`).get(now, now, now, companionId));
    const grants = this.db.prepare('SELECT data,autonomous,revision,next_at,manual,lease_token,lease_until FROM companion_learning_grants WHERE companion_id=? AND enabled=1 ORDER BY rowid LIMIT 48').all(companionId) as Row[];
    return { companionId, checkedAt, active: parse<{ active?: boolean }>(row(owner).data).active !== false,
      resetting: !!this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed' LIMIT 1").get(companionId),
      clock: { realNow: checkedAt, virtualNow: iso(virtualNow), observedRealAt: iso(observedAt), timeZone: settings.timeZone, speed: companionWorldSpeed(settings) }, routine,
      ...(actor ? { actor: { activity: actor.activity, routinePhase: actor.routinePhase, activityStartedAtReal: actor.activityStartedAtReal, moving: actor.route.length > 0,
        working: !!state?.works.some(work => work.companionId === companionId && work.status !== 'ended') } } : {}),
      hasUnconsolidated: this.unseenNotes(companionId, 1).length > 0,
      admission: episode ? Number(row(episode).admitted) === 1 ? 'admitted' : 'not_admitted' : 'unchecked',
      ...(cooldown && cooldown > virtualNow ? { dreamCooldownUntilWorld: iso(cooldown) } : {}),
      ...(job ? { job: { status: job.status as 'pending' | 'running' | 'failed', attempts: job.attempts, dreamAllowed: job.dreamAllowed === true,
        ...(job.terminal ? { terminal: true, error: job.error } : {}),
        leaseActive: job.status === 'running' && String(row(foundJob!).lease_until) > checkedAt,
        ...(job.status === 'failed' && row(foundJob!).lease_until ? { nextAttemptAt: String(row(foundJob!).lease_until) } : {}) } } : {}),
      captureQueue: { pending: Number(capture.pending), running: Number(capture.running), failed: Number(capture.failed), liveRunning: Number(capture.live), expiredLeases: Number(capture.expired), held: Number(capture.held),
        retryExhausted: Number(capture.exhausted), eligible: Number(capture.eligible), ...(capture.next !== null && Number(capture.next) > now ? { nextAttemptAt: iso(Number(capture.next)) } : {}) },
      learning: grants.slice(0, 47).map(found => {
        const grant = parse<CompanionLearningGrant>(found.data), live = !!found.lease_token && Number(found.lease_until) > now;
        return { grant: { ...grant, enabled: true, autonomous: Number(found.autonomous) === 1, revision: Number(found.revision), nextAt: iso(Number(found.next_at)),
          ...(live ? { status: 'reading' as const } : grant.status === 'reading' ? { status: 'waiting' as const, error: '上次阅读的租约已过期，等待后台重新领取。' } : {}) }, manualPending: Number(found.manual) === 1 };
      }),
      learningHasMore: grants.length > 47 };
  }
  private visibleEvent(event: StoredEvent, scope?: CompanionWorldScope): boolean {
    try { return this.sourceEventVisible(event, scope); } catch { return false; }
  }
  private sourceEventVisible(event: StoredEvent, scope?: CompanionWorldScope): boolean {
    if (event.withdrawn) return false;
    if (scope && event.privateOwner && event.privateOwner !== scope.companionId) return false;
    if (scope && event.actorId !== scope.companionId && event.targetId !== scope.companionId && event.privateOwner !== scope.companionId && !event.witnessIds?.includes(scope.companionId)) return false;
    const owner = event.privateOwner ?? event.actorId;
    const sourceIds = [...new Set([...(event.sourceMessageId ? [event.sourceMessageId] : []), ...event.sourceMessageIds ?? []])];
    // Legacy quotations have no trustworthy version. Do not certify their old
    // text with the checksum of whatever the source happens to contain today.
    if (sourceIds.some(id => !event.sourceReads?.some(reference => reference.id === id && this.sourceReadValid(reference, id, reference.conversationId)))) return false;
    if (event.sourceMessageId && owner && event.conversationId) {
      let s = scope ?? { companionId: owner, conversationId: event.conversationId };
      if (scope && this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + scope.conversationId) &&
        this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + event.conversationId) &&
        this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(event.conversationId, scope.companionId)) s = { ...scope, conversationId: event.conversationId };
      if (!this.visibleSources(s, [event.sourceMessageId]).length) return false;
    }
    if (event.sourceMessageIds?.length && owner && event.conversationId && this.visibleSources(scope ?? { companionId: owner, conversationId: event.conversationId }, event.sourceMessageIds).length !== event.sourceMessageIds.length) return false;
    if (event.sourceMemoryIds?.length && owner && event.sourceMemoryIds.some(id => !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.status')='indexed'").get(id, owner))) return false;
    if (event.memoryVersions?.some(memory => !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status')='indexed'").get(memory.id, memory.version))) return false;
    // A past witnessed visit stays a past experience after its entry permission
    // expires. Current permission gates physical entry, not owned recollection.
    return true;
  }
  invalidateEvidence(companionId: string, sourceIds: string[]): void {
    this.dirty = true;
    const state = this.load();
    for (const source of sourceIds) for (const found of this.db.prepare('SELECT * FROM companion_world_peer_appraisals WHERE companion_id=? AND source_message_id=? AND active=1').all(companionId, source) as Row[]) {
      const relation = state.relationships.find(item => item.companionId === companionId && item.targetCompanionId === found.target_id);
      if (relation) { relation.affinity = Math.max(0, Math.min(100, relation.affinity - Number(found.affinity_delta))); relation.trust = Math.max(0, Math.min(100, relation.trust - Number(found.trust_delta))); }
      this.db.prepare('UPDATE companion_world_peer_appraisals SET active=0 WHERE companion_id=? AND event_id=?').run(companionId, found.event_id);
    }
    this.save(state);
  }
  private snapshotValue(state: StoredWorld, now: number, scope?: CompanionWorldScope): CompanionWorldSnapshot {
    const previous = this.advancing; this.advancing = true;
    try { return this.buildSnapshotValue(state, now, scope); } finally { this.advancing = previous; }
  }
  private buildSnapshotValue(state: StoredWorld, now: number, scope?: CompanionWorldScope): CompanionWorldSnapshot {
    // A bounded offline tick may not have reached the wall clock yet. Render the
    // same observed instant as positions and physical recovery, not future weather
    // or completed animation frames that the simulation has not reached.
    const observedAt = state.cursor, virtualAt = this.virtualFor(state, observedAt), environment = companionWorldEnvironment(virtualAt, state.settings.timeZone), scenes = this.scenes(state);
    const perception = scope ? this.perception(scope.companionId) : undefined;
    const allowedScenes = scope ? scenes.filter(scene => scene.kind === 'park' || scene.ownerId && this.permitted(state, scope.companionId, scene.ownerId))
      .map(scene => ({ ...scene, objects: perception?.objects.filter(object => object.sceneId === scene.id).map(object => ({ id: object.id, kind: object.kind, name: object.name,
        position: object.position, width: object.width, depth: object.depth, anchor: object.anchor, blocking: object.blocking })) ?? [] })) : scenes;
    const visibleIds = new Set(allowedScenes.map(scene => scene.id));
    const found = this.db.prepare('SELECT data FROM companion_world_events ORDER BY sequence DESC LIMIT 500').all() as Row[];
    const events = found.map(value => parse<StoredEvent>(value.data)).filter(event => this.visibleEvent(event, scope)).slice(0, 100).reverse().map(event => event.kind === 'social_phone' ? { ...event, sceneId: undefined } : event);
    const sensedEnvironment = perception ? { light: perception.environment.light,
      ...(perception.environment.weatherObservedAtVirtual === perception.observedAtVirtual ? { weather: perception.environment.weather } : {}),
      ...(perception.sceneId === 'park' ? { outdoorTemperature: perception.environment.temperature } : { indoorTemperature: perception.environment.temperature }) } : { light: 0 };
    const sensedAt = perception ? Date.parse(perception.observedAtVirtual) : virtualAt;
    return companionWorldSnapshotSchema.parse({ settings: state.settings, clock: { realNow: iso(now), virtualNow: iso(scope ? sensedAt : virtualAt), speed: companionWorldSpeed(state.settings),
      ...(scope ? companionWorldEnvironment(sensedAt, state.settings.timeZone).clock : environment.clock) }, environment: scope ? sensedEnvironment : environment.environment,
      residents: (this.db.prepare("SELECT id,json_extract(data,'$.name') AS name,json_extract(data,'$.active') AS active FROM companions WHERE deleted_at IS NULL ORDER BY rowid").all() as Row[]).map(companion => ({ companionId: String(companion.id), name: String(companion.name), active: companion.active === 1, ...(!scope || scope.companionId === companion.id ? { homeSceneId: 'home_' + companion.id } : {}) })),
      knownAddresses: scope ? this.homeKnowledge(scope.companionId, state) : [],
      ...(perception ? { perception } : {}),
      scenes: allowedScenes, actors: state.actors.filter(actor => scope ? actor.companionId === scope.companionId : visibleIds.has(actor.sceneId)).map(actor => {
        const runtime = { ...this.runtime(actor.companionId), thermalComfort: Math.max(0, 1 - Math.abs((actor.sceneId === 'park' ? environment.environment.outdoorTemperature : environment.environment.indoorTemperature) - 22) / 15) };
        const pose: CompanionWorldActor['artAction'] = actor.activity === 'walking' ? actor.locomotion : actor.activity === 'working' ? 'work' : actor.activity === 'seating' ? 'sitDown' : actor.activity === 'sitting' ? 'sit' :
          actor.activity === 'standingUp' ? 'standUp' : actor.activity === 'lyingDown' ? 'lieDown' : actor.activity === 'waking' ? 'wake' : actor.activity === 'turning' ? 'turn' : actor.activity === 'sleeping' ? 'sleep' : actor.activity === 'eating' ? 'eat' : actor.activity === 'resting' ? 'rest' :
            actor.activity === 'habit' ? actor.manualArtAction ?? this.habitArt(state, actor) : 'idle';
        const expression = companionWorldExpression({ companionId: actor.companionId, pose, state: runtime, events, now: observedAt });
        const communicationRow = this.db.prepare('SELECT data FROM companion_social_communication WHERE companion_id=? AND until_real>?').get(actor.companionId, iso(observedAt));
        const storedCommunication = communicationRow ? parse<NonNullable<CompanionWorldActor['communication']>>(row(communicationRow).data) : undefined;
        const noticeRow = this.db.prepare("SELECT data,lease_until FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>? ORDER BY created_at,id LIMIT 1").get(actor.companionId, iso(observedAt));
        const noticeCommunication = noticeRow ? { channel: 'phone' as const, phase: 'typing' as const, conversationId: parse<{ conversationId: string }>(row(noticeRow).data).conversationId, recipientIds: ['user'], untilReal: String(row(noticeRow).lease_until) } : undefined;
        const chat = state.works.find(work => work.companionId === actor.companionId && work.kind === 'chat' && work.status === 'ready');
        const communication: CompanionWorldActor['communication'] = chat ? { channel: 'phone', phase: 'responding', conversationId: chat.conversationId, recipientIds: ['user'], untilReal: iso(observedAt + 5000) }
          : storedCommunication ? { channel: storedCommunication.channel, phase: storedCommunication.phase, conversationId: storedCommunication.conversationId, recipientIds: storedCommunication.recipientIds, untilReal: storedCommunication.untilReal } : noticeCommunication;
        const phonePose = ['typing', 'responding'].includes(communication?.phase ?? '') && !['sleeping', 'eating', 'working'].includes(actor.routinePhase) && ['idle', 'sitting', 'resting'].includes(actor.activity) ? ['sitting', 'resting'].includes(actor.activity) ? 'phoneTypingSeated' : 'phoneTypingStanding' : undefined;
        return { ...actor, travel: actor.journey ? { targetSceneId: actor.journey.targetSceneId, exitId: actor.journey.exitId, entryId: actor.journey.entryId } : undefined,
        frame: actor.transition ? Math.min(2, Math.floor(Math.max(0, observedAt - Date.parse(actor.activityStartedAtReal)) / (actor.transition.until - Date.parse(actor.activityStartedAtReal)) * 3)) :
            Math.floor(Math.max(0, observedAt - Date.parse(actor.activityStartedAtReal)) / (actor.activity === 'walking' ? 180 : 700)) % 3,
        transitionEndsAtReal: actor.transition ? iso(actor.transition.until) : undefined,
        state: runtime, artAction: communication?.channel === 'face_to_face' ? communication.phase === 'speaking' ? 'communicate' : 'think' : phonePose ?? expression.action, artStartedAtReal: expression.startedAtReal,
        communication: !scope || scope.companionId === actor.companionId || communication?.recipientIds.includes(scope.companionId) ? communication : undefined,
        activityLabel: actor.parkWalk ? actor.parkWalk.stage === 'travelling' ? '正在前往公共花园' : actor.parkWalk.stage === 'returning' ? '散步结束，正在回家' : '在公共花园散步放松' : actor.recovery && actor.destinationId === actor.recovery.furnitureId ? actor.activity === 'resting' ? '正在休息，恢复精力' : '正在前往沙发恢复精力' : actor.routinePhase === 'habit' ? '个人日常活动' : undefined }; }),
      visits: state.visits.filter(visit => !scope || visit.hostId === scope.companionId || visit.guestId === scope.companionId).map(visit => {
        const visible = (owner: string, sourceId?: string, conversationId?: string, sourceRead?: CompanionWorldVisit['sourceRead']) => {
          if (!sourceId) return true; if (!conversationId) return false;
          if (!this.sourceReadValid(sourceRead, sourceId, conversationId)) return false;
          try { return !!this.visibleSources(scope ?? { companionId: owner, conversationId }, [sourceId]).length; } catch { return false; }
        };
        const reasonVisible = visible(visit.guestId, visit.sourceMessageId, visit.conversationId, visit.sourceRead), responseVisible = visible(visit.hostId, visit.responseSourceMessageId, visit.responseConversationId, visit.responseSourceRead);
        return { ...visit, reason: reasonVisible ? visit.reason : '申请来小屋做客', response: responseVisible ? visit.response : visit.response ? '房主已回应拜访请求' : undefined,
          sourceMessageId: reasonVisible ? visit.sourceMessageId : undefined, conversationId: reasonVisible ? visit.conversationId : undefined, sourceRead: reasonVisible ? visit.sourceRead : undefined,
          responseSourceMessageId: responseVisible ? visit.responseSourceMessageId : undefined, responseConversationId: responseVisible ? visit.responseConversationId : undefined,
          responseSourceRead: responseVisible ? visit.responseSourceRead : undefined };
      }), events,
      relationships: state.relationships.filter(relation => !scope || relation.companionId === scope.companionId), works: state.works.filter(work => !scope || work.companionId === scope.companionId),
      lastEventSequence: Number(row(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM companion_world_events').get()).n), backlog: state.cursor + 1 < now });
  }
  snapshot(scope?: CompanionWorldScope): CompanionWorldSnapshot {
    if (scope) this.requireScope(scope);
    const now = Date.now(); this.ensureThrough(now); return this.atomic(() => { const state = this.load(); this.sync(state);
    // Explicit actor observation must describe the same instant as its route,
    // arrival and work receipts. Observer windows retain the periodic throttle.
    this.refreshPerceptions(state, now, scope?.companionId); this.save(state);
    // A snapshot observes one instant. SQL/projection time after catching up is
    // not new offline simulation debt and must not suppress autonomous events.
    return this.snapshotValue(state, now, scope); });
  }
  private habitArt(state: StoredWorld, actor: StoredActor): CompanionWorldActor['artAction'] {
    const config = this.routineConfig(actor.companionId), phase = evaluateCompanionRoutine(config, iso(this.virtualFor(state, state.cursor))), kind = config.habits.find(habit => habit.id === phase.activeHabitId)?.kind;
    return kind === 'study' ? 'read' : kind === 'exercise' ? 'exercise' : kind === 'rest' || kind === 'leisure' ? 'rest' : 'idle';
  }
  configure(expectedRevision: number, patch: Partial<Omit<CompanionWorldSettings, 'revision'>>): CompanionWorldSnapshot {
    const now = Date.now(); this.advance(now); return this.atomic(() => { const state = this.load(); if (state.settings.revision !== expectedRevision) throw new Error('世界设置已更新，请重新读取。');
    if (state.cursor < now) throw new Error('世界存档仍在补算，请完成后再修改时间设置。');
    const current = this.virtualFor(state, now); state.settings = { ...state.settings, ...patch, revision: state.settings.revision + 1 };
    if (!isCompanionScheduleTimeZone(state.settings.timeZone)) throw new Error('世界时区无效。'); state.settings.timeZone = resolveCompanionScheduleTimeZone(state.settings.timeZone);
    const nextVirtual = state.settings.mode === 'realtime' ? now : current, shift = nextVirtual - current;
    for (const visit of state.visits) if (activeVisit(visit)) visit.expiresAt = iso(Math.max(nextVirtual, Date.parse(visit.expiresAt) + shift));
    for (const actor of state.actors) {
      actor.lastDecisionAt += shift;
      if (actor.manualActivityUntil !== undefined) actor.manualActivityUntil += shift;
    }
    state.anchors.push({ realAt: now, virtualAt: nextVirtual, settings: { ...state.settings } }); this.rememberClock(state);
    this.syncOccupancy(state); this.save(state); this.dirty = true; return this.snapshotValue(state, now); });
  }
  begin(scope: CompanionWorldScope, workId: string, kind: CompanionWorldWork['kind'], sourceMessageId?: string, urgent = false, fixed = false, learning: WorkProof = {}): CompanionWorldWork {
    const requestedAtReal = Date.now(); this.requireScope(scope); this.advance(requestedAtReal);
    return this.atomic(() => this.beginAt(scope, workId, kind, requestedAtReal, sourceMessageId, urgent, fixed, learning));
  }
  private beginAt(scope: CompanionWorldScope, workId: string, kind: CompanionWorldWork['kind'], requestedAtReal: number, sourceMessageId?: string, urgent = false, fixed = false, learning: WorkProof = {}): CompanionWorldWork {
    const state = this.load();
    if (!state.actors.some(actor => actor.companionId === scope.companionId)) throw new Error('伙伴已休眠，请先手动激活。');
    if (kind === 'learning') {
      if (sourceMessageId || urgent || fixed || learning.authorizationGrantId || learning.invocationId || !this.learningWorkAllowed({ ...scope, ...learning })) throw new Error('资料阅读需要本人世界域中仍有效的明确授权和读取租约。');
    } else if (learning.learningGrantId || learning.learningLeaseToken) throw new Error('学习租约不能授权其它行动。');
    else if (learning.authorizationGrantId) {
      if (!this.collaborationAllowed || !sourceMessageId || !learning.invocationId || kind !== 'action' || urgent || fixed) throw new Error('协作电脑工作需要本人真实授权，不能借此扩大固定、紧急或其它行动权限。');
      this.collaborationAllowed({ ...scope, authorizationGrantId: learning.authorizationGrantId, sourceMessageId, invocationId: learning.invocationId });
    }
    else if (learning.invocationId) throw new Error('独立协作身份缺少真实协作授权。');
    else if (sourceMessageId) { const source = this.visibleSources(scope, [sourceMessageId])[0]; if (!source || source.authorId !== 'user') throw new Error('工作需要真实可见的用户来源。'); const verified = this.urgent(scope.companionId, sourceMessageId); if (urgent && !verified) throw new Error('来源缺少已核验的紧急通知判断。'); urgent = verified; }
    else if (!fixed) throw new Error('工作缺少真实用户来源。');
    let work = state.works.find(work => work.workId === workId);
    if (!work) { const saved = this.db.prepare('SELECT data FROM companion_world_work_records WHERE work_id=?').get(workId); if (saved) { work = parse<StoredWork>(row(saved).data); state.works.push(work); } }
    if (work && (work.companionId !== scope.companionId || work.conversationId !== scope.conversationId || work.kind !== kind || work.sourceMessageId !== sourceMessageId || work.learningGrantId !== learning.learningGrantId || work.learningLeaseToken !== learning.learningLeaseToken || work.authorizationGrantId !== learning.authorizationGrantId || work.invocationId !== learning.invocationId)) throw new Error('工作不属于当前伙伴或原来的来源。');
    if (!work) { work = { workId, companionId: scope.companionId, conversationId: scope.conversationId, kind, sourceMessageId, urgent, fixed, requestedAtReal, ...learning, status: 'waiting' }; state.works.push(work); }
    else if (work.status === 'ended') { work.status = 'waiting'; work.urgent = urgent; work.fixed = fixed; work.requestedAtReal = requestedAtReal; delete work.computerId; delete work.reason; }
    this.planRoutine(state, state.actors.find(actor => actor.companionId === scope.companionId)!);
    this.syncOccupancy(state); this.save(state); return work;
  }
  ready(companionId: string, workId: string): CompanionWorldWork {
    const now = Date.now(); this.advance(now); const saved = this.db.prepare('SELECT data FROM companion_world_work_records WHERE work_id=? AND companion_id=?').get(workId, companionId); if (!saved) throw new Error('工作不存在。');
    const work = parse<StoredWork>(row(saved).data);
    if (work.authorizationGrantId && work.status !== 'ended' && !this.workSourceAllowed(work)) { this.end(companionId, workId); throw new Error('协作授权已失效，停止这个电脑预约。'); }
    return this.through < now && work.status !== 'ended' ? { ...work, status: 'waiting', reason: '正在补算世界存档', nextCheckAt: iso(now + 250) } : work;
  }
  end(companionId: string, workId: string): CompanionWorldWork | undefined {
    this.ensureThrough(Date.now());
    return this.atomic(() => this.endAt(companionId, workId));
  }
  private endAt(companionId: string, workId: string): CompanionWorldWork | undefined {
    const state = this.load(), work = state.works.find(item => item.workId === workId && item.companionId === companionId); if (!work) { const saved = this.db.prepare('SELECT data FROM companion_world_work_records WHERE work_id=? AND companion_id=?').get(workId, companionId); return saved ? parse<StoredWork>(row(saved).data) : undefined; }
    if (work.status !== 'ended') { work.status = 'ended'; const actor = state.actors.find(actor => actor.companionId === companionId)!;
      if (work.kind === 'chat') {
        if (!state.works.some(item => item.companionId === companionId && item.kind === 'chat' && item.status === 'ready')) this.releasePhone(actor, state.cursor);
        this.event(state, { kind: 'phone_response_end', actorId: companionId, text: '结束手机回复，继续当前生活' }); this.planRoutine(state, actor); this.syncOccupancy(state);
      } else if (!state.works.some(item => item.companionId === companionId && ['moving', 'seating', 'ready'].includes(item.status))) {
        actor.route = []; delete actor.destinationId;
        if (['working', 'sitting', 'seating'].includes(actor.activity)) this.startTransition(state, actor, 'standingUp', 'idle', state.cursor);
        else if (actor.transition) actor.transition.after = 'idle';
        else { actor.activity = 'idle'; delete actor.furnitureId; }
      }
      if (work.kind !== 'chat' && actor.phoneResume?.activity === 'working' && !state.works.some(item => item.companionId === companionId && item.kind !== 'chat' && ['moving', 'seating', 'ready'].includes(item.status))) {
        actor.phoneResume.activity = 'sitting'; actor.activity = 'sitting';
      }
      if (work.kind !== 'chat') this.event(state, { kind: 'work_end', actorId: companionId, text: '结束电脑工作并释放预约' }); this.save(state); }
    const actor = state.actors.find(item => item.companionId === companionId);
    if (actor?.afterWork && !state.works.some(item => item.companionId === companionId && ['moving', 'seating', 'ready'].includes(item.status))) {
      const deferred = actor.afterWork; delete actor.afterWork; this.save(state);
      if (!deferred.sourceMessageId || this.visibleSources(deferred.scope, [deferred.sourceMessageId]).length) this.tool(deferred.scope, deferred.args, deferred.sourceMessageId);
    }
    return work;
  }
  tool(scope: CompanionWorldScope, args: CompanionWorldArguments, sourceMessageId?: string): CompanionWorldSnapshot {
    return this.atomic(() => this.performTool(scope, args, sourceMessageId));
  }
  startLifeActivity(scope: CompanionWorldScope, kind: 'rest' | 'study' | 'leisure'): void {
    this.atomic(() => {
      this.requireScope(scope); this.ensureThrough(Date.now()); const state = this.load(), actor = state.actors.find(actor => actor.companionId === scope.companionId)!;
      if (actor.parkWalk) this.finishParkWalk(state, actor, '改为进行另一项生活活动', false);
      if (state.works.some(work => work.companionId === actor.companionId && work.status !== 'ended')) throw new Error('正在回应或工作，不能同时开始新的生活活动。');
      const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId)!, object = home.objects.find(object => object.kind === (kind === 'rest' ? 'sofa' : 'habit'))!;
      this.move(state, actor, home, object.anchor, object.id, kind === 'rest' ? 'resting' : 'habit');
      actor.manualActivityUntil = this.virtualFor(state, state.cursor) + 30 * 60000;
      actor.manualArtAction = kind === 'study' ? 'standingRead' : kind === 'leisure' ? 'think' : undefined;
      this.event(state, { kind: 'life_activity', actorId: actor.companionId, sceneId: actor.sceneId, text: '开始前往' + object.name + '进行' + kind }); this.syncOccupancy(state); this.save(state);
    });
  }
  startParkWalk(scope: CompanionWorldScope, durationMinutes: number, occurrenceId?: string): void {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 10 || durationMinutes > 120) throw new Error('公园散步时长需要在10到120分钟之间。');
    this.atomic(() => {
      this.requireScope(scope); const now = Date.now(); this.ensureThrough(now); const state = this.load(), actor = state.actors.find(actor => actor.companionId === scope.companionId)!;
      if (actor.parkWalk) {
        if (occurrenceId && actor.parkWalk.occurrenceId === occurrenceId) return;
        throw new Error('伙伴已经在进行一次公园散步。');
      }
      const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
      if (state.cursor + 1 < now || ['sleeping', 'eating'].includes(phase.phase) || ['working', 'eating', 'sleeping', 'lyingDown', 'waking'].includes(actor.activity)
        || state.works.some(work => work.companionId === actor.companionId && work.kind !== 'chat' && work.status !== 'ended')) throw new Error('伙伴此刻正在工作、用餐、睡眠或恢复存档，无法开始散步。');
      const climate = companionWorldEnvironment(this.virtualFor(state, state.cursor), state.settings.timeZone).environment;
      if (this.runtime(actor.companionId).energy <= 25 || actor.sceneId === 'park' && !companionWorldParkSuitable(climate)) throw new Error('当前感受到的户外天气或伙伴精力不适合开始公园散步。');
      const scenes = this.scenes(state), park = scenes.find(scene => scene.kind === 'park')!, circuit = companionWorldParkCircuit(park);
      if (!circuit.length) throw new Error('公园的真实步道暂时不可达。');
      const current = scenes.find(scene => scene.id === actor.sceneId)!, outside = current.id === park.id ? actor.position : park.door;
      const waypointIndex = circuit.reduce((best, point, index) => Math.hypot(point.x - outside.x, point.y - outside.y) < Math.hypot(circuit[best]!.x - outside.x, circuit[best]!.y - outside.y) ? index : best, 0);
      actor.parkWalk = { stage: 'travelling', durationMinutes, participatedMinutes: 0, waypointIndex, comfortTicks: 0, occurrenceId };
      this.move(state, actor, park, circuit[waypointIndex]!, 'park_promenade_' + waypointIndex, 'idle');
      this.event(state, { kind: 'park_walk_start', actorId: actor.companionId, sceneId: actor.sceneId,
        text: `决定去公共花园散步${durationMinutes}分钟；先真实步行前往，抵达后才计算散步时间。` });
      this.syncOccupancy(state); this.save(state);
    });
  }
  private performTool(scope: CompanionWorldScope, args: CompanionWorldArguments, sourceMessageId?: string): CompanionWorldSnapshot {
    if (args.action === 'introduce' || args.action === 'create_group') {
      const result = this.initiateSocial(scope, args, sourceMessageId);
      if (!result.world) throw new Error('社交动作缺少实际世界回执。'); return result.world;
    }
    this.requireScope(scope); this.advance(); const state = this.load(), actor = state.actors.find(actor => actor.companionId === scope.companionId);
    if (!actor) throw new Error('伙伴处于休眠状态，请由玩家在联系人资料中手动激活。');
    if (sourceMessageId && !this.visibleSources(scope, [sourceMessageId]).length) throw new Error('世界行为的消息来源不可见。');
    if (args.action === 'inspect') return this.snapshotValue(state, Date.now(), scope);
    if (['move', 'travel', 'visit', 'interact', 'leave'].includes(args.action) && state.works.some(work => work.companionId === actor.companionId && work.kind !== 'chat' && work.status !== 'ended')) {
      actor.afterWork = { scope, args, sourceMessageId };
      this.event(state, { kind: 'deferred_movement', actorId: actor.companionId, text: '已记录意图，完成当前电脑工作后再行动', sourceMessageId, conversationId: scope.conversationId });
      this.save(state); return this.snapshotValue(state, Date.now(), scope);
    }
    const scenes = this.scenes(state);
    if ('targetCompanionId' in args && args.targetCompanionId && ['visit'].includes(args.action) && this.contactState(args.targetCompanionId) === 'dormant') throw new Error('对方伙伴已休眠；请等待玩家手动激活后再联系或拜访，不能自动唤醒或入屋。');
    if (actor.parkWalk && ['move', 'travel', 'visit', 'interact', 'leave'].includes(args.action)) this.finishParkWalk(state, actor, '收到新的行动安排，结束这次散步', false);
    if (args.action === 'share_entrance') {
      if (!this.social || args.recipientIds.includes(actor.companionId) || new Set(args.recipientIds).size !== args.recipientIds.length) throw new Error('地址接收伙伴无效。');
      const room = this.social.ensure(actor.companionId, [actor.companionId, ...args.recipientIds]);
      this.social.send({ companionId: actor.companionId, conversationId: room.id, content: this.addressText(actor.companionId), channel: 'phone', clientId: randomUUID(), shareAddress: true });
      return this.snapshotValue(this.load(), Date.now(), scope);
    }
    if (args.action === 'travel') {
      const target = scenes.find(scene => scene.id === args.targetSceneId);
      if (!target) throw new Error('目的场景未开放，休眠伙伴的世界不会被加载。');
      const entry = target.portals?.find(portal => portal.id === (args.entryId ?? 'entrance') && portal.direction !== 'exit');
      if (!entry) throw new Error('目的场景入口不存在。');
      if (target.ownerId && target.ownerId !== actor.companionId) {
        const invitation = state.visits.find(visit => visit.guestId === actor.companionId && visit.hostId === target.ownerId && visit.status === 'allowed'
          && Date.parse(visit.expiresAt) > this.virtualFor(state, state.cursor) && visit.destination?.sceneId === target.id && visit.destination.entryId === entry.id);
        if (!invitation) throw new Error('尚未获得有效的房主邀请，请先联系并申请拜访。');
      }
      const visit = state.visits.find(visit => visit.guestId === actor.companionId && visit.hostId === target.ownerId && visit.status === 'allowed');
      this.move(state, actor, target, entry.position, target.id, 'idle');
      if (target.ownerId && target.ownerId !== actor.companionId) {
        if (actor.journey && visit) actor.journey.visitId = visit.id;
        this.event(state, { kind: 'scene_depart', actorId: actor.companionId, targetId: target.ownerId, sceneId: actor.sceneId,
          ...(visit ? { visitId: visit.id } : {}), text: '从当前场景出口出发拜访。' });
      }
      actor.manualActivityUntil = this.virtualFor(state, state.cursor) + 30 * 60000;
    } else
    if (args.action === 'move') {
      const scene = args.position ? scenes.find(scene => scene.id === actor.sceneId) : scenes.find(scene => scene.id === args.destinationId || scene.objects.some(object => object.id === args.destinationId));
      if (!scene) throw new Error('地点不存在。'); const object = scene.objects.find(object => object.id === args.destinationId);
      if (actor.sceneId !== scene.id) throw new Error('move仅在当前场景内寻路；前往其他场景请使用入口travel。');
      if (object && object.kind !== 'door' && scene.ownerId && scene.ownerId !== actor.companionId && !this.perception(actor.companionId)?.objects.some(known => known.id === object.id)) throw new Error('还没有观察到这个家具。');
      if (object?.kind === 'bench' && object.reservedBy && object.reservedBy !== actor.companionId) throw new Error('这张长椅正在被其他伙伴使用或前往，请选择另一张。');
      this.move(state, actor, scene, args.position ?? object?.anchor ?? scene.door, args.destinationId ?? scene.id, 'idle');
      actor.manualActivityUntil = this.virtualFor(state, state.cursor) + 30 * 60000;
    } else if (args.action === 'interact') {
      const scene = scenes.find(scene => scene.id === actor.sceneId)!, object = scene.objects.find(object => object.id === args.furnitureId);
      if (!object || !this.permitted(state, actor.companionId, scene.ownerId ?? actor.companionId) || Math.hypot(actor.position.x - object.anchor.x, actor.position.y - object.anchor.y) > .2 || actor.route.length) throw new Error('需要先走到有权使用的家具旁。');
      if (object.reservedBy && object.reservedBy !== actor.companionId) throw new Error('家具已被其他伙伴预约。');
      const permitted = args.interaction === 'stand' || args.interaction === 'sit' && ['chair', 'sofa', 'bench', 'dining'].includes(object.kind) || args.interaction === 'sleep' && object.kind === 'bed' || args.interaction === 'eat' && ['kitchen', 'dining'].includes(object.kind) || args.interaction === 'rest' && ['sofa', 'bed', 'bench'].includes(object.kind) || args.interaction === 'study' && ['desk', 'habit'].includes(object.kind) || args.interaction === 'use' && ['computer', 'kitchen', 'habit'].includes(object.kind);
      if (!permitted) throw new Error('该家具不支持这种动作。');
      const activity = args.interaction === 'stand' ? 'idle' : args.interaction === 'sleep' ? 'sleeping' : args.interaction === 'eat' ? 'eating' : args.interaction === 'rest' ? 'resting' : args.interaction === 'study' || args.interaction === 'use' && object.kind === 'kitchen' ? 'habit' : 'sitting';
      actor.furnitureId = object.id; this.enterFurniture(state, actor, activity, state.cursor);
      actor.manualActivityUntil = this.virtualFor(state, state.cursor) + (activity === 'sleeping' ? 30 : activity === 'habit' ? 30 : activity === 'idle' ? 1 : 15) * 60000;
      actor.manualArtAction = args.interaction === 'study' ? 'read' : args.interaction === 'use' && object.kind === 'kitchen' ? 'cook' : undefined;
      this.event(state, { kind: 'interact', actorId: actor.companionId, sceneId: scene.id, text: args.interaction + ' ' + object.name, sourceMessageId, conversationId: scope.conversationId });
    } else if (args.action === 'visit') {
      if (!state.actors.some(item => item.companionId === args.targetCompanionId) || args.targetCompanionId === actor.companionId) throw new Error('拜访对象无效。');
      const playerRequested = !!sourceMessageId && this.visibleSources(scope, [sourceMessageId])[0]?.authorId === 'user';
      if (!playerRequested && !row(this.db.prepare("SELECT json_extract(data,'$.proactive') AS proactive FROM companions WHERE id=?").get(actor.companionId)).proactive && !this.social?.continuity.hasDelegationTo(actor.companionId, args.targetCompanionId)) throw new Error('伙伴未开启主动联系，也没有对应的真实委托，不能自行发起拜访。');
      const pending = state.visits.find(visit => visit.guestId === actor.companionId && visit.hostId === args.targetCompanionId && ['requested', 'allowed'].includes(visit.status));
      if (!pending) { state.visits.push({ id: randomUUID(), guestId: actor.companionId, hostId: args.targetCompanionId, reason: args.reason, status: 'requested', createdAt: iso(this.virtualFor(state, state.cursor)), expiresAt: iso(this.virtualFor(state, state.cursor) + 6 * 3600000), sourceMessageId, conversationId: scope.conversationId, sourceRead: this.sourceRead(sourceMessageId) });
        this.event(state, { kind: 'visit_request', visitId: state.visits.at(-1)!.id, actorId: actor.companionId, targetId: args.targetCompanionId, text: args.reason, sourceMessageId, conversationId: scope.conversationId }); this.queueJob(state, args.targetCompanionId, 'decision'); }
      // A request neither reveals an address nor moves the guest.
    } else if (args.action === 'respond') {
      const visit = state.visits.find(visit => visit.id === args.requestId && visit.hostId === actor.companionId && visit.status === 'requested'); if (!visit) throw new Error('只有房主可回应待处理的拜访。');
      visit.status = args.decision === 'allow' ? 'allowed' : 'denied'; visit.response = args.reason;
      visit.destination = args.decision === 'allow' ? { sceneId: actor.homeSceneId, entryId: 'entrance' } : undefined;
      visit.responseSourceMessageId = sourceMessageId; visit.responseConversationId = scope.conversationId;
      visit.responseSourceRead = this.sourceRead(sourceMessageId);
      this.event(state, { kind: 'visit_response', visitId: visit.id, visitDecision: args.decision, actorId: actor.companionId, targetId: visit.guestId, text: args.reason, sourceMessageId, conversationId: scope.conversationId });
      // Permission is independent of navigation and the guest's decision to enter.
    } else if (args.action === 'leave') {
      const hostId = scenes.find(scene => scene.id === actor.sceneId)?.ownerId;
      for (const visit of state.visits) if (visit.guestId === actor.companionId && ['allowed', 'requested'].includes(visit.status)) visit.status = 'left';
      const home = scenes.find(scene => scene.id === actor.homeSceneId)!;
      this.move(state, actor, home, { x: 10, y: 12 }, home.id, 'idle');
      this.event(state, { kind: 'visit_leave', actorId: actor.companionId, ...(hostId && hostId !== actor.companionId ? { targetId: hostId } : {}), text: '结束拜访，步行返回自己的小屋', sourceMessageId, conversationId: scope.conversationId });
    } else if (args.action === 'social') {
      const recipients = args.recipientIds ?? [args.targetCompanionId!];
      if (!this.faceGroupAvailable(state, [actor.companionId, ...recipients])) throw new Error('所有参与者需要在同一现场、彼此5格内且方便交流。');
      if (!this.social) throw new Error('社交存储尚未连接。');
      const room = this.social.ensure(actor.companionId, [actor.companionId, ...recipients]);
      this.social.send({ companionId: actor.companionId, conversationId: room.id, content: args.text, channel: 'face_to_face', clientId: randomUUID() });
      return this.snapshotValue(this.load(), Date.now(), scope);
    } else if (args.action === 'message') {
      if (!this.social) throw new Error('社交存储尚未连接。');
      this.social.requireAcquaintances(actor.companionId, args.recipientIds);
      const room = this.social.resolveRoom(actor.companionId, [actor.companionId, ...args.recipientIds], args.roomId);
      this.social.send({ companionId: actor.companionId, conversationId: room.id, topicId: args.topicId, content: args.text, channel: 'phone', urgent: args.urgent, clientId: randomUUID() });
      return this.snapshotValue(this.load(), Date.now(), scope);
    }
    this.syncOccupancy(state); this.save(state); return this.snapshotValue(state, Date.now(), scope);
  }
  private initiateSocial(scope: CompanionWorldScope, args: Extract<CompanionWorldArguments, { action: 'introduce' | 'create_group' }>, sourceMessageId?: string, clientId: string = randomUUID()): CompanionStorageResponse {
    return this.atomic(() => {
      this.requireScope(scope); this.advance();
      if (!this.social) throw new Error('社交存储尚未连接。');
      if (!this.load().actors.some(actor => actor.companionId === scope.companionId)) throw new Error('伙伴已休眠，请先由玩家激活。');
      const source = sourceMessageId ? this.visibleSources(scope, [sourceMessageId])[0] : undefined;
      if (sourceMessageId && !source) throw new Error('世界行为的消息来源不可见。');
      const recipients = args.action === 'introduce' ? [args.targetCompanionId] : args.recipientIds;
      if (new Set(recipients).size !== recipients.length || recipients.includes(scope.companionId) || recipients.some(id => this.contactState(id) === 'dormant')) throw new Error('请选择本人之外已激活的真实伙伴；不能唤醒休眠者。');
      if (args.action === 'introduce') {
        const observed = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(`world-person-observation/${scope.companionId}/${args.targetCompanionId}`);
        const record = observed ? parse<{ messageId: string }>(row(observed).value) : undefined;
        const visible = this.perception(scope.companionId)?.people.some(person => person.companionId === args.targetCompanionId && person.visible);
        if (!this.social.acquaintanceIds(scope.companionId).has(args.targetCompanionId) && !visible && (!record || !this.visibleSources({ companionId: scope.companionId, conversationId: scope.conversationId }, [record.messageId]).length)) throw new Error('尚未了解这个人。先query category=people读取公开目录，或在现场实际见到对方，再主动自我介绍。');
      } else this.social.requireAcquaintances(scope.companionId, recipients);
      const goal = args.action === 'create_group' && args.topic?.kind === 'game' && source
        ? companionSocialGoalOrigin(this.db, this.social, (port, ids) => this.visibleSources(port, ids), scope.companionId, source) : undefined;
      const goalKey = goal ? `world-goal-game-port/${goal.companionId}/${goal.sourceMessageId}` : undefined;
      const replayKey = goal ? `world-goal-game-replay/${goal.companionId}/${goal.sourceMessageId}/${clientId}` : undefined;
      const requestFingerprint = createHash('sha256').update(JSON.stringify([scope.conversationId, sourceMessageId, args])).digest('hex');
      if (goal) {
        const terminalTask = this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? AND status IN('cancelled','failed','succeeded') AND NOT EXISTS(SELECT 1 FROM companion_activity_tasks a WHERE a.companion_id=? AND a.source_message_id=? AND a.status IN('queued','running','waiting')) LIMIT 1")
          .get(goal.companionId, goal.sourceMessageId, goal.companionId, goal.sourceMessageId);
        if (terminalTask) throw new Error('原玩家持续目标已结束或取消，迟到的通信不能创建新一局。');
        const replay = (saved: GoalGamePort): CompanionStorageResponse => {
          if (saved.sourceChecksum !== goal.checksum) throw new Error('原游戏目标来源已经改变，不能沿用旧创建回执。');
          if (JSON.stringify([...recipients].sort()) !== JSON.stringify([...saved.recipientIds].sort()) || (args.action === 'create_group' && !!args.includePlayer) !== saved.includePlayer)
            throw new Error('本目标当前已有实际游戏端口，但本次收件人与原端口不一致；不会隐式扩大或缩小受众。请读取已有话题再决定后续。');
          const current = this.topicCommand?.({ type: 'topic.read', conversationId: saved.conversationId, topicId: saved.topicId, readerId: scope.companionId });
          if (!current?.topic || current.topic.deletedAt) throw new Error('原游戏端口已撤回，不能在旧目标下重建。');
          const room = this.social!.resolveRoom(scope.companionId, [scope.companionId, ...recipients], saved.conversationId);
          const creator = saved.send.agentSource ? this.visibleSources({ companionId: scope.companionId,
            conversationId: saved.send.agentSource.conversationId }, [saved.send.agentSource.messageId])[0] : undefined;
          const creatorGoal = creator ? companionSocialGoalOrigin(this.db, this.social!, (port, ids) => this.visibleSources(port, ids), scope.companionId, creator) : undefined;
          if (!creatorGoal || creatorGoal.sourceMessageId !== goal.sourceMessageId || creatorGoal.checksum !== goal.checksum)
            throw new Error('原创建端口的真实来源链已失效，不能重放或另建来复活旧目标。');
          const delivery = this.social!.send(saved.send);
          return { ...delivery, socialDeliveryClientId: saved.send.clientId, socialDeliveryReused: true, topic: current.topic, topicState: current.topicState,
            socialConversation: room, world: this.snapshotValue(this.load(), Date.now(), scope) };
        };
        const oldReplay = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(replayKey!) as { value: string } | undefined;
        if (oldReplay) {
          const saved = JSON.parse(oldReplay.value) as { fingerprint: string; port: GoalGamePort };
          if (saved.fingerprint !== requestFingerprint) throw new Error('本次建群调用标识已经绑定另一提案，不能改变后重试。');
          return replay(saved.port);
        }
        const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(goalKey!) as { value: string } | undefined;
        if (found) {
          const saved = JSON.parse(found.value) as GoalGamePort;
          if (saved.sourceChecksum !== goal.checksum) throw new Error('原游戏目标来源已经改变，不能沿用旧创建回执。');
          const current = this.topicCommand?.({ type: 'topic.read', conversationId: saved.conversationId, topicId: saved.topicId, readerId: scope.companionId });
          if (current?.topic && !current.topic.deletedAt && current.topic.status !== 'closed') {
            const result = replay(saved);
            this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(replayKey!, JSON.stringify({ companionId: scope.companionId, fingerprint: requestFingerprint, port: saved }));
            return result;
          }
          // Only an explicit close finishes the current episode. Deletion is
          // a withdrawal, not permission to silently recreate erased context.
          if (!current?.topic || current.topic.deletedAt) throw new Error('原游戏端口已撤回，不能在旧目标下重建。');
        }
      }
      const members = [scope.companionId, ...recipients];
      const room = args.action === 'create_group' && args.includePlayer ? this.social.ensurePlayerGroup(scope.companionId, members, args.title)
        : this.social.ensure(scope.companionId, members, args.action === 'create_group' ? args.title : '');
      let topicResult: CompanionStorageResponse | undefined;
      if (args.action === 'create_group' && args.topic) {
        if (!this.topicCommand) throw new Error('群话题能力尚未连接。');
        const key = `world-group-topic/${scope.companionId}/${clientId}`;
        const previous = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
        const fingerprint = createHash('sha256').update(JSON.stringify([room.id, args.topic])).digest('hex');
        if (previous) {
          const saved = parse<{ topicId: string; fingerprint: string }>(row(previous).value);
          if (saved.fingerprint !== fingerprint) throw new Error('本次建群重试对应的话题设置已改变。');
          topicResult = this.topicCommand({ type: 'topic.read', conversationId: room.id, readerId: scope.companionId, topicId: saved.topicId });
        } else {
          topicResult = this.topicCommand({ type: 'topic.create', conversationId: room.id, readerId: scope.companionId,
            ...args.topic, participantIds: [...recipients, ...(args.includePlayer ? ['user'] : [])] });
          if (!topicResult?.topic) throw new Error('群话题未成功建立。');
          this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify({ companionId: scope.companionId, topicId: topicResult.topic.id, fingerprint }));
        }
      }
      const send = { companionId: scope.companionId, conversationId: room.id, content: args.text, channel: 'phone' as const, clientId,
        ...(args.action === 'create_group' ? { topicId: topicResult?.topic?.id ?? null } : {}),
        ...(source ? { agentSource: { conversationId: scope.conversationId, messageId: source.id } } : {}),
        ...(source?.authorId === 'user' ? { authorizationMessageId: source.id } : {}) };
      const delivery = this.social.send(send);
      if (goalKey && goal && topicResult?.topic) {
        const port: GoalGamePort = { companionId: scope.companionId, sourceChecksum: goal.checksum, topicId: topicResult.topic.id,
          conversationId: room.id, recipientIds: recipients, includePlayer: args.action === 'create_group' && !!args.includePlayer, send };
        this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(goalKey, JSON.stringify(port));
        this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(replayKey!, JSON.stringify({ companionId: scope.companionId, fingerprint: requestFingerprint, port }));
      }
      return { ...delivery, socialDeliveryClientId: clientId, ...(topicResult ? { topic: topicResult.topic, topicState: topicResult.topicState } : {}), socialConversation: room, world: this.snapshotValue(this.load(), Date.now(), scope) };
    });
  }
  private claim(kind: CompanionWorldJob['kind'], excludedCompanionIds: readonly string[] = []): CompanionWorldJob | undefined {
    const claimAt = Date.now(); this.advance(claimAt); return this.db.transaction(() => {
      const candidates = this.db.prepare("SELECT * FROM companion_world_jobs WHERE kind=? AND COALESCE(json_extract(data,'$.terminal'),0)=0 AND (status='pending' OR status IN ('running','failed') AND lease_until<?) ORDER BY rowid").all(kind, iso()) as Row[];
      const state = this.load();
      if (state.cursor < claimAt) return undefined;
      const found = candidates.find(candidate => {
        const owner = String(candidate.companion_id), actor = state.actors.find(actor => actor.companionId === owner);
        if (excludedCompanionIds.includes(owner)) return false;
        const busy = state.works.some(work => work.companionId === owner && work.status !== 'ended');
        return actor && !busy && (kind === 'dream' ? this.sleepingForJob(state, parse<StoredJob>(candidate.data)) : (parse<StoredJob>(candidate.data).encounterMemberIds ? !['sleeping', 'eating'].includes(actor.routinePhase) : this.phoneAvailable(state, actor) && !this.peerPhoneActive(owner, state.cursor)));
      }); if (!found) return undefined;
      const job = parse<StoredJob>(row(found).data); job.status = 'running'; job.leaseToken = randomUUID(); job.attempts++;
      if (job.encounterMemberIds && !this.faceGroupAvailable(state, job.encounterMemberIds)) { job.status = 'done'; this.db.prepare("UPDATE companion_world_jobs SET status='done',lease_until=NULL,data=? WHERE id=?").run(JSON.stringify(job), job.id); for (const actor of state.actors) if (actor.meetingHold?.jobId === job.id) this.releaseMeeting(actor, true); this.save(state); return undefined; }
      if (kind === 'dream') { job.seedMemoryVersions = this.sleepSeeds(job.companionId); job.sourceMemoryIds = job.seedMemoryVersions.map(memory => memory.id);
        job.maintenanceMemoryVersions = this.maintenanceSeeds(job.companionId, job.seedMemoryVersions);
        job.maintenanceMemoryIds = job.maintenanceMemoryVersions.map(memory => memory.id);
        job.memoryVersions = [...new Map([...job.seedMemoryVersions, ...job.maintenanceMemoryVersions].map(memory => [memory.id, memory])).values()];
        if (!job.sourceMemoryIds.length) { job.status = 'done'; this.db.prepare("UPDATE companion_world_jobs SET status='done',lease_until=NULL,data=? WHERE id=?").run(JSON.stringify(job), job.id); return undefined; } }
      job.throughEventSequence = Number(row(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM companion_world_events').get()).n);
      if (kind === 'decision') {
        const scope = { companionId: job.companionId, conversationId: job.conversationId };
        const events = (this.db.prepare('SELECT data FROM companion_world_events WHERE sequence<=? ORDER BY sequence DESC LIMIT 500').all(job.throughEventSequence) as Row[])
          .map(value => parse<StoredEvent>(value.data)).filter(event => this.visibleEvent(event, scope)).slice(0, 100);
        job.readSet = events.map(event => {
          const source = event.sourceMessageId ? this.db.prepare('SELECT content,revision FROM messages WHERE id=?').get(event.sourceMessageId) : undefined;
          return { eventId: event.id, checksum: createHash('sha256').update(JSON.stringify(event)).digest('hex'), ...(source ? { sourceChecksum: createHash('sha256').update(String(row(source).content)).digest('hex'), sourceRevision: Number(row(source).revision) } : {}) };
        });
      }
      this.db.prepare("UPDATE companion_world_jobs SET status='running',lease_until=?,data=? WHERE id=?").run(iso(Date.now() + 120000), JSON.stringify(job), job.id); return job;
    }).immediate();
  }
  private complete(command: Extract<CompanionStorageCommand, { type: 'world.job.complete' }>): void {
    this.atomic(() => {
      const found = this.db.prepare('SELECT * FROM companion_world_jobs WHERE id=?').get(command.id); if (!found) throw new Error('世界后台任务不存在。');
      const job = parse<StoredJob>(row(found).data); if (job.status === 'done' && job.leaseToken === command.leaseToken) return;
      if (job.status !== 'running' || job.leaseToken !== command.leaseToken || String(row(found).lease_until) < iso()) throw new Error('世界任务租约已失效。');
      if (command.dreamComponentFailure) {
        if (job.kind !== 'dream' || !job.dreamAllowed || command.dream)
          throw new Error('可选梦境失败诊断只能记录已入梦任务且不能同时发布梦境。');
        job.dreamComponentFailure = command.dreamComponentFailure;
      }
      const scope = { companionId: job.companionId, conversationId: job.conversationId };
      if (command.expectedProhibitionRevision !== undefined && this.prohibitionRevision(scope, job.kind === 'dream' ? job.sourceMemoryIds : undefined) !== command.expectedProhibitionRevision)
        throw new Error('世界任务使用的记忆禁记规则已变化，请重新核对主题范围。');
      if (command.activityTask && (job.kind !== 'decision' || command.action || !this.startActivityTask)) throw new Error('只有清醒决策可以创建单一自主行动。');
      if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(job.companionId)) throw new Error('伙伴已休眠，旧世界任务不能提交。');
      if (job.kind === 'decision' && command.expectedMemoryRevision !== undefined && this.memoryRevision(scope) !== command.expectedMemoryRevision)
        throw new Error('世界决策使用的记忆来源已经变化，请重新召回。');
      if (job.encounterMemberIds && !this.faceGroupAvailable(this.load(), job.encounterMemberIds)) throw new Error('这次相遇的参与者已经离场或正在忙碌。');
      if (job.kind === 'decision' && !job.encounterMemberIds) {
        const state = this.load(), actor = state.actors.find(actor => actor.companionId === job.companionId);
        if (!actor || !this.phoneAvailable(state, actor) || this.peerPhoneActive(job.companionId, state.cursor)) {
          job.status = 'pending'; delete job.leaseToken;
          this.db.prepare("UPDATE companion_world_jobs SET status='pending',lease_until=NULL,data=? WHERE id=?").run(JSON.stringify(job), job.id);
          return;
        }
      }
      for (const read of job.readSet ?? []) {
        const saved = this.db.prepare('SELECT data FROM companion_world_events WHERE id=?').get(read.eventId), event = saved ? parse<StoredEvent>(row(saved).data) : undefined;
        if (!event || !this.visibleEvent(event, scope) || createHash('sha256').update(JSON.stringify(event)).digest('hex') !== read.checksum) throw new Error('世界决策读过的来源已撤回或变化，请重新观察。');
        if (read.sourceChecksum && event.sourceMessageId) { const source = this.db.prepare('SELECT content,revision FROM messages WHERE id=?').get(event.sourceMessageId);
          if (!source || Number(row(source).revision) !== read.sourceRevision || createHash('sha256').update(String(row(source).content)).digest('hex') !== read.sourceChecksum) throw new Error('世界决策的发言来源已经变化。'); }
      }
      if (command.action) this.tool(scope, command.action);
      const state = this.load();
      for (const actor of state.actors) if (actor.meetingHold?.jobId === job.id) delete actor.meetingHold;
      const memoryIds = [...new Set([...(command.sourceMemoryIds ?? []), ...(command.dream?.relatedMemoryIds ?? [])])];
      if (job.kind === 'dream') {
        if (memoryIds.some(id => !job.sourceMemoryIds.includes(id)) || job.memoryVersions?.some(memory => !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status')='indexed'").get(memory.id, memory.version))) throw new Error('本次待整理记忆已经变化。');
        if (!this.sleepingForJob(state, job)) throw new Error('伙伴已经醒来，本次睡眠回顾已停止。');
        if (memoryIds.some(id => !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.status')='indexed'").get(id, job.companionId))) throw new Error('梦的记忆依赖已失效。');
      }
      const usedInputs = new Set<string>(), usedSources = new Set<string>();
      if (command.maintenance) {
        const audit = command.maintenance, seeds = new Map((job.maintenanceMemoryVersions ?? job.seedMemoryVersions ?? []).map(note => [note.id, note.version]));
        const reviewed = new Map(audit.reviewedMemoryVersions.map(note => [note.id, note.version]));
        if (job.kind !== 'dream' || reviewed.size !== audit.reviewedMemoryVersions.length
          || audit.reviewedMemoryVersions.some(note => seeds.get(note.id) !== note.version)
          || (audit.decision === 'merge') !== !!command.consolidations?.length
          || command.consolidations?.some(plan => plan.inputs.some(note => reviewed.get(note.id) !== note.version))) throw new Error('独立维护决策必须对应本轮准确读取的睡眠种子及实际整合计划。');
        job.maintenance = audit;
      }
      for (const proposal of command.consolidations ?? []) {
        const plan = companionMemoryConsolidateSchema.parse(proposal);
        if (job.kind !== 'dream' || !this.consolidateMemory || plan.inputs.some(input => !memoryIds.includes(input.id) || usedInputs.has(input.id))
          || plan.candidate.sourceMessageIds.some(id => usedSources.has(id))) throw new Error('自动整合只能在本次真实睡眠中使用未重复的已读种子及原始来源。');
        plan.inputs.forEach(input => usedInputs.add(input.id)); plan.candidate.sourceMessageIds.forEach(id => usedSources.add(id));
        if (!this.consolidateMemory(scope, plan, job.id, command.leaseToken)) throw new Error('本次自动整合没有通过来源或禁记核验，原文未归档。');
      }
      const savedNotes: CompanionMemory[] = [];
      for (const candidate of command.memoryCandidates ?? []) {
        if (job.kind !== 'dream' || !candidate.relatedMemoryIds?.length || candidate.relatedMemoryIds.some(id => !memoryIds.includes(id))) throw new Error('睡眠整理只能基于本次真实原子记忆形成可追溯回顾。');
        const proposal = { ...candidate, metadata: { ...candidate.metadata, consolidation: true, sleepReflection: true } };
        const note = this.recordPrivateMemory ? this.recordPrivateMemory(scope, proposal, job.id, command.leaseToken) : this.recordMemory(scope, proposal);
        if (note) savedNotes.push(note);
      }
      if (command.stateProposal) {
        if (job.kind !== 'dream' || !savedNotes.length || !this.integrateMemory) throw new Error('睡眠状态变化需要本次实际保存的反思记忆。');
        this.integrateMemory(scope, savedNotes, command.stateProposal, { eventKey: 'sleep:' + job.id, kind: 'sleep', expectedRevision: command.expectedStateRevision });
      }
      if (command.dream) {
        if (job.kind !== 'dream' || !job.dreamAllowed) throw new Error('本次睡眠没有通过入梦条件，不能伪造梦境。');
        const dream = command.dream, sources = this.visibleSources(scope, dream.sourceMessageIds);
        if (sources.length !== dream.sourceMessageIds.length || dream.sourceMessageIds.some(id => !dream.evidence.some(evidence => evidence.sourceMessageId === id && sources.find(source => source.id === id)?.content.includes(evidence.quote))) ||
          dream.evidence.some(evidence => !sources.some(source => source.id === evidence.sourceMessageId && source.content.includes(evidence.quote)))) throw new Error('梦的回顾来源已失效。');
        const text = '梦境（虚拟联想，并非现实经历）：\n' + dream.text;
        const candidate = { content: text, diaryName: '梦境', tags: ['梦境', '主观联想'],
          sourceMessageIds: dream.sourceMessageIds, relatedMemoryIds: dream.relatedMemoryIds, evidence: dream.evidence,
          sourceChecksums: Object.fromEntries(sources.map(source => [source.id, createHash('sha256').update(source.content).digest('hex')])),
          metadata: { consolidation: true, dream: true, simulation: true, sleepEpisodeId: job.sleepEpisodeId, worldJobId: job.id } };
        const savedDream = this.recordPrivateMemory ? this.recordPrivateMemory(scope, candidate, job.id, command.leaseToken) : this.recordMemory(scope, candidate);
        if (!savedDream) throw new Error('梦叙述未通过本人来源或禁记核验，不能留下梦事件。');
        this.event(state, { kind: 'dream', actorId: job.companionId, privateOwner: job.companionId, conversationId: scope.conversationId,
          text, sourceMessageIds: dream.sourceMessageIds, sourceMemoryIds: dream.relatedMemoryIds, memoryVersions: dream.relatedMemoryIds.map(id => ({ id, version: Number(row(this.db.prepare("SELECT json_extract(data,'$.version') AS version FROM vcp_memory_notes WHERE id=?").get(id)).version) })), evidence: dream.evidence });
      }
      for (const appraisal of command.appraisals ?? []) {
        if (appraisal.confidence < .65 || this.db.prepare('SELECT 1 FROM companion_world_peer_appraisals WHERE companion_id=? AND event_id=?').get(job.companionId, appraisal.eventId)) continue;
        if (!job.readSet?.some(read => read.eventId === appraisal.eventId)) continue;
        const foundEvent = this.db.prepare('SELECT data FROM companion_world_events WHERE id=? AND sequence<=?').get(appraisal.eventId, job.throughEventSequence); if (!foundEvent) continue;
        const event = parse<StoredEvent>(row(foundEvent).data);
        const actualSource = event.sourceMessageId ? this.db.prepare('SELECT author_id,conversation_id FROM messages WHERE id=?').get(event.sourceMessageId) : undefined;
        if (!this.visibleEvent(event, scope) || event.actorId !== appraisal.targetCompanionId || event.targetId !== job.companionId || !event.kind.startsWith('social_') ||
          !actualSource || row(actualSource).author_id !== event.actorId || row(actualSource).conversation_id !== event.conversationId) continue;
        let relation = state.relationships.find(item => item.companionId === job.companionId && item.targetCompanionId === appraisal.targetCompanionId);
        if (!relation) { relation = { companionId: job.companionId, targetCompanionId: appraisal.targetCompanionId, affinity: 50, trust: 50, interactions: 0, updatedAt: iso() }; state.relationships.push(relation); }
        const local = companionTimeInZone(Date.parse(event.at), state.settings.timeZone), appraisalDay = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
        const used = Number(row(this.db.prepare('SELECT COALESCE(SUM(positive_change),0) AS n FROM companion_world_peer_appraisals WHERE companion_id=? AND day=? AND active=1').get(job.companionId, appraisalDay)).n);
        const before = { affinity: relation.affinity, trust: relation.trust };
        const result = applyCompanionAppraisal({ affect: { pleasure: 0, arousal: 0, dominance: 0 }, relationship: { affinity: relation.affinity, trust: relation.trust, respect: 50 } }, { ...appraisal, target: 'user' }, this.elapsedVirtual(Date.parse(event.realAt), state.cursor), Math.max(0, 6 - used));
        relation.affinity = result.relationship.affinity; relation.trust = result.relationship.trust; relation.updatedAt = iso(this.virtualFor(state, state.cursor));
        this.db.prepare('INSERT INTO companion_world_peer_appraisals(companion_id,event_id,target_id,source_message_id,day,positive_change,affinity_delta,trust_delta) VALUES(?,?,?,?,?,?,?,?)').run(job.companionId, event.id, appraisal.targetCompanionId, event.sourceMessageId ?? null, appraisalDay, result.positiveChange, relation.affinity - before.affinity, relation.trust - before.trust);
        this.event(state, { kind: 'social_appraisal', actorId: job.companionId, targetId: appraisal.targetCompanionId, text: '对真实伙伴互动形成感受', positiveChange: result.positiveChange, appraisalDay, sourceMessageId: event.sourceMessageId, conversationId: event.conversationId,
          relationshipDelta: { affinity: relation.affinity - before.affinity, trust: relation.trust - before.trust },
          effect: { type: result.affect.pleasure < 0 ? 'stress' : 'social', intensity: Math.abs(result.affect.pleasure) } });
      }
      if (job.kind === 'dream') { for (const memory of job.seedMemoryVersions ?? job.memoryVersions ?? []) this.db.prepare('INSERT OR IGNORE INTO companion_world_dream_watermark(companion_id,memory_id,version,processed_at) VALUES(?,?,?,?)').run(job.companionId, memory.id, memory.version, iso()); }
      job.status = 'done'; this.db.prepare("UPDATE companion_world_jobs SET status='done',lease_until=NULL,data=? WHERE id=?").run(JSON.stringify(job), job.id);
      this.save(state);
      if (command.activityTask) this.startActivityTask!(job.companionId, job.id, command.activityTask);
      this.flushEffects();
    });
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'world.status': return { ok: true, worldStatus: this.status(command.companionIds) };
      case 'world.clock': return { ok: true, worldClock: this.clock(command.since) };
      case 'world.clock.peek': return { ok: true, worldClock: this.clockPeek() };
      case 'world.sleep-plan': return { ok: true, worldSleepPlan: this.sleepPlan(command.companionId) };
      case 'life.overview.read': {
        const sleep = this.sleepPlan(command.companionId);
        const saved = this.db.prepare('SELECT data FROM companion_world WHERE id=1').get();
        const state = saved ? parse<StoredWorld>(row(saved).data) : undefined;
        const clock = { ...sleep.clock, mode: state?.settings.mode ?? COMPANION_WORLD_DEFAULT_SETTINGS.mode,
          backlog: observationBacklog(Date.parse(sleep.clock.observedRealAt), Date.parse(sleep.checkedAt)) };
        const climate = companionWorldEnvironment(Date.parse(clock.virtualNow), clock.timeZone);
        const labels: Record<string, string> = { idle: '清醒的日常', walking: '正在走路', seating: '正在坐下', sitting: '安静坐着', working: '正在处理工作', sleeping: '在床上睡眠', eating: '正在用餐', resting: '正在休息', habit: '正在进行日常习惯', standingUp: '正在起身', lyingDown: '正在躺下', waking: '正在醒来', turning: '正在转身' };
        return { ok: true, lifeOverviewContext: { companionId: command.companionId, checkedAt: sleep.checkedAt, clock, environment: climate.environment,
          ...(sleep.actor ? { current: { activity: sleep.actor.activity, label: labels[sleep.actor.activity] ?? sleep.actor.activity,
            startedAtReal: sleep.actor.activityStartedAtReal, routinePhase: sleep.actor.routinePhase } } : {}),
          ...readCompanionLifeOverviewPage(this.db, command, clock) } };
      }
      case 'world.snapshot': return { ok: true, world: this.tick() };
      case 'world.observe': return { ok: true, world: this.snapshot(command) };
      case 'world.tick': { const now = command.now ? Date.parse(command.now) : Date.now(); this.advance(now); return { ok: true, ...(command.snapshot ? { world: this.snapshotValue(this.load(), now) } : {}) }; }
      case 'world.attention.record': this.recordAttention(command); return { ok: true };
      case 'world.configure': return { ok: true, world: this.configure(command.expectedRevision, command.patch) };
      case 'world.tool': if (command.arguments.action === 'query') return this.queryKnowledge(command, command.arguments);
        if (command.arguments.action === 'introduce' || command.arguments.action === 'create_group') return this.initiateSocial(command, command.arguments, command.sourceMessageId, command.clientId);
        return { ok: true, world: this.tool(command, command.arguments, command.sourceMessageId) };
      case 'world.work.begin': return { ok: true, worldWork: this.begin(command, command.workId, command.kind, command.sourceMessageId, command.urgent, command.fixed,
        { learningGrantId: command.learningGrantId, learningLeaseToken: command.learningLeaseToken,
          authorizationGrantId: command.authorizationGrantId, invocationId: command.invocationId }) };
      case 'world.work.ready': return { ok: true, worldWork: this.ready(command.companionId, command.workId) };
      case 'world.work.end': return { ok: true, worldWork: this.end(command.companionId, command.workId) };
      case 'world.job.claim': return { ok: true, worldJob: this.claim(command.kind, command.excludedCompanionIds) };
      case 'world.job.check': return this.atomic(() => {
        const found = this.db.prepare('SELECT * FROM companion_world_jobs WHERE id=?').get(command.id);
        if (!found) return { ok: true };
        const job = parse<StoredJob>(row(found).data);
        if (job.status !== 'running' || job.leaseToken !== command.leaseToken || String(row(found).lease_until) < iso()) return { ok: true };
        if (job.kind === 'dream' && (!this.sleepingForJob(this.load(), job) || job.memoryVersions?.some(memory =>
          !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status')='indexed'").get(memory.id, job.companionId, memory.version)))) return { ok: true };
        this.db.prepare('UPDATE companion_world_jobs SET lease_until=? WHERE id=?').run(iso(Date.now() + 120000), job.id);
        return { ok: true, worldJob: job };
      });
      case 'world.job.bind-memories': return this.atomic(() => {
        const found = this.db.prepare('SELECT * FROM companion_world_jobs WHERE id=?').get(command.id);
        if (!found) throw new Error('睡眠整理任务不存在。');
        const job = parse<StoredJob>(row(found).data);
        if (job.kind !== 'dream' || job.status !== 'running' || job.leaseToken !== command.leaseToken
          || String(row(found).lease_until) < iso() || !this.sleepingForJob(this.load(), job)) throw new Error('睡眠整理租约或睡眠阶段已失效。');
        const versions = new Map(command.memoryVersions.map(memory => [memory.id, memory.version]));
        if (versions.size !== command.memoryVersions.length || job.memoryVersions?.some(memory => versions.get(memory.id) !== memory.version)) throw new Error('睡眠整理不能替换原始记忆种子。');
        for (const memory of command.memoryVersions) {
          const noteRow = this.db.prepare("SELECT data FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status')='indexed'").get(memory.id, job.companionId, memory.version);
          if (!noteRow) throw new Error('联想日记已经修订或撤回。');
          const note = parse<CompanionMemory>(row(noteRow).data);
          if (!note.sources.length || this.visibleSources({ companionId: job.companionId, conversationId: job.conversationId }, note.sources.map(source => source.messageId)).length !== note.sources.length)
            throw new Error('睡眠联想只能读取本人真实见证且仍获权的来源。');
        }
        job.seedMemoryVersions ??= [...(job.memoryVersions ?? [])];
        job.memoryVersions = command.memoryVersions; job.sourceMemoryIds = [...versions.keys()];
        this.db.prepare('UPDATE companion_world_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
        return { ok: true, worldJob: job };
      });
      case 'world.job.complete': this.complete(command); return { ok: true };
      case 'world.job.fail': return this.atomic(() => {
        const found = this.db.prepare('SELECT data FROM companion_world_jobs WHERE id=?').get(command.id); if (!found) throw new Error('世界任务不存在。'); const job = parse<CompanionWorldJob>(row(found).data);
        if (job.status !== 'running' || job.leaseToken !== command.leaseToken) throw new Error('世界任务租约已失效。');
        if (command.terminal) { job.status = 'failed'; job.terminal = true; job.error = command.error; }
        else job.status = job.encounterMemberIds || job.kind === 'dream' && job.attempts >= COMPANION_SLEEP_MAX_ATTEMPTS ? 'done' : 'failed';
        if (job.encounterMemberIds) { const state = this.load(); for (const actor of state.actors) if (actor.meetingHold?.jobId === job.id) this.releaseMeeting(actor, true); this.save(state); }
        this.db.prepare('UPDATE companion_world_jobs SET status=?,lease_until=?,data=? WHERE id=?').run(job.status, job.status === 'done' || job.terminal ? null : iso(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 6))), JSON.stringify(job), job.id); return { ok: true };
      });
      default: return undefined;
    }
  }
}
