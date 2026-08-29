/** Account-scoped virtual companion directory, room state, and Agent context. */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AgentVaultService, RecallCard, SelfModule, VaultDocument, VaultEntry, VaultPolicy, VaultResource,
} from '@deepseek-ai/dsh-agent-vault'
import { AgentVaultError } from '@deepseek-ai/dsh-agent-vault'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { worldlineHomePath } from '@deepseek-ai/dsh-home-paths'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import type {
  VirtualCompanion,
  VirtualCompanionDraft,
  VirtualCompanionRoom,
  VirtualCompanionSnapshot,
  ReferenceDraft,
} from './contracts.ts'
import { initialCompanionId } from './contracts.ts'
import { BUILT_IN_MEMES } from './builtin-memes.ts'
import { CompanionActorRuntime } from './actor-runtime.ts'
import { migrateLegacyCompanions } from './agent-vault-migration.ts'

export type {
  VirtualCompanion,
  VirtualCompanionDraft,
  VirtualCompanionRoom,
  VirtualCompanionSnapshot,
} from './contracts.ts'

export const name = 'virtual-companion-directory'
export const inject = ['agents', 'agentVaults', 'subagents', 'webServer', 'systemPrompt']

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

function vaultReference(value: VaultResource, url: string): import('./contracts.ts').ReferenceAsset {
  return {
    id: value.id, scope: value.agentId, enabled: value.enabled, title: value.title,
    description: value.description, tags: value.tags, transcript: value.transcript,
    mimeType: value.mimeType, bytes: value.bytes,
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    source: value.sha256 === undefined
      ? { type: 'link', url: value.externalUrl ?? url }
      : { type: 'blob', hash: value.sha256 },
    builtIn: value.builtIn, usageCount: value.usageCount,
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
    createdAt: value.createdAt, updatedAt: value.updatedAt, url,
  }
}

function knowledgeEntry(value: VaultEntry): import('./contracts.ts').KnowledgeTreeEntry {
  return { name: value.name, path: value.uri.slice('vault://'.length),
    kind: value.kind === 'directory' ? 'directory' : 'document', updatedAt: value.updatedAt,
    size: value.bytes }
}

function knowledgeDocument(value: VaultDocument): import('./contracts.ts').KnowledgeDocument {
  return { scope: '', path: value.uri.slice('vault://'.length), title: value.title,
    summary: value.summary, tags: value.tags, revision: value.revision, updatedAt: value.updatedAt,
    content: value.content, headings: value.headings, links: value.links, sources: value.sources,
    totalLines: value.totalLines, view: value.view }
}

function knowledgeResult(scope: string, value: RecallCard): import('./contracts.ts').KnowledgeSearchResult {
  return { scope, path: value.uri.slice(value.uri.indexOf('://') + 3), title: value.title,
    summary: value.summary, tags: value.tags, revision: value.revision, updatedAt: value.updatedAt }
}

async function vaultDocuments(vaults: AgentVaultService, scope: string): Promise<readonly VaultDocument[]> {
  const queue = ['memory', 'procedures']
  const documents: VaultDocument[] = []
  while (queue.length > 0) {
    const path = queue.shift() ?? ''
    let cursor = 0
    for (;;) {
      const entries = await vaults.list(scope, `vault://${path}`, cursor, 500)
      for (const entry of entries) {
        const child = entry.uri.slice('vault://'.length)
        if (entry.kind === 'directory') queue.push(child)
        else if (entry.kind === 'document' && child.endsWith('.md'))
          documents.push(await vaults.read(scope, entry.uri, 'full'))
      }
      if (entries.length < 500) break
      cursor += entries.length
    }
  }
  return documents
}

