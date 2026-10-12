import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_RECENT_SCRIPTS_LIMIT,
  createJsonFileAutomationRecentScriptsStore,
} from '../../src/main/automation-recent-scripts-store';

const roots: string[] = [];
const handleA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const handleB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-recent-scripts-'));
  roots.push(root);
  return path.join(root, 'automation-recent-scripts.json');
}

describe('AutomationRecentScriptsStore', () => {
  it('records scripts by basename and never exposes absolute paths in list()', () => {
    const filename = storePath();
    const store = createJsonFileAutomationRecentScriptsStore(filename, {
      clock: () => new Date('2026-07-31T08:00:00.000Z'),
      newHandle: (() => {
        let next = 0;
        return () => (next += 1) === 1 ? handleA : handleB;
      })(),
    });

    store.record('rating.worldlinebox.ts', '/Users/test/scripts/rating.worldlinebox.ts');
    expect(store.list()).toEqual([{
      handle: handleA,
      displayName: 'rating.worldlinebox.ts',
      lastOpenedAt: '2026-07-31T08:00:00.000Z',
    }]);
    expect(store.list().every((entry) => !('absolutePath' in entry))).toBe(true);
    // store 以 path.resolve 规范化存储（Windows 下会带盘符）
    expect(store.resolvePath(handleA)).toBe(
      path.resolve('/Users/test/scripts/rating.worldlinebox.ts'),
    );
  });

  it('moves the same file to the front and updates lastOpenedAt without duplicating entries', () => {
    const filename = storePath();
    let tick = 0;
    const store = createJsonFileAutomationRecentScriptsStore(filename, {
      clock: () => new Date(`2026-07-31T08:0${tick}:00.000Z`),
      newHandle: (() => {
        let next = 0;
        return () => (next += 1) === 1 ? handleA : handleB;
      })(),
    });
    const firstPath = '/tmp/first.worldlinebox.ts';
    const secondPath = '/tmp/second.worldlinebox.ts';

    store.record('first.worldlinebox.ts', firstPath);
    tick = 1;
    store.record('second.worldlinebox.ts', secondPath);
    tick = 2;
    store.record('first.worldlinebox.ts', firstPath);

    expect(store.list()).toEqual([
      {
        handle: handleA,
        displayName: 'first.worldlinebox.ts',
        lastOpenedAt: '2026-07-31T08:02:00.000Z',
      },
      {
        handle: handleB,
        displayName: 'second.worldlinebox.ts',
        lastOpenedAt: '2026-07-31T08:01:00.000Z',
      },
    ]);
  });

  it('caps the list at twelve entries and persists to disk', () => {
    const filename = storePath();
    let counter = 0;
    const store = createJsonFileAutomationRecentScriptsStore(filename, {
      clock: () => new Date('2026-07-31T08:00:00.000Z'),
      newHandle: () => `cccccccc-cccc-4ccc-8ccc-${String(++counter).padStart(12, '0')}`,
    });

    for (let index = 0; index < AUTOMATION_RECENT_SCRIPTS_LIMIT + 2; index += 1) {
      store.record(`script-${index}.worldlinebox.ts`, `/tmp/script-${index}.worldlinebox.ts`);
    }

    expect(store.list()).toHaveLength(AUTOMATION_RECENT_SCRIPTS_LIMIT);
    expect(store.list()[0]?.displayName).toBe(`script-${AUTOMATION_RECENT_SCRIPTS_LIMIT + 1}.worldlinebox.ts`);
    const persisted = JSON.parse(readFileSync(filename, 'utf8')) as { entries: { absolutePath: string }[] };
    expect(persisted.entries).toHaveLength(AUTOMATION_RECENT_SCRIPTS_LIMIT);
    // 持久化路径是 path.resolve 规范化后的平台路径（Windows 下带盘符）
    const tmpPrefix = path.resolve('/tmp/');
    expect(persisted.entries.every((entry) => entry.absolutePath.startsWith(tmpPrefix))).toBe(true);
  });
});
