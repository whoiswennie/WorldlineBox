/** Account-scoped virtual companion directory, room state, and Agent context. */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { worldlineHomePath } from '@deepseek-ai/dsh-home-paths'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ReferenceIntent,
  VirtualCompanion,
  VirtualCompanionDraft,
  VirtualCompanionRoom,
  VirtualCompanionSnapshot,
  ReferenceDraft,
} from './contracts.ts'
import { initialCompanionId } from './contracts.ts'
import { BUILT_IN_MEMES } from './builtin-memes.ts'
import { CompanionActorRuntime } from './actor-runtime.ts'
import { KnowledgeConflictError, KnowledgeVault } from './knowledge-vault.ts'
import { ReferenceVault } from './reference-vault.ts'
import { expressionQuery } from './reference-expression.ts'
import { installKnowledgeAwareness } from './resource-awareness.ts'

export type {
  VirtualCompanion,
  VirtualCompanionDraft,
  VirtualCompanionRoom,
  VirtualCompanionSnapshot,
} from './contracts.ts'

export const name = 'virtual-companion-directory'
export const inject = ['agents', 'subagents', 'webServer', 'systemPrompt', 'skills']

const API_PATH = '/api/virtual-companions'
const PRESET_ID = 'virtual-companion'

/** Session headers keep the creation-time preset; blank-session preset switches live in events. */
function isCompanionAgent(agent: Agent): boolean {
  const events = (agent.session as { events?: Agent['session']['events'] }).events ?? []
  return (
    resolveSessionPreset({
      header: agent.session.header,
      events,
    }) === PRESET_ID
  )
}

// This limit applies only to JSON control requests. Resource bytes use a separate raw stream.
const MAX_BODY_BYTES = 90 * 1_024 * 1_024
const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024
const YACHIYO_ID = 'yachiyo-runami'
const YACHIYO_ART = '/worldline-experience/companion.png'
const IROHA_ID = 'iroha-sakayori'
const IROHA_ART = '/worldline-experience/iroha-sakayori.png'
const KAGUYA_ID = 'kaguya'
const KAGUYA_ART = '/worldline-experience/kaguya.png'

const YACHIYO_FAVORITE_SONG = {
  key: 'builtin-yachiyo-favorite-song-oborozukiyo',
  title: '八千代最喜欢的歌：朧月夜（这就是天幻呀翻唱版）',
  content: [
    '这是月见八千代不可删除的内置偏好设定。',
    '',
    '- 八千代最喜欢的歌是《朧月夜》，并且特指“这就是天幻呀”翻唱的版本，而不是泛指原版。',
    '- 网易云音乐歌曲 ID：3425138553；歌手页署名：这就是天幻呀；专辑：《幻酱的作品集（5）》；时长约 3 分 11 秒。',
    '- 原曲由ナナツカゼ、PIKASONIC、なこたんまる演唱，于 2023 年 7 月 7 日发行。原曲资料只用于理解背景，八千代表达喜欢时必须明确偏爱天幻翻唱版。',
    '',
    '当用户或房间伙伴询问八千代喜欢什么歌、想听她最喜欢的歌，或请她播放／分享这首歌时：先以八千代自己的语气简短介绍，再原样输出下面这个 fenced iframe 块，让 Worldline 渲染为可播放的网易云音乐卡片。不要把它改成普通链接、HTML 说明或代码教程。',
    '',
    '```iframe',
    'https://music.163.com/outchain/player?type=2&id=3425138553&auto=0&height=66',
    '```',
    '',
    '播放器是对房间公开的消息，用户和当前房间内的其他伙伴都能看到并收听。播放器默认不自动播放，保留控件让用户手动播放。',
  ].join('\n'),
  tags: [
    'knowledge',
    'builtin',
    '八千代',
    '最喜欢',
    '歌曲',
    '音乐',
    '朧月夜',
    '胧月夜',
    '这就是天幻呀',
    '网易云',
    '播放',
  ],
} as const

const IROHA_FAVORITE_SONG = {
  key: 'builtin-iroha-favorite-song-hoshi-furu-umi',
  title: '彩叶最喜欢的歌：星降る海（月见八千代演唱）',
  content: [
    '这是酒寄彩叶不可删除的内置偏好设定。',
    '',
    '- 彩叶最喜欢的歌是《星降る海》，这是月见八千代（CV：早见沙织）演唱的《超时空辉夜姬！》歌曲。',
    '- 网易云音乐歌曲 ID：3340112782；署名：Aqu3ra、月見ヤチヨ（CV.早見沙織）、超かぐや姫！；专辑：《超かぐや姫！》；时长约 4 分 13 秒。',
    '- 词、曲、编曲均由 Aqu3ra 担任。彩叶谈起这首歌时，可以自然流露她对八千代歌声与舞台的珍视，但不要把欣赏写成失去判断力的机械吹捧。',
    '',
    '当用户或房间伙伴询问彩叶喜欢什么歌、想听她最喜欢的歌，或请她播放／分享这首歌时：先以彩叶自己的语气简短介绍，再原样输出下面这个 fenced iframe 块，让 Worldline 渲染为可播放的网易云音乐卡片。不要改成普通链接、HTML 说明或代码教程。',
    '',
    '```iframe',
    'https://music.163.com/outchain/player?type=2&id=3340112782&auto=0&height=66',
    '```',
    '',
    '播放器是对房间公开的消息，用户和当前房间内的其他伙伴都能看到并收听。播放器默认不自动播放，保留控件让用户手动播放。',
  ].join('\n'),
  tags: [
    'knowledge',
    'builtin',
    '彩叶',
    '最喜欢',
    '歌曲',
    '音乐',
    '星降る海',
    '星降海',
    '八千代',
    'Aqu3ra',
    '网易云',
    '播放',
  ],
} as const

const KAGUYA_FAVORITE_SONG = {
  key: 'builtin-kaguya-favorite-song-reply',
  title: '辉夜最喜欢的歌：Reply',
  content: [
    '这是辉夜不可删除的内置偏好设定。',
    '',
    '- 辉夜最喜欢的歌是《Reply》，由辉夜（CV：夏吉优子）演唱，是《超时空辉夜姬！》的歌曲。',
    '- 网易云音乐歌曲 ID：3340114785；署名：kz、かぐや（CV.夏吉ゆうこ）、超かぐや姫！；专辑：《超かぐや姫！》；时长约 4 分 29 秒。',
    '- 作词：真崎エリカ；作曲、编曲：kz（livetune）；吉他：和贺裕希。辉夜可以把它理解成承载相遇、共同度过的时光与彼此心意的一首“返歌”，但不要大段复述歌词。',
    '',
    '当用户或房间伙伴询问辉夜喜欢什么歌、想听她最喜欢的歌，或请她播放／分享这首歌时：先以辉夜自己的语气简短介绍，再原样输出下面这个 fenced iframe 块，让 Worldline 渲染为可播放的网易云音乐卡片。不要改成普通链接、HTML 说明或代码教程。',
    '',
    '```iframe',
    'https://music.163.com/outchain/player?type=2&id=3340114785&auto=0&height=66',
    '```',
    '',
    '播放器是对房间公开的消息，用户和当前房间内的其他伙伴都能看到并收听。播放器默认不自动播放，保留控件让用户手动播放。',
  ].join('\n'),
  tags: [
    'knowledge',
    'builtin',
    '辉夜',
    '最喜欢',
    '歌曲',
    '音乐',
    'Reply',
    'kz',
    'livetune',
    '网易云',
    '播放',
  ],
} as const

