import { expect, it, vi } from 'vitest';
import { buildCompanionContext, refreshCompanionContextClock } from '../../src/main/companions/context';
import { generateCompanionReply } from '../../src/main/companions/model';
import { generateCompanionWorldDecision } from '../../src/main/companions/world-model';
import { generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { companionModelPhoneReceipt, companionModelWorld, companionPerceivedToolTurns } from '../../src/main/companions/world-perception-context';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
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
  const ownHome = createCompanionWorldHome('self'), foreignHome = createCompanionWorldHome('far');
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
  expect(world!.perception!.people.some(person => person.companionId === 'remembered')).toBe(false);
  expect(world!.residents.some(person => person.companionId === 'far')).toBe(false);
  expect(world!.scenes.find(scene => scene.id === 'home_far')!.objects).toEqual([]);
  expect(world!.relationships).toEqual([{ companionId: 'self', targetCompanionId: 'near', affinity: 60, trust: 55, interactions: 2, updatedAt: old }]);
  expect(world!.environment).toMatchObject({ temperature: 21, light: .4, temperatureLocation: 'indoors', weatherStatus: 'remembered',
    lastWeatherObservation: { weather: 'rain', weatherObservedAtVirtual: old, weatherLabel: '下雨' } });
  expect(world!.environment).not.toHaveProperty('weather');
  expect(world!.clock.virtualNow).toBe(now);
}

it('projects present local perception and learned entries while leaving past observations to explicit queries', () => {
  const world = fixture(), projected = companionModelWorld(world, 'self'); checkBoundary(projected);
  expect(projected!.actors[0]).toMatchObject({ state: world.actors[0]!.state });
  expect(companionModelWorld(projected, 'self')).toEqual(projected);
  expect(JSON.parse(buildCompanionContext(modelInput(world)).user).world).toEqual(projected);
});
it('uses the same canonical weather label when currently observed, without exposing unseen global weather', () => {
  const world = fixture(); world.perception!.environment.weather = 'cloudy';
  world.perception!.environment.weatherObservedAtVirtual = world.perception!.environment.time;
  world.perception!.environment.weatherObservedAtReal = world.perception!.observedAtReal;
  const projected = companionModelWorld(world, 'self')!;
  expect(projected.environment).toMatchObject({ weather: 'cloudy', weatherStatus: 'current', weatherLabel: '多云', temperature: 21 });
  expect(projected.clock).toMatchObject({ virtualNow: now, timeZone: 'UTC', mode: 'realtime' });
  expect(JSON.stringify(projected)).not.toContain('snow'); expect(companionModelWorld(projected, 'self')).toEqual(projected);
});

