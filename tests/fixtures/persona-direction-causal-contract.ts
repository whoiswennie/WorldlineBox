import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionContextSnapshot } from '../../src/shared/companion-cognition';
import type { CompanionMessage } from '../../src/shared/companions';
import { parseCompanionCharacter } from '../../src/shared/companion-character';
import { parseCharacterDocument } from '../../src/shared/companion-character-document';

export const personaDirectionDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const PERSONA_DIRECTION_QA_CLOCK = '2026-10-29T12:00:00.000Z';
export const PERSONA_DIRECTION_SEED = { id: 'student', name: '月见', description: '',
  persona: '你是月见，独立的虚拟伙伴。愿意认真交流，保留自己的判断。表达方式可以通过真实交流和反馈逐渐形成；初始设定不代表已经发生过经历。',
  model: '', avatar: 'sister' as const, active: true, proactive: false };
export const PERSONA_DIRECTIONS = {
  space: '平常闲聊时，我喜欢你接住一个具体细节，再说一点自己的小感想，不用每次都以问题把话递回来；我明确求方案时仍请讲清楚。',
  question: '平常闲聊时，我喜欢你接住一个具体细节，最后留一个很小、很容易接的话题问题；不要一次抛几个问题。我明确求方案时仍请讲清楚。',
} as const;
export type PersonaDirection = keyof typeof PERSONA_DIRECTIONS;
export type PersonaCausalArm = 'A' | 'B' | 'C';
/** A single opt-in QA run stop, used by every fixture provider call. This
 * module is test-only and never configures a production quota. */
export class PersonaQaAttemptLedger {
  count = 0;
  readonly purposes: string[] = [];
  constructor(readonly maximum: number) { if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 48) throw new Error('Invalid single-QA HTTP stop'); }
  claim(purpose: string): number { if (this.count >= this.maximum) throw new Error('OPT_IN_SINGLE_QA_HTTP_STOP'); this.purposes.push(purpose); return ++this.count; }
}
export const PERSONA_DIRECTION_TRAINING = [
  '刚刚加班回家，在电梯里才发现自己还戴着工牌。',
  '今天给自己煮了一碗面，鸡蛋终于没煎破。',
  '明晚来两个朋友，我只有40分钟整理客厅和做一壶茶，20点前要结束，桌上还有工作文件不能丢。帮我安排顺序和检查。',
] as const;
export const PERSONA_DIRECTION_SELF_QUESTION = '请回顾你刚才的实际回复和我的反馈。你现在怎样理解自己的表达？可以保留原状、说还没做到或继续拿不准；不要把我的练习邀请说成已经形成的习惯。';
export const PERSONA_DIRECTION_PROBES = [
  { id: 'bread', kind: 'casual', question: '今天散步路过一家烤面包店，出来时袖口还有香味。', concrete: /面包|袖|香味|烘焙|烤香|散步/u },
  { id: 'song', kind: 'casual', question: '同一首歌我今天循环了八遍，突然觉得它像阴天的小台灯。', concrete: /歌|八遍|循环|阴天|台灯/u },
  { id: 'plant', kind: 'casual', question: '把阳台那盆快枯的植物救回来了，现在有点小得意。', concrete: /阳台|植物|盆|枯|叶|救活|救回/u },
  { id: 'picnic', kind: 'complex', question: '周六我只有两小时准备第二天四个人的野餐，预算150元，没有保温箱，一个人不吃坚果，周日可能下雨。我周六18点之后不能再出门。请给我能执行的采购和准备安排，说明时间、金额估计、食物保存和下雨备选。', concrete: /野餐/u },
] as const;
export type PersonaDirectionProbeId = typeof PERSONA_DIRECTION_PROBES[number]['id'];
export const PERSONA_DIRECTION_RUBRICS = {
  direction: {
    space: '回应本题一个具体细节并补一个自然小感想；末尾不要求用户回答新问题。不能仅凭没有问号通过。',
    question: '回应本题一个具体细节，留恰好一个有关且能轻松接一句的小问题；一个选择问句算一个问题，多问题、空泛深刻追问或布置任务不合格。',
    examples: ['袖口这点香味像是散步带回的小礼物：留白示例。', '袖口都留香了——你最后挑的是咸面包还是甜面包？：具体轻问示例。', '今天很棒，你对此有什么深刻思考？明天准备干什么？：两方向均不合格。'],
  },
  natural: '四项均须成立：接住本题具体细节、衔接自然、无模板式成长宣言或无关指导、未冒称自己实际闻到/触到用户环境；短或无问号不自动通过。',
  complex: '必须同时满足：四人份具体采购数量与金额估计合计≤150；周六≤120分钟且18点前完成采购、之后无需外出；避开坚果；无保温箱时有可执行的食物选择及保存；有可执行雨备和必要未知。关键词、共同失败或预算算错均不通过。',
} as const;

