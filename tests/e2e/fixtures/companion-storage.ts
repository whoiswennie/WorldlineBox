import type { ElectronApplication } from '@playwright/test';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../../src/shared/companion-storage';

type FixtureHost = { topicAcceptanceStorage?: { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; close(): Promise<void> } };
/** Real UtilityProcess over the actual selected SQLite database. No Main IPC handler or projection is replaced. */
export async function startTopicFixtureStorage(application: ElectronApplication, databasePath: string): Promise<void> {
  await application.evaluate(async ({ app, utilityProcess }, databasePath) => {
    if (!databasePath.includes('worldlinebox-topic-ui-') || !databasePath.endsWith('messages.sqlite')) throw Error('Unexpected fixture database.');
    const child = utilityProcess.fork(app.getAppPath() + '/.vite/build/companion_worker.js', [], { serviceName: 'WorldlineBox Topic UI Acceptance', stdio: 'pipe' });
    child.stdout?.resume(); child.stderr?.resume();
    let sequence = 0, finishClose: (() => void) | undefined;
    const pending = new Map<string, { resolve(value: CompanionStorageResponse): void; reject(error: Error): void }>();
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Actual topic fixture initialization timed out.')), 15000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timeout); for (const task of pending.values()) task.reject(Error('Actual fixture exited: ' + code)); pending.clear(); finishClose?.(); });
      child.on('message', (input: unknown) => {
        const message = input as { type?: string; requestId?: string; response?: CompanionStorageResponse; error?: string };
        if (message.type === 'storage.booted') child.postMessage({ type: 'storage.initialize', databasePath });
        else if (message.type === 'storage.ready') { clearTimeout(timeout); resolve(); }
        else if (message.type === 'storage.failed') { clearTimeout(timeout); reject(Error(message.error)); }
        else if (message.type === 'storage.closed') finishClose?.();
        else if (message.requestId && message.response) { pending.get(message.requestId)?.resolve(message.response); pending.delete(message.requestId); }
      });
    });
    (globalThis as FixtureHost).topicAcceptanceStorage = {
      request: async command => { await ready; const requestId = 'topic_ui_' + ++sequence; return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); child.postMessage({ requestId, command }); }); },
      close: async () => { await ready; await new Promise<void>(resolve => { const timeout = setTimeout(() => { child.kill(); resolve(); }, 2000); finishClose = () => { clearTimeout(timeout); resolve(); }; child.postMessage({ type: 'storage.close' }); }); },
    };
    await ready;
  }, databasePath);
}
export async function topicFixtureStorage(application: ElectronApplication, command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
  const result = await application.evaluate(async (_, command) => {
    const worker = (globalThis as FixtureHost).topicAcceptanceStorage; if (!worker) throw Error('Actual fixture unavailable.'); return worker.request(command);
  }, command);
  if (!result.ok) throw Error(result.error); return result;
}
export async function closeTopicFixtureStorage(application: ElectronApplication): Promise<void> {
  await application.evaluate(async () => (globalThis as FixtureHost).topicAcceptanceStorage?.close());
}
