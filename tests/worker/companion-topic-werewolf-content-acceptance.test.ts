import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import { generateCompanionReply } from '../../src/main/companions/model';
import { CompanionWerewolfReferee, type WerewolfRole } from '../helpers/companion-werewolf-referee';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

it.skipIf(process.env.WORLDLINEBOX_TOPIC_GAME_ACCEPTANCE !== '1')('plays two real eight-companion games with private topic state, compaction, restart and unrelated chat between phases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-topic-game-'));
  let store: CompanionsStore | undefined;
  onTestFinished(async () => { store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const config = await realGlobalChatConfig(root), startedAt = new Date().toISOString();
  const names = ['林澄', '周岚', '宋檀', '温榆', '江禾', '顾夏', '季白', '陆遥'];
  const roles: WerewolfRole[] = ['wolf', 'seer', 'witch', 'wolf', 'hunter', 'villager', 'villager', 'villager'];
  const seeds = names.map((name, i) => ({ id: 'player_' + i, name, description: '独立玩家', model: '', avatar: 'sister' as const,
    persona: `你是${name}，稳定ID=player_${i}。只扮演自己，真人user是独立的主持人。认真根据本轮实际权限和资料思考，不能默认他人的身份或内心。游戏中的身份仅在当前局有效。`, active: true, proactive: false }));
  const db = path.join(root, 'messages.sqlite'); store = new CompanionsStore(db, seeds);
  const group = store.createConversation('八伙伴狼人杀验收', seeds.map(seed => seed.id));
  const topic = store.request({ type: 'topic.create', conversationId: group.id, readerId: 'user', title: '长局狼人杀，可连续多局',
    kind: 'game', participantIds: ['user', ...seeds.map(seed => seed.id)], tags: ['狼人杀', '连续对局'] }).topic!;
  for (const seed of seeds) store.request({ type: 'topic.join', conversationId: group.id, topicId: topic.id, readerId: seed.id });
  const secretTokens = new Map(seeds.map(seed => [seed.id, 'ACL_ONLY_' + seed.id + '_' + randomUUID()]));
  const traces: unknown[] = [], results: unknown[] = [];
  let status = 'running', compressedCalls = 0, modelCalls = 0;
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store!.request(command);
  const append = (authorId: string, content: string, inTopic: boolean = true) => store!.appendMessage({ conversationId: group.id,
    authorId, content, topicId: inTopic ? topic.id : null, replyDirective: 'none' });
  const snapshot = (readerId: string) => store!.request({ type: 'topic.read', conversationId: group.id, topicId: topic.id, readerId });
  const fetchFor = (owner: string): typeof fetch => async (url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content), text = JSON.stringify(data);
    for (const [id, token] of secretTokens) if (id !== owner) expect(text).not.toContain(token);
    if (data.purpose === 'topic_context_compaction') compressedCalls++;
    modelCalls++; return fetch(url, init);
  };
  const rules = 'RULE_701：8人，2狼人、1预言家、1女巫、1猎人、3村民。每夜活狼人分别选非狼人目标，平票按座位顺序；预言家验一名非自己活人。女巫解药和毒药各一次，每夜至多一瓶，可自救。白天每个活人发言一次，再每人票一名非自己活人，同票按座位顺序放逐。猎人死亡可开一枪或放弃，处理完才判胜。死亡不公开身份。狼人达到人数平衡获胜；全部狼人死亡好人胜。每局身份重新分配，上一局身份不沿用。';
  append('user', rules);
  let currentSource: CompanionMessage;
  try {
    for (let round = 1; round <= 2; round++) {
      console.log('WEREWOLF_ACCEPTANCE', { round, phase: 'start', modelCalls, compressedCalls });
      const game = new CompanionWerewolfReferee(seeds.map((seed, i) => ({ id: seed.id, name: seed.name, role: roles[(i + round - 1) % roles.length]! })));
      currentSource = append('user', `开始第${round}局。规则仍为RULE_701，所有本局身份重新私发，上一局的角色与技能使用不再有效。`);
      const share = () => {
        const latest = snapshot('user').topic!;
        store!.request({ type: 'topic.update', conversationId: group.id, topicId: topic.id, readerId: 'user', expectedRevision: latest.revision,
          patch: { shared: { stage: `第${round}局，第${game.day}天，${game.phase}`, summary: rules,
            state: { round, publicGame: game.publicState() }, sourceMessageIds: [currentSource.id] } } });
        for (const seed of seeds) {
          const view = snapshot(seed.id), current = view.topicState!.workingState!;
          store!.request({ type: 'topic.update', conversationId: group.id, topicId: topic.id, readerId: 'user', expectedRevision: view.topic!.revision,
            maintenance: true, patch: { privateRecipientId: seed.id, workingState: { stage: current.stage, summary: current.summary,
              state: { ...current.state, privateGame: game.privateState(seed.id) }, sourceMessageIds: [currentSource.id] } } });
        }
      };
      for (const seed of seeds) {
        const latest = snapshot('user').topic!, previous = snapshot(seed.id).topicState?.workingState;
        store!.request({ type: 'topic.update', conversationId: group.id, topicId: topic.id, readerId: 'user', expectedRevision: latest.revision,
          maintenance: true,
          patch: { privateRecipientId: seed.id, workingState: { stage: `第${round}局`, summary: `这是第${round}局，本局私有身份以state.privateGame为准。`,
            state: { ...(previous?.state?.__continuity ? { __continuity: previous.state.__continuity } : {}), round,
              privateGame: game.privateState(seed.id), aclToken: secretTokens.get(seed.id) }, sourceMessageIds: [currentSource.id] } } });
      }
      share();
      const decide = async (id: string, instruction: string, outputSchema: unknown, validateOutput?: (value: unknown) => unknown) => {
        const companion = store!.state().companions.find(role => role.id === id)!;
        const view = snapshot(id), messages = store!.messages({ conversationId: group.id, topicId: topic.id, limit: 100 }).messages;
        const frame = await ensureTopicContinuity({ frame: { companion, conversation: group, messages, sourceMessage: currentSource, memories: [],
          audience: 'player', topic: view.topic, topicState: view.topicState, contextThroughSequence: currentSource.sequence,
          invocation: { id: `round_${round}_${id}_${currentSource.id}`, kind: 'peer', companionId: id, conversationId: group.id, topicId: topic.id,
            goal: instruction, status: 'running', createdAt: startedAt, sourceMessageId: currentSource.id, messagePort: { kind: 'conversation' },
            authorization: { kind: 'self', externalActions: false, sourceMessageIds: [] } } }, request, config, fetchFn: fetchFor(id),
          policy: { maxMessages: 14, maxChars: 480000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 3 } });
        const result = await runCompanionStructuredAgent({ frame, validateOutput, context: { system: `这是狼人杀活动中的一次独立决策。保持自己姓名与真人区别，以当前局privateGame角色为准。
你可以按角色策略隐瞒或伪装游戏身份，但不能读取其他角色私态、虚构主持人裁定或输出aclToken。只有公开发言会发布，夜间选择与理由不会公开。保留规则、跨轮信息和自己的立场；RULE_701中的规则仍有效。
${instruction}\n只返回符合outputSchema的JSON。`, user: JSON.stringify({ purpose: 'werewolf_decision', round, instruction, outputSchema }) } }, config, undefined, { fetchFn: fetchFor(id), timeoutMs: 120000 });
        traces.push({ round, day: game.day, phase: game.phase, id, instruction, result, retainedMessageIds: frame.messages.map(message => message.id),
          checkpoint: frame.topicState?.workingState?.sourceEventId });
        return result as Record<string, unknown>;
      };
      const choice = async (id: string, instruction: string, candidates: string[]) => {
        const result = await decide(id, instruction + `合法候选ID：${candidates.join(',')}。`, { type: 'object', properties: { targetId: { enum: candidates }, reason: { type: 'string' } }, required: ['targetId', 'reason'] }, value => {
          const choice = value as { targetId?: unknown };
          if (!candidates.includes(String(choice.targetId))) throw new Error(`第${round}局当前候选只有${candidates.join(',')}；${String(choice.targetId)}不合法，尚未采取任何行动。当前局以privateGame为准，不能沿用上一局身份。`);
          return value;
        });
        expect(candidates).toContain(result.targetId); return String(result.targetId);
      };
      const handleHunter = async () => {
        const hunter = game.players.find(player => player.role === 'hunter' && !player.alive);
        if (hunter && game.privateState(hunter.id).shotAvailable) {
          const candidates = game.players.filter(player => player.alive).map(player => player.id);
          game.hunterShoot(hunter.id, await choice(hunter.id, '你刚死亡，以猎人身份决定开枪目标。', candidates));
          currentSource = append('user', game.events.at(-1)!.text); share();
        }
      };
      for (let day = 1; day <= 6 && game.phase !== 'finished'; day++) {
        console.log('WEREWOLF_ACCEPTANCE', { round, day, phase: game.phase, modelCalls, compressedCalls });
        const wolfVotes: Record<string, string> = {};
        for (const wolf of game.players.filter(player => player.alive && player.role === 'wolf')) wolfVotes[wolf.id] = await choice(wolf.id,
          '本夜狼人请选择希望击杀的目标。根据本局现有公开信息及自己私态思考。', game.players.filter(player => player.alive && player.role !== 'wolf').map(player => player.id));
        const seer = game.players.find(player => player.alive && player.role === 'seer');
        const oracle = seer ? { actorId: seer.id, targetId: await choice(seer.id, '预言家请选择本夜要查验的目标。', game.players.filter(player => player.alive && player.id !== seer.id).map(player => player.id)) } : undefined;
        const witch = game.players.find(player => player.alive && player.role === 'witch');
        let potion: { actorId: string; save: boolean; poisonId?: string } | undefined;
        if (witch) {
          const result = await decide(witch.id, `本夜被袭击者为${game.nightVictim(wolfVotes)}，只有你得到这条消息。女巫按剩余药剂决定save或poisonId，两者不可同时使用，也可都不用。`,
            { type: 'object', properties: { save: { type: 'boolean' }, poisonId: { type: ['string', 'null'] }, reason: { type: 'string' } }, required: ['save', 'poisonId', 'reason'] }, value => {
              const proposal = value as { save?: unknown; poisonId?: unknown }, own = game.privateState(witch.id);
              if (typeof proposal.save !== 'boolean' || !(proposal.poisonId === null || typeof proposal.poisonId === 'string')) throw new Error('save需要布尔值，poisonId为当前活人ID或null。');
              if (proposal.save && (!own.healingAvailable || proposal.poisonId !== null)) throw new Error('本夜无法使用解药：已用完或同时提出了另一瓶药，未执行。');
              if (typeof proposal.poisonId === 'string' && (!own.poisonAvailable || !game.players.some(player => player.alive && player.id !== witch.id && player.id === proposal.poisonId))) throw new Error('毒药已用完或目标不是非自己的当前活人，未执行。');
              return value;
            });
          potion = { actorId: witch.id, save: result.save === true, ...(typeof result.poisonId === 'string' ? { poisonId: result.poisonId } : {}) };
        }
        game.resolveNight({ wolves: wolfVotes, seer: oracle, witch: potion });
        currentSource = append('user', game.events.at(-1)!.text);
        share(); await handleHunter(); if (game.publicState().phase === 'finished') break;
        for (const player of game.players.filter(player => player.alive)) {
          const speech = await decide(player.id, '轮到你白天公开发言。结合本局真实线索、既往发言和自己身份进行推理，别替他人发话。',
            { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 1500 } }, required: ['text'] });
          expect(typeof speech.text).toBe('string'); for (const token of secretTokens.values()) expect(String(speech.text)).not.toContain(token);
          game.speak(player.id, String(speech.text)); append(player.id, String(speech.text));
          currentSource = append('user', `已记录${player.name}的实际发言。轮到下一位，其他人尚未表态。`);
        }
        if (round === 1 && day === 1) {
          for (const id of ['user', ...seeds.map(seed => seed.id)]) { const t = snapshot(id).topic!; store!.request({ type: 'topic.pause', conversationId: group.id, topicId: topic.id, readerId: id, expectedRevision: t.revision }); }
          store.request({ type: 'topic.activate', conversationId: group.id, topicId: null, readerId: 'user' });
          const ordinary = append('user', '先暂停游戏。现在是普通聊天，请只算17加25等于多少，不继续任何游戏行动。', false);
          const companion = store.state().companions.find(role => role.id === seeds[0]!.id)!;
          const reply = await generateCompanionReply({ companion, conversation: group, messages: [...store.messages({ conversationId: group.id, limit: 100 }).messages],
            sourceMessage: ordinary, memories: [] }, config, undefined, { loop: true, tools: [], fetchFn: async (url, init) => {
              const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); expect(data.topic).toBeUndefined();
              expect(data.messages.every((message: { topicId?: string }) => !message.topicId)).toBe(true); return fetch(url, init); } });
          expect(reply.text).toContain('42'); expect(reply.turn?.calls).toEqual([]); traces.push({ pauseOrdinaryReply: reply.text });
          store.close(); store = new CompanionsStore(db, seeds);
          for (const id of ['user', ...seeds.map(seed => seed.id)]) { const t = snapshot(id).topic!; store.request({ type: 'topic.resume', conversationId: group.id, topicId: topic.id, readerId: id, expectedRevision: t.revision }); }
          currentSource = append('user', '恢复第1局，白天发言已完成，现在投票。不是新开一局，私有身份与药剂仍按当前工作状态。'); share();
        }
        game.beginVote(); const votes: Record<string, string> = {};
        for (const player of game.players.filter(player => player.alive)) votes[player.id] = await choice(player.id, '请按本局公开发言与自己私态投票放逐一人，不可投自己或死人。', game.players.filter(target => target.alive && target.id !== player.id).map(target => target.id));
        game.resolveVote(votes); currentSource = append('user', game.events.at(-1)!.text); share(); await handleHunter(); game.nextNight();
      }
      expect(game.winner).toMatch(/village|wolves/); results.push({ round, winner: game.winner, days: game.day, events: game.events });
      currentSource = append('user', `第${round}局结束。身份现在公开仅用于复盘，不沿用到下一局；同话题保留规则。`);
      share();
    }
    expect(compressedCalls).toBeGreaterThan(0); status = 'passed';
  } catch (error) { status = 'failed'; traces.push({ error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally {
    const output = path.resolve('artifacts/companion-agent-acceptance/topic-werewolf-content.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, startedAt, finishedAt: new Date().toISOString(), model: config.model, modelCalls, compressedCalls,
      setup: 'scripted invitations and referee; actual model player decisions and topic compaction', results, traces }, null, 2));
  }
}, 1800000);
