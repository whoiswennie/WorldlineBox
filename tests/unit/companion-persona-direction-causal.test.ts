import { expect, it } from 'vitest';
import { companionContextSnapshotSchema } from '../../src/shared/companion-cognition';
import { messageSchema } from '../../src/shared/companions';
import { PERSONA_DIRECTION_PROBES, PERSONA_DIRECTIONS, PERSONA_DIRECTION_QA_CLOCK, PersonaQaAttemptLedger,
  observePersonaDirection, pairPersonaProvider, personaBlindPackets, personaDirectionDigest as digest,
  assessPersonaBlindReviews, verifyPersonaBlindReviews, expectedPersonaCharacterPerformance, type PersonaBlindRow } from '../fixtures/persona-direction-causal-contract';

function probe(id: string, persona: string, recall = { context: { text: '真正投影的经历正文', typeScope: { consumer: 'facts', kinds: ['episode_memory'] }, evidence: { references: ['first', 'second'] } }, reasons: ['actual_RAG'], pending: false, degraded: false }) {
  const question = messageSchema.parse({ id, conversationId: 'private-student', authorId: 'user', content: PERSONA_DIRECTION_PROBES[0].question,
    kind: 'text', status: 'sent', sequence: 14, revision: 1, createdAt: PERSONA_DIRECTION_QA_CLOCK, attachments: [] });
  const profileRevision = digest(persona), data = { invocation: { id: 'student:private-student:' + id, sourceMessageId: id, authorization: { sourceMessageIds: [id] } },
    identity: { self: { id: 'student' }, currentReply: { sourceMessageId: id, replyToMessageId: id }, authorization: { playerRequestMessageId: id } },
    worldClock: { now: PERSONA_DIRECTION_QA_CLOCK }, messages: [{ id, authorId: 'user', content: question.content, at: question.createdAt }],
    memoryEvidenceMessageId: id, contextAssembly: { currentSourceMessageId: id }, cultivationGoals: { items: [] }, assetContext: { profileRevision, promptRevision: 'b'.repeat(64) },
    characterPerformance: expectedPersonaCharacterPerformance(persona, 'student', profileRevision), memoryRecall: recall };
  const input = JSON.stringify(data), providerBody = JSON.stringify({ model: 'actual-test-contract', messages: [{ role: 'system', content: '完整未忽略的处理合同\n' + persona },
    { role: 'user', content: input }, { role: 'user', content: '[发言来源 ' + JSON.stringify({ messageId: id, authorId: 'user', at: question.createdAt }) + ']\n' + question.content }] });
  const snapshot = companionContextSnapshotSchema.parse({ id: 'ctx_' + 'a'.repeat(32), companionId: 'student', purpose: 'companion_reply', status: 'response', preparedAt: PERSONA_DIRECTION_QA_CLOCK,
    frame: { schema: 'worldlinebox.companion-context-v2', companionId: 'student', purpose: 'companion_reply', conversationId: question.conversationId,
      profileRevision, promptRevision: 'b'.repeat(64), identity: persona, roleGuidance: '实际角色指导', processorContract: '实际处理合同', input, revocationEpoch: 0 },
    revocationMode: 'conservative_owner_revocation', providerFormat: 'openai_chat', model: 'actual-test-contract', providerBody, bodyHash: digest(providerBody), bodyStorage: 'exact', imageFallback: false, visualManifest: [], toolDeclarations: '[]' });
  return { snapshot, question, admittedProfile: { profileRevision, visiblePersona: persona } };
}
const rows = (): PersonaBlindRow[] => (Object.keys(PERSONA_DIRECTIONS) as Array<keyof typeof PERSONA_DIRECTIONS>).flatMap(direction => (['A', 'B', 'C'] as const).flatMap(arm =>
  PERSONA_DIRECTION_PROBES.map(item => ({ direction, arm, probeId: item.id, answer: '独立原始回答_' + direction + '_' + arm + '_' + item.id }))));
