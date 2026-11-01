import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCompanionLibraryAdmission, readCompanionWorkspaceStatus, type CompanionWorkspaceSelection } from '../../src/main/companions/workspace';
import type { LibraryWorkerClient } from '../../src/main/worker-client';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';

const selected: CompanionWorkspaceSelection = { libraryId: 'selected-library', displayName: '真正选择的资料库', libraryPath: path.resolve('fixture-library'),
  dataRoot: path.resolve('fixture-library/.worldlinebox/companions'), memoryRoot: path.resolve('fixture-library/伙伴记忆') };
const library = { libraryId: selected.libraryId, displayName: selected.displayName, libraryPath: selected.libraryPath };
const rootFolder = { folderId: 'memory-root', displayName: '伙伴记忆', status: 'available' as const, assetCount: 0,
  absoluteRootPath: selected.memoryRoot, linkedFolderId: 'memory-root', relativePath: '' };
const roots: WorkerResult = { ok: true, type: 'linked-folder.list', folders: [rootFolder] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

it('returns only the verified locator immediately while a cold admission is pending, and shares that exact in-flight work with the foreground', async () => {
  const list = deferred<WorkerResult>(), opened = vi.fn(), catalog = vi.fn(async () => [library]);
  const request = vi.fn<LibraryWorkerClient['request']>(async command => {
    if (command.type === 'library.list') return list.promise;
    if (command.type === 'linked-folder.list') return roots;
    throw new Error('Unexpected domain request: ' + command.type);
  });
  const admission = createCompanionLibraryAdmission({ worker: () => ({ request }), isClosing: () => false, opened });
  let pending: Promise<void> | undefined;
  const status = await readCompanionWorkspaceStatus({ current: async () => selected }, false, { libraries: catalog, beginAdmission: value => { pending = admission.ensure(value); } });
  expect(status).toEqual({ ok: true, selected }); expect(status).not.toHaveProperty('libraries'); expect(status).not.toHaveProperty('companions');
  expect(catalog).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'library.list' });
  const foreground = admission.ensure(selected); expect(foreground).toBe(pending);
  list.resolve({ ok: true, type: 'library.list', libraries: [library] }); await foreground;
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['library.list', 'linked-folder.list']);
  await admission.ensure(selected); expect(request.mock.calls.map(([command]) => command.type)).toEqual(['library.list', 'linked-folder.list', 'library.list', 'linked-folder.list']);
});

it('keeps the legacy catalog request explicit and does not prime when a catalog was requested', async () => {
  expect(companionWorkspaceRequestSchema.parse({ type: 'status' })).toEqual({ type: 'status' });
  expect(companionWorkspaceRequestSchema.parse({ type: 'status', includeLibraries: false })).toEqual({ type: 'status', includeLibraries: false });
  expect(() => companionWorkspaceRequestSchema.parse({ type: 'status', includeLibraries: false, authorizeAgent: true })).toThrow();
  const list = deferred<typeof library[]>(), catalog = vi.fn(() => list.promise), beginAdmission = vi.fn();
  let complete = false;
  const pending = readCompanionWorkspaceStatus({ current: async () => selected }, true, { libraries: catalog, beginAdmission }).then(value => { complete = true; return value; });
  await Promise.resolve(); expect(complete).toBe(false); expect(catalog).toHaveBeenCalledOnce(); expect(beginAdmission).not.toHaveBeenCalled();
  list.resolve([library]); expect(await pending).toEqual({ ok: true, selected, libraries: [library] });
});

it('loads the picker catalog for an unselected workspace and does not admit an invalid locator', async () => {
  const libraries = vi.fn(async () => [library]), beginAdmission = vi.fn();
  expect(await readCompanionWorkspaceStatus({ current: async () => undefined }, false, { libraries, beginAdmission })).toEqual({ ok: true, selected: undefined, libraries: [library] });
  expect(beginAdmission).not.toHaveBeenCalled(); libraries.mockClear();
  await expect(readCompanionWorkspaceStatus({ current: async () => { throw new Error('unsafe locator'); } }, false, { libraries, beginAdmission })).rejects.toThrow('unsafe locator');
  expect(libraries).not.toHaveBeenCalled(); expect(beginAdmission).not.toHaveBeenCalled();
});

