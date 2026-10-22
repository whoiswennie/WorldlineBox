/**
 * Native media decoders allocate outside the V8 heap. A queue semaphore limits
 * work count, but it does not account for a 16 MP image and a video frame
 * buffer having very different native footprints. Keep one process-wide byte
 * budget so Sharp, OIIO and FFmpeg cannot each spend their own independent
 * concurrency allowance at the same time.
 *
 * The budget is an admission estimate, not an OS cgroup. The production
 * benchmark samples the Worker and child-process RSS separately; this gate is
 * the deterministic protection used before a native decoder starts.
 */

const BYTES_PER_RGBA_PIXEL = 4;
const MIN_RESERVATION_BYTES = 8 * 1024 * 1024;
const UNKNOWN_SHARP_BYTES = 64 * 1024 * 1024;
const UNKNOWN_FFMPEG_BYTES = 128 * 1024 * 1024;
const UNKNOWN_OIIO_BYTES = 192 * 1024 * 1024;
const DECODER_OVERHEAD_BYTES = 16 * 1024 * 1024;

/** Shared native-decode admission budget for one Library Worker process. */
export const MEDIA_NATIVE_MEMORY_BUDGET_BYTES = 384 * 1024 * 1024;

export type MediaNativeDecoder = 'sharp' | 'oiio' | 'ffmpeg';

export interface MediaNativeMemoryEstimate {
  decoder: MediaNativeDecoder;
  sourceByteSize?: number | null;
  width?: number | null;
  height?: number | null;
  /** Number of simultaneously retained RGBA-sized raster copies. */
  decodedRasterCopies?: number | null;
}

export interface MediaNativeConcurrencyAdmission {
  /** Resource name whose active native jobs share one process-wide limit. */
  key: string;
  /** Re-evaluated immediately before a queued reservation is granted. */
  limit: () => number;
}

function positiveSafeInteger(value: number | null | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value! : undefined;
}

function unknownReservation(decoder: MediaNativeDecoder): number {
  switch (decoder) {
    case 'oiio':
      return UNKNOWN_OIIO_BYTES;
    case 'ffmpeg':
      return UNKNOWN_FFMPEG_BYTES;
    case 'sharp':
      return UNKNOWN_SHARP_BYTES;
  }
}

/**
 * Estimate the native footprint before starting a decoder. Source byte size is
 * deliberately not part of the admission decision: local resources have no
 * product size limit, and the native decoders stream their inputs. The
 * estimate only coordinates concurrent decoded rasters and decoder overhead.
 */
export function estimateMediaNativeMemoryBytes(input: MediaNativeMemoryEstimate): number {
  const width = positiveSafeInteger(input.width);
  const height = positiveSafeInteger(input.height);
  if (width === undefined || height === undefined || width > Number.MAX_SAFE_INTEGER / height) {
    return Math.min(MEDIA_NATIVE_MEMORY_BUDGET_BYTES, unknownReservation(input.decoder));
  }

  const pixelBytes = width * height * BYTES_PER_RGBA_PIXEL;
  const rasterCopies = positiveSafeInteger(input.decodedRasterCopies) ?? 1;
  const rasterBytes = pixelBytes > Number.MAX_SAFE_INTEGER / rasterCopies
    ? Number.POSITIVE_INFINITY
    : pixelBytes * rasterCopies;
  const estimate = rasterBytes + DECODER_OVERHEAD_BYTES;
  return Math.min(
    MEDIA_NATIVE_MEMORY_BUDGET_BYTES,
    Math.max(MIN_RESERVATION_BYTES, estimate),
  );
}

