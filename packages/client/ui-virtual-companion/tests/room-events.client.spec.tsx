// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  CompanionMembershipNodeView,
  CompanionReferenceNodeView,
  CompanionStreamNodeView,
  companionMembershipDefinition,
  companionReferenceDefinition,
  companionStreamDefinition,
} from '../src/client/RoomEvents.tsx'
import { companionStore } from '../src/client/store.ts'

const companion = {
  id: 'actor-one', name: '独立伙伴', handle: 'ACTOR', avatar: '/actor.png', portrait: '/actor.png',
  status: '在线', description: '', persona: '', style: '', speakingStyle: '', behaviorLogic: '',
  builtIn: false, createdAt: 1, updatedAt: 1,
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function load(): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
    ok: true, value: { companions: [companion], rooms: {} },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))))
  await companionStore.load(true)
}

describe('independent companion conversation events', () => {
  it('claims native room events and renders ordered reference parts with live identity', async () => {
    await load()
    expect(companionReferenceDefinition.match({ type: 'companion/reference', seq: 7 } as never)).toMatchObject({
      id: '7', role: 'start',
    })
    const messageProps = { node: { data: {
      version: 1, companionId: companion.id, actorSessionId: 'actor-session', roomEpoch: 1,
      assetId: 'meme-one', title: '收到', mimeType: 'image/gif', url: '/meme.gif',
    } } } as unknown as Parameters<typeof CompanionReferenceNodeView>[0]
    const { container } = render(<CompanionReferenceNodeView {...messageProps} />)
    await waitFor(() => { expect(screen.getByText('独立伙伴')).toBeTruthy() })
    expect(screen.getByAltText('收到').getAttribute('src')).toBe('/meme.gif')
    expect(container.querySelectorAll('img')[0]?.getAttribute('src')).toBe('/actor.png')
  })

  it('renders join and leave operations as durable room notices', async () => {
    await load()
    expect(companionMembershipDefinition.match({ type: 'companion/room-membership', seq: 8 } as never))
      .toMatchObject({ id: '8', role: 'start' })
    const joinedProps = { node: { data: {
      version: 1, action: 'joined', companionId: companion.id, roomEpoch: 2, actor: 'owner',
    } } } as unknown as Parameters<typeof CompanionMembershipNodeView>[0]
    const { rerender } = render(<CompanionMembershipNodeView {...joinedProps} />)
    expect(screen.getByText('独立伙伴加入了房间')).toBeTruthy()
    const leftProps = { node: { data: {
      version: 1, action: 'left', companionId: companion.id, roomEpoch: 3, actor: 'owner',
    } } } as unknown as Parameters<typeof CompanionMembershipNodeView>[0]
    rerender(<CompanionMembershipNodeView {...leftProps} />)
    expect(screen.getByText('独立伙伴离开了房间')).toBeTruthy()
  })

  it('claims stream lifecycle events and renders the independent Narrator in tavern prose style', () => {
    const startEvent = {
      type: 'companion/stream-start', seq: 9,
      data: {
        version: 1, streamId: 'stream-one', roomEpoch: 1,
        speaker: { type: 'narrator', actorSessionId: 'narrator-session' },
      },
    } as const
    expect(companionStreamDefinition.match(startEvent as never))
      .toMatchObject({ id: 'stream-one', role: 'start' })
    expect(companionStreamDefinition.match({
      type: 'companion/stream-delta', seq: 10, data: { streamId: 'stream-one' },
    } as never)).toMatchObject({ id: 'stream-one', role: 'update' })
    expect(companionStreamDefinition.match({
      type: 'companion/stream-end', seq: 11, data: { streamId: 'stream-one' },
    } as never)).toMatchObject({ id: 'stream-one', role: 'update' })
    let state = companionStreamDefinition.start(
      {} as never,
      { event: startEvent } as never,
      {} as never,
    )
    state = companionStreamDefinition.update({ state } as never, {
      event: {
        type: 'companion/stream-delta',
        data: { version: 1, streamId: 'stream-one', text: '逐字出现' },
      },
    } as never)
    expect(state).toMatchObject({ text: '逐字出现', status: 'running' })
    state = companionStreamDefinition.update({ state } as never, {
      event: {
        type: 'companion/stream-end',
        data: { version: 1, streamId: 'stream-one' },
      },
    } as never)
    expect(state.status).toBe('settled')
    const props = { node: { data: {
      speaker: { type: 'narrator', actorSessionId: 'narrator-session' },
      text: '房间安静了下来，但故事仍在继续。', status: 'running',
    } } } as unknown as Parameters<typeof CompanionStreamNodeView>[0]
    const { container } = render(<CompanionStreamNodeView {...props} />)
    expect(screen.getByText('旁白')).toBeTruthy()
    expect(screen.getByText('房间安静了下来，但故事仍在继续。')).toBeTruthy()
    expect(container.querySelector('[aria-label="旁白"]')).toBeTruthy()
  })
})
