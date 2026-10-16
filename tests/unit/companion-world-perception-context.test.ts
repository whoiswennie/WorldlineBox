import { expect, it, vi } from 'vitest';
import { buildCompanionContext, refreshCompanionContextClock } from '../../src/main/companions/context';
import { generateCompanionReply } from '../../src/main/companions/model';
import { generateCompanionWorldDecision } from '../../src/main/companions/world-model';
import { generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { companionModelWorld } from '../../src/main/companions/world-perception-context';
import { createCompanionWorldHome } from '../../src/shared/companion-world-engine';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import type { CompanionWorldActor, CompanionWorldSnapshot } from '../../src/shared/companion-world';

const now = '2026-10-15T10:00:00.000Z', old = '2026-10-15T06:00:00.000Z';
const companion: Companion = { id: 'self', name: '自己', description: '', persona: '礼貌、如实说出不确定性。', model: '', avatar: 'sister', builtin: false, proactive: true, createdAt: now };
const conversation: CompanionConversation = { id: 'private_self', kind: 'private', title: '自己', memberIds: ['self'], unread: 0, muted: false, pinned: false, lastMessage: '', updatedAt: now };
const source: CompanionMessage = { id: 'current', authorId: 'user', conversationId: conversation.id, sequence: 1, kind: 'text', status: 'sent', attachments: [], content: '现在外面天气怎样？朋友在做什么？', createdAt: now };
const config = { apiFormat: 'openai_chat' as const, model: 'configured', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
const modelInput = (world: CompanionWorldSnapshot) => ({ companion, conversation, messages: [source], memories: [], world });
function fixture(): CompanionWorldSnapshot {
  const actors: CompanionWorldActor[] = ['self', 'near', 'remembered', 'far'].map((companionId, index) => ({ companionId,
    sceneId: index < 2 ? 'home_self' : 'home_far', homeSceneId: 'home_' + companionId, position: { x: 4 + index * 40, y: 4 },
    facing: 'south', frame: 0, activity: 'idle', activityStartedAtReal: now, artAction: 'idle', locomotion: 'walk', movementSpeed: 2.4,
    state: { energy: 7, mood: 'low', expression: 'reserved', affect: { pleasure: -.9, arousal: .9, dominance: -.7 }, thermalComfort: .2 },
    destinationId: companionId === 'self' ? 'self_desk' : 'PRIVATE_PEER_PLAN', route: [{ sceneId: 'home_far', x: 777, y: 888 }], routinePhase: 'awake' }));
  const ownHome = createCompanionWorldHome('self', 0), foreignHome = createCompanionWorldHome('far', 1);
  foreignHome.objects[0] = { ...foreignHome.objects[0]!, id: 'UNSEEN_PRIVATE_FURNITURE', name: 'UNSEEN_PRIVATE_FURNITURE' };
  const bench = { ...ownHome.objects.find(object => object.kind === 'chair')!, sceneId: ownHome.id, firstObservedAt: old, lastObservedAt: now, visible: true };
  return { settings: { revision: 1, mode: 'realtime', timeZone: 'UTC', dayDurationMinutes: 20 },
    clock: { realNow: now, virtualNow: '2026-10-15T11:00:00.000Z', speed: 1, day: 1, hour: 11, daylight: true },
    environment: { weather: 'snow', light: 1, outdoorTemperature: -7, indoorTemperature: 24 },
    scenes: [ownHome, foreignHome], actors,
    residents: ['self', 'near', 'remembered', 'far'].map(companionId => ({ companionId, name: companionId, homeSceneId: 'home_' + companionId })),
    visits: [{ id: 'hidden_visit', guestId: 'near', hostId: 'far', status: 'allowed', reason: 'PRIVATE_VISIT_REASON', createdAt: now, expiresAt: '2026-10-16T10:00:00.000Z' }],
    events: [{ id: 'hidden_event', sequence: 1, actorId: 'far', targetId: 'near', sceneId: foreignHome.id, kind: 'social_phone', text: 'PRIVATE_ROOM_EVENT', at: now, realAt: now, simulation: true }],
    works: [{ workId: 'PRIVATE_PEER_WORK', companionId: 'near', kind: 'action', status: 'ready', computerId: 'UNSEEN_COMPUTER', reason: 'PRIVATE_WORK_REASON' }],
    relationships: [{ companionId: 'near', targetCompanionId: 'self', affinity: 99, trust: 99, interactions: 9, updatedAt: now },
      { companionId: 'self', targetCompanionId: 'near', affinity: 60, trust: 55, interactions: 2, updatedAt: old }],
    lastEventSequence: 1, backlog: false,
    perception: { companionId: 'self', sceneId: ownHome.id, position: { x: 4, y: 4 }, activity: 'idle', awake: true, radius: 5,
      observedAtReal: now, observedAtVirtual: now, revision: 3,
      environment: { time: now, light: .4, temperature: 21, daylight: true, weather: 'rain',
        weatherObservedAtVirtual: old, weatherObservedAtReal: old, weatherSource: 'door' },
      objects: [bench], visibleObjectIds: [bench.id], visibleCompanionIds: ['near'],
      people: [{ companionId: 'near', sceneId: ownHome.id, position: { x: 5, y: 4 }, activity: 'walking', lastObservedAt: now, visible: true },
        { companionId: 'remembered', sceneId: ownHome.id, position: { x: 7, y: 4 }, activity: 'resting', lastObservedAt: old, visible: false }] },
  };
}
function checkBoundary(world: ReturnType<typeof companionModelWorld>) {
  const text = JSON.stringify(world);
  for (const secret of ['PRIVATE_PEER_PLAN', 'UNSEEN_PRIVATE_FURNITURE', 'PRIVATE_PEER_WORK', 'UNSEEN_COMPUTER',
    'PRIVATE_WORK_REASON', 'PRIVATE_VISIT_REASON', 'PRIVATE_ROOM_EVENT', 'snow']) expect(text).not.toContain(secret);
  expect(world!.actors.map(actor => actor.companionId)).toEqual(['self', 'near']);
  expect(world!.actors[1]).toEqual({ companionId: 'near', sceneId: 'home_self', position: { x: 5, y: 4 }, activity: 'walking', lastObservedAt: now, visible: true });
  expect(world!.perception!.people[1]).toMatchObject({ companionId: 'remembered', position: { x: 7, y: 4 }, lastObservedAt: old, visible: false });
  expect(world!.residents).toContainEqual({ companionId: 'far', name: 'far' });
  expect(world!.scenes.find(scene => scene.id === 'home_far')!.objects).toEqual([]);
  expect(world!.relationships).toEqual([{ companionId: 'self', targetCompanionId: 'near', affinity: 60, trust: 55, interactions: 2, updatedAt: old }]);
  expect(world!.environment).toMatchObject({ temperature: 21, light: .4, weather: 'rain', weatherObservedAtVirtual: old });
  expect(world!.clock.virtualNow).toBe(now);
}

it('projects only actual local perception, own state and public addresses while preserving stale evidence', () => {
  const world = fixture(), projected = companionModelWorld(world, 'self'); checkBoundary(projected);
  expect(projected!.actors[0]).toMatchObject({ state: world.actors[0]!.state });
  expect(companionModelWorld(projected, 'self')).toEqual(projected);
  expect(JSON.parse(buildCompanionContext(modelInput(world)).user).world).toEqual(projected);
});

it('does not refresh remembered people or objects from their changed authoritative state', () => {
  const world = fixture(); world.perception!.objects[0]!.visible = false; world.perception!.objects[0]!.lastObservedAt = old;
  world.perception!.visibleObjectIds = [];
  const result = companionModelWorld(world, 'self')!;
  expect(result.perception!.people[1]).toMatchObject({ position: { x: 7, y: 4 }, lastObservedAt: old, visible: false });
  expect(result.scenes[0]!.objects[0]).toMatchObject({ lastObservedAt: old, visible: false });
  expect(result.scenes[0]!.objects[0]).not.toHaveProperty('occupantId'); expect(result.scenes[0]!.objects[0]).not.toHaveProperty('reservedBy');
});

it('keeps never-observed weather unknown and fails closed on missing or another character perception', () => {
  const world = fixture(); delete world.perception!.environment.weather; delete world.perception!.environment.weatherObservedAtVirtual;
  delete world.perception!.environment.weatherObservedAtReal; delete world.perception!.environment.weatherSource;
  const unseenWeather = companionModelWorld(world, 'self')!;
  expect(unseenWeather.environment).not.toHaveProperty('weather'); expect(unseenWeather.environment).not.toHaveProperty('outdoorTemperature');
  for (const perception of [undefined, { ...world.perception!, companionId: 'far' }]) {
    const result = companionModelWorld({ ...world, perception }, 'self')!;
    expect(result.environment).toEqual({}); expect(result.actors.map(actor => actor.companionId)).toEqual(['self']);
    expect(result.scenes.every(scene => scene.objects.length === 0)).toBe(true);
  }
});

it('requires actual weather observation provenance and never exposes a remote sender location or private appraisal', () => {
  const world = fixture(); delete world.perception!.environment.weatherObservedAtVirtual;
  world.events = [
    { ...world.events[0]!, id: 'received', actorId: 'far', targetId: 'self', sceneId: 'REMOTE_PRIVATE_ROOM', text: '你好' },
    { ...world.events[0]!, id: 'private_appraisal', actorId: 'far', targetId: 'self', kind: 'social_appraisal', text: 'PRIVATE_INNER_APPRAISAL' },
  ];
  const result = companionModelWorld(world, 'self')!;
  expect(result.environment).not.toHaveProperty('weather'); expect(result.events).toHaveLength(1);
  expect(result.events[0]).not.toHaveProperty('sceneId', 'REMOTE_PRIVATE_ROOM');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_INNER_APPRAISAL');
});

it('preserves timestamped actual witnesses without guessing from current visibility or exposing other witnesses and plans', () => {
  const world = fixture(); world.events = [
    { ...world.events[0]!, id: 'actual_witness', kind: 'move', actorId: 'near', text: '开始步行前往PRIVATE_PEER_PLAN', witnessIds: ['self', 'far'], at: old },
    { ...world.events[0]!, id: 'current_visible_but_not_witnessed', actorId: 'near' },
    { ...world.events[0]!, id: 'actual_pose', kind: 'behavior_started', actorId: 'near', text: 'PRIVATE_POSE_REASON', witnessIds: ['self'],
      behavior: { id: 'behavior', kind: 'walking', phase: 'started', targetId: 'PRIVATE_PEER_PLAN' } },
  ];
  const result = companionModelWorld(world, 'self')!;
  expect(result.events.map(event => event.id)).toEqual(['actual_witness', 'actual_pose']);
  expect(result.events[0]).toMatchObject({ at: old, witnessIds: ['self'] });
  expect(result.events[1]!.behavior).not.toHaveProperty('targetId');
  expect(JSON.stringify(result.events)).not.toContain('PRIVATE_PEER_PLAN'); expect(JSON.stringify(result.events)).not.toContain('PRIVATE_POSE_REASON');
  expect(companionModelWorld(result, 'self')!.events).toEqual(result.events);
});

it('sanitizes actual chat request and recovered world tool history before provider replay', async () => {
  const world = fixture(), raw = buildCompanionContext(modelInput(world));
  raw.user = JSON.stringify({ ...JSON.parse(raw.user), world }); // Simulate a checkpoint made before the model boundary was tightened.
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content); checkBoundary(data.world);
    const tool = body.messages.find((message: { role: string }) => message.role === 'tool'); checkBoundary(JSON.parse(tool.content).world);
    expect(body.messages[0].content).toContain('weather缺省就是未知');
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PEER_PLAN');
    return response({ text: '我上次在门边看到下雨，但现在还没有重新确认；不知道远处朋友的当前状态。' });
  });
  await generateCompanionReply(modelInput(world), config, undefined, { context: raw, fetchFn, loop: true,
    turns: [{ text: '', rawText: '', calls: [{ id: 'inspect', name: 'world', arguments: '{"action":"inspect"}' }],
      results: [{ callId: 'inspect', content: JSON.stringify({ ok: true, world }) }] }] });
  expect(fetchFn).toHaveBeenCalledOnce();
  checkBoundary(JSON.parse(refreshCompanionContextClock(raw, world, 'self').user).world);
});