it('does not refresh remembered people or objects from their changed authoritative state', () => {
  const world = fixture(); world.perception!.objects[0]!.visible = false; world.perception!.objects[0]!.lastObservedAt = old;
  world.perception!.visibleObjectIds = [];
  const result = companionModelWorld(world, 'self')!;
  expect(result.perception!.people.some(person => person.companionId === 'remembered')).toBe(false);
  expect(result.scenes[0]!.objects).toEqual([]);
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
    const tool = body.messages.find((message: { role: string }) => message.role === 'tool'), historical = JSON.parse(tool.content).world;
    expect(historical.observation).toMatchObject({ status: 'historical', requiresReobservation: true, asOfReal: now, comparedToReal: now });
    expect(historical.perception.visibleCompanionIds).toEqual([]); expect(historical.perception.visibleObjectIds).toEqual([]);
    expect(historical.actors.every((actor: { visible?: boolean }) => actor.visible !== true)).toBe(true);
    expect(historical.environment.weatherStatus).toBe('remembered');
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

it('keeps earlier weather and peer positions explicitly historical when a newer authorized observation exists', () => {
  const earlier = fixture(), current = fixture();
  earlier.perception!.observedAtReal = old; earlier.perception!.observedAtVirtual = old; earlier.perception!.environment.time = old;
  earlier.perception!.environment.weather = 'clear'; earlier.perception!.environment.weatherObservedAtReal = old;
  earlier.perception!.environment.weatherObservedAtVirtual = old; earlier.perception!.people[0]!.lastObservedAt = old;
  current.perception!.environment.weatherObservedAtVirtual = now; current.perception!.environment.weatherObservedAtReal = now;
  const original = JSON.stringify(earlier);
  const result = companionPerceivedToolTurns([{ text: '', rawText: '', calls: [{ id: 'world-old', name: 'world', arguments: '{"action":"inspect"}' }],
    results: [{ callId: 'world-old', content: JSON.stringify({ ok: true, world: earlier }) }] }], 'self', current);
  const history = JSON.parse(result[0]!.results![0]!.content).world;
  expect(history.observation).toMatchObject({ status: 'historical', asOfReal: old, asOfVirtual: old, comparedToReal: now, comparedToVirtual: now });
  expect(history.environment).toMatchObject({ weatherStatus: 'remembered', lastWeatherObservation: { weather: 'clear', weatherObservedAtVirtual: old } });
  expect(history.environment).not.toHaveProperty('weather'); expect(history.perception.people[0]).toMatchObject({ visible: false, lastObservedAt: old });
  expect(history.perception.visibleCompanionIds).toEqual([]); expect(history.perception.objects.every((object: { visible: boolean }) => !object.visible)).toBe(true);
  expect(companionModelWorld(current, 'self')!.environment).toMatchObject({ weatherStatus: 'current', weather: 'rain' });
  expect(JSON.stringify(earlier)).toBe(original); expect(JSON.stringify(history)).not.toContain('snow'); expect(JSON.stringify(history)).not.toContain('PRIVATE_PEER_PLAN');
});

it('does not certify an old checkpoint clock as the time of this request when no fresh world was supplied', () => {
  const world = fixture(); world.perception!.observedAtReal = old; world.perception!.observedAtVirtual = old; world.perception!.environment.time = old;
  world.perception!.environment.weatherObservedAtVirtual = old; world.perception!.environment.weatherObservedAtReal = old;
  const frozen = buildCompanionContext(modelInput(world)), refreshed = JSON.parse(refreshCompanionContextClock(frozen, undefined, 'self').user);
  expect(refreshed.worldClock).toMatchObject({ now: old, asOfVirtual: old, asOfReal: old, status: 'historical', requiresRefresh: true, trust: 'host_world_clock_at_recorded_observation' });
  expect(refreshed.worldClock.trust).not.toBe('host_world_clock_at_request_time'); expect(refreshed.world.observation.status).toBe('historical');
  expect(refreshed.world.environment.weatherStatus).toBe('remembered'); expect(refreshed.world.perception.visibleCompanionIds).toEqual([]);
});

it('marks a simulation backlog as an observed past without turning old visibility or weather into current facts', () => {
  const world = fixture(); world.backlog = true; world.perception!.environment.weatherObservedAtVirtual = now; world.perception!.environment.weatherObservedAtReal = now;
  const context = JSON.parse(buildCompanionContext(modelInput(world)).user);
  expect(context.worldClock).toMatchObject({ status: 'historical', backlog: true, requiresRefresh: true, asOfVirtual: now, asOfReal: now });
  expect(context.world.observation).toMatchObject({ status: 'historical', backlog: true, requiresReobservation: true });
  expect(context.world.environment.weatherStatus).toBe('remembered'); expect(context.world.perception.visibleObjectIds).toEqual([]);
});

it('sends fresh world facts separately from historical tool receipts at the real provider boundary', async () => {
  const previous = fixture(), current = fixture();
  previous.perception!.environment.weather = 'clear'; previous.perception!.environment.time = old;
  previous.perception!.observedAtVirtual = old; previous.perception!.observedAtReal = old;
  previous.perception!.environment.weatherObservedAtVirtual = old; previous.perception!.environment.weatherObservedAtReal = old;
  current.perception!.environment.weatherObservedAtVirtual = now; current.perception!.environment.weatherObservedAtReal = now;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const messages = JSON.parse(String(init?.body)).messages, data = JSON.parse(messages[1].content);
    expect(data.world.environment).toMatchObject({ weatherStatus: 'current', weather: 'rain' });
    expect(data.worldClock).toMatchObject({ status: 'current', asOfVirtual: now, trust: 'host_world_clock_at_current_observation' });
    const tool = JSON.parse(messages.find((item: { role: string }) => item.role === 'tool').content);
    expect(tool.world.environment).toMatchObject({ weatherStatus: 'remembered', lastWeatherObservation: { weather: 'clear' } });
    expect(tool.world.observation).toMatchObject({ status: 'historical', comparedToReal: now, asOfReal: old });
    expect(tool.world.perception.visibleCompanionIds).toEqual([]);
    return response({ text: '本次实际观察下雨，之前晴天属于旧见闻。' });
  });
  await generateCompanionReply(modelInput(current), config, undefined, { fetchFn, loop: true,
    turns: [{ text: '', rawText: '', calls: [{ id: 'prior', name: 'world', arguments: '{"action":"inspect"}' }], results: [{ callId: 'prior', content: JSON.stringify({ ok: true, world: previous }) }] }] });
  expect(fetchFn).toHaveBeenCalledOnce();
});

