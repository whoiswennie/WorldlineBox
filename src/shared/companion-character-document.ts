/** A form projection of the authored text, not a separate persisted schema.
 * Edits replace only the chosen source range, preserving all other prose. */
export interface CharacterDocumentField { label: string; value: string; start: number; end: number }
export interface CharacterDocumentSection { title: string; start: number; headingEnd: number; end: number; intro: string; fields: CharacterDocumentField[] }
export function parseCharacterDocument(source: string): CharacterDocumentSection[] {
  const headings = [...source.matchAll(/^(?:【([^】\r\n]+)】|#{1,3}[ \t]+([^\r\n]+))[ \t]*\r?$/gmu)];
  return headings.map((heading, index) => {
    const start = heading.index!, headingEnd = start + heading[0].length + (source[start + heading[0].length] === '\n' ? 1 : 0);
    const end = headings[index + 1]?.index ?? source.length, body = source.slice(headingEnd, end);
    const matches = [...body.matchAll(/^([^\s：:\r\n][^：:\r\n]{0,99})[：:]([^\r\n]*)\r?$/gmu)];
    const fields = matches.map((match, fieldIndex) => {
      const from = headingEnd + match.index!, through = headingEnd + (matches[fieldIndex + 1]?.index ?? body.length);
      const raw = source.slice(from + match[1]!.length + 1, through);
      return { label: match[1]!.trim(), value: raw.replace(/^ /u, '').replace(/\r\n/gu, '\n').replace(/\n {2}/gu, '\n').trimEnd(), start: from, end: through };
    });
    return { title: (heading[1] ?? heading[2]!).trim(), start, headingEnd, end, intro: source.slice(headingEnd, fields[0]?.start ?? end), fields };
  });
}
export function replaceCharacterField(source: string, field: CharacterDocumentField, label: string, value: string): string {
  const name = label.replace(/[：:\r\n]/gu, '').trim() || field.label;
  const lines = value.replace(/\r\n/gu, '\n').split('\n');
  const rendered = name + '：' + (lines[0] ?? '') + lines.slice(1).map(line => '\n  ' + line).join('') + '\n';
  // Preserve the original spacing between this field and the following block.
  const spacing = /(?:\r?\n){2,}$/u.exec(source.slice(field.start, field.end))?.[0] ?? '';
  return source.slice(0, field.start) + rendered + (spacing ? spacing.slice(1) : '') + source.slice(field.end);
}
export function appendCharacterSection(source: string, title: string): string {
  return source + (source.endsWith('\n\n') || !source ? '' : source.endsWith('\n') ? '\n' : '\n\n') + '【' + title + '】\n';
}