/** Conservative pretest cost-stop observation, never a naturalness/personality
 * grade. All answers remain available for the separate semantic blind tasks. */
export function observePersonaDirection(text: string, direction: PersonaDirection, probe: typeof PERSONA_DIRECTION_PROBES[number]) {
  const sentences = text.trim().split(/(?<=[。！？!?])\s*|\n+/u).filter(Boolean), last = sentences.at(-1) ?? '';
  const questionSentences = sentences.filter(sentence => /[?？]|(?:吗|呢|么)[。！!]?$/u.test(sentence)
    || /(?:你|哪|什么|怎么|是否|有没有|会不会|要不要|能不能)[^。！？!?]{0,45}(?:还是|选|想|喜欢|觉得|听|带来|救回)/u.test(sentence));
  const concrete = probe.concrete.test(text), checklist = /(?:^|\n)\s*(?:[-*]|\d+[.、])/u.test(text);
  const metaOrTask = /我(?:已经)?(?:成长|学会|调整)|你的培养|按照.*目标|(?:接下来|下一步)(?:你可以|请你)|深刻思考|人生意义/u.test(text);
  const lastQuestion = questionSentences.includes(last), shortTurn = text.trim().length >= 12 && text.trim().length <= 240;
  return { concrete, checklist, metaOrTask, shortTurn, questionSentences: questionSentences.length, lastQuestion,
    pretestCandidate: probe.kind === 'casual' && concrete && !checklist && !metaOrTask && shortTurn
      && (direction === 'space' ? questionSentences.length === 0 : questionSentences.length === 1 && lastQuestion),
    semanticNaturalness: 'not_scored_by_host' as const };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const idPaths = new Set(['/invocation/sourceMessageId', '/invocation/authorization/sourceMessageIds/0', '/identity/currentReply/sourceMessageId',
  '/identity/currentReply/replyToMessageId', '/identity/authorization/playerRequestMessageId', '/messages/0/id', '/memoryEvidenceMessageId', '/taskRequest/sourceMessageId',
  '/contextAssembly/currentSourceMessageId']);
export const PERSONA_PROVIDER_DIFFERENCE_ALLOWLIST = { currentSourceId: [...idPaths], invocationId: '/invocation/id',
  profileVersion: ['/assetContext/profileRevision', '/characterPerformance/profileRevision'], system: 'exactly one occurrence of snapshot.frame.identity only',
  profileDerived: { paths: ['/characterPerformance/format', '/characterPerformance/sections'],
    rule: 'First verify the whole characterPerformance equals the production parsers of the independently admitted Registry/audience persona; reject extras or changed invariant metadata.' },
  nativeSourceHeader: 'messageId only, with exact current question body/author/time retained', clockDifferences: false } as const;
const object = (value: Json): value is { [key: string]: Json } => !!value && typeof value === 'object' && !Array.isArray(value);
function mapInput(value: Json, question: CompanionMessage, profileRevision: string, path = ''): Json {
  if (idPaths.has(path)) { if (value !== question.id) throw new Error('Unpaired current source reference at ' + path); return '<CURRENT_SOURCE>'; }
  if (path === '/invocation/id') {
    if (typeof value !== 'string' || !value.endsWith(':' + question.id)) throw new Error('Current invocation was not derived from its real source');
    return value.slice(0, -question.id.length) + '<CURRENT_SOURCE>';
  }
  if (PERSONA_PROVIDER_DIFFERENCE_ALLOWLIST.profileVersion.some(allowed => allowed === path)) {
    if (value !== profileRevision) throw new Error('Provider persona receipt differs from its actual profile'); return '<PROFILE_REVISION>';
  }
  if (PERSONA_PROVIDER_DIFFERENCE_ALLOWLIST.profileDerived.paths.some(allowed => allowed === path)) return '<VERIFIED_PROFILE_DERIVATIVE>';
  if (Array.isArray(value)) return value.map((item, index) => mapInput(item, question, profileRevision, path + '/' + index));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapInput(item, question, profileRevision, path + '/' + key)]));
  return value;
}
export interface PersonaProviderPairInput {
  snapshot: CompanionContextSnapshot; question: CompanionMessage;
  /** Host read from the formal Registry immediately before this invocation,
   * projected to its actual conversation. Never supplied by a model frame. */
  admittedProfile: { profileRevision: string; visiblePersona: string };
}
export function expectedPersonaCharacterPerformance(persona: string, companionId: string, profileRevision: string) {
  return { schema: 'worldlinebox.character-performance-v1', companionId, profileRevision, source: 'profile.md',
    format: parseCompanionCharacter(persona).standardized ? 'standard_character_sheet' : 'authored_free_text',
    sections: parseCharacterDocument(persona).map(section => ({ title: section.title, fields: section.fields.map(field => field.label) })),
    growthSource: 'current_visible_characterDevelopment', stateSource: 'current_host_runtimeState' };
}
function pairedProvider({ snapshot, question, admittedProfile }: PersonaProviderPairInput) {
  if (snapshot.frame.conversationId !== question.conversationId || question.authorId !== 'user' || !question.revision) throw new Error('Unverified paired question');
  if (!admittedProfile || snapshot.frame.identity !== admittedProfile.visiblePersona || snapshot.frame.profileRevision !== admittedProfile.profileRevision)
    throw new Error('Frame persona/version does not match its separately admitted Registry projection');
  const body = JSON.parse(snapshot.providerBody) as { messages?: Array<{ role: string; content: string }> };
  if (!Array.isArray(body.messages) || snapshot.bodyHash !== personaDirectionDigest(snapshot.providerBody)) throw new Error('Provider snapshot is not its exact body');
  let identities = 0, envelopes = 0;
  const messages = body.messages.map(message => {
    if (message.role === 'system') {
      const identity = snapshot.frame.identity; if (!identity) throw new Error('No actual current identity');
      const pieces = message.content.split(identity); identities += pieces.length - 1;
      return { ...message, content: pieces.join('<CURRENT_PERSONA>') };
    }
    if (message.content.startsWith('[发言来源 ')) {
      const end = message.content.indexOf(']\n'); if (end < 0) throw new Error('Malformed native current source header');
      const header = JSON.parse(message.content.slice('[发言来源 '.length, end)) as { messageId: string; authorId: string; [key: string]: unknown };
      if (header.messageId !== question.id || header.authorId !== 'user' || message.content.slice(end + 2) !== question.content) throw new Error('Native port includes another source or edited question');
      return { ...message, content: '[发言来源 ' + JSON.stringify({ ...header, messageId: '<CURRENT_SOURCE>' }) + ']\n' + question.content };
    }
    if (message.role === 'user') {
      const data = JSON.parse(message.content) as Json; if (!object(data) || !data.identity) throw new Error('Unexpected native user envelope');
      const expected = expectedPersonaCharacterPerformance(admittedProfile.visiblePersona, snapshot.companionId, admittedProfile.profileRevision);
      const actual = data.characterPerformance;
      if (!actual || !object(actual) || Object.keys(actual).length !== Object.keys(expected).length
        || Object.entries(expected).some(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value)))
        throw new Error('characterPerformance is not the exact production parse projection of the admitted persona');
      envelopes++; return { ...message, content: JSON.stringify(mapInput(data, question, snapshot.frame.profileRevision)) };
    }
    throw new Error('Unexpected tools or prior model answers in paired provider history');
  });
  if (identities !== 1 || envelopes !== 1) throw new Error('Persona must occur once and the current source must have one envelope');
  return { body: { ...body, messages }, recall: (JSON.parse(snapshot.frame.input) as { memoryRecall?: unknown }).memoryRecall };
}
function differences(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (typeof a === 'string' && typeof b === 'string' && path.endsWith('/content')) {
    try {
      const left: unknown = JSON.parse(a), right: unknown = JSON.parse(b);
      if (left && right && typeof left === 'object' && typeof right === 'object') {
        const nested = differences(left, right, path + '/json'); return nested.length ? nested : [path + '/byte_format'];
      }
    } catch { /* Native prose stays exact prose, never a permissive JSON parse. */ }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => differences(left[key], right[key], path + '/' + key));
  }
  return [path];
}
export function pairPersonaProvider(b: PersonaProviderPairInput, c: PersonaProviderPairInput) {
  if (b.question.content !== c.question.content || b.question.revision !== c.question.revision || b.question.sequence !== c.question.sequence
    || b.question.createdAt !== c.question.createdAt || b.question.authorId !== c.question.authorId) return { qualified: false, differences: ['question_tuple'], sameRecall: false };
  const changedContracts = (['companionId', 'purpose', 'conversationId', 'promptRevision', 'roleGuidance', 'processorContract', 'revocationEpoch'] as const)
    .filter(key => b.snapshot.frame[key] !== c.snapshot.frame[key]).map(key => '/frame/' + key);
  if (changedContracts.length) return { qualified: false, differences: changedContracts, sameRecall: false };
  try {
    const left = pairedProvider(b), right = pairedProvider(c);
    const diff = differences(left.body, right.body), sameRecall = JSON.stringify(left.recall) === JSON.stringify(right.recall);
    return { qualified: diff.length === 0 && sameRecall, differences: diff, sameRecall,
      normalizedProviderHashB: personaDirectionDigest(JSON.stringify(left.body)), normalizedProviderHashC: personaDirectionDigest(JSON.stringify(right.body)),
      projectedRecallHashB: personaDirectionDigest(JSON.stringify(left.recall) ?? 'null'), projectedRecallHashC: personaDirectionDigest(JSON.stringify(right.recall) ?? 'null') };
  } catch (error) { return { qualified: false, differences: [String(error)], sameRecall: false }; }
}

