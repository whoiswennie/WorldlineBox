// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DocumentView, ProjectRootView, ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import { WorldlineStudio, type WorldlineStudioProps } from '../src/client/WorldlineStudio.tsx'
import { uploadProjectEntry } from '../src/client/CanonWorkbench.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function ownMethod(target: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(target, name)?.value
}

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
    t: (key: keyof typeof zh) => zh[key],
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
  it('streams dropped files to the project-scoped upload endpoint', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const file = new File([Uint8Array.from([1, 2, 3])], 'portrait.bin', { type: 'application/octet-stream' })

    await uploadProjectEntry(project.manifest.id, 'assets/portraits', file)

    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toContain('/api/worldline/project/upload?')
    expect(url).toContain('projectId=project%3Aatlas')
    expect(url).toContain('path=assets%2Fportraits%2Fportrait.bin')
    expect(init).toMatchObject({ method: 'PUT', body: file })
  })

  it('requires an explicit local library binding on first use', async () => {
    const root: ProjectRootView = { configured: false, writable: false, projectCount: 0 }
    const props = studioProps(root)
    render(<WorldlineStudio {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '选择目录' }))

    await waitFor(() => {
      expect(ownMethod(props, 'pickDirectory')).toHaveBeenCalledOnce()
      expect(ownMethod(props.projects, 'setRoot'))
        .toHaveBeenCalledWith({ path: 'C:\\Worlds', create: true })
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
    await waitFor(() => {
      expect(ownMethod(props, 'launchConversation')).toHaveBeenCalledWith(project)
    })
  })

  it('exposes current Blueprint and logical Run archive workflows in their workbenches', async () => {
    const props = studioProps(configured)
    Object.assign(props.projects, {
      importBlueprint: vi.fn(async () => ({
        id: 'transfer:blueprint',
        kind: 'import-blueprint',
        state: 'completed',
        completedBytes: 10,
        totalBytes: 10,
      })),
    })
    Object.assign(props.compiler, { state: vi.fn(async () => ({ questions: [], proposals: [] })) })
    Object.assign(props.runs, { list: vi.fn(async () => []) })
    Object.assign(props.ai, { catalog: vi.fn(async () => ({ models: [] })) })
    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '构建' }))
    fireEvent.click(await screen.findByRole('button', { name: '导入 Blueprint' }))
    const blueprintDialog = screen.getByRole('dialog', { name: '导入 Blueprint' })
    fireEvent.change(within(blueprintDialog).getByLabelText('归档路径'), {
      target: { value: 'C:\\Worlds\\frozen.worldline-blueprint.zip' },
    })
    fireEvent.click(within(blueprintDialog).getByRole('button', { name: '导入 Blueprint' }))
    await waitFor(() => {
      expect(ownMethod(props.projects, 'importBlueprint')).toHaveBeenCalledWith({
        projectId: project.manifest.id,
        source: 'C:\\Worlds\\frozen.worldline-blueprint.zip',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '模拟' }))
    fireEvent.click(await screen.findByRole('button', { name: '导入 Run 存档' }))
    expect(screen.getByText(/不包含 SQLite 缓存数据库/u)).toBeTruthy()
  })

  it('keeps multiple canon documents open in one current tabbed editor', async () => {
    const props = studioProps(configured)
    const documents = new Map<string, DocumentView>(['canon/alpha.md', 'canon/beta.md'].map((path, index) => [path, {
      projectId: project.manifest.id,
      id: `document:${String(index + 1)}`,
      path,
      content: `# ${path}`,
      revision: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      tags: [],
    } as unknown as DocumentView]))
    Object.assign(props.projects, {
      tree: vi.fn(async () => ({
        projectId: project.manifest.id,
        path: '',
        truncated: false,
        entries: [...documents.values()].map(document => ({
          id: document.id,
          name: document.path.slice(document.path.lastIndexOf('/') + 1),
          path: document.path,
          kind: 'document',
          sizeBytes: document.content.length,
          updatedAt: document.updatedAt,
          revision: document.revision,
          tags: [],
        })),
      })),
      read: vi.fn(async ({ path }: { path: string }) => {
        const document = documents.get(path)
        if (document === undefined) throw new Error('not found')
        return document
      }),
      search: vi.fn(async () => []),
    })
    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '设定' }))

    fireEvent.click(await screen.findByRole('button', { name: /alpha\.md/u }))
    await screen.findByRole('button', { name: '关闭 alpha.md' })
    fireEvent.click(await screen.findByRole('button', { name: /beta\.md/u }))

    expect(screen.getByRole('navigation', { name: '已打开文档' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭 alpha.md' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: '关闭 beta.md' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '专用视图' }))
    expect((await screen.findAllByText('自定义对象')).length).toBeGreaterThan(0)
    expect(screen.getByText('真源')).toBeTruthy()
  })
})
