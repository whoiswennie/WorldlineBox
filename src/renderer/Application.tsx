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
import type { AppSettingsCategoryId } from './app-settings-sections';
import { FastAppSettings } from './FastAppSettings';
import { createShellPortal } from './ui/ShellStyleScope';
import type { WorldlineBoxDshLauncherApi } from '../shared/dsh-launcher';
import type { WorldlineBoxApplicationNetworkApi } from '../shared/application-network';
import type { WorldlineBoxMusicApi } from '../shared/music';
import type { WorldlineBoxShellApi } from '../shared/external-url';
import type { WorldlineBoxBrowserApi } from '../shared/browser';
import type { BrowserPageContext } from '../shared/browser-page-context';
import type { CaptureToolTask, WorldlineBoxCaptureToolsApi } from '../shared/capture-tools';
import { CaptureToolsToolbar } from './CaptureToolsToolbar';
import { useApplicationModuleShortcuts } from './use-application-module-shortcuts';
import type { WorldlineBoxLibraryApi } from '../shared/library-api';
import type { ExtensionSaveCompletedEvent } from '../shared/protocol/responses';
import type { WorldlineBoxBotApi } from '../shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../shared/companion-bot-media';
import { featureLoader } from './feature-loader';
import './feature-loading.css';

const launcherFeature = featureLoader(() => import('./launcher/DshLauncher').then(module => ({ default: module.DshLauncher })));
const browserFeature = featureLoader(() => import('./browser/BrowserPage').then(module => ({ default: module.BrowserPage })));
const companionsFeature = featureLoader(() => import('./companion-bot/BotWorkspace').then(module => ({ default: module.BotWorkspace })));
const assetsFeature = featureLoader(() => import('./App').then(module => ({ default: module.AssetManager })));
const networkFeature = featureLoader(() => import('./network/ApplicationNetworkPage').then(module => ({ default: module.ApplicationNetworkPage })));
const Launcher = lazy(launcherFeature.load), Browser = lazy(browserFeature.load), Companions = lazy(companionsFeature.load);
const Assets = lazy(assetsFeature.load), Network = lazy(networkFeature.load);
const api = (window as Window & { worldlinebox?: { dshLauncher?: WorldlineBoxDshLauncherApi;
  captureTools?: WorldlineBoxCaptureToolsApi; network?: WorldlineBoxApplicationNetworkApi; companionBot?: WorldlineBoxBotApi; companionBotMedia?: WorldlineBoxBotMediaApi; music?: WorldlineBoxMusicApi; shell?: WorldlineBoxShellApi; browser?: WorldlineBoxBrowserApi; library?: WorldlineBoxLibraryApi } }).worldlinebox;

function FeatureLoading() {
  return <div className="feature-loading" role="status"><span className="feature-loading-dot" aria-hidden="true" />正在打开…</div>;
}

type AssetSettingsRequest = { category: AppSettingsCategoryId; expandPlugins?: boolean } | { log: true };
function openAssetSettings(handle: AssetManagerHandle, request: AssetSettingsRequest) {
  if ('log' in request) handle.openAppLog();
  else handle.openSettings(request.category, request.expandPlugins);
}

