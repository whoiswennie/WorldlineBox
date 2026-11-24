import { openPromise } from 'yauzl';
import { stat } from 'node:fs/promises';
import { BOT_MEDIA_PREVIEW_MAX_BYTES, officeFormat } from '../../shared/companion-bot-media';

const partsByFormat = {
  docx: /^word\/document\.xml$/,
  pptx: /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)$/,
  xlsx: /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/,
};

export async function readOfficeParts(file: string, name: string) {
  const format = officeFormat(name);
  if (!format) throw Error('此附件不是支持的 Office 文档。');
  if ((await stat(file)).size > BOT_MEDIA_PREVIEW_MAX_BYTES) throw Error('文档超过预览容量。');
  const zip = await openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const parts: Record<string, string> = {};
  let total = 0;
  const tooLarge = () => Error('文档内容超过内置预览容量，请使用系统应用打开。');
  try {
    if (zip.entryCount > 12000) throw tooLarge();
    for await (const entry of zip.eachEntry()) {
      if (!partsByFormat[format].test(entry.fileName)) continue;
      if (entry.uncompressedSize > 4 * 1024 * 1024 || Object.keys(parts).length >= 300 ||
        total + entry.uncompressedSize > 12 * 1024 * 1024) throw tooLarge();
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > 12 * 1024 * 1024) throw tooLarge();
        chunks.push(chunk);
      }
      const xml = Buffer.concat(chunks).toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('文档包含不支持的 XML 声明。');
      parts[entry.fileName] = xml;
    }
    return parts;
  } finally { zip.close(); }
}

