import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  electronLaunchEnv,
  resolveElectronExecutablePath,
  resolveSessionLogPath,
} from "./electron-test-helpers";
import { readFileSync } from "node:fs";

/**
 * Real-usage browse benchmark: a wheel-driven scroll on a real library, and a
 * real library *switch* between two libraries.
 *
 * Random scrollbar jumps do not exercise what users do — they teleport the
 * viewport and skip the continuous wheel path where windowing, media attach and
 * the library-change reload policy actually interact. A switch was never
 * measured at all, which is how "switching libraries stalls" survived a
 * green benchmark.
 *
 * Requires WORLDLINEBOX_E2E_SWITCH_LIBRARIES="<pathA>|<pathB>" (pipe separated) and
 * skips without it. Library paths are never defaulted or committed: this is a
 * real journey that drives a real library's media queue and writes its database,
 * so it must be an explicit operator choice (privacy + workspace-cleanliness
 * rules in AGENTS.md).
 */
const configured = (process.env.WORLDLINEBOX_E2E_SWITCH_LIBRARIES ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const libraryPaths = configured.length >= 2 ? configured : [];
const reportPath = process.env.WORLDLINEBOX_E2E_SWITCH_REPORT;
const wheelMs = Number(process.env.WORLDLINEBOX_E2E_SWITCH_WHEEL_MS ?? 8_000);

test.describe.configure({ timeout: 420_000 });

type ScrollProbe = {
  slotCreated: number;
  slotRemoved: number;
  mediaSrcWrites: number;
  srcCounts: Record<string, number>;
};

async function installScrollProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    const probe = {
      slotCreated: 0,
      slotRemoved: 0,
      mediaSrcWrites: 0,
      srcCounts: {} as Record<string, number>,
    };
    (globalThis as unknown as { __scrollProbe: unknown }).__scrollProbe = probe;
    const slotsIn = (node: Node): number => {
      if (!(node instanceof HTMLElement)) return 0;
      return (node.matches("[data-layout-index]") ? 1 : 0)
        + node.querySelectorAll("[data-layout-index]").length;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          probe.slotCreated += slotsIn(node);
          if (!(node instanceof HTMLElement)) continue;
          const images = node.matches("img.asset-thumbnail")
            ? [node as HTMLImageElement]
            : Array.from(node.querySelectorAll<HTMLImageElement>("img.asset-thumbnail"));
          for (const image of images) {
            const src = image.getAttribute("src");
            if (!src || !src.startsWith("worldlinebox://")) continue;
            probe.mediaSrcWrites += 1;
            probe.srcCounts[src] = (probe.srcCounts[src] ?? 0) + 1;
          }
        }
        for (const node of Array.from(record.removedNodes)) {
          probe.slotRemoved += slotsIn(node);
        }
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          const src = record.target.getAttribute("src");
          if (src && src.startsWith("worldlinebox://")) {
            probe.mediaSrcWrites += 1;
            probe.srcCounts[src] = (probe.srcCounts[src] ?? 0) + 1;
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  });
}

type ScopeState = {
  cards: number;
  slots: number;
  scrollHeight: number;
  allAssetCount: string | null;
  folderOrCollectionRows: number;
  navText: string;
};

async function readScope(window: Page): Promise<ScopeState> {
  return window.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".workspace-canvas");
    const nav = document.querySelector<HTMLElement>(".navigation-pane");
    const labels = [...document.querySelectorAll<HTMLElement>(".navigation-pane .nav-row-label")]
      .map((node) => node.textContent?.trim() ?? "");
    return {
      cards: document.querySelectorAll(".asset-card").length,
      slots: document.querySelectorAll("[data-layout-index]").length,
      scrollHeight: canvas?.scrollHeight ?? -1,
      allAssetCount: labels[0] ? (nav?.innerText.split("\n")[1] ?? null) : null,
      folderOrCollectionRows: labels.length,
      navText: (nav?.innerText ?? "").replace(/\s+/g, " ").slice(0, 220),
    };
  });
}

/**
 * Continuous wheel scroll with jitter, the way a user drags a wheel: many small
 * deltas, direction reversals, and pauses. Returns the geometry it observed.
 */