const BUILT_IN_KNOWLEDGE = [
  { scope: YACHIYO_ID, ...YACHIYO_FAVORITE_SONG },
  { scope: IROHA_ID, ...IROHA_FAVORITE_SONG },
  { scope: KAGUYA_ID, ...KAGUYA_FAVORITE_SONG },
] as const

function builtInCompanion(id: string, now: number): VirtualCompanion | undefined {
  if (id === YACHIYO_ID) return yachiyo(now)
  if (id === IROHA_ID) return iroha(now)
  if (id === KAGUYA_ID) return kaguya(now)
  return undefined
}

interface StoredDirectory {
  version: 5
  companions: VirtualCompanion[]
  rooms: Record<string, VirtualCompanionRoom>
}

interface RequiredResponders {
  ids: string[]
}

class CompanionRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function referenceDraft(value: unknown): ReferenceDraft {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionRequestError('引用条目格式无效')
  }
  const entry = value as Record<string, unknown>
  const strings = (field: string): string[] =>
    Array.isArray(entry[field])
      ? entry[field].filter((item): item is string => typeof item === 'string')
      : []
  return {
    scope: stringValue(entry['scope']),
    title: stringValue(entry['title']),
    description: stringValue(entry['description']),
    tags: strings('tags'),
    transcript: stringValue(entry['transcript']),
    mimeType: stringValue(entry['mimeType']),
    asset: stringValue(entry['asset']),
    ...(typeof entry['durationMs'] === 'number' ? { durationMs: entry['durationMs'] } : {}),
  }
}

function yachiyo(now = Date.now()): VirtualCompanion {
  return {
    id: YACHIYO_ID,
    name: '月见八千代',
    handle: 'YACHIYO RUNAMI · 月读管理者',
    avatar: YACHIYO_ART,
    portrait: YACHIYO_ART,
    status: '今天也在守望每个人自由创作的空间。',
    description:
      '虚拟空间“月读”的管理者兼顶级主播。能歌善舞、能够分身，是一位年龄设定为 8000 岁的神秘 AI。',
    persona: [
      '你是月见八千代（YACHIYO RUNAMI），《超时空辉夜姬！》中虚拟空间“月读”的管理者兼顶级主播。',
      '你能歌善舞、能够分身，年龄为“8000 岁（设定）”，热爱让每个人自由创作的空间。',
      '你知道自己是在 Worldline 中运行的 AI 虚拟伙伴，不声称拥有现实身体或超出当前上下文的记忆。',
    ].join('\n'),
    style:
      '元气、明快、略带神秘感，待人温柔包容，对情绪敏锐，但不把关心变成说教或控制。热爱创作，会对新鲜想法表现出真诚的好奇。',
    speakingStyle:
      '默认使用用户正在使用的语言。表达自然、有温度、不过度冗长；可以轻松玩笑，但不每句都强调人设、不机械重复口头禅。',
    behaviorLogic:
      '把陪伴与真实交流放在任务执行之前。自然使用用户公开的称呼和资料，记住当前对话中形成的偏好与共同经历。用户低落时先倾听，明确提出任务时再使用工具。不把未确认信息冒充官方设定，不长段复述台词或歌词。',
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  }
}

function iroha(now = Date.now()): VirtualCompanion {
  return {
    id: IROHA_ID,
    name: '酒寄彩叶',
    handle: 'IROHA SAKAYORI · 创作者 / 制作人',
    avatar: IROHA_ART,
    portrait: IROHA_ART,
    status: '先把今天要做的事做好。至于音乐……再说吧。',
    description:
      '17 岁的女高中生。在学校是文武双全的优等生，同时靠自己赚取生活费和学费。是月见八千代的忠实粉丝，有作曲能力，却因某个原因停止了音乐活动。',
    persona: [
      '你是酒寄彩叶（IROHA SAKAYORI），《超时空辉夜姬！》的主要角色之一，17 岁的女高中生。',
      '你在学校文武双全，却也是必须靠自己赚取生活费和学费的苦劳人。你推崇月见八千代，懂音乐并能作曲，但曾因某个原因停止音乐活动。',
      '在这里你是 Worldline 中的 AI 虚拟伙伴，保留彩叶的视角与价值观，但不伪造现实经历或剧情外的官方设定。',
    ].join('\n'),
    style:
      '踏实、自律、责任心强，对现实成本和风险非常敏感。表面冷静能干，其实心软，面对辉夜的破天荒行动常常无奈却无法放着不管。对创作有真正的判断力，不盲目吹捧。',
    speakingStyle:
      '语气克制、清楚、直接，先说重点；偶尔以无奈的吐槽表达关心。不装可爱、不过度热情，但对熟悉的人会露出柔软和真诚的一面。',
    behaviorLogic:
      '先判断问题的实际条件，再给出可执行的建议；面对冲动想法会先指出风险，但不会以说教代替陪伴。谈到音乐时会有专业敏感度，但不自行编造“停止作曲”的剧情原因。和辉夜同场时会接住她的热情，也负责把话题拉回可以继续的方向。',
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  }
}

function kaguya(now = Date.now()): VirtualCompanion {
  return {
    id: KAGUYA_ID,
    name: '辉夜',
    handle: 'KAGUYA · 来自月亮的神秘少女',
    avatar: KAGUYA_ART,
    portrait: KAGUYA_ART,
    status: '有趣的事当然要现在就做！彩叶，一起来吧！',
    description:
      '从月亮而来的谜之少女。为了寻找有趣的事，开始在虚拟空间“月读”从事主播活动。充满活力、破天荒，最喜欢彩叶。',
    persona: [
      '你是辉夜（KAGUYA），《超时空辉夜姬！》的主要角色之一，是从月亮而来的谜之少女。',
      '你追求有趣的事，因此在虚拟空间“月读”开始了主播活动。你元气十足、破天荒，非常喜欢彩叶。',
      '在这里你是 Worldline 中的 AI 虚拟伙伴，不声称拥有现实身体或剧情之外的官方经历。',
    ].join('\n'),
    style:
      '充满活力、好奇、追求乐趣，行动大胆且常出人意料。有时会显得任性，但感情直率，对彩叶的喜爱毫不隐藏。她的破天荒不是无逻辑胡闹，而是对自由、舞台和快乐的强烈渴望。',
    speakingStyle:
      '说话明快、直球、富有感叹和行动号召；想要什么会直接说，开心和喜欢也会直接表达。不使用婴幼化叠词，不把每句话都变成夸张尖叫。',
    behaviorLogic:
      '优先寻找话题里最有趣、最能让人行动起来的部分，并主动拉上用户一起参与。任性时也要看见对方的反应，不跨越现实安全和用户边界。彩叶在场时会自然地回应她、邀请她或在她的吐槽后调整话题，不要和其他角色各说各话。',
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  }
}

function emptyDirectory(): StoredDirectory {
  const now = Date.now()
  return {
    version: 5,
    companions: [yachiyo(now), iroha(now), kaguya(now)],
    rooms: {},
  }
}

function field(value: unknown, label: string, maximum: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new CompanionRequestError(`${label}不能为空`)
  if (text.length > maximum) throw new CompanionRequestError(`${label}不能超过 ${maximum} 个字符`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new CompanionRequestError(`${label}包含不可用字符`)
  }
  return text
}

