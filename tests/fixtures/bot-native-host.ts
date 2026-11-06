import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { InstanceService } from '../../src/main/dsh/instance-service';
import type { DshHostStartupProgress } from '../../src/main/dsh/instance-service';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { OperationStore } from '../../src/main/dsh/operations';
import { dshRuntimeSchema } from '../../src/shared/dsh-launcher';
import { removeAcceptanceRoot, type AcceptanceOwnedInstance } from '../../scripts/bot-acceptance-cleanup-lib.mjs';

/** Real installed CLI and Host in a fresh profile. No old companion service,
 * borrowed user history, global credentials or fabricated native events. */
export async function createBotNativeHost(program: string, options?: {
  verifyRuntime?(signal?: AbortSignal): Promise<void>;
  onStartup?(progress: DshHostStartupProgress): void;
}) {
  const plan = { ...canonicalRuntimeEntryPaths(program), env: {} };
  const manifest = JSON.parse(await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  const runtime = dshRuntimeSchema.parse({ id: 'runtime-bot-acceptance', version: manifest.version, nodeVersion: '24', platform: 'win32-x64',
    adapter: 'node-cli-web-v1', source: program, sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: new Date().toISOString(), fileCount: 0, byteLength: 0 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-host-'));
  await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'native-host-fixture', ownerPid: process.pid }));
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const instances = new InstanceService({ rootPath: root, bridgePackagePath: path.resolve('resources/dsh-bridge'), operations,
    runtimes: { list: () => [runtime], get: () => runtime, directory: () => program, plan: () => plan,
      verify: async (_id, signal) => { await options?.verifyRuntime?.(signal); } },
    onStartup: options?.onStartup,
    onChanged: () => undefined, openWorkbench: async () => undefined, closeWorkbench: async () => undefined, clearBrowserData: async () => undefined });
  await instances.init(); const instance = await instances.create('Bot native acceptance', runtime.id);
  let closed = false;
  return { root, instances, instance, runtimeVersion: manifest.version,
    close: async (expectedInstances?: readonly AcceptanceOwnedInstance[]) => {
      if (closed) return; closed = true;
      await instances.shutdown(); await operations.shutdown();
      try { await removeAcceptanceRoot(root, process.pid, expectedInstances); }
      catch (error) {
        process.stderr.write(JSON.stringify({ kind: 'bot-native-cleanup-retained', root: path.basename(root), reason: error instanceof Error ? error.message : 'Cleanup could not verify process termination.' }) + '\n');
        throw error;
      }
    } };
}
