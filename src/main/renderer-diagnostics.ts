import type { WebContentsConsoleMessageEventParams } from "electron";

export interface RendererDiagnosticLogger {
  info(scope: string, message: string, context?: Record<string, unknown>): void;
  error(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

export function logRendererConsoleMessage(
  logger: RendererDiagnosticLogger | undefined,
  details: Pick<WebContentsConsoleMessageEventParams, "level" | "message" | "lineNumber" | "sourceId">,
): void {
  if (logger === undefined) return;
  const { message, lineNumber: line, sourceId } = details;
  // Keep existing log context levels while consuming Electron's modern event.
  const level = { debug: 0, info: 1, warning: 2, error: 3 }[details.level];
  const context = { level, line, sourceId };
  if (level >= 3) {
    logger.error("renderer.console.error", new Error(message), context);
    return;
  }
  if (level === 1 && /^startup\.(?:renderer\.ready|world\.ready)\b/u.test(message)) {
    logger.info('renderer.startup', message.slice(0, 1200), context);
    return;
  }
  if (level === 2) {
    logger.info("renderer.console.warning", message, context);
  }
}

export function logRendererProcessGone(
  logger: RendererDiagnosticLogger | undefined,
  windowId: number,
  details: { reason: string; exitCode: number },
): void {
  logger?.error("renderer.process-gone", new Error(`The renderer process exited: ${details.reason}.`), {
    windowId,
    reason: details.reason,
    exitCode: details.exitCode,
  });
}

export function logRendererUnresponsive(
  logger: RendererDiagnosticLogger | undefined,
  windowId: number,
): void {
  logger?.error("renderer.unresponsive", new Error("The renderer became unresponsive."), { windowId });
}

export function logRendererResponsive(
  logger: RendererDiagnosticLogger | undefined,
  windowId: number,
): void {
  logger?.info("renderer.responsive", "The renderer became responsive again.", { windowId });
}

export function logRendererChildProcessGone(
  logger: RendererDiagnosticLogger | undefined,
  windowId: number | undefined,
  details: {
    type: string;
    reason: string;
    exitCode: number;
    serviceName?: string;
  },
): void {
  logger?.error("renderer.child-process-gone", new Error(`A renderer child process exited: ${details.reason}.`), {
    ...(windowId === undefined ? {} : { windowId }),
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    ...(details.serviceName === undefined ? {} : { serviceName: details.serviceName }),
  });
}
