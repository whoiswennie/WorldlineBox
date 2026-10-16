/** Wait for real resources, with cancellation and a bounded degraded first draw. */
export async function prepareWorldResources(input: {
  compile: Promise<unknown>; assets: Promise<unknown>[]; signal: AbortSignal;
  onProgress: (value: { completed: number; total: number; compiled: boolean }) => void;
  timeoutMs?: number;
}): Promise<{ failedAssets: number; compileFailed: boolean; timedOut: boolean; cancelled: boolean }> {
  let completed = 0, failedAssets = 0, compiled = false, compileFailed = false, active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => undefined;
  const progress = () => { if (active && !input.signal.aborted) input.onProgress({ completed, total: input.assets.length, compiled }); };
  const result = () => ({ failedAssets, compileFailed, timedOut: false, cancelled: false });
  try {
    progress();
    const resources = Promise.all([
      input.compile.then(() => { compiled = true; progress(); }, () => { compileFailed = true; compiled = true; progress(); }),
      Promise.all(input.assets.map(asset => asset.then(() => { completed++; progress(); }, () => { completed++; failedAssets++; progress(); }))),
    ]).then(result);
    if (input.signal.aborted) { void resources; return { ...result(), cancelled: true }; }
    const deadline = new Promise<ReturnType<typeof result>>(resolve => { timer = setTimeout(() => resolve({ ...result(), timedOut: true }), input.timeoutMs ?? 20_000); });
    const cancelled = new Promise<ReturnType<typeof result>>(resolve => { cancel = () => resolve({ ...result(), cancelled: true }); input.signal.addEventListener('abort', cancel, { once: true }); });
    return await Promise.race([resources, deadline, cancelled]);
  } finally { active = false; clearTimeout(timer); input.signal.removeEventListener('abort', cancel); }
}
