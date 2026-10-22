import { evaluateWorldGraphicsCapability, type WorldGraphicsCapability, type WorldGraphicsReasonCode } from '../../shared/world-graphics-capability';

let report: WorldGraphicsCapability | undefined;
const listeners = new Set<() => void>();
export const getWorldGraphicsCapability = () => report;
export const subscribeWorldGraphicsCapability = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: WorldGraphicsCapability) { report = next; listeners.forEach(listener => listener()); return next; }

/** A 1x1, no-draw context check; no assets, shaders, benchmark, network or model. */
export function checkWorldGraphicsCapability(options: { totalMemoryBytes?: number } = {}): WorldGraphicsCapability {
  let context: WebGL2RenderingContext | null = null;
  let canvas: HTMLCanvasElement | undefined;
  const memory = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  try {
    canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    const lost = context ? context.isContextLost() || context.getContextAttributes() === null : false;
    return publish(evaluateWorldGraphicsCapability({ webgl2: context !== null, contextLost: lost, totalMemoryBytes: options.totalMemoryBytes, browserMemoryGiB: memory }));
  } catch {
    return publish(evaluateWorldGraphicsCapability({ webgl2: false, probeFailed: true, totalMemoryBytes: options.totalMemoryBytes, browserMemoryGiB: memory }));
  } finally {
    // Destroy the temporary native graphics context immediately. It is never
    // inserted into the document or retained alongside the real world renderer.
    try { context?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Driver cleanup cannot turn a completed check into a render attempt. */ }
    canvas?.remove();
  }
}

/** A real scene failure supersedes the earlier small-context success. */
export function markWorldGraphicsUnavailable(reasonCode: WorldGraphicsReasonCode, reason: string): WorldGraphicsCapability {
  return publish({ ...(report ?? evaluateWorldGraphicsCapability({ webgl2: false })), status: 'unavailable', checkedAt: new Date().toISOString(), reasonCode, reason });
}
