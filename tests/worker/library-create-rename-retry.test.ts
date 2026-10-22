import {
  mkdtempSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LibraryService,
  LibraryServiceError,
} from '../../src/worker/library-service';
import { removePathWithSyncRetry } from '../../src/worker/windows-fs-retry';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
  };
});

const roots: string[] = [];
const services: LibraryService[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-library-create-retry-'));
  roots.push(root);
  return root;
}

function newService(): LibraryService {
  const service = new LibraryService();
  services.push(service);
  return service;
}

function permissionError(): NodeJS.ErrnoException {
  const error = new Error('simulated transient rename lock') as NodeJS.ErrnoException;
  error.code = 'EPERM';
  return error;
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of roots.splice(0)) removePathWithSyncRetry(root);
  vi.mocked(renameSync).mockClear();
});

describe('library creation publish retry', () => {
  it('retries one transient publish lock and remains writable after reopen', () => {
    const root = temporaryRoot();
    const publishRename = vi.mocked(renameSync);
    publishRename.mockImplementationOnce(() => {
      throw permissionError();
    });

    const creatingService = newService();
    const created = creatingService.createLibrary({
      displayName: 'Retry library',
      selectedParentPath: root,
    });

    expect(publishRename).toHaveBeenCalledTimes(2);
    expect(readdirSync(root)).toEqual(['Retry library']);
    creatingService.closeAll();

    const writer = newService();
    writer.openLibrary(created.libraryPath);
    writer.createTag({ libraryId: created.libraryId, name: 'retry-check' });
    writer.closeAll();

    const reader = newService();
    reader.openLibrary(created.libraryPath);
    expect(reader.listTags(created.libraryId).map((tag) => tag.name)).toEqual(['retry-check']);
  });

  it('preserves the public error mapping and removes the partial tree after bounded retries', () => {
    const root = temporaryRoot();
    const publishRename = vi.mocked(renameSync);
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      publishRename.mockImplementationOnce(() => {
        throw permissionError();
      });
    }

    let thrown: unknown;
    try {
      newService().createLibrary({
        displayName: 'Blocked library',
        selectedParentPath: root,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LibraryServiceError);
    expect((thrown as LibraryServiceError).code).toBe('LIBRARY_NOT_WRITABLE');
    expect(['FILE_BUSY', 'PERMISSION_DENIED']).toContain((thrown as LibraryServiceError).reason);
    expect(publishRename).toHaveBeenCalledTimes(5);
    expect(readdirSync(root)).toEqual([]);
  });
});
