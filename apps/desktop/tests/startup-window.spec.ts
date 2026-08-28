import { describe, expect, it } from 'vitest'
import { desktopStartupDataUrl, desktopStartupDocument } from '../src/startup-window.ts'

describe('desktop startup window', () => {
  it('shows the product identity and a bounded startup status before the Host is ready', () => {
    const document = desktopStartupDocument('data:image/png;base64,logo')

    expect(document).toContain('<title>世界线正在启动</title>')
    expect(document).toContain('src="data:image/png;base64,logo"')
    expect(document).toContain('正在启动 Agent 与虚拟伙伴运行时')
    expect(document).toContain("default-src 'none'; img-src data:")
    expect(document).not.toContain('nodeIntegration')
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
