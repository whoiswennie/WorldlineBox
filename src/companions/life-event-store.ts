import { createHash, randomUUID } from 'node:crypto';
import { companionTaskCanClaim } from './task-concurrency-store';
import { companionCivilInstantInZone, companionTimeInZone } from '../shared/companion-schedule-time';
import { companionLifeHazard, companionLifeMultiplier, companionLifeRuleDraftSchema, companionLifeThreshold,
  companionLifeRhythm,
  type CompanionLifeOccurrence, type CompanionLifeRule } from '../shared/companion-life-event';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionWorldSnapshot } from '../shared/companion-world';
import type { CompanionWorldPerception } from '../shared/companion-world-perception';
import type { CompanionConnection } from './store';
import type { CompanionExecutionReadset } from '../shared/companion-execution-evidence';

type Row = { data: string };
type LifeOptions = { world(): CompanionWorldSnapshot; perception(id: string): CompanionWorldPerception | undefined; elapsed(from: number, to: number): number;
  acquaintances(id: string): ReadonlySet<string>;
  perform(occurrence: CompanionLifeOccurrence, text?: string): string;
  memoryRevision?(scope: { companionId: string; conversationId: string }): string;
  readsetValid?(scope: { companionId: string; conversationId: string }, proof: CompanionExecutionReadset): boolean };
const iso = (at = Date.now()) => new Date(at).toISOString();
const read = <T>(row: unknown): T => JSON.parse((row as Row).data) as T;

