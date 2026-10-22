import { z } from 'zod';

export const EMBEDDING_DEVICE_BENCHMARK_VERSION = 'embeddinggemma2-device-v1';
export const embeddingDeviceHardwareSchema = z.strictObject({
  observedAt: z.iso.datetime(), platform: z.string(), arch: z.string(), osRelease: z.string(),
  cpuModel: z.string().max(300), logicalCores: z.number().int().positive(),
  totalMemoryBytes: z.number().nonnegative(), availableMemoryBytes: z.number().nonnegative(),
  gpus: z.array(z.strictObject({ id: z.string().max(80), name: z.string().max(300),
    totalMemoryMiB: z.number().nonnegative(), freeMemoryMiB: z.number().nonnegative(),
    driver: z.string().max(100).optional(),
  })).max(32),
  gpuProbeError: z.string().max(300).optional(),
});
export type EmbeddingDeviceHardware = z.infer<typeof embeddingDeviceHardwareSchema>;

export const embeddingDeviceMetricsSchema = z.strictObject({
  startupMs: z.number().nonnegative(), textMs: z.array(z.number().nonnegative()).length(3),
  textMedianMs: z.number().nonnegative(), imageMs: z.number().nonnegative(), totalMs: z.number().nonnegative(),
  minimumAvailableMemoryBytes: z.number().nonnegative(),
});
export const embeddingDeviceCapabilitySchema = z.strictObject({
  version: z.literal(1), benchmarkVersion: z.literal(EMBEDDING_DEVICE_BENCHMARK_VERSION),
  state: z.enum(['unchecked', 'testing', 'supported', 'unsupported', 'error']),
  stage: z.string().max(300), message: z.string().max(1000), retryable: z.boolean(), cacheUsed: z.boolean(),
  reason: z.enum(['memory_pressure', 'latency', 'integrity', 'runtime', 'cancelled', 'timeout', 'missing_package', 'hardware_changed']).optional(),
  hardware: embeddingDeviceHardwareSchema.optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  testedAt: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional(),
  backend: z.enum(['gpu', 'cpu']).optional(), deviceId: z.string().max(80).optional(), deviceName: z.string().max(300).optional(),
  metrics: embeddingDeviceMetricsSchema.optional(),
  budgets: z.strictObject({ minimumAvailableMemoryBytes: z.number().nonnegative(), textMedianMs: z.number().positive(),
    imageMs: z.number().positive(), startupMs: z.number().positive(), totalMs: z.number().positive() }),
});
export type EmbeddingDeviceCapability = z.infer<typeof embeddingDeviceCapabilitySchema>;
export type EmbeddingDeviceMetrics = z.infer<typeof embeddingDeviceMetricsSchema>;
