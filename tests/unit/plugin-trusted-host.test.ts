import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPluginTrustedHostHandler } from '../../src/scripting/plugin-trusted-host';
import {
  WORLDLINEBOX_GUEST_ASSET_METHODS,
  WORLDLINEBOX_GUEST_COLLECTION_METHODS,
  WORLDLINEBOX_GUEST_FILE_METHODS,
  WORLDLINEBOX_GUEST_FOLDER_METHODS,
  WORLDLINEBOX_GUEST_LIBRARY_METHODS,
  WORLDLINEBOX_GUEST_LINKED_FOLDER_METHODS,
  WORLDLINEBOX_GUEST_PALETTE_METHODS,
  WORLDLINEBOX_GUEST_SMART_COLLECTION_METHODS,
  WORLDLINEBOX_GUEST_TAG_METHODS,
  WORLDLINEBOX_GUEST_TRASH_METHODS,
} from '../../src/scripting/worldlinebox-guest-api';
import type { PluginTrustedChildMessage } from '../../src/shared/plugin-trusted-runtime-protocol';
import { pluginTrustedParentMessageSchema } from '../../src/shared/plugin-trusted-runtime-protocol';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function flush(ms = 0): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('plugin-trusted runtime protocol', () => {
  it('requires a package directory for trusted activate', () => {
    const parsed = pluginTrustedParentMessageSchema.parse({
      type: 'plugin-trusted.activate',
      instanceId: '11111111-1111-4111-8111-111111111111',
      libraryId: 'library-1',
      pluginId: 'com.example.trusted',
      version: '1.0.0',
      packageHash: 'a'.repeat(64),
      packageDirectory: '/plugins/trusted',
      entryRelativePath: 'dist/main.js',
      permissions: ['library.read', 'asset.read'],
    });
    expect(parsed.type).toBe('plugin-trusted.activate');
  });
});

