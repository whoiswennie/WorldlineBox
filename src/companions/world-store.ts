import { createHash, randomUUID } from 'node:crypto';
import { COMPANION_WORLD_DEFAULT_SETTINGS, companionWorldSnapshotSchema, type CompanionWorldActor, type CompanionWorldEvent, type CompanionWorldJob, type CompanionWorldRelationship,
  type CompanionWorldScene, type CompanionWorldScope, type CompanionWorldSettings, type CompanionWorldSnapshot, type CompanionWorldVisit, type CompanionWorldWork } from '../shared/companion-world';
import type { CompanionWorldOccupancy } from '../shared/companion-world';
import { advanceCompanionWorldActor, companionWorldEnvironment, companionWorldRealAt, companionWorldSpeed, companionWorldVirtualAt,
  COMPANION_WORLD_SEATING_MS, COMPANION_WORLD_ACTION_TIMINGS, COMPANION_WORLD_WALK_TILES_PER_SECOND, createCompanionWorldCommons, createCompanionWorldHome, routeCompanionWorldActor } from '../shared/companion-world-engine';
import { evaluateCompanionRoutine } from '../shared/companion-routine-time';
import { resolveCompanionScheduleTimeZone, isCompanionScheduleTimeZone } from '../shared/companion-schedule-time';
import { applyCompanionAppraisal } from '../shared/companion-affect';
import { companionWorldExpression } from '../shared/companion-world-expression';
import type { CompanionRoutineConfig } from '../shared/companion-routine';
import type { CompanionWorldArguments } from '../shared/companion-world-tool';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionRuntimeState } from '../shared/companion-state';
import type { CompanionMemoryCandidate } from '../shared/companion-memory';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionSocialMessage } from '../shared/companion-social';
import type { CompanionSocialStore } from './social-store';
import type { CompanionWorkOrderStore } from './work-order-store';
import { companionTimeInZone } from '../shared/companion-schedule-time';

type Row = Record<string, string | number | null>;
type StoredActor = CompanionWorldActor & { arrivalActivity?: CompanionWorldActor['activity']; seatUntil?: number; lastDecisionAt: number; lastDreamDay?: number;
  phoneResume?: { activity: CompanionWorldActor['activity'] };
  afterWork?: { scope: CompanionWorldScope; args: CompanionWorldArguments; sourceMessageId?: string }; lastClimateKey?: string;
  transition?: { until: number; after: CompanionWorldActor['activity'] }; manualActivityUntil?: number; manualArtAction?: CompanionWorldActor['artAction']; pendingVisitId?: string };
type StoredWork = CompanionWorldWork & { conversationId: string; sourceMessageId?: string; urgent: boolean; fixed: boolean; requestedAtReal: number; workOrderId?: string };
type StoredVisit = CompanionWorldVisit & { responseSourceMessageId?: string; responseConversationId?: string; settledAt?: number };
type StoredJob = CompanionWorldJob & { memoryVersions?: Array<{ id: string; version: number }>; readSet?: Array<{ eventId: string; checksum: string; sourceChecksum?: string; sourceRevision?: number }> };
type StoredEvent = CompanionWorldEvent & { privateOwner?: string; sourceMemoryIds?: string[]; sourceMessageIds?: string[]; evidence?: Array<{ sourceMessageId: string; quote: string }>; positiveChange?: number; appraisalDay?: string;
  memoryVersions?: Array<{ id: string; version: number }>; relationshipDelta?: { affinity: number; trust: number }; withdrawn?: boolean };
type ClockSegment = { realAt: number; virtualAt: number; settings: CompanionWorldSettings };
type StoredWorld = { settings: CompanionWorldSettings; anchors: ClockSegment[]; cursor: number; slots: string[]; actors: StoredActor[];
  works: StoredWork[]; visits: StoredVisit[]; relationships: CompanionWorldRelationship[] };
const iso = (at = Date.now()) => new Date(at).toISOString();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const row = (value: unknown) => value as Row;
const privateRoom = (id: string) => 'world_' + id;
const activeVisit = (visit: StoredVisit) => visit.status === 'requested' || visit.status === 'allowed';
const RECENT_SETTLED_VISITS = 100;

/** World authority lives on the existing UtilityProcess connection. Tick is deterministic, not a second timer or database owner. */
export class CompanionWorldStore {
  private advancing = false;
  private dirty = true;
  private clockAnchors?: ClockSegment[];
  private through = 0;
  private actorProjection: StoredActor[] = [];
  private unseenCache = new Map<string, { token: string; present: boolean }>();
  private social?: CompanionSocialStore;
  private orders?: CompanionWorkOrderStore;
  private atomic<T>(fn: () => T): T {
    try { return this.db.transaction(fn).immediate(); } catch (error) { this.clockAnchors = undefined; this.actorProjection = []; this.through = 0; this.dirty = true; throw error; }
  }
  constructor(private readonly db: CompanionConnection, private readonly routineConfig: (id: string) => CompanionRoutineConfig,
    private readonly visibleSources: (scope: CompanionWorldScope, ids: string[]) => CompanionMessage[],
    private readonly runtime: (id: string) => Pick<CompanionRuntimeState, 'energy' | 'mood' | 'expression' | 'affect'>,
    private readonly applyEffect: (event: CompanionWorldEvent) => void,
    private readonly recordMemory: (scope: CompanionWorldScope, candidate: CompanionMemoryCandidate) => void) {}

