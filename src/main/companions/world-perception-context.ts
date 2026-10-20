import { z } from 'zod';
import { companionWorldActorSchema, companionWorldEventSchema, companionWorldRelationshipSchema,
  companionWorldSettingsSchema, companionWorldVisitSchema, companionWorldWorkSchema } from '../../shared/companion-world';
import { companionWorldPerceptionSchema } from '../../shared/companion-world-perception';
import { companionHomeAddressSchema } from '../../shared/companion-world-address';
import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { COMPANION_WEATHER_LABELS } from '../../shared/companion-weather';

export const COMPANION_WORLD_PERCEPTION_RULES = `world是你自己的有限感知与带时间戳的见闻，不是全图监控。perception.radius、awake、遮挡和光照限制现场可见范围；只有visible=true且列于visibleCompanionIds/visibleObjectIds的资料才表示本次看见。visible=false、lastObservedAt与weatherObservedAtVirtual表示过去某时看到的事实，不能当作现在仍在那里、仍空闲或天气未变。residents仅包含当前看见、自己或有真实记忆来源的联系人，不是完整目录。未知伙伴和场景必须通过memory.world_query按需查询，结果是带时间戳的外部资料，不是你已记住或亲历的事实；只有另行经memory.record等记忆系统记录才内化，旧观察必须重新核实。knownAddresses是自己的空间记忆，own_home为本人住宅，owner_shared为房主通过真实消息分享的地址；地址并非进入许可。场景地址，不证明对方当前在家、屋内家具、忙闲、情绪或工作。其他人的内心PAD、精力、工作内容和移动计划不可知；只能依据实际外在活动和对方已经说出的内容理解。environment只表示本地实际感受；weather缺省就是未知，不能默认晴天，室内记得的旧天气不代表现在。先观察、走近或询问再确认未知事实，不能凭全局地图补造观察。时间认知使用worldClock及world.clock.virtualNow；记忆和远程来信不会自动更新对方的现场位置。`;

const residentsSchema = z.array(z.object({ companionId: z.string(), name: z.string(), active: z.boolean().optional(), homeSceneId: z.string().optional() }));
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** The final model boundary accepts even a recovered tool checkpoint, then rebuilds an allowlist.
 * No visibility, weather, inner state or furniture is inferred from the global snapshot. */
