// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VirtualCompanionNavItem } from '../src/client/VirtualCompanionNavItem.tsx'

const pageCss = readFileSync(resolve(
  process.cwd(), 'packages/client/ui-virtual-companion/src/client/VirtualCompanionPage.module.css',
), 'utf8')
const chatCss = readFileSync(resolve(
  process.cwd(), 'packages/client/ui-virtual-companion/src/client/CompanionChat.module.css',
), 'utf8')
const experienceCss = readFileSync(resolve(
  process.cwd(), 'packages/client/ui-virtual-companion/src/client/CompanionExperience.module.css',
), 'utf8')

afterEach(cleanup)

describe('virtual companion layout', () => {
  it('keeps the companion list as the sidebar-height scroll region', () => {
    expect(pageCss).toMatch(/\.friends\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s)
    expect(pageCss).toMatch(/\.friendList\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*auto;/s)
    expect(pageCss).toMatch(/\.friend\s*\{\s*box-sizing:\s*border-box;/)
  })

  it('keeps the portrait preview hint inside the rounded portrait safe area', () => {
    expect(pageCss).toMatch(/\.previewHint\s*\{[^}]*top:\s*76px;[^}]*left:\s*50%;/s)
    expect(pageCss).toMatch(/\.portraitPreviewTrigger:hover \.previewHint[^}]*transform:\s*translate\(-50%, 0\);/s)
  })

  it('uses a companion-and-spark glyph instead of a heart in the primary rail', () => {
    const open = vi.fn()
    const props = {
      open,
      useActivePage: (select: (page: string) => boolean) => select('conversation'),
      t: () => '虚拟伙伴',
    } as unknown as ComponentProps<typeof VirtualCompanionNavItem>
    render(<VirtualCompanionNavItem {...props} />)

    const button = screen.getByRole('button', { name: '虚拟伙伴' })
    expect(button.querySelector('circle')).not.toBeNull()
    expect(button.querySelector('path')?.getAttribute('d')).toContain('M4.5 19')
    fireEvent.click(button)
    expect(open).toHaveBeenCalledOnce()
  })

  it('uses a compact scene strip for narration and folds only coordinator rows', () => {
    expect(chatCss).toMatch(/\.narratorCard\s*\{[^}]*text-align:\s*left;/s)
    expect(chatCss).toMatch(/\.narratorCard\s*\{[^}]*border-radius:\s*6px 16px 16px 6px;/s)
    expect(chatCss).not.toContain('font-style: italic')
    expect(experienceCss).toContain("data-chat-flow-kind='assistant-step'")
    expect(experienceCss).toContain("data-chat-flow-kind='tool-call'")
    expect(experienceCss).toContain("data-chat-flow-kind='context'")
    expect(experienceCss).toContain("data-chat-flow-kind='turn-tail'")
  })

  it('keeps mixed user references in a bounded message surface with companion-sized media', () => {
    expect(chatCss).toMatch(/\.richUserMessage\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(520px, 100%\);/s)
    expect(chatCss).toMatch(/\.referenceGrid\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s)
    expect(chatCss).toMatch(/\.referenceGrid \.toolMeme\s*\{[^}]*margin:\s*0;/s)
    expect(chatCss).toContain(".richUserMessage[data-media-only='true']")
    expect(chatCss).not.toContain('.userMeme')
  })

  it('keeps a visible fallback for the room owner in the participant avatar stack', () => {
    expect(chatCss).toMatch(/\.participantInitial\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s)
    expect(chatCss).toMatch(/\.participantInitial\s*\{[^}]*font-weight:\s*700;/s)
  })
})
