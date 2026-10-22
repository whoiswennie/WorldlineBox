/** Local admission policy for the optional 3D observer, never for world simulation. */
export const WORLD_GRAPHICS_MINIMUM_MEMORY_GIB = 4;
export type WorldGraphicsReasonCode = 'webgl2_unavailable' | 'context_lost' | 'memory_insufficient' | 'probe_failed';
export interface WorldGraphicsCapability {
  status: 'available' | 'unavailable';
  checkedAt: string;
  webgl2: boolean;
  reason?: string;
  reasonCode?: WorldGraphicsReasonCode;
  memoryGiB?: number;
  memorySource?: 'system' | 'browser';
  minimumMemoryGiB: number;
}
export interface WorldGraphicsEvidence {
  webgl2: boolean;
  contextLost?: boolean;
  probeFailed?: boolean;
  totalMemoryBytes?: number;
  browserMemoryGiB?: number;
  checkedAt?: string;
}

/** Unknown/invalid memory is not zero. No vendor, core-count or VRAM guesses. */
export function evaluateWorldGraphicsCapability(evidence: WorldGraphicsEvidence): WorldGraphicsCapability {
  const valid = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0;
  const system = valid(evidence.totalMemoryBytes), browser = valid(evidence.browserMemoryGiB);
  const memoryGiB = system ? evidence.totalMemoryBytes! / 1024 ** 3 : browser ? evidence.browserMemoryGiB : undefined;
  const base: WorldGraphicsCapability = { status: 'available', checkedAt: evidence.checkedAt ?? new Date().toISOString(), webgl2: evidence.webgl2,
    minimumMemoryGiB: WORLD_GRAPHICS_MINIMUM_MEMORY_GIB,
    ...(memoryGiB !== undefined ? { memoryGiB, memorySource: system ? 'system' as const : 'browser' as const } : {}) };
  if (evidence.probeFailed) return { ...base, status: 'unavailable', reasonCode: 'probe_failed', reason: '当前未能完成图形检测，请重新检测。' };
  if (!evidence.webgl2) return { ...base, status: 'unavailable', reasonCode: 'webgl2_unavailable', reason: '当前图形环境无法创建 WebGL 2 画面。请检查显卡驱动或硬件加速设置后重新检测。' };
  if (evidence.contextLost) return { ...base, status: 'unavailable', reasonCode: 'context_lost', reason: '当前图形上下文不可用，请稍后重新检测。' };
  if (memoryGiB !== undefined && memoryGiB < WORLD_GRAPHICS_MINIMUM_MEMORY_GIB) return { ...base, status: 'unavailable', reasonCode: 'memory_insufficient',
    reason: `当前${system ? '系统总内存' : '浏览器报告的约计内存'}低于本软件 3D 场景的 ${WORLD_GRAPHICS_MINIMUM_MEMORY_GIB} GiB 安全预算，暂不加载 3D 画面。` };
  return base;
}
