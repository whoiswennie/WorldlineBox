import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { botWorldActorSchema, botWorldCommandSchema, botWorldEventSchema, botWorldSceneSchema,
  type BotWorldActor, type BotWorldCommand, type BotWorldEvent, type BotWorldReceipt, type BotWorldScope, type BotWorldSnapshot } from '../../shared/companion-bot-world';
import { advanceWorldActor, createWorldHome, createWorldPark, findWorldPath, WORLD_WALK_TILES_PER_SECOND } from '../../shared/world-physics';
import type { BotStore } from './store';

const stateKey = 'world:physical:v2';
const stateSchema = z.object({ revision: z.number().int().positive(), updatedAt: z.number().finite(), scenes: z.array(botWorldSceneSchema).max(1025),
  actors: z.array(botWorldActorSchema).max(1024), events: z.array(botWorldEventSchema).max(64), pendingEvents: z.array(botWorldEventSchema).max(256) });
type State = z.infer<typeof stateSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const actions = { sit: 'sitting', sleep: 'sleeping', rest: 'resting', work: 'working', eat: 'eating', read: 'reading' } as const;
const supports: Record<keyof typeof actions, string[]> = { sit: ['chair', 'sofa', 'bench'], sleep: ['bed'], rest: ['sofa', 'bed', 'bench'],
  work: ['computer', 'desk'], eat: ['dining'], read: ['desk', 'chair', 'sofa', 'bench'] };
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) <= .01;

/** Physical scenes are a separate domain. Memory, routines and model loops cannot mutate this snapshot directly. */
export class BotWorld {
  constructor(private readonly store: Pick<BotStore, 'getMetadata' | 'setMetadataBatch' | 'getCompanion' | 'listCompanions' | 'getConversation'>,
    private readonly clock: () => number = Date.now) {}

