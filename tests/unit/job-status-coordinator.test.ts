import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JobStatusCoordinator,
  type JobStatusKind,
  type JobStatusProbeResult,
} from '../../src/renderer/job-status-coordinator';

/**
 * WorldlineBox-e97c00: the fallback status queries must stay bounded while the
 * Worker is blocked. These tests are the contract for that bound: one
 * in-flight request per kind, a burst that collapses into exactly one
 * follow-up, dropped stale results across a library change, and a backoff that
 * only tightens for real activity.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

type Harness = {
  coordinator: JobStatusCoordinator;
  calls: Record<JobStatusKind, number>;
  applied: Array<{ kind: JobStatusKind; value: unknown }>;
};

function createHarness(options: {
  results: Record<JobStatusKind, JobStatusProbeResult | null>;
  gates?: Partial<Record<JobStatusKind, Promise<JobStatusProbeResult | null>>>;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  closedPanelIntervalMs?: number;
}): Harness {
  const calls: Record<JobStatusKind, number> = { media: 0, ai: 0, plugin: 0 };
  const applied: Array<{ kind: JobStatusKind; value: unknown }> = [];
  const probe = (kind: JobStatusKind) => async (): Promise<JobStatusProbeResult | null> => {
    calls[kind] += 1;
    const gate = options.gates?.[kind];
    // The gate models one blocked query: later calls resolve from `results`.
    if (gate && calls[kind] === 1) return gate;
    return options.results[kind];
  };
  const coordinator = new JobStatusCoordinator({
    probes: { media: probe('media'), ai: probe('ai'), plugin: probe('plugin') },
    onResult: (kind, value) => {
      applied.push({ kind, value });
    },
    ...(options.activeIntervalMs === undefined ? {} : { activeIntervalMs: options.activeIntervalMs }),
    ...(options.idleIntervalMs === undefined ? {} : { idleIntervalMs: options.idleIntervalMs }),
    ...(options.closedPanelIntervalMs === undefined ? {} : { closedPanelIntervalMs: options.closedPanelIntervalMs }),
  });
  return { coordinator, calls, applied };
}

const IDLE_RESULTS: Record<JobStatusKind, JobStatusProbeResult> = {
  media: { value: "media-idle", active: false },
  ai: { value: "ai-idle", active: false },
  plugin: { value: "plugin-idle", active: false },
};

describe("JobStatusCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one in-flight request per kind and collapses a burst into one follow-up", async () => {
    const gates = {
      media: deferred<JobStatusProbeResult | null>(),
      ai: deferred<JobStatusProbeResult | null>(),
      plugin: deferred<JobStatusProbeResult | null>(),
    };
    const harness = createHarness({
      results: IDLE_RESULTS,
      gates: {
        media: gates.media.promise,
        ai: gates.ai.promise,
        plugin: gates.plugin.promise,
      },
    });

    harness.coordinator.start();
    for (let index = 0; index < 50; index += 1) harness.coordinator.refreshAll();

    // One request per kind, no matter how many refreshes were requested.
    expect(harness.calls).toEqual({ media: 1, ai: 1, plugin: 1 });
    expect(harness.coordinator.stats().maxPending).toBeLessThanOrEqual(3);

    gates.media.resolve({ value: "media-1", active: false });
    gates.ai.resolve({ value: "ai-1", active: false });
    gates.plugin.resolve({ value: "plugin-1", active: false });
    await flushMicrotasks();

    // Exactly one follow-up per kind: the 50 refreshes collapsed.
    expect(harness.calls).toEqual({ media: 2, ai: 2, plugin: 2 });
    expect(harness.applied.map((entry) => entry.value)).toEqual([
      "media-1",
      "ai-1",
      "plugin-1",
      "media-idle",
      "ai-idle",
      "plugin-idle",
    ]);
    harness.coordinator.stop();
  });

  it("defaults to ignoring completion events while the panel is closed and uses the slow fallback", async () => {
    const harness = createHarness({
      results: IDLE_RESULTS,
      activeIntervalMs: 1000,
      idleIntervalMs: 10000,
      closedPanelIntervalMs: 15000,
    });

    harness.coordinator.start();
    await flushMicrotasks();
    expect(harness.calls).toEqual({ media: 1, ai: 1, plugin: 1 });

    // A completion event no longer turns into a full status re-query.
    for (let index = 0; index < 20; index += 1) harness.coordinator.noteActivity("media");
    await flushMicrotasks();
    expect(harness.calls.media).toBe(1);

    // The slow fallback still refreshes eventually.
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(harness.calls.media).toBe(2);

    harness.coordinator.stop();
  });

  it("queries on completion events once the panel is open", async () => {
    const harness = createHarness({ results: IDLE_RESULTS, activeIntervalMs: 1000, idleIntervalMs: 10000 });
    harness.coordinator.setEventDrivenQueries(false);
    harness.coordinator.setPanelOpen(true);
    harness.coordinator.start();
    await flushMicrotasks();
    harness.coordinator.noteActivity("media");
    await flushMicrotasks();
    expect(harness.calls.media).toBeGreaterThanOrEqual(2);
    harness.coordinator.stop();
  });

  it("uses the fast cadence while the tasks panel is open", async () => {
    const harness = createHarness({
      results: IDLE_RESULTS,
      activeIntervalMs: 1_000,
      idleIntervalMs: 10_000,
    });

    harness.coordinator.start();
    await flushMicrotasks();
    harness.coordinator.setPanelOpen(true);
    await flushMicrotasks();
    expect(harness.calls.media).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(harness.calls.media).toBe(3);
    harness.coordinator.stop();
  });

  it("stops polling while the window is hidden and refreshes once when visible", async () => {
    const harness = createHarness({
      results: IDLE_RESULTS,
      activeIntervalMs: 1_000,
      idleIntervalMs: 1_000,
    });

    harness.coordinator.start();
    await flushMicrotasks();
    expect(harness.calls.media).toBe(1);

    harness.coordinator.setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(harness.calls.media).toBe(1);

    harness.coordinator.setHidden(false);
    await flushMicrotasks();
    expect(harness.calls.media).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(harness.calls.media).toBe(3);
    harness.coordinator.stop();
  });

  it("drops results that resolve after the library changed or after stop", async () => {
    const gate = deferred<JobStatusProbeResult | null>();
    const harness = createHarness({
      results: IDLE_RESULTS,
      gates: { media: gate.promise },
    });

    harness.coordinator.start();
    await flushMicrotasks();
    expect(harness.calls.media).toBe(1);

    // The library changed while the media query was still in flight.
    harness.coordinator.invalidate();
    await flushMicrotasks();
    expect(harness.calls.media).toBe(1);

    gate.resolve({ value: "stale-media", active: false });
    await flushMicrotasks();
    expect(harness.applied.some((entry) => entry.value === "stale-media")).toBe(false);
    // The coalesced follow-up ran against the new library generation.
    expect(harness.calls.media).toBe(2);
    expect(harness.applied).toContainEqual({ kind: "media", value: "media-idle" });

    harness.coordinator.stop();
    await flushMicrotasks();
    const appliedBefore = harness.applied.length;
    harness.coordinator.refreshAll();
    await flushMicrotasks();
    expect(harness.applied.length).toBe(appliedBefore);
  });

  it("keeps pending bounded when the probe never resolves", async () => {
    const never = deferred<JobStatusProbeResult | null>();
    const harness = createHarness({
      results: IDLE_RESULTS,
      gates: { media: never.promise, ai: never.promise, plugin: never.promise },
    });

    harness.coordinator.start();
    for (let index = 0; index < 200; index += 1) {
      harness.coordinator.refreshAll();
      harness.coordinator.noteActivity("media");
    }
    await flushMicrotasks();

    // Requests never grow with the number of asks or with blocking time.
    expect(harness.calls).toEqual({ media: 1, ai: 1, plugin: 1 });
    const stats = harness.coordinator.stats();
    expect(stats.maxPending).toBeLessThanOrEqual(3);
    expect(stats.coalesced).toBeGreaterThan(0);
  });
});
