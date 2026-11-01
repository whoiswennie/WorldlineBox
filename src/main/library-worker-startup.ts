type StartupWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  once(event: 'show' | 'closed', listener: () => void): unknown;
  removeListener(event: 'show', listener: () => void): unknown;
};

/** Boot the existing utility runtime only after the first real window is
 * visible. No library command, selection, companion service or model task is
 * created here; foreground requests join the client's normal ready promise. */
export function prestartLibraryWorkerAfterWindowShown(window: StartupWindow, ports: {
  isClosing(): boolean;
  start(): Promise<void>;
  report(error: unknown): void;
}): void {
  let scheduled = false;
  const shown = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      if (ports.isClosing() || window.isDestroyed() || !window.isVisible()) return;
      void Promise.resolve().then(() => {
        if (!ports.isClosing() && !window.isDestroyed()) return ports.start();
      }).catch(error => {
        if (!ports.isClosing()) ports.report(error);
      });
    });
  };
  if (window.isVisible()) shown();
  else {
    window.once('show', shown);
    window.once('closed', () => window.removeListener('show', shown));
  }
}
