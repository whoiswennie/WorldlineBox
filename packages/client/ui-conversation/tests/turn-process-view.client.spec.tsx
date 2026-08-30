// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TurnProcessNodeView } from '../src/client/chat/TurnProcessNodeView.tsx'
import { isTurnProcessIndependentNode } from '../src/client/contract/turn-process.ts'

afterEach(cleanup)

describe('TurnProcessNodeView', () => {
  it('keeps companion speech, companion references, and generic reference delivery visible', () => {
    const base = { key: 'node', id: 'node', target: 'chat', anchorSeq: 8,
      location: { kind: 'session' }, visibility: 'visible' }
    expect(isTurnProcessIndependentNode({ ...base, kind: 'companion-stream', data: {
      speaker: { type: 'companion', companionId: 'yachiyo', actorSessionId: 'actor' },
      text: '正文', status: 'settled',
    } } as never)).toBe(true)
    expect(isTurnProcessIndependentNode({ ...base, kind: 'companion-reference', data: {
      version: 1, companionId: 'yachiyo', actorSessionId: 'actor', roomEpoch: 1,
      assetId: 'tears', title: '泪眼', mimeType: 'image/gif', url: '/tears.gif',
    } } as never)).toBe(true)
    expect(isTurnProcessIndependentNode({ ...base, kind: 'tool-call', data: { root: {
      kind: 'tool-result', seq: 9, time: 9, callId: 'express-1',
      call: { name: 'express', argsRaw: '{}' }, callTime: 8, content: [], isError: false,
      callView: null, resultView: null, subCalls: [],
    } } } as never)).toBe(true)
    expect(isTurnProcessIndependentNode({ ...base, kind: 'tool-call', data: { root: {
      callId: 'read-1', name: 'read', argsRaw: '{}', turn: 1, step: 1, time: 8,
      callView: null, subCalls: [],
    } } } as never)).toBe(false)
  })

  it('summarizes process counts and toggles the shared disclosure state', () => {
    const setOpen = vi.fn()
    const props = {
      node: {
        data: { turn: 3, toolCallCount: 2, messageCount: 1, subagentCount: 1 },
      },
      turnProcess: { foldable: true, open: false, setOpen },
      t: (key: string, values?: Record<string, unknown>) => {
        const rawCount = values?.count
        const count = typeof rawCount === 'string' || typeof rawCount === 'number'
          ? String(rawCount)
          : ''
        const copy: Record<string, string> = {
          'message.turnProcess.toolCalls.other': `${count} tool calls`,
          'message.turnProcess.messages.one': `${count} message`,
          'message.turnProcess.subagents.one': `${count} subagent`,
          'message.turnProcess.separator': ' · ',
        }
        return copy[key] ?? key
      },
    } as unknown as ComponentProps<typeof TurnProcessNodeView>
    render(<TurnProcessNodeView {...props} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toBe('2 tool calls · 1 message · 1 subagent')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(setOpen).toHaveBeenCalledWith(true)
  })
})
