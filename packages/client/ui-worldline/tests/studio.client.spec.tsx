// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DocumentView, ProjectRootView, ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import { characterDraft, characterMarkdown, WorldlineStudio, type WorldlineStudioProps } from '../src/client/WorldlineStudio.tsx'
import { CanonWorkbench, uploadProjectEntry } from '../src/client/CanonWorkbench.tsx'
import { LocationMapComposer } from '../src/client/LocationMapComposer.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => { window.sessionStorage.clear() })
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals() })

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
    compiler: { state: vi.fn(async () => ({ questions: [], proposals: [] })) },
    runs: {},
    ai: {},
    narrative: {},
    renderSlot: (_key: string, owner: {
      open: boolean
      request: { mode: string; extensions?: readonly string[]; suggestedName?: string }
      onPicked(path: string): void
    }) => owner.open
      ? <button type="button" onClick={() => {
        const path = owner.request.mode === 'directory'
          ? 'C:\\Worlds'
          : owner.request.mode === 'save-file'
            ? `C:\\Archives\\${owner.request.suggestedName ?? 'archive.zip'}`
            : owner.request.extensions?.includes('worldline-blueprint.zip') === true
              ? 'C:\\Archives\\frozen.worldline-blueprint.zip'
              : 'C:\\Archives\\archive.worldline.zip'
        owner.onPicked(path)
      }}>选择测试路径</button>
      : null,
    openPath: vi.fn(async () => {}),
    launchConversation: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WorldlineStudioProps
}