  connectSocial(social: CompanionSocialStore): void { this.social = social; }
  connectWorkOrders(orders: CompanionWorkOrderStore): void { this.orders = orders; }
  socialContext(): { timeZone: string; virtualNow: string; observedDay: string; backlog: boolean } {
    const now = Date.now(); this.ensureThrough(now); const state = this.load(), at = this.virtualFor(state, state.cursor), day = companionTimeInZone(at, state.settings.timeZone);
    return { timeZone: state.settings.timeZone, virtualNow: iso(at), observedDay: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`, backlog: state.cursor + 1 < now };
  }
  socialAvailable(owner: string, channel: 'phone' | 'face_to_face', recipients: string[]): boolean {
    const state = this.load(), actor = state.actors.find(actor => actor.companionId === owner);
    if (!actor || !this.phoneAvailable(state, actor)) return false;
    if (channel === 'phone') return true;
    return !actor.route.length && !actor.transition && ['idle', 'sitting'].includes(actor.activity)
      && evaluateCompanionRoutine(this.routineConfig(owner), iso(this.virtualFor(state, state.cursor))).canRespond
      && !state.works.some(work => work.companionId === owner && work.status !== 'ended')
      && recipients.every(id => { const peer = state.actors.find(actor => actor.companionId === id); return peer && peer.sceneId === actor.sceneId && Math.hypot(peer.position.x - actor.position.x, peer.position.y - actor.position.y) <= 5; });
  }
  private phoneAvailable(state: StoredWorld, actor: StoredActor): boolean {
    const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
    return !['sleeping', 'eating'].includes(phase.phase) && !['sleeping', 'lyingDown', 'waking', 'eating', 'working'].includes(actor.activity)
      && !state.works.some(work => work.companionId === actor.companionId && work.kind !== 'chat' && work.status !== 'ended')
      && !this.db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status IN('queued','running') LIMIT 1").get(actor.companionId);
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_world_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_world_jobs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),kind TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_job_status ON companion_world_jobs(kind,status,lease_until);`);
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
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_world_dream_watermark(companion_id TEXT NOT NULL,memory_id TEXT NOT NULL,version INTEGER NOT NULL,processed_at TEXT NOT NULL,PRIMARY KEY(companion_id,memory_id,version))');
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_world_visit_records(id TEXT PRIMARY KEY,guest_id TEXT NOT NULL,host_id TEXT NOT NULL,status TEXT NOT NULL,settled_at INTEGER,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_visit_history ON companion_world_visit_records(guest_id,host_id,status,settled_at DESC);
      CREATE TABLE IF NOT EXISTS companion_world_clock_segments(revision INTEGER PRIMARY KEY,real_at INTEGER NOT NULL,virtual_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_world_clock_real ON companion_world_clock_segments(real_at DESC,revision DESC);
      CREATE INDEX IF NOT EXISTS companion_world_clock_virtual ON companion_world_clock_segments(virtual_at DESC,revision DESC);`);
    const state = this.load(); this.sync(state);
    // The stopped process did no external work during its absence. Keep positions
    // and routes; close only computer reservations belonging to that process.
    for (const work of state.works) if (work.status !== 'ended') work.status = 'ended';
    for (const actor of state.actors) this.releasePhone(actor, state.cursor);
    for (const actor of state.actors) if (actor.activity === 'working' || actor.activity === 'seating') { actor.activity = 'idle'; actor.route = []; delete actor.furnitureId; delete actor.destinationId; }
    this.save(state);
  }
  private load(): StoredWorld {
    const existing = this.db.prepare('SELECT data FROM companion_world WHERE id=1').get();
    if (existing) { const state = parse<StoredWorld>(row(existing).data); this.rememberClock(state); return state; }
    const now = Date.now(), settings: CompanionWorldSettings = { ...COMPANION_WORLD_DEFAULT_SETTINGS, revision: 1, timeZone: resolveCompanionScheduleTimeZone('system') };
    const fresh: StoredWorld = { settings, anchors: [{ realAt: now, virtualAt: now, settings }], cursor: now, slots: [], actors: [], works: [], visits: [], relationships: [] };
    this.save(fresh); return fresh;
  }
  private rememberClock(state: StoredWorld): void { this.clockAnchors = state.anchors; this.through = state.cursor; this.actorProjection = state.actors; }
  changed(): void { this.dirty = true; }
  resetCompanion(id: string): void {
    const state = this.load();
    state.actors = state.actors.filter(actor => actor.companionId !== id);
    state.works = state.works.filter(work => work.companionId !== id);
    state.visits = state.visits.filter(visit => visit.guestId !== id && visit.hostId !== id);
    state.relationships = state.relationships.filter(relation => relation.companionId !== id && relation.targetCompanionId !== id);
    for (const actor of state.actors) if (actor.sceneId === 'home_' + id || actor.route.some(point => point.sceneId === 'home_' + id)) {
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
    if (actor.transition) return { phase: 'awake', activity: actor.activity === 'lyingDown' ? '正在床上躺下，尚未入睡' : actor.activity === 'waking' ? '正在醒来起床' : actor.activity === 'standingUp' ? '正在起身准备行动' : actor.activity === 'seating' ? '正在家具前坐下' : '正在转身' };
    if (actor.activity === 'walking') return { phase: 'awake', activity: '正在前往' + (actor.destinationId?.endsWith('_bed') ? '床边准备睡觉' : actor.destinationId?.endsWith('_dining') ? '餐桌准备吃饭' : actor.destinationId?.endsWith('_sofa') ? '沙发准备休息' : actor.destinationId?.endsWith('_computer') ? '电脑前' : '日常活动地点') };
    if (['sleeping', 'eating', 'resting', 'habit'].includes(actor.activity)) {
      const planned = evaluateCompanionRoutine(this.routineConfig(companionId), iso(this.virtualAt(this.through)));
      return { phase: actor.activity as 'sleeping' | 'eating' | 'resting' | 'habit', activity: actor.activity === 'habit' ? planned.activity : actor.activity === 'sleeping' ? '在床上睡眠' : actor.activity === 'eating' ? '在餐桌用餐' : '在家具旁休息', ...(actor.activity === 'habit' && planned.activeHabitId ? { activeHabitId: planned.activeHabitId } : {}) };
    }
    return { phase: 'awake', ...(actor.activity === 'working' ? { activity: '正在电脑前处理已答应的事' } : actor.activity === 'seating' ? { activity: '正在电脑前坐稳' } : {}) };
  }
  private syncOccupancy(state: StoredWorld): void {
    const present = new Set(state.actors.map(actor => actor.companionId));
    for (const open of this.db.prepare('SELECT id,companion_id FROM companion_world_occupancy WHERE ends_at IS NULL').all() as Row[]) if (!present.has(String(open.companion_id))) this.db.prepare('UPDATE companion_world_occupancy SET ends_at=? WHERE id=?').run(state.cursor, open.id);
    for (const actor of state.actors) {
      const phase = ['sleeping', 'eating', 'resting', 'habit'].includes(actor.activity) && !actor.route.length && actor.furnitureId ? actor.activity : undefined;
      const config = this.routineConfig(actor.companionId), planned = evaluateCompanionRoutine(config, iso(this.virtualFor(state, state.cursor)));
      const habitId = phase === 'habit' || phase === 'resting' ? planned.activeHabitId : undefined, habitKind = config.habits.find(habit => habit.id === habitId)?.kind;
      const open = this.db.prepare('SELECT * FROM companion_world_occupancy WHERE companion_id=? AND ends_at IS NULL').get(actor.companionId);
      if (open && row(open).phase === phase && (row(open).habit_id ?? undefined) === habitId) continue;
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
  private virtualFor(state: StoredWorld, realAt: number): number {
    const anchor = this.clockAnchor(state.anchors, realAt);
    return companionWorldVirtualAt(anchor, anchor.settings, realAt);
  }
  private realFor(state: StoredWorld, virtualAt: number): number {
    const anchor = this.clockAnchor(state.anchors, state.cursor);
    return companionWorldRealAt(anchor, anchor.settings, virtualAt);
  }
  private scenes(state: StoredWorld): CompanionWorldScene[] {
    const homes = state.slots.map((id, slot) => createCompanionWorldHome(id, slot));
    const scenes = [createCompanionWorldCommons(homes), ...homes];
    for (const work of state.works.filter(work => work.status !== 'ended')) for (const scene of scenes) {
      const computer = scene.objects.find(object => object.id === work.computerId);
      if (computer) { computer.reservedBy = work.companionId; if (work.status === 'ready' || work.status === 'seating') computer.occupantId = work.companionId; }
    }
    for (const actor of state.actors) if (actor.furnitureId && !actor.route.length && ['seating', 'sitting', 'working', 'standingUp'].includes(actor.activity)) {
      const computer = scenes.flatMap(scene => scene.objects).find(object => object.id === actor.furnitureId && object.kind === 'computer');
      if (computer) { computer.occupantId = actor.companionId; computer.reservedBy = actor.companionId; }
    }
    return scenes;
  }
  private sync(state: StoredWorld): void {
    const ids = (this.db.prepare("SELECT id FROM companions c WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed') ORDER BY rowid").all() as Row[]).map(value => String(value.id));
    for (const id of ids) {
      if (!state.slots.includes(id)) state.slots.push(id);
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
    state.actors = state.actors.filter(actor => ids.includes(actor.companionId));
    for (const work of state.works) if (!ids.includes(work.companionId) || !this.db.prepare('SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.dissolved_at IS NULL AND m.companion_id=?').get(work.conversationId, work.companionId) ||
      work.sourceMessageId && !this.visibleSources({ companionId: work.companionId, conversationId: work.conversationId }, [work.sourceMessageId]).length) work.status = 'ended';
    for (const visit of state.visits) if (!ids.includes(visit.guestId) || !ids.includes(visit.hostId)) visit.status = 'expired';
  }
  private requireScope(scope: CompanionWorldScope): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(scope.companionId) ||
      !this.db.prepare('SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.dissolved_at IS NULL AND m.companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('世界操作不属于当前伙伴或聊天。');
  }
  private permitted(state: StoredWorld, actorId: string, ownerId: string): boolean {
    return ownerId === actorId || state.visits.some(visit => visit.hostId === ownerId && visit.guestId === actorId && visit.status === 'allowed' && Date.parse(visit.expiresAt) > this.virtualFor(state, state.cursor));
  }
  private event(state: StoredWorld, input: Omit<StoredEvent, 'id' | 'sequence' | 'at' | 'realAt' | 'simulation'>, at = state.cursor): StoredEvent {
    const event = { ...input, id: randomUUID(), sequence: 1, at: iso(this.virtualFor(state, at)), realAt: iso(at), simulation: true as const };
    const result = this.db.prepare('INSERT INTO companion_world_events(id,data) VALUES(?,?)').run(event.id, JSON.stringify(event)); event.sequence = Number(result.lastInsertRowid);
    this.db.prepare('UPDATE companion_world_events SET data=? WHERE id=?').run(JSON.stringify(event), event.id);
    return event;
  }
  private move(state: StoredWorld, actor: StoredActor, scene: CompanionWorldScene, destination: { x: number; y: number }, destinationId: string, activity: CompanionWorldActor['activity']): void {
    const route = routeCompanionWorldActor(this.scenes(state), actor, scene.id, destination, owner => this.permitted(state, actor.companionId, owner));
    if (!route) throw new Error('目的地不可达，或房主尚未同意进入。');
    const previous = actor.activity, transition = actor.transition;
    delete actor.manualActivityUntil; delete actor.manualArtAction;
    actor.route = route; actor.destinationId = destinationId; actor.arrivalActivity = activity; actor.activity = route.length ? 'walking' : activity;
    const running = state.works.some(work => work.companionId === actor.companionId && work.urgent && work.status !== 'ended');
    actor.locomotion = running ? 'run' : 'walk'; actor.movementSpeed = running ? 4.8 : COMPANION_WORLD_WALK_TILES_PER_SECOND;
    actor.activityStartedAtReal = iso(state.cursor);
    delete actor.seatUntil;
    if (transition && transition.until > state.cursor) { actor.activity = previous; transition.after = route.length ? 'walking' : activity; }
    else if (['sleeping', 'lyingDown'].includes(previous)) this.startTransition(actor, 'waking', 'walking', state.cursor);
    else if (['sitting', 'working', 'eating', 'resting', 'seating'].includes(previous)) this.startTransition(actor, 'standingUp', 'walking', state.cursor);
    else if (route.length) {
      const first = route.find(point => point.sceneId === actor.sceneId && Math.hypot(point.x - actor.position.x, point.y - actor.position.y) > .01);
      const facing = first ? Math.abs(first.x - actor.position.x) > Math.abs(first.y - actor.position.y) ? first.x > actor.position.x ? 'east' : 'west' : first.y > actor.position.y ? 'south' : 'north' : actor.facing;
      if (facing !== actor.facing) { actor.facing = facing; this.startTransition(actor, 'turning', 'walking', state.cursor); }
    }
    if (!actor.transition) delete actor.furnitureId;
    if (!route.length && !actor.transition && activity === 'sleeping') { actor.furnitureId = destinationId; this.startTransition(actor, 'lyingDown', 'sleeping', state.cursor); }
    else if (!route.length && !actor.transition && (activity === 'eating' || activity === 'resting')) { actor.furnitureId = destinationId; this.startTransition(actor, 'seating', activity, state.cursor); }
    this.event(state, { kind: 'move', actorId: actor.companionId, sceneId: actor.sceneId, text: '开始步行前往' + destinationId });
  }
  private startTransition(actor: StoredActor, action: 'seating' | 'standingUp' | 'lyingDown' | 'waking' | 'turning', after: CompanionWorldActor['activity'], at: number): void {
    const duration = action === 'seating' ? COMPANION_WORLD_ACTION_TIMINGS.sitDown : action === 'standingUp' ? COMPANION_WORLD_ACTION_TIMINGS.standUp : action === 'lyingDown' ? COMPANION_WORLD_ACTION_TIMINGS.lieDown : action === 'waking' ? COMPANION_WORLD_ACTION_TIMINGS.wake : COMPANION_WORLD_ACTION_TIMINGS.turn;
    actor.activity = action; actor.activityStartedAtReal = iso(at); actor.transition = { until: at + duration, after };
  }
  private finishTransitions(state: StoredWorld): void {
    for (const actor of state.actors) if (actor.transition && actor.transition.until <= state.cursor) {
      const transition = actor.transition; actor.activity = transition.after; actor.activityStartedAtReal = iso(transition.until); delete actor.transition;
      if (actor.activity === 'walking' || actor.activity === 'idle') delete actor.furnitureId;
    }
  }
  private enterFurniture(actor: StoredActor, activity: CompanionWorldActor['activity'], at: number): void {
    if (actor.activity === activity) return;
    if (activity === 'sleeping') this.startTransition(actor, 'lyingDown', 'sleeping', at);
    else if (['eating', 'resting', 'sitting'].includes(activity)) this.startTransition(actor, 'seating', activity, at);
    else if (activity === 'idle' && ['sleeping', 'lyingDown'].includes(actor.activity)) this.startTransition(actor, 'waking', 'idle', at);
    else if (activity === 'idle' && ['sitting', 'seating', 'resting', 'eating', 'working'].includes(actor.activity)) this.startTransition(actor, 'standingUp', 'idle', at);
    else { actor.activity = activity; actor.activityStartedAtReal = iso(at); }
  }
  private planRoutine(state: StoredWorld, actor: StoredActor): void {
    const focus = this.orders?.focus(actor.companionId);
    let releasedFocus = false;
    for (const held of state.works.filter(work => work.companionId === actor.companionId && work.workOrderId && work.status !== 'ended')) {
      if (held.workOrderId !== focus?.id) { held.status = 'ended'; releasedFocus = true; }
      else if (focus) held.sourceMessageId = focus.sourceMessageId;
    }
    if (focus && !state.works.some(work => work.companionId === actor.companionId && work.workOrderId === focus.id && work.status !== 'ended')) {
      state.works.push({ workId: 'order_hold_' + focus.id, workOrderId: focus.id, companionId: actor.companionId, conversationId: focus.conversationId, sourceMessageId: focus.sourceMessageId, kind: 'action', urgent: false, fixed: true, requestedAtReal: Date.parse(focus.createdAt), status: 'waiting', reason: '已受理工作尚未结束，保持集中工作' });
    }
    const active = state.works.filter(work => work.companionId === actor.companionId && work.status !== 'ended');
    const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
    actor.routinePhase = phase.phase;
    const computer = active.filter(work => work.kind !== 'chat'), phone = active.filter(work => work.kind === 'chat');
    const peerPhone = this.peerPhoneActive(actor.companionId, state.cursor);
    if (releasedFocus && !computer.length && ['working', 'seating'].includes(actor.activity)) {
      delete actor.seatUntil; delete actor.destinationId;
      this.startTransition(actor, 'standingUp', 'idle', state.cursor);
    }
    if (actor.phoneResume && (computer.length || !phone.some(work => work.status === 'ready') && !(peerPhone && this.phoneAvailable(state, actor)))) this.releasePhone(actor, state.cursor);
    if (computer.length) this.planComputer(state, actor, computer);
    if (phone.length) this.planPhone(state, actor, phone, computer);
    if (active.some(work => work.status !== 'waiting')) return;
    if (peerPhone && this.phoneAvailable(state, actor)) {
      if (!actor.transition) this.holdPhone(actor, state.cursor);
      return;
    }
    if (actor.transition && actor.transition.until > state.cursor) return;
    if (actor.manualActivityUntil && actor.manualActivityUntil > this.virtualFor(state, state.cursor) && phase.canRespond) return;
    delete actor.manualActivityUntil; delete actor.manualArtAction;
    if (actor.pendingVisitId && phase.canRespond) {
      const visit = state.visits.find(visit => visit.id === actor.pendingVisitId && visit.status === 'allowed' && Date.parse(visit.expiresAt) > this.virtualFor(state, state.cursor));
      delete actor.pendingVisitId;
      if (visit) { const home = this.scenes(state).find(scene => scene.ownerId === visit.hostId)!; this.move(state, actor, home, { x: 10, y: 12 }, home.id, 'idle'); return; }
    }
    const currentScene = this.scenes(state).find(scene => scene.id === actor.sceneId);
    if (currentScene?.ownerId && !this.permitted(state, actor.companionId, currentScene.ownerId)) {
      const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId)!;
      if (actor.destinationId !== home.id) this.move(state, actor, home, { x: 10, y: 12 }, home.id, 'idle');
      return;
    }
    if (actor.seatUntil && actor.seatUntil > state.cursor) return;
    const kind = phase.phase === 'sleeping' ? 'bed' : phase.phase === 'eating' ? 'dining' : phase.phase === 'resting' ? 'sofa' : phase.phase === 'habit' ? 'habit' : undefined;
    if (!kind) {
      if (actor.activity === 'sleeping') this.startTransition(actor, 'waking', 'idle', state.cursor);
      else if (['eating', 'resting'].includes(actor.activity)) this.startTransition(actor, 'standingUp', 'idle', state.cursor);
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
      this.enterFurniture(actor, activity, state.cursor);
    }
  }
  private releasePhone(actor: StoredActor, now: number): void {
    if (!actor.phoneResume) return;
    if (!actor.transition || actor.transition.until <= now) { actor.activity = actor.phoneResume.activity; actor.activityStartedAtReal = iso(now); }
    delete actor.phoneResume;
  }
  private holdPhone(actor: StoredActor, now: number): void {
    if (actor.phoneResume) return;
    actor.phoneResume = { activity: actor.activity };
    if (!['working', 'sitting', 'resting'].includes(actor.activity)) actor.activity = 'idle';
    actor.activityStartedAtReal = iso(now);
  }
  private planPhone(state: StoredWorld, actor: StoredActor, phones: StoredWork[], computers: StoredWork[]): void {
    // A reply awaiting its own computer work cannot also hold the walking actor
    // on the phone. A distinct urgent message may still interrupt that work.
    const awaitingComputer = (phone: StoredWork) => !!phone.sourceMessageId && computers.some(work => work.conversationId === phone.conversationId && work.sourceMessageId === phone.sourceMessageId);
    const urgentSources = phones.filter(work => work.urgent && work.sourceMessageId && !awaitingComputer(work)).flatMap(work => this.db.prepare('SELECT sequence,conversation_id FROM messages WHERE id=?').all(work.sourceMessageId) as Row[]);
    const ordinaryAllowed = this.phoneAvailable(state, actor) && !this.peerPhoneActive(actor.companionId, state.cursor);
    const eligible = phones.filter(work => work.requestedAtReal <= state.cursor && !awaitingComputer(work) && (ordinaryAllowed || work.urgent || work.sourceMessageId && urgentSources.some(source => source.conversation_id === work.conversationId && Number(row(this.db.prepare('SELECT sequence FROM messages WHERE id=?').get(work.sourceMessageId)).sequence) >= Number(source.sequence))));
    for (const work of phones) {
      delete work.computerId; work.nextCheckAt = iso(Math.max(state.cursor + 500, work.requestedAtReal));
      if (!eligible.includes(work)) { work.status = 'waiting'; work.reason = work.requestedAtReal > state.cursor ? '正在补算世界存档' : awaitingComputer(work) ? '这条请求正在电脑执行，等待实际结果后继续手机回复' : this.peerPhoneActive(actor.companionId, state.cursor) ? '正在用手机处理先前消息，稍后依次回复' : '正在工作、用餐或睡眠，稍后用手机回复'; }
    }
    if (!eligible.length) { if (!this.peerPhoneActive(actor.companionId, state.cursor) || !this.phoneAvailable(state, actor)) this.releasePhone(actor, state.cursor); return; }
    if (['sleeping', 'lyingDown'].includes(actor.activity)) this.enterFurniture(actor, 'idle', state.cursor);
    else if (actor.activity === 'eating') this.enterFurniture(actor, 'idle', state.cursor);
    if (actor.transition && actor.transition.until > state.cursor) { for (const work of eligible) { work.status = 'moving'; work.reason = '正在结束当前姿态，准备查看手机'; } return; }
    this.holdPhone(actor, state.cursor);
    for (const work of eligible) { work.status = 'ready'; delete work.reason; }
  }
  private planComputer(state: StoredWorld, actor: StoredActor, works: StoredWork[]): void {
    const phase = evaluateCompanionRoutine(this.routineConfig(actor.companionId), iso(this.virtualFor(state, state.cursor)));
    const urgentSources = works.filter(work => work.urgent && work.sourceMessageId).flatMap(work => this.db.prepare('SELECT sequence,conversation_id FROM messages WHERE id=?').all(work.sourceMessageId) as Row[]);
    const eligible = works.filter(work => work.requestedAtReal <= state.cursor && (phase.canRespond || work.urgent || work.fixed || ['moving', 'seating', 'ready'].includes(work.status) || work.sourceMessageId &&
      urgentSources.some(source => source.conversation_id === work.conversationId && Number(row(this.db.prepare('SELECT sequence FROM messages WHERE id=?').get(work.sourceMessageId)).sequence) >= Number(source.sequence))));
    for (const work of works.filter(work => !eligible.includes(work))) { work.status = 'waiting'; work.reason = work.requestedAtReal > state.cursor ? '正在补算世界存档，尚未到达这次请求的实际时刻' : '按照世界作息休息，等待醒来'; work.nextCheckAt = iso(Math.max(work.requestedAtReal, this.realFor(state, Date.parse(phase.nextTransitionAt)))); delete work.computerId; }
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
    if (actor.transition && actor.transition.until > state.cursor) { for (const work of eligible) work.status = 'moving'; return; }
    if (!actor.route.length && actor.sceneId === scene.id && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01) {
      if (!actor.seatUntil) actor.seatUntil = state.cursor + COMPANION_WORLD_SEATING_MS;
      if (state.cursor >= actor.seatUntil) { if (actor.activity !== 'working') actor.activityStartedAtReal = iso(state.cursor); actor.activity = 'working'; actor.furnitureId = computer.id; for (const work of eligible) work.status = 'ready'; }
      else { actor.activity = 'seating'; for (const work of eligible) work.status = 'seating'; }
    } else for (const work of eligible) work.status = 'moving';
  }
  tick(now = Date.now()): CompanionWorldSnapshot { this.advance(now); return this.snapshotValue(this.load(), now); }
  private advance(now = Date.now()): void {
    if (this.advancing) return;
    if (this.clockAnchors && now <= this.through && !this.dirty) return;
    this.advancing = true;
    try { this.db.transaction(() => {
      const state = this.load(); this.sync(state); const target = Math.max(state.cursor, now); let steps = 0;
      while (state.cursor < target && steps++ < 1000) {
        this.finishTransitions(state);
        for (const visit of state.visits) if (['allowed', 'requested'].includes(visit.status) && Date.parse(visit.expiresAt) <= this.virtualFor(state, state.cursor)) visit.status = 'expired';
        for (const actor of state.actors) this.planRoutine(state, actor);
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
          if (actor.route.length && actor.activity === 'walking') {
            const distance = actor.route.reduce((sum, point, index) => { const prior = index ? actor.route[index - 1]! : { ...actor.position, sceneId: actor.sceneId };
              return sum + (prior.sceneId === point.sceneId ? Math.hypot(point.x - prior.x, point.y - prior.y) : 1); }, 0);
            next = Math.min(next, state.cursor + Math.max(1, distance / actor.movementSpeed * 1000));
          }
          if (actor.seatUntil && actor.seatUntil > state.cursor) next = Math.min(next, actor.seatUntil);
          if (actor.transition && actor.transition.until > state.cursor) next = Math.min(next, actor.transition.until);
        }
        const elapsed = next - state.cursor;
        for (let index = 0; index < state.actors.length; index++) {
          const actor = state.actors[index]!; if (!actor.route.length || actor.activity !== 'walking') continue;
          // Recheck every doorway at the instant of crossing; permission may be
          // revoked while walking, including by expiration during an offline tick.
          let priorScene = actor.sceneId;
          const forbidden = actor.route.findIndex(point => { const crossing = point.sceneId !== priorScene; priorScene = point.sceneId; return crossing && point.sceneId.startsWith('home_') && !this.permitted(state, actor.companionId, point.sceneId.slice(5)); });
          if (forbidden >= 0) { actor.route = []; delete actor.destinationId; actor.activity = 'idle'; continue; }
          const advanced = advanceCompanionWorldActor(actor, elapsed); state.actors[index] = { ...actor, ...advanced.actor };
          if (advanced.arrived) { const arrived = state.actors[index]!; arrived.activity = arrived.arrivalActivity ?? 'idle'; arrived.activityStartedAtReal = iso(next); arrived.furnitureId = arrived.destinationId;
            const activity = arrived.activity; arrived.activity = 'idle'; this.enterFurniture(arrived, activity, next);
            this.event(state, { kind: 'arrive', actorId: actor.companionId, sceneId: arrived.sceneId, text: '步行到达' + arrived.destinationId }, next); }
        }
        state.cursor = next;
      }
      for (const visit of state.visits) if (['allowed', 'requested'].includes(visit.status) && Date.parse(visit.expiresAt) <= this.virtualFor(state, state.cursor)) visit.status = 'expired';
      this.finishTransitions(state); for (const actor of state.actors) this.planRoutine(state, actor);
      this.syncOccupancy(state);
      for (const actor of state.actors) if (actor.activity === 'sleeping' && !actor.route.length && state.cursor - Date.parse(actor.activityStartedAtReal) >= 5000 &&
        !state.works.some(work => work.companionId === actor.companionId && work.status !== 'ended')) {
        this.queueJob(state, actor.companionId, 'dream');
        if (actor.lastDreamDay !== Math.floor(this.virtualFor(state, state.cursor) / 86400000)) { actor.lastDreamDay = Math.floor(this.virtualFor(state, state.cursor) / 86400000);
          this.event(state, { kind: 'sleep_rest', actorId: actor.companionId, sceneId: actor.sceneId, text: '在自己的床上安静休息', effect: { type: 'rest', intensity: .15 } }); }
      }
      const climate = companionWorldEnvironment(this.virtualFor(state, state.cursor), state.settings.timeZone);
      for (const actor of state.actors) {
        const outside = actor.sceneId === 'commons', band = climate.environment.outdoorTemperature < 10 ? 'cold' : climate.environment.outdoorTemperature > 30 ? 'hot' : 'mild';
        const key = [climate.clock.day, climate.clock.daylight, climate.environment.weather, band, outside].join('_');
        if (key === actor.lastClimateKey) continue; actor.lastClimateKey = key;
        if (!outside) continue;
        const stressed = band !== 'mild' || ['rain', 'snow'].includes(climate.environment.weather);
        this.event(state, { kind: 'environment', actorId: actor.companionId, sceneId: actor.sceneId, text: stressed ? '感受到户外的降水或偏冷偏热天气' : '感受到街区的自然光线与空气', effect: { type: stressed ? 'stress' : 'comfort', intensity: stressed ? .15 : .08 } });
      }
      this.save(state); this.dirty = false; this.flushEffects();
    }).immediate(); } catch (error) { this.clockAnchors = undefined; this.actorProjection = []; this.through = 0; throw error; } finally { this.advancing = false; }
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
    actor.lastDecisionAt = now; this.queueJob(state, actor.companionId, 'decision');
  }
  private queueJob(state: StoredWorld, companionId: string, kind: CompanionWorldJob['kind']): void {
    if (this.db.prepare("SELECT 1 FROM companion_world_jobs WHERE companion_id=? AND kind=? AND status IN ('pending','running','failed')").get(companionId, kind)) return;
    if (kind === 'dream' && !this.unseenAtoms(companionId, 1).length) return;
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
    const job: CompanionWorldJob = { id: randomUUID(), companionId, conversationId, kind, status: 'pending', throughEventSequence: Number(last), createdAt: iso(state.cursor), attempts: 0, sourceMemoryIds: [] };
    this.db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run(job.id, companionId, kind, job.status, JSON.stringify(job));
  }
  private unseenAtoms(companionId: string, limit: number): Array<{ id: string; version: number }> {
    const token = String(row(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-atom-change/' + companionId) ?? { value: '' }).value);
    if (this.unseenCache.get(companionId)?.token === token && !this.unseenCache.get(companionId)?.present) return [];
    const result = (this.db.prepare(`SELECT r.memory_id,r.version FROM memory_records r JOIN memories m ON m.id=r.memory_id
      WHERE r.companion_id=? AND r.status='active' AND r.kind IN ('fact','preference','agreement','event','task')
      AND COALESCE(json_extract(m.data,'$.epistemicStatus'),'')!='unverified' AND json_array_length(json_extract(m.data,'$.sources'))>0
      AND NOT EXISTS(SELECT 1 FROM companion_world_dream_watermark w WHERE w.companion_id=r.companion_id AND w.memory_id=r.memory_id AND w.version=r.version)
      ORDER BY r.ordinal LIMIT ?`).all(companionId, limit) as Row[]).map(value => ({ id: String(value.memory_id), version: Number(value.version) }));
    this.unseenCache.set(companionId, { token, present: !!result.length }); return result;
  }
  private visibleEvent(event: StoredEvent, scope?: CompanionWorldScope): boolean {
    try { return this.sourceEventVisible(event, scope); } catch { return false; }
  }
  private sourceEventVisible(event: StoredEvent, scope?: CompanionWorldScope): boolean {
    if (event.withdrawn) return false;
    if (scope && event.privateOwner && event.privateOwner !== scope.companionId) return false;
    const owner = event.privateOwner ?? event.actorId;
    if (event.sourceMessageId && owner && event.conversationId) {
      let s = scope ?? { companionId: owner, conversationId: event.conversationId };
      if (scope && this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + scope.conversationId) &&
        this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + event.conversationId) &&
        this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(event.conversationId, scope.companionId)) s = { ...scope, conversationId: event.conversationId };
      if (!this.visibleSources(s, [event.sourceMessageId]).length) return false;
    }
    if (event.sourceMessageIds?.length && owner && event.conversationId && this.visibleSources(scope ?? { companionId: owner, conversationId: event.conversationId }, event.sourceMessageIds).length !== event.sourceMessageIds.length) return false;
    if (event.sourceMemoryIds?.length && owner && event.sourceMemoryIds.some(id => !this.db.prepare("SELECT 1 FROM memory_records WHERE memory_id=? AND companion_id=? AND status='active'").get(id, owner))) return false;
    if (event.memoryVersions?.some(memory => !this.db.prepare("SELECT 1 FROM memory_records WHERE memory_id=? AND version=? AND status='active'").get(memory.id, memory.version))) return false;
    if (scope && event.sceneId?.startsWith('home_') && event.kind !== 'social_phone' && !this.permitted(this.load(), scope.companionId, event.sceneId.slice(5))) return false;
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
    const allowedScenes = scope ? scenes.filter(scene => scene.kind === 'commons' || scene.ownerId && this.permitted(state, scope.companionId, scene.ownerId)) : scenes;
    const visibleIds = new Set(allowedScenes.map(scene => scene.id));
    const found = this.db.prepare('SELECT data FROM companion_world_events ORDER BY sequence DESC LIMIT 500').all() as Row[];
    const events = found.map(value => parse<StoredEvent>(value.data)).filter(event => this.visibleEvent(event, scope)).slice(0, 100).reverse().map(event => event.kind === 'social_phone' ? { ...event, sceneId: undefined } : event);
    return companionWorldSnapshotSchema.parse({ settings: state.settings, clock: { realNow: iso(now), virtualNow: iso(virtualAt), speed: companionWorldSpeed(state.settings), ...environment.clock }, environment: environment.environment,
      residents: (this.db.prepare("SELECT id,json_extract(data,'$.name') AS name FROM companions WHERE deleted_at IS NULL ORDER BY rowid").all() as Row[]).map(companion => ({ companionId: String(companion.id), name: String(companion.name), homeSceneId: 'home_' + companion.id })),
      scenes: allowedScenes, actors: state.actors.filter(actor => visibleIds.has(actor.sceneId)).map(actor => {
        const runtime = { ...this.runtime(actor.companionId), thermalComfort: Math.max(0, 1 - Math.abs((actor.sceneId === 'commons' ? environment.environment.outdoorTemperature : environment.environment.indoorTemperature) - 22) / 15) };
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
        const phonePose = ['typing', 'responding'].includes(communication?.phase ?? '') && ['idle', 'sitting', 'resting', 'working'].includes(actor.activity) ? ['sitting', 'resting', 'working'].includes(actor.activity) ? 'phoneTypingSeated' : 'phoneTypingStanding' : undefined;
        return { ...actor,
        frame: actor.transition ? Math.min(2, Math.floor(Math.max(0, observedAt - Date.parse(actor.activityStartedAtReal)) / (actor.transition.until - Date.parse(actor.activityStartedAtReal)) * 3)) :
          actor.activity === 'seating' && actor.seatUntil ? Math.min(2, Math.floor(Math.max(0, observedAt - Date.parse(actor.activityStartedAtReal)) / COMPANION_WORLD_SEATING_MS * 3)) :
            Math.floor(Math.max(0, observedAt - Date.parse(actor.activityStartedAtReal)) / (actor.activity === 'walking' ? 180 : 700)) % 3,
        transitionEndsAtReal: actor.transition ? iso(actor.transition.until) : actor.activity === 'seating' && actor.seatUntil ? iso(actor.seatUntil) : undefined,
        state: runtime, artAction: phonePose ?? expression.action, artStartedAtReal: expression.startedAtReal,
        communication: !scope || scope.companionId === actor.companionId || communication?.recipientIds.includes(scope.companionId) ? communication : undefined,
        activityLabel: actor.routinePhase === 'habit' ? '个人日常活动' : undefined }; }),
      visits: state.visits.filter(visit => !scope || visit.hostId === scope.companionId || visit.guestId === scope.companionId).map(visit => {
        const visible = (owner: string, sourceId?: string, conversationId?: string) => {
          if (!sourceId) return true; if (!conversationId) return false;
          try { return !!this.visibleSources(scope ?? { companionId: owner, conversationId }, [sourceId]).length; } catch { return false; }
        };
        const reasonVisible = visible(visit.guestId, visit.sourceMessageId, visit.conversationId), responseVisible = visible(visit.hostId, visit.responseSourceMessageId, visit.responseConversationId);
        return { ...visit, reason: reasonVisible ? visit.reason : '申请来小屋做客', response: responseVisible ? visit.response : visit.response ? '房主已回应拜访请求' : undefined,
          sourceMessageId: reasonVisible ? visit.sourceMessageId : undefined, conversationId: reasonVisible ? visit.conversationId : undefined };
      }), events,
      relationships: state.relationships.filter(relation => !scope || relation.companionId === scope.companionId), works: state.works.filter(work => !scope || work.companionId === scope.companionId),
      lastEventSequence: Number(row(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM companion_world_events').get()).n), backlog: state.cursor + 1 < now });
  }
  snapshot(scope?: CompanionWorldScope): CompanionWorldSnapshot { if (scope) this.requireScope(scope); this.ensureThrough(Date.now()); const state = this.load(); this.sync(state); this.save(state); return this.snapshotValue(state, Date.now(), scope); }
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
  begin(scope: CompanionWorldScope, workId: string, kind: CompanionWorldWork['kind'], sourceMessageId?: string, urgent = false, fixed = false): CompanionWorldWork {
    const requestedAtReal = Date.now(); this.requireScope(scope); this.advance(requestedAtReal); const state = this.load();
    if (sourceMessageId) { const source = this.visibleSources(scope, [sourceMessageId])[0]; if (!source || source.authorId !== 'user') throw new Error('工作需要真实可见的用户来源。'); const verified = this.urgent(scope.companionId, sourceMessageId); if (urgent && !verified) throw new Error('来源缺少已核验的紧急通知判断。'); urgent = verified; }
    else if (!fixed) throw new Error('工作缺少真实用户来源。');
    let work = state.works.find(work => work.workId === workId);
    if (!work) { const saved = this.db.prepare('SELECT data FROM companion_world_work_records WHERE work_id=?').get(workId); if (saved) { work = parse<StoredWork>(row(saved).data); state.works.push(work); } }
    if (work && (work.companionId !== scope.companionId || work.conversationId !== scope.conversationId || work.kind !== kind || work.sourceMessageId !== sourceMessageId)) throw new Error('工作不属于当前伙伴或原来的来源。');
    if (!work) { work = { workId, companionId: scope.companionId, conversationId: scope.conversationId, kind, sourceMessageId, urgent, fixed, requestedAtReal, status: 'waiting' }; state.works.push(work); }
    else if (work.status === 'ended') { work.status = 'waiting'; work.urgent = urgent; work.fixed = fixed; work.requestedAtReal = requestedAtReal; delete work.computerId; delete work.reason; }
    this.planRoutine(state, state.actors.find(actor => actor.companionId === scope.companionId)!);
    this.syncOccupancy(state); this.save(state); return work;
  }
  ready(companionId: string, workId: string): CompanionWorldWork {
    const now = Date.now(); this.advance(now); const saved = this.db.prepare('SELECT data FROM companion_world_work_records WHERE work_id=? AND companion_id=?').get(workId, companionId); if (!saved) throw new Error('工作不存在。');
    const work = parse<StoredWork>(row(saved).data);
    return this.through < now && work.status !== 'ended' ? { ...work, status: 'waiting', reason: '正在补算世界存档', nextCheckAt: iso(now + 250) } : work;
  }
  end(companionId: string, workId: string): CompanionWorldWork | undefined {
    this.ensureThrough(Date.now());
    const state = this.load(), work = state.works.find(item => item.workId === workId && item.companionId === companionId); if (!work) { const saved = this.db.prepare('SELECT data FROM companion_world_work_records WHERE work_id=? AND companion_id=?').get(workId, companionId); return saved ? parse<StoredWork>(row(saved).data) : undefined; }
    if (work.status !== 'ended') { work.status = 'ended'; const actor = state.actors.find(actor => actor.companionId === companionId)!;
      if (work.kind === 'chat') {
        if (!state.works.some(item => item.companionId === companionId && item.kind === 'chat' && item.status === 'ready')) this.releasePhone(actor, state.cursor);
        this.event(state, { kind: 'phone_response_end', actorId: companionId, text: '结束手机回复，继续当前生活' }); this.planRoutine(state, actor); this.syncOccupancy(state);
      } else if (!state.works.some(item => item.companionId === companionId && ['moving', 'seating', 'ready'].includes(item.status))) {
        actor.route = []; delete actor.destinationId; delete actor.seatUntil;
        if (['working', 'sitting', 'seating'].includes(actor.activity)) this.startTransition(actor, 'standingUp', 'idle', state.cursor);
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
      if (state.works.some(work => work.companionId === actor.companionId && work.status !== 'ended')) throw new Error('正在回应或工作，不能同时开始新的生活活动。');
      const home = this.scenes(state).find(scene => scene.id === actor.homeSceneId)!, object = home.objects.find(object => object.kind === (kind === 'rest' ? 'sofa' : 'habit'))!;
      this.move(state, actor, home, object.anchor, object.id, kind === 'rest' ? 'resting' : 'habit');
      actor.manualActivityUntil = this.virtualFor(state, state.cursor) + 30 * 60000;
      actor.manualArtAction = kind === 'study' ? 'standingRead' : kind === 'leisure' ? 'think' : undefined;
      this.event(state, { kind: 'life_activity', actorId: actor.companionId, sceneId: actor.sceneId, text: '开始前往' + object.name + '进行' + kind }); this.syncOccupancy(state); this.save(state);
    });
  }
  private performTool(scope: CompanionWorldScope, args: CompanionWorldArguments, sourceMessageId?: string): CompanionWorldSnapshot {
    this.requireScope(scope); this.advance(); const state = this.load(), actor = state.actors.find(actor => actor.companionId === scope.companionId)!;
    if (sourceMessageId && !this.visibleSources(scope, [sourceMessageId]).length) throw new Error('世界行为的消息来源不可见。');
    if (args.action === 'inspect') return this.snapshotValue(state, Date.now(), scope);
    if (['move', 'visit', 'interact', 'leave'].includes(args.action) && state.works.some(work => work.companionId === actor.companionId && work.status !== 'ended')) {
      actor.afterWork = { scope, args, sourceMessageId };
      this.event(state, { kind: 'deferred_movement', actorId: actor.companionId, text: '已记录意图，完成当前电脑工作后再行动', sourceMessageId, conversationId: scope.conversationId });
      this.save(state); return this.snapshotValue(state, Date.now(), scope);
    }
    const scenes = this.scenes(state);
    if (args.action === 'move') {
      const scene = scenes.find(scene => scene.id === args.destinationId || scene.objects.some(object => object.id === args.destinationId));
      if (!scene) throw new Error('地点不存在。'); const object = scene.objects.find(object => object.id === args.destinationId);
      this.move(state, actor, scene, object?.anchor ?? scene.door, args.destinationId, 'idle');
    } else if (args.action === 'interact') {
      const scene = scenes.find(scene => scene.id === actor.sceneId)!, object = scene.objects.find(object => object.id === args.furnitureId);
      if (!object || !this.permitted(state, actor.companionId, scene.ownerId ?? actor.companionId) || Math.hypot(actor.position.x - object.anchor.x, actor.position.y - object.anchor.y) > .2 || actor.route.length) throw new Error('需要先走到有权使用的家具旁。');
      if (object.reservedBy && object.reservedBy !== actor.companionId) throw new Error('家具已被其他伙伴预约。');
      const permitted = args.interaction === 'stand' || args.interaction === 'sit' && ['chair', 'sofa', 'bench', 'dining'].includes(object.kind) || args.interaction === 'sleep' && object.kind === 'bed' || args.interaction === 'eat' && ['kitchen', 'dining'].includes(object.kind) || args.interaction === 'rest' && ['sofa', 'bed', 'bench'].includes(object.kind) || args.interaction === 'study' && ['desk', 'habit'].includes(object.kind) || args.interaction === 'use' && ['computer', 'kitchen', 'habit'].includes(object.kind);
      if (!permitted) throw new Error('该家具不支持这种动作。');
      const activity = args.interaction === 'stand' ? 'idle' : args.interaction === 'sleep' ? 'sleeping' : args.interaction === 'eat' ? 'eating' : args.interaction === 'rest' ? 'resting' : args.interaction === 'study' || args.interaction === 'use' && object.kind === 'kitchen' ? 'habit' : 'sitting';
      actor.furnitureId = object.id; this.enterFurniture(actor, activity, state.cursor);
      actor.manualActivityUntil = this.virtualFor(state, state.cursor) + (activity === 'sleeping' ? 30 : activity === 'habit' ? 30 : activity === 'idle' ? 1 : 15) * 60000;
      actor.manualArtAction = args.interaction === 'study' ? 'read' : args.interaction === 'use' && object.kind === 'kitchen' ? 'cook' : undefined;
      this.event(state, { kind: 'interact', actorId: actor.companionId, sceneId: scene.id, text: args.interaction + ' ' + object.name, sourceMessageId, conversationId: scope.conversationId });
    } else if (args.action === 'visit') {
      if (!state.actors.some(item => item.companionId === args.targetCompanionId) || args.targetCompanionId === actor.companionId) throw new Error('拜访对象无效。');
      const playerRequested = !!sourceMessageId && this.visibleSources(scope, [sourceMessageId])[0]?.authorId === 'user';
      if (!playerRequested && !row(this.db.prepare("SELECT json_extract(data,'$.proactive') AS proactive FROM companions WHERE id=?").get(actor.companionId)).proactive && !this.social?.continuity.hasDelegationTo(actor.companionId, args.targetCompanionId)) throw new Error('伙伴未开启主动联系，也没有对应的真实委托，不能自行发起拜访。');
      const pending = state.visits.find(visit => visit.guestId === actor.companionId && visit.hostId === args.targetCompanionId && ['requested', 'allowed'].includes(visit.status));
      if (!pending) { state.visits.push({ id: randomUUID(), guestId: actor.companionId, hostId: args.targetCompanionId, reason: args.reason, status: 'requested', createdAt: iso(this.virtualFor(state, state.cursor)), expiresAt: iso(this.virtualFor(state, state.cursor) + 6 * 3600000), sourceMessageId, conversationId: scope.conversationId });
        this.event(state, { kind: 'visit_request', actorId: actor.companionId, targetId: args.targetCompanionId, text: args.reason, sourceMessageId, conversationId: scope.conversationId }); this.queueJob(state, args.targetCompanionId, 'decision'); }
      const home = scenes.find(scene => scene.ownerId === args.targetCompanionId)!, commons = scenes[0]!;
      this.move(state, actor, commons, { x: home.origin.x + 10, y: home.origin.y + 16 }, args.targetCompanionId + '_entrance', 'idle');
    } else if (args.action === 'respond') {
      const visit = state.visits.find(visit => visit.id === args.requestId && visit.hostId === actor.companionId && visit.status === 'requested'); if (!visit) throw new Error('只有房主可回应待处理的拜访。');
      visit.status = args.decision === 'allow' ? 'allowed' : 'denied'; visit.response = args.reason;
      visit.responseSourceMessageId = sourceMessageId; visit.responseConversationId = scope.conversationId;
      this.event(state, { kind: 'visit_response', actorId: actor.companionId, targetId: visit.guestId, text: args.reason, sourceMessageId, conversationId: scope.conversationId });
      if (visit.status === 'allowed') { const guest = state.actors.find(item => item.companionId === visit.guestId)!; guest.pendingVisitId = visit.id; this.planRoutine(state, guest); }
    } else if (args.action === 'leave') {
      for (const visit of state.visits) if (visit.guestId === actor.companionId && ['allowed', 'requested'].includes(visit.status)) visit.status = 'left';
      delete actor.pendingVisitId;
      const home = scenes.find(scene => scene.id === actor.homeSceneId)!;
      this.move(state, actor, home, { x: 10, y: 12 }, home.id, 'idle');
      this.event(state, { kind: 'visit_leave', actorId: actor.companionId, text: '结束拜访，步行返回自己的小屋', sourceMessageId, conversationId: scope.conversationId });
    } else if (args.action === 'social') {
      const peer = state.actors.find(item => item.companionId === args.targetCompanionId);
      if (!peer || peer.companionId === actor.companionId || peer.sceneId !== actor.sceneId || Math.hypot(peer.position.x - actor.position.x, peer.position.y - actor.position.y) > 5) throw new Error('对方不在可交谈的现场范围内。');
      if (!this.social) throw new Error('社交存储尚未连接。');
      const room = this.social.ensure(actor.companionId, [actor.companionId, peer.companionId]);
      this.social.send({ companionId: actor.companionId, conversationId: room.id, content: args.text, channel: 'face_to_face', clientId: randomUUID() });
      return this.snapshotValue(this.load(), Date.now(), scope);
    } else if (args.action === 'message') {
      if (!this.social) throw new Error('社交存储尚未连接。');
      const room = this.social.ensure(actor.companionId, [actor.companionId, ...args.recipientIds]);
      this.social.send({ companionId: actor.companionId, conversationId: room.id, content: args.text, channel: 'phone', clientId: randomUUID() });
      return this.snapshotValue(this.load(), Date.now(), scope);
    }
    this.syncOccupancy(state); this.save(state); return this.snapshotValue(state, Date.now(), scope);
  }
  private claim(kind: CompanionWorldJob['kind']): CompanionWorldJob | undefined {
    const claimAt = Date.now(); this.advance(claimAt); return this.db.transaction(() => {
      const candidates = this.db.prepare("SELECT * FROM companion_world_jobs WHERE kind=? AND (status='pending' OR status IN ('running','failed') AND lease_until<?) ORDER BY rowid").all(kind, iso()) as Row[];
      const state = this.load();
      if (state.cursor < claimAt) return undefined;
      const found = candidates.find(candidate => {
        const owner = String(candidate.companion_id), actor = state.actors.find(actor => actor.companionId === owner);
        const busy = state.works.some(work => work.companionId === owner && work.status !== 'ended');
        return actor && !busy && (kind === 'dream' ? actor.activity === 'sleeping' && !actor.route.length && state.cursor - Date.parse(actor.activityStartedAtReal) >= 5000 : actor.routinePhase === 'awake');
      }); if (!found) return undefined;
      const job = parse<StoredJob>(row(found).data); job.status = 'running'; job.leaseToken = randomUUID(); job.attempts++;
      if (kind === 'dream') { job.memoryVersions = this.unseenAtoms(job.companionId, 20); job.sourceMemoryIds = job.memoryVersions.map(memory => memory.id);
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
      const scope = { companionId: job.companionId, conversationId: job.conversationId };
      for (const read of job.readSet ?? []) {
        const saved = this.db.prepare('SELECT data FROM companion_world_events WHERE id=?').get(read.eventId), event = saved ? parse<StoredEvent>(row(saved).data) : undefined;
        if (!event || !this.visibleEvent(event, scope) || createHash('sha256').update(JSON.stringify(event)).digest('hex') !== read.checksum) throw new Error('世界决策读过的来源已撤回或变化，请重新观察。');
        if (read.sourceChecksum && event.sourceMessageId) { const source = this.db.prepare('SELECT content,revision FROM messages WHERE id=?').get(event.sourceMessageId);
          if (!source || Number(row(source).revision) !== read.sourceRevision || createHash('sha256').update(String(row(source).content)).digest('hex') !== read.sourceChecksum) throw new Error('世界决策的发言来源已经变化。'); }
      }
      if (command.action) this.tool(scope, command.action);
      const state = this.load();
      const memoryIds = [...new Set([...(command.sourceMemoryIds ?? []), ...(command.dream?.relatedMemoryIds ?? [])])];
      if (job.kind === 'dream') {
        if (memoryIds.some(id => !job.sourceMemoryIds.includes(id)) || job.memoryVersions?.some(memory => !this.db.prepare("SELECT 1 FROM memory_records WHERE memory_id=? AND version=? AND status='active'").get(memory.id, memory.version))) throw new Error('本次待整理记忆已经变化。');
        const sleeper = state.actors.find(actor => actor.companionId === job.companionId);
        if (!sleeper || sleeper.activity !== 'sleeping' || sleeper.route.length || state.works.some(work => work.companionId === job.companionId && work.status !== 'ended')) throw new Error('伙伴已经醒来，本次睡眠回顾已停止。');
        if (memoryIds.some(id => !this.db.prepare("SELECT 1 FROM memory_records WHERE memory_id=? AND companion_id=? AND status='active'").get(id, job.companionId))) throw new Error('梦的记忆依赖已失效。');
      }
      for (const candidate of command.memoryCandidates ?? []) {
        if (job.kind !== 'dream' || !['overview', 'knowledge', 'reflection', 'hypothesis'].includes(candidate.kind) || !candidate.relatedMemoryIds?.length || candidate.relatedMemoryIds.some(id => !memoryIds.includes(id))) throw new Error('睡眠整理只能基于本次真实原子记忆形成可追溯回顾。');
        this.recordMemory(scope, candidate);
      }
      if (command.dream) {
        if (job.kind !== 'dream') throw new Error('清醒决策不能伪造梦。');
        const dream = command.dream, sources = this.visibleSources(scope, dream.sourceMessageIds);
        if (sources.length !== dream.sourceMessageIds.length || dream.sourceMessageIds.some(id => !dream.evidence.some(evidence => evidence.sourceMessageId === id && sources.find(source => source.id === id)?.content.includes(evidence.quote))) ||
          dream.evidence.some(evidence => !sources.some(source => source.id === evidence.sourceMessageId && source.content.includes(evidence.quote)))) throw new Error('梦的回顾来源已失效。');
        this.event(state, { kind: 'dream', actorId: job.companionId, privateOwner: job.companionId, conversationId: scope.conversationId,
          text: dream.text, sourceMessageIds: dream.sourceMessageIds, sourceMemoryIds: memoryIds, memoryVersions: memoryIds.map(id => ({ id, version: Number(row(this.db.prepare('SELECT version FROM memory_records WHERE memory_id=?').get(id)).version) })), evidence: dream.evidence });
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
      if (job.kind === 'dream') { for (const memory of job.memoryVersions ?? []) this.db.prepare('INSERT OR IGNORE INTO companion_world_dream_watermark(companion_id,memory_id,version,processed_at) VALUES(?,?,?,?)').run(job.companionId, memory.id, memory.version, iso()); this.unseenCache.delete(job.companionId); }
      job.status = 'done'; this.db.prepare("UPDATE companion_world_jobs SET status='done',lease_until=NULL,data=? WHERE id=?").run(JSON.stringify(job), job.id); this.save(state); this.flushEffects();
    });
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'world.clock': return { ok: true, worldClock: this.clock(command.since) };
      case 'world.snapshot': return { ok: true, world: this.tick() };
      case 'world.observe': return { ok: true, world: this.snapshot(command) };
      case 'world.tick': { const now = command.now ? Date.parse(command.now) : Date.now(); this.advance(now); return { ok: true, ...(command.snapshot ? { world: this.snapshotValue(this.load(), now) } : {}) }; }
      case 'world.attention.record': this.recordAttention(command); return { ok: true };
      case 'world.configure': return { ok: true, world: this.configure(command.expectedRevision, command.patch) };
      case 'world.tool': return { ok: true, world: this.tool(command, command.arguments, command.sourceMessageId) };
      case 'world.work.begin': return { ok: true, worldWork: this.begin(command, command.workId, command.kind, command.sourceMessageId, command.urgent, command.fixed) };
      case 'world.work.ready': return { ok: true, worldWork: this.ready(command.companionId, command.workId) };
      case 'world.work.end': return { ok: true, worldWork: this.end(command.companionId, command.workId) };
      case 'world.job.claim': return { ok: true, worldJob: this.claim(command.kind) };
      case 'world.job.complete': this.complete(command); return { ok: true };
      case 'world.job.fail': {
        const found = this.db.prepare('SELECT data FROM companion_world_jobs WHERE id=?').get(command.id); if (!found) throw new Error('世界任务不存在。'); const job = parse<CompanionWorldJob>(row(found).data);
        if (job.status !== 'running' || job.leaseToken !== command.leaseToken) throw new Error('世界任务租约已失效。'); job.status = 'failed';
        this.db.prepare("UPDATE companion_world_jobs SET status='failed',lease_until=?,data=? WHERE id=?").run(iso(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 6))), JSON.stringify(job), job.id); return { ok: true };
      }
      default: return undefined;
    }
  }
}
