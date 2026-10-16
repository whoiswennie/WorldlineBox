import { expect, it } from 'vitest';
import { isCurrentDocumentReload } from '../../src/main/renderer-navigation';
it('allows only exact current complete trusted document URLs', () => {
  for (const current of ['file:///app/index.html', 'file:///app/index.html?window=companion-world#camera', 'http://localhost:5173/?window=companion-world', 'https://localhost/app']) {
    expect(isCurrentDocumentReload(current, current)).toBe(true);
    for (const candidate of ['', current + '#changed', current + '?changed', 'https://example.com/', 'file:///other/index.html', 'javascript:alert(1)']) expect(isCurrentDocumentReload(current, candidate)).toBe(false);
  }
  for (const invalid of ['', 'not a URL', 'javascript:alert(1)', 'data:text/html,hello']) expect(isCurrentDocumentReload(invalid, invalid)).toBe(false);
});
