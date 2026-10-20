/** Only a provider's actual HTTPS origin can trigger the sign-in notice. */
export function isRestrictedBrowserSignIn(value: string): boolean {
  try { const url = new URL(value); return url.origin === 'https://accounts.google.com' && !url.username && !url.password; }
  catch { return false; }
}

export function externalBrowserUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.length <= 8192 ? url.href : undefined; }
  catch { return undefined; }
}
