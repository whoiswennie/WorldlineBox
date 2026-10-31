// Conservative CommonMark/GFM/math detection. False positives use the complete
// renderer; plain paragraphs avoid loading/parsing its editors and math stack.
const richSyntax = /[\\`*_~#[\]<>$|&@]|https?:\/\/|www\.|(?:^|\n)(?:[ \t]*[-+>]|[ \t]*\d+[.)][ \t]| {4}|\t|[ \t]*=+[ \t]*(?:\n|$))| {2}\r?\n/u;

export function plainMessageParagraphs(content: string): string[] | undefined {
  if (richSyntax.test(content)) return;
  const text = content.replace(/\r\n?/gu, '\n').replace(/^[ \n]+|[ \n]+$/gu, '');
  return text ? text.split(/\n[ \t]*\n+/u).map(paragraph => paragraph.replace(/^ {1,3}|[ \t]+$/gmu, '')) : [];
}
