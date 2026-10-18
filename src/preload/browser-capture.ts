// Import order is deliberate: install the isolated-world Chrome API before the
// unchanged extension content script registers its listeners and reads settings.
import { installBrowserCaptureShim } from './browser-capture-shim';

// Session frame preloads also run for transient blank documents and internal
// error pages. Do not register extension listeners or read preferences there.
// The build inlines this dynamic import into the one sandbox-compatible bundle.
if (installBrowserCaptureShim()) void import('../../extension/content-script');
