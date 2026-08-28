import { describe, expect, it } from 'vitest'
import {
  desktopStartupDataUrl,
  desktopStartupDocument,
  desktopStartupStageScript,
} from '../src/startup-window.ts'

describe('desktop startup window', () => {
  it('shows the product identity and a bounded startup status before the Host is ready', () => {
    const document = desktopStartupDocument('data:image/png;base64,logo')

    expect(document).toContain('<title>世界线正在启动</title>')
    expect(document).toContain('src="data:image/png;base64,logo"')
    expect(document).toContain('正在初始化桌面安全环境')
    expect(document).toContain('id="startup-stage"')
    expect(document).toContain('步骤 1 / 4')
    expect(document).toContain("default-src 'none'; img-src data:")
    expect(document).not.toContain('nodeIntegration')
  })

  it('updates the visible stage, detail, step, and progress through a bounded DOM script', () => {
    const script = desktopStartupStageScript({
      step: 3,
      title: '启动 Agent 与插件运行时',
      detail: '正在加载账户、插件和虚拟伙伴…',
    })

    expect(script).toContain("document.getElementById('startup-stage')")
    expect(script).toContain('启动 Agent 与插件运行时')
    expect(script).toContain('步骤 3 / 4')
    expect(script).toContain('75%')
  })

  it('embeds the packaged logo without filesystem or network dependencies', () => {
    const url = desktopStartupDataUrl(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
    const html = Buffer.from(url.slice('data:text/html;base64,'.length), 'base64').toString('utf8')

    expect(url).toMatch(/^data:text\/html;base64,/u)
    expect(html).toContain('data:image/png;base64,iVBORw==')
  })

  it('keeps the embedded startup document comfortably below Chromium URL limits', () => {
    const optimizedLogoUpperBound = new Uint8Array(256 * 1024)
    const url = desktopStartupDataUrl(optimizedLogoUpperBound)

    expect(url.length).toBeLessThan(512 * 1024)
  })
})
