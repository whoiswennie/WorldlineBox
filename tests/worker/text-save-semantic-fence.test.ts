import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { WorkerCommand, WorkerRequest } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { LibraryService, openConfiguredDatabase } from '../../src/worker/library-service';
import { invalidateSavedTextSemanticContent, SEMANTIC_SCHEMA_VERSION, SemanticIndexStore } from '../../src/worker/semantic-index-store';
import { closeSemanticIndexWorkerLibrary, executeSemanticIndexWorkerCommand } from '../../src/worker/handlers/semantic-index';
import { importNoConflict } from './import-no-conflict';

const roots: string[] = [];
const services: LibraryService[] = [];
afterEach(async () => {
  await closeSemanticIndexWorkerLibrary();
  for (const service of services.splice(0)) service.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['linked', 'managed'] as const)('fences stale %s text vectors after an in-place save and preserves other vectors', async (kind) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-text-semantic-034-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, 'note.txt'), 'original');
  writeFileSync(path.join(sourceRoot, 'untouched.txt'), 'untouched');
  const service = new LibraryService({ observerFactory: () => ({ close() {} }) });
  services.push(service);
  const library = service.createLibrary({ displayName: 'Text semantic fence', selectedParentPath: root });
  if (kind === 'linked') {
    service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: sourceRoot });
  } else {
    importNoConflict(service, library.libraryId, path.join(sourceRoot, 'note.txt'));
    importNoConflict(service, library.libraryId, path.join(sourceRoot, 'untouched.txt'));
  }
  const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
  const note = assets.find((asset) => asset.relativeFilePath.endsWith('note.txt'))!;
  const untouched = assets.find((asset) => asset.relativeFilePath.endsWith('untouched.txt'))!;
  const profileKey = 'text-edit-fixture';
  let sessionGeneration = randomUUID();
  const call = async (command: WorkerCommand): Promise<WorkerResult> => {
    const result = await executeSemanticIndexWorkerCommand(service, { requestId: randomUUID(), command } as WorkerRequest,
      { runWithoutAdmission: async (work) => work() });
    if (!result) throw new Error('Unhandled semantic command');
    return result;
  };
  const begin = () => call({ type: 'semantic.index.begin', libraryId: library.libraryId,
    sessionGeneration, profileKey, dimensions: 2, modelRevision: 'fixture-v1', modality: 'text',
    modalities: ['text'], maxInputBytes: 1024 });
  const targets = async () => {
    const result = await call({ type: 'semantic.index.targets', libraryId: library.libraryId,
      sessionGeneration, modalities: ['text'], offset: 0, limit: 20 });
    if (!result.ok || result.type !== 'semantic.index.targets') throw new Error('No target page');
    return result.targets;
  };
  await begin();
  const originalTargets = await targets();
  const priorNote = originalTargets.find((target) => target.assetId === note.assetId)!;
  const claims = new Map<string, string>();
  for (const target of originalTargets) {
    const claimToken = randomUUID();
    claims.set(target.assetId, claimToken);
    expect(await call({ type: 'semantic.index.job', libraryId: library.libraryId,
      sessionGeneration, action: 'claim', assetId: target.assetId,
      sourceRevision: target.sourceRevision, claimToken })).toMatchObject({ updated: true });
  }
  expect(await call({ type: 'semantic.index.write', libraryId: library.libraryId,
    sessionGeneration, profileKey, vectors: originalTargets.map((target) => ({
      assetId: target.assetId, sourceRevision: target.sourceRevision, claimToken: claims.get(target.assetId)!, vector: [1, 0] })) }))
    .toMatchObject({ accepted: expect.arrayContaining([note.assetId, untouched.assetId]) });
  expect((await targets()).every((target) => target.alreadyIndexed)).toBe(true);

  const saved = service.saveTextAsset({ libraryId: library.libraryId, assetId: note.assetId,
    content: 'edited!!', expectedRevisionId: note.currentRevisionId, createRevision: false });
  expect(saved.revisionId).toBe(note.currentRevisionId);
  const after = await targets();
  const nextNote = after.find((target) => target.assetId === note.assetId)!;
  expect(nextNote.alreadyIndexed).toBe(false);
  expect(nextNote.sourceRevision).not.toBe(priorNote.sourceRevision);
  expect(after.find((target) => target.assetId === untouched.assetId)?.alreadyIndexed).toBe(true);
  expect(await call({ type: 'semantic.index.write', libraryId: library.libraryId,
    sessionGeneration, profileKey, vectors: [{ assetId: note.assetId,
      sourceRevision: priorNote.sourceRevision, claimToken: claims.get(note.assetId)!, vector: [1, 0] }] }))
    .toMatchObject({ accepted: [], rejected: [note.assetId] });
  expect(await call({ type: 'semantic.index.prepare', libraryId: library.libraryId,
    sessionGeneration, assetId: note.assetId, sourceRevision: nextNote.sourceRevision,
    kind: 'text', maxInputBytes: 1024 }))
    .toMatchObject({ kind: 'text', text: expect.stringContaining('edited!!') });
  const nextClaim = randomUUID();
  expect(await call({ type: 'semantic.index.job', libraryId: library.libraryId,
    sessionGeneration, action: 'claim', assetId: note.assetId,
    sourceRevision: nextNote.sourceRevision, claimToken: nextClaim })).toMatchObject({ updated: true });
  expect(await call({ type: 'semantic.index.write', libraryId: library.libraryId,
    sessionGeneration, profileKey, vectors: [{ assetId: note.assetId,
      sourceRevision: nextNote.sourceRevision, claimToken: nextClaim, vector: [0, 1] }] }))
    .toMatchObject({ accepted: [note.assetId], rejected: [] });

  await closeSemanticIndexWorkerLibrary(library.libraryId);
  sessionGeneration = randomUUID();
  await begin();
  const reopened = await targets();
  expect(reopened.every((target) => target.alreadyIndexed)).toBe(true);
  expect(reopened.find((target) => target.assetId === note.assetId)?.sourceRevision).toBe(nextNote.sourceRevision);
  const retained = new SemanticIndexStore({ libraryPath: library.libraryPath, libraryId: library.libraryId,
    storageKind: 'local' });
  try {
    expect(retained.textContentGeneration(note.assetId)).not.toBeNull();
    retained.removeAsset(note.assetId);
    expect(retained.textContentGeneration(note.assetId)).toBeNull();
  } finally {
    retained.close();
  }
});