it('leaves non-world receipts untouched and still sanitizes unavailable world observations without a reference', () => {
  const other = { callId: 'memory', content: '{"ok":true,"content":"literal"}' };
  const turns = companionPerceivedToolTurns([{ text: '', rawText: '', calls: [{ id: 'memory', name: 'memory', arguments: '{}' }, { id: 'world', name: 'world', arguments: '{}' }],
    results: [other, { callId: 'world', content: 'invalid old snapshot' }] }], 'self');
  expect(turns[0]!.results![0]).toBe(other); expect(JSON.parse(turns[0]!.results![1]!.content)).toMatchObject({ ok: false });
});

it.each(['message', 'introduce', 'create_group'])('projects a world %s phone receipt without a world snapshot as communication reachability, preserving calls and message text', action => {
  const receipt = { ok: true, socialPending: true, socialRecipients: ['available', 'dormant', 'sleeping', 'eating', 'working', 'busy'].map((state, index) => ({ companionId: 'peer_' + index, state })),
    socialMessage: { message: { content: '我昨晚在睡觉，今天愿意玩。', createdAt: old }, virtualCreatedAt: old },
    activityTask: { goal: '不要把sleeping这段真实原文删掉。' } };
  const call = { id: 'phone', name: 'world', arguments: JSON.stringify({ action, text: '邀请一起玩。' }), thoughtSignature: 'OPAQUE_NATIVE_SIGNATURE' };
  const turn = { text: '', rawText: '', calls: [call], results: [{ callId: call.id, content: JSON.stringify(receipt) }] };
  const original = JSON.stringify(turn), projected = companionPerceivedToolTurns([turn], 'self', fixture());
  const content = JSON.parse(projected[0]!.results![0]!.content);
  expect(content.socialRecipients.map((recipient: { state: string }) => recipient.state)).toEqual(['available', 'dormant', 'available', 'available', 'available', 'available']);
  expect(content.socialMessage).toEqual(receipt.socialMessage); expect(content.activityTask).toEqual(receipt.activityTask);
  expect(content.socialReceiptObservation).toMatchObject({ asOf: 'original_tool_receipt', scope: 'phone_contactability_only', confirmsRead: false, confirmsReply: false,
    sentAtReal: old, sentAtVirtual: old });
  expect(content.socialReceiptObservation).not.toHaveProperty('asOfReal');
  expect(projected[0]!.calls[0]).toBe(call); expect(projected[0]!.calls[0]!.arguments).toBe(call.arguments);
  expect(JSON.stringify(turn)).toBe(original);
});

it('keeps a recorded receipt timestamp across immediate inference and checkpoint replay without refreshing it from the current body', () => {
  const world = fixture(); world.clock.realNow = old;
  const receipt = { ok: true, world, socialPending: false, socialRecipients: [{ companionId: 'far', state: 'sleeping', privateRoute: 'UNSEEN_ROUTINE' }] };
  const turns = [{ text: '', rawText: '', calls: [{ id: 'phone', name: 'world', arguments: '{"action":"message","recipientIds":["far"],"text":"一起玩吗？"}' }],
    results: [{ callId: 'phone', content: JSON.stringify(receipt) }] }];
  const immediate = companionPerceivedToolTurns(turns, 'self'), checkpoint = companionPerceivedToolTurns(immediate, 'self', fixture());
  const content = JSON.parse(checkpoint[0]!.results![0]!.content);
  expect(content.socialRecipients).toEqual([{ companionId: 'far', state: 'available' }]);
  expect(content.socialReceiptObservation).toMatchObject({ asOfReal: old, confirmsRead: false, confirmsReply: false });
  expect(content.world.observation).toMatchObject({ status: 'historical', comparedToReal: now });
  expect(JSON.stringify(content)).not.toContain('UNSEEN_ROUTINE');
  expect(receipt.socialRecipients[0]!.state).toBe('sleeping');
});

