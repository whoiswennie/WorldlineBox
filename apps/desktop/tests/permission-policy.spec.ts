import { describe, expect, it } from 'vitest'
import { desktopPermissionAllowed } from '../src/permission-policy.ts'

describe('desktop renderer permission policy', () => {
  const appOrigin = 'http://127.0.0.1:43123'

  it.each(['geolocation', 'clipboard-read', 'clipboard-sanitized-write'])(
    'allows %s for the exact app origin',
    (permission) => {
      expect(desktopPermissionAllowed(permission, appOrigin, appOrigin)).toBe(true)
    },
  )

  it('denies unlisted permissions and every embedded remote origin', () => {
    expect(desktopPermissionAllowed('media', appOrigin, appOrigin)).toBe(false)
    expect(desktopPermissionAllowed('clipboard-read', 'https://example.com', appOrigin)).toBe(false)
    expect(desktopPermissionAllowed('clipboard-sanitized-write', 'https://example.com', appOrigin)).toBe(false)
    expect(desktopPermissionAllowed('clipboard-read', `${appOrigin}.example`, appOrigin)).toBe(false)
  })
})