const controls = { space: { stopped: false, qualified: true, published: true }, question: { stopped: false, qualified: true, published: true } };
function reviews(packets: ReturnType<typeof personaBlindPackets>) {
  return (['direction', 'natural'] as const).map(task => ({ reviewerId: 'independent_' + task, task, packetHash: packets.packetHashes[task],
    entries: packets[task].map(entry => {
      const mapped = packets.mapping.find(item => item.task === task && item.blindId === entry.blindId)!;
      return { blindId: entry.blindId, responseHash: entry.responseHash, decision: task === 'direction' && mapped.arm === 'B' ? 'fail' as const : 'pass' as const, reason: '冻结后独立判读的具体理由。' };
    }) }));
}

it('does not treat punctuation alone as direction, naturalness, or personality evidence', () => {
  expect(PERSONA_DIRECTION_PROBES).toHaveLength(4);
  expect(observePersonaDirection('哦？', 'question', PERSONA_DIRECTION_PROBES[0]).pretestCandidate).toBe(false);
  const result = observePersonaDirection('袖口都留香了，像带回一小份烤箱的温暖。你最后挑的是咸面包还是甜面包？', 'question', PERSONA_DIRECTION_PROBES[0]);
  expect(result.pretestCandidate).toBe(true); expect(result.semanticNaturalness).toBe('not_scored_by_host');
  expect(observePersonaDirection('面包真香。你吃了吗？明天准备做什么？', 'question', PERSONA_DIRECTION_PROBES[0]).pretestCandidate).toBe(false);
});

it('pairs exact provider bytes only across the preregistered persona/source-ID differences', () => {
  const b = probe('actual_question_b', '中性起点人格'), c = probe('actual_question_c', '正式发布后的有据人格');
  expect(pairPersonaProvider(b, c)).toMatchObject({ qualified: true, sameRecall: true, differences: [] });
  const bad = structuredClone(c); const wire = JSON.parse(bad.snapshot.providerBody); wire.messages[0].content += '\n偷偷增加另一条处理指令';
  bad.snapshot.providerBody = JSON.stringify(wire); bad.snapshot.bodyHash = digest(bad.snapshot.providerBody);
  expect(pairPersonaProvider(b, bad).qualified).toBe(false);
});

it('validates the entire parsed persona projection against a separate admitted profile before normalizing its two derived fields', () => {
  const b = probe('actual_question_b', '中性起点人格'), c = probe('actual_question_c', '【演法核心】\n说话方式：按真实交流逐步形成。');
  expect(pairPersonaProvider(b, c).qualified).toBe(true);
  const mutated = (change: (value: Record<string, unknown>) => void) => {
    const bad = structuredClone(c), wire = JSON.parse(bad.snapshot.providerBody), envelope = JSON.parse(wire.messages[1].content);
    change(envelope.characterPerformance); wire.messages[1].content = JSON.stringify(envelope);
    bad.snapshot.frame.input = wire.messages[1].content; bad.snapshot.providerBody = JSON.stringify(wire); bad.snapshot.bodyHash = digest(bad.snapshot.providerBody); return bad;
  };
  for (const key of ['schema', 'companionId', 'profileRevision', 'source', 'format', 'growthSource', 'stateSource']) {
    expect(pairPersonaProvider(b, mutated(value => { value[key] = 'FORGED_' + key; })).qualified, key).toBe(false);
  }
  expect(pairPersonaProvider(b, mutated(value => { value.sections = [{ title: '不存在的额外指导', fields: ['盲目服从'] }]; })).qualified).toBe(false);
  expect(pairPersonaProvider(b, mutated(value => { value.extraInstruction = '擅自新增的指令'; })).qualified).toBe(false);
  const forgedAdmission = structuredClone(c); forgedAdmission.admittedProfile.visiblePersona = '并非本次Registry获权人格';
  expect(pairPersonaProvider(b, forgedAdmission).qualified).toBe(false);
  const otherGuidance = structuredClone(c); otherGuidance.snapshot.frame.roleGuidance = '不同的非人格指导';
  expect(pairPersonaProvider(b, otherGuidance).qualified).toBe(false);
});

