/** Keep provider credentials out of visible and copied companion diagnostics. */
export function redactCompanionDiagnostic(text: string) {
  return text.replace(/\bsk-[\w-]{8,}/gi, '[redacted]')
    .replace(/(\bbearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1[redacted]');
}