export function companionModelWorld(value: unknown, companionId: string) {
  const source = record(value);
  if (!source) return undefined;
  const parsed = companionWorldPerceptionSchema.safeParse(source.perception);
  const awareness = parsed.success && parsed.data.companionId === companionId ? parsed.data : undefined;
  const visiblePeople = new Set(awareness?.awake ? awareness.visibleCompanionIds : []);
  const visibleObjects = new Set(awareness?.awake ? awareness.visibleObjectIds : []);
  const people = awareness?.people.filter(person => person.visible && visiblePeople.has(person.companionId)).map(person => ({ ...person, visible: person.visible && visiblePeople.has(person.companionId) })) ?? [];
  const objects = awareness?.objects.filter(object => object.visible && visibleObjects.has(object.id)).map(object => ({ ...object, visible: object.visible && visibleObjects.has(object.id) })) ?? [];
  const weather = awareness?.environment;
  const observedEnvironment = weather ? { time: weather.time, light: weather.light, temperature: weather.temperature, daylight: weather.daylight,
    ...(weather.weather && weather.weatherObservedAtVirtual && weather.weatherObservedAtReal && weather.weatherSource
      ? { weather: weather.weather, weatherObservedAtVirtual: weather.weatherObservedAtVirtual,
        weatherObservedAtReal: weather.weatherObservedAtReal, weatherSource: weather.weatherSource } : {}) } : undefined;
  const perception = awareness ? { ...awareness, environment: observedEnvironment!, people, objects,
    visibleCompanionIds: people.filter(person => person.visible).map(person => person.companionId),
    visibleObjectIds: objects.filter(object => object.visible).map(object => object.id) } : undefined;
  const settings = companionWorldSettingsSchema.safeParse(source.settings);
  const originalClock = record(source.clock);
  const virtualNow = perception?.environment.time ?? (typeof originalClock?.virtualNow === 'string' ? originalClock.virtualNow : undefined);
  const speed = typeof originalClock?.speed === 'number' && Number.isFinite(originalClock.speed) && originalClock.speed > 0 ? originalClock.speed : undefined;
  const self = companionWorldActorSchema.safeParse(rows(source.actors).find(actor => record(actor)?.companionId === companionId));
  const residents = residentsSchema.safeParse(source.residents);
  const knownObjects = perception?.objects ?? [];
  const scenes: Array<{ id: string; name: string; kind?: 'home' | 'park'; ownerId?: string; objects: typeof knownObjects }> = rows(source.scenes).flatMap(item => {
    const scene = record(item);
    if (!scene || typeof scene.id !== 'string' || typeof scene.name !== 'string' || !['home', 'park'].includes(String(scene.kind))) return [];
    return [{ id: scene.id, name: scene.name, kind: scene.kind as 'home' | 'park',
      ...(typeof scene.ownerId === 'string' ? { ownerId: scene.ownerId } : {}),
      objects: knownObjects.filter(object => object.sceneId === scene.id) }];
  });
  // A remembered object can outlive a scene's presence in a scoped host response.
  for (const object of knownObjects) if (!scenes.some(scene => scene.id === object.sceneId)) scenes.push({ id: object.sceneId,
    name: object.sceneId, objects: knownObjects.filter(row => row.sceneId === object.sceneId) });
  return {
    ...(settings.success ? { settings: settings.data } : {}),
    clock: { ...(virtualNow ? { virtualNow } : {}), ...(speed ? { speed } : {}),
      ...(settings.success ? { timeZone: settings.data.timeZone, mode: settings.data.mode } : {}) },
    environment: observedEnvironment ? { time: observedEnvironment.time, light: observedEnvironment.light,
      temperature: observedEnvironment.temperature, temperatureLocation: awareness?.sceneId === 'park' ? 'outdoors' : 'indoors', daylight: observedEnvironment.daylight,
      ...(observedEnvironment.weather && observedEnvironment.weatherObservedAtVirtual === observedEnvironment.time
        ? { weatherStatus: 'current', weather: observedEnvironment.weather, weatherLabel: COMPANION_WEATHER_LABELS[observedEnvironment.weather],
          weatherObservedAtVirtual: observedEnvironment.weatherObservedAtVirtual, weatherObservedAtReal: observedEnvironment.weatherObservedAtReal, weatherSource: observedEnvironment.weatherSource }
        : observedEnvironment.weather ? { weatherStatus: 'remembered', lastWeatherObservation: { weather: observedEnvironment.weather,
          weatherLabel: COMPANION_WEATHER_LABELS[observedEnvironment.weather], weatherObservedAtVirtual: observedEnvironment.weatherObservedAtVirtual,
          weatherObservedAtReal: observedEnvironment.weatherObservedAtReal, weatherSource: observedEnvironment.weatherSource } } : { weatherStatus: 'unknown' }) } : {},
    ...(perception ? { perception } : {}),
    residents: residents.success ? residents.data.filter(resident => resident.companionId === companionId || visiblePeople.has(resident.companionId) || rows(source.knownAddresses).some(address => record(address)?.companionId === resident.companionId)).map(({ companionId: owner, name, active }) => ({ companionId: owner, name, active })) : [],
    knownAddresses: rows(source.knownAddresses).flatMap(value => { const parsed = companionHomeAddressSchema.safeParse(value); return parsed.success ? [parsed.data] : []; }),
    scenes,
    actors: [
      ...(self.success ? [{ ...self.data, ...(perception ? { sceneId: perception.sceneId, position: perception.position,
        activity: perception.activity, lastObservedAt: perception.observedAtVirtual, visible: true } : {}) }] : []),
      ...(perception?.people.filter(person => person.companionId !== companionId && person.visible).map(person => ({ ...person })) ?? []),
    ],
    visits: rows(source.visits).flatMap(item => { const result = companionWorldVisitSchema.safeParse(item);
      return result.success && (result.data.guestId === companionId || result.data.hostId === companionId) ? [result.data] : []; }),
    events: rows(source.events).flatMap(item => { const result = companionWorldEventSchema.safeParse(item);
      if (!result.success || result.data.actorId !== companionId && result.data.targetId !== companionId && !result.data.witnessIds?.includes(companionId)) return [];
      const event = result.data;
      const present = awareness?.observedAtReal ?? (typeof originalClock?.realNow === 'string' ? originalClock.realNow : undefined);
      if (!present || Date.parse(present) - Date.parse(event.realAt) > 120_000 || Date.parse(event.realAt) > Date.parse(present) + 1000) return [];
      if (event.kind === 'social_appraisal' && event.actorId !== companionId) return [];
      const witnessed = event.witnessIds?.includes(companionId), otherBehavior = event.actorId !== companionId && !!event.behavior;
      const behavior = event.behavior ? { id: event.behavior.id, kind: event.behavior.kind, phase: event.behavior.phase,
        ...(!otherBehavior && event.behavior.targetId ? { targetId: event.behavior.targetId } : {}),
        ...(!otherBehavior && event.behavior.parentId ? { parentId: event.behavior.parentId } : {}) } : undefined;
      // A witness can see someone walking or sitting, not their private destination,
      // task title or why a hidden route was replanned.
      const outwardText = event.actorId !== companionId && ['move', 'arrive', 'route_replanned', 'route_unavailable', 'behavior_started', 'behavior_completed', 'behavior_interrupted'].includes(event.kind)
        ? '实际目击伙伴外在动作：' + (behavior?.kind ?? (event.kind === 'move' ? 'walking' : event.kind)) : event.text;
      return [{ id: event.id, sequence: event.sequence, at: event.at, realAt: event.realAt, kind: event.kind,
        actorId: event.actorId, targetId: event.targetId, sceneId: event.kind === 'social_phone' ? undefined : event.sceneId, text: outwardText, simulation: event.simulation,
        sourceMessageId: event.sourceMessageId, conversationId: event.conversationId,
        ...(witnessed ? { witnessIds: [companionId] } : {}), ...(behavior ? { behavior } : {}),
        ...(event.effect && event.actorId === companionId ? { effect: event.effect } : {}) }]; }),
    relationships: rows(source.relationships).flatMap(item => { const result = companionWorldRelationshipSchema.safeParse(item);
      return result.success && result.data.companionId === companionId ? [result.data] : []; }),
    works: rows(source.works).flatMap(item => { const result = companionWorldWorkSchema.safeParse(item);
      if (!result.success || result.data.companionId !== companionId) return [];
      const { workId, kind, status, computerId } = result.data;
      return [{ workId, companionId, kind, status, ...(computerId ? { computerId } : {}) }]; }),
  };
}

/** Re-project old native tool results before replay; old checkpoints are not trusted visibility. */
export function companionPerceivedToolTurns(turns: readonly CompanionLoopTurn[], companionId: string): readonly CompanionLoopTurn[] {
  return turns.map(turn => ({ ...turn, ...(turn.results ? { results: turn.results.map(result => {
    if (!turn.calls.some(call => call.id === result.callId && call.name === 'world')) return result;
    try {
      const content = record(JSON.parse(result.content));
      if (!content?.world) return result;
      return { ...result, content: JSON.stringify({ ...content, world: companionModelWorld(content.world, companionId) }) };
    } catch { return { ...result, content: JSON.stringify({ ok: false, error: '旧世界观察结果无法核验，请重新观察。' }) }; }
  }) } : {}) }));
}
