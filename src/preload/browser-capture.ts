// Import order is deliberate: install the isolated-world Chrome API before the
// unchanged extension content script registers its listeners and reads settings.
import './browser-capture-shim';
import '../../extension/content-script';
