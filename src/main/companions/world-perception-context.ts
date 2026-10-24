import { z } from 'zod';
import { companionWorldActorSchema, companionWorldEventSchema, companionWorldRelationshipSchema,
  companionWorldSettingsSchema, companionWorldVisitSchema, companionWorldWorkSchema } from '../../shared/companion-world';
import { companionWorldPerceptionSchema } from '../../shared/companion-world-perception';
import { companionHomeAddressSchema } from '../../shared/companion-world-address';
import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { COMPANION_WEATHER_LABELS } from '../../shared/companion-weather';
import { companionContactReceiptSchema } from '../../shared/companion-contact';

export const COMPANION_WORLD_PERCEPTION_RULES = `world是你自己的有限感知与带时间戳的见闻，不是全图监控。perception.radius、awake、遮挡和光照限制现场可见范围；只有visible=true且列于visibleCompanionIds/visibleObjectIds的资料才表示本次看见。world.observation.status=historical、requiresReobservation=true或backlog=true表示历史观察或尚未补算到当前时刻，不能作为当前天气、位置、忙闲或许可的证明。旧工具回执始终是当时的记录，本轮宿主新观察优先；asOfReal/asOfVirtual保留真正观察时点，没有新观察时先重新核实。visible=false、lastObservedAt与weatherObservedAtVirtual表示过去某时看到的事实，不能当作现在仍在那里、仍空闲或天气未变。residents仅包含当前看见、自己或有真实记忆来源的联系人，不是完整目录。未知伙伴和场景必须通过memory.world_query按需查询，结果是带时间戳的外部资料，不是你已记住或亲历的事实；只有另行经memory.record等记忆系统记录才内化，旧观察必须重新核实。knownAddresses是自己的空间记忆，own_home为本人住宅，owner_shared为房主通过真实消息分享的地址；地址并非进入许可。场景地址，不证明对方当前在家、屋内家具、忙闲、情绪或工作。其他人的内心PAD、精力、工作内容和移动计划不可知；只能依据实际外在活动和对方已经说出的内容理解。environment只表示本地实际感受；weather缺省就是未知，不能默认晴天，室内记得的旧天气不代表现在。先观察、走近或询问再确认未知事实，不能凭全局地图补造观察。时间认知使用worldClock及world.clock.virtualNow；记忆和远程来信不会自动更新对方的现场位置。`;

const residentsSchema = z.array(z.object({ companionId: z.string(), name: z.string(), active: z.boolean().optional(), homeSceneId: z.string().optional() }));
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** The final model boundary accepts even a recovered tool checkpoint, then rebuilds an allowlist.
 * No visibility, weather, inner state or furniture is inferred from the global snapshot. */
