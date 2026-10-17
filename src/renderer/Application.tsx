import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { ApplicationShell, type ApplicationShellState } from './ApplicationShell';
import { ContextMenuProvider } from './context-menu';
import { MusicProvider } from './music/MusicProvider';
import { ThemeBackground } from './theme/AnimatedBackground';
import { HoverTipHost } from './hover-tip';
import { EditTextContextMenuHost } from './edit-text-context-menu';
import { WindowsWindowControls } from './WindowsWindowControls';
import { resolveRendererPlatform } from './renderer-platform';
import { useT } from './i18n';
import type { AssetManagerHandle } from './App';
import type { WorldlineBoxDshLauncherApi } from '../shared/dsh-launcher';
import type { WorldlineBoxCompanionsApi } from '../shared/companions';
import type { WorldlineBoxMusicApi } from '../shared/music';
import type { WorldlineBoxShellApi } from '../shared/external-url';
import './feature-loading.css';

const Launcher = lazy(() => import('./launcher/DshLauncher').then(module => ({ default: module.DshLauncher })));
const Companions = lazy(() => import('./companions/Companions').then(module => ({ default: module.Companions })));
const Assets = lazy(() => import('./App').then(module => ({ default: module.AssetManager })));
const api = (window as Window & { worldlinebox?: { dshLauncher?: WorldlineBoxDshLauncherApi;
  companions?: WorldlineBoxCompanionsApi; music?: WorldlineBoxMusicApi; shell?: WorldlineBoxShellApi } }).worldlinebox;

function FeatureLoading() {
  return <div className="feature-loading" role="status"><span className="feature-loading-dot" aria-hidden="true" />正在打开…</div>;
}

/** The navigation shell has no dependency on asset editors, 3D or partner views. */
export function App() {
  const t = useT();
  const [activeModuleId, setActiveModuleId] = useState('dsh');
  const assetManagerRef = useRef<AssetManagerHandle>(null);
  const pendingSettings = useRef(false);
  const [settingsController, setSettingsController] = useState<'idle' | 'opening' | 'open'>('idle');
  const [shellState, setShellState] = useState<ApplicationShellState>({ settingsOpen: false, settingsDisabled: false });
  const attachAssetManager = useCallback((handle: AssetManagerHandle | null) => {
    assetManagerRef.current = handle;
    if (handle && pendingSettings.current) { pendingSettings.current = false; handle.openSettings(); }
  }, []);
  const reportShellState = useCallback((state: ApplicationShellState) => {
    setShellState(state);
    setSettingsController(current => state.settingsOpen ? 'open' : current === 'open' ? 'idle' : current);
  }, []);
  const openSettings = useCallback(() => {
    pendingSettings.current = true;
    setSettingsController(current => current === 'idle' ? 'opening' : current);
    if (assetManagerRef.current) { pendingSettings.current = false; assetManagerRef.current.openSettings(); }
  }, []);
  return <ContextMenuProvider><MusicProvider api={api?.music}>
    <div className="application-root"><ThemeBackground /><HoverTipHost /><EditTextContextMenuHost />
      {resolveRendererPlatform(navigator.userAgent) === 'windows' ? <WindowsWindowControls shell={api?.shell} /> : null}
      <ApplicationShell activeModuleId={activeModuleId} onSelectModule={setActiveModuleId} onOpenSettings={openSettings}
        settingsOpen={shellState.settingsOpen} settingsDisabled={activeModuleId === 'assets' && shellState.settingsDisabled}
        modules={[
          { id: 'dsh', label: t('appNavigation.launcher'), icon: 'box', content: <Suspense fallback={<FeatureLoading />}><Launcher api={api?.dshLauncher} /></Suspense> },
          { id: 'companions', label: t('appNavigation.companions'), icon: 'users', content: <Suspense fallback={<FeatureLoading />}><Companions api={api?.companions} dshApi={api?.dshLauncher} onOpenSettings={openSettings} isActive={activeModuleId === 'companions'} /></Suspense> },
          { id: 'assets', label: t('appNavigation.assets'), icon: 'grid', keepEffectsActive: settingsController !== 'idle', content: <Suspense fallback={<FeatureLoading />}><Assets settingsRef={attachAssetManager} onShellStateChange={reportShellState} isModuleActive={activeModuleId === 'assets'} /></Suspense> },
        ]} />
    </div>
  </MusicProvider></ContextMenuProvider>;
}
