// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => ({
    svg: `<svg id="${id}" data-source="${source.replaceAll('"', '&quot;')}"></svg>`,
    bindFunctions: undefined as ((element: Element) => void) | undefined,
  })),
}))

vi.mock('mermaid', () => ({ default: mermaid }))

afterEach(() => {
  cleanup()
  mermaid.render.mockClear()
})

describe('MarkdownText Mermaid fences', () => {
  it('loads Mermaid lazily and renders settled diagrams under the strict security policy', async () => {
    const source = 'flowchart LR\n  A --> B'
    const { container } = render(<MarkdownText text={`\`\`\`mermaid\n${source}\n\`\`\``} />)

    expect(screen.getByRole('status').textContent).toContain('正在渲染')
    await waitFor(() => { expect(container.querySelector('svg')).not.toBeNull() })
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
    }))
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^worldline-mermaid-/), source)
    expect(container.querySelector('[data-source]')?.getAttribute('data-source')).toBe(source)
  })

  it('keeps an unfinished streaming diagram as source code until the message settles', async () => {
    const source = 'sequenceDiagram\n  Alice->>Bob: Hello'
    const view = render(<MarkdownText text={`\`\`\`mermaid\n${source}\n\`\`\``} streaming />)

    expect(view.container.querySelector('pre code')?.textContent).toContain('sequenceDiagram')
    expect(view.container.querySelector('svg')).toBeNull()
    expect(mermaid.render).not.toHaveBeenCalled()

    view.rerender(<MarkdownText text={`\`\`\`mermaid\n${source}\n\`\`\``} />)
    await waitFor(() => { expect(view.container.querySelector('svg')).not.toBeNull() })
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it('shows the authored fence and parse error when Mermaid rejects a diagram', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Parse error on line 1'))
    const { container } = render(<MarkdownText text={'```mermaid\nnot a diagram\n```'} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Mermaid 图表渲染失败')
    expect(alert.textContent).toContain('Parse error on line 1')
    expect(container.querySelector('pre code')?.textContent).toContain('not a diagram')
  })

  it('contains an interaction-binding failure inside the diagram block', async () => {
    mermaid.render.mockResolvedValueOnce({
      svg: '<svg></svg>',
      bindFunctions: () => { throw new Error('Binding failed') },
    })
    const { container } = render(
      <MarkdownText text={'```mermaid\nflowchart LR\nA --> B\n```'} />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Binding failed')
    expect(container.querySelector('pre code')?.textContent).toContain('flowchart LR\nA --> B')
  })
})