export function companionModelWorld(value: unknown, companionId: string, options: { historical?: boolean; reference?: unknown } = {}) {
  const source = record(value);
  if (!source) return undefined;
  const parsed = companionWorldPerceptionSchema.safeParse(source.perception);
  const awareness = parsed.success && parsed.data.companionId === companionId ? parsed.data : undefined;
  const priorObservation = record(source.observation), reference = record(options.reference), referencePerception = record(reference?.perception), referenceClock = record(reference?.clock);
  const backlog = source.backlog === true || priorObservation?.backlog === true;
  const historical = options.historical === true || priorObservation?.status === 'historical' || backlog;
  const visiblePeople = new Set(awareness?.awake ? awareness.visibleCompanionIds : []);
  const visibleObjects = new Set(awareness?.awake ? awareness.visibleObjectIds : []);
  const people = awareness?.people.filter(person => person.visible && visiblePeople.has(person.companionId)).map(person => ({ ...person, visible: !historical && person.visible && visiblePeople.has(person.companionId) })) ?? [];
  const objects = awareness?.objects.filter(object => object.visible && visibleObjects.has(object.id)).map(object => ({ ...object, visible: !historical && object.visible && visibleObjects.has(object.id) })) ?? [];
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
    backlog,
    observation: { status: historical ? 'historical' as const : 'current' as const, requiresReobservation: historical, backlog,
      ...(awareness ? { asOfReal: awareness.observedAtReal, asOfVirtual: awareness.observedAtVirtual } : {}),
      ...(typeof referencePerception?.observedAtReal === 'string' ? { comparedToReal: referencePerception.observedAtReal } : typeof referenceClock?.realNow === 'string' ? { comparedToReal: referenceClock.realNow } : {}),
      ...(typeof referencePerception?.observedAtVirtual === 'string' ? { comparedToVirtual: referencePerception.observedAtVirtual } : typeof referenceClock?.virtualNow === 'string' ? { comparedToVirtual: referenceClock.virtualNow } : {}),
    },
    ...(settings.success ? { settings: settings.data } : {}),
    clock: { ...(virtualNow ? { virtualNow } : {}), ...(speed ? { speed } : {}),
      ...(settings.success ? { timeZone: settings.data.timeZone, mode: settings.data.mode } : {}) },
    environment: observedEnvironment ? { time: observedEnvironment.time, light: observedEnvironment.light,
      temperature: observedEnvironment.temperature, temperatureLocation: awareness?.sceneId === 'park' ? 'outdoors' : 'indoors', daylight: observedEnvironment.daylight,
      ...(!historical && observedEnvironment.weather && observedEnvironment.weatherObservedAtVirtual === observedEnvironment.time
        ? { weatherStatus: 'current', weather: observedEnvironment.weather, weatherLabel: COMPANION_WEATHER_LABELS[observedEnvironment.weather],
          weatherObservedAtVirtual: observedEnvironment.weatherObservedAtVirtual, weatherObservedAtReal: observedEnvironment.weatherObservedAtReal, weatherSource: observedEnvironment.weatherSource }
        : observedEnvironment.weather ? { weatherStatus: 'remembered', lastWeatherObservation: { weather: observedEnvironment.weather,
          weatherLabel: COMPANION_WEATHER_LABELS[observedEnvironment.weather], weatherObservedAtVirtual: observedEnvironment.weatherObservedAtVirtual,
          weatherObservedAtReal: observedEnvironment.weatherObservedAtReal, weatherSource: observedEnvironment.weatherSource } } : { weatherStatus: 'unknown' }) } : {},
    ...(perception ? { perception } : {}),
    residents: residents.success ? residents.data.filter(resident => resident.companionId === companionId || visiblePeople.has(resident.companionId) || rows(source.knownAddresses).some(address => record(address)?.companionId === resident.companionId)).map(({ companionId: owner, name, active }) => ({ companionId: owner, name, ...(!historical && active !== undefined ? { active } : {}) })) : [],
    knownAddresses: rows(source.knownAddresses).flatMap(value => { const parsed = companionHomeAddressSchema.safeParse(value); return parsed.success ? [parsed.data] : []; }),
    scenes,
    actors: [
      ...(self.success ? [{ ...self.data, ...(perception ? { sceneId: perception.sceneId, position: perception.position,
        activity: perception.activity, lastObservedAt: perception.observedAtVirtual, visible: !historical } : {}) }] : []),
      ...(perception?.people.filter(person => person.companionId !== companionId && (historical || person.visible)).map(person => ({ ...person })) ?? []),
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
        sourceMessageId: event.sourceMessageId, conversationId: event.conversationId, sourceReads: event.sourceReads,
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

/** Phone delivery is independent of the rendered body's routine. A contact
 * receipt grants no remote bodily observation, read receipt or reply. This is
 * deliberately a typed host receipt projection, never a scan of message text. */
export function companionModelPhoneReceipt(value: unknown) {
  const content = record(value);
  if (!content || !Array.isArray(content.socialRecipients) && typeof content.socialPending !== 'boolean' && !record(content.socialMessage)) return content;
  const clock = record(record(content.world)?.clock), previous = record(content.socialReceiptObservation);
  const asOfReal = z.iso.datetime().safeParse(clock?.realNow ?? previous?.asOfReal);
  const delivered = record(content.socialMessage), message = record(delivered?.message);
  const sentAtReal = z.iso.datetime().safeParse(message?.createdAt), sentAtVirtual = z.iso.datetime().safeParse(delivered?.virtualCreatedAt);
  return { ...content,
    ...(Array.isArray(content.socialRecipients) ? { socialRecipients: content.socialRecipients.slice(0, 20).flatMap(value => {
      const recipient = companionContactReceiptSchema.safeParse(value);
      return recipient.success ? [{ companionId: recipient.data.companionId, state: recipient.data.state === 'dormant' ? 'dormant' : 'available' }] : [];
    }) } : {}),
    socialReceiptObservation: { asOf: 'original_tool_receipt', ...(asOfReal.success ? { asOfReal: asOfReal.data } : {}),
      ...(sentAtReal.success ? { sentAtReal: sentAtReal.data } : {}), ...(sentAtVirtual.success ? { sentAtVirtual: sentAtVirtual.data } : {}),
      scope: 'phone_contactability_only', confirmsRead: false, confirmsReply: false,
      notice: '这是原工具执行时的通信可达性回执，不是当前身体观察。available只表示可联系，不能推断醒着、空闲或在家；已激活伙伴可独立处理手机消息。socialPending只表示待发，socialMessage只证明这条消息已送达，不证明已读或收到回复；回复以实际后续来信为准。' },
  };
}

/** Re-project native tool results before every inference, including immediate
 * receipts and recovered checkpoints. Original calls and records stay intact. */
export function companionPerceivedToolTurns(turns: readonly CompanionLoopTurn[], companionId: string, reference?: unknown): readonly CompanionLoopTurn[] {
  return turns.map(turn => ({ ...turn, ...(turn.results ? { results: turn.results.map(result => {
    const call = turn.calls.find(call => call.id === result.callId && call.name === 'world');
    if (!call) return result;
    try {
      const content = record(JSON.parse(result.content));
      if (!content) return result;
      let action: unknown;
      try { action = record(JSON.parse(call.arguments))?.action; } catch { /* Invalid calls are never reclassified as a phone capability. */ }
      const perceived = ['message', 'introduce', 'create_group'].includes(String(action)) ? companionModelPhoneReceipt(content)! : content;
      if (!content.world && perceived === content) return result;
      return { ...result, content: JSON.stringify({ ...perceived, ...(content.world ? {
        world: companionModelWorld(content.world, companionId, { historical: true, reference }),
      } : {}) }) };
    } catch { return { ...result, content: JSON.stringify({ ok: false, error: '旧世界观察结果无法核验，请重新观察。' }) }; }
  }) } : {}) }));
}