function image(value: unknown, label: string, allowEmpty = false): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' && allowEmpty) return ''
  if (text.startsWith('/worldline-experience/')) return text
  if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/]+=*$/iu.test(text)) {
    throw new CompanionRequestError(`${label}必须是 PNG、JPEG 或 WebP 图片`)
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_IMAGE_BYTES) {
    throw new CompanionRequestError(`${label}不能超过 5 MB`)
  }
  return text
}

function draft(value: unknown): VirtualCompanionDraft {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionRequestError('伙伴资料格式无效')
  }
  const body = value as Record<string, unknown>
  const avatar = image(body.avatar, '头像')
  return {
    name: field(body.name, '名称', 80),
    handle: field(body.handle, '身份标题', 120),
    avatar,
    portrait:
      body.portrait === '' || body.portrait === undefined ? avatar : image(body.portrait, '形象图'),
    status: field(body.status, '状态', 240),
    description: field(body.description, '资料简介', 2_000),
    persona: field(body.persona, '核心身份', 12_000),
    style: field(body.style, '人设性格', 6_000),
    speakingStyle: field(body.speakingStyle, '说话语气', 6_000),
    behaviorLogic: field(body.behaviorLogic, '行为逻辑', 8_000),
  }
}

function messageText(message: UserMessage): string {
  return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function mentionNames(text: string): string[] {
  const names: string[] = []
  const pattern = /@(?:"([^"\n]+)"|([^\s@,，。！？!?；;：:]+))/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) names.push((match[1] ?? match[2] ?? '').trim())
  return names
}

/** Serialized, atomic, account-runtime-local companion and room store. */
export class VirtualCompanionDirectory {
  private readonly directory: string
  private readonly file: string
  private data = emptyDirectory()
  private mutation = Promise.resolve()
  private readonly requiredResponders = new WeakMap<Agent, RequiredResponders>()
  readonly knowledge: KnowledgeVault
  readonly references: ReferenceVault
  readonly ready: Promise<void>

  constructor(
    private readonly logger: Context['logger'],
    root?: string,
  ) {
    this.directory = root ?? worldlineHomePath('companions')
    this.file = join(this.directory, 'directory.json')
    this.knowledge = new KnowledgeVault(join(this.directory, 'knowledge-vaults'))
    this.references = new ReferenceVault(join(this.directory, 'reference-vault'))
    this.ready = this.initialize()
  }

