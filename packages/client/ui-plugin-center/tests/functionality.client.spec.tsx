// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { FunctionalityPage, type FunctionalityPageProps } from '../src/client/FunctionalityPage.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const snapshot: PluginInventorySnapshot = {
  entries: [
    {
      entryId: 'client-runtime' as never,
      moduleName: '@deepseek-ai/dsh-client-runtime',
      enabled: true,
      fiberPhase: 'active',
      protected: true,
    },
    {
      entryId: 'community-note' as never,
      moduleName: 'community-note',
      enabled: true,
      fiberPhase: 'active',
      protected: false,
    },
    {
      entryId: 'tool-bash' as never,
      moduleName: '@deepseek-ai/dsh-tool-bash',
      enabled: false,
      fiberPhase: null,
      protected: true,
    },
    {
      entryId: 'plan-mode' as never,
      moduleName: '@deepseek-ai/dsh-plan-mode',
      enabled: false,
      fiberPhase: null,
      protected: true,
    },
  ],
  clientModules: [],
  skillIds: ['system-skill'],
  skills: [{
    name: 'system-skill',
    description: 'Bundled system skill',
    source: 'runtime',
    provider: 'runtime',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    directory: '/skills/system-skill',
    canDelete: false,
  }],
}

function props(overrides: Partial<FunctionalityPageProps> = {}): FunctionalityPageProps {
  return {
    activePage: 'features',
    useSessions: (() => { throw new Error('unused') }),
    useWorkspaces: selector => selector({
      items: [{ workspaceId: 'workspace' as never, path: '/workspace' } as never],
      recentWorkspaceId: 'workspace' as never,
    } as never),
    t: key => (zh as Record<string, string>)[key] ?? key,
    list: () => Promise.resolve(snapshot),
    setPluginEnabled: () => Promise.resolve(snapshot),
    deletePlugin: () => Promise.resolve(snapshot),
    setSkillEnabled: () => Promise.resolve(snapshot),
    deleteSkill: () => Promise.resolve(snapshot),
    openDirectory: () => Promise.resolve(),
    subscribe: () => () => {},
    ...overrides,
  }
}

describe('FunctionalityPage', () => {
  it('is local-only and exposes no mutation control for a protected framework plugin', async () => {
    render(<FunctionalityPage {...props()} />)

    expect(await screen.findByText('本地管理')).toBeTruthy()
    const protectedRow = screen.getByText('@deepseek-ai/dsh-client-runtime').closest('article')!
    expect(within(protectedRow).getByText('系统保护')).toBeTruthy()
    expect(within(protectedRow).queryByRole('button')).toBeNull()

    const communityRow = screen.getByText('community-note', { selector: 'code' }).closest('article')!
    expect(within(communityRow).getByRole('button', { name: '禁用' })).toBeTruthy()
    expect(within(communityRow).getByRole('button', { name: '删除' })).toBeTruthy()
  })

  it('forwards a local plugin enablement mutation', async () => {
    const setPluginEnabled = vi.fn(() => Promise.resolve(snapshot))
    render(<FunctionalityPage {...props({ setPluginEnabled })} />)
    const communityRow = (await screen.findByText('community-note', { selector: 'code' })).closest('article')!

    fireEvent.click(within(communityRow).getByRole('button', { name: '禁用' }))

    await waitFor(() => {
      expect(setPluginEnabled).toHaveBeenCalledWith({
        entryId: 'community-note',
        enabled: false,
        cwd: '/workspace',
      })
    })
  })

  it('confirms plugin deletion in-app without a blocking browser dialog', async () => {
    const deletePlugin = vi.fn(() => Promise.resolve(snapshot))
    render(<FunctionalityPage {...props({ deletePlugin })} />)
    const communityRow = (await screen.findByText('community-note', { selector: 'code' })).closest('article')!

    fireEvent.click(within(communityRow).getByRole('button', { name: '删除' }))

    expect(deletePlugin).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '确认删除' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => {
      expect(deletePlugin).toHaveBeenCalledWith({
        entryId: 'community-note',
        cwd: '/workspace',
      })
    })
  })

  it('reports mutation failures through a non-blocking toast', async () => {
    const setPluginEnabled = vi.fn(() => Promise.reject(new Error('mutation failed')))
    render(<FunctionalityPage {...props({ setPluginEnabled })} />)
    const communityRow = (await screen.findByText('community-note', { selector: 'code' })).closest('article')!

    fireEvent.click(within(communityRow).getByRole('button', { name: '禁用' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('操作失败')
    expect(alert.textContent).toContain('mutation failed')
  })

  it('shows bundled skills as non-deletable', async () => {
    render(<FunctionalityPage {...props()} />)
    await screen.findByText('本地管理')
    fireEvent.click(screen.getByRole('tab', { name: /技能包/u }))

    const row = screen.getByText('/system-skill').closest('article')!
    expect(within(row).queryByRole('button', { name: '删除' })).toBeNull()
    expect(within(row).getByText('系统保护')).toBeTruthy()
  })

  it('fuzzy-filters immediately without a submit or refresh action', async () => {
    render(<FunctionalityPage {...props()} />)
    await screen.findByText('community-note', { selector: 'code' })

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cmnt' } })

    expect(screen.getByText('community-note', { selector: 'code' })).toBeTruthy()
    expect(screen.queryByText('@deepseek-ai/dsh-client-runtime')).toBeNull()
  })

  it('does not retain unrelated plugins for a plan query', async () => {
    render(<FunctionalityPage {...props()} />)
    await screen.findByText('@deepseek-ai/dsh-tool-bash')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'plan' } })

    expect(screen.getByText('@deepseek-ai/dsh-plan-mode')).toBeTruthy()
    expect(screen.queryByText('@deepseek-ai/dsh-tool-bash')).toBeNull()
    expect(screen.getByText('1/4')).toBeTruthy()
  })

  it('opens the Host-resolved directory for a discovered Skill', async () => {
    const openDirectory = vi.fn(() => Promise.resolve())
    render(<FunctionalityPage {...props({ openDirectory })} />)
    await screen.findByText('本地管理')
    fireEvent.click(screen.getByRole('tab', { name: /技能包/u }))

    fireEvent.click(screen.getByRole('button', { name: '打开目录' }))

    expect(openDirectory).toHaveBeenCalledWith('/skills/system-skill')
  })
})
