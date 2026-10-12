import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  electronLaunchEnv,
  resolveElectronExecutablePath,
  resolveSessionLogPath,
} from "./electron-test-helpers";

/**
 * CANVAS-038 measurement harness (not a pass/fail gate).
 *
 * Measures a real library — typically a network share — while a fixed scroll
 * journey runs. It exists because the mid-size browse regressions were only
 * ever reproduced by eye: unit tests cannot see slot remounts, and the
 * 「scroll to ~15% and every card reloads」 report needs both renderer churn and
 * Main-process origin reads in one report.
 *
 * Requires WORLDLINEBOX_E2E_NAS_LIBRARY_PATH and is skipped without it, so neither
 * the curated `npm run test:e2e` file list nor a bare `playwright test` over
 * `tests/e2e` (playwright.config testDir) can open a real user library by
 * accident. A real journey is only ever started by setting that variable.
 */
const libraryPath = process.env.WORLDLINEBOX_E2E_NAS_LIBRARY_PATH;
const reportPath = process.env.WORLDLINEBOX_NAS_PROBE_OUT;

test.describe.configure({ timeout: 420_000 });

type ProbeSnapshot = {
  slotCreated: number;
  slotMoved: number;
  slotRemoved: number;
  mediaElementCreated: number;
  mediaSrcReassigned: number;
  maxSrcWritesOnOneElement: number;
  mediaSrcWrites: number;
  distinctMediaUrls: number;
  previewSrcWrites: number;
  sourceSrcWrites: number;
  srcCounts: Record<string, number>;
};

type PhaseSample = {
  t: number;
  h: number;
  cards: number;
  slots: number;
  /** Column count: a change here rewrites total height without any geometry change. */
  cols: number;
  /** Slots the index has not resolved yet: their height is an estimate until they resolve. */
  placeholders: number;
  /** Indices of those unresolved slots: a prefix means the layout was rebuilt from page 1. */
  placeholderIndexes: number[];
};

/**
 * Count real mounts, DOM moves, and media churn separately.
 *
 * React reorders masonry nodes, so a naive MutationObserver reports every
 * `insertBefore` as mount+unmount. A node that reappears in a later batch is a
 * move; a removed node that is still in the document after the batch drains is
 * also a move. Only the residue is a genuine mount/unmount — that is what tears
 * down an `<img>` and re-requests its bytes.
 */
async function installProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    const probe = {
      slotCreated: 0,
      slotMoved: 0,
      slotRemoved: 0,
      mediaElementCreated: 0,
      mediaSrcReassigned: 0,
      maxSrcWritesOnOneElement: 0,
      mediaSrcWrites: 0,
      srcCounts: {} as Record<string, number>,
      seenSlots: new WeakSet<Element>(),
      seenMedia: new WeakSet<Element>(),
      srcWritesByElement: new WeakMap<Element, number>(),
      pendingRemovals: new Set<Element>(),
      flushing: false,
      isSlot(node: Node): boolean {
        return node instanceof HTMLElement && node.matches("[data-layout-index]");
      },
      slotDescendants(node: Node): Element[] {
        if (!(node instanceof HTMLElement)) return [];
        const list = Array.from(node.querySelectorAll("[data-layout-index]"));
        if (node.matches("[data-layout-index]")) list.unshift(node);
        return list;
      },
      mediaIn(node: Node): HTMLImageElement[] {
        if (!(node instanceof HTMLElement)) return [];
        const list = Array.from(node.querySelectorAll<HTMLImageElement>("img.asset-thumbnail"));
        if (node.matches("img.asset-thumbnail")) list.unshift(node as HTMLImageElement);
        return list;
      },
      recordSrc(image: HTMLImageElement): void {
        const src = image.getAttribute("src");
        if (!src || !src.startsWith("worldlinebox://")) return;
        probe.mediaSrcWrites += 1;
        probe.srcCounts[src] = (probe.srcCounts[src] ?? 0) + 1;
        const writes = (probe.srcWritesByElement.get(image) ?? 0) + 1;
        probe.srcWritesByElement.set(image, writes);
        if (writes > 1) probe.mediaSrcReassigned += 1;
        if (writes > probe.maxSrcWritesOnOneElement) {
          probe.maxSrcWritesOnOneElement = writes;
        }
      },
      flushRemovals(): void {
        if (probe.flushing) return;
        probe.flushing = true;
        queueMicrotask(() => {
          probe.flushing = false;
          for (const node of Array.from(probe.pendingRemovals)) {
            probe.pendingRemovals.delete(node);
            if (document.contains(node)) {
              probe.slotMoved += 1;
            } else {
              probe.slotRemoved += 1;
            }
          }
        });
      },
    };
    (window as unknown as { __worldlineboxProbe: unknown }).__worldlineboxProbe = probe;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          for (const slot of probe.slotDescendants(node)) {
            if (probe.seenSlots.has(slot)) probe.slotMoved += 1;
            else {
              probe.seenSlots.add(slot);
              probe.slotCreated += 1;
            }
          }
          for (const image of probe.mediaIn(node)) {
            if (probe.seenMedia.has(image)) continue;
            probe.seenMedia.add(image);
            probe.mediaElementCreated += 1;
            probe.recordSrc(image);
          }
        }
        for (const node of Array.from(record.removedNodes)) {
          for (const slot of probe.slotDescendants(node)) {
            probe.pendingRemovals.add(slot);
          }
        }
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          probe.recordSrc(record.target);
        }
      }
      probe.flushRemovals();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  });
}