/** The navigation shell has no dependency on asset editors, 3D or partner views. */
export function App() {
  const t = useT();
  const [activeModuleId, setActiveModuleId] = useState('dsh');
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [notificationTarget, setNotificationTarget] = useState<{ room: string }>();
  const clearTarget = useCallback(() => setNotificationTarget(undefined), []);
  const [desktopPet, setDesktopPet] = useState(false);
  const reportDesktopPet = useCallback((active: boolean, returning?: boolean) => {
    setDesktopPet(active);
    if (returning) setActiveModuleId('companions');
  }, []);
  const [browserContext, setBrowserContext] = useState<BrowserPageContext>();
  useEffect(() => api?.browser?.onCompanionRequest?.(context => { setBrowserContext(context); setActiveModuleId('companions'); }), []);
  useApplicationModuleShortcuts(api?.shell, activeModuleId !== 'assets');
  const [toolError, setToolError] = useState('');
  const openAttachedBrowser = useCallback((id: string) => {
    void api?.browser?.request({ type: 'tab.select', id }).then(result => { if (result.ok) setActiveModuleId('browser'); else setToolError(result.error); });
  }, []);
  const openTool = useCallback((task: CaptureToolTask, source?: 'browser') => {
    void api?.captureTools?.request({ type: 'open', task, ...(source ? { source } : {}) }).then(result => setToolError(result.ok ? '' : result.error)).catch(() => setToolError('无法打开屏幕工具，请重试。'));
  }, []);
  const assetManagerRef = useRef<AssetManagerHandle>(null);
  const pendingSettings = useRef<AssetSettingsRequest>(undefined);
  const [settingsRequest, setSettingsRequest] = useState<AssetSettingsRequest>();
  const [fastSettings, setFastSettings] = useState<AppSettingsCategoryId>();
  const pendingExtensionSave = useRef<ExtensionSaveCompletedEvent | null>(null);
  const [settingsController, setSettingsController] = useState<'idle' | 'opening' | 'open'>('idle');
  const [shellState, setShellState] = useState<ApplicationShellState>({ settingsOpen: false, settingsDisabled: false });
  useEffect(() => {
    const bot = api?.companionBot;
    let received = false;
    const unsubscribe = bot?.onInbox?.(event => {
      received = true; setUnread(event.counts);
      if (event.openRoom) {
        pendingSettings.current = undefined;
        setFastSettings(undefined); setSettingsRequest(undefined);
        setSettingsController(current => current === 'opening' ? 'idle' : current);
        assetManagerRef.current?.closeSettings?.();
        setActiveModuleId('companions'); setNotificationTarget({ room: event.openRoom });
      }
    });
    void bot?.inbox?.().then(counts => { if (!received) setUnread(counts); }).catch(() => undefined);
    return () => { received = true; unsubscribe?.(); };
  }, []);
  const attachAssetManager = useCallback((handle: AssetManagerHandle | null) => {
    assetManagerRef.current = handle;
    if (handle && pendingSettings.current) {
      const request = pendingSettings.current;
      pendingSettings.current = undefined;
      openAssetSettings(handle, request);
    }
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
    if (state.settingsOpen) setFastSettings(undefined);
    setSettingsController(current => state.settingsOpen ? 'open' : current === 'open' ? 'idle' : current);
  }, []);
  const closeFastSettings = useCallback(() => {
    pendingSettings.current = undefined;
    setSettingsRequest(undefined); setFastSettings(undefined);
    setSettingsController(current => current === 'opening' ? 'idle' : current);
    assetManagerRef.current?.closeSettings?.();
  }, []);
  const openSettings = useCallback((category: AppSettingsCategoryId = 'general') => {
    if (shellState.settingsOpen && assetManagerRef.current) {
      assetManagerRef.current.openSettings(category);
      return;
    }
    pendingSettings.current = undefined;
    setFastSettings(category);
    if (category === 'general' || category === 'music') {
      setSettingsRequest(undefined);
      setSettingsController(current => current === 'opening' ? 'idle' : current);
      return;
    }
    setSettingsRequest({ category });
  }, [shellState.settingsOpen]);
  useEffect(() => {
    if (!settingsRequest) return;
    // Paint settings chrome before activating the asset manager on the cold path.
    let task: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      task = setTimeout(() => {
        const handle = assetManagerRef.current;
        setSettingsController('opening');
        if (handle) openAssetSettings(handle, settingsRequest);
        else pendingSettings.current = settingsRequest;
        setSettingsRequest(undefined);
      }, 0);
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(task); };
  }, [settingsRequest]);
  const settingsVisible = !!fastSettings || shellState.settingsOpen || settingsController !== 'idle';
  const openCompanionUrl = useCallback((url: string) => {
    let address: URL;
    try { address = new URL(url); } catch { setToolError('这个链接无法打开。'); return; }
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || url.length > 8192) { setToolError('这个链接无法打开。'); return; }
    if (!api?.browser) { setToolError('内置浏览器尚未就绪，请稍后重试。'); return; }
    void api.browser.request({ type: 'tab.new', url: address.href, background: false }).then(result => {
      if (result.ok) { setToolError(''); setActiveModuleId('browser'); }
      else setToolError(result.error);
    }).catch(() => setToolError('内置浏览器未能打开这个链接，请重试。'));
  }, []);
  return <ContextMenuProvider><MusicProvider api={api?.music}>
    <div className="application-root"><ThemeBackground /><HoverTipHost /><EditTextContextMenuHost />
      {usesWindowsStyleShell(navigator.userAgent) ? <><WindowsWindowControls shell={api?.shell} /><WindowEdgeResizeHandles shell={api?.shell} /></> : null}
      {toolError ? <div className="application-tool-error" role="alert">{toolError}<button type="button" onClick={() => setToolError('')} aria-label={t('common.close')}>×</button></div> : null}
      <ApplicationShell activeModuleId={activeModuleId} onSelectModule={setActiveModuleId} onOpenSettings={() => openSettings()}
        tools={api?.captureTools ? <CaptureToolsToolbar onOpen={openTool} onError={setToolError} nativeMenu={activeModuleId === 'browser' && !settingsVisible ? api.captureTools : undefined} /> : null}
        settingsOpen={settingsVisible} settingsDisabled={activeModuleId === 'assets' && shellState.settingsDisabled}
        modules={[
          { id: 'dsh', preload: launcherFeature.preload, label: t('appNavigation.launcher'), icon: 'box', content: <Suspense fallback={<FeatureLoading />}><Launcher api={api?.dshLauncher} /></Suspense> },
          { id: 'companions', badge: Object.values(unread).reduce((sum, count) => sum + count, 0), keepEffectsActive: desktopPet, preload: companionsFeature.preload, label: t('appNavigation.companions'), icon: 'users', content: <Suspense fallback={<FeatureLoading />}><Companions unread={unread} notificationTarget={notificationTarget} clearTarget={clearTarget} covered={settingsVisible} api={api?.companionBot} mediaApi={api?.companionBotMedia} launcherApi={api?.dshLauncher} browserApi={api?.browser} browserContext={browserContext} onOpenBrowserContext={openAttachedBrowser} onOpenLauncher={() => setActiveModuleId('dsh')} onOpenSettings={() => openSettings('ai')} revealAppLog={api?.shell?.revealAppLog} onOpenUrl={openCompanionUrl} onDesktopPetChange={reportDesktopPet} isActive={activeModuleId === 'companions'} /></Suspense> },
          { id: 'assets', preload: assetsFeature.preload, label: t('appNavigation.assets'), icon: 'grid', keepEffectsActive: settingsController !== 'idle', content: <Suspense fallback={<FeatureLoading />}><Assets settingsRef={attachAssetManager} onShellStateChange={reportShellState} isModuleActive={activeModuleId === 'assets'} /></Suspense> },
          { id: 'browser', preload: browserFeature.preload, label: t('appNavigation.browser'), icon: 'globe', content: <Suspense fallback={<FeatureLoading />}><Browser api={api?.browser} active={activeModuleId === 'browser' && !settingsVisible} onScreenshot={() => openTool('screenshot')} onOpenAssets={() => setActiveModuleId('assets')} onOpenNetwork={() => setActiveModuleId('network')} /></Suspense> },
          { id: 'network', preload: networkFeature.preload, label: t('appNavigation.network'), icon: 'network', content: <Suspense fallback={<FeatureLoading />}><Network api={api?.network} /></Suspense> },
        ]} />
      {fastSettings && createShellPortal(<div className="application-global-dialogs"><FastAppSettings
        category={fastSettings} select={openSettings} close={closeFastSettings}
        openPlugins={() => { setFastSettings('plugins'); setSettingsRequest({ category: 'plugins', expandPlugins: true }); }}
        openLog={() => setSettingsRequest({ log: true })}
        openExtensionReleases={() => { void api?.shell?.openExternalUrl('https://github.com/dolag233/WorldlineBox-Extension/releases/latest'); }}
      /></div>, document.body)}
    </div>
  </MusicProvider></ContextMenuProvider>;
}
