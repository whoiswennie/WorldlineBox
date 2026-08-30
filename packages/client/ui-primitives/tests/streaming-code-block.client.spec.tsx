// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { StreamingHighlightSession } from '../src/markdown/highlight.ts'

afterEach(cleanup)

describe('StreamingHighlightSession', () => {
  it('reconstructs code and retains completed line spans across append growth', () => {
    const session = new StreamingHighlightSession()
    const first = session.update('const a = 1\nlet', 'ts')
    const second = session.update('const a = 1\nlet b = 2', 'ts')
    expect(first?.map(line => line.map(span => span.text).join('')).join('\n'))
      .toBe('const a = 1\nlet')
    expect(second?.[0]).toBe(first?.[0])
    expect(second?.[1]).not.toBe(first?.[1])
  })

  it('incremental growth equals fresh tokenization inside a multiline grammar state', () => {
    const code = 'const s = `template\nline ${x} mid\n` // done\nconst t: number = 42'
    const session = new StreamingHighlightSession()
    for (let end = 1; end <= code.length; end += 1) {
      const slice = code.slice(0, end)
      expect(session.update(slice, 'ts'))
        .toEqual(new StreamingHighlightSession().update(slice, 'ts'))
    }
  })

  it('resets for replacement and stays plain for unknown languages', () => {
    const session = new StreamingHighlightSession()
    session.update('const a = 1\nconst b = 2', 'ts')
    expect(session.update('let c = 3', 'ts'))
      .toEqual(new StreamingHighlightSession().update('let c = 3', 'ts'))
    expect(session.update('DISPLAY "X".', 'cobol')).toBeUndefined()
  })
})

describe('CodeBlock streaming arm', () => {
  it('keeps completed line DOM nodes while a fence grows', () => {
    const view = render(<CodeBlock code={'const a = 1\nlet partial\n'} lang="ts" streaming />)
    const firstLine = view.container.querySelector('pre.shiki .line')
    expect(firstLine).not.toBeNull()
    view.rerender(<CodeBlock code={'const a = 1\nlet partial = 2\n// tail\n'} lang="ts" streaming />)
    const lines = view.container.querySelectorAll('pre.shiki .line')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(firstLine)
    expect(view.container.querySelector('pre.shiki')?.textContent)
      .toBe('const a = 1\nlet partial = 2\n// tail')
  })

  it('settles to the static shiki arm without changing code content', () => {
    const code = 'const answer = 42\n'
    const view = render(<CodeBlock code={code} lang="ts" streaming />)
    const streamed = view.container.querySelector('pre.shiki')?.textContent
    view.rerender(<CodeBlock code={code} lang="ts" />)
    expect(view.container.querySelector('pre.shiki')?.textContent).toBe(streamed)
  })
})
