import { expect, it } from 'vitest';
import { consumeTerminalSnapshot, terminalExternalLink } from '../../src/renderer/launcher/terminal-stream';

it('appends each terminal byte sequence only once when state updates replay its bounded ring', () => {
  const initial = consumeTerminalSnapshot({ text: '\u001b[32mPS> \u001b[0m', startOffset: 0, revision: 0 });
  expect(initial.reset).toBe(true);
  const replay = consumeTerminalSnapshot({ text: '\u001b[32mPS> \u001b[0m', startOffset: 0, revision: 0 }, initial.cursor);
  expect(replay).toMatchObject({ reset: false, text: '' });
  const append = consumeTerminalSnapshot({ text: '\u001b[32mPS> \u001b[0m你好\r\n', startOffset: 0, revision: 0 }, replay.cursor);
  expect(append).toMatchObject({ reset: false, text: '你好\r\n' });
});

it('retains screen history across backend ring trims and detects a missed stream gap', () => {
  const initial = consumeTerminalSnapshot({ text: 'old\r\nfirst', startOffset: 0, revision: 4 });
  const trimmed = consumeTerminalSnapshot({ text: 'first\r\nsecond', startOffset: 5, revision: 4 }, initial.cursor);
  expect(trimmed).toMatchObject({ reset: false, text: '\r\nsecond' });
  const gap = consumeTerminalSnapshot({ text: 'new baseline', startOffset: 100, revision: 4 }, trimmed.cursor);
  expect(gap).toMatchObject({ reset: true, text: 'new baseline' });
});

it('honors clears and rejects a discontinuous same-length replacement', () => {
  const initial = consumeTerminalSnapshot({ text: 'old', startOffset: 0, revision: 0 });
  expect(consumeTerminalSnapshot({ text: '', startOffset: 0, revision: 1 }, initial.cursor)).toMatchObject({ reset: true, text: '' });
  expect(consumeTerminalSnapshot({ text: 'new', startOffset: 0, revision: 0 }, initial.cursor)).toMatchObject({ reset: true, text: 'new' });
  expect(() => consumeTerminalSnapshot({ text: 'x', startOffset: -1, revision: 0 })).toThrow('Invalid terminal');
});

it('only exposes ordinary web links from terminal output', () => {
  expect(terminalExternalLink('https://example.com/docs?q=term')).toBe('https://example.com/docs?q=term');
  expect(terminalExternalLink('file:///C:/private.txt')).toBeUndefined();
  expect(terminalExternalLink('javascript:alert(1)')).toBeUndefined();
  expect(terminalExternalLink('https://name:secret@example.com/')).toBeUndefined();
});
