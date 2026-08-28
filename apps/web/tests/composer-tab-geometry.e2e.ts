// Web contract: Chat owns the composer; auxiliary tabs own the full center column.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = createChatScrollFixture({
  markerPrefix: 'AUXILIARY_VIEW_HEIGHT',
  title: 'AUXILIARY_VIEW_HEIGHT session',
  turns: 4,
})
const SEED_ID = 'auxiliary-view-height-web-e2e'

async function connectSeedWorkspace(page: Page, workspace: string): Promise<void> {
  await page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ }).click()
  const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
}

async function openSeededSession(page: Page): Promise<void> {
  const searchButton = page.getByRole('button', { name: /^(Search sessions|搜索会话)$/ })
  await searchButton.waitFor({ timeout: 30_000 })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: /^(Search sessions\.\.\.|搜索会话…)$/ })
  await search.fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: /^(Search results|搜索结果)$/ }).getByRole('treeitem')
  await results.first().waitFor({ timeout: 60_000 })
  if (await results.count() !== 1) throw new Error('seeded-session search returned an ambiguous result set')
  await results.click()
}

describe('web e2e: full-height auxiliary conversation views', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectSeedWorkspace(page, scaffold.workspaceCwd)
    await openSeededSession(page)
    await page.getByRole('tab', { name: /^(Chat|对话)$/ }).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('removes the composer from Trajectory and gives its view the complete body height', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auxiliary-view-full-height'))
    await page.getByRole('tab', { name: /^(Trajectory|轨迹)$/ }).click()
    await page.locator('[data-conversation-view="trajectory"]').waitFor({ timeout: 30_000 })

    const geometry = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-conversation-scroll]')
      const view = document.querySelector<HTMLElement>('[data-conversation-view="trajectory"]')
      const composer = document.querySelector<HTMLElement>('[data-composer-seat]')
      if (body === null || view === null || composer === null) {
        throw new Error('conversation auxiliary-view geometry is incomplete')
      }
      const bodyRect = body.getBoundingClientRect()
      const viewRect = view.getBoundingClientRect()
      return {
        composerDisplay: getComputedStyle(composer).display,
        topGap: Math.abs(viewRect.top - bodyRect.top),
        bottomGap: Math.abs(viewRect.bottom - bodyRect.bottom),
      }
    })

    expect(geometry.composerDisplay).toBe('none')
    expect(geometry.topGap).toBeLessThanOrEqual(1)
    expect(geometry.bottomGap).toBeLessThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('restores the composer only when returning to Chat', async () => {
    await page.getByRole('tab', { name: /^(Chat|对话)$/ }).click()
    await page.locator('[data-conversation-view="chat"]').waitFor({ timeout: 30_000 })
    await page.locator('[data-composer-seat]').waitFor({ state: 'visible' })
    await page.locator('textarea:enabled').last().waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
