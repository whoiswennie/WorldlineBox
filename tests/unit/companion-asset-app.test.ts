import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createCompanionAssetApp } from '../fixtures/companion-asset-app';
import { McpClientCredentialStore } from '../../src/main/mcp-client-credentials';
import { companionAssetArgumentsSchema } from '../../src/shared/companion-apps';

it('starts the existing MCP automatically and creates, imports and searches real libraries without credentials or desktop clicks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-app-assets-'));
  const fixture = await createCompanionAssetApp(root), scope = { companionId: 'alice', companionName: 'Alice', conversationId: 'chat', topicId: 'topic' }, signal = AbortSignal.timeout(60_000);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await fixture.app.execute(scope, { action: 'call', name, arguments: args }, signal) as { isError?: boolean; structuredContent: { ok: boolean; result: Record<string, unknown> }; content: unknown };
    expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(result.structuredContent.ok, JSON.stringify(result)).toBe(true);
    return result.structuredContent.result;
  };
  try {
    expect(fixture.server.snapshot().runtime.status).toBe('stopped');
    await expect(fixture.app.execute(scope, { action: 'tools', query: '', offset: 0, limit: 5 }, signal)).rejects.toThrow('先在');
    expect(fixture.server.snapshot().runtime.status).toBe('stopped');
    await Promise.all([fixture.app.connect(scope, signal), fixture.app.connect(scope, signal)]);
    expect(fixture.server.snapshot().runtime.status).toBe('running'); expect(fixture.server.snapshot().credentials).toHaveLength(1);
    const catalog = await fixture.app.execute(scope, { action: 'tools', query: 'library_create', offset: 0, limit: 5 }, signal);
    expect(JSON.stringify(catalog)).toContain('worldlinebox_library_create'); expect(JSON.stringify(catalog)).not.toContain('inputSchema');
    const described = await fixture.app.execute(scope, { action: 'describe', names: ['worldlinebox_library_create'] }, signal); expect(JSON.stringify(described)).toContain('selectedParentPath');
    const parent = path.join(root, 'user-selected'); await mkdir(parent);
    const created = await call('worldlinebox_library_create', { displayName: '伙伴资料', selectedParentPath: parent, idempotencyKey: 'create-once' });
    const libraryId = created.libraryId as string; expect(libraryId).toBeTruthy();
    const library = fixture.libraries.listLibraries().find(item => item.libraryId === libraryId)!; expect(path.dirname(library.libraryPath)).toBe(parent);
    const sources = [path.join(root, '项目需求.md'), path.join(root, '研究笔记.txt')]; await Promise.all(sources.map((file, index) => writeFile(file, 'Owned application task ' + index)));
    const imported = await call('worldlinebox_file_import', { libraryId, sourceKind: 'files', sourcePaths: sources, idempotencyKey: 'import-once' }); expect(imported.status).toBe('completed');
    const listed = await call('worldlinebox_asset_search', { libraryId, query: '项目', offset: 0, limit: 20 }); expect(JSON.stringify(listed)).toContain('项目需求');
    expect(fixture.libraries.listLibraries()).toHaveLength(1);
    await fixture.server.stop();
    expect((await call('worldlinebox_library_list_open', {})).libraries).toHaveLength(1);
    expect(fixture.server.snapshot().credentials).toHaveLength(1);
    const stored = JSON.parse(await readFile(path.join(root, 'mcp-client-credentials.json'), 'utf8'));
    expect(stored.credentials[0].tokenCiphertext).toBeTruthy(); expect(JSON.stringify(stored)).not.toContain('Bearer');
    const reopened = new McpClientCredentialStore(root);
    expect(reopened.managedConnection('companion-assets:alice', 'Alice', false).credentialId).toBe(fixture.server.snapshot().credentials[0]!.credentialId);
    const credential = fixture.server.snapshot().credentials[0]!; await fixture.server.revokeCredential(credential.credentialId);
    await expect(call('worldlinebox_library_list_open', {})).rejects.toThrow('撤销');
    await fixture.app.connect(scope, signal); expect((await call('worldlinebox_library_list_open', {})).libraries).toHaveLength(1);
    const evidence = path.resolve('artifacts/companion-apps'); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'mcp-result.json'), JSON.stringify({ passed: true, actualMcpHttp: true, actualPermissionBroker: true, actualWorkerHandlers: true, createdLibrary: library.libraryPath, importedFiles: sources.length, stoppedServiceReconnected: true, credentialRevocationRespected: true }, null, 2));
  } finally { await fixture.close(); }
}, 90_000);

it('rejects invalid app calls before dispatch', () => {
  expect(companionAssetArgumentsSchema.safeParse({ action: 'call', name: '', arguments: {} }).success).toBe(false);
});