  observe(scope: BotWorldScope): BotWorldSnapshot {
    this.authorize(scope); const { state, changed } = this.current();
    if (changed) this.save(state);
    return this.project(state, scope.companionId);
  }
  execute(scope: BotWorldScope, raw: BotWorldCommand, effectId: string): { snapshot: BotWorldSnapshot; receipt: BotWorldReceipt; event: BotWorldEvent } {
    this.authorize(scope); const command = botWorldCommandSchema.parse(raw);
    if (!effectId.trim() || effectId.length > 500) throw new Error('世界动作效果标识无效。');
    const effectKey = `world:effect:${digest(effectId)}`, requestHash = digest(JSON.stringify({ scope, command }));
    const previous = this.store.getMetadata(effectKey);
    if (previous) {
      const saved = JSON.parse(previous) as { requestHash: string; receipt: BotWorldReceipt; event: BotWorldEvent };
      if (saved.requestHash !== requestHash) throw new Error('同一世界动作标识对应其他动作。');
      return { snapshot: this.observe(scope), receipt: saved.receipt, event: saved.event };
    }
    const { state } = this.current();
    if (command.expectedRevision !== undefined && state.revision !== command.expectedRevision) throw new Error('世界状态已变化，请重新观察后再行动。');
    const actor = state.actors.find(item => item.companionId === scope.companionId)!;
    const scene = state.scenes.find(item => item.id === actor.sceneId)!;
    let description: string, kind: BotWorldEvent['kind'] = 'move';
    if (command.operation === 'move') {
      if (command.sceneId !== actor.sceneId) throw new Error('坐标移动不能跨场景，请使用出入口旅行。');
      const route = findWorldPath(scene, actor.position, { x: command.x, y: command.y }, true);
      if (!route) throw new Error('目标位置不可到达，不能穿过家具或场景边界。');
      this.release(state, actor); actor.pending = undefined; actor.route = route;
      actor.activity = route.length ? 'walking' : 'idle'; description = `${actor.name}${route.length ? '正走向' : '已位于'}${scene.name}中的（${command.x}, ${command.y}）。`;
    } else if (command.operation === 'travel') {
      const destination = state.scenes.find(item => item.id === command.sceneId);
      if (!destination || destination.ownerId && destination.ownerId !== actor.companionId) throw new Error('没有进入该私人小屋的授权。');
      if (destination.id === scene.id) throw new Error('已经在目标场景。');
      const route = findWorldPath(scene, actor.position, scene.door, true);
      if (!route) throw new Error('无法走到当前场景出入口。');
      this.release(state, actor); actor.pending = { operation: 'travel', sceneId: destination.id }; actor.route = route; actor.activity = route.length ? 'walking' : 'idle';
      if (!route.length) this.completePending(state, actor);
      description = `${actor.name}通过出入口前往${destination.name}。`; kind = 'travel';
    } else if (command.action === 'stand') {
      this.release(state, actor); actor.pending = undefined; actor.route = []; actor.activity = 'idle'; description = `${actor.name}结束当前动作，站了起来。`; kind = 'interact';
    } else {
      const object = scene.objects.find(item => item.id === command.objectId);
      if (!object || !supports[command.action].includes(object.kind)) throw new Error('这个物件不支持所请求的动作。');
      const reserved = state.actors.find(item => item.companionId !== actor.companionId && (item.objectId === object.id
        || item.pending?.operation === 'interact' && item.pending.objectId === object.id));
      if (object.occupantId && object.occupantId !== actor.companionId || reserved) throw new Error('该物件已经被其他伙伴占用或预约。');
      const route = findWorldPath(scene, actor.position, object.anchor, true);
      if (!route) throw new Error('无法到达物件的交互位置。');
      this.release(state, actor); actor.route = route; actor.pending = { operation: 'interact', objectId: object.id, action: command.action };
      actor.activity = route.length ? 'walking' : 'idle'; if (!route.length) this.completePending(state, actor);
      description = `${actor.name}${route.length ? '正走向' : '正在使用'}${object.name}。`; kind = 'interact';
    }
    state.revision++; state.updatedAt = this.clock();
    const event = this.event(state, actor, kind, description, effectId); this.appendEvent(state, event);
    const receipt: BotWorldReceipt = { effectId, actorId: actor.companionId, status: actor.route.length ? 'moving' : command.operation === 'move' ? 'arrived' : 'applied', revision: state.revision, text: description };
    this.store.setMetadataBatch([{ key: stateKey, value: JSON.stringify(stateSchema.parse(state)) }, { key: effectKey, value: JSON.stringify({ requestHash, receipt, event }) }]);
    return { snapshot: this.project(state, scope.companionId), receipt, event };
  }
  /** Returns only durable semantic events, never frame-by-frame model wakeups. */
  tick(): BotWorldEvent[] { const { state, changed } = this.current(); if (changed) this.save(state); return state.pendingEvents.slice(0, 32); }
  pendingEvents(limit = 32): BotWorldEvent[] { return this.tick().slice(0, Math.max(1, Math.min(32, limit))); }
  ackEvents(ids: readonly string[]): void {
    const raw = this.store.getMetadata(stateKey); if (!raw) return;
    const state = stateSchema.parse(JSON.parse(raw)), selected = new Set(ids);
    state.pendingEvents = state.pendingEvents.filter(event => !selected.has(event.id)); this.save(state);
  }
  private authorize(scope: BotWorldScope): void {
    const conversation = this.store.getConversation(scope.conversationId);
    if (!conversation?.memberIds.includes(scope.companionId) || !this.store.getCompanion(scope.companionId)) throw new Error('世界动作不属于当前伙伴会话。');
  }
  private current(): { state: State; changed: boolean } {
    const now = this.clock(), stored = this.store.getMetadata(stateKey);
    const state: State = stored ? stateSchema.parse(JSON.parse(stored)) : { revision: 1, updatedAt: now, scenes: [createWorldPark()], actors: [], events: [], pendingEvents: [] };
    let changed = !stored;
    const companions = this.store.listCompanions(), live = new Set(companions.map(companion => companion.id));
    if (state.actors.some(actor => !live.has(actor.companionId))) {
      state.actors = state.actors.filter(actor => live.has(actor.companionId));
      state.scenes = state.scenes.filter(scene => !scene.ownerId || live.has(scene.ownerId));
      for (const scene of state.scenes) for (const object of scene.objects) if (object.occupantId && !live.has(object.occupantId)) delete object.occupantId;
      state.events = state.events.filter(event => live.has(event.companionId)).map(event => ({ ...event, recipientIds: event.recipientIds.filter(id => live.has(id)) }));
      state.pendingEvents = state.pendingEvents.filter(event => live.has(event.companionId)).map(event => ({ ...event, recipientIds: event.recipientIds.filter(id => live.has(id)) }));
      changed = true;
    }
    for (const companion of companions) {
      const existing = state.actors.find(actor => actor.companionId === companion.id);
      if (existing) {
        if (existing.name !== companion.name) { existing.name = companion.name; changed = true; }
        continue;
      }
      if (state.actors.length >= 1024) throw new Error('世界居民数量超过当前版本容量。');
      const home = createWorldHome(companion.id); home.name = `${companion.name}的小屋`; state.scenes.push(home);
      state.actors.push({ companionId: companion.id, name: companion.name, sceneId: home.id, homeSceneId: home.id,
        position: { x: home.door.x, y: home.door.y }, facing: 'north', frame: 0, activity: 'idle', movementSpeed: WORLD_WALK_TILES_PER_SECOND, route: [] }); changed = true;
    }
    const elapsed = Math.max(0, now - state.updatedAt); let arrived = false;
    for (let index = 0; index < state.actors.length; index++) {
      const original = state.actors[index]!; if (!original.route.length) continue;
      const advanced = advanceWorldActor(original, elapsed), actor = advanced.actor; state.actors[index] = actor;
      if (advanced.arrived) {
        actor.activity = 'idle'; this.completePending(state, actor); arrived = true;
        this.appendEvent(state, this.event(state, actor, 'arrival', `${actor.name}已经到达${state.scenes.find(scene => scene.id === actor.sceneId)!.name}中的目标位置。`, `arrival:${original.companionId}:${state.updatedAt}`));
      }
    }
    if (arrived) { state.revision++; changed = true; }
    // Persist projected positions only at a semantic change. Pure observations otherwise remain read-only.
    if (changed) state.updatedAt = now;
    return { state, changed };
  }
  private completePending(state: State, actor: BotWorldActor): void {
    const pending = actor.pending; actor.pending = undefined;
    if (!pending) return;
    if (pending.operation === 'travel') {
      const target = state.scenes.find(scene => scene.id === pending.sceneId)!;
      actor.sceneId = target.id; actor.position = { ...target.door }; actor.activity = 'idle'; return;
    }
    const object = state.scenes.find(scene => scene.id === actor.sceneId)!.objects.find(item => item.id === pending.objectId);
    if (!object || !close(actor.position, object.anchor)) throw new Error('物理动作尚未到达交互位置。');
    if (object.occupantId && object.occupantId !== actor.companionId) throw new Error('到达时物件已被其他伙伴占用。');
    object.occupantId = actor.companionId; actor.objectId = object.id; actor.activity = actions[pending.action];
  }
  private release(state: State, actor: BotWorldActor): void {
    for (const scene of state.scenes) for (const object of scene.objects) if (object.occupantId === actor.companionId) delete object.occupantId;
    actor.objectId = undefined;
  }
  private event(state: State, actor: BotWorldActor, kind: BotWorldEvent['kind'], text: string, effectId: string): BotWorldEvent {
    return { id: randomUUID(), effectId, companionId: actor.companionId, sceneId: actor.sceneId, kind, text, createdAt: new Date(this.clock()).toISOString(),
      recipientIds: state.actors.filter(other => other.sceneId === actor.sceneId).map(other => other.companionId) };
  }
  private appendEvent(state: State, event: BotWorldEvent): void {
    if (state.pendingEvents.length >= 256) throw new Error('世界事件待投递队列已满，先恢复投递再行动。');
    state.events = [...state.events, event].slice(-64); state.pendingEvents.push(event);
  }
  private save(state: State): void { this.store.setMetadataBatch([{ key: stateKey, value: JSON.stringify(stateSchema.parse(state)) }]); }
  private project(state: State, companionId: string): BotWorldSnapshot {
    const own = state.actors.find(actor => actor.companionId === companionId)!;
    const visibleScenes = state.scenes.filter(scene => !scene.ownerId || scene.ownerId === companionId);
    const visibleIds = new Set(visibleScenes.map(scene => scene.id));
    return { revision: state.revision, observedAt: new Date(this.clock()).toISOString(), companionId, scenes: visibleScenes,
      actors: state.actors.filter(actor => actor.companionId === companionId || actor.sceneId === own.sceneId && visibleIds.has(actor.sceneId)),
      events: state.events.filter(event => event.recipientIds.includes(companionId)).slice(-20) };
  }
}