describe('Plugin Trusted Host handler', () => {
  it('exposes the shared Guest API Gateway method sets', async () => {
    const packageDirectory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-trusted-guest-api-'));
    roots.push(packageDirectory);
    mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDirectory, 'dist', 'main.js'), `
        let pluginContext;
        exports.setup = async function setup(worldlinebox) {
        pluginContext = worldlinebox;
        worldlinebox.subscriptions.add(() => worldlinebox.console.log('subscription-disposed'));
        worldlinebox.console.log('signal-aborted:' + worldlinebox.signal.aborted);
        worldlinebox.console.log(JSON.stringify({
          assets: Object.keys(worldlinebox.assets).sort(),
          library: Object.keys(worldlinebox.library).sort(),
          folders: Object.keys(worldlinebox.folders).sort(),
          tags: Object.keys(worldlinebox.tags).sort(),
          collections: Object.keys(worldlinebox.collections).sort(),
          smartCollections: Object.keys(worldlinebox.smartCollections).sort(),
          linkedFolders: Object.keys(worldlinebox.linkedFolders).sort(),
          files: Object.keys(worldlinebox.files).sort(),
          trash: Object.keys(worldlinebox.trash).sort(),
          palettes: Object.keys(worldlinebox.palettes).sort()
        }));
      };
      exports.dispose = async function dispose() {
        pluginContext.console.log('dispose-signal-aborted:' + pluginContext.signal.aborted);
      };
    `);

    const posted: PluginTrustedChildMessage[] = [];
    const handler = createPluginTrustedHostHandler({
      postMessage: (message) => posted.push(message),
      heartbeatIntervalMs: 60_000,
    });
    const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    handler.handle({
      type: 'plugin-trusted.activate',
      instanceId,
      libraryId: 'library-1',
      pluginId: 'com.example.guest-api',
      version: '1.0.0',
      packageHash: 'c'.repeat(64),
      packageDirectory,
      entryRelativePath: 'dist/main.js',
      permissions: [],
      activateDeadlineMs: 15_000,
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.activated'); attempt += 1) {
      await flush(10);
    }
    const consoleMessage = posted.find((message) => message.type === 'plugin-trusted.console' && message.message.startsWith('{'));
    expect(consoleMessage?.type).toBe('plugin-trusted.console');
    if (consoleMessage?.type !== 'plugin-trusted.console') throw new Error('missing Guest API probe output');
    expect(JSON.parse(consoleMessage.message)).toEqual({
      assets: [...WORLDLINEBOX_GUEST_ASSET_METHODS].sort(),
      library: [...WORLDLINEBOX_GUEST_LIBRARY_METHODS].sort(),
      folders: [...WORLDLINEBOX_GUEST_FOLDER_METHODS].sort(),
      tags: [...WORLDLINEBOX_GUEST_TAG_METHODS].sort(),
      collections: [...WORLDLINEBOX_GUEST_COLLECTION_METHODS].sort(),
      smartCollections: [...WORLDLINEBOX_GUEST_SMART_COLLECTION_METHODS].sort(),
      linkedFolders: [...WORLDLINEBOX_GUEST_LINKED_FOLDER_METHODS].sort(),
      files: [...WORLDLINEBOX_GUEST_FILE_METHODS].sort(),
      trash: [...WORLDLINEBOX_GUEST_TRASH_METHODS].sort(),
      palettes: [...WORLDLINEBOX_GUEST_PALETTE_METHODS].sort(),
    });
    expect(posted.some((message) => message.type === 'plugin-trusted.console' && message.message === 'signal-aborted:false')).toBe(true);

    handler.handle({
      type: 'plugin-trusted.deactivate',
      instanceId,
      reason: 'library-closed',
    });
    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.deactivated'); attempt += 1) {
      await flush(10);
    }
    expect(posted.some((message) => message.type === 'plugin-trusted.console' && message.message === 'subscription-disposed')).toBe(true);
    expect(posted.some((message) => message.type === 'plugin-trusted.console' && message.message === 'dispose-signal-aborted:true')).toBe(true);
    handler.dispose();
  }, 20_000);

  it('binds trusted jobs to the same explicit forLibrary target as domain calls', async () => {
    const packageDirectory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-trusted-targeted-jobs-'));
    roots.push(packageDirectory);
    mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDirectory, 'dist', 'main.js'), `
      exports.setup = async function setup(worldlinebox) {
        const scoped = worldlinebox.forLibrary('library-2');
        await scoped.jobs.enqueue({ handlerId: 'tick', payload: { tick: 2 } });
        await scoped.jobs.reportProgress({ jobId: '88888888-8888-4888-8888-888888888888', completed: 1, total: 2 });
        await scoped.jobs.cancel({ jobId: '88888888-8888-4888-8888-888888888888', reason: 'stop' });
      };
      exports.dispose = async function dispose() {};
    `);
    const posted: PluginTrustedChildMessage[] = [];
    const handler = createPluginTrustedHostHandler({
      postMessage: (message) => posted.push(message),
      heartbeatIntervalMs: 60_000,
    });
    const instanceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    handler.handle({
      type: 'plugin-trusted.activate',
      instanceId,
      libraryId: '__worldlinebox_global_runtime__',
      instanceScope: 'global',
      pluginId: 'com.example.targeted-jobs',
      version: '1.0.0',
      packageHash: 'e'.repeat(64),
      packageDirectory,
      entryRelativePath: 'dist/main.js',
      permissions: ['job.manage'],
      activateDeadlineMs: 15_000,
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.job-enqueue'); attempt += 1) {
      await flush(10);
    }
    const enqueueMessage = posted.find((message) => message.type === 'plugin-trusted.job-enqueue');
    expect(enqueueMessage).toMatchObject({ targetLibraryId: 'library-2', handlerId: 'tick' });
    if (enqueueMessage?.type !== 'plugin-trusted.job-enqueue') throw new Error('missing targeted trusted job enqueue');
    handler.handle({
      type: 'plugin-trusted.job-enqueue-result',
      instanceId,
      requestId: enqueueMessage.requestId,
      ok: true,
      result: { jobId: '88888888-8888-4888-8888-888888888888' },
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.job-progress'); attempt += 1) {
      await flush(10);
    }
    expect(posted).toContainEqual(expect.objectContaining({
      type: 'plugin-trusted.job-progress',
      targetLibraryId: 'library-2',
      jobId: '88888888-8888-4888-8888-888888888888',
    }));
    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.job-control'); attempt += 1) {
      await flush(10);
    }
    const controlMessage = posted.find((message) => message.type === 'plugin-trusted.job-control');
    expect(controlMessage).toMatchObject({
      targetLibraryId: 'library-2',
      jobId: '88888888-8888-4888-8888-888888888888',
      action: 'cancel',
      reason: 'stop',
    });
    if (controlMessage?.type !== 'plugin-trusted.job-control') throw new Error('missing targeted trusted job control');
    handler.handle({
      type: 'plugin-trusted.job-control-result',
      instanceId,
      requestId: controlMessage.requestId,
      ok: true,
      job: null,
    });
    handler.handle({ type: 'plugin-trusted.deactivate', instanceId, reason: 'library-closed' });
    handler.dispose();
  }, 20_000);

  it('loads a CommonJS entry from a package directory and parks until deactivate', async () => {
    const packageDirectory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-trusted-plugin-'));
    roots.push(packageDirectory);
    mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDirectory, 'dist', 'main.js'), `
      let bridge;
      exports.setup = async function setup(worldlinebox) {
        bridge = worldlinebox;
        await worldlinebox.assets.search({ query: null, limit: 1 });
      };
      exports.dispose = async function dispose(reason) {
        bridge.console.log('disposed:' + reason);
      };
    `);

    const posted: PluginTrustedChildMessage[] = [];
    const handler = createPluginTrustedHostHandler({
      postMessage: (message) => {
        posted.push(message);
      },
      heartbeatIntervalMs: 60_000,
    });
    const instanceId = '11111111-1111-4111-8111-111111111111';
    handler.handle({
      type: 'plugin-trusted.activate',
      instanceId,
      libraryId: 'library-1',
      pluginId: 'com.example.trusted',
      version: '1.0.0',
      packageHash: 'a'.repeat(64),
      packageDirectory,
      entryRelativePath: 'dist/main.js',
      permissions: ['library.read', 'asset.read'],
      activateDeadlineMs: 15_000,
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.host-command'); attempt += 1) {
      await flush(10);
    }
    const hostCommand = posted.find((message) => message.type === 'plugin-trusted.host-command');
    expect(hostCommand).toMatchObject({
      type: 'plugin-trusted.host-command',
      commandId: 'asset.search',
    });
    if (hostCommand?.type !== 'plugin-trusted.host-command') throw new Error('missing host command');

    handler.handle({
      type: 'plugin-trusted.host-result',
      instanceId,
      requestId: hostCommand.requestId,
      ok: true,
      result: { items: [], total: 0, offset: 0, limit: 1, hasMore: false },
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.activated'); attempt += 1) {
      await flush(10);
    }
    expect(posted.some((message) => message.type === 'plugin-trusted.activated')).toBe(true);

    handler.handle({
      type: 'plugin-trusted.deactivate',
      instanceId,
      reason: 'library-closed',
    });
    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.deactivated'); attempt += 1) {
      await flush(10);
    }
    expect(posted.some((message) => (
      message.type === 'plugin-trusted.deactivated' && message.reason === 'library-closed'
    ))).toBe(true);
    expect(posted.some((message) => (
      message.type === 'plugin-trusted.console' && message.message === 'disposed:library-closed'
    ))).toBe(true);
    handler.dispose();
  }, 20_000);

  it('rejects a pending Host call during deactivation before disposing with its reason', async () => {
    const packageDirectory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-trusted-pending-plugin-'));
    roots.push(packageDirectory);
    mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDirectory, 'dist', 'main.js'), `
      let bridge;
      exports.setup = async function setup(worldlinebox) {
        bridge = worldlinebox;
        void worldlinebox.assets.search({ query: null, limit: 1 }).catch((error) => {
          bridge.console.log('pending:' + error.message);
        });
      };
      exports.dispose = async function dispose(reason) {
        bridge.console.log('disposed:' + reason);
      };
    `);

    const posted: PluginTrustedChildMessage[] = [];
    const handler = createPluginTrustedHostHandler({
      postMessage: (message) => posted.push(message),
      heartbeatIntervalMs: 60_000,
    });
    const instanceId = '12111111-1111-4111-8111-111111111111';
    handler.handle({
      type: 'plugin-trusted.activate',
      instanceId,
      libraryId: 'library-1',
      pluginId: 'com.example.trusted.pending',
      version: '1.0.0',
      packageHash: 'a'.repeat(64),
      packageDirectory,
      entryRelativePath: 'dist/main.js',
      permissions: ['library.read', 'asset.read'],
      activateDeadlineMs: 15_000,
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.activated'); attempt += 1) {
      await flush(10);
    }
    expect(posted.some((message) => message.type === 'plugin-trusted.host-command')).toBe(true);

    handler.handle({ type: 'plugin-trusted.deactivate', instanceId, reason: 'library-closed' });
    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.deactivated'); attempt += 1) {
      await flush(10);
    }
    expect(posted.some((message) => message.type === 'plugin-trusted.console' && message.message === 'pending:The trusted plugin instance was deactivated.')).toBe(true);
    expect(posted.some((message) => message.type === 'plugin-trusted.console' && message.message === 'disposed:library-closed')).toBe(true);
    handler.dispose();
  }, 20_000);

  it('exposes bounded content read and replacement through the Gateway bridge', async () => {
    const packageDirectory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-trusted-content-plugin-'));
    roots.push(packageDirectory);
    mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDirectory, 'dist', 'main.js'), `
        exports.setup = async function setup(worldlinebox) {
        await worldlinebox.assets.readContent('asset-1', { maxBytes: 4 });
        await worldlinebox.assets.replaceContent('asset-1', 'AQID', { expectedRevisionId: 'revision-1' });
      };
        exports.dispose = async function dispose() {};
    `);

    const posted: PluginTrustedChildMessage[] = [];
    const handler = createPluginTrustedHostHandler({
      postMessage: (message) => {
        posted.push(message);
      },
      heartbeatIntervalMs: 60_000,
    });
    const instanceId = '77777777-7777-4777-8777-777777777777';
    handler.handle({
      type: 'plugin-trusted.activate',
      instanceId,
      libraryId: 'library-1',
      pluginId: 'com.example.content',
      version: '1.0.0',
      packageHash: 'b'.repeat(64),
      packageDirectory,
      entryRelativePath: 'dist/main.js',
      permissions: ['library.read', 'asset.read', 'content.read', 'content.write'],
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => (
      message.type === 'plugin-trusted.host-command' && message.commandId === 'asset.content.read'
    )); attempt += 1) {
      await flush(10);
    }
    const readCommand = posted.find((message) => (
      message.type === 'plugin-trusted.host-command' && message.commandId === 'asset.content.read'
    ));
    expect(readCommand).toMatchObject({
      commandId: 'asset.content.read',
      input: { assetId: 'asset-1', maxBytes: 4 },
    });
    if (readCommand?.type !== 'plugin-trusted.host-command') throw new Error('missing content read');
    handler.handle({
      type: 'plugin-trusted.host-result',
      instanceId,
      requestId: readCommand.requestId,
      ok: true,
      result: {
        assetId: 'asset-1',
        revisionId: 'revision-1',
        byteSize: 8,
        dataBase64: 'AQIDBA==',
        truncated: true,
        mimeType: 'image/png',
      },
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => (
      message.type === 'plugin-trusted.host-command' && message.commandId === 'asset.content.replace'
    )); attempt += 1) {
      await flush(10);
    }
    const replaceCommand = posted.find((message) => (
      message.type === 'plugin-trusted.host-command' && message.commandId === 'asset.content.replace'
    ));
    expect(replaceCommand).toMatchObject({
      commandId: 'asset.content.replace',
      input: { assetId: 'asset-1', dataBase64: 'AQID', expectedRevisionId: 'revision-1' },
    });
    if (replaceCommand?.type !== 'plugin-trusted.host-command') throw new Error('missing content replace');
    handler.handle({
      type: 'plugin-trusted.host-result',
      instanceId,
      requestId: replaceCommand.requestId,
      ok: true,
      result: { assetId: 'asset-1', revisionId: 'revision-2', byteSize: 3 },
    });

    for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === 'plugin-trusted.activated'); attempt += 1) {
      await flush(10);
    }
    expect(posted.some((message) => message.type === 'plugin-trusted.activated')).toBe(true);
    handler.handle({
      type: 'plugin-trusted.deactivate',
      instanceId,
      reason: 'library-closed',
    });
    handler.dispose();
  }, 20_000);
});
