import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SimulationPurpose } from '@deepseek-ai/dsh-worldline-standard'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorldlineCompiler from '../src/index.ts'

const roots: string[] = []

async function start(): Promise<{ ctx: Context; root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-compiler-'))
  roots.push(root)
  const ctx = new Context()
  const projects = ctx.plugin(LocalWorldlineProjects, {
    root,
    maxEntries: 5000,
    maxSearchFiles: 50_000,
  })
  await projects.await()
  const compiler = ctx.plugin(WorldlineCompiler)
  await compiler.await()
  return {
    ctx,
    root,
    dispose: async () => {
      await compiler.dispose()
      await projects.dispose()
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const purpose: SimulationPurpose = {
  summary: 'Run one day of an autonomous village.',
  scope: ['characters', 'space', 'actions'],
  duration: 86_400,
  resolution: 60,
  detail: 'L2',
  hardExpectations: ['A legal action can commit without violating safety.'],
  statisticalExpectations: [],
  antiPatterns: ['instant ordinary movement'],
}

const mechanismSource = '# Executable core\n\nRuntime semantics are stored outside Markdown.\n'
const mechanismRuntime = {
  maps: [{
    id: 'map:village01', version: 1, name: 'Village', rootNodeId: 'map-node:village01',
    layers: [{ id: 'ground', name: 'Ground', visible: true, locked: false, order: 0 }],
    nodes: [{
      id: 'map-node:village01', layerId: 'ground', kind: 'world', name: 'Village',
      description: 'A compact riverside village whose lanes, weathered houses, and shared square anchor everyday work and travel.',
      position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [],
    }],
    edges: [],
  }],
  actions: [{
    id: 'world.wait', description: 'Wait while time passes', actorTypes: ['character'],
    location: { mode: 'anywhere' },
    duration: 60, maxWait: 300, maxRetries: 2,
    effects: [{ op: 'increment', path: 'state.elapsed', amount: 60 }],
  }, {
    id: 'world.observe', description: 'Observe the passing moment', actorTypes: ['character'],
    location: { mode: 'anywhere' },
    duration: 10, maxWait: 300, maxRetries: 2,
    effects: [{ op: 'increment', path: 'state.elapsed', amount: 10 }],
  }],
  systems: [{
    id: 'world.clock', description: 'Advance the world clock', interval: 60,
    effects: [{ op: 'increment', path: 'world.time', amount: 60 }],
  }],
  invariants: [{
    id: 'world.time.nonnegative', description: 'Time never becomes negative',
    expression: { op: 'gte', path: 'world.time', value: 0 },
  }],
}

async function setRuntimeModel(
  ctx: Context,
  projectId: string,
  runtime: Record<string, unknown> = mechanismRuntime,
): Promise<void> {
  await ctx.worldlineProjects.writeControl({
    projectId: projectId as Parameters<Context['worldlineProjects']['writeControl']>[0]['projectId'],
    namespace: 'compiler',
    path: 'runtime-model.json',
    content: JSON.stringify({ documents: { 'mechanisms/runtime.md': runtime } }),
  })
}

describe('WorldlineCompiler', () => {
  it('surfaces closure questions instead of inventing missing runtime mechanics', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Questions', template: 'blank' })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(false)
    expect(preview.questions.map(item => item.id)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^question:/u),
    ]))
    expect(preview.certificate.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'actions', status: 'blocking' }),
      expect.objectContaining({ category: 'space', status: 'blocking' }),
    ]))
    await expect(runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ code: 'closure-blocked' })
    await runtime.dispose()
  })

  it('blocks removed Markdown runtime fences instead of compiling a compatibility path', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Obsolete Runtime', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/obsolete.md',
      content: '# 旧结构\n\n```worldline-action\n{"id":"old.wait"}\n```\n',
      createParents: true,
      objectKind: 'rule',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(false)
    expect(preview.diagnostics).toContainEqual(expect.objectContaining({
      code: 'obsolete-runtime-fence',
      severity: 'blocking',
      path: 'mechanisms/obsolete.md',
    }))
    expect(preview.executableCounts.actions).toBe(0)
    await runtime.dispose()
  })

  it('compiles source-anchored mechanisms and freezes a content-addressed immutable Blueprint', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Runnable', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
      content: `# 测试角色

\`\`\`worldline-state-schema
elapsed:
  type: number
  mutable: false
  label: 已用时间
  participation:
    drivers: [action]
    meaning: 角色已经投入当前行动的时间
    narrative: 时间积累会带来疲劳与紧迫感
    choices: 时间越久越优先选择收束或休整
    bands:
      - { max: 59, label: 刚开始, narrative: 动作仍从容, choices: 可以继续观察 }
      - { min: 60, label: 已持续, narrative: 时间压力开始显现, choices: 应考虑收束 }
locationId:
  type: string
  mutable: false
  label: 当前位置
\`\`\`

\`\`\`worldline-initial-state
elapsed: 0
locationId: map-node:village01
\`\`\``,
      createParents: true,
      objectKind: 'character',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/protagonist.md',
      content: '# 主角\n\n写明身份、外观、性格、价值观、目标、能力、资源、关系、经历与初始位置。\n',
      createParents: true,
      objectKind: 'character',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview).toMatchObject({
      canFreeze: true,
      sourceCoverage: 1,
      executableCounts: { maps: 1, actions: 2, systems: 1, invariants: 1 },
    })
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'world.wait', location: { mode: 'anywhere' } }),
    ]))
    expect(frozen.blueprint.entities[0]?.facets.stateSchema).toMatchObject({
      elapsed: {
        label: '已用时间',
        participation: { drivers: ['action'], meaning: '角色已经投入当前行动的时间' },
      },
    })
    expect(frozen.blueprint.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(frozen.blueprint.actions[0]?.provenance[0]?.anchors[0]?.documentId).toMatch(/^doc:/u)
    const active = await readFile(join(project.path, '.worldline', 'builds', 'active'), 'utf8')
    expect(active.trim()).toBe(frozen.blueprint.digest)
    const stored = JSON.parse(await readFile(join(
      project.path,
      '.worldline',
      'builds',
      frozen.blueprint.digest,
      'blueprint.json',
    ), 'utf8')) as { digest: string }
    expect(stored.digest).toBe(frozen.blueprint.digest)
    await runtime.dispose()
  })

  it('proves later script actions through bounded forward witness states', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({
      name: 'Sequential plot',
      template: 'blank',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/plot.md',
      content: '# 顺序剧情机制\n\n第一幕完成后才允许进入第二幕，第二幕再唤醒天气系统。\n',
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/protagonist.md',
      content: '# 主角\n\n一名会依次经历两个剧本点的学生。\n',
      createParents: true,
      objectKind: 'character',
    })
    await runtime.ctx.worldlineProjects.writeControl({
      projectId: project.manifest.id,
      namespace: 'compiler',
      path: 'runtime-model.json',
      content: JSON.stringify({ documents: {
        'mechanisms/plot.md': {
          maps: [{
            id: 'map:campus01', version: 1, name: '校园', rootNodeId: 'map-node:campus01',
            layers: [{ id: 'ground', name: '地面', visible: true, locked: false, order: 0 }],
            nodes: [{
              id: 'map-node:campus01', layerId: 'ground', kind: 'world', name: '校园',
              position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [],
            }],
            edges: [],
          }],
          actions: [{
            id: 'plot.advance', description: '完成第一幕', actorTypes: ['character'],
            duration: 1, maxWait: 5, maxRetries: 1,
            preconditions: [{ op: 'eq', path: 'world.time', value: 0 }],
            effects: [{ op: 'set', path: 'world.time', value: 1 }],
          }, {
            id: 'plot.resolve', description: '进入第二幕', actorTypes: ['character'],
            duration: 1, maxWait: 5, maxRetries: 1,
            preconditions: [{ op: 'eq', path: 'world.time', value: 1 }],
            effects: [{ op: 'set', path: 'world.time', value: 2 }],
          }],
          systems: [{
            id: 'plot.weather', description: '第二幕后天气发生变化', interval: 60,
            preconditions: [{ op: 'eq', path: 'world.time', value: 2 }],
            effects: [{ op: 'increment', path: 'world.time', amount: 1 }],
          }],
          invariants: [{
            id: 'world.time.bound', description: '测试剧情状态保持有界',
            expression: { op: 'lte', path: 'world.time', value: 3 },
          }],
        },
      } }),
    })

    const preview = await runtime.ctx.worldlineCompiler.compile({
      projectId: project.manifest.id,
      purpose,
    })
    expect(preview.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'action-unreachable' }),
      expect.objectContaining({ code: 'system-no-progress' }),
    ]))
    expect(preview.certificate.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'actions', status: 'pass' }),
      expect.objectContaining({ category: 'liveness', status: 'pass' }),
    ]))
    expect(preview.canFreeze).toBe(true)
    await runtime.dispose()
  })

  it('keeps Markdown readable while compiling the hidden runtime model and character resources', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Readable OC', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: '# 村庄的生活规律\n\n居民每天会休息，村庄时钟持续前进。\n',
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
      content: '# 林汐\n\n林汐是村里的信使，随身携带三封等待送出的信。\n',
      createParents: true,
      objectKind: 'character',
    })
    await runtime.ctx.worldlineProjects.writeControl({
      projectId: project.manifest.id,
      namespace: 'compiler',
      path: 'runtime-model.json',
      content: JSON.stringify({ documents: {
        'characters/tester.md': { facets: {
          initialState: { elapsed: 0 },
          memory: { goals: ['送完三封信'] },
          resources: {
            knowledge: ['facts/linxi-letters.md'],
            visual: { portrait: 'assets/files/characters/linxi/visual/portrait.png' },
            audio: { voice: 'assets/files/characters/linxi/audio/greeting.ogg' },
          },
        } },
        'mechanisms/runtime.md': {
          maps: [{
            id: 'map:village01', version: 1, name: '村庄', rootNodeId: 'map-node:village01',
            layers: [{ id: 'ground', name: '地面', visible: true, locked: false, order: 0 }],
            nodes: [{ id: 'map-node:village01', layerId: 'ground', kind: 'world', name: '村庄', position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] }],
            edges: [],
          }],
          actions: [{ id: 'world.wait', description: '等待片刻', actorTypes: ['character'], duration: 60, maxWait: 300, maxRetries: 2, effects: [{ op: 'increment', path: 'state.elapsed', amount: 60 }] }],
          systems: [{ id: 'world.clock', description: '村庄时钟前进', interval: 60, effects: [{ op: 'increment', path: 'world.time', amount: 60 }] }],
          invariants: [{ id: 'world.time.nonnegative', description: '时间不能倒流', expression: { op: 'gte', path: 'world.time', value: 0 } }],
        },
      } }),
    })

    const source = await runtime.ctx.worldlineProjects.read({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
    })
    expect(source.content).not.toContain('worldline-')
    expect(source.content).not.toContain('"initialState"')
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview).toMatchObject({
      canFreeze: true,
      executableCounts: { maps: 1, actions: 1, systems: 1, invariants: 1 },
    })
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.entities[0]).toMatchObject({
      state: { elapsed: 0 },
      facets: {
        resources: {
          visual: { portrait: 'assets/files/characters/linxi/visual/portrait.png' },
          audio: { voice: 'assets/files/characters/linxi/audio/greeting.ogg' },
        },
      },
      memory: { goals: [{ goal: '送完三封信', status: 'active' }] },
    })
    await runtime.dispose()
  })

  it('freezes ordered human-readable plot points as the authoritative script track', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Scripted World', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
      content: `# 测试角色

\`\`\`worldline-state-schema
elapsed:
  type: number
  mutable: false
  label: 已用时间
  participation:
    drivers: [action]
    meaning: 角色已经投入当前行动的时间
    narrative: 时间积累会带来疲劳与紧迫感
    choices: 时间越久越优先选择收束或休整
    bands:
      - { max: 59, label: 刚开始, narrative: 动作仍从容, choices: 可以继续观察 }
      - { min: 60, label: 已持续, narrative: 时间压力开始显现, choices: 应考虑收束 }
locationId:
  type: string
  mutable: false
  label: 当前位置
\`\`\`

\`\`\`worldline-initial-state
elapsed: 0
locationId: map-node:village01
\`\`\``,
      createParents: true,
      objectKind: 'character',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'scenarios/plot-points/01-opening.md',
      content: `# 放学后的约定

两位学生必须先完成值日，才能赶去天台赴约。

## 剧情推进

- 顺序：1
- 激活时刻（游戏秒）：0
- 截止时刻（游戏秒）：3600
- 时间干预：3000|闭馆警报|教学楼广播宣布十分钟后关闭
- 时间干预：3300|暴雨封路|通往天台的外廊因暴雨强制封闭
- 进入条件：值日尚未完成，两位学生都还在教学楼
- 完成证据：两位学生明确确认天台约定
- 戏剧压力：教学楼即将关闭，暴雨警报正在升级
- 成功后果：天台约定成为下一幕的现实前提
- 失败后果：双方错过会面，异常来临时无法协作
- 恢复钩子：未送出的消息可在下一地点重新建立联系

\`\`\`worldline-initial-world-state
world:
  calendar:
    secondsPerDay: 86400
    daysPerSeason: 28
    seasons: [春季, 夏季, 秋季, 冬季]
    week: 1
    weekday: 周一
    startDayIndex: 1
    startClockMinute: 960
\`\`\`

\`\`\`worldline-world-state-schema
time:
  type: number
  mutable: false
  label: 世界时钟
  participation:
    drivers: [system]
    meaning: 世界已经推进的秒数
    narrative: 时间推进改变场景节奏与外界响应
    choices: 时间越久越重视截止压力
    bands:
      - { max: 59, label: 起始, narrative: 场景刚刚开始, choices: 可从容观察 }
      - { min: 60, label: 推进, narrative: 环境开始随时间变化, choices: 要考虑时间成本 }
\`\`\`
`,
      createParents: true,
      objectKind: 'scenario',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.diagnostics).toEqual([])
    expect(preview.canFreeze).toBe(true)
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.plotPoints).toEqual([
      expect.objectContaining({
        name: '放学后的约定',
        order: 1,
        entryCondition: '值日尚未完成，两位学生都还在教学楼',
        completionCriteria: '两位学生明确确认天台约定',
        dramaticPressure: '教学楼即将关闭，暴雨警报正在升级',
      }),
    ])
    expect(frozen.blueprint.plotPoints?.[0]?.timing?.interventions).toEqual([
      expect.objectContaining({ at: 3000, title: '闭馆警报' }),
      expect.objectContaining({ at: 3300, title: '暴雨封路' }),
    ])
    await runtime.dispose()
  })

  it('blocks obsolete hidden facets and story worlds with guessed time or location', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Invalid story authority', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
      content: `# 测试角色

<!-- worldline-facets {"initialState":{"locationId":"map-node:guessed"}} -->

\`\`\`worldline-state-schema
locationId:
  type: string
  mutable: true
\`\`\`

\`\`\`worldline-initial-state
locationId: map-node:guessed
\`\`\``,
      createParents: true,
      objectKind: 'character',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'scenarios/plot-points/01-invalid.md',
      content: `# 不完整权威

## 剧情推进

- 顺序：1
- 进入条件：角色仍在场
- 完成证据：角色确认事实
- 戏剧压力：时间正在流逝
- 成功后果：进入下一幕
- 失败后果：出现现实阻碍
- 恢复钩子：可以再次调查
`,
      createParents: true,
      objectKind: 'scenario',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(false)
    expect(preview.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'obsolete-worldline-facets', severity: 'blocking' }),
      expect.objectContaining({ code: 'story-time-unconfigured', severity: 'blocking' }),
      expect.objectContaining({ code: 'story-location-unconfigured', severity: 'blocking' }),
      expect.objectContaining({ code: 'story-location-schema-invalid', severity: 'blocking' }),
    ]))
    await runtime.dispose()
  })

  it('blocks targetless social actions before they can create fake dialogue choices', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Grounded Social', template: 'blank' })
    const targetlessSocial = {
      id: 'social.bond', description: '与同伴深交并建立关系', actorTypes: ['character'],
      duration: 20, maxWait: 60, maxRetries: 1,
      effects: [{ op: 'increment', path: 'state.bond', amount: 1 }],
    }
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id, {
      ...mechanismRuntime,
      actions: [...mechanismRuntime.actions, targetlessSocial],
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
      content: '# 测试角色\n\n```worldline-initial-state\nelapsed: 0\nbond: 0\n```',
      createParents: true,
      objectKind: 'character',
    })

    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(false)
    expect(preview.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'social-action-targetless',
        severity: 'blocking',
        objectId: 'social.bond',
      }),
    ]))
    await expect(runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ code: 'closure-blocked' })
    await runtime.dispose()
  })

  it('compiles native OC editor fields from human-readable Markdown', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Native OC', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/linxi.md',
      content: `# 林汐

潮汐邮局的年轻投递员。

## 基本信息

- 年龄：19 岁
- 性别／形态：女／人类
- 身份／职业：邮差

## 性格与人生

- 性格：温和而固执
- 关键词：潮汐、信件
- 目标：送完三封无法投递的信

## 记忆与知识

- 知识资料：facts/linxi-letters.md

## 可运行状态

\`\`\`worldline-state-schema
emotion:
  type: string
  mutable: true
inventory:
  type: array
  mutable: true
\`\`\`

\`\`\`worldline-initial-state
emotion: 平静
inventory:
  - 旧信袋
\`\`\`

## 角色资源

- 头像：assets/files/characters/linxi/avatar.png
- 默认立绘：assets/files/characters/linxi/standing.png
- 形象画廊：assets/files/characters/linxi/smile.png；assets/files/characters/linxi/rain.png
- 语音：assets/files/characters/linxi/intro.mp3
- 角色曲：assets/files/characters/linxi/theme.mp3
`,
      createParents: true,
      objectKind: 'character',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(true)
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id, purpose, expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.entities[0]).toMatchObject({
      facets: {
        displayName: '林汐',
        profile: { age: '19 岁', gender: '女／人类', identity: '邮差', personality: '温和而固执', keywords: ['潮汐', '信件'] },
        resources: {
          visual: {
            portrait: 'assets/files/characters/linxi/avatar.png',
            expression: 'assets/files/characters/linxi/standing.png',
            gallery: ['assets/files/characters/linxi/smile.png', 'assets/files/characters/linxi/rain.png'],
          },
          audio: { voice: 'assets/files/characters/linxi/intro.mp3', theme: 'assets/files/characters/linxi/theme.mp3' },
          knowledge: ['facts/linxi-letters.md'],
        },
        stateSchema: {
          emotion: { type: 'string', mutable: true },
          inventory: { type: 'array', mutable: true },
        },
        initialState: { emotion: '平静', inventory: ['旧信袋'] },
      },
      state: { emotion: '平静', inventory: ['旧信袋'] },
      memory: { goals: [{ goal: '送完三封无法投递的信', status: 'active' }] },
    })
    await runtime.dispose()
  })

  it('discovers conventional character assets from free-form Markdown sections', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Free-form OC', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/gu-xingye.md',
      content: `# 顾星野

星轨学园的学生。

## 身份

高二学生，天文社成员，也是故事的第一视角。

## 性格

温和、耐心、观察力强。

## 目标

查明天空裂隙的真相并守护同伴。

## 资源

立绘资源索引位于 \`assets/files/characters/gu-xingye/\`，现有形象见
\`visual/alert-portrait.png\`，语音见 \`audio/voice-intro.ogg\`。
`,
      createParents: true,
      objectKind: 'character',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(true)
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.entities[0]).toMatchObject({
      facets: {
        profile: {
          identity: '高二学生，天文社成员，也是故事的第一视角。',
          personality: '温和、耐心、观察力强。',
        },
        resources: {
          visual: {
            portrait: 'assets/files/characters/gu-xingye/visual/alert-portrait.png',
            expression: 'assets/files/characters/gu-xingye/visual/alert-portrait.png',
          },
          audio: { voice: 'assets/files/characters/gu-xingye/audio/voice-intro.ogg' },
        },
      },
      memory: { goals: [{ goal: '查明天空裂隙的真相并守护同伴。', status: 'active' }] },
    })
    await runtime.dispose()
  })

  it('assembles native place documents into one reachable world map', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Native Map', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({ projectId: project.manifest.id, path: 'mechanisms/runtime.md', content: mechanismSource, createParents: true, objectKind: 'rule' })
    await setRuntimeModel(runtime.ctx, project.manifest.id, { ...mechanismRuntime, maps: [] })
    await runtime.ctx.worldlineProjects.write({ projectId: project.manifest.id, path: 'characters/tester.md', content: '# 测试角色\n', createParents: true, objectKind: 'character' })
    await runtime.ctx.worldlineProjects.write({ projectId: project.manifest.id, path: 'maps/places/world.md', content: '# 星露谷\n\n小镇与农场所在的世界。\n\n- 地点 ID：map-node:world00\n- 地点类型：world\n- 上级地点：—\n- 地图坐标：100, 100\n- 相邻地点：map-node:farm00|15\n', createParents: true, objectKind: 'place' })
    await runtime.ctx.worldlineProjects.write({ projectId: project.manifest.id, path: 'maps/places/farm.md', content: '# 农场\n\n可以耕作和生活的农场。\n\n- 地点 ID：map-node:farm00\n- 地点类型：region\n- 上级地点：map-node:world00\n- 地图坐标：360, 180\n- 相邻地点：map-node:world00|15\n- 场景背景：assets/files/locations/farm/spring-morning.png\n', createParents: true, objectKind: 'place' })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(true)
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id, purpose, expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.maps[0]).toMatchObject({ name: '世界地图', rootNodeId: 'map-node:world00' })
    expect(frozen.blueprint.maps[0]?.nodes).toHaveLength(2)
    expect(frozen.blueprint.maps[0]?.nodes.find(node => node.id === 'map-node:farm00'))
      .toMatchObject({ background: 'assets/files/locations/farm/spring-morning.png' })
    expect(frozen.blueprint.maps[0]?.edges).toEqual([expect.objectContaining({ baseDuration: 15, bidirectional: true })])
    expect(new Set([frozen.blueprint.maps[0]?.edges[0]?.from, frozen.blueprint.maps[0]?.edges[0]?.to])).toEqual(new Set(['map-node:world00', 'map-node:farm00']))
    await runtime.dispose()
  })

  it('merges native place presentation metadata into an existing executable map', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Map Presentation', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/tester.md',
      content: '# 测试角色\n\n```worldline-initial-state\nelapsed: 0\n```',
      createParents: true,
      objectKind: 'character',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'maps/places/village.md',
      content: '# 星穹学园\n\n互动小说的主舞台。\n\n- 地点 ID：`map-node:village01`\n- 地点类型：世界（World）\n- 上级地点：—（地图根节点）\n- 地图坐标：(320, 180)\n- 容纳人数：约 1200 人\n- 相邻地点：\n  - `map-node:village01|15`\n- 场景背景：`assets/files/locations/campus/background.png`\n',
      createParents: true,
      objectKind: 'place',
    })

    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(true)
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })

    expect(frozen.blueprint.maps[0]?.nodes[0]).toMatchObject({
      id: 'map-node:village01',
      name: '星穹学园',
      position: { x: 320, y: 180 },
      capacity: 1200,
      background: 'assets/files/locations/campus/background.png',
    })
    await runtime.dispose()
  })

  it('rejects freeze when any source changed after preview', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Race', template: 'blank' })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id })
    const charter = await runtime.ctx.worldlineProjects.read({
      projectId: project.manifest.id,
      path: 'canon/charter.md',
    })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: charter.path,
      content: `${charter.content}\nA later edit.`,
      expectedRevision: charter.revision,
    })
    await expect(runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      expectedSourceDigest: preview.sourceDigest,
    })).rejects.toMatchObject({ code: 'source-changed' })
    await runtime.dispose()
  })

  it('persists reviewable proposals with optimistic state revisions', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Review', template: 'blank' })
    const state = await runtime.ctx.worldlineCompiler.submitProposal({
      projectId: project.manifest.id,
      target: 'action',
      title: 'Add a bounded rest action',
      rationale: 'Characters need deterministic recovery.',
      risk: 'medium',
      payload: {
        id: 'character.rest', description: 'Rest', duration: 3600, maxWait: 600,
        effects: [{ op: 'increment', path: 'state.energy', amount: 1 }],
      },
      anchors: [],
    })
    const proposal = state.proposals[0]!
    if (state.revision === undefined) throw new Error('proposal state has no persisted revision')
    const reviewed = await runtime.ctx.worldlineCompiler.reviewProposal({
      projectId: project.manifest.id,
      proposalId: proposal.id,
      decision: 'approved',
      reviewedBy: 'test-author',
      expectedStateRevision: state.revision,
    })
    expect(reviewed.proposals[0]).toMatchObject({ status: 'approved', reviewedBy: 'test-author' })
    await expect(runtime.ctx.worldlineCompiler.reviewProposal({
      projectId: project.manifest.id,
      proposalId: proposal.id,
      decision: 'rejected',
      reviewedBy: 'stale-author',
      expectedStateRevision: state.revision,
    })).rejects.toMatchObject({ code: 'state-conflict' })
    await runtime.dispose()
  })

  it('materializes only runtime characters and preserves concise authored memory', async () => {
    const runtime = await start()
    const project = await runtime.ctx.worldlineProjects.create({ name: 'Memory', template: 'blank' })
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanismSource,
      createParents: true,
      objectKind: 'rule',
    })
    await setRuntimeModel(runtime.ctx, project.manifest.id)
    await runtime.ctx.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/courier.md',
      content: `# 林汐

\`\`\`worldline-initial-state
elapsed: 0
energy: 10
\`\`\`

\`\`\`worldline-memory
episodic: [曾答应送回三封信]
beliefs:
  northBeaconBroken: false
goals: [deliver-three-letters]
relationships:
  entity:keeper: 1
\`\`\``,
      createParents: true,
      objectKind: 'character',
    })
    const preview = await runtime.ctx.worldlineCompiler.compile({ projectId: project.manifest.id, purpose })
    expect(preview.canFreeze).toBe(true)
    const frozen = await runtime.ctx.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    expect(frozen.blueprint.entities).toHaveLength(1)
    expect(frozen.blueprint.entities[0]).toMatchObject({
      type: 'character',
      state: { elapsed: 0, energy: 10 },
      memory: {
        episodic: [{ summary: '曾答应送回三封信' }],
        beliefs: [{ subject: 'northBeaconBroken', value: false }],
        goals: [{ goal: 'deliver-three-letters', status: 'active' }],
        relationships: [{ otherId: 'entity:keeper', dimensions: { affinity: 1 } }],
      },
    })
    expect(frozen.blueprint.entities).toHaveLength(1)
    expect(frozen.blueprint.entities.some(entity => entity.type === 'rule')).toBe(false)
    await runtime.dispose()
  })
})
