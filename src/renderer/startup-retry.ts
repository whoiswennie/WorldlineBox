const RETRY_KEY = 'worldlinebox.startup-retries';
export function startupRetryCount(): number {
  try { const value = Number(sessionStorage.getItem(RETRY_KEY) ?? '0'); return Number.isInteger(value) && value >= 0 ? Math.min(2, value) : 2; } catch { return 2; }
}
export function retryStartup(): void {
  const count = startupRetryCount(); if (count >= 2) return;
  try { sessionStorage.setItem(RETRY_KEY, String(count + 1)); } catch { return; }
  window.location.reload();
}
