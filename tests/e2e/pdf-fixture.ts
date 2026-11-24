/** Multi-page PDF (hand-assembled, correct xref offsets) — WorldlineBox-8ca259. */
export function buildMultiPagePdf(pageCount: number): Buffer {
  const parts: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  const objects: string[] = [];
  const kids = Array.from({ length: pageCount }, (_, i) => `${4 + i} 0 R`).join(" ");
  objects.push("<</Type/Catalog/Pages 2 0 R>>"); // 1
  objects.push(`<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`); // 2
  objects.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"); // 3
  for (let i = 1; i <= pageCount; i += 1) {
    const contentId = 4 + pageCount + (i - 1);
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentId} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`,
    ); // 4..3+n
  }
  for (let i = 1; i <= pageCount; i += 1) {
    const stream = `BT /F1 24 Tf 50 100 Td (Page ${i} of ${pageCount}) Tj ET`;
    objects.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`); // 4+n..3+2n
  }
  let objectNumber = 1;
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(parts.join(""), "latin1"));
    parts.push(`${objectNumber} 0 obj\n${obj}\nendobj\n`);
    objectNumber += 1;
  }
  const xrefStart = Buffer.byteLength(parts.join(""), "latin1");
  const total = 1 + objects.length;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer<</Size ${total}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(parts.join("") + xref, "latin1");
}
