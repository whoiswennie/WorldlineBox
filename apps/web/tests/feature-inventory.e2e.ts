import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

describe('web e2e: composed Feature inventory', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('discovers the bundled Skill and filters locally without refresh', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feature-inventory'))
    await page.getByRole('button', { name: '功能', exact: true }).click()
    await page.getByRole('heading', { name: '功能', exact: true }).waitFor({ timeout: 10_000 })

    expect(await page.getByRole('button', { name: /刷新/u }).count()).toBe(0)
    await page.getByRole('tab', { name: /技能包/u }).click()
    const creation = page.getByText('/companion-creation', { exact: true })
    await creation.waitFor({ timeout: 10_000 })
    const card = creation.locator('xpath=ancestor::article')
    expect(await card.getByText('应用内置', { exact: true }).count()).toBe(1)
    expect(await card.getByRole('button', { name: '打开目录', exact: true }).count()).toBe(1)
    expect(await card.getByRole('button', { name: '删除', exact: true }).count()).toBe(0)

    await page.getByRole('searchbox').fill('companion')
    await expect.poll(() => creation.count(), { timeout: 2_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('filters an unrelated plugin immediately for a plan query', async () => {
    await page.getByRole('button', { name: '功能', exact: true }).click()
    await page.getByRole('heading', { name: '功能', exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('tab', { name: /插件/u }).click()
    const search = page.getByRole('searchbox')
    await expect.poll(() => search.inputValue(), { timeout: 2_000 }).toBe('')
    await search.fill('plan')

    await page.getByText('@deepseek-ai/dsh-plan-mode', { exact: true }).first().waitFor({ timeout: 2_000 })
    expect(await search.inputValue()).toBe('plan')
    expect(await page.getByText('@deepseek-ai/dsh-tool-bash', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /刷新/u }).count()).toBe(0)
  })
})