it('keeps world decision and phone reply provider payloads within the same finite perception', async () => {
  const world = fixture(), members = world.residents.map(resident => ({ id: resident.companionId, name: resident.name, description: '' }));
  const decisionFetch: typeof fetch = async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); checkBoundary(data.world);
    expect(data.trigger.encounterMemberIds).toEqual(['self', 'near']);
    return response({ action: null, reason: '先承认未观察到的内容。', appraisals: [] });
  };
  await generateCompanionWorldDecision({ companion, world, members, job: { id: 'job', companionId: 'self', conversationId: 'world_self',
    kind: 'decision', status: 'running', throughEventSequence: 1, attempts: 1, createdAt: now, sourceMemoryIds: [], encounterMemberIds: ['self', 'near', 'far'] } }, config, undefined, { fetchFn: decisionFetch });
  const room = { ...conversation, id: 'peer_room', kind: 'group' as const, memberIds: ['self', 'near', 'remembered', 'far'] };
  const message = { ...source, conversationId: room.id, authorId: 'far', content: '你现在在做什么？' };
  await generateCompanionSocialReply({ companion, world, members, conversation: room, source: message, messages: [message], job: {
    id: 'social_job', companionId: 'self', conversationId: room.id, sourceMessageId: message.id, throughSequence: 1,
    chainId: 'chain', remainingTurns: 2, memberIds: room.memberIds, channel: 'phone', status: 'running', attempts: 1, createdAt: now, typingNotBefore: now,
  } }, config, undefined, { fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content); checkBoundary(data.world);
    expect(data.channel).toBe('phone'); expect(data.world.actors.some((actor: { companionId: string }) => actor.companionId === 'far')).toBe(false);
    expect(data.world.works).toBeUndefined(); expect(body.tools).toBeUndefined();
    return response({ text: '我在家里，刚看见身边有人走过。你那边现在怎么样？', reason: '只说明自己的实际感知，不猜远程位置。' });
  } });
});

it('validates present encounters from visible perception even when the scoped actors array contains only oneself', async () => {
  const world = fixture(); world.actors = world.actors.filter(actor => actor.companionId === 'self');
  const decide = (targetCompanionId: string) => generateCompanionWorldDecision({ companion, world, members: [], job: { id: 'encounter',
    companionId: 'self', conversationId: 'world_self', kind: 'decision', status: 'running', throughEventSequence: 1,
    attempts: 1, createdAt: now, sourceMemoryIds: [] } }, config, undefined,
  { fetchFn: async () => response({ action: { action: 'social', targetCompanionId, kind: 'greet', text: '你好，现在方便聊会儿吗？' }, reason: '只和眼前的人交流。', appraisals: [] }) });
  await expect(decide('near')).resolves.toMatchObject({ action: { action: 'social', targetCompanionId: 'near' } });
  await expect(decide('remembered')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(decide('far')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  world.perception!.awake = false;
  await expect(decide('near')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