export class MediaNativeMemoryBudget {
  private inUseBytes = 0;
  private peakBytes = 0;
  private readonly activeByAdmissionKey = new Map<string, number>();
  private readonly capacityBytes: number;
  private readonly waiting: Array<{
    bytes: number;
    admission?: MediaNativeConcurrencyAdmission;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(capacityBytes = MEDIA_NATIVE_MEMORY_BUDGET_BYTES) {
    this.capacityBytes = Math.max(
      MIN_RESERVATION_BYTES,
      Number.isFinite(capacityBytes) ? Math.trunc(capacityBytes) : MEDIA_NATIVE_MEMORY_BUDGET_BYTES,
    );
  }

  get usedBytes(): number {
    return this.inUseBytes;
  }

  get peakUsedBytes(): number {
    return this.peakBytes;
  }

  activeForAdmission(key: string): number {
    return this.activeByAdmissionKey.get(key) ?? 0;
  }

  async run<T>(
    signal: AbortSignal | undefined,
    requestedBytes: number,
    task: () => Promise<T>,
    admission?: MediaNativeConcurrencyAdmission,
  ): Promise<T> {
    const normalizedRequestedBytes = Number.isFinite(requestedBytes) && requestedBytes > 0
      ? requestedBytes
      : MIN_RESERVATION_BYTES;
    const bytes = Math.min(
      this.capacityBytes,
      Math.max(MIN_RESERVATION_BYTES, Math.trunc(normalizedRequestedBytes)),
    );
    const release = await this.acquire(signal, bytes, admission);
    try {
      if (signal?.aborted) throw new DOMException('Media job cancelled.', 'AbortError');
      return await task();
    } finally {
      release();
    }
  }

  private acquire(
    signal: AbortSignal | undefined,
    bytes: number,
    admission?: MediaNativeConcurrencyAdmission,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Media job cancelled.', 'AbortError'));
    }
    if (this.canFit(bytes, admission) && this.waiting.length === 0) {
      return Promise.resolve(this.reserve(bytes, admission));
    }
    return new Promise((resolve, reject) => {
      const waiter: {
        bytes: number;
        admission?: MediaNativeConcurrencyAdmission;
        resolve: (release: () => void) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        abort?: () => void;
      } = { bytes, admission, resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          this.drainWaiters();
          reject(new DOMException('Media job cancelled while waiting for native memory.', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiting.push(waiter);
      this.drainWaiters();
    });
  }

  private canFit(bytes: number, admission?: MediaNativeConcurrencyAdmission): boolean {
    return this.canFitBytes(bytes) && this.canFitAdmission(admission);
  }

  private canFitBytes(bytes: number): boolean {
    return this.inUseBytes + bytes <= this.capacityBytes;
  }

  private canFitAdmission(admission?: MediaNativeConcurrencyAdmission): boolean {
    if (!admission) return true;

    let limit = 1;
    try {
      const sampledLimit = admission.limit();
      if (Number.isSafeInteger(sampledLimit) && sampledLimit > 0) limit = sampledLimit;
    } catch {
      // An unavailable dynamic limit must never grant extra native work.
    }
    return (this.activeByAdmissionKey.get(admission.key) ?? 0) < limit;
  }

  private reserve(bytes: number, admission?: MediaNativeConcurrencyAdmission): () => void {
    this.inUseBytes += bytes;
    if (admission) {
      this.activeByAdmissionKey.set(
        admission.key,
        (this.activeByAdmissionKey.get(admission.key) ?? 0) + 1,
      );
    }
    this.peakBytes = Math.max(this.peakBytes, this.inUseBytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUseBytes = Math.max(0, this.inUseBytes - bytes);
      if (admission) {
        const active = this.activeByAdmissionKey.get(admission.key) ?? 0;
        if (active <= 1) this.activeByAdmissionKey.delete(admission.key);
        else this.activeByAdmissionKey.set(admission.key, active - 1);
      }
      this.drainWaiters();
    };
  }

  private drainWaiters(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting[0]!;
      if (waiter.signal?.aborted) {
        this.waiting.shift();
        waiter.signal.removeEventListener('abort', waiter.abort!);
        waiter.reject(new DOMException('Media job cancelled while waiting for native memory.', 'AbortError'));
        continue;
      }

      let eligibleIndex = 0;
      if (!this.canFit(waiter.bytes, waiter.admission)) {
        // Preserve FIFO when the head is waiting for byte capacity. When only
        // its keyed native-process slot is full, let a different decoder use
        // genuinely free bytes instead of blocking thumbnails behind FFmpeg.
        if (!this.canFitBytes(waiter.bytes) || !waiter.admission) return;
        const blockedKey = waiter.admission.key;
        eligibleIndex = this.waiting.findIndex((candidate, index) => (
          index > 0
          && candidate.admission?.key !== blockedKey
          && this.canFit(candidate.bytes, candidate.admission)
        ));
        if (eligibleIndex < 0) return;
      }

      const [eligible] = this.waiting.splice(eligibleIndex, 1);
      if (!eligible) return;
      eligible.signal?.removeEventListener('abort', eligible.abort!);
      eligible.resolve(this.reserve(eligible.bytes, eligible.admission));
    }
  }
}

/** One budget shared by every open library in the Worker process. */
export const mediaNativeMemoryBudget = new MediaNativeMemoryBudget();