async function wheelScroll(window: Page, canvasSelector: string, ms: number): Promise<{
  heightSamples: number;
  distinctHeights: number;
  spreadPct: number;
}> {
  const canvas = window.locator(canvasSelector);
  const box = await canvas.boundingBox();
  if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const heights: number[] = [];
  const startedAt = Date.now();
  let direction = 1;
  while (Date.now() - startedAt < ms) {
    const delta = direction * (60 + Math.floor(Math.random() * 240));
    await window.mouse.wheel(0, delta);
    await window.waitForTimeout(60 + Math.floor(Math.random() * 90));
    heights.push(await canvas.evaluate((element) => element.scrollHeight));
    if (Math.random() < 0.25) direction *= -1;
  }
  const min = heights.length ? Math.min(...heights) : -1;
  const max = heights.length ? Math.max(...heights) : -1;
  return {
    heightSamples: heights.length,
    distinctHeights: new Set(heights).size,
    spreadPct: max > 0 ? Number((((max - min) / max) * 100).toFixed(1)) : -1,
  };
}

function countLogEvents(logText: string, needle: string): number {
  return logText.split(needle).length - 1;
}

/**
 * Aggregate every `worker.cmd` / `worker.cmd.roundtrip` line by command type.
 *
 * A stalled switch is diagnosed from two facts that a top-N slice cannot
 * answer: whether the incoming library's commands appear at all, and how long
 * the worst one waited/ran. Command fields live under `context`.
 */
function aggregateLogCommands(
  logText: string,
  scope: string,
): Array<{ commandType: string; count: number; maxQueueMs: number; maxSchedulerWaitMs: number; maxRunMs: number; maxRoundTripMs: number; libraryIds: string[] }> {
  const totals = new Map<string, {
    commandType: string;
    count: number;
    maxQueueMs: number;
    maxSchedulerWaitMs: number;
    maxRunMs: number;
    maxRoundTripMs: number;
    libraryIds: Set<string>;
  }>();
  for (const line of logText.split("\n")) {
    if (!line.includes(`"${scope}"`)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.scope !== scope) continue;
    const context = (parsed.context ?? {}) as Record<string, unknown>;
    const commandType = String(context.type ?? context.commandType ?? "unknown");
    const entry = totals.get(commandType) ?? {
      commandType,
      count: 0,
      maxQueueMs: 0,
      maxSchedulerWaitMs: 0,
      maxRunMs: 0,
      maxRoundTripMs: 0,
      libraryIds: new Set<string>(),
    };
    entry.count += 1;
    entry.maxQueueMs = Math.max(entry.maxQueueMs, Number(context.queueMs ?? 0));
    // `queueMs` is time to *receipt*; `schedulerWaitMs` is time from receipt to
    // admission. A mutation waits for an idle scheduler, so a transition's real
    // wait lives here, and `queueMs` alone reports it as zero.
    entry.maxSchedulerWaitMs = Math.max(
      entry.maxSchedulerWaitMs,
      Number(context.schedulerWaitMs ?? 0),
    );
    entry.maxRunMs = Math.max(entry.maxRunMs, Number(context.runMs ?? 0));
    entry.maxRoundTripMs = Math.max(
      entry.maxRoundTripMs,
      Number(context.roundTripMs ?? context.totalMs ?? 0),
    );
    if (typeof context.libraryId === "string") entry.libraryIds.add(context.libraryId);
    totals.set(commandType, entry);
  }
  return [...totals.values()]
    .map((entry) => ({ ...entry, libraryIds: [...entry.libraryIds] }))
    .sort((left, right) =>
      Math.max(right.maxRoundTripMs, right.maxRunMs, right.maxSchedulerWaitMs)
      - Math.max(left.maxRoundTripMs, left.maxRunMs, left.maxSchedulerWaitMs));
}