it('only narrows typed phone recipients and never scans DSH output, free JSON, direct bodily observations or contact directory reads', () => {
  const content = JSON.stringify({ ok: true, socialRecipients: [{ companionId: 'far', state: 'sleeping' }],
    worldKnowledge: { category: 'contacts', items: [{ id: 'far', state: 'available', description: '她说昨晚睡得不错。' }] }, text: 'sleeping是原文。' });
  const calls = [{ id: 'dsh', name: 'dsh', arguments: '{"operation":"run"}' }, { id: 'memory', name: 'memory', arguments: '{"action":"world_query","category":"contacts"}' },
    { id: 'inspect', name: 'world', arguments: '{"action":"inspect"}' }, { id: 'query', name: 'world', arguments: '{"action":"query","category":"contacts"}' },
    { id: 'face', name: 'world', arguments: '{"action":"social","targetCompanionId":"far","kind":"talk","text":"你好"}' }];
  const results = calls.map(call => ({ callId: call.id, content }));
  const projected = companionPerceivedToolTurns([{ text: '', rawText: '', calls, results }], 'self');
  for (const [index, result] of results.entries()) expect(projected[0]!.results![index]).toBe(result);
  expect(companionModelPhoneReceipt({ ok: true, socialRecipients: [{ companionId: 'far', state: 'invented_private_state' }, { companionId: 'other', state: 'working' }] })!.socialRecipients)
    .toEqual([{ companionId: 'other', state: 'available' }]);
});

it('uses the same phone projection at the provider boundary for an immediate receipt and the same recovered checkpoint', async () => {
  const turns = [{ text: '', rawText: '', calls: [{ id: 'phone', name: 'world', arguments: '{"action":"message","recipientIds":["far"],"text":"一起玩吗？"}' }],
    results: [{ callId: 'phone', content: JSON.stringify({ ok: true, socialPending: true, socialRecipients: [{ companionId: 'far', state: 'sleeping' }] }) }] }];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const messages = JSON.parse(String(init?.body)).messages, content = JSON.parse(messages.find((message: { role: string }) => message.role === 'tool').content);
    expect(content.socialRecipients).toEqual([{ companionId: 'far', state: 'available' }]);
    expect(content.socialReceiptObservation).toMatchObject({ scope: 'phone_contactability_only', confirmsRead: false, confirmsReply: false });
    expect(content.socialReceiptObservation).not.toHaveProperty('asOfReal');
    return response({ text: '邀请还在待发中，是否愿意参加要等实际回复；我不知道她此刻的身体状态。' });
  });
  await generateCompanionReply(modelInput(fixture()), config, undefined, { fetchFn, loop: true, turns });
  await generateCompanionReply(modelInput(fixture()), config, undefined, { fetchFn, loop: true, turns: companionPerceivedToolTurns(turns, 'self') });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it('applies the same phone receipt boundary inside the structured agent tool loop', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const messages = JSON.parse(String(init?.body)).messages, tool = messages.find((message: { role: string }) => message.role === 'tool');
    if (!tool) return new Response(JSON.stringify({ choices: [{ message: { content: null,
      tool_calls: [{ id: 'phone', type: 'function', function: { name: 'world', arguments: '{"action":"message","recipientIds":["far"],"text":"一起玩吗？"}' } }] } }] }),
    { headers: { 'Content-Type': 'application/json' } });
    const content = JSON.parse(tool.content);
    expect(content.socialRecipients).toEqual([{ companionId: 'far', state: 'available' }]);
    expect(content.socialReceiptObservation).toMatchObject({ confirmsRead: false, confirmsReply: false });
    return response({ done: true });
  });
  const result = await runCompanionStructuredAgent({ frame: modelInput(fixture()), context: { system: '按本次领域JSON结构交付。', user: '{"purpose":"phone_receipt_boundary"}' },
    capabilities: { tools: [{ name: 'world', parameters: { type: 'object' }, description: '发送真实自己的邀约。' }],
      execute: async () => ({ ok: true, socialRecipients: [{ companionId: 'far', state: 'working' }] }) } }, config, undefined, { fetchFn });
  expect(result).toEqual({ done: true }); expect(fetchFn).toHaveBeenCalledTimes(2);
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
    expect(data.world.works).toBeUndefined(); expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['wait', 'companion_submit_result']);
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
