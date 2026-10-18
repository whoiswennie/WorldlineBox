type ContentStyleInstaller = (root: ShadowRoot, css: string) => void;
let installer: ContentStyleInstaller | undefined;

/** The built-in isolated preload supplies its stylesheet implementation. */
export function setContentStyleInstaller(value: ContentStyleInstaller | undefined): void {
  installer = value;
}

export function installContentStyle(root: ShadowRoot, css: string): void {
  if (installer) { installer(root, css); return; }
  // Preserve the standalone Chrome extension's existing style insertion.
  const style = root.ownerDocument.createElement('style');
  style.textContent = css;
  root.appendChild(style);
}