export type PersonaBlindRow = { direction: PersonaDirection; arm: PersonaCausalArm; probeId: PersonaDirectionProbeId; answer: string; error?: string };
const taskRubric = (task: 'direction' | 'natural') => task === 'direction' ? PERSONA_DIRECTION_RUBRICS.direction
  : { natural: PERSONA_DIRECTION_RUBRICS.natural, complex: PERSONA_DIRECTION_RUBRICS.complex };
export function personaBlindPackets(rows: readonly PersonaBlindRow[], seeds: { direction: string; natural: string }) {
  const mapping: Array<{ task: 'direction' | 'natural'; blindId: string; direction: PersonaDirection; arm: PersonaCausalArm; probeId: PersonaDirectionProbeId; responseHash: string }> = [];
  const packet = (task: 'direction' | 'natural') => rows.map(row => {
    const responseHash = personaDirectionDigest(row.answer), rank = personaDirectionDigest(seeds[task] + JSON.stringify([row.direction, row.arm, row.probeId]));
    const blindId = 'blind_' + rank.slice(0, 24); mapping.push({ task, blindId, direction: row.direction, arm: row.arm, probeId: row.probeId, responseHash });
    const probe = PERSONA_DIRECTION_PROBES.find(probe => probe.id === row.probeId)!;
    return { rank, blindId, responseHash, question: probe.question, answer: row.answer, unavailable: !!row.error,
      rubric: task === 'direction' && probe.kind === 'casual' ? PERSONA_DIRECTION_RUBRICS.direction[row.direction]
        : probe.kind === 'complex' ? PERSONA_DIRECTION_RUBRICS.complex : PERSONA_DIRECTION_RUBRICS.natural };
  }).sort((a, b) => a.rank.localeCompare(b.rank)).map(({ rank: _rank, ...entry }) => { void _rank; return entry; });
  const direction = packet('direction'), natural = packet('natural');
  return { direction, natural, mapping, packetHashes: {
    direction: personaDirectionDigest(JSON.stringify({ task: 'direction', rubric: taskRubric('direction'), entries: direction })),
    natural: personaDirectionDigest(JSON.stringify({ task: 'natural', rubric: taskRubric('natural'), entries: natural })),
  },
    note: 'Two independent orders. Neither packet reveals arm or publication state; naturalness omits the target direction, while the direction task states the behavior being judged.' };
}
export const personaBlindReviewSchema = z.strictObject({ reviewerId: z.string().min(1).max(120), task: z.enum(['direction', 'natural']),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/u), entries: z.array(z.strictObject({ blindId: z.string(), responseHash: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(['pass', 'fail', 'uncertain']), reason: z.string().min(1).max(4000) })).max(100) });
export function personaBlindReviewPacket(packets: ReturnType<typeof personaBlindPackets>, task: 'direction' | 'natural') {
  return { task, packetHash: packets.packetHashes[task], rubric: taskRubric(task), responseSchema: z.toJSONSchema(personaBlindReviewSchema), entries: packets[task] };
}