const linkKey = (value: string): string => value.replace(/^vault:\/\//u, '').replace(/\.md$/iu, '')

function findVaultTarget(keys: ReadonlySet<string>, target: string): string | undefined {
  const normalized = linkKey(target)
  if (keys.has(normalized)) return normalized
  const leaf = basename(normalized)
  return [...keys].find(key => basename(key) === leaf)
}

/**
 * Find portable Wiki documents that link to a target inside one Agent Vault.
 * @param vaults - Agent Vault service that owns the source-of-truth documents.
 * @param scope - Agent identifier whose document tree is searched.
 * @param target - Portable Wiki target or vault path to resolve.
 * @returns Lightweight metadata for every document containing a matching link.
 */
export async function vaultBacklinks(vaults: AgentVaultService, scope: string, target: string): Promise<unknown[]> {
  const documents = await vaultDocuments(vaults, scope)
  const normalized = linkKey(target)
  return documents.filter(document => document.links.some((link) => {
    const candidate = linkKey(link)
    return candidate === normalized || basename(candidate) === basename(normalized)
  })).map(document => ({ scope, path: document.uri.slice('vault://'.length), title: document.title,
    summary: document.summary, tags: document.tags, revision: document.revision, updatedAt: document.updatedAt }))
}

/**
 * Audit links, provenance, and reachability without mutating an Agent Vault.
 * @param vaults - Agent Vault service that owns the source-of-truth documents.
 * @param scope - Agent identifier whose document tree is audited.
 * @returns Broken links, unreferenced documents, and documents without source metadata.
 */
export async function auditVault(vaults: AgentVaultService, scope: string): Promise<{
  brokenLinks: readonly { source: string; target: string }[]
  orphaned: readonly string[]
  missingSources: readonly string[]
}> {
  const documents = await vaultDocuments(vaults, scope)
  const keys = new Set(documents.map(document => linkKey(document.uri.slice('vault://'.length))))
  const linked = new Set<string>()
  const brokenLinks: Array<{ source: string; target: string }> = []
  const missingSources: string[] = []
  for (const document of documents) {
    const source = document.uri.slice('vault://'.length)
    for (const raw of document.links) {
      const found = findVaultTarget(keys, raw)
      if (found === undefined) brokenLinks.push({ source, target: raw })
      else linked.add(found)
    }
    if (!source.endsWith('/index.md') && document.sources.length === 0) missingSources.push(source)
  }
  return { brokenLinks, missingSources,
    orphaned: [...keys].filter(path => !path.endsWith('/index') && !linked.has(path)).sort() }
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
  readonly ready: Promise<void>
  private readonly agentVaults: AgentVaultService | undefined

  constructor(
    private readonly logger: Context['logger'],
    root?: string,
    agentVaults?: AgentVaultService,
  ) {
    this.directory = root ?? worldlineHomePath('companions')
    this.file = join(this.directory, 'directory.json')
    this.agentVaults = agentVaults
    this.ready = this.initialize()
  }

  /** Return the configured Agent Vault service or fail when the plugin is unavailable. */
  get vaults(): AgentVaultService {
    if (this.agentVaults === undefined) throw new Error('Agent Vault service is unavailable')
    return this.agentVaults
  }

  /**
   * Build the stable local HTTP URL for a resource stored in an Agent Vault.
   * @param agentId - Agent that owns the resource.
   * @param resourceId - Resource identifier within that Agent Vault.
   * @returns URL accepted by the virtual-companion resource endpoint.
   */
  resourceUrl(agentId: string, resourceId: string): string {
    return `${API_PATH}/vault/resource/${encodeURIComponent(agentId)}/${encodeURIComponent(resourceId)}`
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
    if (this.agentVaults !== undefined) await migrateLegacyCompanions({
      legacyRoot: this.directory,
      backupRoot: join(this.directory, '..', 'agent-vault-backups'),
      profiles: this.data.companions,
      vaults: this.agentVaults,
    })
    if (this.agentVaults !== undefined) {
      await this.seedBuiltInKnowledge()
      await this.seedBuiltInReferences()
    }
    await this.save()
  }

  private async syncProfile(profile: VirtualCompanion): Promise<void> {
    if (this.agentVaults === undefined) return
    const known = (await this.agentVaults.listAgents()).some(item => item.agent.id === profile.id)
    if (!known) await this.agentVaults.createAgent(profile.id, profile.name)
    const snapshot = await this.agentVaults.inspectSelf(profile.id)
    const values: Readonly<Record<string, { summary: string; details: readonly string[] }>> = {
      identity: { summary: `${profile.name}（${profile.handle}）`, details: [profile.description, profile.persona] },
      appearance: { summary: profile.avatar === '' ? '尚未提供形象资料。' : '已登记角色形象。',
        details: profile.avatar === '' ? [] : [`形象资源：${profile.avatar}`, `立绘资源：${profile.portrait || profile.avatar}`] },
      persona: { summary: profile.style, details: [profile.persona, profile.behaviorLogic] },
      voice: { summary: profile.speakingStyle, details: [] },
      state: { summary: profile.status, details: [] },
    }
    for (const current of snapshot.modules) {
      const next = values[current.id]; if (next === undefined) continue
      await this.agentVaults.updateSelf(profile.id, { ...current, summary: next.summary,
        details: next.details.filter(Boolean), updatedAt: Date.now() } satisfies SelfModule,
      { actor: { type: 'user', id: 'companion-profile-editor' }, reason: 'User updated companion profile.',
        expectedRevision: current.revision })
    }
  }

  /**
   * Read one agent's mutation and self-module policy.
   * @param agentId - Agent whose policy is requested.
   * @returns Current Agent Vault policy.
   */
  async vaultPolicy(agentId: string): Promise<VaultPolicy> { return await this.vaults.policy(agentId) }

  /**
   * Replace one agent's mutation and self-module policy through a user-authorized action.
   * @param agentId - Agent whose policy is changed.
   * @param policy - Complete replacement policy.
   * @returns Persisted Agent Vault policy.
   */
  async setVaultPolicy(agentId: string, policy: VaultPolicy): Promise<VaultPolicy> {
    if (!this.data.companions.some(item => item.id === agentId) && agentId !== 'public') {
      throw new CompanionRequestError('Agent Vault 不存在', 404)
    }
    return await this.vaults.setPolicy(agentId, policy, {
      actor: { type: 'user', id: 'vault-settings' }, reason: 'User changed Agent Vault policy.',
    })
  }

  /**
   * Materialize an imported Agent Vault's structured self modules as a companion card.
   * @param agentId - Imported Agent Vault identifier.
   * @returns Updated companion directory snapshot.
   */
  async registerImportedCompanion(agentId: string): Promise<VirtualCompanionSnapshot> {
    return await this.exclusive(async () => {
      if (agentId === 'public' || this.data.companions.some(item => item.id === agentId)) return this.snapshot()
      const self = await this.vaults.inspectSelf(agentId); const get = (id: string) => self.modules.find(item => item.id === id)
      const identity = get('identity'); const appearance = get('appearance'); const persona = get('persona')
      const avatar = appearance?.details.find(item => item.startsWith('形象资源：'))?.slice('形象资源：'.length) ?? ''
      const now = Date.now(); const name = identity?.summary.split('（', 1)[0]?.trim() || agentId
      this.data.companions.push({ id: agentId, name, handle: identity?.summary ?? name,
        avatar, portrait: avatar, status: get('state')?.summary ?? '', description: identity?.details[0] ?? '',
        persona: identity?.details[1] ?? '', style: persona?.summary ?? '', speakingStyle: get('voice')?.summary ?? '',
        behaviorLogic: persona?.details[1] ?? '', builtIn: false, createdAt: now, updatedAt: now })
      await this.save(); return this.snapshot()
    })
  }

  private async seedBuiltInReferences(scope?: string): Promise<void> {
    const seededAt = Date.now()
    for (const meme of BUILT_IN_MEMES.filter(item => scope === undefined || item.scope === scope)) {
      try { await this.vaults.resource(meme.scope, meme.id); continue } catch { /* seed missing built-in */ }
      await this.vaults.importResource(meme.scope, { preferredId: meme.id, enabled: true,
        roles: ['expression'], title: meme.title, description: meme.content,
        tags: [...new Set(['表情包', '图片', meme.mimeType === 'image/gif' ? 'gif' : 'jpg', meme.scope,
          ...meme.content.split(/[-—_\s，。！？、]+/u).filter(Boolean)])], originalTags: [], transcript: '',
        mimeType: meme.mimeType, bytes: 0, externalUrl: meme.asset, builtIn: true, usageCount: 0,
        createdAt: seededAt }, undefined, { actor: { type: 'system', id: 'built-in-seed' },
        reason: 'Install a missing bundled expression resource.' })
    }
  }

  private async seedBuiltInKnowledge(scope?: string): Promise<void> {
    for (const page of BUILT_IN_KNOWLEDGE.filter(item => scope === undefined || item.scope === scope)) {
      const known = await this.vaults.recall({ agentId: page.scope, domain: 'memory', query: page.title,
        budget: { maxResults: 10, maxChars: 8_000, maxMillis: 200 } })
      if (known.cards.some(card => card.title === page.title)) continue
      const content = ['---', `title: ${JSON.stringify(page.title)}`, `tags: ${JSON.stringify(page.tags)}`,
        `summary: ${JSON.stringify(page.content.slice(0, 320).replace(/\s+/gu, ' '))}`,
        'sources: ["worldline://bundled-companion"]', '---', '', `# ${page.title}`, '', page.content, ''].join('\n')
      await this.vaults.write(page.scope, `vault://memory/long/builtin/${page.key}.md`, content,
        { actor: { type: 'system', id: 'built-in-seed' }, reason: 'Install missing bundled companion knowledge.' })
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

  close(): void {}

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
      const created: VirtualCompanion = {
        ...input,
        id: randomUUID(),
        builtIn: false,
        createdAt: now,
        updatedAt: now,
      }
      await this.syncProfile(created)
      this.data.companions.push(created)
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
      const updated: VirtualCompanion = {
        ...current,
        ...input,
        updatedAt: Date.now(),
      }
      await this.syncProfile(updated)
      this.data.companions[index] = updated
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

      this.data.companions[index] = {
        ...original,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      }
      if (this.agentVaults !== undefined) {
        await this.agentVaults.removeAgent(id, { actor: { type: 'system', id: 'restore-built-in' },
          reason: 'User restored the built-in companion.' })
        await this.agentVaults.createAgent(id, original.name)
        const restored = this.data.companions[index]
        if (restored === undefined) throw new CompanionRequestError('内置伙伴恢复失败', 500)
        await this.syncProfile(restored)
        await this.seedBuiltInKnowledge(id)
        await this.seedBuiltInReferences(id)
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
        if (this.agentVaults !== undefined) await this.agentVaults.removeAgent(id, {
          actor: { type: 'user', id: 'companion-directory' }, reason: 'User deleted the companion.',
        })
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

/** Install the public Agent Vault into an ordinary/coordinator Agent scope. */
export function installLibraryRuntime(directory: VirtualCompanionDirectory, agent: Agent): () => void {
  const disposers: Array<() => unknown> = [directory.vaults.bindRuntimeAgent(agent.id, 'public')]
  disposers.push(agent.ctx.systemPrompt.context({ name: 'agent-vault:public-policy', order: -8,
    text: () => '你只能通过 Agent Vault 工具访问公共认知。先快速召回方向，再渐进读取；不要全量扫描，不要把普通知识检索写入 self。' }))
  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'express', description: 'Resolve one public expression resource from a semantic intent without injecting the full catalog.',
    parameters: { act: { type: 'string', required: true }, query: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      found: { type: 'boolean', required: true }, asset_id: { type: 'string', required: true },
      title: { type: 'string', required: true }, url: { type: 'string', required: true },
      mime_type: { type: 'string', required: true }, markup: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.found
      ? `Expression resource resolved: ${value.title}` : 'No suitable public resource found.' }] },
    execute: async (args) => {
      const page = await directory.vaults.searchResources({ agentId: 'public',
        query: `${args.act} ${args.query ?? ''}`, tags: args.tags ?? [], roles: ['expression'], limit: 1 })
      const selected = page.items[0]
      return selected === undefined
        ? { found: false, asset_id: '', title: '', url: '', mime_type: '', markup: '' }
        : { found: true, asset_id: selected.id, title: selected.title,
          url: directory.resourceUrl(selected.agentId, selected.id), mime_type: selected.mimeType,
          markup: `<agent-reference asset-id="${selected.id}"/>` }
    },
  })))
  return () => { for (const dispose of disposers.reverse()) dispose() }
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
  const directory = new VirtualCompanionDirectory(ctx.logger, undefined, ctx.agentVaults)
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
          : () => {}
    installed.set(agent, { mode, dispose })
    actors.install(agent)
  }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let action = ''
    let requestBody: Record<string, unknown> | undefined
    try {
      await directory.ready
      const pathname = new URL(req.url ?? '/', 'http://local').pathname
      action = pathname.slice(API_PATH.length).replace(/^\//u, '')
      if (req.method === 'GET' && action === '') {
        send(res, 200, { ok: true, value: directory.snapshot() })
        return
      }
      if (req.method === 'GET' && action.startsWith('vault/resource/')) {
        const [, , agentId = '', resourceId = ''] = action.split('/')
        const content = await directory.vaults.resourceContent(decodeURIComponent(agentId), decodeURIComponent(resourceId))
        if (content.type === 'external') {
          res.writeHead(302, { location: content.url, 'cache-control': 'private, max-age=300' }); res.end(); return
        }
        const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range ?? '')
        let start = 0; let end = content.bytes - 1; let status = 200
        if (range !== null) {
          start = range[1] === '' ? Math.max(0, content.bytes - Number(range[2])) : Number(range[1])
          end = range[2] === '' ? end : Number(range[2])
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
            || start >= content.bytes) { res.writeHead(416, { 'content-range': `bytes */${content.bytes}` }); res.end(); return }
          end = Math.min(end, content.bytes - 1); status = 206
        }
        res.writeHead(status, { 'content-type': content.mimeType, 'x-content-type-options': 'nosniff',
          'content-length': String(end - start + 1), 'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=31536000, immutable',
          ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${content.bytes}` } : {}) })
        await pipeline(createReadStream(content.path, { start, end }), res); return
      }
      if (req.method === 'GET' && action.startsWith('vault/export/')) {
        const agentId = decodeURIComponent(action.slice('vault/export/'.length)); const transfer = join(worldlineHomePath('transfers'), `${randomUUID()}.wlvault`)
        await mkdir(worldlineHomePath('transfers'), { recursive: true })
        await directory.vaults.exportAgent(agentId, transfer, false)
        res.writeHead(200, { 'content-type': 'application/vnd.worldline.agent-vault',
          'content-disposition': `attachment; filename="${agentId}.wlvault"`, 'cache-control': 'no-store' })
        try { await pipeline(createReadStream(transfer), res) } finally { await rm(transfer, { force: true }) }
        return
      }
      if (req.method !== 'POST') throw new CompanionRequestError('请求方法不支持', 405)
      if (action.startsWith('vault/import')) {
        const targetId = new URL(req.url ?? '/', 'http://local').searchParams.get('agentId') ?? undefined
        const transfer = join(worldlineHomePath('transfers'), `${randomUUID()}.wlvault`)
        await mkdir(worldlineHomePath('transfers'), { recursive: true })
        try {
          await pipeline(req, createWriteStream(transfer, { flags: 'wx', mode: 0o600 }))
          const report = await directory.vaults.importAgent(transfer, targetId)
          await directory.registerImportedCompanion(report.agentId)
          send(res, 200, { ok: true, value: report })
        } finally { await rm(transfer, { force: true }) }
        return
      }
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
        if (expectedBytes !== undefined && expectedBytes > MAX_BODY_BYTES)
          throw new CompanionRequestError('上传资源过大', 413)
        const transfer = join(worldlineHomePath('transfers'), `${randomUUID()}.resource`)
        await mkdir(worldlineHomePath('transfers'), { recursive: true })
        let bytes = 0
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength
          callback(bytes > MAX_BODY_BYTES ? new CompanionRequestError('上传资源过大', 413) : null, chunk)
        } })
        try {
          await pipeline(req, limiter, createWriteStream(transfer, { flags: 'wx', mode: 0o600 }))
          if (expectedBytes !== undefined && expectedBytes !== bytes)
            throw new CompanionRequestError('上传资源长度不完整')
          const value = await directory.vaults.importResourceFromFile(pending.draft.scope, {
            enabled: true, roles: ['expression'], title: pending.draft.title,
            description: pending.draft.description, tags: pending.draft.tags,
            originalTags: pending.draft.tags, transcript: pending.draft.transcript ?? '', mimeType,
            bytes, ...(pending.draft.durationMs === undefined ? {} : { durationMs: pending.draft.durationMs }),
            builtIn: false,
          }, transfer, { actor: { type: 'user', id: 'vault-resource-editor' }, reason: 'User uploaded a resource.' })
          send(res, 200, { ok: true, value: vaultReference(value, directory.resourceUrl(value.agentId, value.id)) })
        } finally { await rm(transfer, { force: true }) }
        return
      }
      const body = await readBody(req)
      requestBody = body
      const scope = typeof body.scope === 'string' ? body.scope : ''
      if (action === 'vault/self') {
        send(res, 200, { ok: true, value: await directory.vaults.inspectSelf(scope) }); return
      }
      if (action === 'vault/self/update') {
        send(res, 200, { ok: true, value: await directory.vaults.updateSelf(scope, body.module as SelfModule,
          { actor: { type: 'user', id: 'vault-ui' }, reason: stringValue(body.reason, 'User edited self module.'),
            expectedRevision: stringValue((body.module as { revision?: unknown } | undefined)?.revision) }) }); return
      }
      if (action === 'vault/policy') {
        send(res, 200, { ok: true, value: await directory.vaultPolicy(scope) }); return
      }
      if (action === 'vault/policy/set') {
        send(res, 200, { ok: true, value: await directory.setVaultPolicy(scope, body.policy as VaultPolicy) }); return
      }
      if (action === 'vault/jobs') {
        send(res, 200, { ok: true, value: await directory.vaults.consolidationJobs(scope) }); return
      }
      if (action === 'vault/consolidate') {
        const source = body.source === 'medium' ? 'medium' : 'short'; const target = source === 'short' ? 'medium' : 'long'
        const job = await directory.vaults.queueConsolidation(scope, source, target,
          { actor: { type: 'user', id: 'vault-ui' }, reason: 'User requested bounded consolidation.' })
        send(res, 200, { ok: true, value: await directory.vaults.runConsolidation(job.id, Number(body.limit ?? 50)) }); return
      }
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
        const path = stringValue(body.path)
        const value = path === ''
          ? ['self', 'memory', 'procedures'].map(name => ({ name, path: name, kind: 'directory' as const }))
          : (await directory.vaults.list(scope, `vault://${path}`)).map(knowledgeEntry)
        send(res, 200, {
          ok: true,
          value,
        })
        return
      }
      if (action === 'knowledge/search') {
        const query = stringValue(body.query); const budget = { maxResults: Number(body.limit ?? 30), maxChars: 12_000, maxMillis: 150 }
        const [memory, procedure] = await Promise.all([
          directory.vaults.recall({ agentId: scope, domain: 'memory', query, budget }),
          directory.vaults.recall({ agentId: scope, domain: 'procedure', query, budget }),
        ])
        send(res, 200, {
          ok: true,
          value: [...memory.cards, ...procedure.cards].sort((a, b) => b.score - a.score)
            .slice(0, Number(body.limit ?? 30)).map(item => knowledgeResult(scope, item)),
        })
        return
      }
      if (action === 'knowledge/read') {
        send(res, 200, {
          ok: true,
          value: knowledgeDocument(await directory.vaults.read(
            scope, `vault://${stringValue(body.path)}`,
            body.view === 'top' || body.view === 'section' || body.view === 'grep'
              ? body.view
              : 'full',
            stringValue(body.selector),
          )),
        })
        return
      }
      if (action === 'knowledge/write') {
        send(res, 200, {
          ok: true,
          value: knowledgeDocument(await directory.vaults.write(scope, `vault://${stringValue(body.path)}`,
            stringValue(body.content), { actor: { type: 'user', id: 'vault-editor' },
              reason: 'User edited a Vault document.',
              ...(typeof body.expectedRevision === 'string' ? { expectedRevision: body.expectedRevision } : {}) })),
        })
        return
      }
      if (action === 'knowledge/create') {
        const title = stringValue(body.title).trim(); const slug = title.normalize('NFKC')
          .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-').replace(/\s+/gu, '-').slice(0, 80) || randomUUID()
        const content = ['---', `title: ${JSON.stringify(title)}`, 'tags: []', `summary: ${JSON.stringify(title)}`,
          'sources: []', '---', '', `# ${title}`, ''].join('\n')
        send(res, 200, {
          ok: true,
          value: knowledgeDocument(await directory.vaults.write(scope, `vault://memory/long/pages/${slug}.md`, content,
            { actor: { type: 'user', id: 'vault-editor' }, reason: 'User created a Vault document.' })),
        })
        return
      }
      if (action === 'knowledge/move') {
        send(res, 200, {
          ok: true,
          value: await directory.vaults.move(scope, `vault://${stringValue(body.source)}`,
            `vault://${stringValue(body.target)}`, { actor: { type: 'user', id: 'vault-editor' },
              reason: 'User moved a Vault document.', expectedRevision: stringValue(body.expectedRevision) }),
        })
        return
      }
      if (action === 'knowledge/trash') {
        const source = stringValue(body.path); const first = source.split('/', 1)[0]
        if (first === 'self') throw new CompanionRequestError('印象卡模块不能从文档工作台删除', 403)
        const base = first === 'procedures' ? 'procedures/.trash' : 'memory/long/.trash'
        await directory.vaults.move(scope, `vault://${source}`, `vault://${base}/${Date.now()}-${basename(source)}`,
          { actor: { type: 'user', id: 'vault-editor' }, reason: 'User moved a document to recoverable trash.',
            expectedRevision: stringValue(body.expectedRevision) })
        send(res, 200, { ok: true, value: { removed: true } })
        return
      }
      if (action === 'knowledge/backlinks') {
        send(res, 200, { ok: true,
          value: await vaultBacklinks(directory.vaults, scope, stringValue(body.path)) })
        return
      }
      if (action === 'knowledge/audit') {
        send(res, 200, { ok: true, value: await auditVault(directory.vaults, scope) })
        return
      }
      if (action === 'reference/tags') {
        const scopes = Array.isArray(body.scopes)
          ? body.scopes.filter((value): value is string => typeof value === 'string')
          : []
        if (!scopes.every(scope => directory.ownsScope(scope)))
          throw new CompanionRequestError('引用库范围不存在', 404)
        const counts = new Map<string, number>()
        for (const agentId of scopes) {
          let cursor = 0
          for (;;) {
            const page = await directory.vaults.searchResources({ agentId, query: '', includeDisabled: body.includeDisabled === true, cursor, limit: 100 })
            for (const item of page.items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
            if (page.nextCursor < 0) break; cursor = page.nextCursor
          }
        }
        send(res, 200, { ok: true, value: [...counts].map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 200) })
        return
      }
      if (action === 'reference/search') {
        const scopes = Array.isArray(body.scopes)
          ? body.scopes.filter(
            (value): value is string => typeof value === 'string' && directory.ownsScope(value),
          )
          : []
        const pages = await Promise.all(scopes.map(agentId => directory.vaults.searchResources({
          agentId, query: stringValue(body.query), tags: Array.isArray(body.tags)
            ? body.tags.filter((value): value is string => typeof value === 'string') : [],
          includeDisabled: body.includeDisabled === true, cursor: Number(body.cursor ?? 0), limit: Number(body.limit ?? 30),
        })))
        const items = pages.flatMap(page => page.items)
          .filter(item => typeof body.enabled !== 'boolean' || item.enabled === body.enabled)
          .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Number(body.limit ?? 30))
        send(res, 200, {
          ok: true,
          value: {
            items: items.map(item => vaultReference(item, directory.resourceUrl(item.agentId, item.id))),
            nextCursor: pages.some(page => page.nextCursor >= 0) ? Number(body.cursor ?? 0) + items.length : -1,
          },
        })
        return
      }
      if (action === 'reference/get') {
        let value: VaultResource | undefined
        for (const agentId of ['public', ...directory.snapshot().companions.map(item => item.id)]) {
          value = await directory.vaults.resource(agentId, stringValue(body.id)).catch(() => undefined)
          if (value !== undefined) break
        }
        if (value === undefined) throw new CompanionRequestError('引用不存在', 404)
        send(res, 200, { ok: true, value: vaultReference(value, directory.resourceUrl(value.agentId, value.id)) })
        return
      }
      if (action === 'reference/create') {
        const entry = referenceDraft(body.entry)
        if (!directory.ownsScope(entry.scope))
          throw new CompanionRequestError('引用库范围不存在', 404)
        const decoded = /^data:([^;,]+);base64,(.+)$/u.exec(entry.asset)
        const value = await directory.vaults.importResource(entry.scope, { enabled: true, roles: ['expression'],
          title: entry.title, description: entry.description, tags: entry.tags, originalTags: entry.tags,
          transcript: entry.transcript ?? '', mimeType: entry.mimeType, bytes: decoded === null ? 0 : Buffer.byteLength(decoded[2] ?? '', 'base64'),
          ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
          ...(decoded === null ? { externalUrl: entry.asset } : {}), builtIn: false },
        decoded === null ? undefined : Buffer.from(decoded[2] ?? '', 'base64'),
        { actor: { type: 'user', id: 'vault-resource-editor' }, reason: 'User created a resource.' })
        send(res, 200, { ok: true, value: vaultReference(value, directory.resourceUrl(value.agentId, value.id)) })
        return
      }
      if (action === 'reference/update') {
        const entry = referenceDraft(body.entry)
        if (!directory.ownsScope(entry.scope))
          throw new CompanionRequestError('引用库范围不存在', 404)
        const current = await directory.vaults.resource(entry.scope, stringValue(body.id))
        const value = await directory.vaults.updateResource(entry.scope, current.id, {
          title: entry.title, description: entry.description, tags: entry.tags,
          originalTags: entry.tags, transcript: entry.transcript ?? '', roles: ['expression'],
          ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        }, { actor: { type: 'user', id: 'vault-resource-editor' }, reason: 'User edited resource metadata.', expectedRevision: current.revision })
        send(res, 200, { ok: true, value: vaultReference(value, directory.resourceUrl(value.agentId, value.id)) })
        return
      }
      if (action === 'reference/set-enabled') {
        const current = await directory.vaults.resource(scope, stringValue(body.id))
        if (typeof body.enabled !== 'boolean')
          throw new CompanionRequestError('引用启用状态无效')
        const value = await directory.vaults.setResourceEnabled(scope, current.id, body.enabled,
          { actor: { type: 'user', id: 'vault-resource-editor' }, reason: 'User changed resource availability.', expectedRevision: current.revision })
        send(res, 200, { ok: true, value: vaultReference(value, directory.resourceUrl(value.agentId, value.id)) })
        return
      }
      if (action === 'reference/delete') {
        const current = await directory.vaults.resource(scope, stringValue(body.id))
        await directory.vaults.removeResource(scope, current.id,
          { actor: { type: 'user', id: 'vault-resource-editor' }, reason: 'User deleted a resource.', expectedRevision: current.revision })
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
          : error instanceof AgentVaultError && error.code === 'REVISION_CONFLICT'
            ? 409
            : 500
      if (status === 500) ctx.logger.warn(error)
      const current = status === 409 && action === 'knowledge/write' && requestBody !== undefined
        ? await directory.vaults.read(stringValue(requestBody.scope),
          `vault://${stringValue(requestBody.path)}`, 'full').then(knowledgeDocument, () => undefined)
        : undefined
      send(res, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(current === undefined ? {} : { current }),
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