test("measures wheel scrolling and a real library switch", async () => {
  test.skip(libraryPaths.length < 2, "Set WORLDLINEBOX_E2E_SWITCH_LIBRARIES=<pathA>|<pathB>.");

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-switch-bench-"));
  const userDataPath = path.join(temporaryRoot, "user-data");
  mkdirSync(userDataPath, { recursive: true });
  const [pathA, pathB] = libraryPaths as [string, string];
  const nameOf = (value: string) => path.basename(value);
  // Seed the recent list so the UI can perform a real switch; the profile stays
  // isolated from the operator's own configuration. `libraryId` is deliberately
  // omitted: the schema requires a UUID, and a wrong one makes the whole v2 file
  // fail to parse (the app then idles on the open-library panel) — the v1
  // migration also produces entries without it.
  writeFileSync(
    path.join(userDataPath, "recent-library.json"),
    JSON.stringify({
      version: 2,
      activePath: pathA,
      libraries: [
        { path: pathA, name: nameOf(pathA), lastOpenedAt: new Date().toISOString() },
        { path: pathB, name: nameOf(pathB), lastOpenedAt: new Date().toISOString() },
      ],
    }),
  );

  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_RESTORE_RECENT: "1",
      WORLDLINEBOX_E2E_USER_DATA_PATH: userDataPath,
      // Main-side request trace: without it a switch that never reaches the
      // Worker cannot be told apart from one Main never handled.
      WORLDLINEBOX_E2E_LIBRARY_TRACE: "1",
    }),
  });

  // Hoisted so the teardown can always undo a paused media queue, even when the
  // measurement fails before or inside the pause experiment.
  let pausedMedia = false;
  let benchmarkWindow: Page | null = null;
  // A renderer that dies under a loaded library must still leave diagnostics:
  // the log-derived fields can be collected after a crash, but everything that
  // needs the live page cannot. Record the failure and keep going to the report.
  let measurementError: string | null = null;

  try {
    const window = await application.firstWindow();
    benchmarkWindow = window;
    window.on("crash", () => {
      measurementError = "renderer crashed";
    });
    await window.waitForLoadState("domcontentloaded");
    // Switching away from a busy library raises a native `window.confirm`
    // warning (confirmLibrarySwitch). Playwright does not answer native modals,
    // so without this the renderer blocks forever and the switch looks like a
    // hang instead of a prompt.
    const dialogs: string[] = [];
    window.on("dialog", (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.accept();
    });
    await installScrollProbe(window);

    const openedA = Date.now();
    await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 180_000 });
    const firstCardAMs = Date.now() - openedA;
    const stateA = await readScope(window);
    const wheelA = await wheelScroll(window, ".workspace-canvas", wheelMs);
    const probeA = await window.evaluate(
      () => (globalThis as unknown as { __scrollProbe: ScrollProbe }).__scrollProbe,
    );

    // Let the source library settle before switching. Opening a library starts
    // background reconciliation; if the Worker is single-threaded inside a long
    // synchronous pass, a switch issued during it queues behind the pass and
    // looks like a hang. Configurable so that hypothesis can be measured.
    const settleMs = Number(process.env.WORLDLINEBOX_E2E_SWITCH_SETTLE_MS ?? 0);
    if (settleMs > 0) {
      try {
        await window.waitForTimeout(settleMs);
      } catch (error) {
        // A crashed renderer under a loaded library is itself a finding, but it
        // must not throw away the log-derived diagnostics below.
        measurementError ??= error instanceof Error ? error.message : String(error);
      }
    }

    // Discriminating experiment: if the Worker is saturated by this library's own
    // media-job churn, a `library.open` queues behind it and the switch hangs.
    // Pausing media first should then make the same switch succeed.
    pausedMedia = process.env.WORLDLINEBOX_E2E_SWITCH_PAUSE_MEDIA === "1";
    if (pausedMedia) {
      const pauseResult = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as {
          worldlinebox: {
            library: {
              listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
              pauseMediaJobs(input: { libraryId: string }): Promise<{ ok: boolean; error?: { code: string } }>;
            };
          };
        }).worldlinebox;
        const opened = await bridge.library.listOpen();
        const libraryId = opened.value?.[0]?.libraryId;
        if (!libraryId) return { ok: false, reason: "no-open-library" };
        const result = await bridge.library.pauseMediaJobs({ libraryId });
        return { ok: result.ok, errorCode: result.error?.code ?? null };
      });
      console.log(`SWITCH_BENCH_PAUSE ${JSON.stringify(pauseResult)}`);
    }

    // ---- real library switch through the UI ----
    const switcher = window.getByRole("button", { name: `当前资源库 ${nameOf(pathA)}` });
    let switchFirstCardMs: number | null = null;
    let switchToSidebarMs: number | null = null;
    let switchTimedOut = true;
    try {
      await expect(switcher).toBeVisible({ timeout: 30_000 });
      const switchStartedAt = Date.now();
      await switcher.click();
      await window.getByRole("menuitem", { name: nameOf(pathB) }).click();
      switchTimedOut = false;
      try {
        await expect(
          window.getByRole("button", { name: `当前资源库 ${nameOf(pathB)}` }),
        ).toBeVisible({ timeout: 90_000 });
        await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 90_000 });
        switchFirstCardMs = Date.now() - switchStartedAt;
        await expect
          .poll(async () => (await readScope(window)).folderOrCollectionRows, { timeout: 90_000 })
          .toBeGreaterThan(4);
        switchToSidebarMs = Date.now() - switchStartedAt;
      } catch {
        switchTimedOut = true;
      }
    } catch (error) {
      // The switch could not even be issued (dead renderer, missing menu).
      measurementError ??= error instanceof Error ? error.message : String(error);
    }
    const stateB = await readScope(window).catch(() => null);
    const wheelB = switchTimedOut || stateB === null
      ? null
      : await wheelScroll(window, ".workspace-canvas", wheelMs).catch(() => null);
    const probeB = switchTimedOut
      ? null
      : await window.evaluate(
        () => (globalThis as unknown as { __scrollProbe: ScrollProbe }).__scrollProbe,
      ).catch(() => null);

    const logText = (() => {
      try {
        return readFileSync(resolveSessionLogPath(path.join(userDataPath, "logs")), "utf8");
      } catch {
        return "";
      }
    })();

    // Diagnostics for a switch that never completes: the switcher's own label,
    // any loading overlay, and what the app logged while it was asked to switch.
    const switchDiagnostics = stateB === null ? null : await window.evaluate(() => {
      const switcherLabel = [...document.querySelectorAll<HTMLElement>("button")]
        .map((node) => node.textContent?.trim() ?? "")
        .find((text) => text.startsWith("当前资源库")) ?? null;
      const buttons = [...document.querySelectorAll<HTMLElement>("button")]
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => text.length > 0 && text.length < 40);
      return {
        switcherLabel,
        loadingBackdrop: document.querySelectorAll(".library-loading-backdrop").length,
        overlayText: (
          document.querySelector<HTMLElement>(".library-loading-backdrop")?.innerText ?? ""
        ).replace(/\s+/g, " ").slice(0, 160),
        libraryButtons: buttons.filter((text) => text.includes("资源库")).slice(0, 8),
        dialogCount: document.querySelectorAll("[role='dialog'], [role='alertdialog']").length,
        dialogText: (
          document.querySelector<HTMLElement>("[role='dialog'], [role='alertdialog']")?.innerText ?? ""
        ).replace(/\s+/g, " ").slice(0, 200),
        cards: document.querySelectorAll(".asset-card").length,
        navText: (document.querySelector<HTMLElement>(".navigation-pane")?.innerText ?? "")
          .replace(/\s+/g, " ").slice(0, 200),
      };
    }).catch(() => null);

    const report = {
      libraryA: nameOf(pathA),
      libraryB: nameOf(pathB),
      measurementError,
      firstCardAMs,
      stateA,
      wheelA,
      probeA: {
        slotCreated: probeA.slotCreated,
        slotRemoved: probeA.slotRemoved,
        mediaSrcWrites: probeA.mediaSrcWrites,
        distinctUrls: Object.keys(probeA.srcCounts).length,
        repeatedSrcWrites: Object.values(probeA.srcCounts)
          .reduce((total, count) => total + Math.max(0, count - 1), 0),
      },
      switch: { switchFirstCardMs, switchToSidebarMs, switchTimedOut, stateB, switchDiagnostics, dialogs },
      wheelB,
      probeB: probeB === null ? null : {
        slotCreated: probeB.slotCreated - probeA.slotCreated,
        slotRemoved: probeB.slotRemoved - probeA.slotRemoved,
        mediaSrcWrites: probeB.mediaSrcWrites - probeA.mediaSrcWrites,
      },
      logTail: logText.split("\n").filter((line) => line.length > 0).slice(-60),
      loadDiag: logText.split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> =>
          typeof entry?.message === "string" && entry.message.includes("LOADDIAG"))
        .slice(-12),
      // WORLDLINEBOX_WORKER_CMD_LOG=1 emits one `worker.cmd` line per command with
      // `queueMs` (waiting to be dispatched) and `runMs` (execution). Every
      // field lives under `context`; reading them from the top level silently
      // compares `undefined`, which is how a 16-second holder stayed invisible.
      // Sorting by queueMs attributes a stalled switch to the command that
      // waited; `slowestCommands` below attributes it to the one that ran.
      commandLog: logText.split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry?.scope === "worker.cmd")
        .map((entry) => entry.context as Record<string, unknown>)
        .sort((left, right) => Number(right?.queueMs ?? 0) - Number(left?.queueMs ?? 0))
        .slice(0, 12),
      // Main-side round trips: which commands Main sent and how long they took.
      roundtripLog: logText.split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry?.scope === "worker.cmd.roundtrip")
        .map((entry) => entry.context as Record<string, unknown>)
        .sort((left, right) => Number(right.totalMs ?? right.roundTripMs ?? 0) - Number(left.totalMs ?? left.roundTripMs ?? 0))
        .slice(0, 12),
      // A switch that stalls does so while a command is *executing*, not while
      // queued: the single Worker thread is busy, so `runMs` is the attribution
      // key and `queueMs` alone cannot see the holder.
      slowestCommands: logText.split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry?.scope === "worker.cmd")
        .map((entry) => entry.context as Record<string, unknown>)
        .sort((left, right) => Number(right?.runMs ?? 0) - Number(left?.runMs ?? 0))
        .slice(0, 15)
        .map((entry) => ({
          type: entry?.type,
          lane: entry?.lane,
          libraryId: entry?.libraryId,
          queueMs: entry?.queueMs,
          schedulerWaitMs: entry?.schedulerWaitMs,
          runMs: entry?.runMs,
          outcome: entry?.outcome,
        })),
      // `worker.scheduler.stall` is emitted when a non-empty queue cannot be
      // admitted at all; it names the lane holder that is blocking it.
      stallLog: logText.split("\n")
        .filter((line) => line.includes("worker.scheduler.stall"))
        .slice(-10),
      // The Worker-side log cannot answer "did Main even dispatch the switch?".
      // Keep the Main-side lifecycle story, otherwise a missing `library.open`
      // for the incoming library is indistinguishable from a Worker-side stall.
      lifecycleLog: logText.split("\n")
        .filter((line) =>
          /library\.opening|library\.open|library\.closed|main\.library-request|open\.cancel|recent-library|library\.open-failed|diag\.library-request/
            .test(line)
          && !line.includes('"scope":"worker.cmd"')
          && !line.includes('"scope":"performance.span"')
          // The per-second viewport reports would otherwise flush the switch's
          // own lifecycle lines out of this window.
          && !line.includes("asset.thumbnail.visible-window")
          && !line.includes("media.list-jobs")
          && !line.includes("plugin.jobs.list")
          && !line.includes("ai.status"))
        .map((line) => line.slice(0, 400))
        .slice(-60),
      errorLog: logText.split("\n")
        .filter((line) =>
          line.includes('"level":"error"')
          && !line.includes('"scope":"worker.cmd"')
          && !line.includes('"scope":"performance.span"'))
        .map((line) => line.slice(0, 400))
        .slice(-40),
      // Top-N slices can hide the one command that matters (a fast `library.open`
      // for the incoming library never reaches either top-N list). Aggregate by
      // command type so presence, worst queue and worst run are always visible.
      commandTypeTotals: aggregateLogCommands(logText, "worker.cmd"),
      roundtripTypeTotals: aggregateLogCommands(logText, "worker.cmd.roundtrip"),
      // Event-loop lag from both processes: a stalled switch is caused by one of
      // them being unable to run its callbacks, not by a missing request.
      lagLog: logText.split("\n")
        .filter((line) => line.includes("eventLoop.lag"))
        .map((line) => line.slice(0, 300))
        .slice(-40),
      // Reconciliation stage timings (WORLDLINEBOX_REFRESH_STAGE_LOG=1): inside the
      // open path, a single stage is what holds the Worker event loop, and the
      // lag line alone cannot say which.
      stageLog: logText.split("\n")
        .filter((line) =>
          // Keep the open-path marks and the top-level reconciliation stages.
          // The per-batch `refresh.managed-assets.stage` lines are one per batch
          // (dozens per open) and would flush everything else out of the window.
          (line.includes("open.refresh-managed-assets.stage")
            || line.includes("open.reconciliation.stage"))
          && !line.includes('"scope":"refresh.managed-assets.stage"'))
        .map((line) => line.slice(0, 260))
        .slice(-40),
      mainLog: {
        sourceRequests: countLogEvents(logText, "worldlinebox-protocol.source-request"),
        mediaJobInterrupted: countLogEvents(logText, "worker.media-job.interrupted"),
      },
    };
    const serialized = JSON.stringify(report, null, 2);
    if (reportPath) writeFileSync(reportPath, serialized, "utf8");
    console.log(`SWITCH_BENCH_BEGIN\n${serialized}\nSWITCH_BENCH_END`);
  } finally {
    // A paused media queue is persistent state in the library's database. The
    // pause experiment must not leave the operator's library with generation
    // stopped, so always resume before leaving, whatever the measurement did.
    if (pausedMedia) {
      try {
        await benchmarkWindow?.evaluate(async () => {
          const bridge = (globalThis as unknown as {
            worldlinebox: {
              library: {
                listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
                resumeMediaJobs(input: { libraryId: string }): Promise<{ ok: boolean }>;
              };
            };
          }).worldlinebox;
          const opened = await bridge.library.listOpen();
          for (const library of opened.value ?? []) {
            await bridge.library.resumeMediaJobs({ libraryId: library.libraryId });
          }
        });
      } catch {
        // Best effort: a failed resume must not mask the measurement result.
      }
    }
    await application.close();
    try {
      rmSync(temporaryRoot, { force: true, recursive: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A leftover temp profile must not fail the measurement.
    }
  }
});
