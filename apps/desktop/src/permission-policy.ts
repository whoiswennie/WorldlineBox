/** Permissions the trusted Worldline renderer needs from Electron. */
const APP_PERMISSIONS = new Set([
  'geolocation',
  'clipboard-read',
  // Chromium classifies async image writes separately from writeText(). Keep
  // this grant on the exact local app origin; embedded remote pages remain
  // denied by desktopPermissionAllowed below.
  'clipboard-sanitized-write',
])

/**
 * Keep renderer permissions scoped to the exact local application origin.
 * Embedded remote pages share an Electron session, so permission name alone
 * is never sufficient.
 */
export function desktopPermissionAllowed(
  permission: string,
  requestingOrigin: string,
  appOrigin: string,
): boolean {
  return requestingOrigin === appOrigin && APP_PERMISSIONS.has(permission)
}
