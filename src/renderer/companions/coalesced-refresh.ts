/** Keep accepting completed snapshots during a burst of change notifications.
 * Only one read batch runs at a time; changes during it request one fresh batch
 * after it settles, instead of invalidating every response already in flight. */
export function createCoalescedRefresh(read: () => void | Promise<unknown>, report?: (error: unknown) => void | Promise<void>) {
  let running: Promise<void> | undefined;
  let dirty = false, disposed = false;
  const stopped = Promise.resolve();

  async function drain(): Promise<void> {
    while (!disposed && dirty) {
      dirty = false;
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
    dispose(): void { disposed = true; dirty = false; },
  };
}
