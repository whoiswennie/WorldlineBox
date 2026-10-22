import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  McpClientCredentialStore,
  McpCredentialStoreError,
  buildPepperFileAccessRepairArgs,
  buildPepperFileAclArgs,
  parseCurrentUserSid,
  readOrCreatePepper,
  readExistingPepper,
} from '../../src/main/mcp-client-credentials';

describe('MCP credential pepper ACL hardening (WorldlineBox-8b5b.7)', () => {
  it('builds an inheritance-free, current-user-only icacls command shape', () => {
    const sid = 'S-1-5-18';
    expect(buildPepperFileAclArgs('pepper', sid)).toEqual([
      'pepper',
      '/inheritance:r',
      '/grant:r',
      `*${sid}:F`,
    ]);
  });

  it('uses an explicit SID when repairing an existing file without resetting other ACEs', () => {
    const sid = 'S-1-5-18';
    expect(buildPepperFileAccessRepairArgs('pepper', sid)).toEqual([
      'pepper',
      '/grant:r',
      `*${sid}:F`,
    ]);
  });

  it('parses the current user SID from whoami CSV output', () => {
    expect(parseCurrentUserSid('"SID"\r\n"S-1-5-18"')).toBe('S-1-5-18');
    expect(() => parseCurrentUserSid('no SID present')).toThrow('Could not determine');
  });

  it('creates a new pepper only when the file is actually missing', () => {
    const readFile = vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const repairAccess = vi.fn();

    expect(readExistingPepper('pepper', { platform: 'win32', readFile, repairAccess })).toBeUndefined();
    expect(repairAccess).not.toHaveBeenCalled();
  });

  it('repairs Windows access and returns the exact existing key bytes', () => {
    const key = Buffer.alloc(32, 0x6a);
    let reads = 0;
    const repairAccess = vi.fn();
    const readFile = vi.fn(() => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('access denied'), { code: 'EPERM' });
      return Buffer.from(key);
    });

    expect(readExistingPepper('pepper', { platform: 'win32', readFile, repairAccess })).toEqual(key);
    expect(repairAccess).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('surfaces the original and ACL repair errors without replacing an unreadable key', () => {
    const repairAccess = vi.fn(() => {
      throw Object.assign(new Error('ACL update failed'), { code: '5' });
    });
    const readFile = vi.fn(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' });
    });

    let failure: unknown;
    try {
      readExistingPepper('pepper', { platform: 'win32', readFile, repairAccess });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(McpCredentialStoreError);
    expect(failure).toMatchObject({
      code: 'MCP_CREDENTIAL_ACCESS_DENIED',
      filePath: 'pepper',
      systemCode: 'EPERM',
      recoveryCode: '5',
    });
    expect(readFile).toHaveBeenCalledOnce();
  });

  it('does not try Windows ACL recovery on other platforms', () => {
    const repairAccess = vi.fn();
    const readFile = vi.fn(() => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    });

    expect(() => readExistingPepper('pepper', { platform: 'darwin', readFile, repairAccess }))
      .toThrowError(expect.objectContaining({ code: 'MCP_CREDENTIAL_ACCESS_DENIED' }));
    expect(repairAccess).not.toHaveBeenCalled();
  });

  it('rejects an invalid pepper length without attempting to replace it', () => {
    const readFile = vi.fn(() => Buffer.alloc(31));
    const repairAccess = vi.fn();

    expect(() => readExistingPepper('pepper', { platform: 'win32', readFile, repairAccess }))
      .toThrowError(expect.objectContaining({ code: 'MCP_CREDENTIAL_INVALID' }));
    expect(readFile).toHaveBeenCalledOnce();
    expect(repairAccess).not.toHaveBeenCalled();
  });

  it('reports the key path and system error when its parent directory cannot be created', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-mcp-credential-directory-error-'));
    const filename = path.join(root, 'missing', 'mcp-client-credential-pepper');
    const createError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const createDirectory = vi.fn(() => { throw createError; });

    try {
      expect(() => readOrCreatePepper(filename, createDirectory)).toThrowError(expect.objectContaining({
        code: 'MCP_CREDENTIAL_CREATE_FAILED',
        filePath: filename,
        systemCode: 'EACCES',
      }));
      expect(createDirectory).toHaveBeenCalledWith(path.dirname(filename));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP credential token persistence', () => {
  it('keeps the client and token stable when copying it again', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-mcp-credential-persistence-'));
    try {
      const store = new McpClientCredentialStore(root);
      const issued = store.issue('Agent');
      const copied = store.tokenFor(issued.credentialId);

      expect(copied).toBe(issued.token);
      expect(store.authenticationState(issued.token)).toBe('valid');

      const reloaded = new McpClientCredentialStore(root);
      expect(reloaded.tokenFor(issued.credentialId)).toBe(issued.token);
      expect(reloaded.authenticationState(issued.token)).toBe('valid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not return a missing or revoked credential token', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-mcp-credential-persistence-missing-'));
    try {
      const store = new McpClientCredentialStore(root);
      expect(store.tokenFor('00000000-0000-4000-8000-000000000000')).toBeUndefined();
      const issued = store.issue();
      expect(store.revoke(issued.credentialId)).toBe(true);
      expect(store.tokenFor(issued.credentialId)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
