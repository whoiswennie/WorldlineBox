// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type {
  NarrativeStreamChunk,
  StoryChoiceSuggestions,
  TextPlayView,
} from '@deepseek-ai/dsh-worldline-narrative/types'
import type {
  CompletePresentationRequest,
  RunSpatialView,
  RunView,
} from '@deepseek-ai/dsh-worldline-runtime/types'
import type { EntityId, NarrativeBeat } from '@deepseek-ai/dsh-worldline-standard/types'
import { runAutonomyCycle, SimulationWorkbench } from '../src/client/SimulationWorkbench.tsx'
import {
  initialStoryPlayback,
  MediaIntentPlaceholder,
  shouldFollowSuggestedActor,
  stableRunOrder,
  storyAgentStages,
  storyStageWindow,
  TextPlayWorkbench,
  userFacingStoryError,
} from '../src/client/TextPlayWorkbench.tsx'
import {
  characterFacts,
  characterMemorySections,
  characterResources,
  gameCalendar,
  newWorldlineSeed,
  worldEnvironmentFacts,
} from '../src/client/presentation.ts'
import type { AiClient, NarrativeClient, ProjectClient, RunsClient } from '../src/client/types.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('Worldline authored calendar projection', () => {
  it('renders native image and audio intents inline with generator prompts and text fallbacks', () => {
    const { rerender } = render(<MediaIntentPlaceholder intent={{
      kind: 'image',
      purpose: 'scene',
      prompt: '第七码头候潮厅，窗外潮雾压低，人物只以背影出现。',
      fallbackText: '此处应出现候潮厅被潮雾包围的场景图。',
    }} />)
    expect(screen.getByLabelText('待生成图片：此处应出现候潮厅被潮雾包围的场景图。')
      .getAttribute('data-kind')).toBe('image')
    fireEvent.click(screen.getByText('查看生成提示词'))
    expect(screen.getByText('第七码头候潮厅，窗外潮雾压低，人物只以背影出现。')
      .textContent).toContain('人物只以背影出现')

    rerender(<MediaIntentPlaceholder intent={{
      kind: 'audio',
      purpose: 'sfx',
      prompt: '低沉潮钟与远处列车制动摩擦声，无对白。',
      fallbackText: '此处应响起潮钟与列车制动声。',
    }} />)
    expect(screen.getByLabelText('待生成音频：此处应响起潮钟与列车制动声。')
      .getAttribute('data-purpose')).toBe('sfx')
  })

  it('restores a completed beat without replaying its reveal animation', () => {
    const beat = {
      id: 'narrative-beat:restore-test',
      invocationId: 'ai-invocation:restore-test',
      perspectiveActorId: 'entity:reader',
      eventIds: [],
      observationIds: [],
      camera: 'limited-third-person',
      text: '第一段\n\n第二段',
      blocks: [
        { type: 'narration', text: '第一段' },
        { type: 'narration', text: '第二段' },
      ],
      media: [],
      modelRoute: { provider: 'test', model: 'narrator' },
    } as unknown as NarrativeBeat
    expect(initialStoryPlayback(beat, beat.id)).toEqual({
      revealLength: 2,
      blockIndex: 1,
      typingLength: 3,
    })
    expect(initialStoryPlayback(beat, undefined)).toEqual({
      revealLength: 1,
      blockIndex: 0,
      typingLength: 0,
    })
  })

  it('projects inventory and equipment from authoritative character state', () => {
    expect(characterFacts({
      state: {
        inventory: ['灯笼', '钟楼钥匙'],
        equipment: { 短剑: 1, 旧盾: true, 丢失物: false },
      },
    })).toEqual([
      { label: '随身物品', value: '灯笼、钟楼钥匙' },
      { label: '装备', value: '短剑 × 1、旧盾' },
    ])
  })

  it('projects every schema-authored custom character state and retained memory', () => {
    const entity = {
      facets: {
        stateSchema: {
          routeSense: { type: 'string', mutable: true, label: '潮路感知' },
          'evidence.fragments': { type: 'array', mutable: true, label: '证据碎片' },
        },
      },
      state: { routeSense: '回声偏左', evidence: { fragments: ['铜哨', '断页'] } },
      memory: {
        episodic: [{ summary: '亲眼看见桥下信标熄灭。' }],
        beliefs: [{ content: '闻栖隐瞒了潮位记录。' }],
      },
    }
    expect(characterFacts(entity)).toEqual([
      { label: '潮路感知', value: '回声偏左' },
      { label: '证据碎片', value: '铜哨、断页' },
    ])
    expect(characterMemorySections(entity)).toEqual([
      { label: '近期经历', entries: ['亲眼看见桥下信标熄灭。'] },
      { label: '认知与判断', entries: ['闻栖隐瞒了潮位记录。'] },
    ])
  })

  it('generates a distinct seed for each fresh playthrough', () => {
    expect(newWorldlineSeed()).not.toBe(newWorldlineSeed())
  })

  it('keeps worldline numbers stable when recently updated runs are returned first', () => {
    const newestActivity = {
      runId: 'run:older', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    } as RunView['summary']
    const newerRun = {
      runId: 'run:newer', createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } as RunView['summary']
    expect(stableRunOrder([newerRun, newestActivity]).map(item => item.runId)).toEqual([
      'run:older', 'run:newer',
    ])
  })

  it('keeps one perspective actor for every stage of an active story turn', () => {
    const current = 'entity:current' as EntityId
    const next = 'entity:next' as EntityId

    expect(shouldFollowSuggestedActor(false, undefined, current, [next])).toBe(next)
    expect(shouldFollowSuggestedActor(false, current, next, [next])).toBe(current)
    expect(shouldFollowSuggestedActor(false, current, current, [next])).toBeUndefined()
    expect(shouldFollowSuggestedActor(true, current, next, [next])).toBeUndefined()
  })

  it('explains the real four-stage story agent pipeline', () => {
    expect(storyAgentStages('context').map(item => item.status)).toEqual([
      'active', 'pending', 'pending', 'pending',
    ])
    expect(storyAgentStages('world-state').map(item => item.status)).toEqual([
      'done', 'done', 'active', 'pending',
    ])
    expect(storyAgentStages('choices').map(item => item.status)).toEqual([
      'done', 'done', 'done', 'active',
    ])
    expect(storyAgentStages('world-state')[2]?.detail).toContain('全部角色')
  })

  it('keeps a bounded Kiny-style trail ending at the current story beat', () => {
    const beats = Array.from({ length: 12 }, (_, index) => ({
      id: `narrative-beat:${String(index)}`,
      invocationId: `ai-invocation:${String(index)}`,
      perspectiveActorId: 'entity:reader',
      eventIds: [],
      observationIds: [],
      camera: 'limited-third',
      text: `Beat ${String(index)}`,
      blocks: [{ type: 'narration', text: `Beat ${String(index)}` }],
      media: [],
      modelRoute: { provider: 'test', model: 'narrator' },
    })) as unknown as NarrativeBeat[]

    expect(storyStageWindow(beats).map(beat => beat.id)).toEqual(
      beats.slice(4).map(beat => beat.id),
    )
    expect(storyStageWindow(beats, 3).map(beat => beat.id)).toEqual(
      beats.slice(9).map(beat => beat.id),
    )
  })

  it('treats calendar.startClockMinute as the authored start clock instead of midnight', () => {
    const calendar = gameCalendar({
      logicalTime: 7_090,
      state: {
        world: {
          calendar: {
            secondsPerDay: 86_400,
            daysPerSeason: 28,
            seasons: ['春季', '夏季', '秋季', '冬季'],
            week: 1,
            weekday: '周一',
            startDayIndex: 1,
            startClockMinute: 1_005,
          },
        },
      },
    })
    expect(calendar.dateLabel).toBe('第 1 周 · 周一')
    expect(calendar.timeLabel).toBe('18:43')
    expect(calendar.fullLabel).toBe('第 1 周 · 周一 18:43')
  })

  it('uses the authored world era as the calendar anchor and rolls it forward', () => {
    const state = {
      world: {
        calendar: {
          secondsPerDay: 86_400,
          daysPerSeason: 9,
          seasons: ['第一伪月周期', '第二伪月周期', '第三伪月周期', '第四伪月周期',
            '第五伪月周期', '第六伪月周期'],
          startDayIndex: 53,
          startClockMinute: 1_397,
        },
        year: 218,
        season: '第六伪月周期',
        day: 8,
      },
    }
    expect(gameCalendar({ logicalTime: 0, state })).toMatchObject({
      dateLabel: '第 218 年 · 第六伪月周期 8 日',
      timeLabel: '23:17',
    })
    expect(gameCalendar({ logicalTime: 45 * 60, state })).toMatchObject({
      dateLabel: '第 218 年 · 第六伪月周期 9 日',
      timeLabel: '00:02',
    })
  })

  it('shows an explicit unconfigured state instead of inventing spring midnight', () => {
    expect(gameCalendar({ logicalTime: 0, state: {} })).toMatchObject({
      configured: false,
      dateLabel: '历法未配置',
      timeLabel: '--:--',
      fullLabel: '历法与开场时间未配置',
    })
  })

  it('rolls the authored weekday and week forward with logical time', () => {
    const calendar = gameCalendar({
      logicalTime: 7 * 86_400,
      state: {
        world: {
          calendar: {
            secondsPerDay: 86_400,
            daysPerSeason: 28,
            seasons: ['春季', '夏季', '秋季', '冬季'],
            week: 1,
            weekday: '周一',
            startDayIndex: 1,
            startClockMinute: 0,
          },
        },
      },
    })
    expect(calendar.dateLabel).toBe('第 2 周 · 周一')
    expect(calendar.timeLabel).toBe('00:00')
  })

  it('projects changing weather and hazards without exposing raw state paths', () => {
    const facts = worldEnvironmentFacts({
      state: {
        world: {
          weather: { severity: 4 },
          hazards: { exposureRisk: 22 },
          disaster: { stage: 2 },
        },
        conflict: { greyTide: 6, infectedCount: 7 },
      },
    })
    expect(facts).toEqual([
      { label: '天气', value: '风雨逼近', level: 'danger' },
      { label: '阶段', value: '异变', level: 'notice' },
      { label: '灰潮', value: '6', level: 'danger' },
      { label: '灰骸', value: '7', level: 'danger' },
      { label: '暴露', value: '22', level: 'danger' },
    ])
    expect(JSON.stringify(facts)).not.toContain('exposureRisk')
  })

  it('projects arbitrary world state declared by the current schema', () => {
    expect(worldEnvironmentFacts({
      state: {
        world: {
          year: 218,
          season: '第六伪月周期',
          day: 8,
          time: '23:17',
          storm: { pressure: 73 },
          bridge: { integrity: 41 },
          allocation: ['北仓', '泵站'],
          calendar: { startClockMinute: 700 },
        },
        worldStateSchema: {
          year: { type: 'number', mutable: false, label: '年份' },
          season: { type: 'string', mutable: false, label: '季节' },
          day: { type: 'number', mutable: false, label: '日期' },
          time: { type: 'string', mutable: false, label: '时间' },
          'storm.pressure': {
            type: 'number', mutable: true, label: '风暴压力',
            participation: { bands: [{ min: 70, label: '逼近临界', tone: 'danger' }] },
          },
          'bridge.integrity': { type: 'number', mutable: true, label: '桥体完整度' },
          allocation: { type: 'array', mutable: true, label: '救援分配' },
          'calendar.startClockMinute': { type: 'number', mutable: false },
        },
      },
    })).toEqual([
      { label: '风暴压力', value: '73 · 逼近临界', level: 'danger' },
      { label: '桥体完整度', value: '41', level: 'normal' },
      { label: '救援分配', value: '北仓、泵站', level: 'normal' },
    ])
  })

  it('selects the authored expression that matches the live character emotion', () => {
    const resources = characterResources('project:atlas', {
      state: { emotion: 'anxious' },
      facets: {
        resources: {
          visual: {
            portrait: 'assets/files/characters/traveller/portrait.png',
            expressions: {
              default: 'assets/files/characters/traveller/neutral.png',
              anxious: 'assets/files/characters/traveller/anxious.png',
            },
          },
        },
      },
    })
    expect(resources.expression).toContain('assets%2Ffiles%2Fcharacters%2Ftraveller%2Fanxious.png')
    expect(resources.expression).not.toContain('neutral.png')
  })

  it('does not expose transport-layer error prefixes to readers', () => {
    expect(userFacingStoryError(new Error('internal: 这个交互缺少当前在场的对象。')))
      .toBe('这个交互缺少当前在场的对象。')
  })
})

