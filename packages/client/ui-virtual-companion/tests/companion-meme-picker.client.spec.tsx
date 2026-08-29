// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReferenceAsset } from '../src/contracts.ts'
import { CompanionMemePicker } from '../src/client/CompanionMemePicker.tsx'

const meme: ReferenceAsset = {
  id: 'meme-1', scope: 'yachiyo-runami', enabled: true, title: '好耶',
  description: '开心庆祝', tags: ['表情包', '庆祝'], transcript: '', mimeType: 'image/gif',
  bytes: 32, source: { type: 'builtin', url: '/meme.gif' }, builtIn: true, usageCount: 0,
  createdAt: 1, updatedAt: 1, url: '/meme.gif',
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('CompanionMemePicker', () => {
  it('portals the picker above the conversation shell and stages the selected meme', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      const value = url.endsWith('/reference/search')
        ? { items: [meme], nextCursor: -1 }
        : { companions: [], rooms: {} }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }))
    const stageMeme = vi.fn(() => true)
    const pickerProps = {
      input: { phase: 'plain' }, session: {}, stageMeme,
    }
    const Picker = CompanionMemePicker as ComponentType<typeof pickerProps>
    const { container } = render(<Picker {...pickerProps} />)

    fireEvent.click(screen.getByRole('button', { name: '选择表情包' }))
    const dialog = await screen.findByRole('dialog', { name: '表情包选择器' })
    expect(dialog.parentElement).toBe(document.body)
    expect(container.contains(dialog)).toBe(false)
    await waitFor(() => { expect(screen.getByRole('option', { name: '好耶' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('option', { name: '好耶' }))
    expect(stageMeme).toHaveBeenCalledWith(meme)
  })
})
