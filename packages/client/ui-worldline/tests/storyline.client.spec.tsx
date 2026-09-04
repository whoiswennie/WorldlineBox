// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { PlotPointDefinition } from '@deepseek-ai/dsh-worldline-standard/types'
import { StorylineWorkbench } from '../src/client/StorylineWorkbench.tsx'
import type { NarrativeClient, ProjectClient, RunsClient } from '../src/client/types.ts'

afterEach(cleanup)

const project = {
  manifest: { id: 'project:control-room', name: '潮汐调度局' },
} as unknown as ProjectSummary

const point = {
  id: 'plot-point:signal-window',
  name: '信标校验窗口',
  summary: '必须在风暴抵港前核验第三信标。',
  order: 1,
  entryCondition: '权威时钟到达 00:00:00。',
  completionCriteria: '事件流中存在已验证的信标记录。',
  dramaticPressure: '潮位上升会切断外港交通。',
  successOutcome: '疏散航路保持开放。',
  failureOutcome: '港区进入强制封锁。',
  recoveryHook: '从地下维护井重接备用信标。',
  timing: {
    activateAt: 0,
    deadlineAt: 120,
    interventions: [{
      id: 'intervention:storm-siren',
      at: 60,
      title: '风暴警报强制响起',
      description: 'Runtime 向所有港区写入警报事件并提升潮压。',
    }],
  },
  provenance: [],
} as unknown as PlotPointDefinition

describe('Storyline runtime control board', () => {
  it('presents authoritative time gates and evidence as a professional control surface', async () => {
    const summary = {
      runId: 'run:control-room', projectId: project.manifest.id, status: 'running',
    }
    const definition = vi.fn(async () => ({ plotPoints: [point] }))
    const runs = {
      list: vi.fn(async () => [summary]),
      view: vi.fn(async () => ({
        summary,
        snapshot: {
          logicalTime: 65,
          state: {
            entities: {
              'entity:observer': {
                type: 'character', facets: { sourcePath: 'characters/observer.md' }, state: {},
              },
            },
          },
        },
      })),
      definition,
    } as unknown as RunsClient
    const narrative = {
      open: vi.fn(async () => ({
        script: {
          completed: [], current: point, remaining: 1, suggestedActorIds: ['entity:observer'],
          currentProgress: {
            rationale: '警报已经由事件流触发，但信标证据仍未形成。',
            evidence: ['story.intervention: 风暴警报强制响起'],
          },
        },
      })),
    } as unknown as NarrativeClient

    render(<StorylineWorkbench
      project={project}
      projects={{} as ProjectClient}
      runs={runs}
      narrative={narrative}
      treeRevision={0}
      openPath={async () => {}}
      openVisualStory={() => {}}
    />)

    const metrics = await screen.findByLabelText('剧情线运行摘要')
    expect(within(metrics).getByText('00:01:05')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '剧情调度台' })).toBeTruthy()
    expect(screen.getByText('00:00:00 — 00:02:00')).toBeTruthy()
    expect(screen.getByText('风暴警报强制响起')).toBeTruthy()
    expect(screen.getByText('Runtime 向所有港区写入警报事件并提升潮压。')).toBeTruthy()
    expect(screen.getByText('本轮证据审计')).toBeTruthy()
    expect(screen.getByText('story.intervention: 风暴警报强制响起')).toBeTruthy()
    await waitFor(() => { expect(definition).toHaveBeenCalledOnce() })
  })
})
