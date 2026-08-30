// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createSnapshotStore,
  type SessionListState,
  type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'
import { createFontSizeRowStore } from '../src/client/settings-store.ts'

afterEach(cleanup)

const copy: Record<string, string> = {
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
  'fontSize.unit': 'px',
}

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
    items: [],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: undefined,
  }))
}

function mount(fontSize = 14) {
  const store = createFontSizeRowStore().create()
  store.actions.sync(fontSize, 0)
  const setFontSize = vi.fn()
  render(<FontSizeRow
    useSessions={emptySessions()}
    useWorkspaces={emptyWorkspaces()}
    useStore={bindSnapshotSelector(store)}
    actions={store.actions}
    t={(key: string) => copy[key] ?? key}
    setFontSize={setFontSize}
  />)
  return { store, setFontSize }
}

const arrow = (name: string): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

describe('FontSizeRow', () => {
  it('renders the mirrored value and steps through the service callback', () => {
    const mounted = mount()
    expect(screen.getByText('14')).toBeDefined()
    fireEvent.click(arrow('Increase font size'))
    expect(mounted.setFontSize).toHaveBeenCalledWith(15)
    expect(screen.getByText('14')).toBeDefined()
    act(() => { mounted.store.actions.sync(15, 1) })
    expect(screen.getByText('15')).toBeDefined()
    fireEvent.click(arrow('Decrease font size'))
    expect(mounted.setFontSize).toHaveBeenLastCalledWith(14)
  })

  it('disables only the outward arrow at each bound', () => {
    mount(17)
    expect(arrow('Increase font size').disabled).toBe(true)
    expect(arrow('Decrease font size').disabled).toBe(false)
    cleanup()
    mount(12)
    expect(arrow('Increase font size').disabled).toBe(false)
    expect(arrow('Decrease font size').disabled).toBe(true)
  })
})