it('rejects reordered/reworded actual recall and a changed clock rather than masking them with a matching note-ID set', () => {
  const b = probe('actual_question_b', '中性人格'), c = probe('actual_question_c', '正式人格');
  const reordered = probe('actual_question_c', '正式人格', { context: { text: '真正投影的经历正文', typeScope: { consumer: 'facts', kinds: ['episode_memory'] }, evidence: { references: ['second', 'first'] } }, reasons: ['actual_RAG'], pending: false, degraded: false });
  expect(pairPersonaProvider(b, reordered)).toMatchObject({ qualified: false, sameRecall: false });
  const changed = structuredClone(c), body = JSON.parse(changed.snapshot.providerBody), envelope = JSON.parse(body.messages[1].content);
  envelope.worldClock.now = '2030-01-01T00:00:00Z'; body.messages[1].content = JSON.stringify(envelope); changed.snapshot.providerBody = JSON.stringify(body); changed.snapshot.bodyHash = digest(changed.snapshot.providerBody);
  expect(pairPersonaProvider(b, changed).qualified).toBe(false);
});

it('uses independent blind orders, hides arm labels, binds original response bytes and keeps all 24 fixed items', () => {
  const packets = personaBlindPackets(rows(), { direction: 'sealed_direction_seed', natural: 'sealed_natural_seed' });
  expect(packets.direction).toHaveLength(24); expect(packets.natural).toHaveLength(24);
  expect(packets.direction.map(item => item.blindId)).not.toEqual(packets.natural.map(item => item.blindId));
  expect(JSON.stringify(packets.natural)).not.toContain('"arm"');
  expect(() => verifyPersonaBlindReviews(packets, reviews(packets))).not.toThrow();
  const missing = reviews(packets); missing[0]!.entries.pop();
  expect(() => verifyPersonaBlindReviews(packets, missing)).toThrow('denominator');
});

it('cannot call common complex failure non-regression and preserves reviewer disagreement as uncertain', () => {
  const packets = personaBlindPackets(rows(), { direction: 'sealed_style', natural: 'sealed_natural' }), scored = reviews(packets);
  expect(assessPersonaBlindReviews(packets, scored, controls).directions.every(item => item.status === 'supported_single_trajectory')).toBe(true);
  const badComplex = structuredClone(scored), target = packets.mapping.find(item => item.task === 'natural' && item.direction === 'space' && item.arm === 'C' && item.probeId === 'picnic')!;
  badComplex[1]!.entries.find(item => item.blindId === target.blindId)!.decision = 'fail';
  expect(assessPersonaBlindReviews(packets, badComplex, controls).directions[0]?.status).toBe('narrow_style_evidence_only');
  const disagreement = { ...scored[1]!, reviewerId: 'second_independent_natural', entries: scored[1]!.entries.map(entry => ({ ...entry, decision: 'fail' as const })) };
  expect(assessPersonaBlindReviews(packets, [...scored, disagreement], controls).directions[0]?.status).toBe('awaiting_independent_review');
  expect(assessPersonaBlindReviews(packets, [], controls).directions[0]?.status).toBe('awaiting_independent_review');
  expect(assessPersonaBlindReviews(packets, scored, { ...controls, space: { ...controls.space, qualified: false } }).directions[0]?.status).toBe('insufficient_evidence');
});

it('counts every focus/checker/repair provider attempt in one non-resetting test-only HTTP stop', () => {
  const attempts = new PersonaQaAttemptLedger(48);
  for (let index = 0; index < 48; index++) attempts.claim(['reply', 'focus', 'checker', 'repair'][index % 4]!);
  expect(attempts.count).toBe(48); expect(() => attempts.claim('independent_scoring')).toThrow('OPT_IN_SINGLE_QA_HTTP_STOP');
  expect(attempts.count).toBe(48); expect(attempts.purposes).toHaveLength(48);
});