function ownMethod(target: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(target, name)?.value
}

const runId = 'run:simulation-map-test' as RunView['summary']['runId']
const project = {
  manifest: { id: 'project:simulation-map-test', name: 'Map world' },
} as unknown as ProjectSummary
const view = {
  summary: {
    runId,
    projectId: project.manifest.id,
    branchId: 'worldline:main',
    blueprintDigest: 'a'.repeat(64),
    status: 'paused',
    logicalTime: 4,
    sequence: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  },
  snapshot: {
    logicalTime: 4,
    sequence: 2,
    state: {
      world: {
        time: 0,
        calendar: {
          secondsPerDay: 86_400,
          daysPerSeason: 28,
          seasons: ['春季', '夏季', '秋季', '冬季'],
          startDayIndex: 1,
          startClockMinute: 540,
        },
      },
      entities: {
        'entity:charter': { state: {} },
        'entity:traveller': { state: { locationId: 'map-node:start' } },
      },
    },
    processes: [],
    reservations: [],
    futureEvents: [{ id: 'future:clock', due: 60, order: 0, kind: 'system-wake', payload: { systemId: 'world.clock' } }],
    modelPolicy: { aiEnabled: false, routes: {} },
    presentationCursors: {},
    actionDecks: {},
  },
  health: {
    futureQueueDepth: 1, activeProcesses: 1, waitingProcesses: 0, reservations: 1,
    longestWait: 0, noProgressSteps: 0, deadlocksResolved: 0, livelocksResolved: 0,
    fairnessInterventions: 0,
  },
  aiUsage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  controls: {},
} as unknown as RunView
const spatial = {
  runId,
  sequence: 2,
  logicalTime: 4,
  availableMaps: [{ id: 'map:town', name: 'Town', nodeCount: 2 }],
  map: {
    id: 'map:town', name: 'Town', rootNodeId: 'map-node:start', layers: [],
    nodes: [
      { id: 'map-node:start', layerId: 'ground', kind: 'room', name: 'Start', position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
      { id: 'map-node:end', layerId: 'ground', kind: 'room', name: 'Destination', position: { x: 10, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
    ],
    edges: [{ id: 'map-edge:route', from: 'map-node:start', to: 'map-node:end', bidirectional: true, distance: 10, baseDuration: 12, modes: ['walk'], permissions: [], hazards: [] }],
    totalNodes: 2, totalEdges: 1, truncated: false,
  },
  actors: [{ actorId: 'entity:traveller', nodeId: 'map-node:start' }],
  movements: [{
    processId: 'process:move', actorId: 'entity:traveller', state: 'started',
    origin: 'map-node:start', destination: 'map-node:end', route: ['map-node:start', 'map-node:end'],
    edgeIndex: 0, edgeFraction: .35, remainingDuration: 8, estimatedArrival: 12, mode: 'walk',
  }],
} as unknown as RunSpatialView

function runsClient(): RunsClient {
  return {
    list: vi.fn(async () => [view.summary]),
    completePresentation: vi.fn(async (request: CompletePresentationRequest) => ({
      cursor: { actorId: request.actorId, completedBeatId: request.beatId },
      view,
    })),
    view: vi.fn(async () => view),
    definition: vi.fn(async () => ({
      runId,
      blueprintDigest: view.summary.blueprintDigest,
      purpose: { summary: 'Town runtime', scope: [], duration: 100, resolution: 1, detail: 'L2', hardExpectations: [], statisticalExpectations: [], antiPatterns: [] },
      entities: [
        { id: 'entity:charter', type: 'charter', lod: 'L0', policyIds: [] },
        { id: 'entity:traveller', type: 'character', lod: 'L2', policyIds: [] },
      ],
      actions: [{ id: 'character.move', description: 'Walk to a connected place', actorTypes: ['character'] }],
      systems: [{ id: 'world.clock', description: 'Advance town time', nextWake: 60, interval: 60, preconditions: [], effects: [], provenance: [] }],
      invariants: [{ id: 'world.safe', description: 'Town remains safe', expression: { op: 'literal', value: true }, provenance: [] }],
    })),
    spatial: vi.fn(async () => spatial),
    choices: vi.fn(async () => ({
      runId,
      actorId: 'entity:traveller',
      sequence: 2,
      choices: [{ id: 'choice:walk', actionType: 'character.move', parameters: { destination: 'map-node:end' }, label: 'Walk to Destination', description: 'Follow the connected route.', targetIds: ['map-node:end'], estimatedDuration: 12, costs: [], risks: [] }],
    })),
    simulate: vi.fn(async () => ({
      run: view,
      cycles: 1,
      actionsPerformed: 0,
      actionCounts: {},
      actorActionCounts: {},
      actions: [],
    })),
    submitAction: vi.fn(async () => ({})),
    advance: vi.fn(async () => view),
    records: vi.fn(async () => ({ records: [], nextSequence: 0, nextOrdinal: 0, hasMore: false })),
    checkpoints: vi.fn(async () => []),
  } as unknown as RunsClient
}

const t: TranslateNS<'worldlineStudio'> = key => zh[key as keyof typeof zh] ?? key

const readerId = 'entity:traveller' as EntityId
const retainedBeat = {
  id: 'narrative-beat:retained-choice-test',
  invocationId: 'ai-invocation:retained-choice-test',
  perspectiveActorId: readerId,
  eventIds: [],
  observationIds: [],
  camera: 'limited-third-person',
  text: '雾从石桥下缓缓漫上来。',
  blocks: [{ type: 'narration', text: '雾从石桥下缓缓漫上来。' }],
  media: [],
  modelRoute: { provider: 'mock', model: 'narrator' },
} as unknown as NarrativeBeat

function textPlayView(beats: readonly NarrativeBeat[] = [retainedBeat]): TextPlayView {
  const storyRun = {
    ...view,
    summary: { ...view.summary, status: 'running' },
    snapshot: {
      ...view.snapshot,
      state: {
        ...view.snapshot.state,
        entities: {
          ...(view.snapshot.state['entities'] as Record<string, unknown>),
          [readerId]: { type: 'character', state: { locationId: 'map-node:start' } },
        },
      },
      modelPolicy: {
        aiEnabled: true,
        routes: { narrator: { provider: 'mock', model: 'narrator' } },
      },
      aiUsage: {
        calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        estimatedCost: 0, cacheHits: 0,
      },
      presentationCursors: beats.length === 0 ? {} : {
        [readerId]: { actorId: readerId, completedBeatId: beats.at(-1)?.id },
      },
      actionDecks: {},
      storyProgress: {},
      storyStateCommits: {},
    },
  } as unknown as RunView
  return {
    run: storyRun,
    frame: {
      logicalTime: 4,
      placeId: 'map-node:start',
      presentEntityIds: [readerId],
      visibleState: { place: { name: '入口广场' }, environment: { weather: '薄雾' } },
      activeProcesses: [],
      media: [],
    },
    beats,
    choices: {
      runId,
      actorId: readerId,
      sequence: 2,
      choices: [{
        id: 'choice:walk',
        actionType: 'character.move',
        parameters: { destination: 'map-node:end' },
        label: '走向石桥',
        description: '沿当前道路前进。',
        targetIds: ['map-node:end'],
        estimatedDuration: 12,
        costs: [],
        risks: [],
      }],
    },
    saves: [],
    script: { completed: [], suggestedActorIds: [readerId], remaining: 1 },
  } as unknown as TextPlayView
}

function textPlayProjects(): ProjectClient {
  return {
    tree: vi.fn(async () => ({ entries: [] })),
    read: vi.fn(),
  } as unknown as ProjectClient
}

describe('Worldline text-play recovery experience', () => {
  it('retries only the failed choice stage and keeps its progress dock outside the reading log', async () => {
    const play = textPlayView()
    const runs = runsClient()
    Object.defineProperty(runs, 'list', { value: vi.fn(async () => [play.run.summary]) })
    Object.defineProperty(runs, 'view', { value: vi.fn(async () => play.run) })
    let resolveRetry: ((value: StoryChoiceSuggestions) => void) | undefined
    const retryResult = new Promise<StoryChoiceSuggestions>((resolve) => { resolveRetry = resolve })
    const suggest = vi.fn()
      .mockRejectedValueOnce(new Error('临时网络故障'))
      .mockImplementationOnce(() => retryResult)
    const narrative = {
      open: vi.fn(async () => play),
      storyStage: vi.fn(async () => ({ available: true, renderers: [], message: 'ready' })),
      suggest,
      choose: vi.fn(),
      narrateStream: vi.fn(),
    } as unknown as NarrativeClient

    render(<TextPlayWorkbench
      project={project}
      runs={runs}
      ai={{ catalog: vi.fn(async () => ({ providers: [], models: [] })) } as unknown as AiClient}
      narrative={narrative}
      projects={textPlayProjects()}
      preferredRunId={runId}
      preferredActorId={readerId}
      onRunsChanged={() => {}}
      onImportRun={() => {}}
      onExportRun={() => {}}
      t={t}
    />)

    expect((await screen.findByRole('alert')).textContent).toContain('临时网络故障')
    expect(suggest).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '立即重试当前阶段' }))
    const progress = await screen.findByLabelText('故事推演阶段：生成选项')
    const storyLog = screen.getByLabelText('小说正文')
    expect(storyLog.contains(progress)).toBe(false)
    expect(ownMethod(runs, 'advance')).not.toHaveBeenCalled()
    expect(ownMethod(runs, 'submitAction')).not.toHaveBeenCalled()
    expect(ownMethod(narrative, 'choose')).not.toHaveBeenCalled()

    await act(async () => {
      resolveRetry?.({
        sequence: 2,
        afterBeatId: retainedBeat.id,
        suggestions: [
          { id: 'action-plan:advance', actorId: readerId, opportunityId: 'choice:walk', capabilityId: 'character.move', parameters: { destination: 'map-node:end' }, targetIds: ['map-node:end'], label: '穿过石桥', intent: '接近雾中的钟声', storyRole: 'advance', estimatedDuration: 12, costs: [], risks: [] },
          { id: 'action-plan:character', actorId: readerId, opportunityId: 'choice:walk', capabilityId: 'character.move', parameters: { destination: 'map-node:end' }, targetIds: ['map-node:end'], label: '先询问同伴', intent: '确认彼此判断', storyRole: 'character', estimatedDuration: 12, costs: [], risks: [] },
          { id: 'action-plan:deviate', actorId: readerId, opportunityId: 'choice:walk', capabilityId: 'character.move', parameters: { destination: 'map-node:end' }, targetIds: ['map-node:end'], label: '观察桥下倒影', intent: '寻找偏离线索', storyRole: 'deviate', estimatedDuration: 12, costs: [], risks: [] },
        ],
      } as unknown as StoryChoiceSuggestions)
      await retryResult
    })
    expect(await screen.findByRole('button', { name: '穿过石桥' })).toBeTruthy()
    expect(suggest).toHaveBeenCalledTimes(2)
  })

  it('retries a failed opening from the same narrative boundary without advancing the world', async () => {
    let play = textPlayView([])
    const runs = runsClient()
    Object.defineProperty(runs, 'list', { value: vi.fn(async () => [play.run.summary]) })
    Object.defineProperty(runs, 'view', { value: vi.fn(async () => play.run) })
    let finishRetry: (() => void) | undefined
    const narrateStream = vi.fn()
      .mockRejectedValueOnce(new Error('叙事连接暂时中断'))
      .mockImplementationOnce((_request: unknown, onChunk: (chunk: NarrativeStreamChunk) => void) => {
        onChunk({ type: 'phase', phase: 'narrative' })
        onChunk({
          type: 'retry',
          phase: 'narrative',
          attempt: 2,
          maxAttempts: 4,
          delayMs: 1_000,
          failure: { code: 'TRANSPORT', message: 'temporary disconnect' },
        })
        return new Promise<NarrativeBeat>((resolve) => {
          finishRetry = () => {
            play = textPlayView([retainedBeat])
            resolve(retainedBeat)
          }
        })
      })
    const narrative = {
      open: vi.fn(async () => play),
      storyStage: vi.fn(async () => ({ available: true, renderers: [], message: 'ready' })),
      suggest: vi.fn(async () => ({
        sequence: 2,
        afterBeatId: retainedBeat.id,
        suggestions: [],
      })),
      choose: vi.fn(),
      narrateStream,
    } as unknown as NarrativeClient

    render(<TextPlayWorkbench
      project={project}
      runs={runs}
      ai={{ catalog: vi.fn(async () => ({ providers: [], models: [] })) } as unknown as AiClient}
      narrative={narrative}
      projects={textPlayProjects()}
      preferredRunId={runId}
      preferredActorId={readerId}
      onRunsChanged={() => {}}
      onImportRun={() => {}}
      onExportRun={() => {}}
      t={t}
    />)

    expect((await screen.findByRole('alert')).textContent).toContain('叙事连接暂时中断')
    fireEvent.click(screen.getByRole('button', { name: '立即重试当前阶段' }))
    const retryDock = await screen.findByLabelText('故事推演阶段：撰写正文')
    expect(retryDock.textContent).toContain('自动恢复中')
    expect(retryDock.textContent).toContain('第 2/4 次尝试')
    expect(retryDock.textContent).toContain('TRANSPORT')
    expect(ownMethod(runs, 'advance')).not.toHaveBeenCalled()
    expect(ownMethod(runs, 'submitAction')).not.toHaveBeenCalled()
    expect(ownMethod(narrative, 'choose')).not.toHaveBeenCalled()

    await act(async () => { finishRetry?.() })
    await waitFor(() => { expect(narrateStream).toHaveBeenCalledTimes(2) })
    expect(narrateStream.mock.calls[1]?.[0]).toEqual(narrateStream.mock.calls[0]?.[0])
    expect(await screen.findByText('雾从石桥下缓缓漫上来。')).toBeTruthy()
  })
})

