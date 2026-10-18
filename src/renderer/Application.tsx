import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell, type ApplicationShellState } from './ApplicationShell';
import { ContextMenuProvider } from './context-menu';
import { MusicProvider } from './music/MusicProvider';
import { ThemeBackground } from './theme/AnimatedBackground';
import { HoverTipHost } from './hover-tip';
import { EditTextContextMenuHost } from './edit-text-context-menu';
import { WindowsWindowControls } from './WindowsWindowControls';
import { WindowEdgeResizeHandles } from './WindowEdgeResizeHandles';
import { usesWindowsStyleShell } from './renderer-platform';
import { useT } from './i18n';
import type { AssetManagerHandle } from './App';
import type { WorldlineBoxDshLauncherApi } from '../shared/dsh-launcher';
import type { WorldlineBoxApplicationNetworkApi } from '../shared/application-network';
import type { WorldlineBoxCompanionsApi } from '../shared/companions';
import type { WorldlineBoxMusicApi } from '../shared/music';
import type { WorldlineBoxShellApi } from '../shared/external-url';
import type { WorldlineBoxBrowserApi } from '../shared/browser';
import type { CaptureToolTask, WorldlineBoxCaptureToolsApi } from '../shared/capture-tools';
import { CaptureToolsToolbar } from './CaptureToolsToolbar';
import type { WorldlineBoxLibraryApi } from '../shared/library-api';
import type { ExtensionSaveCompletedEvent } from '../shared/protocol/responses';
import './feature-loading.css';

const Launcher = lazy(() => import('./launcher/DshLauncher').then(module => ({ default: module.DshLauncher })));
const Browser = lazy(() => import('./browser/BrowserPage').then(module => ({ default: module.BrowserPage })));
const Companions = lazy(() => import('./companions/Companions').then(module => ({ default: module.Companions })));
const Assets = lazy(() => import('./App').then(module => ({ default: module.AssetManager })));
const Network = lazy(() => import('./network/ApplicationNetworkPage').then(module => ({ default: module.ApplicationNetworkPage })));
const api = (window as Window & { worldlinebox?: { dshLauncher?: WorldlineBoxDshLauncherApi;
  captureTools?: WorldlineBoxCaptureToolsApi; network?: WorldlineBoxApplicationNetworkApi; companions?: WorldlineBoxCompanionsApi; music?: WorldlineBoxMusicApi; shell?: WorldlineBoxShellApi; browser?: WorldlineBoxBrowserApi; library?: WorldlineBoxLibraryApi } }).worldlinebox;

function FeatureLoading() {
  return <div className="feature-loading" role="status"><span className="feature-loading-dot" aria-hidden="true" />正在打开…</div>;
}

/** The navigation shell has no dependency on asset editors, 3D or partner views. */
export function App() {
  const t = useT();
  const [activeModuleId, setActiveModuleId] = useState('dsh');
  const [toolError, setToolError] = useState('');
  const openTool = useCallback((task: CaptureToolTask, source?: 'browser') => {
    void api?.captureTools?.request({ type: 'open', task, ...(source ? { source } : {}) }).then(result => setToolError(result.ok ? '' : result.error)).catch(() => setToolError('无法打开屏幕工具，请重试。'));
  }, []);
  const assetManagerRef = useRef<AssetManagerHandle>(null);
  const pendingSettings = useRef(false);
  const pendingExtensionSave = useRef<ExtensionSaveCompletedEvent | null>(null);
  const [settingsController, setSettingsController] = useState<'idle' | 'opening' | 'open'>('idle');
  const [shellState, setShellState] = useState<ApplicationShellState>({ settingsOpen: false, settingsDisabled: false });
  const attachAssetManager = useCallback((handle: AssetManagerHandle | null) => {
    assetManagerRef.current = handle;
    if (handle && pendingSettings.current) { pendingSettings.current = false; handle.openSettings(); }
    if (handle && pendingExtensionSave.current) {
      handle.revealExtensionSave(pendingExtensionSave.current);
      pendingExtensionSave.current = null;
    }
  }, []);
  useEffect(() => api?.library?.onExtensionSaveCompleted((event) => {
    // The retained Assets view pauses effects while another module is active.
    // Retain the reveal until its lazy view and library state have resumed.
    if (assetManagerRef.current) {
      assetManagerRef.current.revealExtensionSave(event);
    } else {
      pendingExtensionSave.current = event;
    }
    setActiveModuleId('assets');
  }), []);
  useEffect(() => api?.browser?.onCaptureOpenAssets(() => setActiveModuleId('assets')), []);
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
      {usesWindowsStyleShell(navigator.userAgent) ? <><WindowsWindowControls shell={api?.shell} /><WindowEdgeResizeHandles shell={api?.shell} /></> : null}
      {toolError ? <div className="application-tool-error" role="alert">{toolError}<button type="button" onClick={() => setToolError('')} aria-label={t('common.close')}>×</button></div> : null}
      <ApplicationShell activeModuleId={activeModuleId} onSelectModule={setActiveModuleId} onOpenSettings={openSettings}
        tools={api?.captureTools ? <CaptureToolsToolbar onOpen={openTool} /> : null}
        settingsOpen={shellState.settingsOpen} settingsDisabled={activeModuleId === 'assets' && shellState.settingsDisabled}
        modules={[
          { id: 'dsh', label: t('appNavigation.launcher'), icon: 'box', content: <Suspense fallback={<FeatureLoading />}><Launcher api={api?.dshLauncher} /></Suspense> },
          { id: 'companions', label: t('appNavigation.companions'), icon: 'users', content: <Suspense fallback={<FeatureLoading />}><Companions api={api?.companions} dshApi={api?.dshLauncher} onOpenSettings={openSettings} isActive={activeModuleId === 'companions'} /></Suspense> },
          { id: 'assets', label: t('appNavigation.assets'), icon: 'grid', keepEffectsActive: settingsController !== 'idle', content: <Suspense fallback={<FeatureLoading />}><Assets settingsRef={attachAssetManager} onShellStateChange={reportShellState} isModuleActive={activeModuleId === 'assets'} /></Suspense> },
          { id: 'browser', label: t('appNavigation.browser'), icon: 'globe', content: <Suspense fallback={<FeatureLoading />}><Browser api={api?.browser} active={activeModuleId === 'browser' && settingsController === 'idle' && !shellState.settingsOpen} onScreenshot={() => openTool('screenshot', 'browser')} onSelection={() => openTool('selection', 'browser')} onOpenAssets={() => setActiveModuleId('assets')} onOpenNetwork={() => setActiveModuleId('network')} /></Suspense> },
          { id: 'network', label: t('appNavigation.network'), icon: 'network', content: <Suspense fallback={<FeatureLoading />}><Network api={api?.network} /></Suspense> },
        ]} />
    </div>
  </MusicProvider></ContextMenuProvider>;
}
