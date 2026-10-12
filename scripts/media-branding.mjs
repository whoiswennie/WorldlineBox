// Rewrite only compiler diagnostic paths in unsigned Windows media tools.
// Preserve the PE layout, executable sections, string addresses and imports.
export function brandWindowsDiagnosticPaths(input) {
  const output = Buffer.from(input);
  const matches = [...input.toString('latin1').matchAll(/[A-Z]:\\Users\\[^\\\0]+\\AppData\\Local\\[^\\\0]+MediaBuild\\[^\0]+/g)];
  if (matches.length === 0) return output;
  if (input.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a PE media tool.');
  const pe = input.readUInt32LE(0x3c);
  const optional = pe + 24;
  if (input.toString('ascii', pe, pe + 4) !== 'PE\0\0' || input.readUInt16LE(optional) !== 0x20b) throw new Error('Expected a PE32+ media tool.');
  const certificate = optional + 112 + 4 * 8;
  if (input.readUInt32LE(certificate) || input.readUInt32LE(certificate + 4)) throw new Error('Refuse to rewrite a signed media tool.');
  const sections = [];
  const sectionTable = optional + input.readUInt16LE(pe + 20);
  for (let index = 0; index < input.readUInt16LE(pe + 6); index++) {
    const header = sectionTable + index * 40;
    sections.push({ offset: input.readUInt32LE(header + 20), size: input.readUInt32LE(header + 16), executable: (input.readUInt32LE(header + 36) & 0x20000000) !== 0 });
  }
  for (const match of matches) {
    const offset = match.index;
    const oldPath = match[0];
    const section = sections.find((item) => offset >= item.offset && offset + oldPath.length <= item.offset + item.size);
    if (!section || section.executable) throw new Error('Build path is outside a non-executable PE data section.');
    const newPath = oldPath
      .replace(/^[A-Z]:\\Users\\[^\\]+\\AppData\\Local\\[^\\]+MediaBuild\\/, 'C:\\Build\\WorldlineBoxMediaBuild\\')
      .replace(/\\[^\\]+-x64-windows-static-rel\\/, '\\worldlinebox-x64-windows-static-rel\\');
    if (newPath.length > oldPath.length) throw new Error('Branded diagnostic path exceeds its original allocation.');
    output.fill(0, offset, offset + oldPath.length);
    output.write(newPath, offset, 'latin1');
  }
  return output;
}
