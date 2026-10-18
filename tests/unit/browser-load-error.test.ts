import { describe, expect, it } from 'vitest';
import { browserLoadFailureKind, formatBrowserLoadError, shouldIgnoreBrowserLoadError } from '../../src/shared/browser-load-error';

describe('browser top-level load failures', () => {
  it.each([
    [-100, 'ERR_CONNECTION_CLOSED', 'connection'], [-105, 'ERR_NAME_NOT_RESOLVED', 'dns'],
    [-106, 'ERR_INTERNET_DISCONNECTED', 'offline'], [-118, 'ERR_CONNECTION_TIMED_OUT', 'timeout'],
    [-130, 'ERR_PROXY_CONNECTION_FAILED', 'proxy'], [-107, 'ERR_SSL_PROTOCOL_ERROR', 'secure'],
    [-202, 'ERR_CERT_AUTHORITY_INVALID', 'secure'], [-200, 'ERR_CERT_COMMON_NAME_INVALID', 'secure'],
    [-809, 'ERR_DNS_SECURE_PROBE_RECORD_INVALID', 'dns'],
  ])('preserves Chromium %s (%s) and identifies the correct recovery guidance', (code, description, kind) => {
    const formatted = formatBrowserLoadError(code, description);
    expect(formatted).toBe(`${description} (${code})`);
    expect(browserLoadFailureKind(formatted)).toBe(kind);
    expect(shouldIgnoreBrowserLoadError(code, description)).toBe(false);
  });

  it('does not misreport a connection closed during TLS as a certificate validation failure', () => {
    expect(browserLoadFailureKind(formatBrowserLoadError(-100, 'ERR_CONNECTION_CLOSED'))).toBe('connection');
    expect(browserLoadFailureKind('ERR_SSL_PROTOCOL_ERROR')).toBe('secure');
  });

  it('retains the diagnostic code without leaking loadURL query parameters in the UI', () => {
    const error = Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://example.invalid/?token=private'"), { errno: -105, code: 'ERR_NAME_NOT_RESOLVED' });
    expect(formatBrowserLoadError(error)).toBe('ERR_NAME_NOT_RESOLVED (-105)');
    expect(formatBrowserLoadError(error)).not.toContain('token=');
    expect(formatBrowserLoadError(new Error('A page process exited.'))).toBe('A page process exited.');
    expect(formatBrowserLoadError(-999, 'A future network error')).toBe('A future network error (-999)');
  });

  it('ignores stop/superseded navigation rejections instead of rendering a failed page', () => {
    expect(shouldIgnoreBrowserLoadError(-3, 'ERR_ABORTED')).toBe(true);
    expect(shouldIgnoreBrowserLoadError(Object.assign(new Error('navigation was stopped'), { errno: -3 }))).toBe(true);
    expect(shouldIgnoreBrowserLoadError(new Error('ERR_ABORTED (-3) loading https://example.test/'))).toBe(true);
    expect(shouldIgnoreBrowserLoadError(new Error('ERR_CONNECTION_CLOSED (-100)'))).toBe(false);
  });

  it('handles unknown/legacy failures without inventing a network diagnosis', () => {
    expect(browserLoadFailureKind('页面进程已退出，请重新加载。')).toBe('generic');
    expect(browserLoadFailureKind('ERR_UNKNOWN_ERROR (-999)')).toBe('generic');
    expect(formatBrowserLoadError(undefined).length).toBeGreaterThan(0);
  });
});
