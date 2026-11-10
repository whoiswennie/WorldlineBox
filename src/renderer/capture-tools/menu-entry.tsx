import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ElevationProvider } from '../ElevationProvider';
import { FontSizeProvider } from '../FontSizeProvider';
import { InspectorCardFeelProvider } from '../InspectorCardFeelProvider';
import { LocaleProvider } from '../i18n';
import { MenuAcrylicProvider } from '../MenuAcrylicProvider';
import { RadiusProvider } from '../RadiusProvider';
import { ThemeProvider } from '../theme';
import { applyRendererPlatform } from '../renderer-platform';
import { CaptureToolsMenuList } from '../CaptureToolsMenuList';
import { ShellStyleScope } from '../ui/ShellStyleScope';
import type { CaptureToolTask, WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import '../styles.css';
import '../ui/tokens.css';
import '../ui/ui.css';
import '../ui/islands-surfaces.css';
import './menu-surface.css';

const api = (window as unknown as { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } }).worldlinebox.captureTools;
applyRendererPlatform(document.documentElement, navigator.userAgent);
document.documentElement.classList.add('capture-tools-menu-surface');
function Surface({ locale }: { locale: 'zh-CN' | 'en' }) {
  const menu = useRef<HTMLDivElement>(null);
  const choose = (task?: CaptureToolTask) => { void api.request({ type: 'menu.choose', ...(task ? { task } : {}) }).catch(() => undefined); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) choose(); };
    document.addEventListener('pointerdown', outside); menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    void api.request({ type: 'menu.ready' }).catch(() => undefined);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <ShellStyleScope><CaptureToolsMenuList locale={locale} menuRef={menu} onChoose={choose} onDismiss={() => choose()} /></ShellStyleScope>;
}
void api.request({ type: 'menu.context' }).then(result => {
  if (!result.ok || !result.menuContext) throw Error('工具列表已失效。');
  const locale = result.menuContext.locale;
  createRoot(document.getElementById('root')!).render(<StrictMode><LocaleProvider initialPreference={locale}><FontSizeProvider><ThemeProvider><ElevationProvider><RadiusProvider><MenuAcrylicProvider><InspectorCardFeelProvider>
    <Surface locale={locale} />
  </InspectorCardFeelProvider></MenuAcrylicProvider></RadiusProvider></ElevationProvider></ThemeProvider></FontSizeProvider></LocaleProvider></StrictMode>);
}).catch(() => { void api.request({ type: 'menu.choose' }).catch(() => undefined); });