describe('Worldline simulation spatial projection', () => {
  it('delegates one autonomous turn to the runtime scheduler', async () => {
    const running = {
      ...view,
      summary: { ...view.summary, status: 'running' },
      controls: { 'entity:charter': 'player', 'entity:traveller': 'autonomous' },
    } as RunView
    const runs = runsClient()
    Object.defineProperty(runs, 'view', { value: vi.fn(async () => running) })

    await runAutonomyCycle(runs, runId, undefined, 60)

    expect(ownMethod(runs, 'simulate')).toHaveBeenCalledWith({
      runId,
      cycles: 1,
      stepDuration: 60,
    })
  })

  it('shows the frozen Run map and an in-progress non-teleport movement', async () => {
    const runs = runsClient()
    render(<SimulationWorkbench
      project={project}
      runs={runs}
      ai={{ catalog: vi.fn(async () => ({ providers: [], models: [] })) } as unknown as AiClient}
      runRevision={0}
      onRunsChanged={() => {}}
      onOpenTextPlay={() => {}}
      onImportRun={() => undefined}
      onExportRun={() => undefined}
      t={t}
    />)

    expect(await screen.findByRole('img', { name: 'Town' })).toBeTruthy()
    expect(screen.getAllByText('Start').length).toBeGreaterThan(0)
    expect(screen.getByText('Destination')).toBeTruthy()
    expect(screen.getByText(/已完成 35%.*8 秒/u)).toBeTruthy()
    expect(await screen.findByText('第 1 年 · 春季 1 日')).toBeTruthy()
    expect(screen.getByText('世界近况')).toBeTruthy()
    expect((await screen.findAllByText('前往相邻地点')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '执行这个行动' }))
    await waitFor(() => {
      expect(ownMethod(runs, 'submitAction')).toHaveBeenCalledWith({
        runId,
        actorId: 'entity:traveller',
        type: 'character.move',
        parameters: { destination: 'map-node:end' },
        expectedSequence: 2,
        controller: 'system',
      })
    })
  })
})