describe('Worldline Studio', () => {
  it('renders Preview as the authored Markdown document instead of an OC object card', async () => {
    const document = {
      projectId: project.manifest.id,
      id: 'document:charter',
      path: 'canon/world-charter.md',
      content: '# 星澜大学 · 世界宪章\n\n## 世界概述\n\n这是正常的 Markdown 正文。\n\n- 校园\n- 钟楼\n',
      revision: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      tags: ['世界观'],
    } as unknown as DocumentView
    const projects = {
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
    }
    render(<CanonWorkbench
      project={project}
      projects={projects as never}
      openDocuments={[{ document, content: document.content, saveState: 'saved' }]}
      activePath={document.path}
      openPath={async () => {}}
      activatePath={() => {}}
      closePath={async () => {}}
      editDocument={() => {}}
      saveDocument={async () => {}}
      useDiskVersion={() => {}}
      retryLocalVersion={async () => {}}
      treeRevision={0}
      refreshTree={() => {}}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />)

    fireEvent.click(screen.getByRole('button', { name: '预览' }))

    const preview = screen.getByLabelText('预览: canon/world-charter.md')
    expect(within(preview).getByRole('heading', { name: '星澜大学 · 世界宪章' })).toBeTruthy()
    expect(within(preview).getByText('这是正常的 Markdown 正文。')).toBeTruthy()
    expect(within(preview).getAllByRole('listitem')).toHaveLength(2)
    expect(within(preview).queryByText('正典对象')).toBeNull()
  })

  it('opens the world charter automatically instead of showing an unexplained blank editor', async () => {
    const openPath = vi.fn(async () => {})
    const projects = {
      search: vi.fn(async () => [{ id: 'document:charter', path: 'canon/world-charter.md', title: '世界宪章', excerpt: '', score: 1, tags: [] }]),
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
    }
    render(<CanonWorkbench
      project={project}
      projects={projects as never}
      openDocuments={[]}
      openPath={openPath}
      activatePath={() => {}}
      closePath={async () => {}}
      editDocument={() => {}}
      saveDocument={async () => {}}
      useDiskVersion={() => {}}
      retryLocalVersion={async () => {}}
      treeRevision={0}
      refreshTree={() => {}}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />)

    await waitFor(() => { expect(openPath).toHaveBeenCalledWith('canon/world-charter.md') })
  })

  it('shows a concrete create action when a project has no document to open', async () => {
    const openPath = vi.fn(async () => {})
    const projects = {
      search: vi.fn(async () => []),
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
      write: vi.fn(async () => ({})),
    }
    render(<CanonWorkbench
      project={project}
      projects={projects as never}
      openDocuments={[]}
      openPath={openPath}
      activatePath={() => {}}
      closePath={async () => {}}
      editDocument={() => {}}
      saveDocument={async () => {}}
      useDiskVersion={() => {}}
      retryLocalVersion={async () => {}}
      treeRevision={0}
      refreshTree={() => {}}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />)

    expect(screen.getByRole('heading', { name: '选择一份设定开始编辑' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建并打开新文档' }))
    await waitFor(() => { expect(openPath).toHaveBeenCalledWith('canon/new-document.md') })
  })

  it('treats a missing native location directory as an empty map instead of exposing ENOENT', async () => {
    const openAuthoring = vi.fn()
    const projects = {
      tree: vi.fn(async () => { throw new Error("internal: ENOENT: no such file or directory, lstat 'maps/places'") }),
    }
    render(<LocationMapComposer project={project} projects={projects as never} openAuthoring={openAuthoring} />)

    expect(await screen.findByText('先定义地点，再组装世界')).toBeTruthy()
    expect(screen.queryByText(/ENOENT/iu)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '去创建地点' }))
    expect(openAuthoring).toHaveBeenCalledTimes(1)
  })

  it('preserves existing character prose when the native editor adds structured fields', () => {
    const existing = {
      projectId: project.manifest.id,
      id: 'document:legacy-character',
      path: 'characters/legacy.md',
      content: '# 顾潮\n\n这是一段不能被表单覆盖的完整旧人物传记。\n\n## 经历\n\n十年前曾在灯塔守夜。\n',
      revision: 3,
      updatedAt: '2026-09-01T00:00:00.000Z',
      tags: ['角色'],
    } as unknown as DocumentView
    const draft = characterDraft(existing)
    const updated = characterMarkdown({ ...draft, identity: '灯塔守望者', goals: '找回失物' })

    expect(updated).toContain('这是一段不能被表单覆盖的完整旧人物传记。')
    expect(updated).toContain('十年前曾在灯塔守夜。')
    expect(updated).toContain('- 身份／职业：灯塔守望者')
    expect(updated).toContain('- 目标：找回失物')
  })

  it('round-trips authored character sections through the native editor', () => {
    const authored = {
      projectId: project.manifest.id,
      id: 'document:authored-character',
      path: 'characters/gu-xingye.md',
      content: '# 顾星野\n\n校医之女，也是刚转入星穹学园的高一学生。\n\n## 身份\n\n16 岁，高一转学生。\n\n## 性格\n\n敏锐、谨慎，会把担心藏在冷静之后。\n\n## 目标与愿望\n\n查明校园异象并保护同伴。\n\n## 经历\n\n曾在旧实验楼听见不属于任何人的广播。\n',
      revision: 3,
      updatedAt: '2026-09-01T00:00:00.000Z',
      tags: ['角色', '调查者'],
    } as unknown as DocumentView

    const draft = characterDraft(authored)
    expect(draft.summary).toBe('校医之女，也是刚转入星穹学园的高一学生。')
    expect(draft.age).toBe('16')
    expect(draft.identity).toBe('16 岁，高一转学生。')
    expect(draft.personality).toContain('敏锐、谨慎')
    expect(draft.goals).toContain('查明校园异象')
    expect(draft.keywords).toBe('调查者')

    const updated = characterMarkdown({
      ...draft,
      summary: '她决定主动追查那段午夜广播。',
      personality: '冷静、敏锐，也愿意为朋友冒险。',
    })
    expect(updated).toContain('# 顾星野\n\n她决定主动追查那段午夜广播。')
    expect(updated).not.toContain('校医之女，也是刚转入星穹学园的高一学生。')
    expect(updated.match(/## 经历/gu)).toHaveLength(1)
    expect(updated).toContain('曾在旧实验楼听见不属于任何人的广播。')
    expect(updated).toContain('- 性格：冷静、敏锐，也愿意为朋友冒险。')

    const reopened = characterDraft({ ...authored, content: updated })
    expect(reopened.summary).toBe('她决定主动追查那段午夜广播。')
    expect(reopened.personality).toBe('冷静、敏锐，也愿意为朋友冒险。')
  })

  it('projects the latest compiled character profile into the archive draft', () => {
    const document = {
      projectId: project.manifest.id,
      id: 'document:runtime-profile',
      path: 'characters/lansheng.md',
      content: '# 岚笙\n\n她负责校准折光穹顶。\n',
      revision: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
      tags: ['角色'],
    } as unknown as DocumentView
    const draft = characterDraft(document, {
      profile: {
        age: '青年',
        gender: '女',
        form: '人形',
        pronouns: '她',
        identity: '黎明区测量师',
        personality: '敏锐、谨慎、执拗于真相',
        goal: '公开聚焦漂移异常',
      },
    })

    expect(draft).toMatchObject({
      age: '青年',
      gender: '女／人形／她',
      identity: '黎明区测量师',
      personality: '敏锐、谨慎、执拗于真相',
      goals: '公开聚焦漂移异常',
    })
  })

  it('offers both built-in Huan forms when creating a character', async () => {
    const props = studioProps(configured)
    Object.assign(props.projects, {
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
    })
    Object.assign(props.runs, { list: vi.fn(async () => []) })
    render(<WorldlineStudio {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '创作设定' }))
    fireEvent.click(await screen.findByRole('button', { name: '＋ 新建人物' }))

    const editor = screen.getByRole('dialog', { name: '新建人物档案' })
    expect(within(editor).getByRole('img', { name: '幻 · 白色形态' })).toBeTruthy()
    expect(within(editor).getByRole('img', { name: '幻 · 黑色形态' })).toBeTruthy()
    const forms = [
      within(editor).getByRole('button', { name: /幻 · 白色形态/u }),
      within(editor).getByRole('button', { name: /幻 · 黑色形态/u }),
    ]
    expect(forms.filter(button => button.hasAttribute('data-selected'))).toHaveLength(1)
  })

  it('creates every extended OC dossier in its framework-owned directory', async () => {
    const props = studioProps(configured)
    const write = vi.fn(async (request: {
      path: string
      content: string
      objectKind: string
      tags: readonly string[]
      createParents?: boolean
    }) => ({
      projectId: project.manifest.id,
      id: 'document:council',
      revision: 'sha256:council',
      updatedAt: '2026-09-04T00:00:00.000Z',
      ...request,
    }))
    Object.assign(props.projects, {
      tree: vi.fn(async ({ path }: { path: string }) => ({
        projectId: project.manifest.id, path, truncated: false, entries: [],
      })),
      write,
    })
    Object.assign(props.runs, { list: vi.fn(async () => []) })
    render(<WorldlineStudio {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '创作设定' }))
    fireEvent.click(await screen.findByRole('button', { name: '组织与关系' }))
    expect(screen.getByLabelText<HTMLSelectElement>('新建档案类型').value).toBe('organization')
    fireEvent.click(screen.getByRole('button', { name: '＋ 新建组织' }))

    const editor = screen.getByRole('dialog', { name: '新建组织档案' })
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: '雾港议会' } })
    fireEvent.change(within(editor).getByLabelText('摘要'), { target: { value: '管理航线与灯塔。' } })
    fireEvent.change(within(editor).getByLabelText('组织档案（支持 Markdown）'), {
      target: { value: '## 权力结构\n\n七席轮值。' },
    })
    fireEvent.click(within(editor).getByRole('button', { name: '保存组织档案' }))

    await waitFor(() => { expect(write).toHaveBeenCalledTimes(1) })
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      path: 'organizations/雾港议会.md',
      objectKind: 'organization',
      createParents: true,
    })
    expect(write.mock.calls[0]?.[0].content).toContain('## 权力结构')
  })

  it('projects compiled character artwork and hides the untouched starter template', async () => {
    const props = studioProps(configured)
    const starter = {
      projectId: project.manifest.id,
      id: 'document:starter',
      path: 'characters/protagonist.md',
      content: '# 主角\n\n写明身份、外观、性格、价值观、目标、能力、资源、关系、经历与初始位置。\n',
      revision: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      tags: [],
    } as unknown as DocumentView
    const character = {
      ...starter,
      id: 'document:lin-ruochuan',
      path: 'characters/lin-ruochuan.md',
      content: '# 林若川\n\n一名在灾变前努力维持日常秩序的学生。\n',
      tags: ['角色'],
    } as unknown as DocumentView
    Object.assign(props.projects, {
      tree: vi.fn(async ({ path }: { path: string }) => path === 'characters' ? ({
        projectId: project.manifest.id,
        path,
        truncated: false,
        entries: [starter, character].map(document => ({
          kind: 'document',
          id: document.id,
          path: document.path,
          name: document.path.split('/').at(-1) ?? '',
        })),
      }) : ({ projectId: project.manifest.id, path, truncated: false, entries: [] })),
      read: vi.fn(async ({ path }: { path: string }) => path === starter.path ? starter : character),
    })
    Object.assign(props.compiler, {
      compile: vi.fn(async () => ({
        canon: [{
          kind: 'character',
          facets: {
            sourcePath: character.path,
            resources: {
              visual: {
                portrait: 'assets/files/characters/lin-ruochuan/portrait.png',
                expressions: { default: 'assets/files/characters/lin-ruochuan/neutral.png' },
              },
            },
          },
        }],
      })),
    })
    Object.assign(props.runs, { list: vi.fn(async () => []) })

    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    expect(await screen.findByText('1/12')).toBeTruthy()
    expect(await screen.findByRole('heading', { name: '林若川' })).toBeTruthy()
    expect(await screen.findByRole('img', { name: '林若川主视觉' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '主角' })).toBeNull()
  })

  it('recursively indexes nested dossiers inside framework-owned directories', async () => {
    const props = studioProps(configured)
    const nested = {
      projectId: project.manifest.id,
      id: 'document:nested-character',
      path: 'characters/shenxu/profile.md',
      content: '# 沈栩\n\n影库区看守，负责追踪异常影能迁入。\n',
      revision: 1,
      updatedAt: '2026-09-04T00:00:00.000Z',
      objectKind: 'character',
      tags: ['角色'],
    } as unknown as DocumentView
    Object.assign(props.projects, {
      tree: vi.fn(async ({ path }: { path: string }) => ({
        projectId: project.manifest.id,
        path,
        truncated: false,
        entries: path === 'characters' ? [{
          kind: 'directory', id: 'directory:shenxu', path: 'characters/shenxu', name: 'shenxu', tags: [],
        }] : path === 'characters/shenxu' ? [{
          kind: 'document', id: nested.id, path: nested.path, name: 'profile.md', tags: nested.tags,
        }] : [],
      })),
      read: vi.fn(async () => nested),
    })
    Object.assign(props.compiler, { compile: vi.fn(async () => ({ canon: [] })) })
    Object.assign(props.runs, { list: vi.fn(async () => []) })

    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))

    expect(await screen.findByRole('heading', { name: '沈栩' })).toBeTruthy()
    expect(ownMethod(props.projects, 'tree')).toHaveBeenCalledWith(expect.objectContaining({
      path: 'characters/shenxu',
    }))
  })

  it('indexes the complete world as native dossiers before offering source editing', async () => {
    const props = studioProps(configured)
    const documents = new Map<string, DocumentView>([
      ['mechanisms/tide-law.md', {
        projectId: project.manifest.id,
        id: 'document:tide-law',
        path: 'mechanisms/tide-law.md',
        content: '# 潮汐法则\n\n潮高会改变渡口通行与角色体力消耗。\n\n## 生效条件\n\n当潮高超过 70 时，低地道路关闭。\n',
        revision: 3,
        updatedAt: '2026-09-01T00:00:00.000Z',
        objectKind: 'rule',
        tags: ['机制', '环境'],
      } as unknown as DocumentView],
      ['maps/places/moon-port.md', {
        projectId: project.manifest.id,
        id: 'document:moon-port',
        path: 'maps/places/moon-port.md',
        content: '# 月潮港\n\n一座受天气与潮汐共同影响的港城。\n\n## 环境\n\n盐雾会降低能见度。\n',
        revision: 2,
        updatedAt: '2026-09-01T00:00:00.000Z',
        objectKind: 'place',
        tags: ['地点'],
      } as unknown as DocumentView],
    ])
    Object.assign(props.projects, {
      tree: vi.fn(async ({ path }: { path: string }) => ({
        projectId: project.manifest.id,
        path,
        truncated: false,
        entries: path === '' ? [{
          kind: 'directory', id: 'directory:mechanisms', path: 'mechanisms', name: 'mechanisms', tags: [],
        }] : path === 'mechanisms' ? [{
          kind: 'document', id: 'document:tide-law', path: 'mechanisms/tide-law.md',
          name: 'tide-law.md', tags: ['机制', '环境'],
        }] : [],
      })),
      read: vi.fn(async ({ path }: { path: string }) => {
        const document = documents.get(path)
        if (document === undefined) throw new Error('not found')
        return document
      }),
    })
    Object.assign(props.compiler, { compile: vi.fn(async () => ({ canon: [] })) })
    Object.assign(props.runs, { list: vi.fn(async () => []) })

    const view = render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(await screen.findByRole('button', { name: /潮汐法则/u }))

    expect(await screen.findByRole('heading', { name: '潮汐法则' })).toBeTruthy()
    expect(screen.getByText('当潮高超过 70 时，低地道路关闭。')).toBeTruthy()
    expect(screen.getByText('规则与世界知识')).toBeTruthy()
    expect(ownMethod(props, 'openPath')).not.toHaveBeenCalled()

    const archiveIndex = screen.getByLabelText('档案目录')
    const overview = archiveIndex.parentElement?.parentElement as HTMLElement
    overview.scrollTop = 420
    archiveIndex.scrollTop = 96
    fireEvent.scroll(overview)
    fireEvent.scroll(archiveIndex)

    fireEvent.click(screen.getByRole('button', { name: '打开源码' }))
    await waitFor(() => { expect(screen.getByText('高级源码工作区')).toBeTruthy() })
    expect(screen.getByRole('button', { name: 'Markdown 源文本 IDE' }).hasAttribute('data-active')).toBe(true)
    await waitFor(() => {
      expect(ownMethod(props.projects, 'tree')).toHaveBeenCalledWith(expect.objectContaining({ path: '' }))
      expect(ownMethod(props.projects, 'tree')).toHaveBeenCalledWith(expect.objectContaining({ path: 'mechanisms' }))
    })
    expect((await screen.findAllByRole('button', { name: /tide-law\.md/u })).length).toBeGreaterThan(1)

    view.unmount()
    render(<WorldlineStudio {...props} />)
    expect(await screen.findByText('高级源码工作区')).toBeTruthy()
    expect((await screen.findAllByRole('button', { name: /tide-law\.md/u })).length).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: '← 返回世界档案馆' }))
    expect(await screen.findByRole('heading', { name: '世界档案馆' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: '潮汐法则' })).toBeTruthy()
    const restoredArchiveIndex = screen.getByLabelText('档案目录')
    expect(restoredArchiveIndex.parentElement?.parentElement?.scrollTop).toBe(420)
    expect(restoredArchiveIndex.scrollTop).toBe(96)
  })

  it('restores the open project and workspace after the worldline surface remounts', async () => {
    const props = studioProps(configured)
    Object.assign(props.projects, {
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
      search: vi.fn(async () => []),
    })
    Object.assign(props.runs, { list: vi.fn(async () => []) })

    const first = render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '创作设定' }))
    expect(await screen.findByRole('heading', { name: '原生 OC 创作框架' })).toBeTruthy()
    first.unmount()

    render(<WorldlineStudio {...props} />)
    expect(await screen.findByRole('heading', { name: '原生 OC 创作框架' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '创作设定' }).hasAttribute('data-active')).toBe(true)
    expect(screen.queryByRole('button', { name: '打开 星海图鉴' })).toBeNull()
  })

  it('returns from the advanced source IDE to the native authoring workspace', async () => {
    const props = studioProps(configured)
    Object.assign(props.projects, {
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
      search: vi.fn(async () => []),
    })
    Object.assign(props.runs, { list: vi.fn(async () => []) })

    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '创作设定' }))
    fireEvent.click(screen.getByRole('button', { name: 'Markdown 源文本 IDE' }))
    fireEvent.click(screen.getByRole('button', { name: '← 原生档案与表单' }))

    expect(await screen.findByRole('heading', { name: '原生 OC 创作框架' })).toBeTruthy()
    expect(screen.getByText('原生创作工作室')).toBeTruthy()
  })

  it('provides first-class save management over real runs and checkpoints', async () => {
    const props = studioProps(configured)
    const run = {
      runId: 'run:main',
      projectId: project.manifest.id,
      branchId: 'worldline:main',
      blueprintDigest: 'digest',
      status: 'paused',
      logicalTime: 7200,
      sequence: 12,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T02:00:00.000Z',
    }
    const checkpoint = {
      checkpoint: { id: 'checkpoint:noon' },
      label: '第 1 年 · 光弧秋 27 日 08:01',
      createdAt: '2026-09-03T01:00:00.000Z',
    }
    Object.assign(props.projects, {
      search: vi.fn(async () => []),
      tree: vi.fn(async () => ({ projectId: project.manifest.id, path: '', truncated: false, entries: [] })),
    })
    Object.assign(props.runs, {
      list: vi.fn(async () => [run]),
      view: vi.fn(async () => ({ summary: run, snapshot: { logicalTime: 7200, sequence: 12, state: {} } })),
      checkpoints: vi.fn(async () => [checkpoint]),
      checkpoint: vi.fn(async () => checkpoint),
      pause: vi.fn(async () => ({ summary: run, snapshot: { logicalTime: 7200, sequence: 12, state: {} } })),
      resume: vi.fn(async () => ({ summary: { ...run, status: 'running' }, snapshot: { logicalTime: 7200, sequence: 12, state: {} } })),
      branch: vi.fn(async () => ({ summary: { ...run, runId: 'run:branch', parentRunId: run.runId }, snapshot: { logicalTime: 7200, sequence: 12, state: {} } })),
    })

    render(<WorldlineStudio {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))
    fireEvent.click(screen.getByRole('button', { name: '存档管理' }))

    expect(await screen.findByRole('heading', { name: '存档管理' })).toBeTruthy()
    expect(await screen.findByText('第 1 年 · 光弧秋 27 日 08:01')).toBeTruthy()
    expect(screen.getByRole('button', { name: '继续故事' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复世界' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存此刻' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '导出存档' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '从这里另开世界线' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '保存此刻' }))
    await waitFor(() => { expect(ownMethod(props.runs, 'checkpoint')).toHaveBeenCalledWith({ runId: 'run:main', label: '历法与开场时间未配置' }) })
  })

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
    fireEvent.click(await screen.findByRole('button', { name: '选择测试路径' }))

    await waitFor(() => {
      expect(ownMethod(props.projects, 'setRoot'))
        .toHaveBeenCalledWith({ path: 'C:\\Worlds', create: true })
    })
  })

  it('opens a real library project into the five-purpose workspace without a standalone build page', async () => {
    render(<WorldlineStudio {...studioProps(configured)} />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 星海图鉴' }))

    expect(await screen.findByRole('button', { name: '创作设定' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '世界地图' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '构建验证' })).toBeNull()
    expect(screen.getByRole('button', { name: '剧情线' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '视觉演绎' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '实时演算' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '世界档案' })).toHaveLength(1)
    expect(screen.getByText('一个可运行的星海世界')).toBeTruthy()
  })

  it('copies and trashes projects through accessible recoverable dialogs', async () => {
    const props = studioProps(configured)
    const copyProject = vi.fn(async () => project)
    const trashProject = vi.fn(async () => undefined)
    Object.assign(props.projects, { copyProject, trashProject })
    vi.stubGlobal('prompt', vi.fn(() => { throw new Error('native prompt must not be used') }))
    vi.stubGlobal('confirm', vi.fn(() => { throw new Error('native confirm must not be used') }))
    render(<WorldlineStudio {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '创建副本' }))
    const copyDialog = screen.getByRole('dialog', { name: '创建项目副本' })
    expect(copyDialog.parentElement?.parentElement).toBe(document.body)
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.change(within(copyDialog).getByLabelText('项目名称'), {
      target: { value: '星海图鉴独立副本' },
    })
    fireEvent.click(within(copyDialog).getByRole('button', { name: '创建副本' }))
    await waitFor(() => {
      expect(copyProject).toHaveBeenCalledWith({
        projectId: project.manifest.id,
        name: '星海图鉴独立副本',
      })
    })

    fireEvent.click(await screen.findByRole('button', { name: '移到回收站' }))
    const trashDialog = screen.getByRole('dialog', { name: '确认移入回收站' })
    expect(within(trashDialog).getByText(/不会立即永久删除/u)).toBeTruthy()
    fireEvent.click(within(trashDialog).getByRole('button', { name: '移到回收站' }))
    await waitFor(() => {
      expect(trashProject).toHaveBeenCalledWith({ projectId: project.manifest.id })
    })
  })

  it('empties the recycle bin only after an explicit irreversible confirmation', async () => {
    const props = studioProps(configured)
    const trashed = [{
      trashId: 'trash:first',
      originalName: 'first-world',
      deletedAt: '2026-09-01T00:00:00.000Z',
      sizeBytes: 2048,
      manifest: project.manifest,
    }]
    const emptyProjectTrash = vi.fn(async () => 1)
    Object.assign(props.projects, {
      listTrashedProjects: vi.fn(async () => trashed),
      emptyProjectTrash,
    })
    render(<WorldlineStudio {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '回收站' }))
    const trashDialog = await screen.findByRole('dialog', { name: '回收站' })
    fireEvent.click(within(trashDialog).getByRole('button', { name: '清空回收站' }))
    const confirmDialog = screen.getByRole('dialog', { name: '确认清空回收站' })
    expect(within(confirmDialog).getByText(/无法撤销或恢复/u)).toBeTruthy()
    expect(emptyProjectTrash).not.toHaveBeenCalled()
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '清空回收站' }))

    await waitFor(() => { expect(emptyProjectTrash).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('回收站已清空')).toBeTruthy()
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

  it('exposes current world-blueprint and logical simulation archive workflows', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: '创作设定' }))
    fireEvent.click(await screen.findByText('可运行性检查与发布'))
    fireEvent.click(await screen.findByRole('button', { name: '导入世界蓝图' }))
    const blueprintDialog = screen.getByRole('dialog', { name: '导入世界蓝图' })
    fireEvent.click(within(blueprintDialog).getByRole('button', { name: '选择归档文件' }))
    fireEvent.click(screen.getByRole('button', { name: '选择测试路径' }))
    fireEvent.click(within(blueprintDialog).getByRole('button', { name: '导入世界蓝图' }))
    await waitFor(() => {
      expect(ownMethod(props.projects, 'importBlueprint')).toHaveBeenCalledWith({
        projectId: project.manifest.id,
        source: 'C:\\Archives\\frozen.worldline-blueprint.zip',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '视觉演绎' }))
    fireEvent.click(await screen.findByRole('button', { name: '导入世界线' }))
    expect(screen.getByText(/不包含本地缓存数据库/u)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: '创作设定' }))
    fireEvent.click(screen.getByRole('button', { name: 'Markdown 源文本 IDE' }))

    fireEvent.click(await screen.findByRole('button', { name: /alpha\.md/u }))
    await screen.findByRole('button', { name: '关闭 alpha.md' })
    fireEvent.click(await screen.findByRole('button', { name: /beta\.md/u }))

    expect(screen.getByRole('navigation', { name: '已打开文档' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭 alpha.md' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: '关闭 beta.md' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '文件信息' })).toBeTruthy()
    expect(screen.getByText('基本信息')).toBeTruthy()
    expect(screen.getByText('文件操作')).toBeTruthy()
    expect(screen.getByRole('button', { name: /移动或重命名/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /移入回收站.*可从回收站恢复/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '专用视图' })).toBeNull()
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '预览' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '分栏' })).toBeTruthy()
  })
})
