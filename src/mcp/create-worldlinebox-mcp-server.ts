import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { AutomationCommandGateway, AutomationExecutionContext } from '../automation/command-gateway';
import { AUTOMATION_API_VERSION } from '../automation/command-registry';
import { callWorldlineBoxMcpTool, type WorldlineBoxMcpPluginToolBridge } from './call-tool';
import { shouldEmitCommandCompleted } from './command-completed-filter';
import type { PluginMcpToolDefinition } from './plugin-tool-catalog';
import { listWorldlineBoxMcpTools, mcpExposureAllowsWrite, type WorldlineBoxMcpToolExposure } from './tool-catalog';

export type WorldlineBoxMcpSessionEvent =
  | { type: 'context-changed' }
  | { type: 'tools-changed' }
  | { type: 'library-changed'; libraryId: string; changeSequence: number };

export interface WorldlineBoxMcpSessionBackend {
  getExecutionContext(): AutomationExecutionContext | undefined;
  getToolExposure(): WorldlineBoxMcpToolExposure;
  getPluginTools(): WorldlineBoxMcpPluginToolBridge | undefined;
  /** Last known library change sequence for the response echo (ADR-0031 §2). */
  getLibraryChangeSequence?(libraryId: string): number | undefined;
  subscribe?(listener: (event: WorldlineBoxMcpSessionEvent) => void): () => void;
}

export type WorldlineBoxMcpServerOptions = {
  backend: WorldlineBoxMcpSessionBackend;
  gateway: AutomationCommandGateway;
  serverName?: string;
  serverVersion?: string;
  /**
   * Desktop feedback for MCP tool results (WorldlineBox-fmbr): fired only when a
   * non-read command actually executed (two-phase challenge reports excluded),
   * with the structured result so the renderer can show the same toast as the
   * manual operation. Read-only and failed calls deliberately emit nothing.
   */
  onCommandCompleted?: (input: {
    commandId: string;
    result: unknown;
  }) => void;
};

/**
 * MCP clients receive this during initialize, so an Agent does not have to
 * infer WorldlineBox's targeting and confirmation rules from tool names alone.
 */
export const WORLDLINEBOX_MCP_INSTRUCTIONS = [
  'After initialize, call tools/list to discover the available WorldlineBox tools.',
  'Call worldlinebox_library_list_open or worldlinebox_library_list_recent to obtain a libraryId.',
  'Every library-scoped tool call must include that explicit libraryId; desktop focus is never an implicit target.',
  'Critical operations first return an exact challenge and require a second confirmation call.',
].join(' ');

function toolResultText(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} {
  const serialized = JSON.stringify(payload, null, 2);
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      content: [{ type: 'text', text: serialized }],
      structuredContent: payload as Record<string, unknown>,
    };
  }
  return { content: [{ type: 'text', text: serialized }] };
}

/** Creates the only MCP protocol implementation used by WorldlineBox. */
export function createWorldlineBoxMcpServer(options: WorldlineBoxMcpServerOptions): Server {
  const { backend, gateway } = options;
  const server = new Server(
    {
      name: options.serverName ?? 'worldlinebox',
      version: options.serverVersion ?? String(AUTOMATION_API_VERSION),
    },
    {
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions: WORLDLINEBOX_MCP_INSTRUCTIONS,
    },
  );

  const currentExposure = (): WorldlineBoxMcpToolExposure => backend.getToolExposure();
  const pluginTools = (): readonly PluginMcpToolDefinition[] => {
    const exposure = currentExposure();
    const writeEnabled = mcpExposureAllowsWrite(exposure);
    if (!writeEnabled) return [];
    // Plugin tools are part of the static credential catalogue. A library
    // target, when required, is supplied in the individual call.
    const listed = backend.getPluginTools()?.list(undefined) ?? [];
    return listed;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = listWorldlineBoxMcpTools(currentExposure());
    const pluginDefinitions = pluginTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const tool of pluginDefinitions) {
      if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
      names.add(tool.name);
    }
    return {
      tools: [
        ...listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
        ...pluginDefinitions.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    const reportProgress = progressToken === undefined
      ? undefined
      : async (progress: number, total = 1, message?: string): Promise<void> => {
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress,
              total,
              ...(message === undefined ? {} : { message }),
            },
          });
        } catch {
          // Progress is advisory. A disconnected notification stream must not
          // turn the underlying Gateway result into a second failure.
        }
      };
    await reportProgress?.(0, 1, 'WorldlineBox is running the tool.');
    const result = await callWorldlineBoxMcpTool({
      toolName: request.params.name,
      arguments: request.params.arguments ?? {},
      context: backend.getExecutionContext(),
      exposure: currentExposure(),
      gateway,
      pluginTools: backend.getPluginTools(),
      signal: extra.signal,
      ...(backend.getLibraryChangeSequence === undefined
        ? {}
        : { getLibraryChangeSequence: backend.getLibraryChangeSequence }),
    });
    await reportProgress?.(1, 1, result.ok ? 'WorldlineBox completed the tool.' : 'WorldlineBox rejected the tool call.');
    if (result.ok && result.commandId !== undefined && result.plugin === undefined) {
      // WorldlineBox-fmbr: only executed non-read commands surface on the desktop;
      // read calls and phase-1 challenge reports (nothing executed yet) stay quiet.
      if (shouldEmitCommandCompleted(result.commandId, result.result)) {
        const completedResult = result.result !== null
          && typeof result.result === 'object'
          && !Array.isArray(result.result)
          && result.historyEntryId !== undefined
          ? { ...(result.result as Record<string, unknown>), historyEntryId: result.historyEntryId }
          : result.result;
        options.onCommandCompleted?.({ commandId: result.commandId, result: completedResult });
      }
    }
    if (!result.ok) {
      return {
        ...toolResultText({ ok: false, code: result.code, message: result.message, gateway: result.gateway }),
        isError: true,
      };
    }
    return toolResultText({
      ok: true,
      toolName: result.toolName,
      commandId: result.commandId,
      ...(result.plugin === undefined ? {} : { plugin: result.plugin }),
      ...(result.libraryId === undefined ? {} : { libraryId: result.libraryId }),
      ...(result.libraryChangeSequence === undefined
        ? {}
        : { libraryChangeSequence: result.libraryChangeSequence }),
      result: result.result,
      ...(result.historyEntryId === undefined ? {} : { historyEntryId: result.historyEntryId }),
      ...(result.undoGroupId === undefined ? {} : { undoGroupId: result.undoGroupId }),
    });
  });

  const unsubscribe = backend.subscribe?.((event) => {
    if (event.type === 'tools-changed') {
      void server.sendToolListChanged().catch(() => undefined);
    }
    if (event.type === 'library-changed') {
      void server.sendLoggingMessage({
        level: 'info',
        logger: 'worldlinebox.library',
        data: { type: 'library.changed', libraryId: event.libraryId, changeSequence: event.changeSequence },
      }).catch(() => undefined);
    }
  });
  const close = server.close.bind(server);
  server.close = async () => {
    unsubscribe?.();
    await close();
  };
  return server;
}
