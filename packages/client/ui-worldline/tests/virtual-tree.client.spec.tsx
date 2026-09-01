// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Revision } from '@deepseek-ai/dsh-worldline-standard'
import type { ProjectSummary, ProjectTreeEntry } from '@deepseek-ai/dsh-worldline-project/types'
import { VirtualProjectTree } from '../src/client/CanonWorkbench.tsx'
import type { ProjectClient } from '../src/client/types.ts'

afterEach(cleanup)

const project = {
  manifest: { id: 'project:virtual-tree', name: 'Virtual tree' },
} as unknown as ProjectSummary

describe('Worldline virtual project tree', () => {
  it('keeps a huge loaded page outside the DOM except for the visible window', async () => {
    const entries: ProjectTreeEntry[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `document:virtual-${String(index).padStart(6, '0')}` as ProjectTreeEntry['id'],
      name: `file-${String(index).padStart(5, '0')}.md`,
      path: `file-${String(index).padStart(5, '0')}.md`,
      kind: 'document',
      sizeBytes: 10,
      updatedAt: '2026-09-01T00:00:00.000Z',
      revision: `sha256:${String(index)}` as Revision,
      tags: [],
    }))
    const tree = vi.fn(async () => ({
      projectId: project.manifest.id,
      path: '',
      entries,
      truncated: false,
    }))
    render(<VirtualProjectTree
      project={project}
      projects={{ tree } as unknown as ProjectClient}
      revision={0}
      onOpen={() => undefined}
      onSelect={() => undefined}
    />)
    await waitFor(() => { expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0) })
    expect(tree).toHaveBeenCalledWith(expect.objectContaining({ limit: 200, path: '' }))
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(40)
    expect(screen.queryByText('file-04999.md')).toBeNull()

    const viewport = screen.getByRole('tree')
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 310 })
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 4_900 * 31 })
    fireEvent.scroll(viewport)
    await waitFor(() => { expect(screen.getByText('file-04900.md')).toBeTruthy() })
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(40)
  })
})
