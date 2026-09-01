// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProjectRootView, ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import { WorldlineStudio, type WorldlineStudioProps } from '../src/client/WorldlineStudio.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const configured: ProjectRootView = {
  configured: true,
  path: 'C:\\Worlds',
  writable: true,
  projectCount: 1,
  scannedAt: '2026-09-01T00:00:00.000Z',
}

const project = {
  manifest: {
    format: '0.1.0',
    id: 'project:atlas',
    name: '星海图鉴',
    description: '一个可运行的星海世界',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    defaultWorldId: 'world:main',
    defaultWorldlineId: 'worldline:main',
    template: 'world-encyclopedia',
    tags: ['星海'],
    dependencies: [],
  },
  path: 'C:\\Worlds\\atlas',
  health: 'ready',
  status: 'buildable',
  sizeBytes: 2048,
  documentCount: 3,
} as unknown as ProjectSummary

function studioProps(root: ProjectRootView, overrides: Record<string, unknown> = {}): WorldlineStudioProps {
  const projects = {
    root: vi.fn(async () => root),
    setRoot: vi.fn(async ({ path }: { path: string }) => ({
      destination: path, projects: [], conflicts: [], requiredBytes: 0, dryRun: false,
    })),
    library: vi.fn(async () => ({ root, projects: root.configured ? [project] : [], total: root.configured ? 1 : 0 })),
  }
  return {
    activePage: 'worldline-studio',
    useSessions: (() => { throw new Error('unused') }),
    useWorkspaces: (() => { throw new Error('unused') }),
    t: key => (zh as Record<string, string>)[key] ?? key,
    projects,
    compiler: {},
    runs: {},
    ai: {},
    narrative: {},
    pickDirectory: vi.fn(async () => 'C:\\Worlds'),
    openPath: vi.fn(async () => {}),
    launchConversation: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WorldlineStudioProps
}

describe('Worldline Studio', () => {
  it('requires an explicit local library binding on first use', async () => {
    const root: ProjectRootView = { configured: false, writable: false, projectCount: 0 }
    const props = studioProps(root)
    render(<WorldlineStudio {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '选择目录' }))

    await waitFor(() => {
      expect(props.pickDirectory).toHaveBeenCalledOnce()
      expect(props.projects.setRoot).toHaveBeenCalledWith({ path: 'C:\\Worlds', create: true })
    })
  })

  it('opens a real library project into the six-mode workspace', async () => {
    render(<WorldlineStudio {...studioProps(configured)} />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))

    expect(await screen.findByRole('button', { name: '设定' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '地图' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '构建' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '模拟' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '文本游玩' })).toBeTruthy()
    expect(screen.getByText('一个可运行的星海世界')).toBeTruthy()
  })

  it('launches the project-bound author conversation from overview', async () => {
    const props = studioProps(configured)
    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(await screen.findByRole('button', { name: '与世界线助手对话' }))
    await waitFor(() => { expect(props.launchConversation).toHaveBeenCalledWith(project) })
  })
})
