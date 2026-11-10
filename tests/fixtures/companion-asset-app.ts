import { createServer } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LibraryService } from '../../src/worker/library-service';
import { executeLibraryIdentityWorkerCommand } from '../../src/worker/handlers/library-identity';
import { executeAutomationReadOnlyWorkerCommand } from '../../src/worker/automation-readonly-command-executor';
import { executeAssetIngestionWorkerCommand } from '../../src/worker/handlers/asset-ingestion';
import { createAutomationCommandGateway } from '../../src/automation/command-gateway';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import { AutomationExecutionJournal, createJsonFileAutomationExecutionStore } from '../../src/main/automation-execution-journal';
import { EmbeddedMcpServer } from '../../src/main/embedded-mcp-server';
import { McpSettingsStore } from '../../src/main/mcp-settings-store';
import { McpPermissionPolicyStore } from '../../src/main/mcp-permission-policy-store';
import { McpPermissionBroker } from '../../src/main/mcp-permission-broker';
import { McpOperationChallengeStore } from '../../src/main/mcp-operation-challenge';
import { createDesktopAutomationFilePlanApprovalHandler } from '../../src/main/automation-file-plan-approval';
import { BotAssetManagerApp } from '../../src/main/companion-bot/asset-manager-app';

/** Actual protocol, gateway, permission broker, Worker handlers and SQLite libraries. */
export async function createCompanionAssetApp(root: string) {
  const logger = { info() {}, error(scope: string, error: unknown) { process.stderr.write(scope + ': ' + String(error) + '\n'); } };
  const port = await new Promise<number>((resolve, reject) => { const probe = createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); }); });
  const settings = new McpSettingsStore(root); settings.setPreferences({ enabled: false, autoStart: false, port });
  const libraries = new LibraryService({ observerFactory: () => ({ close() {} }) });
  const worker = { async request(command: WorkerCommand) {
    const request = { requestId: randomUUID(), command };
    const result = await executeAutomationReadOnlyWorkerCommand(libraries, command)
      ?? await executeLibraryIdentityWorkerCommand(libraries, request)
      ?? await executeAssetIngestionWorkerCommand(libraries, request, { scheduleThumbnails() {}, async withMediaSchedulingSuspended(_id, operation) { return await operation(); } });
    if (!result) throw Error('Unexpected fixture command ' + command.type); return result;
  }, onLibraryChanged: () => () => undefined };
  const journal = new AutomationExecutionJournal({ store: createJsonFileAutomationExecutionStore(path.join(root, 'executions.json')), logger });
  const policy = new McpPermissionPolicyStore(root), broker = new McpPermissionBroker({ policyStore: policy, challengeStore: new McpOperationChallengeStore() });
  const gateway = createAutomationCommandGateway(worker, journal, {
    auditSink: journal, auditLogger: logger, permissionBroker: broker,
    libraryBindingHandler: { bindLibrary() { throw Error('MCP must retain explicit stateless library targeting'); } },
    libraryContextHandler: { async execute({ commandId }) { const open = libraries.listLibraries(); if (commandId === 'library.list-open') return { libraries: open.map(library => ({ libraryId: library.libraryId, displayName: library.displayName, active: false })), activeLibraryId: null, contextRevision: 0 }; if (commandId === 'library.list-recent') return open.map(library => ({ libraryId: library.libraryId, displayName: library.displayName })); throw Error('Unexpected lifecycle command'); } },
    filePlanApprovalHandler: createDesktopAutomationFilePlanApprovalHandler({ workerClient: worker, confirm: async () => { throw Error('MCP must not request a desktop click'); } }),
  });
  const server = new EmbeddedMcpServer({ userDataPath: root, settingsStore: settings, journal, gateway, workerClient: worker, logger, permissionPolicyStore: policy, permissionBroker: broker, getPluginTools: () => undefined });
  const app = new BotAssetManagerApp(() => server);
  return { server, app, libraries, close: async () => { await app.close(); await server.close(); libraries.closeAll(); } };
}
