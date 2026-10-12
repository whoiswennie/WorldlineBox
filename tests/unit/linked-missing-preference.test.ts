import { describe, expect, it } from 'vitest';

import {
  readShowMissingLinkedFiles,
  writeShowMissingLinkedFiles,
} from '../../src/renderer/linked-missing-preference';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('linked missing file preference', () => {
  it('shows missing linked files until the stored value is off', () => {
    const storage = memoryStorage();
    expect(readShowMissingLinkedFiles(storage)).toBe(true);
    writeShowMissingLinkedFiles(false, storage);
    expect(readShowMissingLinkedFiles(storage)).toBe(false);
    writeShowMissingLinkedFiles(true, storage);
    expect(readShowMissingLinkedFiles(storage)).toBe(true);
  });
});
