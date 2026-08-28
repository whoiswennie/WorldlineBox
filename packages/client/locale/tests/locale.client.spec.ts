// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { LocaleSettings, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'

const make = (): {
  ctx: Context
  svc: LocaleRuntime
  events: LocaleSnapshot[]
} => {
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  return { ctx, svc: new LocaleRuntime(ctx), events }
}

describe('LocaleRuntime', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' })
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('publishes the complete bilingual catalog', () => {
    const { svc } = make()
    expect(svc.getLocale()).toMatchObject({
      active: 'zh',
      locales: [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }],
    })
  })

  it('翻译、插值并对缺失键显式回退', () => {
    const { svc } = make()
    svc.register('common', 'zh', { retry: '重试' })
    svc.register('demo', 'zh', { greet: '你好，{name}！' })
    const t = svc.bind('demo')
    expect(t('greet', { name: '世界' })).toBe('你好，世界！')
    expect(t('retry')).toBe('重试')
    expect(t('missing')).toBe('missing')
  })

  it('拒绝重复字典，释放器幂等且会发布新版本', () => {
    const { svc } = make()
    const dispose = svc.register('demo', 'zh', { value: '一' })
    expect(() => svc.register('demo', 'zh', { value: '二' })).toThrow('already has locale')
    const revision = svc.getSnapshot().revision
    dispose()
    expect(svc.getSnapshot().revision).toBe(revision + 1)
    dispose()
    expect(svc.getSnapshot().revision).toBe(revision + 1)
  })

  it('字典变更通知订阅者，取消订阅后停止通知', () => {
    const { svc } = make()
    const seen: number[] = []
    const off = svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
    const dispose = svc.register('demo', 'zh', { value: '值' })
    expect(seen).toEqual([1])
    off()
    dispose()
    expect(seen).toEqual([1])
  })

  it('switches languages while rejecting an unknown locale', () => {
    const { svc, events } = make()
    svc.setLocale('zh')
    expect(events).toHaveLength(0)
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(1)
    expect(() => { svc.setLocale('fr') }).toThrow('not registered')
  })

  it('稳定缓存命名空间绑定函数', () => {
    const { svc } = make()
    expect(svc.bind('a')).toBe(svc.bind('a'))
    expect(svc.bind('a')).not.toBe(svc.bind('b'))
  })

  it('derives the provisional locale from regional browser preferences', () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'en-GB'], language: 'fr-FR' })
    expect(make().svc.getLocale().active).toBe('en')
    vi.stubGlobal('window', undefined)
    expect(make().svc.getLocale().active).toBe('en')
  })

  it('persists explicit choices and adopts later Host preferences without write-back', () => {
    let value: LocaleSettings | undefined = {}
    const listeners = new Set<() => void>()
    const set = vi.fn(async (_field: string, next: string) => { value = { preference: next as never } })
    const host = {
      getSnapshot: () => ({ status: 'ready', value, revision: 0, writable: true }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
    } as unknown as SettingsScope<LocaleSettings>
    const ctx = new Context()
    const svc = new LocaleRuntime(ctx, host)

    svc.setLocale('en')
    expect(set).toHaveBeenCalledWith('preference', 'en')
    set.mockClear()
    value = { preference: 'zh' }
    for (const listener of listeners) listener()
    expect(svc.getLocale().active).toBe('zh')
    expect(set).not.toHaveBeenCalled()
  })
})
