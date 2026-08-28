import { describe, expect, it } from 'vitest'
import type { WebPreferences } from 'electron'
import {
  RENDER_DATA_PREFIX,
  RENDER_WEBVIEW_PARTITION,
  configureRenderWebPreferences,
  embeddingResponseHeaders,
  isRenderWebviewAttachment,
  renderRequestAllowed,
} from '../src/render-webview-policy.ts'

describe('desktop browser-render guest policy', () => {
  it('recognizes only renderer-owned documents in the isolated partition', () => {
    expect(isRenderWebviewAttachment(
      { partition: RENDER_WEBVIEW_PARTITION },
      { src: `${RENDER_DATA_PREFIX}PGgxPm9rPC9oMT4=` },
    )).toBe(true)
    expect(isRenderWebviewAttachment(
      { partition: 'persist:worldline-browser' },
      { src: `${RENDER_DATA_PREFIX}PGgxPm9rPC9oMT4=` },
    )).toBe(false)
    expect(isRenderWebviewAttachment(
      { partition: RENDER_WEBVIEW_PARTITION },
      { src: 'https://example.com/' },
    )).toBe(true)
    expect(isRenderWebviewAttachment(
      { partition: RENDER_WEBVIEW_PARTITION },
      { src: 'http://127.0.0.1/private' },
    )).toBe(false)
    expect(isRenderWebviewAttachment(
      { partition: RENDER_WEBVIEW_PARTITION },
      { src: 'data:text/plain,not-a-render-document' },
    )).toBe(false)
    expect(isRenderWebviewAttachment(
      { partition: 'persist:worldline-browser' },
      { src: 'https://example.com/' },
    )).toBe(false)
  })

  it('disables guest web security without exposing Node or a preload', () => {
    const preferences: WebPreferences = {
      preload: 'malicious.js',
      partition: RENDER_WEBVIEW_PARTITION,
      nodeIntegration: true,
      sandbox: false,
      webSecurity: true,
    }
    configureRenderWebPreferences(preferences)

    expect(preferences).toMatchObject({
      partition: RENDER_WEBVIEW_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      autoplayPolicy: 'no-user-gesture-required',
      disableDialogs: true,
    })
    expect(preferences.preload).toBeUndefined()
  })

  it('allows remote web resources but denies local files and literal private-network targets', () => {
    expect(renderRequestAllowed('https://music.163.com/outchain/player?id=42')).toBe(true)
    expect(renderRequestAllowed('wss://stream.example.com/socket')).toBe(true)
    expect(renderRequestAllowed(`${RENDER_DATA_PREFIX}PGgxPm9rPC9oMT4=`)).toBe(true)
    expect(renderRequestAllowed('blob:null/example')).toBe(true)
    for (const target of [
      'file:///C:/Users/hp/.worldline/settings.yaml',
      'http://127.0.0.1:43123/api',
      'http://10.0.0.2/',
      'http://172.20.0.1/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'http://intranet/',
      'javascript:alert(1)',
    ]) expect(renderRequestAllowed(target)).toBe(false)
  })

  it('removes frame embedding restrictions while preserving the rest of remote CSP', () => {
    expect(embeddingResponseHeaders({
      'X-Frame-Options': ['DENY'],
      'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'none'; img-src https:"],
      'Content-Security-Policy-Report-Only': ["frame-ancestors https://example.com; script-src 'none'"],
      'Cache-Control': ['no-cache'],
    })).toEqual({
      'Content-Security-Policy': ["default-src 'self'; img-src https:"],
      'Content-Security-Policy-Report-Only': ["script-src 'none'"],
      'Cache-Control': ['no-cache'],
    })
  })
})
