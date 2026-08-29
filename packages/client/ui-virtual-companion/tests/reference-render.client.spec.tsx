// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  bindCompanionAccountIdentity,
  CompanionRoomHeader,
  ReferenceToolView,
  RichUserText,
} from '../src/client/CompanionChat.tsx'
import { companionStore } from '../src/client/store.ts'
import { ReferenceContent, referenceRenderers } from '../src/client/reference-renderer.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function props(url: string, mimeType: string): ToolCallViewProps {
  return { block: {
    kind: 'tool-result', seq: 3, time: 3, callId: 'reference-1',
    call: { name: 'express', argsRaw: '{}' }, callTime: 2,
    content: [{ type: 'text', text: 'Reference delivered' }], isError: false,
    meta: { found: true, asset_id: 'asset-1', title: '即时回应', url, mime_type: mimeType },
    callView: null, resultView: null, subCalls: [],
  } } as unknown as ToolCallViewProps
}

describe('generic reference rendering', () => {
  it('lets an extension register one renderer for a new MIME without changing consumers', () => {
    const dispose = referenceRenderers.register({
      id: 'test:canvas',
      mediaTypes: ['application/vnd.worldline.canvas+json'],
      render: ({ resource }) => <div data-canvas-resource="">画布：{resource.title}</div>,
    })
    const view = render(<ReferenceContent resource={{
      title: '自由画布',
      url: '/canvas.json',
      mimeType: 'application/vnd.worldline.canvas+json',
    }} />)
    expect(screen.getByText('画布：自由画布')).toBeTruthy()
    expect(view.container.querySelector('[data-reference-renderer="test:canvas"]')).toBeTruthy()
    dispose()
    view.rerender(<ReferenceContent resource={{
      title: '自由画布',
      url: '/canvas.json',
      mimeType: 'application/vnd.worldline.canvas+json',
    }} />)
    expect(view.container.querySelector('[data-reference-renderer="fallback:attachment"]')).toBeTruthy()
  })

  it('renders image, audio, video, and link assets from indexed tool metadata', () => {
    const view = render(<ReferenceToolView {...props('/image.webp', 'image/webp')} />)
    expect(screen.getByAltText('即时回应').getAttribute('src')).toBe('/image.webp')
    view.rerender(<ReferenceToolView {...props('/audio.mp3', 'audio/mpeg')} />)
    expect(view.container.querySelector('audio')?.getAttribute('src')).toBe('/audio.mp3')
    view.rerender(<ReferenceToolView {...props('/video.mp4', 'video/mp4')} />)
    const video = view.container.querySelector('video')
    expect(video?.getAttribute('src')).toBe('/video.mp4')
    expect(video?.controls).toBe(true)
    expect(video?.playsInline).toBe(true)
    expect(video?.getAttribute('controlsList')).toBeNull()
    const videoEnvelope = view.container.querySelector('[data-reference-renderer="builtin:video"]')
    expect(videoEnvelope?.getAttribute('data-reference-mode')).toBe('conversation')
    expect(videoEnvelope?.getAttribute('data-reference-layout')).toBe('bounded')
    expect(videoEnvelope?.getAttribute('data-reference-interactive')).toBe('true')
    view.rerender(<ReferenceToolView {...props('https://example.com', '')} />)
    expect(screen.getByRole('link', { name: /即时回应/u }).getAttribute('href')).toBe('https://example.com')
    expect(view.container.querySelector('[data-reference-renderer="fallback:attachment"]')
      ?.getAttribute('data-reference-layout')).toBe('bounded')
  })

  it('keeps text-reference-text ordering inside one rich message surface', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const id = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id: string }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: {
        id: id.id, scope: 'public', title: id.id, description: '', tags: [], transcript: '', mimeType: 'image/gif',
        bytes: 1, url: `/${id.id}.gif`, enabled: true, builtIn: true, usageCount: 0,
        createdAt: 1, updatedAt: 1,
      } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    const { container } = render(<RichUserText text={'先看这个 <user-reference asset-id="mix-one">开心</user-reference> 真的很像你'} />)

    await waitFor(() => { expect(screen.getByAltText('mix-one')).toBeTruthy() })
    const message = container.querySelector('[data-companion-rich-message]')
    expect(message?.getAttribute('data-media-only')).toBe('false')
    expect(Array.from(message?.children ?? []).map(child => child.getAttribute('data-message-part')))
      .toEqual(['text', 'references', 'text'])
  })

  it('groups consecutive stickers into one compact media grid', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const id = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id: string }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: {
        id: id.id, scope: 'public', title: id.id, description: '', tags: [], transcript: '', mimeType: 'image/gif',
        bytes: 1, url: `/${id.id}.gif`, enabled: true, builtIn: true, usageCount: 0,
        createdAt: 1, updatedAt: 1,
      } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    const { container } = render(<RichUserText text={'<user-reference asset-id="grid-one">一</user-reference> <user-reference asset-id="grid-two">二</user-reference> <user-reference asset-id="grid-three">三</user-reference>'} />)

    await waitFor(() => { expect(screen.getAllByRole('img')).toHaveLength(3) })
    const message = container.querySelector('[data-companion-rich-message]')
    const grid = message?.querySelector('[data-message-part="references"]')
    expect(message?.getAttribute('data-media-only')).toBe('true')
    expect(grid?.getAttribute('data-reference-count')).toBe('3')
    expect(grid?.querySelectorAll('figure')).toHaveLength(3)
  })

  it('always reserves the first participant avatar for the room owner', () => {
    const user = {
      id: 7, username: 'owner', createdAt: 1, lastLoginAt: 1,
      displayName: '天幻', avatar: '', bio: '',
    }
    const identitySnapshot = { loading: false, user, savedAccounts: [user], error: '' }
    const releaseIdentity = bindCompanionAccountIdentity({
      getSnapshot: () => identitySnapshot,
      subscribe: () => () => {},
    })
    const load = vi.spyOn(companionStore, 'load').mockResolvedValue()
    const props = {
      sessionId: 'session',
      useSession: (selector: (state: unknown) => unknown) => selector({
        chat: { order: [], nodes: new Map() },
      }),
      useSessions: (selector: (state: unknown) => unknown) => selector({
        byId: { session: { agentPreset: 'virtual-companion' } },
      }),
    } as unknown as ComponentProps<typeof CompanionRoomHeader>

    render(<CompanionRoomHeader {...props} />)
    const ownerAvatar = screen.getByTitle('天幻 · 房主')
    expect(ownerAvatar.textContent).toContain('天')
    expect(ownerAvatar.querySelector('img')).toBeNull()

    load.mockRestore()
    releaseIdentity()
  })

  it('resolves a companion subagent identity from its parent room actor binding', async () => {
    const kaguya = {
      id: 'kaguya', name: '辉夜', handle: 'KAGUYA', avatar: '/kaguya.png', portrait: '/kaguya.png',
      status: '在线', description: '', persona: '', style: '', speakingStyle: '', behaviorLogic: '',
      builtIn: true, createdAt: 1, updatedAt: 1,
    }
    const yachiyo = { ...kaguya, id: 'yachiyo', name: '月见八千代', avatar: '/yachiyo.png' }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      value: {
        companions: [kaguya, yachiyo],
        rooms: {
          room: {
            sessionId: 'room', participantIds: [kaguya.id],
            actorSessionIds: { [kaguya.id]: 'kaguya-child' }, updatedAt: 1,
          },
          'kaguya-child': {
            sessionId: 'kaguya-child', participantIds: [yachiyo.id], updatedAt: 1,
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    await companionStore.load(true)
    const load = vi.spyOn(companionStore, 'load').mockResolvedValue()
    const headerProps = {
      sessionId: 'kaguya-child',
      useSession: (selector: (state: unknown) => unknown) => selector({
        chat: { order: [], nodes: new Map() },
      }),
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: 'kaguya-child',
        currentAddress: {
          parentSessionId: 'room', childSessionId: 'kaguya-child', mode: 'continuable',
        },
        byId: { 'kaguya-child': { agentPreset: 'virtual-companion' } },
      }),
    } as unknown as ComponentProps<typeof CompanionRoomHeader>

    render(<CompanionRoomHeader {...headerProps} />)

    expect(screen.getByTitle('我、辉夜')).toBeTruthy()
    expect(screen.queryByTitle('我、月见八千代')).toBeNull()
    load.mockRestore()
  })
})
