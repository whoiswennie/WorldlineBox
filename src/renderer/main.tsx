// System UI fonts keep startup independent of hundreds of webfont shards.
// Font assets opened by the asset viewer continue to load on demand.
import { lazy, StrictMode, Suspense } from 'react';
import { RendererReady, StartupBoundary, StartupScreen } from './StartupScreen';
import { createRoot } from 'react-dom/client';

import { ElevationProvider } from './ElevationProvider';
import { FontSizeProvider } from './FontSizeProvider';
import { InspectorCardFeelProvider } from './InspectorCardFeelProvider';
import { LocaleProvider } from './i18n';
import { MenuAcrylicProvider } from './MenuAcrylicProvider';
import { applyRendererPlatform } from './renderer-platform';
import {
  applyMenuAcrylicPreferences,
  loadMenuAcrylicPreferences,
} from './menu-acrylic-preferences';
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

applyRendererPlatform(document.documentElement, navigator.userAgent);
// Apply elev level before first paint so level 0 never flashes shell shadows.
applyShadowPreferences(loadShadowPreferences());
// Apply menu acrylic before first paint so the shared context-menu surface does
// not flash from the opaque default while React providers mount.
applyMenuAcrylicPreferences(loadMenuAcrylicPreferences());
// Apply the user's typography scale before React mounts to avoid a default-size
// flash. This is app typography, separate from OS/Chromium display scaling.
applyFontSizePreferences(loadFontSizePreferences());

const root = document.getElementById('root');
const App = lazy(() => import('./Application').then(module => ({ default: module.App })));
const WorldWindow = lazy(() => import('./companions/world/CompanionWorldWindow').then(module => ({ default: module.CompanionWorldWindow })));
const observer = new URLSearchParams(window.location.search).get('window') === 'companion-world';

if (!root) {
  throw new Error('Renderer root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <FontSizeProvider>
        <ThemeProvider>
          <ElevationProvider>
            <MenuAcrylicProvider>
              <InspectorCardFeelProvider>
                <StartupBoundary><Suspense fallback={observer ? <StartupScreen title="正在打开伙伴世界" compact /> : null}><RendererReady>{observer ? <WorldWindow /> : <App />}</RendererReady></Suspense></StartupBoundary>
              </InspectorCardFeelProvider>
            </MenuAcrylicProvider>
          </ElevationProvider>
        </ThemeProvider>
      </FontSizeProvider>
    </LocaleProvider>
  </StrictMode>,
);
