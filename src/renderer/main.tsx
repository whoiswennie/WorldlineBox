// System UI fonts keep startup independent of hundreds of webfont shards.
// Font assets opened by the asset viewer continue to load on demand.
import { lazy, StrictMode, Suspense } from 'react';
import { RendererReady, StartupBoundary, StartupScreen } from './StartupScreen';
import { createRoot, type Root } from 'react-dom/client';

import { ElevationProvider } from './ElevationProvider';
import { FontSizeProvider } from './FontSizeProvider';
import { InspectorCardFeelProvider } from './InspectorCardFeelProvider';
import { LocaleProvider } from './i18n';
import { MenuAcrylicProvider } from './MenuAcrylicProvider';
import { RadiusProvider } from './RadiusProvider';
import { ShortcutProvider } from './shortcut-provider';
import { applyRendererPlatform } from './renderer-platform';
import {
  applyMenuAcrylicPreferences,
  loadMenuAcrylicPreferences,
} from './menu-acrylic-preferences';
import {
  applyRadiusPreferences,
  loadRadiusPreferences,
} from './radius-preferences';
import {
  applyShadowPreferences,
  loadShadowPreferences,
} from './shadow-preferences';
import { ThemeProvider } from './theme';
import {
  applyFontSizePreferences,
  loadFontSizePreferences,
} from './font-size-preferences';
import './styles.css';
import './ui/tokens.css';
import './ui/ui.css';
import './ui/islands-surfaces.css';

applyRendererPlatform(document.documentElement, navigator.userAgent);
// Apply elev level before first paint so level 0 never flashes shell shadows.
applyShadowPreferences(loadShadowPreferences());
// Apply menu acrylic before first paint so the shared context-menu surface does
// not flash from the opaque default while React providers mount.
applyMenuAcrylicPreferences(loadMenuAcrylicPreferences());
applyRadiusPreferences(loadRadiusPreferences());
// Apply the user's typography scale before React mounts to avoid a default-size
// flash. This is app typography, separate from OS/Chromium display scaling.
applyFontSizePreferences(loadFontSizePreferences());

const root = document.getElementById('root');
const App = lazy(() => import('./Application').then(module => ({ default: module.App })));
const WorldWindow = lazy(() => import('./companions/world/CompanionWorldWindow').then(module => ({ default: module.CompanionWorldWindow })));
const CaptureWindow = lazy(() => import('./capture-tools/CaptureToolsWindow').then(module => ({ default: module.CaptureToolsWindow })));
const observer = new URLSearchParams(window.location.search).get('window') === 'companion-world';
const captureWindow = new URLSearchParams(window.location.search).get('window') === 'capture-tools';

if (!root) {
  throw new Error('Renderer root element is missing.');
}

// Entry-point invalidation can re-evaluate this module during development.
// Reuse the existing root so HMR does not create two owners for the same DOM.
const applicationRoot: Root = import.meta.hot?.data.applicationRoot ?? createRoot(root);
if (import.meta.hot) import.meta.hot.data.applicationRoot = applicationRoot;
applicationRoot.render(
  <StrictMode>
    <LocaleProvider>
      <FontSizeProvider>
        <ThemeProvider>
          <ElevationProvider>
            <RadiusProvider>
            <MenuAcrylicProvider>
              <InspectorCardFeelProvider>
                <StartupBoundary><Suspense fallback={observer || captureWindow ? <StartupScreen title={captureWindow ? '正在打开屏幕工具' : '正在打开伙伴世界'} compact /> : null}><RendererReady>{captureWindow ? <CaptureWindow /> : observer ? <WorldWindow /> : <ShortcutProvider><App /></ShortcutProvider>}</RendererReady></Suspense></StartupBoundary>
              </InspectorCardFeelProvider>
            </MenuAcrylicProvider>
            </RadiusProvider>
          </ElevationProvider>
        </ThemeProvider>
      </FontSizeProvider>
    </LocaleProvider>
  </StrictMode>,
);
