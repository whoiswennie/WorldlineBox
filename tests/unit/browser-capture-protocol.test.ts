import { describe, expect, it } from 'vitest';
import {
  browserCaptureContentRequestSchema, browserCaptureRequestSchema, browserCaptureTargetSchema,
} from '../../src/shared/browser-capture';

describe('built-in browser capture boundary', () => {
  it('pins the target library explicitly and distinguishes its root from a folder', () => {
    expect(browserCaptureTargetSchema.parse({ libraryId: 'lib-a', folderId: null })).toEqual({ libraryId: 'lib-a', folderId: null });
    expect(browserCaptureTargetSchema.safeParse({ folderId: 'folder-a' }).success).toBe(false);
    expect(browserCaptureTargetSchema.safeParse({ libraryId: '', folderId: null }).success).toBe(false);
    expect(browserCaptureRequestSchema.parse({ type: 'target.set', target: { libraryId: 'lib-a', folderId: 'folder-a' } }))
      .toMatchObject({ target: { libraryId: 'lib-a', folderId: 'folder-a' } });
  });

  it('keeps native pickers and library navigation out of the untrusted frame channel', () => {
    for (const type of ['local.open', 'open-assets', 'target.set', 'preferences.save']) {
      expect(browserCaptureContentRequestSchema.safeParse({ type }).success).toBe(false);
      expect(browserCaptureContentRequestSchema.safeParse({ type: 'runtime.message', message: { type } }).success).toBe(false);
    }
    expect(browserCaptureRequestSchema.safeParse({ type: 'local.open' }).success).toBe(true);
  });

  it('limits extension storage to capture settings and recent folders', () => {
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'storage.set', area: 'sync',
      values: { worldlineboxDragRadialMenuEnabled: false } }).success).toBe(true);
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'storage.get', area: 'local', keys: ['recentFolderIds'] }).success).toBe(true);
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'storage.get', area: 'local', keys: ['apiKey'] }).success).toBe(false);
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'storage.set', area: 'sync', values: { apiKey: true } }).success).toBe(false);
  });

  it('only relays the existing extension message shapes', () => {
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'runtime.message', message: {
      type: 'worldlinebox-save-request', intent: { kind: 'image', sourcePageUrl: 'https://example.test/gallery',
        mediaUrl: 'https://example.test/large.png', targetFolderId: null },
    } }).success).toBe(true);
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'runtime.message', message: {
      type: 'worldlinebox-save-request', intent: { kind: 'image', sourcePageUrl: 'https://example.test/gallery',
        mediaUrl: 'https://example.test/large.png', libraryId: 'untrusted-override' },
    } }).success).toBe(false);
    expect(browserCaptureContentRequestSchema.safeParse({ type: 'runtime.message', message: {
      type: 'worldlinebox-local-save-request', kind: 'image', filename: 'image.png', contentType: 'image/png',
      bodyBase64: 'AAAA', stagedFilePath: 'C:/private/file',
    } }).success).toBe(false);
  });
});
