import { randomUUID } from 'node:crypto';
import type { BrowserCompanionActivity as Activity, CompanionBrowserScope } from '../../shared/companion-browser';

/** Live native calls only. Never persisted as tab ownership or a viewing lease. */
export class BrowserCompanionActivity {
  private readonly calls = new Map<string, { activity: Activity; controller: AbortController }>();
  private readonly pausedTabs = new Set<string>();
  private paused = false;
  constructor(private readonly changed: () => void) {}
  state() { return { activities: [...this.calls.values()].map(({ activity }) => ({ ...activity })), paused: this.paused, pausedTabIds: [...this.pausedTabs] }; }
  busy(tabId: string) { return [...this.calls.values()].some(call => call.activity.tabId === tabId); }
  assertAllowed(tabId?: string) {
    if (this.paused || tabId && this.pausedTabs.has(tabId)) throw Error('用户已暂停伙伴使用浏览器；请等待用户恢复，不要重开或换页绕过。');
  }
  pause(paused: boolean, tabId?: string) {
    if (tabId) { if (paused) this.pausedTabs.add(tabId); else this.pausedTabs.delete(tabId); }
    else this.paused = paused;
    if (paused) this.cancel(tabId);
    this.changed();
  }
  cancel(tabId?: string) {
    for (const [id, call] of this.calls) if (!tabId || call.activity.tabId === tabId) {
      this.calls.delete(id); call.controller.abort(Error('用户已停止查看，或标签页已关闭。'));
    }
    this.changed();
  }
  forget(tabId: string) { this.cancel(tabId); this.pausedTabs.delete(tabId); }
  async run<T>(scope: CompanionBrowserScope, tabId: string, action: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertAllowed(tabId); signal?.throwIfAborted();
    const id = randomUUID(), controller = new AbortController();
    const current = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(Error('浏览器调用超时，请检查页面状态。')), 30_000); timer.unref();
    this.calls.set(id, { controller, activity: { id, companionId: scope.companionId, companionName: scope.companionName.slice(0, 200), tabId, action, startedAt: new Date().toISOString() } });
    this.changed();
    let aborted: () => void = () => undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => { aborted = () => reject(current.reason); current.addEventListener('abort', aborted, { once: true }); if (current.aborted) aborted(); });
      return await Promise.race([Promise.resolve().then(() => { current.throwIfAborted(); return operation(current); }), cancelled]);
    } finally { clearTimeout(timer); current.removeEventListener('abort', aborted); this.calls.delete(id); this.changed(); }
  }
}
