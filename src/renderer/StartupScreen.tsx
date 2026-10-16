import { Component, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import logo from '../../assets/icons/startup-logo.png';
import { startupMarkup } from '../shared/startup-presentation';
import { retryStartup, startupRetryCount } from './startup-retry';
import { afterStartupPaint, notifyStartupState } from './startup-lifecycle';
import './startup.css';

export function StartupScreen({ title = '正在打开世界线盒子', detail = '装载界面模块与本地连接', stage = '装载界面模块', compact = false }: { title?: string; detail?: string; stage?: string; compact?: boolean }) {
  const [started] = useState(() => performance.now());
  const [elapsed, setElapsed] = useState(0);
  // The elapsed timer must never recreate the animated DOM every 250 ms.
  const markup = useMemo(() => ({ __html: startupMarkup(logo, title, detail, compact) }), [title, detail, compact]);
  useLayoutEffect(() => { document.getElementById('startup-shell')?.remove(); }, []);
  useEffect(() => { const timer = setInterval(() => setElapsed(performance.now() - started), 250); return () => clearInterval(timer); }, [started]);
  return <div className="startup-host" data-startup-stage={stage} style={{ position: 'absolute', inset: 0, zIndex: 20 }}>
    <div dangerouslySetInnerHTML={markup} />
    <span className="startup-live" role="status" aria-live="polite">{stage} · {(elapsed / 1000).toFixed(1)} 秒</span>
  </div>;
}
export function RendererReady({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.getElementById('startup-shell')?.remove();
    try { sessionStorage.removeItem('worldlinebox.startup-retries'); } catch { /* optional storage */ }
    return afterStartupPaint(() => {
      console.info('startup.renderer.ready', JSON.stringify({ elapsedMs: Math.round(performance.now()) }));
      notifyStartupState('ready');
    });
  }, []);
  return children;
}
export class StartupBoundary extends Component<{ children: ReactNode }, { error: string }> {
  override state = { error: '' };
  static getDerivedStateFromError(error: unknown) { return { error: (error instanceof Error ? error.message : String(error)).slice(0, 600) }; }
  override componentDidCatch(error: unknown) { document.getElementById('startup-shell')?.remove(); console.error('startup.renderer.failed', error); notifyStartupState('failed'); }
  override render() {
    return this.state.error ? <section className="startup-screen is-error" role="alert"><div className="startup-card"><img className="startup-logo" src={logo} alt="WorldlineBox" /><h1>界面未能打开</h1><p className="startup-description">请重试，或在诊断日志中查看本次启动记录。</p><p className="startup-error">{this.state.error}</p><button className="startup-retry" disabled={startupRetryCount() >= 2} onClick={retryStartup}>{startupRetryCount() >= 2 ? "已达重试上限，请查看诊断日志" : "重新加载（最多 2 次）"}</button></div></section> : this.props.children;
  }
}