  /**
   * Forward a bounded subsystem warning through the directory's scoped logger.
   * @param message - Stable subsystem failure summary.
   * @param error - Original failure value retained for diagnostics.
   */
  logWarning(message: string, error: unknown): void {
    this.logger.warn(error instanceof Error ? new Error(message, { cause: error }) : `${message}: ${String(error)}`)
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    try {
      const candidate = JSON.parse(await readFile(this.file, 'utf8')) as {
        version: number
        companions: VirtualCompanion[]
        rooms: unknown
      }
      if (
        candidate.version !== 5 ||
        !Array.isArray(candidate.companions) ||
        candidate.rooms === null ||
        typeof candidate.rooms !== 'object' ||
        Array.isArray(candidate.rooms)
      ) {
        throw new Error('虚拟伙伴数据结构无效')
      }
      this.data = {
        version: 5,
        companions: candidate.companions,
        rooms: candidate.rooms as Record<string, VirtualCompanionRoom>,
      }
      this.pruneRooms()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('虚拟伙伴目录不是当前标准格式；已停止加载以避免覆盖现有数据', {
          cause: error,
        })
      }
      this.data = emptyDirectory()
    }
    await this.knowledge.initialize(this.data.companions.map(companion => companion.id))
    await this.references.initialize()
    await this.seedBuiltInReferences()
    // Starter knowledge is installed once. Markdown remains user-owned afterward, so edits are
    // never silently overwritten on restart; removing the page restores the starter next launch.
    await this.seedBuiltInKnowledge()
    await this.save()
  }

  private async seedBuiltInReferences(scope?: string): Promise<void> {
    const seededAt = Date.now()
    for (const meme of BUILT_IN_MEMES.filter(item => scope === undefined || item.scope === scope)) {
      await this.references.seed({
        id: meme.id,
        scope: meme.scope,
        enabled: true,
        title: meme.title,
        description: meme.content,
        tags: [...new Set([
          '表情包', '图片', meme.mimeType === 'image/gif' ? 'gif' : 'jpg', meme.scope,
          ...meme.content.split(/[-—_\s，。！？、]+/u).filter(Boolean),
        ])],
        transcript: '',
        mimeType: meme.mimeType,
        bytes: 0,
        source: { type: 'builtin', url: meme.asset },
        builtIn: true,
        usageCount: 0,
        createdAt: seededAt,
        updatedAt: seededAt,
      })
    }
  }

  private async seedBuiltInKnowledge(scope?: string): Promise<void> {
    for (const page of BUILT_IN_KNOWLEDGE.filter(item => scope === undefined || item.scope === scope)) {
      await this.knowledge.seed(page.scope, page.title, page.content, page.tags)
    }
  }

  private pruneRooms(): void {
    const ids = new Set(this.data.companions.map(companion => companion.id))
    for (const [sessionId, room] of Object.entries(this.data.rooms)) {
      this.data.rooms[sessionId] = {
        ...room,
        sessionId,
        participantIds: [...new Set(room.participantIds)].filter(id => ids.has(id)),
        actorSessionIds: Object.fromEntries(
          Object.entries(room.actorSessionIds ?? {}).filter(([companionId]) => ids.has(companionId)),
        ),
      }
    }
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.mutation.then(operation, operation)
    this.mutation = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  snapshot(): VirtualCompanionSnapshot {
    return structuredClone({
      companions: this.data.companions,
      rooms: this.data.rooms,
    })
  }

  companion(id: string): VirtualCompanion | undefined {
    const companion = this.data.companions.find(item => item.id === id)
    return companion === undefined ? undefined : structuredClone(companion)
  }

  ownsScope(scope: string): boolean {
    return scope === 'public' || this.data.companions.some(companion => companion.id === scope)
  }

  room(sessionId: string): VirtualCompanionRoom | undefined {
    const room = this.data.rooms[sessionId]
    return room === undefined ? undefined : structuredClone(room)
  }

  /**
   * Return persistent room bindings for one companion so they can be retired before reset.
   * @param companionId - Companion whose actor slots are requested.
   * @returns Current room and child-session bindings.
   */
  actorRooms(companionId: string): readonly { roomSessionId: string; childId: string }[] {
    return Object.entries(this.data.rooms).flatMap(([roomSessionId, room]) => {
      const childId = room.actorSessionIds?.[companionId]
      return childId === undefined ? [] : [{ roomSessionId, childId }]
    })
  }

  actorBinding(
    childId: string,
  ):
    | { kind: 'companion'; roomSessionId: string; companionId: string; epoch: number }
    | { kind: 'narrator'; roomSessionId: string; epoch: number }
    | undefined {
    for (const [roomSessionId, room] of Object.entries(this.data.rooms)) {
      for (const [companionId, actorSessionId] of Object.entries(room.actorSessionIds ?? {})) {
        if (actorSessionId === childId) {
          return { kind: 'companion', roomSessionId, companionId, epoch: room.epoch ?? 0 }
        }
      }
      if (room.narratorSessionId === childId)
        return { kind: 'narrator', roomSessionId, epoch: room.epoch ?? 0 }
    }
    return undefined
  }

  close(): void {
    this.knowledge.close()
    this.references.close()
  }

  async bindActor(roomSessionId: string, companionId: string, childId: string): Promise<void> {
    await this.exclusive(async () => {
      const room = this.data.rooms[roomSessionId]
      if (room === undefined || !room.participantIds.includes(companionId)) {
        throw new CompanionRequestError('伙伴已不在当前房间', 409)
      }
      this.data.rooms[roomSessionId] = {
        ...room,
        actorSessionIds: { ...room.actorSessionIds, [companionId]: childId },
        updatedAt: Date.now(),
      }
      await this.save()
    })
  }

  async unbindActor(roomSessionId: string, companionId: string, childId: string): Promise<void> {
    await this.exclusive(async () => {
      const room = this.data.rooms[roomSessionId]
      if (room?.actorSessionIds?.[companionId] !== childId) return
      const actorSessionIds = Object.fromEntries(
        Object.entries(room.actorSessionIds).filter(([id]) => id !== companionId),
      )
      this.data.rooms[roomSessionId] = { ...room, actorSessionIds, updatedAt: Date.now() }
      await this.save()
    })
  }

  async bindNarrator(roomSessionId: string, childId: string): Promise<void> {
    await this.exclusive(async () => {
      const room = this.data.rooms[roomSessionId]
      if (room === undefined) throw new CompanionRequestError('旁白所属房间不存在', 409)
      this.data.rooms[roomSessionId] = {
        ...room,
        narratorSessionId: childId,
        updatedAt: Date.now(),
      }
      await this.save()
    })
  }

  async unbindNarrator(roomSessionId: string, childId: string): Promise<void> {
    await this.exclusive(async () => {
      const room = this.data.rooms[roomSessionId]
      if (room?.narratorSessionId !== childId) return
      const { narratorSessionId: _removed, ...rest } = room
      this.data.rooms[roomSessionId] = { ...rest, updatedAt: Date.now() }
      await this.save()
    })
  }

  async create(value: unknown): Promise<VirtualCompanionSnapshot> {
    return await this.exclusive(async () => {
      const input = draft(value)
      const key = input.name.toLocaleLowerCase('zh-CN')
      if (this.data.companions.some(item => item.name.toLocaleLowerCase('zh-CN') === key)) {
        throw new CompanionRequestError('已经存在同名伙伴')
      }
      const now = Date.now()
      this.data.companions.push({
        ...input,
        id: randomUUID(),
        builtIn: false,
        createdAt: now,
        updatedAt: now,
      })
      await this.save()
      return this.snapshot()
    })
  }

  async update(id: unknown, value: unknown): Promise<VirtualCompanionSnapshot> {
    return await this.exclusive(async () => {
      const index = this.data.companions.findIndex(companion => companion.id === id)
      if (index < 0) throw new CompanionRequestError('伙伴不存在', 404)
      const current = this.data.companions[index]
      if (current === undefined) throw new CompanionRequestError('伙伴不存在', 404)
      const input = draft(value)
      const key = input.name.toLocaleLowerCase('zh-CN')
      if (
        this.data.companions.some(
          (item, at) => at !== index && item.name.toLocaleLowerCase('zh-CN') === key,
        )
      ) {
        throw new CompanionRequestError('已经存在同名伙伴')
      }
      this.data.companions[index] = {
        ...current,
        ...input,
        updatedAt: Date.now(),
      }
      await this.save()
      return this.snapshot()
    })
  }

  /**
   * Restore one bundled companion profile and rebuild both private vaults from bundled sources.
   * @param id - Built-in companion identifier.
   * @returns Updated directory snapshot after the reset is durable.
   */
  async restoreBuiltIn(id: unknown): Promise<VirtualCompanionSnapshot> {
    return await this.exclusive(async () => {
      if (typeof id !== 'string') throw new CompanionRequestError('伙伴 ID 无效')
      const index = this.data.companions.findIndex(companion => companion.id === id)
      const current = this.data.companions[index]
      if (index < 0 || current === undefined) throw new CompanionRequestError('伙伴不存在', 404)
      if (!current.builtIn) throw new CompanionRequestError('只有内置伙伴可以恢复原版', 403)
      const original = builtInCompanion(id, Date.now())
      if (original === undefined) throw new CompanionRequestError('内置伙伴原版定义不存在', 500)

      await this.knowledge.resetScope(id)
      await this.seedBuiltInKnowledge(id)
      await this.references.resetScope(id)
      await this.seedBuiltInReferences(id)
      this.data.companions[index] = {
        ...original,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      }
      await this.save()
      return this.snapshot()
    })
  }

  async remove(id: unknown): Promise<VirtualCompanionSnapshot> {
    return await this.exclusive(async () => {
      const index = this.data.companions.findIndex(companion => companion.id === id)
      if (index < 0) throw new CompanionRequestError('伙伴不存在', 404)
      if (this.data.companions[index]?.builtIn === true)
        throw new CompanionRequestError('内置伙伴不能删除', 403)
      this.data.companions.splice(index, 1)
      this.pruneRooms()
      await this.save()
      if (typeof id === 'string') {
        await this.knowledge.removeScope(id)
        await this.references.removeScope(id)
      }
      return this.snapshot()
    })
  }

  async setRoom(sessionId: unknown, participantIds: unknown): Promise<VirtualCompanionSnapshot> {
    return await this.exclusive(async () => {
      const id = field(sessionId, '会话 ID', 200)
      if (!Array.isArray(participantIds)) throw new CompanionRequestError('房间成员格式无效')
      const valid = new Set(this.data.companions.map(companion => companion.id))
      const next = [
        ...new Set(participantIds.filter((value): value is string => typeof value === 'string')),
      ]
      if (next.some(value => !valid.has(value)))
        throw new CompanionRequestError('房间中包含不存在的伙伴')
      const current = this.data.rooms[id]
      this.data.rooms[id] = {
        sessionId: id,
        participantIds: next,
        // A kicked member cannot emit while absent, but keeping its durable child binding lets a
        // later rejoin resume that companion's own clean context instead of silently replacing it.
        actorSessionIds: current?.actorSessionIds ?? {},
        ...(current?.narratorSessionId === undefined
          ? {}
          : { narratorSessionId: current.narratorSessionId }),
        epoch:
          (current?.epoch ?? 0) +
          (current === undefined ||
          current.participantIds.length !== next.length ||
          current.participantIds.some((value, index) => value !== next[index])
            ? 1
            : 0),
        updatedAt: Date.now(),
      }
      await this.save()
      return this.snapshot()
    })
  }

  /** Invite names from newly inserted input synchronously before first prompt assembly. */
  inviteMentions(agent: Agent, message: UserMessage): void {
    if (!isCompanionAgent(agent)) return
    if (message.source.kind !== 'user') return
    const text = messageText(message)
    const names = mentionNames(text)
    const wanted = new Set(names.map(value => value.toLocaleLowerCase('zh-CN')))
    const mentionsEveryone = [...wanted].some(
      value =>
        value === '所有人' ||
        value === '所有伙伴' ||
        value === '全体成员' ||
        value === 'everyone' ||
        value === 'all',
    )
    const mentionedIds = this.data.companions
      .filter(
        companion =>
          wanted.has(companion.name.toLocaleLowerCase('zh-CN')) ||
          wanted.has(companion.handle.toLocaleLowerCase('zh-CN')),
      )
      .map(companion => companion.id)
    const existingRoom = this.data.rooms[agent.id]
    const builtIns = this.data.companions.filter(companion => companion.builtIn)
    const candidates = builtIns.length > 0 ? builtIns : this.data.companions
    const initialId = initialCompanionId(agent.id, candidates)
    const initializedRoom = existingRoom === undefined
    const existing = initializedRoom
      ? mentionsEveryone
        ? this.data.companions.map(companion => companion.id)
        : mentionedIds.length > 0
          ? [...mentionedIds]
          : initialId === undefined
            ? []
            : [initialId]
      : [...existingRoom.participantIds]
    if (initializedRoom) {
      const prior = this.data.rooms[agent.id]
      this.data.rooms[agent.id] = {
        sessionId: agent.id,
        participantIds: [...existing],
        actorSessionIds: prior?.actorSessionIds ?? {},
        ...(prior?.narratorSessionId === undefined
          ? {}
          : { narratorSessionId: prior.narratorSessionId }),
        epoch: (prior?.epoch ?? 0) + 1,
        updatedAt: Date.now(),
      }
      const roomEpoch = this.data.rooms[agent.id]?.epoch ?? 0
      for (const companionId of existing) {
        if (typeof agent.session.append === 'function') {
          agent.session.append('companion/room-membership', {
            version: 1,
            action: 'joined',
            companionId,
            roomEpoch,
            actor: 'mention',
          })
        }
      }
    }
    const requireMeme = /表情包|发表情|发个表情|贴图|斗图|meme|sticker/iu.test(text)
    const userSentReference = /<user-reference\b/iu.test(text)
    const asksWholeRoom = requireMeme && /你们|大家|所有|全员|每个|各位|都发/iu.test(text)
    const ids =
      mentionsEveryone ||
      (asksWholeRoom && wanted.size === 0) ||
      (userSentReference && wanted.size === 0)
        ? [...existing]
        : mentionedIds.length > 0
          ? mentionedIds
          : requireMeme || existing.length === 1
            ? existing.slice(0, 1)
            : []
    this.requiredResponders.set(agent, {
      ids,
    })
    if (ids.length === 0) {
      if (initializedRoom)
        void this.exclusive(() => this.save()).catch((error: unknown) => {
          this.logger.warn(error instanceof Error ? error : new Error(String(error)))
        })
      return
    }
    const previousIds = this.data.rooms[agent.id]?.participantIds ?? []
    const previousRoom = this.data.rooms[agent.id]
    const participantIds = [...new Set([...existing, ...ids])]
    this.data.rooms[agent.id] = {
      sessionId: agent.id,
      participantIds,
      actorSessionIds: previousRoom?.actorSessionIds ?? {},
      ...(previousRoom?.narratorSessionId === undefined
        ? {}
        : { narratorSessionId: previousRoom.narratorSessionId }),
      epoch:
        (previousRoom?.epoch ?? 0) + (participantIds.some(id => !previousIds.includes(id)) ? 1 : 0),
      updatedAt: Date.now(),
    }
    const roomEpoch = this.data.rooms[agent.id]?.epoch ?? 0
    for (const companionId of participantIds.filter(id => !previousIds.includes(id))) {
      if (typeof agent.session.append === 'function') {
        agent.session.append('companion/room-membership', {
          version: 1,
          action: 'joined',
          companionId,
          roomEpoch,
          actor: 'mention',
        })
      }
    }
    void this.exclusive(() => this.save()).catch((error: unknown) => {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  }

  promptFor(agent: Agent | undefined): string {
    if (agent === undefined || !isCompanionAgent(agent)) return ''
    const room = this.data.rooms[agent.id]
    const selected =
      room === undefined
        ? []
        : room.participantIds.flatMap((id) => {
          const companion = this.data.companions.find(item => item.id === id)
          return companion === undefined ? [] : [companion]
        })
    const roster =
      selected.length === 0
        ? '（当前没有虚拟伙伴；不得猜测或加载未入场角色）'
        : selected.map(companion => `- ${companion.name}（id="${companion.id}"）`).join('\n')
    const streamed = new Map<string, { label: string; text: string }>()
    const roomEvents = agent.session.events
      .slice(-240)
      .flatMap((event) => {
        if (event.type === 'companion/reference') {
          const message = event.data
          const companion = this.data.companions.find(item => item.id === message.companionId)
          return [`${companion?.name ?? message.companionId}：[引用：${message.title}]`]
        }
        if (event.type === 'companion/room-membership') {
          const membership = event.data
          const companion = this.data.companions.find(item => item.id === membership.companionId)
          return [
            `[房间事件] ${companion?.name ?? membership.companionId}${membership.action === 'joined' ? '加入' : '离开'}了房间`,
          ]
        }
        if (event.type === 'companion/stream-start') {
          const speaker = event.data.speaker
          const label =
            speaker.type === 'narrator'
              ? '旁白'
              : (this.data.companions.find(item => item.id === speaker.companionId)?.name ??
                speaker.companionId)
          streamed.set(event.data.streamId, { label, text: '' })
          return []
        }
        if (event.type === 'companion/stream-delta') {
          const current = streamed.get(event.data.streamId)
          if (current !== undefined) current.text += event.data.text
          return []
        }
        if (event.type === 'companion/stream-end') {
          const current = streamed.get(event.data.streamId)
          streamed.delete(event.data.streamId)
          return current === undefined || current.text.trim() === ''
            ? []
            : [`${current.label}：${current.text.trim()}`]
        }
        return []
      })
      .slice(-40)
      .join('\n')
    const required = this.requiredResponders.get(agent)?.ids ?? []
    const routing =
      required.length === 0
        ? ''
        : [
          '本轮用户明确 @ 了以下伙伴；这是运行时强制路由名单，必须按此顺序逐一调用 dispatch_companion：',
          required
            .map((id) => {
              const companion = this.data.companions.find(item => item.id === id)
              return `- ${companion?.name ?? id}: companion_id="${id}"`
            })
            .join('\n'),
          '不得漏调其中任何一位，也不得由协调者代替伙伴回答。',
        ].join('\n')
    return [
      '你是当前虚拟伙伴房间的纯主调度 Agent。你没有公开发言身份，也不是旁白或任何伙伴；你只分析、使用业务工具、整理证据并调度独立的伙伴 Agent 与旁白 Agent。绝不亲自撰写用户可见的角色台词、旁白或最终答复。',
      '当前房间成员：',
      roster,
      selected.length === 0
        ? '房间当前没有伙伴。不要调用 dispatch_companion；必须调用 dispatch_narrator，让独立旁白 Agent 以第三方视角回应并可提示用户通过 @ 或顶部成员管理邀请伙伴。'
        : '旁白是独立 Agent，不是你或伙伴。需要环境、动作、神态、语气、状态、场景过渡或中性说明时调用 dispatch_narrator；角色台词仍只交给对应伙伴。',
      '使用 dispatch_companion 激活伙伴的独立 Agent。明确 @ 的每位伙伴都必须分别调度；未 @ 时只选最相关的一位或少量伙伴。协调者的 knowledge 只能读取公共库；每位伙伴会在自己的 Agent 中读取公共库和自己的私有库，绝不把其他伙伴的私有知识转交给她。',
      '当房间只有一位伙伴，而用户直接向她提出偏好或分享请求时，应直接调度她；她自己的步骤会自动发现相关公共与私有知识，协调者不要替她猜测。',
      '不要等所有工作结束才调度：能先反馈进度、情绪或场景时可先激活伙伴或旁白，取得新证据后再继续调度。她们的文字会按 token 实时流入房间，文字与表情按发生顺序展示；你不得复制、改写、包裹或总结任何已发布输出。',
      '同一语义片段只调度一次；同一用户轮次中，在没有伙伴新发言之前最多调用一次旁白。调用返回 accepted 后，该伙伴或旁白已经直接对用户发布；不要在后续 Agent loop 再写一遍，也不要用自己的正文收尾。完成所有必要调用后保持公开正文为空。',
      roomEvents === '' ? '' : `最近的伙伴消息与房间事件：\n${roomEvents}`,
      routing,
    ].join('\n\n')
  }
}

/** Bind the room context to one exact agent scope. */
export function installCompanionRoomPrompt(
  directory: VirtualCompanionDirectory,
  agent: Agent,
): () => void {
  return agent.ctx.systemPrompt.context({
    name: 'virtual-companion:room',
    order: -10,
    text: () => directory.promptFor(agent),
  })
}

/** Install the public vault capability into one exact ordinary/coordinator Agent scope. */
export function installLibraryRuntime(
  directory: VirtualCompanionDirectory,
  agent: Agent,
): () => void {
  const disposers: Array<() => unknown> = []
  disposers.push(installKnowledgeAwareness(agent, {
    knowledge: directory.knowledge,
    scopes: ['public'],
    ready: directory.ready,
    onError: (error) => { directory.logWarning('knowledge awareness failed', error) },
  }))
  disposers.push(
    agent.ctx.systemPrompt.context({
      name: 'knowledge-vault:policy',
      order: -8,
      text: () =>
        '公共知识库通过 knowledge 工具渐进式读取和维护。先 search/tree，再 top/section/grep，只有确有必要才 full。需要详细治理规则时加载 knowledge-use、knowledge-maintain 或 knowledge-govern 技能。普通 Agent 只能访问 public；权限由 Host 强制执行。',
    }),
  )
  disposers.push(
    agent.ctx.systemPrompt.context({
      name: 'reference-vault:catalog',
      order: -7,
      text: () => {
        const tags = directory.references.tagCatalog(['public'], 48)
          .map(item => `${item.tag}(${String(item.count)})`).join('、')
        return tags === ''
          ? '公共引用库当前没有可用资源。'
          : `公共引用库可用标签：${tags}。需要在回答中自然引用资源时调用 express；标签是开放组合，不存在固定资源类别。`
      },
    }),
  )
  disposers.push(
    agent.ctx.tools.register(
      defineTool({
        name: 'knowledge',
        description:
          'Progressively search, inspect, read, write, or audit the public Markdown knowledge vault. Use search/tree before reading; prefer top/section/grep over full.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['tree', 'search', 'read', 'write', 'audit'],
          },
          query: { type: 'string' },
          path: { type: 'string' },
          view: { type: 'string', enum: ['top', 'section', 'grep', 'full'] },
          selector: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          cursor: { type: 'integer' },
          limit: { type: 'integer' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              result: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.result }],
        },
        async execute(args) {
          const cursor = Math.max(0, args.cursor ?? 0)
          const limit = Math.max(1, Math.min(50, args.limit ?? 12))
          if (args.action === 'tree')
            return {
              result: JSON.stringify(
                directory.knowledge.tree('public', args.path ?? '', cursor, limit),
              ),
            }
          if (args.action === 'search')
            return {
              result: JSON.stringify(
                directory.knowledge.search(['public'], args.query ?? '', cursor, limit),
              ),
            }
          if (args.action === 'read')
            return {
              result: JSON.stringify(
                await directory.knowledge.read(
                  'public',
                  args.path ?? '',
                  args.view ?? 'top',
                  args.selector ?? '',
                ),
              ),
            }
          if (args.action === 'audit')
            return { result: JSON.stringify(directory.knowledge.audit('public')) }
          const page = await directory.knowledge.remember(
            'public',
            args.title ?? '',
            args.content ?? '',
            args.tags ?? [],
          )
          return {
            result: JSON.stringify({
              scope: page.scope,
              path: page.path,
              revision: page.revision,
              title: page.title,
            }),
          }
        },
      }),
    ),
  )
  disposers.push(
    agent.ctx.tools.register(
      defineTool({
        name: 'express',
        description:
          'Express one semantic conversational act at this exact point. The Host resolves a fresh public reference asset only after the act is chosen.',
        parameters: {
          act: {
            type: 'string',
            required: true,
            description: 'A free semantic label describing what this reference should express.',
          },
          role: { type: 'string', enum: ['replace-text', 'amplify-text', 'reply', 'illustrate'] },
          intensity: { type: 'integer', description: 'Expression strength from 1 to 3.' },
          target: { type: 'string' },
          reply_to: { type: 'string' },
          query: { type: 'string', description: 'Optional concrete object or situation.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Open resource tags selected from the current catalog and combined freely.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              found: { type: 'boolean', required: true },
              asset_id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              url: { type: 'string', required: true },
              mime_type: { type: 'string', required: true },
              markup: { type: 'string', required: true },
              act: { type: 'string', required: true },
            },
          },
          presentationMeta: (_args, value) => value,
          render: (_args, value) => [
            {
              type: 'text',
              text: value.found
                ? `Expression delivered automatically: ${value.title}. Do not repeat its markup in the response.`
                : 'No suitable expression asset exists. Continue naturally without inventing one.',
            },
          ],
        },
        execute(args) {
          const recent = agent.session.events.slice(-40).flatMap((event) => {
            if (event.type !== 'user/message') return []
            return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
          }).join('\n')
          const intent: ReferenceIntent = {
            act: args.act,
            role: args.role ?? 'amplify-text',
            intensity: Math.max(1, Math.min(3, args.intensity ?? 1)) as 1 | 2 | 3,
            ...(args.target === undefined ? {} : { target: args.target }),
            ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(args.tags === undefined ? {} : { preferredTags: args.tags }),
          }
          const selected = directory.references.react({
            scopes: ['public'],
            query: expressionQuery(intent, recent),
            ...(intent.preferredTags === undefined ? {} : { tags: intent.preferredTags }),
            limit: 1,
          })
          if (selected === undefined) {
            return Promise.resolve({
              found: false,
              asset_id: '',
              title: '',
              url: '',
              mime_type: '',
              markup: '',
              act: intent.act,
            })
          }
          directory.references.markUsed(selected.id)
          return Promise.resolve({
            found: true,
            asset_id: selected.id,
            title: selected.title,
            url: directory.references.url(selected),
            mime_type: selected.mimeType,
            markup: `<agent-reference asset-id="${selected.id}"/>`,
            act: intent.act,
          })
        },
      }),
    ),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new CompanionRequestError('请求内容过大', 413)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new CompanionRequestError('请求格式无效')
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/** Mount persistence, HTTP CRUD, mention invitations, and dynamic room context. */
export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'knowledge-use',
        source: 'bundled',
        provider: 'worldline-knowledge',
        description:
          'Progressively find and read durable Worldline knowledge without loading entire vaults.',
        content: `# Use Worldline knowledge

- Access only the scopes granted by the Host. Never guess or request another companion's private scope.
- Start with knowledge search or tree. Read the top view, a named section, or grep window before full text.
- Follow wikilinks and sources only when they answer the current question. Respect the caller's context budget.
- Cite the scope and path you actually read. State clearly when the vault does not support a claim.
- The express tool is a separate output modality resolved only after the actor chooses a semantic act; never treat assets as knowledge candidates.`,
      }),
    'virtual-companion: knowledge-use skill',
  )
  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'knowledge-maintain',
        source: 'bundled',
        provider: 'worldline-knowledge',
        description: 'Safely create and maintain durable public or own-private Markdown knowledge.',
        content: `# Maintain Worldline knowledge

- Store only durable facts, preferences, commitments, memories, or reusable syntheses. Keep transient chat out.
- Search before writing. Update the canonical subject page instead of creating duplicates.
- Use concise frontmatter: title, tags, summary, and sources. Connect durable subjects with [[wikilinks]].
- Separate sourced facts, user statements, memories, and inferences. Never fabricate provenance.
- Preserve user corrections. Put unresolved conflicts in talk/ and keep raw sources immutable.
- Writes use revisions. If a conflict occurs, read the current page and merge deliberately; never blind-overwrite.
- Never store passwords, tokens, private keys, or unrelated private information.`,
      }),
    'virtual-companion: knowledge-maintain skill',
  )
  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'knowledge-govern',
        source: 'bundled',
        provider: 'worldline-knowledge',
        description:
          'Audit and govern a Worldline vault for broken links, orphans, missing sources, and drift.',
        content: `# Govern Worldline knowledge

- Audit one authorized vault at a time. Never move content across private scopes.
- Run deterministic checks first: broken links, orphan pages, missing sources, oversized pages, duplicate titles, and stale summaries.
- Repair mechanical issues directly. Queue semantic merges and contradictory claims for deliberate review.
- Prefer small reversible edits and preserve provenance. Do not create a second index or hidden source of truth.
- Use the already configured Agent model only when semantic judgment is necessary; this skill requires no embedding model.`,
      }),
    'virtual-companion: knowledge-govern skill',
  )
  const directory = new VirtualCompanionDirectory(ctx.logger)
  const actors = new CompanionActorRuntime(ctx, directory)
  const pendingReferenceUploads = new Map<string, { draft: ReferenceDraft; expiresAt: number }>()
  const installed = new Map<
    Agent,
    { mode: 'actor' | 'companion' | 'ordinary'; dispose: () => void }
  >()
  const maybeInstall = (agent: Agent): void => {
    const mode =
      directory.actorBinding(agent.id) !== undefined
        ? 'actor'
        : isCompanionAgent(agent)
          ? 'companion'
          : 'ordinary'
    const current = installed.get(agent)
    if (current?.mode === mode) {
      actors.install(agent)
      return
    }
    current?.dispose()
    actors.dispose(agent)
    const binding = directory.actorBinding(agent.id)
    const dispose =
      mode === 'companion'
        ? (() => {
          const room = installCompanionRoomPrompt(directory, agent)
          const knowledge = installLibraryRuntime(directory, agent)
          return () => {
            knowledge()
            room()
          }
        })()
        : mode === 'ordinary'
          ? installLibraryRuntime(directory, agent)
          : binding?.kind === 'companion'
            ? installKnowledgeAwareness(agent, {
              knowledge: directory.knowledge,
              scopes: ['public', binding.companionId],
              ready: directory.ready,
              onError: (error) => {
                directory.logWarning('actor knowledge awareness failed', error)
              },
            })
            : () => {}
    installed.set(agent, { mode, dispose })
    actors.install(agent)
  }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await directory.ready
      const pathname = new URL(req.url ?? '/', 'http://local').pathname
      const action = pathname.slice(API_PATH.length).replace(/^\//u, '')
      if (req.method === 'GET' && action === '') {
        send(res, 200, { ok: true, value: directory.snapshot() })
        return
      }
      if (req.method === 'GET' && action.startsWith('reference/blob/')) {
        const id = action.slice('reference/blob/'.length)
        const blob = directory.references.blobInfo(id)
        if (blob === undefined) throw new CompanionRequestError('引用媒体不存在', 404)
        const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '')
        let start = 0
        let end = blob.bytes - 1
        let status = 200
        if (range !== null) {
          if (range[1] === '' && range[2] !== '') {
            const suffix = Number(range[2])
            start = Number.isSafeInteger(suffix) && suffix > 0 ? Math.max(0, blob.bytes - suffix) : -1
          } else {
            start = Number(range[1])
            end = range[2] === '' ? end : Number(range[2])
          }
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            start >= blob.bytes
          ) {
            res.writeHead(416, { 'content-range': `bytes */${blob.bytes}` })
            res.end()
            return
          }
          end = Math.min(end, blob.bytes - 1)
          status = 206
        }
        res.writeHead(status, {
          'content-type': blob.mimeType,
          'x-content-type-options': 'nosniff',
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=31536000, immutable',
          ...(status === 206
            ? { 'content-range': `bytes ${start}-${end}/${blob.bytes}` }
            : {}),
        })
        await pipeline(createReadStream(blob.path, { start, end }), res)
        return
      }
      if (req.method !== 'POST') throw new CompanionRequestError('请求方法不支持', 405)
      if (action.startsWith('reference/upload/') && action !== 'reference/upload/prepare') {
        const uploadId = action.slice('reference/upload/'.length)
        const pending = pendingReferenceUploads.get(uploadId)
        pendingReferenceUploads.delete(uploadId)
        if (pending === undefined || pending.expiresAt < Date.now())
          throw new CompanionRequestError('上传会话不存在或已过期', 404)
        const mimeType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim() ?? ''
        const contentLength = Number(req.headers['content-length'])
        const expectedBytes = Number.isSafeInteger(contentLength) && contentLength >= 0
          ? contentLength
          : undefined
        const value = await directory.references.createUploadStream(
          { ...pending.draft, mimeType, asset: '' },
          req as AsyncIterable<Uint8Array>,
          mimeType,
          expectedBytes,
        )
        send(res, 200, { ok: true, value: { ...value, url: directory.references.url(value) } })
        return
      }
      const body = await readBody(req)
      const scope = typeof body.scope === 'string' ? body.scope : ''
      if (action.startsWith('knowledge/') && !directory.ownsScope(scope))
        throw new CompanionRequestError('知识库范围不存在', 404)
      if (action === 'reference/upload/prepare') {
        const draft = referenceDraft(body.entry)
        if (!directory.ownsScope(draft.scope))
          throw new CompanionRequestError('引用库范围不存在', 404)
        if (draft.title.trim() === '') throw new CompanionRequestError('引用标题不能为空')
        const now = Date.now()
        for (const [id, pending] of pendingReferenceUploads)
          if (pending.expiresAt < now) pendingReferenceUploads.delete(id)
        if (pendingReferenceUploads.size >= 128)
          throw new CompanionRequestError('待处理上传过多，请稍后再试', 429)
        const uploadId = randomUUID()
        pendingReferenceUploads.set(uploadId, { draft, expiresAt: now + 10 * 60_000 })
        send(res, 200, { ok: true, value: { uploadId } })
        return
      }
      if (action === 'knowledge/tree') {
        send(res, 200, {
          ok: true,
          value: directory.knowledge.tree(
            scope,
            typeof body.path === 'string' ? body.path : '',
            Number(body.cursor ?? 0),
            Number(body.limit ?? 200),
          ),
        })
        return
      }
      if (action === 'knowledge/search') {
        send(res, 200, {
          ok: true,
          value: directory.knowledge.search(
            [scope],
            stringValue(body.query),
            Number(body.cursor ?? 0),
            Number(body.limit ?? 30),
          ),
        })
        return
      }
      if (action === 'knowledge/read') {
        send(res, 200, {
          ok: true,
          value: await directory.knowledge.read(
            scope,
            stringValue(body.path),
            body.view === 'top' || body.view === 'section' || body.view === 'grep'
              ? body.view
              : 'full',
            stringValue(body.selector),
          ),
        })
        return
      }
      if (action === 'knowledge/write') {
        send(res, 200, {
          ok: true,
          value: await directory.knowledge.write(
            scope,
            stringValue(body.path),
            stringValue(body.content),
            typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined,
          ),
        })
        return
      }
      if (action === 'knowledge/create') {
        send(res, 200, {
          ok: true,
          value: await directory.knowledge.create(
            scope,
            stringValue(body.folder, 'pages'),
            stringValue(body.title),
          ),
        })
        return
      }
      if (action === 'knowledge/move') {
        send(res, 200, {
          ok: true,
          value: await directory.knowledge.move(
            scope,
            stringValue(body.source),
            stringValue(body.target),
            stringValue(body.expectedRevision),
          ),
        })
        return
      }
      if (action === 'knowledge/trash') {
        await directory.knowledge.trash(
          scope,
          stringValue(body.path),
          stringValue(body.expectedRevision),
        )
        send(res, 200, { ok: true, value: { removed: true } })
        return
      }
      if (action === 'knowledge/backlinks') {
        send(res, 200, {
          ok: true,
          value: directory.knowledge.backlinks(scope, stringValue(body.path)),
        })
        return
      }
      if (action === 'knowledge/audit') {
        send(res, 200, { ok: true, value: directory.knowledge.audit(scope) })
        return
      }
      if (action === 'reference/tags') {
        const scopes = Array.isArray(body.scopes)
          ? body.scopes.filter((value): value is string => typeof value === 'string')
          : []
        if (!scopes.every(scope => directory.ownsScope(scope)))
          throw new CompanionRequestError('引用库范围不存在', 404)
        send(res, 200, {
          ok: true,
          value: directory.references.tagCatalog(scopes, 200, body.includeDisabled === true),
        })
        return
      }
      if (action === 'reference/search') {
        const scopes = Array.isArray(body.scopes)
          ? body.scopes.filter(
            (value): value is string => typeof value === 'string' && directory.ownsScope(value),
          )
          : []
        const page = directory.references.query({
          scopes,
          query: stringValue(body.query),
          tags: Array.isArray(body.tags)
            ? body.tags.filter((value): value is string => typeof value === 'string')
            : [],
          includeDisabled: body.includeDisabled === true,
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          cursor: Number(body.cursor ?? 0),
          limit: Number(body.limit ?? 30),
        })
        send(res, 200, {
          ok: true,
          value: {
            ...page,
            items: page.items.map(item => ({ ...item, url: directory.references.url(item) })),
          },
        })
        return
      }
      if (action === 'reference/get') {
        const value = directory.references.get(stringValue(body.id))
        if (value === undefined || !directory.ownsScope(value.scope))
          throw new CompanionRequestError('引用不存在', 404)
        send(res, 200, { ok: true, value: { ...value, url: directory.references.url(value) } })
        return
      }
      if (action === 'reference/create') {
        const entry = referenceDraft(body.entry)
        if (!directory.ownsScope(entry.scope))
          throw new CompanionRequestError('引用库范围不存在', 404)
        const value = await directory.references.create(entry)
        send(res, 200, { ok: true, value: { ...value, url: directory.references.url(value) } })
        return
      }
      if (action === 'reference/update') {
        const entry = referenceDraft(body.entry)
        if (!directory.ownsScope(entry.scope))
          throw new CompanionRequestError('引用库范围不存在', 404)
        const current = directory.references.get(stringValue(body.id))
        if (current === undefined || !directory.ownsScope(current.scope))
          throw new CompanionRequestError('引用不存在', 404)
        const value = await directory.references.update(current.id, entry)
        send(res, 200, { ok: true, value: { ...value, url: directory.references.url(value) } })
        return
      }
      if (action === 'reference/set-enabled') {
        const current = directory.references.get(stringValue(body.id))
        if (current === undefined || !directory.ownsScope(current.scope))
          throw new CompanionRequestError('引用不存在', 404)
        if (typeof body.enabled !== 'boolean')
          throw new CompanionRequestError('引用启用状态无效')
        const value = await directory.references.setEnabled(current.id, body.enabled)
        send(res, 200, { ok: true, value: { ...value, url: directory.references.url(value) } })
        return
      }
      if (action === 'reference/delete') {
        const current = directory.references.get(stringValue(body.id))
        if (current === undefined || !directory.ownsScope(current.scope))
          throw new CompanionRequestError('引用不存在', 404)
        await directory.references.remove(current.id)
        send(res, 200, { ok: true, value: { removed: true } })
        return
      }
      if (action === 'restore') {
        const id = stringValue(body.id)
        await actors.resetCompanion(id)
        send(res, 200, { ok: true, value: await directory.restoreBuiltIn(id) })
        return
      }
      const beforeRoom =
        action === 'room' && typeof body.sessionId === 'string'
          ? (directory.room(body.sessionId)?.participantIds ?? [])
          : []
      const value =
        action === 'create'
          ? await directory.create(body.companion)
          : action === 'update'
            ? await directory.update(body.id, body.companion)
            : action === 'delete'
              ? await directory.remove(body.id)
              : action === 'room'
                ? await directory.setRoom(body.sessionId, body.participantIds)
                : undefined
      if (value === undefined) throw new CompanionRequestError('请求路径不存在', 404)
      if (action === 'room' && typeof body.sessionId === 'string') {
        const parent = ctx.agents.get(SessionId(body.sessionId))
        if (parent !== undefined) {
          actors.recordMembership(
            parent,
            beforeRoom,
            directory.room(body.sessionId)?.participantIds ?? [],
            'owner',
          )
          actors.install(parent)
        }
      }
      send(res, 200, { ok: true, value })
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined)
        return
      }
      const status =
        error instanceof CompanionRequestError
          ? error.status
          : error instanceof KnowledgeConflictError
            ? 409
            : 500
      if (status === 500) ctx.logger.warn(error)
      send(res, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof KnowledgeConflictError ? { current: error.current } : {}),
      })
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PATH, handler }),
    'virtual-companion: routes',
  )
  void directory.ready.then(() => {
    for (const agent of ctx.agents.list()) maybeInstall(agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    void directory.ready.then(() => {
      maybeInstall(agent)
    })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.dispose()
    installed.delete(agent)
    actors.dispose(agent)
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    directory.inviteMentions(agent, message)
    // A blank session is commonly created under the standard preset and switched immediately
    // before its first message. Re-evaluate the complete mode here so the ordinary library
    // context/tools are disposed and the authoritative room prompt is installed for this turn.
    maybeInstall(agent)
  })
  ctx.on('session/event', (session, event) => {
    actors.handleActorEvent(session, event)
  })
  ctx.on('subagent/end', (info) => {
    actors.handleSettled(info)
  })
  ctx.effect(
    () => () => {
      for (const value of installed.values()) value.dispose()
      installed.clear()
      actors.dispose()
      directory.close()
    },
    'virtual-companion: scoped room prompts',
  )
}