it.each(['library.list', 'library.open', 'linked-folder.list', 'asset.import-linked'] as const)(
  'stops after an already dispatched %s when the application closes, without issuing another Worker request', async heldType => {
    const gate = deferred<WorkerResult>(), reached = deferred<void>(); let closing = false;
    const result = (type: string): WorkerResult => type === 'library.list' ? { ok: true, type: 'library.list', libraries: [] }
      : type === 'library.open' ? { ok: true, type: 'library.opened', library }
        : type === 'linked-folder.list' ? { ok: true, type: 'linked-folder.list', folders: [] }
          : { ok: true, type: 'asset.import-linked.completed', linkedFolder: rootFolder };
    const request = vi.fn<LibraryWorkerClient['request']>(async command => {
      if (command.type === heldType) { reached.resolve(); return gate.promise; }
      return result(command.type);
    });
    const opened = vi.fn(), admission = createCompanionLibraryAdmission({ worker: () => ({ request }), isClosing: () => closing, opened });
    const pending = admission.ensure(selected), rejected = expect(pending).rejects.toThrow('准入已停止');
    await reached.promise; const requestsBeforeClose = request.mock.calls.length; closing = true; gate.resolve(result(heldType)); await rejected;
    expect(request).toHaveBeenCalledTimes(requestsBeforeClose); if (heldType === 'library.list' || heldType === 'library.open') expect(opened).not.toHaveBeenCalled();
    await expect(admission.ensure(selected)).rejects.toThrow('准入已停止'); expect(request).toHaveBeenCalledTimes(requestsBeforeClose);
  });

it.each(['library.list', 'library.open'] as const)(
  'does not publish an old selection or clear a new admission after switching during %s', async heldType => {
    const gate = deferred<WorkerResult>(), reached = deferred<void>(), newGate = deferred<WorkerResult>(), next = { ...selected, libraryId: 'another-library', displayName: '另一个真实库' };
    let newSelection = false;
    const request = vi.fn<LibraryWorkerClient['request']>(async command => {
      if (command.type === 'library.list') {
        if (newSelection) return newGate.promise;
        if (heldType === 'library.list') { reached.resolve(); return gate.promise; }
        return { ok: true, type: 'library.list', libraries: [] };
      }
      if (command.type === 'library.open') { reached.resolve(); return gate.promise; }
      if (command.type === 'linked-folder.list') return roots;
      throw new Error('Unexpected post-switch request: ' + command.type);
    });
    const opened = vi.fn(), admission = createCompanionLibraryAdmission({ worker: () => ({ request }), isClosing: () => false, opened });
    const old = admission.ensure(selected), rejected = expect(old).rejects.toThrow('选择发生变化');
    await reached.promise; newSelection = true; admission.invalidate(); const fresh = admission.ensure(next);
    gate.resolve(heldType === 'library.list' ? { ok: true, type: 'library.list', libraries: [] } : { ok: true, type: 'library.opened', library });
    await rejected; expect(opened).not.toHaveBeenCalled(); expect(admission.ensure(next)).toBe(fresh);
    newGate.resolve({ ok: true, type: 'library.list', libraries: [{ ...library, libraryId: next.libraryId }] }); await fresh;
    expect(request.mock.calls.filter(([command]) => command.type === 'linked-folder.list').map(([command]) => command)).toEqual([{ type: 'linked-folder.list', libraryId: next.libraryId }]);
  });

it.each(['read-only', 'wrong-identity'] as const)('rejects %s library admission before it can request memory roots', async reason => {
  const request = vi.fn<LibraryWorkerClient['request']>(async command => {
    if (command.type === 'library.list') return { ok: true, type: 'library.list', libraries: reason === 'read-only' ? [{ ...library, readOnly: true }] : [] };
    if (command.type === 'library.open') return { ok: true, type: 'library.opened', library: { ...library, libraryId: 'unknown-library' } };
    throw new Error('No later request is allowed');
  });
  const opened = vi.fn(), admission = createCompanionLibraryAdmission({ worker: () => ({ request }), isClosing: () => false, opened });
  await expect(admission.ensure(selected)).rejects.toThrow(); expect(opened).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([command]) => command.type === 'linked-folder.list' || command.type === 'asset.import-linked')).toBe(false);
});
