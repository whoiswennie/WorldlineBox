// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompanionProcessToggle,
  CompanionWaitingStatus,
} from '../src/client/CompanionExperience.tsx'
import { CompanionAssistantContent } from '../src/client/CompanionChat.tsx'
import { zh } from '../src/client/locales.ts'
import { companionStore, createCompanionExperienceStore } from '../src/client/store.ts'

const sessionId = 'companion-session'
const companion = {
  id: 'yachiyo-runami', name: '月见八千代', handle: 'YACHIYO', avatar: '/yachiyo.png',
  portrait: '/yachiyo.png', status: '在线', description: '', persona: '', style: '',
  speakingStyle: '', behaviorLogic: '', builtIn: true, createdAt: 1, updatedAt: 1,
}
const iroha = {
  ...companion,
  id: 'iroha-tamaki', name: '酒寄彩叶', handle: 'IROHA', avatar: '/iroha.png', portrait: '/iroha.png',
}

function t(key: keyof typeof zh, params?: Record<string, unknown>): string {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

function useSessions(preset = 'virtual-companion') {
  return <T,>(selector: (state: { byId: Record<string, { agentPreset: string }> }) => T): T =>
    selector({ byId: { [sessionId]: { agentPreset: preset } } })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('immersive companion experience', () => {
  it('defaults the per-session process preference to hidden', () => {
    const store = createCompanionExperienceStore().create(sessionId)
    expect(store.getSnapshot()).toEqual({ showProcess: false })
  })

  it('shows the switch only for companion sessions and updates the transcript scope', () => {
    function Harness() {
      const [showProcess, setShowProcess] = useState(false)
      const props = {
        sessionId,
        useSessions: useSessions(),
        useStore: <T,>(selector: (state: { showProcess: boolean }) => T) => selector({ showProcess }),
        actions: { setShowProcess },
        t,
      } as unknown as ComponentProps<typeof CompanionProcessToggle>
      return <div data-conversation-scroll=""><CompanionProcessToggle {...props} /></div>
    }

    const { container } = render(<Harness />)
    const scope = container.querySelector<HTMLElement>('[data-conversation-scroll]')
    const toggle = screen.getByRole('switch', { name: '过程' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(scope?.dataset.companionProcess).toBe('hidden')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(scope?.dataset.companionProcess).toBe('visible')

    const ordinary = {
      sessionId,
      useSessions: useSessions('standard'),
      useStore: <T,>(selector: (state: { showProcess: boolean }) => T) => selector({ showProcess: false }),
      actions: { setShowProcess: vi.fn() },
      t,
    } as unknown as ComponentProps<typeof CompanionProcessToggle>
    const { container: ordinaryContainer } = render(
      <div data-conversation-scroll=""><CompanionProcessToggle {...ordinary} /></div>,
    )
    expect(ordinaryContainer.querySelector('[role="switch"]')).toBeNull()
  })

  it('reveals the coordinator body only when Process is switched on', () => {
    const fallback = <span>主调度过程</span>
    const props = {
      fallback,
      sessionId,
      useSessions: useSessions(),
      useStore: <T,>(selector: (state: { showProcess: boolean }) => T) => selector({ showProcess: false }),
    } as unknown as ComponentProps<typeof CompanionAssistantContent>
    const { rerender } = render(<CompanionAssistantContent {...props} />)
    expect(screen.queryByText('主调度过程')).toBeNull()

    rerender(<CompanionAssistantContent {...props} useStore={selector => selector({ showProcess: true })} />)
    expect(screen.getByText('主调度过程')).toBeTruthy()
  })

  it('keeps a warm, changing presence visible during a long hidden wait', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      value: {
        companions: [companion],
        rooms: { [sessionId]: { sessionId, participantIds: [companion.id], updatedAt: 1 } },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    await companionStore.load(true)
    vi.useFakeTimers()
    const props = {
      sessionId,
      session: { running: true, chat: { order: [], nodes: new Map() } },
      useSessions: useSessions(),
      useStore: <T,>(selector: (state: { showProcess: boolean }) => T) => selector({ showProcess: false }),
      useCompanionDirectory: <T,>(selector: (state: ReturnType<typeof companionStore.getSnapshot>) => T) =>
        selector(companionStore.getSnapshot()),
      loadDirectory: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CompanionWaitingStatus>
    render(<CompanionWaitingStatus {...props} />)

    expect(screen.getByRole('status').textContent).toContain('月见八千代正在读你的消息')
    act(() => { vi.advanceTimersByTime(14_000) })
    expect(screen.getByRole('status').textContent).toContain('月见八千代还在认真想着，没有走开')
  })

  it('maps a running child session back to its exact companion instead of the first room member', async () => {
    const parentId = 'parent-room'
    const childId = 'actor-yachiyo'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      value: {
        companions: [iroha, companion],
        rooms: { [parentId]: {
          sessionId: parentId,
          participantIds: [iroha.id, companion.id],
          actorSessionIds: { [iroha.id]: 'actor-iroha', [companion.id]: childId },
          updatedAt: 1,
        } },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    await companionStore.load(true)
    const childSessions = <T,>(selector: (state: unknown) => T): T => selector({
      current: childId,
      currentAddress: { parentSessionId: parentId, childSessionId: childId },
      byId: { [childId]: { agentPreset: 'virtual-companion' } },
    })
    const props = {
      sessionId: childId,
      session: { running: true, chat: { order: [], nodes: new Map() } },
      useSessions: childSessions,
      useStore: <T,>(selector: (state: { showProcess: boolean }) => T) => selector({ showProcess: false }),
      useCompanionDirectory: <T,>(selector: (state: ReturnType<typeof companionStore.getSnapshot>) => T) =>
        selector(companionStore.getSnapshot()),
      loadDirectory: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CompanionWaitingStatus>

    render(<CompanionWaitingStatus {...props} />)

    expect(screen.getByRole('status').textContent).toContain('月见八千代正在读你的消息')
    expect(screen.getByRole('status').textContent).not.toContain('酒寄彩叶')
  })
})
