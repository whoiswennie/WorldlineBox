import { describe, expect, it } from 'vitest'
import { WINDOWS_APP_ID, windowsAppDetails } from '../src/windows-app-details.ts'

describe('Windows application shell details', () => {
  it('uses the packaged AUMID and the real icon for taskbar grouping and relaunch', () => {
    expect(windowsAppDetails('C:\\Worldline\\resources\\app-icon.ico', 'C:\\Worldline\\世界线.exe'))
      .toEqual({
        appId: WINDOWS_APP_ID,
        appIconPath: 'C:\\Worldline\\resources\\app-icon.ico',
        appIconIndex: 0,
        relaunchCommand: 'C:\\Worldline\\世界线.exe',
      })
    expect(WINDOWS_APP_ID).toBe('fantasy.worldline.desktop')
  })
})
