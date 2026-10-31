type Waiter = { through: number; resolve(): void; reject(error: unknown): void };
type Lane = { requested: number; completed: number; work(): Promise<void>; waiters: Waiter[] };
const lanes = new WeakMap<Map<string, Promise<void>>, Map<string, Lane>>();

/** A drain that observed an empty SQL page cannot acknowledge a later write.
 * Each caller receives its own generation receipt; later work does not keep
 * an earlier receipt waiting, and failure cannot poison the next generation.
 * The supplied map tracks actual pumps for the host's shutdown barrier. */
export function drainCompanionOwnerPublication(inflight: Map<string, Promise<void>>, owner: string, work: () => Promise<void>): Promise<void> {
  let owners = lanes.get(inflight);
  if (!owners) { owners = new Map(); lanes.set(inflight, owners); }
  let lane = owners.get(owner);
  if (!lane) { lane = { requested: 0, completed: 0, work, waiters: [] }; owners.set(owner, lane); }
  lane.work = work;
  const receipt = new Promise<void>((resolve, reject) => lane!.waiters.push({ through: ++lane!.requested, resolve, reject }));
  const start = () => {
    if (inflight.has(owner)) return;
    const pending = Promise.resolve().then(async () => {
      while (lane!.completed < lane!.requested) {
        const through = lane!.requested;
        let failed = false, failure: unknown;
        try { await lane!.work(); } catch (error) { failed = true; failure = error; }
        lane!.completed = through;
        const settled = lane!.waiters.filter(waiter => waiter.through <= through);
        lane!.waiters = lane!.waiters.filter(waiter => waiter.through > through);
        for (const waiter of settled) { if (failed) waiter.reject(failure); else waiter.resolve(); }
      }
    });
    inflight.set(owner, pending);
    void pending.finally(() => {
      if (inflight.get(owner) !== pending) return;
      inflight.delete(owner);
      // A call may join after the final observation and before this cleanup.
      if (lane!.completed < lane!.requested) start();
      else if (owners!.get(owner) === lane) owners!.delete(owner);
    }).catch(() => undefined);
  };
  start(); return receipt;
}
