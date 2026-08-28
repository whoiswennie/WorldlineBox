import type { WebPreferences } from 'electron'

export const RENDER_WEBVIEW_PARTITION = 'worldline-render'
export const RENDER_DATA_PREFIX = 'data:text/html;charset=utf-8;base64,'

/** True only for renderer-owned HTML documents or allowed direct remote embeds. */
export function isRenderWebviewAttachment(
  preferences: WebPreferences,
  params: Readonly<Record<string, string>>,
): boolean {
  return preferences.partition === RENDER_WEBVIEW_PARTITION
    && typeof params.src === 'string'
    && (
      params.src.startsWith(RENDER_DATA_PREFIX)
      || (/^https?:\/\//iu.test(params.src) && renderRequestAllowed(params.src))
    )
}

/** Apply the hard process boundary while deliberately disabling web CORS/SOP inside the guest. */
export function configureRenderWebPreferences(preferences: WebPreferences): void {
  delete preferences.preload
  preferences.partition = RENDER_WEBVIEW_PARTITION
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.nodeIntegrationInWorker = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webSecurity = false
  preferences.allowRunningInsecureContent = true
  preferences.autoplayPolicy = 'no-user-gesture-required'
  preferences.disableDialogs = true
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part))) return false
  const values = parts.map(Number)
  if (values.some(value => value > 255)) return false
  const [a = 0, b = 0] = values
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (privateIpv4(host)) return true
  if (host === '::' || host === '::1' || /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host)) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(host)?.[1]
  if (mapped !== undefined && privateIpv4(mapped)) return true
  // Single-label DNS commonly names intranet services. Public web embeds use
  // a dotted hostname or an IP literal.
  return !host.includes('.') && !host.includes(':')
}

/** Network policy for the CORS-disabled guest: remote web only, never local files or literal private hosts. */
export function renderRequestAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false
    return !privateHost(url.hostname)
  } catch {
    return false
  }
}

function withoutFrameAncestors(values: readonly string[]): string[] {
  return values
    .map(value => value
      .split(';')
      .filter(directive => !/^\s*frame-ancestors(?:\s|$)/iu.test(directive))
      .join(';')
      .trim())
    .filter(value => value !== '')
}

/** Remove only embedding restrictions; keep the remote page's remaining CSP intact. */
export function embeddingResponseHeaders(
  headers: Readonly<Record<string, readonly string[]>> | undefined,
): Record<string, string[]> | undefined {
  if (headers === undefined) return undefined
  const output: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'x-frame-options') continue
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      const filtered = withoutFrameAncestors(values)
      if (filtered.length > 0) output[name] = filtered
      continue
    }
    output[name] = [...values]
  }
  return output
}