/** A durable exponential clock per rule/civil window. No frame-rate lottery. */
export class CompanionLifeEventStore {
  constructor(private readonly db: CompanionConnection, private readonly options: LifeOptions) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_life_rules(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),enabled INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_life_rule_owner ON companion_life_rules(companion_id,enabled);
      CREATE TABLE IF NOT EXISTS companion_life_occurrences(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),rule_id TEXT NOT NULL REFERENCES companion_life_rules(id),window_start TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,data TEXT NOT NULL,UNIQUE(rule_id,window_start));
      CREATE INDEX IF NOT EXISTS companion_life_pending ON companion_life_occurrences(status,lease_until);
      CREATE INDEX IF NOT EXISTS companion_life_owner ON companion_life_occurrences(companion_id,window_start DESC);`);
  }
  private owner(id: string): { proactive: boolean } {
    const row = this.db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row || this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(id)) throw new Error('伙伴不存在或正在重置。');
    return read(row);
  }
  private rules(companionId: string): CompanionLifeRule[] { return this.db.prepare("SELECT data FROM companion_life_rules r WHERE companion_id=? AND NOT EXISTS(SELECT 1 FROM metadata m WHERE m.key='life-rule-removed/'||r.id) ORDER BY id").all(companionId).map(row => read<CompanionLifeRule>(row)); }
  private save(occ: CompanionLifeOccurrence): void {
    this.db.prepare('INSERT INTO companion_life_occurrences(id,companion_id,rule_id,window_start,status,lease_until,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,lease_until=excluded.lease_until,data=excluded.data')
      .run(occ.id, occ.companionId, occ.ruleId, occ.windowStart, occ.status, occ.leaseUntil ?? null, JSON.stringify(occ));
  }
  /** Called only by the physical host, inside its state transition transaction. */
  completePhysical(id: string, companionId: string, outcome: 'done' | 'cancelled', result: string): void {
    const found = this.db.prepare('SELECT data FROM companion_life_occurrences WHERE id=? AND companion_id=?').get(id, companionId);
    if (!found) return;
    const occurrence = read<CompanionLifeOccurrence>(found);
    if (occurrence.status !== 'active' || occurrence.rule.action !== 'park_walk') return;
    occurrence.status = outcome; occurrence.result = result.slice(0, 4000); this.save(occurrence);
  }
  private rule(id: string, companionId: string, revision: number): CompanionLifeRule {
    this.owner(companionId); const row = this.db.prepare("SELECT data FROM companion_life_rules WHERE id=? AND companion_id=? AND NOT EXISTS(SELECT 1 FROM metadata WHERE key='life-rule-removed/'||?)").get(id, companionId, id);
    if (!row) throw new Error('生活事件不存在。');
    const rule = read<CompanionLifeRule>(row); if (rule.revision !== revision) throw new Error('生活事件已经更新，请重新读取。'); return rule;
  }
  private defaults(companionId: string): void {
    // Explicit user removals are persistent; an empty rule list never reseeds.
    const key = 'life-rules-initialized/' + companionId;
    if (!this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key)) {
      const routineRow = this.db.prepare('SELECT data FROM companion_routines WHERE companion_id=?').get(companionId);
      const routine = routineRow ? read<{ config: { wakeAt: string; sleepAt: string } }>(routineRow).config : { wakeAt: '07:00', sleepAt: '23:00' };
      const minute = (value: string) => value.split(':').reduce((hours, part) => hours * 60 + Number(part), 0);
      const awakeMinutes = (minute(routine.sleepAt) - minute(routine.wakeAt) + 1440) % 1440;
      // Use the owner's actual routine. Persona and current state decide what
      // to say (or to remain silent); no random invented personality template.
      this.create(companionId, { title: '闲暇时联系朋友', startMinute: (minute(routine.wakeAt) + Math.min(120, Math.floor(awakeMinutes / 4))) % 1440,
        endMinute: (minute(routine.sleepAt) + 1440 - Math.min(60, Math.floor(awakeMinutes / 4))) % 1440, probability: .45, action: 'message',
        checkIntervalMinutes: 15, actionCooldownMinutes: 90, silenceCooldownMinutes: 20, failureCooldownMinutes: 30 });
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, 'true');
    }
    const parkKey = 'life-park-walk-initialized/' + companionId;
    if (!this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(parkKey) && this.rules(companionId).length < 16) {
      this.create(companionId, { title: '去公园散步放松', startMinute: 15 * 60, endMinute: 18 * 60, probability: .55, action: 'park_walk', durationMinutes: 35 });
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(parkKey, 'true');
    }
  }
  private create(companionId: string, draft: unknown, clientId?: string): CompanionLifeRule {
    this.owner(companionId);
    const value = companionLifeRuleDraftSchema.parse(draft);
    const key = clientId ? 'life-create/' + companionId + '/' + clientId : undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const prior = key ? this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined : undefined;
    if (prior) {
      const record = JSON.parse(prior.value) as { ruleId: string; fingerprint: string };
      if (record.fingerprint !== fingerprint) throw new Error('生活事件重试标识已被其它内容使用。');
      const saved = this.db.prepare('SELECT data FROM companion_life_rules WHERE id=? AND companion_id=?').get(record.ruleId, companionId);
      if (!saved) throw new Error('这次生活事件创建已经被撤回。'); return read<CompanionLifeRule>(saved);
    }
    if (this.rules(companionId).length >= 16) throw new Error('每位伙伴最多设置16个生活事件。');
    if (value.targetId && value.targetId !== 'user') this.owner(value.targetId);
    if (value.targetId === companionId) throw new Error('交流或拜访目标不能是自己。');
    const rule = { ...value, id: randomUUID(), companionId, revision: 1, createdAt: iso() };
    this.db.prepare('INSERT INTO companion_life_rules(id,companion_id,enabled,data) VALUES(?,?,?,?)').run(rule.id, companionId, +rule.enabled, JSON.stringify(rule));
    if (key) this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify({ companionId, ruleId: rule.id, fingerprint })); return rule;
  }
  private available(world: CompanionWorldSnapshot, id: string): boolean {
    const actor = world.actors.find(actor => actor.companionId === id);
    return this.activated(id) && !!actor && !actor.parkWalk && !['sleeping', 'eating'].includes(actor.routinePhase) && !['working', 'eating', 'sleeping', 'lyingDown', 'waking', 'seating', 'standingUp'].includes(actor.activity)
      && !world.works.some(work => work.companionId === id && work.kind !== 'chat' && work.status !== 'ended');
  }
  private activated(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companions c WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1 AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").get(id);
  }
  private targetActivated(rule: CompanionLifeRule, targetId?: string): boolean {
    return !['message', 'visit'].includes(rule.action) || targetId === 'user' || !!targetId && this.activated(targetId);
  }
  private multiplier(world: CompanionWorldSnapshot, rule: CompanionLifeRule, targetId?: string): number {
    const actor = world.actors.find(actor => actor.companionId === rule.companionId);
    if (!actor || !this.targetActivated(rule, targetId)) return 0;
    const perception = this.options.perception(rule.companionId), seenTarget = perception?.people.find(person => person.companionId === targetId && person.visible);
    // A distant friend's attention is unknown. Message delivery, rather than a
    // telepathic probability gate, handles their actual sleeping/working state.
    const targetAvailable = !seenTarget || !['working', 'eating', 'sleeping', 'lyingDown', 'waking'].includes(seenTarget.activity);
    const weather = perception?.environment.weather, temperature = perception?.environment.temperature;
    const input = { energy: actor.state.energy,
      action: rule.action, available: this.available(world, rule.companionId) && targetAvailable,
      weather, outdoorTemperature: temperature };
    if (rule.action !== 'park_walk') return companionLifeMultiplier(input);
    const observedAt = perception?.environment.weatherObservedAtVirtual, observedReal = perception?.environment.weatherObservedAtReal;
    const freshness = weather !== undefined && observedAt && observedReal && Date.parse(observedAt) <= Date.parse(world.clock.virtualNow)
      ? Math.exp(-Math.max(0, this.options.elapsed(Date.parse(observedReal), Date.parse(world.clock.realNow))) / 1800000) : 0;
    // Old rain is evidence with fading reliability, not an eternal veto. The
    // remaining uncertainty allows a cautious attempt to step out and observe.
    return freshness * companionLifeMultiplier(input) + (1 - freshness) * .4 * companionLifeMultiplier({ ...input, weather: undefined });
  }
  private chooseTarget(world: CompanionWorldSnapshot, rule: CompanionLifeRule, key: string): string | undefined {
    if (rule.targetId || !['message', 'visit'].includes(rule.action)) return rule.targetId;
    const known = this.options.acquaintances(rule.companionId);
    const peers = world.residents.filter(peer => known.has(peer.companionId) && peer.active !== false && this.activated(peer.companionId)).sort((a, b) => a.companionId.localeCompare(b.companionId));
    // Equal opportunity among known available people. The owner makes the
    // actual social choice; no hidden friendship weighting is introduced.
    return peers.map(peer => ({ id: peer.companionId, score: companionLifeThreshold(key + '/' + peer.companionId) }))
      .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))[0]?.id;
  }
  private observe(world: CompanionWorldSnapshot): void {
    const real = Date.parse(world.clock.realNow), now = Date.parse(world.clock.virtualNow);
    for (const resident of world.residents) {
      if (resident.active === false) continue;
      try { this.defaults(resident.companionId); } catch { continue; }
      const allowed = this.owner(resident.companionId).proactive;
      for (const rule of this.rules(resident.companionId)) {
        const window = lifeWindow(now, rule.startMinute, rule.endMinute, world.settings.timeZone);
        if (!window) continue;
        const rhythm = companionLifeRhythm(rule), checkMs = rhythm.checkIntervalMinutes * 60000;
        const found = this.db.prepare('SELECT data FROM companion_life_occurrences WHERE rule_id=? AND window_start>=? AND window_start<? ORDER BY window_start DESC LIMIT 1')
          .get(rule.id, iso(window.start), iso(window.end));
        const previousOccurrence = found ? read<CompanionLifeOccurrence>(found) : undefined;
        if (!previousOccurrence) {
          const prior = this.db.prepare('SELECT data FROM companion_life_occurrences WHERE rule_id=? ORDER BY window_start DESC LIMIT 1').get(rule.id);
          const recent = prior ? read<CompanionLifeOccurrence>(prior) : undefined;
          // A civil midnight must not erase the preceding action's cooldown.
          if (recent && (recent.status === 'active' || recent.nextEligibleAt && now < Date.parse(recent.nextEligibleAt))) continue;
        }
        if (previousOccurrence && previousOccurrence.status !== 'observing') {
          if (['pending', 'running', 'active'].includes(previousOccurrence.status)
            || now < Date.parse(previousOccurrence.nextEligibleAt ?? iso(window.end))) continue;
        }
        const start = previousOccurrence && previousOccurrence.status !== 'observing' ? iso(now) : iso(window.start);
        const occurrence: CompanionLifeOccurrence = previousOccurrence?.status === 'observing' ? previousOccurrence : { id: randomUUID(), companionId: rule.companionId, ruleId: rule.id, rule,
          windowStart: start, windowEnd: iso(window.end), status: 'observing', hazard: 0, threshold: companionLifeThreshold(rule.id + '/' + start),
          lastRealAt: iso(real), lastEvaluatedAt: iso(now), multiplier: 0, attempts: 0, targetId: this.chooseTarget(world, rule, rule.id + '/' + start) };
        if (occurrence.status !== 'observing') continue;
        if (!rule.targetId && ['message', 'visit'].includes(rule.action) && (!occurrence.targetId || !this.activated(occurrence.targetId))) {
          const targetId = this.chooseTarget(world, rule, rule.id + '/' + start);
          if (targetId !== occurrence.targetId) { occurrence.targetId = targetId; occurrence.hazard = 0; }
        }
        const previous = Date.parse(occurrence.lastRealAt);
        // A long unobserved offline gap has unknown intermediate availability.
        // Do not invent old social activity, or emit months of delayed greetings.
        const elapsed = real - previous <= 120000 ? Math.min(this.options.elapsed(previous, real), Math.max(0, now - window.start)) : 0;
        occurrence.multiplier = allowed && rule.enabled && this.socialCooldownReady(world, occurrence) ? this.multiplier(world, rule, occurrence.targetId) : 0;
        occurrence.hazard += companionLifeHazard(rule.probability, checkMs, elapsed, occurrence.multiplier);
        occurrence.lastRealAt = iso(real);
        if (now - Date.parse(occurrence.lastEvaluatedAt ?? occurrence.windowStart) >= checkMs) {
          occurrence.lastEvaluatedAt = iso(now);
          if (occurrence.hazard >= occurrence.threshold && occurrence.multiplier > 0 && (!['message', 'visit'].includes(rule.action) || occurrence.targetId)) occurrence.status = 'pending';
        }
        this.save(occurrence);
      }
    }
    for (const row of this.db.prepare("SELECT data FROM companion_life_occurrences WHERE status IN ('observing','pending','running')").all()) {
      const occ = read<CompanionLifeOccurrence>(row);
      if (Date.parse(occ.windowEnd) <= now || now < Date.parse(occ.windowStart)) { occ.status = 'expired'; occ.reason = '世界时间已经离开这个窗口，不补发过期事件。'; occ.leaseToken = undefined; occ.leaseUntil = undefined; this.save(occ); }
    }
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!command.type.startsWith('life-rule.') && !command.type.startsWith('life-event.')) return;
    return this.db.transaction(() => {
      if (command.type === 'life-rule.list') {
        this.owner(command.companionId); this.defaults(command.companionId);
        return { ok: true, lifeRules: this.rules(command.companionId), lifeOccurrences: this.db.prepare('SELECT data FROM companion_life_occurrences WHERE companion_id=? ORDER BY window_start DESC,id DESC LIMIT 100').all(command.companionId).map(row => read<CompanionLifeOccurrence>(row)) };
      }
      if (command.type === 'life-rule.create') return { ok: true, lifeRule: this.create(command.companionId, command.rule, command.clientId) };
      if (command.type === 'life-rule.update' || command.type === 'life-rule.remove') {
        const old = this.rule(command.id, command.companionId, command.expectedRevision);
        const next = command.type === 'life-rule.remove' ? { ...old, enabled: false, revision: old.revision + 1 }
          : { ...old, ...companionLifeRuleDraftSchema.parse(command.rule), revision: old.revision + 1 };
        if (next.targetId && next.targetId !== 'user') this.owner(next.targetId);
        this.db.prepare('UPDATE companion_life_rules SET enabled=?,data=? WHERE id=?').run(+next.enabled, JSON.stringify(next), next.id);
        if (command.type === 'life-rule.remove') this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('life-rule-removed/' + next.id, JSON.stringify({ companionId: next.companionId }));
        for (const row of this.db.prepare("SELECT data FROM companion_life_occurrences WHERE rule_id=? AND status IN ('observing','pending','running')").all(next.id)) {
          const occ = read<CompanionLifeOccurrence>(row); occ.status = 'cancelled'; occ.reason = '规则已修改，旧结果不再提交。';
          occ.nextEligibleAt = iso(Date.parse(this.options.world().clock.virtualNow) + companionLifeRhythm(next).checkIntervalMinutes * 60000);
          occ.leaseToken = undefined; occ.leaseUntil = undefined; this.save(occ);
        }
        return { ok: true, lifeRule: next };
      }
      const world = this.options.world(); if (world.backlog) return { ok: true };
      this.observe(world);
      if (command.type === 'life-event.claim') {
        for (const row of this.db.prepare("SELECT data FROM companion_life_occurrences WHERE status='pending' OR (status='running' AND lease_until<=?) ORDER BY window_start,id LIMIT 100").all(iso())) {
          const occ = read<CompanionLifeOccurrence>(row);
          if (command.excludedCompanionIds?.includes(occ.companionId)) continue;
          try { if (!this.owner(occ.companionId).proactive || !this.ownerRuleEnabled(occ.ruleId) || !this.available(world, occ.companionId)
            || !this.targetActivated(occ.rule, occ.targetId) || !this.socialCooldownReady(world, occ)) continue; } catch { continue; }
          if (!companionTaskCanClaim(this.db, occ.companionId, { kind: 'life', id: occ.id })) continue;
          occ.status = 'running'; occ.leaseToken = randomUUID(); occ.leaseUntil = iso(Date.now() + 120000); occ.attempts++; this.save(occ);
          return { ok: true, lifeOccurrence: occ };
        }
        return { ok: true };
      }
      if (command.type === 'life-event.complete' || command.type === 'life-event.fail') {
        const found = this.db.prepare('SELECT data FROM companion_life_occurrences WHERE id=?').get(command.id);
        if (!found) throw new Error('生活事件不存在。'); const occ = read<CompanionLifeOccurrence>(found); this.owner(occ.companionId);
        if (occ.status === 'done' || occ.status === 'active' || occ.status === 'silent') return { ok: true, lifeOccurrence: occ };
        if (occ.status !== 'running' || occ.leaseToken !== command.leaseToken || Date.parse(occ.leaseUntil!) <= Date.now()) throw new Error('生活事件租约已经失效。');
        if (command.type === 'life-event.complete') {
          if (command.executionReadset && !this.options.readsetValid?.({ companionId: occ.companionId, conversationId: 'world_' + occ.companionId }, command.executionReadset))
            throw new Error('这次生活发言实际使用的来源已撤回或不可访问。');
          // Compatibility for old callers only. A typed frozen task proof is
          // independent of unrelated corpus additions or ordinary edits.
          if (!command.executionReadset && command.expectedMemoryRevision !== undefined
            && this.options.memoryRevision?.({ companionId: occ.companionId, conversationId: 'world_' + occ.companionId }) !== command.expectedMemoryRevision)
            throw new Error('这次生活发言使用的旧回忆已经变化。');
          if (!this.owner(occ.companionId).proactive || !this.ownerRuleEnabled(occ.ruleId) || !this.available(world, occ.companionId)
            || !this.targetActivated(occ.rule, occ.targetId) || !this.socialCooldownReady(world, occ)) throw new Error('伙伴此刻无法发起这个生活事件，联系双方需要保持激活。');
          if (command.silent) {
            if (!['message', 'visit'].includes(occ.rule.action) || command.text?.trim()) throw new Error('沉默结果不能同时发言或执行动作。');
            occ.status = 'silent'; occ.reason = command.reason ?? '这次没有想分享的新内容，继续自己的生活。';
          } else {
            if (['message', 'visit'].includes(occ.rule.action) && !command.text?.trim()) throw new Error('交流事件需要伙伴自己的真实发言。');
            occ.result = this.options.perform(occ, command.text); occ.status = occ.rule.action === 'park_walk' ? 'active' : 'done';
          }
        } else { occ.reason = command.error; occ.status = 'failed'; }
        const rhythm = companionLifeRhythm(occ.rule);
        const cooldown = occ.status === 'silent' ? rhythm.silenceCooldownMinutes : occ.status === 'failed' ? rhythm.failureCooldownMinutes : rhythm.actionCooldownMinutes;
        occ.settledAt = world.clock.virtualNow; occ.nextEligibleAt = iso(Date.parse(occ.settledAt) + cooldown * 60000);
        occ.leaseToken = undefined; occ.leaseUntil = undefined; this.save(occ); return { ok: true, lifeOccurrence: occ };
      }
      return { ok: true };
    }).immediate();
  }
  private ownerRuleEnabled(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM companion_life_rules WHERE id=? AND enabled=1').get(id); }
  private socialCooldownReady(world: CompanionWorldSnapshot, occurrence: CompanionLifeOccurrence): boolean {
    if (!['message', 'visit'].includes(occurrence.rule.action)) return true;
    const found = this.db.prepare("SELECT data FROM companion_life_occurrences WHERE companion_id=? AND status='done' AND json_extract(data,'$.rule.action') IN('message','visit') ORDER BY COALESCE(json_extract(data,'$.settledAt'),window_start) DESC LIMIT 1").get(occurrence.companionId);
    if (!found) return true;
    const previous = read<CompanionLifeOccurrence>(found);
    // Multiple rules cannot bypass an owner's contact budget. Human contact is
    // opt-in per rule and spaced more widely than peer conversations.
    const minimum = occurrence.targetId === 'user' || previous.targetId === 'user' ? 120 : 20;
    return Date.parse(world.clock.virtualNow) - Date.parse(previous.settledAt ?? previous.windowStart) >= minimum * 60000;
  }
}

export function lifeWindow(now: number, startMinute: number, endMinute: number, zone: string): { start: number; end: number } | undefined {
  const current = companionTimeInZone(now, zone), midnight = Date.UTC(current.year, current.month - 1, current.day);
  for (const delta of [-1, 0]) {
    const date = new Date(midnight + delta * 86400000), next = new Date(midnight + (delta + (endMinute <= startMinute ? 1 : 0)) * 86400000);
    const make = (day: Date, minute: number) => companionCivilInstantInZone({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 }, zone, 'next_valid');
    const start = make(date, startMinute), end = endMinute === 1440 ? make(new Date(next.getTime() + 86400000), 0) : make(next, endMinute);
    if (start !== undefined && end !== undefined && start <= now && now < end) return { start, end };
  }
  return;
}
