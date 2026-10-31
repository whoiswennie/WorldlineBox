import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

app.disableHardwareAcceleration();
async function main() {
  const configuration = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { root: string; workerPath: string; reportPath: string };
  const root = path.resolve(configuration.root);
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-companion-utility-')) throw new Error('Unexpected isolated UtilityProcess fixture path.');
  await mkdir(path.join(root, 'electron-profile'), { recursive: true });
  app.setPath('userData', path.join(root, 'electron-profile'));
  let client: CompanionStorageClient | undefined;
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  const request = async (command: CompanionStorageCommand) => {
    if (!client) throw new Error('Actual storage client unavailable.');
    const response = await client.request(command); if (!response.ok) throw new Error(response.error); return response;
  };
  const connect = async () => { client = new CompanionStorageClient(configuration.workerPath, databasePath); await client.start(); };
  const disconnect = async () => { const current = client; client = undefined; await current?.close(); };
  const create = async (name: string) => {
    const operationId = randomUUID(), companionId = randomUUID();
    const prepared = await request({ type: 'companion.creation.prepare', operationId, companionId, request: { kind: 'custom', companion: {
      name, description: 'Isolated real UtilityProcess fixture.', persona: 'Form beliefs from authorized evidence.', model: '', avatar: 'custom', proactive: false,
    } } });
    if (prepared.creation?.state !== 'prepared' || !prepared.companion) throw new Error('Actual creation preparation failed.');
    const profiles = new CompanionAssetProfileStore(path.join(root, 'owner-files'), { registryStorage: { request } });
    await profiles.bootstrap(prepared.companion);
    const committed = await request({ type: 'companion.creation.commit', operationId });
    if (committed.creation?.state !== 'committed') throw new Error('Actual published creation failed.');
    return { operationId, companionId };
  };
  async function run() {
    await connect();
    if ((await request({ type: 'state' })).state?.companions.length) throw new Error('An empty protocol database unexpectedly instantiated templates.');
    const owner = await create('Retiring owner'), other = await create('Independent owner');
    const room = (await request({ type: 'conversation.open', companionId: owner.companionId })).conversation!;
    const otherRoom = (await request({ type: 'conversation.open', companionId: other.companionId })).conversation!;
    const ownSource = (await request({ type: 'message.append', message: { conversationId: room.id, authorId: 'user', content: 'PRIVATE_OWNER_SOURCE', replyDirective: 'none' } })).message!;
    const otherSource = (await request({ type: 'message.append', message: { conversationId: otherRoom.id, authorId: 'user', content: 'OTHER_OWNER_RETAINED', replyDirective: 'none' } })).message!;
    const begun = await request({ type: 'companion.retire', id: owner.companionId, scope: 'all' });
    if (begun.reset?.phase !== 'stopping') throw new Error('Actual worker skipped the durable stop boundary.');
    await request({ type: 'companion.retire.cleanup-failed', id: owner.companionId, jobId: begun.reset.id, error: 'Controlled stop acknowledgement interruption.' });
    await disconnect();
    await connect();
    const restored = (await request({ type: 'companion.retire.status', id: owner.companionId })).reset!;
    if (restored.id !== begun.reset.id || restored.status !== 'failed' || restored.phase !== 'stopping') throw new Error('Actual worker did not retain the same interrupted retirement.');
    if ((await request({ type: 'message.get', id: ownSource.id })).message?.content !== ownSource.content) throw new Error('The worker erased sources before stop acknowledgement.');
    await request({ type: 'companion.retire', id: owner.companionId, scope: 'all' });
    await request({ type: 'companion.retire.cleanup', id: owner.companionId, jobId: restored.id });
    // No direct store.advanceReset call: production worker notifications and its
    // setImmediate scheduler must recognize the new retire command prefix.
    const deadline = Date.now() + 10000; let completed = false;
    while (Date.now() < deadline) {
      const job = (await request({ type: 'companion.retire.status', id: owner.companionId })).reset;
      if (job?.status === 'failed') throw new Error(job.error);
      if (job?.status === 'completed') { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!completed) throw new Error('Actual worker never advanced retirement after the cleanup command.');
    const state = (await request({ type: 'state' })).state!;
    if (state.companions.some(item => item.id === owner.companionId) || !state.companions.some(item => item.id === other.companionId)) throw new Error('Actual retirement crossed identity boundaries.');
    if ((await request({ type: 'messages', conversationId: room.id })).messages?.length) throw new Error('Actual retirement retained private messages.');
    if ((await request({ type: 'message.get', id: otherSource.id })).message?.content !== otherSource.content) throw new Error('Actual retirement removed another owner source.');
    const rejected = await client!.request({ type: 'conversation.open', companionId: owner.companionId });
    if (rejected.ok) throw new Error('Actual worker resurrected a retired identity.');
    await disconnect();
    await connect();
    const afterRestart = (await request({ type: 'state' })).state!;
    if (afterRestart.companions.some(item => item.id === owner.companionId)) throw new Error('Actual worker startup restored a retired identity.');
    return { electronVersion: process.versions.electron, ready: app.isReady(), runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1', windows: BrowserWindow.getAllWindows().length,
      initializedEmpty: true, createdWithPublication: true, restartedDuringStopping: true, sameRetirementId: true, autoAdvanceAfterCleanup: completed,
      oldIdentityAbsentAfterRestart: true, otherOwnerPreserved: true, retiredId: owner.companionId, retainedId: other.companionId };
  }
  await app.whenReady();
  try { const report = await run(); await disconnect(); await writeFile(configuration.reportPath, JSON.stringify(report)); app.exit(0); }
  catch (error) { await disconnect(); await writeFile(configuration.reportPath, JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })); app.exit(1); }
}
void main().catch(error => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); app.exit(1); });