async function snapshot(window: Page): Promise<ProbeSnapshot> {
  const raw = await window.evaluate(() => {
    const probe = (window as unknown as {
      __worldlineboxProbe: {
        slotCreated: number;
        slotMoved: number;
        slotRemoved: number;
        mediaElementCreated: number;
        mediaSrcReassigned: number;
        maxSrcWritesOnOneElement: number;
        mediaSrcWrites: number;
        srcCounts: Record<string, number>;
      };
    }).__worldlineboxProbe;
    return {
      slotCreated: probe.slotCreated,
      slotMoved: probe.slotMoved,
      slotRemoved: probe.slotRemoved,
      mediaElementCreated: probe.mediaElementCreated,
      mediaSrcReassigned: probe.mediaSrcReassigned,
      maxSrcWritesOnOneElement: probe.maxSrcWritesOnOneElement,
      mediaSrcWrites: probe.mediaSrcWrites,
      srcCounts: probe.srcCounts,
    };
  });
  const urls = Object.keys(raw.srcCounts);
  let previewSrcWrites = 0;
  let sourceSrcWrites = 0;
  for (const url of urls) {
    const count = raw.srcCounts[url] ?? 0;
    if (url.startsWith("worldlinebox://preview/")) previewSrcWrites += count;
    else if (url.startsWith("worldlinebox://source/")) sourceSrcWrites += count;
  }
  return {
    ...raw,
    distinctMediaUrls: urls.length,
    previewSrcWrites,
    sourceSrcWrites,
  };
}

