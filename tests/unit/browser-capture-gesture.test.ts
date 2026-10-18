import { describe, expect, it } from 'vitest';
import { createBrowserCaptureGestureGate } from '../../src/preload/browser-capture-gesture';
import type { BrowserCaptureContentRequest } from '../../src/shared/browser-capture';

const folders: BrowserCaptureContentRequest = { type: 'runtime.message', message: { type: 'worldlinebox-list-folders' } };
const save: BrowserCaptureContentRequest = { type: 'runtime.message', message: { type: 'worldlinebox-save-request', intent: {
  kind: 'image', sourcePageUrl: 'https://example.test/post', mediaUrl: 'https://example.test/image.png',
} } };
const local: BrowserCaptureContentRequest = { type: 'runtime.message', message: { type: 'worldlinebox-local-save-request', kind: 'image',
  bodyBase64: 'aGVsbG8=', contentType: 'image/png', filename: 'local.png' } };

describe('isolated browser capture user-gesture gate', () => {
  it('rejects synthetic start/over/drop and leaves preferences and connection checks available', () => {
    const gate = createBrowserCaptureGestureGate(() => 100);
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) gate.observe({ type, isTrusted: false });
    expect(gate.authorize(folders)).toBe(false); expect(gate.authorize(save)).toBe(false); expect(gate.authorize(local)).toBe(false);
    expect(gate.authorize({ type: 'runtime.message', message: { type: 'worldlinebox-connection-status' } })).toBe(true);
    expect(gate.authorize({ type: 'storage.get', area: 'sync', keys: ['worldlineboxNotificationsEnabled',
      'worldlineboxFocusAppAfterSave', 'worldlineboxRevealInLibraryAfterSave', 'worldlineboxDragRadialMenuEnabled'] })).toBe(true);
  });

  it('allows directory browsing during a trusted drag but requires a trusted drop to save', () => {
    const gate = createBrowserCaptureGestureGate(() => 100);
    gate.observe({ type: 'dragstart', isTrusted: true });
    expect(gate.authorize(folders)).toBe(true); expect(gate.authorize(save)).toBe(false);
    gate.observe({ type: 'drop', isTrusted: false });
    expect(gate.authorize(save)).toBe(false);
    gate.observe({ type: 'drop', isTrusted: true });
    expect(gate.authorize(save)).toBe(true); expect(gate.authorize(save)).toBe(false); expect(gate.authorize(folders)).toBe(false);
  });

  it('renews only active trusted drag-over events and expires abandoned gestures', () => {
    let time = 100; const gate = createBrowserCaptureGestureGate(() => time);
    gate.observe({ type: 'dragstart', isTrusted: true }); time += 14_000;
    gate.observe({ type: 'dragover', isTrusted: true }); time += 14_000;
    expect(gate.authorize(folders)).toBe(true); time += 1_001;
    gate.observe({ type: 'dragover', isTrusted: true });
    expect(gate.authorize(folders)).toBe(false);
    gate.observe({ type: 'drop', isTrusted: true }); expect(gate.authorize(save)).toBe(false);
  });

  it('does not authorize saves after a cancelled drag and does not revive it with a late drop', () => {
    const gate = createBrowserCaptureGestureGate(() => 100);
    gate.observe({ type: 'dragstart', isTrusted: true }); gate.observe({ type: 'dragend', isTrusted: true });
    gate.observe({ type: 'drop', isTrusted: true });
    expect(gate.authorize(folders)).toBe(false); expect(gate.authorize(save)).toBe(false);
  });

  it('preserves a single bounded save permit across dragend for asynchronous local-image encoding', () => {
    let time = 100; const gate = createBrowserCaptureGestureGate(() => time);
    gate.observe({ type: 'dragstart', isTrusted: true }); gate.observe({ type: 'drop', isTrusted: true });
    gate.observe({ type: 'dragend', isTrusted: true }); time += 4_999;
    expect(gate.authorize(local)).toBe(true); expect(gate.authorize(local)).toBe(false);
    gate.observe({ type: 'dragstart', isTrusted: true }); gate.observe({ type: 'drop', isTrusted: true }); time += 5_000;
    expect(gate.authorize(save)).toBe(false);
  });

  it('allows exactly one local upload from a native Main context request without authorizing other capabilities', () => {
    let time = 100; const gate = createBrowserCaptureGestureGate(() => time);
    gate.nativeEvent({ type: 'runtime.message', message: { type: 'worldlinebox-save-feedback', state: 'saved' } });
    expect(gate.authorize(local)).toBe(false);
    gate.nativeEvent({ type: 'runtime.message', message: { type: 'worldlinebox-local-context-save-request' } });
    expect(gate.authorize(folders)).toBe(false); expect(gate.authorize(save)).toBe(false);
    expect(gate.authorize(local)).toBe(true); expect(gate.authorize(local)).toBe(false);
    gate.nativeEvent({ type: 'runtime.message', message: { type: 'worldlinebox-local-context-save-request' } }); time += 5_000;
    expect(gate.authorize(local)).toBe(false);
  });
});