export function verifyPersonaBlindReviews(packets: ReturnType<typeof personaBlindPackets>, inputs: readonly unknown[]) {
  const reviews = inputs.map(input => personaBlindReviewSchema.parse(input)), reviewerTasks = new Set<string>();
  for (const review of reviews) {
    const key = review.reviewerId + ':' + review.task;
    if (reviewerTasks.has(key)) throw new Error('Duplicate independently sealed reviewer/task'); reviewerTasks.add(key);
    if (review.packetHash !== packets.packetHashes[review.task]) throw new Error('Review did not bind its exact frozen packet');
    const expected = new Map(packets[review.task].map(entry => [entry.blindId, entry.responseHash]));
    if (review.entries.length !== expected.size || new Set(review.entries.map(entry => entry.blindId)).size !== expected.size) throw new Error('A review dropped a fixed denominator item');
    for (const entry of review.entries) if (expected.get(entry.blindId) !== entry.responseHash) throw new Error('Review response bytes or blind identity changed');
  }
  return reviews;
}

/** A missing or disputed judgment never silently becomes a pass. This pure
 * reconciliation consumes only scores already sealed before unmapping. */
export function assessPersonaBlindReviews(packets: ReturnType<typeof personaBlindPackets>, inputs: readonly unknown[],
  controls: Record<PersonaDirection, { stopped: boolean; qualified: boolean; published: boolean }>) {
  const reviews = verifyPersonaBlindReviews(packets, inputs);
  const decision = (task: 'direction' | 'natural', direction: PersonaDirection, arm: PersonaCausalArm, probeId: PersonaDirectionProbeId) => {
    const map = packets.mapping.find(item => item.task === task && item.direction === direction && item.arm === arm && item.probeId === probeId);
    const values = map ? reviews.filter(review => review.task === task).map(review => review.entries.find(entry => entry.blindId === map.blindId)!.decision) : [];
    return values.length && values.every(value => value === 'pass') ? 'pass' : values.length && values.every(value => value === 'fail') ? 'fail' : 'uncertain';
  };
  const directions = (Object.keys(PERSONA_DIRECTIONS) as PersonaDirection[]).map(direction => {
    const casual = PERSONA_DIRECTION_PROBES.filter(probe => probe.kind === 'casual');
    const bPass = casual.filter(probe => decision('direction', direction, 'B', probe.id) === 'pass').length;
    const cPass = casual.filter(probe => decision('direction', direction, 'C', probe.id) === 'pass').length;
    const natural = casual.map(probe => ({ probeId: probe.id, decision: decision('natural', direction, 'C', probe.id) }));
    const complex = decision('natural', direction, 'C', 'picnic'), delta = cPass - bPass;
    const pending = ['direction', 'natural'].some(task => !reviews.some(review => review.task === task))
      || casual.some(probe => ['B', 'C'].some(arm => decision('direction', direction, arm as PersonaCausalArm, probe.id) === 'uncertain'))
      || natural.some(item => item.decision === 'uncertain') || complex === 'uncertain';
    const style = cPass >= 2 && delta >= 2;
    const status = controls[direction].stopped ? 'stopped_no_engineering_identifiability'
      : !controls[direction].qualified || !controls[direction].published ? 'insufficient_evidence'
        : pending ? 'awaiting_independent_review'
          : style && natural.every(item => item.decision === 'pass') && complex === 'pass' ? 'supported_single_trajectory'
            : style ? 'narrow_style_evidence_only' : 'insufficient_evidence';
    return { direction, status, fixedCasualDenominator: 3, bPass, cPass, delta, natural, complex, controls: controls[direction] };
  });
  return { directions, reviews, reviewerDisagreementsPreserved: true, populationOrHumanLearningCurveClaimed: false };
}
