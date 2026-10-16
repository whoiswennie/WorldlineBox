import { describe, expect, it } from "vitest";

import {
  logRendererChildProcessGone,
  logRendererConsoleMessage,
  logRendererProcessGone,
  logRendererResponsive,
  logRendererUnresponsive,
  type RendererDiagnosticLogger,
} from "../../src/main/renderer-diagnostics";

function createLogger(): RendererDiagnosticLogger & {
  infos: Array<{ scope: string; message: string; context?: Record<string, unknown> }>;
  errors: Array<{ scope: string; error: unknown; context?: Record<string, unknown> }>;
} {
  const logger = {
    infos: [] as Array<{ scope: string; message: string; context?: Record<string, unknown> }>,
    errors: [] as Array<{ scope: string; error: unknown; context?: Record<string, unknown> }>,
    info(scope: string, message: string, context?: Record<string, unknown>) {
      this.infos.push({ scope, message, context });
    },
    error(scope: string, error: unknown, context?: Record<string, unknown>) {
      this.errors.push({ scope, error, context });
    },
  };
  return logger;
}

describe("renderer diagnostics", () => {
  it("forwards only renderer warnings and errors, while preserving console context", () => {
    const logger = createLogger();

    logRendererConsoleMessage(logger, { level: "debug", message: "verbose", lineNumber: 1, sourceId: "source.ts" });
    logRendererConsoleMessage(logger, { level: "info", message: "info", lineNumber: 2, sourceId: "source.ts" });
    logRendererConsoleMessage(logger, { level: "warning", message: "warning", lineNumber: 3, sourceId: "source.ts" });
    logRendererConsoleMessage(logger, { level: "error", message: "error", lineNumber: 4, sourceId: "source.ts" });

    expect(logger.infos).toEqual([{
      scope: "renderer.console.warning",
      message: "warning",
      context: { level: 2, line: 3, sourceId: "source.ts" },
    }]);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({
      scope: "renderer.console.error",
      context: { level: 3, line: 4, sourceId: "source.ts" },
    });
    expect(logger.errors[0]?.error).toBeInstanceOf(Error);
    expect((logger.errors[0]?.error as Error).message).toBe("error");
  });

  it("retains bounded explicit startup timings without forwarding ordinary info chatter", () => {
    const logger = createLogger();
    logRendererConsoleMessage(logger, { level: "info", message: 'startup.renderer.ready {"elapsedMs":412}', lineNumber: 1, sourceId: "startup.ts" });
    logRendererConsoleMessage(logger, { level: "info", message: 'startup.world.ready {"elapsedMs":210}', lineNumber: 2, sourceId: "world.ts" });
    logRendererConsoleMessage(logger, { level: "info", message: "ordinary UI chatter", lineNumber: 3, sourceId: "app.ts" });
    expect(logger.infos).toHaveLength(2); expect(logger.infos.map(entry => entry.scope)).toEqual(["renderer.startup", "renderer.startup"]);
  });

  it("records renderer lifecycle and child-process failures with window identity", () => {
    const logger = createLogger();

    logRendererProcessGone(logger, 12, { reason: "crashed", exitCode: 9 });
    logRendererUnresponsive(logger, 12);
    logRendererResponsive(logger, 12);
    logRendererChildProcessGone(logger, 12, {
      type: "GPU",
      reason: "crashed",
      exitCode: 11,
      serviceName: "GPU Process",
    });

    expect(logger.errors.map((entry) => entry.scope)).toEqual([
      "renderer.process-gone",
      "renderer.unresponsive",
      "renderer.child-process-gone",
    ]);
    expect(logger.errors[0]?.context).toEqual({
      windowId: 12,
      reason: "crashed",
      exitCode: 9,
    });
    expect(logger.errors[2]?.context).toEqual({
      windowId: 12,
      type: "GPU",
      reason: "crashed",
      exitCode: 11,
      serviceName: "GPU Process",
    });
    expect(logger.infos).toEqual([{
      scope: "renderer.responsive",
      message: "The renderer became responsive again.",
      context: { windowId: 12 },
    }]);
  });
});
