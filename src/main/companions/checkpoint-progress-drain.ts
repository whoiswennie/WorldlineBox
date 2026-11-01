/** Latest complete checkpoint persistence for one task, never a shared cache.
 * UI milestones remain per event; while one write is running, another event
 * requests one follow-up write of the actual latest complete state. */
export function createCompanionCheckpointProgressDrain(write: () => Promise<void>, report: (error: unknown) => void): {
  request(): void;
  drain(): Promise<void>;
} {
  let dirty = false, running: Promise<void> | undefined;
  const start = () => {
    if (running || !dirty) return;
    const pending = Promise.resolve().then(async () => {
      while (dirty) {
        dirty = false;
        try { await write(); }
        catch (error) {
          // A failed attempt is settled once. Only an actual later progress
          // request can ask for another write; no timer or busy retry exists.
          try { report(error); } catch { /* Reporting cannot poison later work. */ }
        }
      }
    });
    running = pending;
    void pending.finally(() => {
      if (running !== pending) return;
      running = undefined;
      // A request can arrive after the last check but before this cleanup.
      if (dirty) start();
    });
  };
  return {
    request() { dirty = true; start(); },
    async drain() {
      // Includes a follow-up requested while the current attempt was in
      // flight, including the cleanup boundary above. Critical callers still
      // perform their own authoritative final save after this drain.
      while (running) await running;
    },
  };
}
