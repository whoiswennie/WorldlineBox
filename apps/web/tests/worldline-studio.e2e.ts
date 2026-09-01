import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acceptanceScenarios,
  charterDocument,
  characterDocument,
  mapDocument,
  mechanismDocument,
  openingScenarioDocument,
  timelineDocument,
} from '../../../fixtures/worldline/scenarios.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const scenario = acceptanceScenarios.find(item => item.slug === 'warrior-and-dragon')
if (scenario === undefined) throw new Error('warrior-and-dragon acceptance scenario is missing')

describe('web e2e: Worldline authoring to archived branch', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let libraryRoot: string
  let projectArchive: string
  let runArchive: string

  async function bindProjectLibrary(): Promise<void> {
    await page.getByRole('button', { name: '世界线', exact: true }).click()
    await page.getByRole('button', { name: '选择目录' }).click()
    const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '编辑路径' }).click()
    const pathInput = dialog.getByRole('textbox', { name: '编辑路径' })
    await pathInput.fill(libraryRoot)
    await pathInput.press('Enter')
    await dialog.getByRole('button', { name: '打开', exact: true }).click()
    await page.getByRole('heading', { name: '第一条世界线，正等你落笔' }).waitFor()
  }

  async function openTreeDocument(directory: string, file: string): Promise<Locator> {
    const tree = page.getByRole('tree', { name: '文件' })
    const directoryItem = tree.getByRole('treeitem').filter({ hasText: directory })
    if (await directoryItem.getAttribute('aria-expanded') !== 'true') {
      await directoryItem.getByRole('button').click()
    }
    await tree.getByRole('treeitem').filter({ hasText: file }).getByRole('button').click()
    return page.getByRole('textbox', { name: `编辑: ${directory}/${file}` })
  }

  async function replaceDocument(editor: Locator, content: string): Promise<void> {
    await editor.fill(content)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor({ timeout: 10_000 })
  }

  async function createDocument(path: string, content: string): Promise<void> {
    const pathInput = page.getByRole('textbox', { name: '路径' })
    await pathInput.fill(path)
    await page.getByTitle('新建文档').click()
    await replaceDocument(page.getByRole('textbox', { name: `编辑: ${path}` }), content)
  }

  async function chooseArchiveDestination(dialog: Locator, path: string): Promise<void> {
    await dialog.getByRole('button', { name: '选择保存位置' }).click()
    const picker = page.getByRole('dialog', { name: '选择保存位置' })
    const directory = picker.getByRole('textbox', { name: '编辑路径' })
    await directory.fill(dirname(path))
    await directory.press('Enter')
    const fileName = picker.getByRole('textbox', { name: '文件名' })
    await fileName.fill(basename(path))
    await picker.getByRole('button', { name: '保存到这里' }).click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    libraryRoot = join(scaffold.workspaceCwd, 'worldline-library')
    projectArchive = join(libraryRoot, 'oc-hero.worldline.zip')
    runArchive = join(libraryRoot, 'oc-hero.worldline-run.zip')
    await mkdir(libraryRoot, { recursive: true })
    const executablePath = process.env.WORLDLINE_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    } catch (error) {
      await saveFailureShot(page, 'web-e2e-worldline-studio-boot')
      const body = await page.locator('body').innerText().catch(() => '')
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `body: ${body.slice(0, 2_000)}`,
        `page errors: ${tripwire.pageErrors.join(' | ')}`,
        `warnings: ${tripwire.warnings.join(' | ')}`,
      ].join('\n'))
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('creates, edits, compiles, runs, narrates, branches, and exports one current world', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-worldline-studio'))
    await bindProjectLibrary()

    await page.getByRole('button', { name: '创造新世界' }).first().click()
    const create = page.getByRole('dialog', { name: '创造新世界' })
    const dialogLayer = await create.evaluate((element) => {
      const backdrop = element.parentElement
      const bounds = backdrop?.getBoundingClientRect()
      return {
        parentIsBody: backdrop?.parentElement === document.body,
        bodyOverflow: document.body.style.overflow,
        background: getComputedStyle(element).backgroundColor,
        zIndex: backdrop === null ? undefined : getComputedStyle(backdrop).zIndex,
        bounds: bounds === undefined ? undefined : {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })
    expect(dialogLayer).toMatchObject({
      parentIsBody: true,
      bodyOverflow: 'hidden',
      background: 'rgb(255, 255, 255)',
      zIndex: '10000',
      bounds: { left: 0, top: 0 },
    })
    expect(dialogLayer.bounds?.width).toBeGreaterThanOrEqual(dialogLayer.viewport.width)
    expect(dialogLayer.bounds?.height).toBeGreaterThanOrEqual(dialogLayer.viewport.height)
    await create.getByLabel('项目名称').fill('勇士与恶龙：灰烬王冠')
    await create.getByLabel('描述').fill('可编译、可运行、可推演的完整原创角色冒险世界。')
    await create.getByLabel('模板').selectOption('playable-scenario')
    await create.getByLabel('标签').fill('原创角色, 勇士, 恶龙, 可推演')
    await create.getByRole('button', { name: '创建', exact: true }).click()

    await page.getByRole('heading', { name: '勇士与恶龙：灰烬王冠' }).waitFor()
    await page.getByRole('button', { name: '创作设定', exact: true }).click()
    await replaceDocument(
      await openTreeDocument('canon', 'charter.md'),
      charterDocument(scenario),
    )
    await replaceDocument(
      await openTreeDocument('canon', 'timeline.md'),
      timelineDocument(scenario),
    )
    await replaceDocument(
      await openTreeDocument('mechanisms', 'core.md'),
      mechanismDocument(scenario),
    )
    await replaceDocument(
      await openTreeDocument('characters', 'protagonist.md'),
      characterDocument(scenario, scenario.characters[0]!),
    )
    await replaceDocument(
      await openTreeDocument('maps', 'world.md'),
      mapDocument(scenario),
    )
    await replaceDocument(
      await openTreeDocument('scenarios', 'opening.md'),
      openingScenarioDocument(scenario),
    )
    await createDocument(
      'characters/dragon.md',
      characterDocument(scenario, scenario.characters[1]!),
    )

    await page.getByRole('button', { name: '世界地图', exact: true }).click()
    await page.getByRole('img', { name: scenario.map.name }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: '验证', exact: true }).click()

    await page.getByRole('button', { name: '构建验证', exact: true }).click()
    await page.getByRole('button', { name: '编译预览' }).first().click()
    await page.getByText('可以冻结', { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '冻结并激活' }).click()
    await expect.poll(async () => {
      return await page.getByText('所有闭包门禁已通过，可以冻结。').count()
    }, { timeout: 15_000 }).toBeGreaterThan(0)

    await page.getByRole('button', { name: '实时演算', exact: true }).click()
    await page.getByLabel('创建后先暂停').uncheck()
    await page.getByLabel('命运种子').fill('warrior-dragon-seed')
    await page.getByRole('button', { name: '开始新演算' }).click()
    await page.getByRole('img', { name: scenario.map.name }).waitFor({ timeout: 15_000 })
    await page.getByText('battle.strike', { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: '执行干预' }).click()
    await page.getByLabel('推进时间').fill('120')
    await page.getByRole('button', { name: '推进时间', exact: true }).click()
    await expect.poll(async () => Number((await page.locator('[class*="metrics"] strong').first().textContent())?.replace(/,/gu, '')), {
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(120)
    await page.locator('section[class*="events"]').locator('pre')
      .filter({ hasText: '"type": "action.completed"' }).first()
      .waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: '保存此刻', exact: true }).click()
    await page.getByRole('button', { name: '从这里开启分支' }).waitFor({ timeout: 10_000 })

    await page.getByRole('button', { name: '故事舞台', exact: true }).first().click()
    await page.getByLabel('使用本地模板叙事').check()
    await page.getByRole('button', { name: '叙述当前场景' }).click()
    await page.locator('article').filter({ has: page.getByRole('button', { name: '重新表述' }) })
      .waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '保存点', exact: true }).click()
    await page.getByRole('button', { name: '开启新世界线', exact: true }).click()
    await expect.poll(async () => await page.getByLabel('演算档案').locator('option').count(), {
      timeout: 15_000,
    }).toBeGreaterThan(1)

    await page.getByRole('button', { name: '实时演算', exact: true }).click()
    await page.getByRole('button', { name: '导出演算存档' }).click()
    const exportRun = page.getByRole('dialog', { name: '导出演算存档' })
    await chooseArchiveDestination(exportRun, runArchive)
    await exportRun.getByRole('button', { name: '导出演算存档' }).click()
    await expect.poll(async () => (await stat(runArchive)).size, { timeout: 15_000 }).toBeGreaterThan(0)

    await page.getByRole('button', { name: '回到我的世界' }).click()
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const exportProject = page.getByRole('dialog', { name: '导出' })
    await chooseArchiveDestination(exportProject, projectArchive)
    await exportProject.getByLabel('包含运行记录').check()
    await exportProject.getByRole('button', { name: '导出', exact: true }).click()
    await expect.poll(async () => (await stat(projectArchive)).size, { timeout: 15_000 }).toBeGreaterThan(0)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
