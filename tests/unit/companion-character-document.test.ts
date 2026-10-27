import { expect, it } from 'vitest';
import { parseCharacterDocument, replaceCharacterField } from '../../src/shared/companion-character-document';

it('keeps arbitrary sections, labels, multiline values and untouched prose when editing one source range', () => {
  const source = '一段自由序言。\n\n【契约】\n自定义称呼：领航员\n  仅在远航时使用。\n\n## 世界设定\n港口：银湾\n';
  const sections = parseCharacterDocument(source);
  expect(sections.map(section => section.title)).toEqual(['契约', '世界设定']);
  expect(sections[0]!.fields[0]!.value).toBe('领航员\n仅在远航时使用。');
  const edited = replaceCharacterField(source, sections[0]!.fields[0]!, '新的称呼', '船长\n私人使用');
  expect(edited).toBe('一段自由序言。\n\n【契约】\n新的称呼：船长\n  私人使用\n\n## 世界设定\n港口：银湾\n');
  expect(parseCharacterDocument(edited)[1]!.fields[0]!.label).toBe('港口');
});
it('does not invent fields or restore removed sections', () => {
  expect(parseCharacterDocument('只有自由设定，没有固定字段。')).toEqual([]);
  const source = '【新的章节】\n自定义：值\n', section = parseCharacterDocument(source)[0]!;
  const withoutField = source.slice(0, section.fields[0]!.start) + source.slice(section.fields[0]!.end);
  expect(parseCharacterDocument(withoutField)[0]!.fields).toEqual([]);
});
