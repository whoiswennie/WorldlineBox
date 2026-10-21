import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ElevationProvider } from '../ElevationProvider';
import { FontSizeProvider } from '../FontSizeProvider';
import { InspectorCardFeelProvider } from '../InspectorCardFeelProvider';
import { LocaleProvider } from '../i18n';
import { MenuAcrylicProvider } from '../MenuAcrylicProvider';
import { RadiusProvider } from '../RadiusProvider';
import { applyRendererPlatform } from '../renderer-platform';
import { ThemeProvider } from '../theme';
import { CaptureToolsWindow } from './CaptureToolsWindow';
import '../ui/tokens.css';
import '../ui/ui.css';
import '../ui/islands-surfaces.css';
import './entry.css';

// Screen tools have their own bounded startup handshake. Do not load the main
// application shell, shortcut registry or its large asset-manager stylesheet.
applyRendererPlatform(document.documentElement, navigator.userAgent);
const root = document.getElementById('root');
if (!root) throw Error('Capture renderer root is missing.');
createRoot(root).render(<StrictMode><LocaleProvider><FontSizeProvider><ThemeProvider><ElevationProvider><RadiusProvider><MenuAcrylicProvider><InspectorCardFeelProvider>
  <CaptureToolsWindow />
</InspectorCardFeelProvider></MenuAcrylicProvider></RadiusProvider></ElevationProvider></ThemeProvider></FontSizeProvider></LocaleProvider></StrictMode>);
