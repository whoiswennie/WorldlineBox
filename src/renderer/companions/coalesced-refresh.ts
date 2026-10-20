/** Keep accepting completed snapshots during a burst of change notifications.
 * Only one read batch runs at a time; changes during it request one fresh batch
 * after it settles, instead of invalidating every response already in flight. */
export function createCoalescedRefresh(read: () => void | Promise<unknown>, report?: (error: unknown) => void | Promise<void>, minimumIntervalMs = 0) {
  let running: Promise<void> | undefined;
  let dirty = false, disposed = false;
  let lastStart = -Infinity, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const stopped = Promise.resolve();

  async function drain(): Promise<void> {
    while (!disposed && dirty) {
      const wait = minimumIntervalMs - (Date.now() - lastStart);
      if (wait > 0) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(() => { timer = undefined; wake = undefined; resolve(); }, wait); });
      if (disposed) break;
      dirty = false;
      lastStart = Date.now();
      try { await read(); }
      catch (error) {
        // A failed read is only retried if another real change arrived.
        try { await report?.(error); } catch { /* Reporting cannot break the refresh queue. */ }
      }
    }
    // There is no await between the final dirty check and clearing this slot,
    // so a new notification cannot fall into a settled-promise handoff gap.
    running = undefined;
  }

  return {
    trigger(): Promise<void> {
      if (disposed) return stopped;
      dirty = true;
      running ??= Promise.resolve().then(drain);
      return running;
    },
    dispose(): void { disposed = true; dirty = false; clearTimeout(timer); wake?.(); wake = undefined; },
  };
}