it('leaves absent and future-version semantic sidecars untouched when saving text', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-text-semantic-readonly-'));
  roots.push(root);
  const service = new LibraryService({ observerFactory: () => ({ close() {} }) });
  services.push(service);
  const library = service.createLibrary({ displayName: 'Semantic future version', selectedParentPath: root });
  const source = path.join(root, 'note.txt');
  writeFileSync(source, 'original');
  importNoConflict(service, library.libraryId, source);
  const note = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!;
  const semanticDirectory = path.join(library.libraryPath, '.worldlinebox', 'semantic');
  invalidateSavedTextSemanticContent(library.libraryPath, library.libraryId, note.assetId);
  expect(existsSync(semanticDirectory)).toBe(false);
  const store = new SemanticIndexStore({ libraryPath: library.libraryPath, libraryId: library.libraryId,
    storageKind: 'local' });
  store.close();
  const semanticPath = path.join(semanticDirectory, 'index.sqlite');
  const database = openConfiguredDatabase(semanticPath);
  try {
    database.pragma('user_version = ' + (SEMANTIC_SCHEMA_VERSION + 1));
  } finally {
    database.close();
  }
  const before = readFileSync(semanticPath);
  expect(() => service.saveTextAsset({ libraryId: library.libraryId, assetId: note.assetId,
    content: 'changed', expectedRevisionId: note.currentRevisionId })).toThrow('newer');
  expect(readFileSync(semanticPath)).toEqual(before);
  expect(service.readTextAsset({ libraryId: library.libraryId, assetId: note.assetId }).content).toBe('original');
});
