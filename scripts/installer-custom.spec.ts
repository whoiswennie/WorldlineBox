import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

interface DesktopPackage {
  name: string
  build: {
    win: {
      icon: string
      target?: unknown
    }
    nsis?: unknown
  }
}

describe('WorldlineBox custom Windows installer', () => {
  it('packages the desktop directory without an NSIS UI', async () => {
    const [desktopPackage, buildBatch] = await Promise.all([
      readFile(resolve(root, 'apps', 'desktop', 'package.json'), 'utf8'),
      readFile(resolve(root, 'build-exe.bat'), 'utf8'),
    ])
    const desktop = JSON.parse(desktopPackage) as DesktopPackage
    const build = desktop.build

    expect(desktop.name).toBe('worldline-box-desktop')
    expect(build.win.icon).toBe('../../build/icon.ico')
    expect(build.win.target).toBeUndefined()
    expect(build.nsis).toBeUndefined()
    expect(buildBatch).toContain('--win --dir')
    expect(buildBatch).toContain('scripts\\build-custom-installer.mjs')
    expect(buildBatch).toContain('WorldlineBox-Setup-!APP_VERSION!.exe')
    expect(buildBatch).not.toContain('--win nsis')
  })

  it('uses a self-drawn installer and uninstaller with a stable directory name', async () => {
    const [source, packager] = await Promise.all([
      readFile(resolve(root, 'apps', 'installer', 'windows', 'WorldlineInstaller.cs'), 'utf8'),
      readFile(resolve(root, 'scripts', 'build-custom-installer.mjs'), 'utf8'),
    ])

    expect(source).toContain('WindowStyle = WindowStyle.None')
    expect(source).toContain('AllowsTransparency = true')
    expect(source).toContain('ShowInstallPage()')
    expect(source).toContain('ShowUninstallPage()')
    expect(source).toContain('ShowProgressPage(')
    expect(source).toContain('ShowErrorPage(')
    expect(source).not.toContain('MessageBox.Show')
    expect(source).toContain('NormalizeInstallDirectory')
    expect(source).toContain('"WorldlineBox"')
    expect(source).toContain('ApplicationExe = "WorldlineBox.exe"')
    expect(source).not.toContain('"正在安装 " + entry.Name')
    expect(source).toContain('SafeDestination')
    expect(source).toContain('Registry.LocalMachine')
    expect(source).toContain('你的个人数据将继续保留')
    expect(source).not.toContain('@deepseek')
    expect(packager).toContain("footer.write('WLBOX001'")
    expect(packager).toContain("'zip:compression=deflate,compression-level=1'")
    expect(packager).toContain("resolve(input, '世界线.exe')")
    expect(packager).toContain("resolve(input, 'WorldlineBox.exe')")
    expect(packager).toContain('restoreLocalizedExecutable')
    expect(packager).toContain('collectNonAsciiPaths(input)')
    expect(packager).toContain('Installer payload contains non-ASCII paths')
  })
})