/** Sample the canvas geometry for `ms` inside the page so samples are tight. */
async function sampleFor(window: Page, ms: number): Promise<PhaseSample[]> {
  return window.evaluate(async (duration) => {
    const out: Array<{
      t: number;
      h: number;
      cards: number;
      slots: number;
      cols: number;
      placeholders: number;
      placeholderIndexes: number[];
    }> = [];
    const started = performance.now();
    while (performance.now() - started < duration) {
      const canvas = document.querySelector(".workspace-canvas");
      const grid = document.querySelector<HTMLElement>(".masonry-columns");
      const unresolved = [
        ...document.querySelectorAll<HTMLElement>("[data-layout-asset-id]"),
      ].filter((slot) => (slot.dataset.layoutAssetId ?? "").startsWith("__geometry__:"));
      out.push({
        t: Math.round(performance.now() - started),
        h: canvas ? canvas.scrollHeight : -1,
        cards: document.querySelectorAll(".asset-card").length,
        slots: document.querySelectorAll("[data-layout-index]").length,
        cols: grid
          ? getComputedStyle(grid).gridTemplateColumns
            .split(" ")
            .filter((part) => part.length > 0).length
          : -1,
        placeholders: unresolved.length,
        placeholderIndexes: unresolved
          .map((slot) => Number(slot.dataset.layoutIndex))
          .sort((left, right) => left - right),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return out;
  }, ms);
}

function geometry(samples: PhaseSample[]): {
  first: number;
  last: number;
  min: number;
  max: number;
  distinctHeights: number;
  maxCards: number;
  columnCounts: number[];
  maxPlaceholders: number;
  placeholderIndexes: number[];
} {
  const heights = samples.map((sample) => sample.h);
  return {
    first: heights[0] ?? -1,
    last: heights.at(-1) ?? -1,
    min: heights.length ? Math.min(...heights) : -1,
    max: heights.length ? Math.max(...heights) : -1,
    distinctHeights: new Set(heights).size,
    maxCards: samples.length ? Math.max(...samples.map((sample) => sample.cards)) : 0,
    columnCounts: [...new Set(samples.map((sample) => sample.cols))],
    maxPlaceholders: samples.length
      ? Math.max(...samples.map((sample) => sample.placeholders))
      : 0,
    placeholderIndexes: [
      ...new Set(samples.flatMap((sample) => sample.placeholderIndexes)),
    ].sort((left, right) => left - right),
  };
}

function countLogEvents(logText: string, needle: string): number {
  return logText.split(needle).length - 1;
}

/** Session logs are JSONL; count by scope + message prefix rather than raw text. */
function countScopedLogEvents(logText: string, scope: string, messagePrefix: string): number {
  let total = 0;
  for (const line of logText.split("\n")) {
    if (!line.includes(`"${scope}"`)) continue;
    try {
      const record = JSON.parse(line) as { scope?: string; message?: string };
      if (record.scope === scope && (record.message ?? "").startsWith(messagePrefix)) total += 1;
    } catch {
      // Truncated tail line: ignore.
    }
  }
  return total;
}

/**
 * Spread of canvas height across the phases that must be stable *while the user
 * scrolls*. The first `settle` phase is deliberately excluded: it contains the
 * one-time index arrival, and folding it in makes the metric depend on whether
 * the index landed before the first sample (two runs of the same build measured
 * 0% and 16.6%). That transition is reported separately as `openIndexTransition`
 * so it is disclosed rather than hidden inside a stability number.
 */
function heightStability(phases: Record<string, PhaseSample[]>): {
  min: number;
  max: number;
  spreadPx: number;
  spreadPct: number;
} {
  const heights = ["dwell15a", "backTop", "dwell15b", "settleTop"]
    .flatMap((name) => phases[name] ?? [])
    .map((sample) => sample.h)
    .filter((height) => height > 0);
  const min = heights.length ? Math.min(...heights) : -1;
  const max = heights.length ? Math.max(...heights) : -1;
  return {
    min,
    max,
    spreadPx: max - min,
    spreadPct: max > 0 ? Number((((max - min) / max) * 100).toFixed(1)) : -1,
  };
}

/** One-time change while the scope's complete index replaces the estimated prefix. */
function openIndexTransition(samples: PhaseSample[]): {
  from: number;
  to: number;
  changed: boolean;
} {
  const heights = samples.map((sample) => sample.h).filter((height) => height > 0);
  const from = heights[0] ?? -1;
  const to = heights.at(-1) ?? -1;
  return { from, to, changed: from !== to };
}

test("measures canvas stability while scrolling a real library", async () => {
  test.skip(
    !libraryPath,
    "Set WORLDLINEBOX_E2E_NAS_LIBRARY_PATH to a real library to run this measurement.",
  );

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-nas-probe-"));
  const userDataPath = path.join(temporaryRoot, "user-data");
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();

  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_USER_DATA_PATH: userDataPath,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath as string,
      // Main disables the preview mirror whenever WORLDLINEBOX_E2E=1 (E2E suites
      // mutate artifact rows directly). A measurement of a real library must
      // run with production caching, otherwise every preview remount is
      // reported as an origin read. Set WORLDLINEBOX_PREVIEW_CACHE_FORCE=0 to
      // deliberately measure the uncached path.
      WORLDLINEBOX_PREVIEW_CACHE_FORCE: process.env.WORLDLINEBOX_PREVIEW_CACHE_FORCE ?? "1",
      WORLDLINEBOX_PREVIEW_CACHE_LOG: "1",
      WORLDLINEBOX_PREVIEW_CACHE_BUDGET_BYTES:
        process.env.WORLDLINEBOX_PREVIEW_CACHE_BUDGET_BYTES ?? String(2 * 1024 * 1024 * 1024),
    }),
  });

  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await installProbe(window);

    const openedAt = Date.now();
    await window.getByRole("button", { name: "打开资源库" }).click();
    const canvas = window.locator(".workspace-canvas");
    await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 120_000 });
    const firstCardMs = Date.now() - openedAt;

    const phases: Record<string, unknown> = {};
    const marks: Array<[string, ProbeSnapshot]> = [];
    const mark = async (name: string) => {
      marks.push([name, await snapshot(window)]);
    };

    await mark("opened");
    const settle = await sampleFor(window, 4_000);
    await mark("settled");

    await canvas.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.15;
    });
    const dwellA = await sampleFor(window, 4_000);
    await mark("dwell15a");

    await canvas.evaluate((element) => element.scrollTo(0, 0));
    const backTop = await sampleFor(window, 2_000);
    await mark("backTop");

    await canvas.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.15;
    });
    const dwellB = await sampleFor(window, 4_000);
    await mark("dwell15b");

    await canvas.evaluate((element) => element.scrollTo(0, 0));
    const settleTop = await sampleFor(window, 2_000);
    await mark("settleTop");

    const rawPhases: Record<string, PhaseSample[]> = {
      settle,
      dwell15a: dwellA,
      backTop,
      dwell15b: dwellB,
      settleTop,
    };
    for (const [name, samples] of Object.entries(rawPhases)) {
      phases[name] = { samples: samples.length, geometry: geometry(samples) };
    }

    const deltas: Record<string, unknown> = {};
    for (let index = 1; index < marks.length; index += 1) {
      const [previousName, previous] = marks[index - 1]!;
      const [name, current] = marks[index]!;
      const repeats = Object.values(current.srcCounts)
        .reduce((total, count) => total + Math.max(0, count - 1), 0);
      deltas[`${previousName}->${name}`] = {
        slotCreated: current.slotCreated - previous.slotCreated,
        slotRemoved: current.slotRemoved - previous.slotRemoved,
        slotMoved: current.slotMoved - previous.slotMoved,
        mediaElementCreated: current.mediaElementCreated - previous.mediaElementCreated,
        mediaSrcReassigned: current.mediaSrcReassigned - previous.mediaSrcReassigned,
        mediaSrcWrites: current.mediaSrcWrites - previous.mediaSrcWrites,
        previewSrcWrites: current.previewSrcWrites - previous.previewSrcWrites,
        sourceSrcWrites: current.sourceSrcWrites - previous.sourceSrcWrites,
        distinctUrls: current.distinctMediaUrls,
        repeatSrcWrites: repeats,
      };
    }

    const final = marks.at(-1)![1];
    const logsPath = path.join(userDataPath, "logs");
    let logText = "";
    try {
      logText = readFileSync(resolveSessionLogPath(logsPath), "utf8");
    } catch {
      logText = "";
    }

    const report = {
      libraryPathSet: true,
      previewCacheForced: process.env.WORLDLINEBOX_PREVIEW_CACHE_FORCE ?? "1",
      firstCardMs,
      total: {
        slotCreated: final.slotCreated,
        slotRemoved: final.slotRemoved,
        slotMoved: final.slotMoved,
        mediaElementCreated: final.mediaElementCreated,
        mediaSrcReassigned: final.mediaSrcReassigned,
        maxSrcWritesOnOneElement: final.maxSrcWritesOnOneElement,
        mediaSrcWrites: final.mediaSrcWrites,
        distinctMediaUrls: final.distinctMediaUrls,
        previewSrcWrites: final.previewSrcWrites,
        sourceSrcWrites: final.sourceSrcWrites,
        repeatedSrcWrites: Object.values(final.srcCounts)
          .reduce((total, count) => total + Math.max(0, count - 1), 0),
      },
      topRepeatedUrls: Object.entries(final.srcCounts)
        .filter(([, count]) => count > 1)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 15),
      phases,
      phaseDeltas: deltas,
      heightStability: heightStability(rawPhases),
      openIndexTransition: openIndexTransition(settle),
      perPhaseDistinctHeights: Object.fromEntries(
        Object.entries(rawPhases).map(([name, samples]) => [
          name,
          new Set(samples.map((sample) => sample.h)).size,
        ]),
      ),
      mainLog: {
        sourceRequests: countLogEvents(logText, "worldlinebox-protocol.source-request"),
        mediaJobInterrupted: countLogEvents(logText, "worker.media-job.interrupted"),
        previewCacheHit: countScopedLogEvents(logText, "preview-cache", "hit"),
        previewCacheMiss: countScopedLogEvents(logText, "preview-cache", "miss"),
        previewCacheStore: countScopedLogEvents(logText, "preview-cache", "store"),
        previewCacheError: countScopedLogEvents(logText, "preview-cache", "error"),
        bytes: logText.length,
      },
    };

    const serialized = JSON.stringify(report, null, 2);
    if (reportPath) writeFileSync(reportPath, serialized, "utf8");
    console.log(`NAS_PROBE_REPORT_BEGIN\n${serialized}\nNAS_PROBE_REPORT_END`);
  } finally {
    await application.close();
    // Electron releases userData file handles asynchronously (especially the
    // preview mirror), so a plain rmSync loses the race and throws EPERM.
    try {
      rmSync(temporaryRoot, { force: true, recursive: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A leftover probe profile must never fail the measurement itself.
    }
  }
});
