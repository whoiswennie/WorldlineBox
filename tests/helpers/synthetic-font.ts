/**
 * 合成最小 OpenType 字体，供字体解析/语言判定测试使用。
 *
 * 真实 CJK 字体有授权与体积问题（不能进仓库），而语言判定的输入其实就是
 * `OS/2` 的 `ulCodePageRange` 位 + `name` 表记录 + `cmap` 覆盖，因此用合成的
 * sfnt 精确构造这些组合，比拿真字体更能锁定规则。
 */

/** OS/2 ulCodePageRange1 位（OpenType 规范 / Win32 code page bitfields）。 */
export const CODE_PAGE_BIT = {
  latin1: 0,
  cyrillic: 2,
  greek: 3,
  hebrew: 5,
  arabic: 6,
  thai: 16,
  japanese: 17,
  chineseSimplified: 18,
  koreanWansung: 19,
  chineseTraditional: 20,
  koreanJohab: 21,
} as const;

export interface SyntheticSfntOptions {
  readonly family: string;
  readonly codePoints: number[];
  readonly fsSelection?: number;
  readonly weightClass?: number;
  /** TTC 里表偏移相对整个文件，需要额外加前缀长度。 */
  readonly tableOffsetBase?: number;
  /** ulCodePageRange1 的位；不给则整字段为 0。 */
  readonly codePageBits?: number;
  /** OS/2 版本，默认 1（0 = 没有 code page 字段）。 */
  readonly os2Version?: number;
  /** name 记录，默认只用一条英文 nameID 1。 */
  readonly nameRecords?: ReadonlyArray<{
    readonly nameId: number;
    readonly languageId: number;
    readonly value: string;
  }>;
  /** 写成可变字体：`fvar` 的 `wght` 轴 + 这些命名实例字重。 */
  readonly variableWeights?: readonly number[];
  /** 轴范围（不给则取实例的 min/max）。 */
  readonly weightAxisRange?: { readonly min: number; readonly max: number };
}

const KANA = [0x3042, 0x30a2];
const CJK_IDEOGRAPH = [0x4e00];
const LATIN = [0x0041, 0x7a];
const HANGUL = [0xd55c];

/** 含假名的中文字体（微软雅黑/宋体这类：有假名但只声明 GB2312）。 */
export const CJK_LIKE_CODE_POINTS = [...KANA, ...CJK_IDEOGRAPH, ...LATIN];
export const KOREAN_LIKE_CODE_POINTS = [...HANGUL, ...KANA, ...CJK_IDEOGRAPH, ...LATIN];
export const LATIN_ONLY_CODE_POINTS = [...LATIN];
export function buildSyntheticSfnt(options: SyntheticSfntOptions): Uint8Array {
  const encodeName = (value: string): Buffer => {
    const out = Buffer.alloc(value.length * 2);
    for (let index = 0; index < value.length; index += 1) {
      out.writeUInt16BE(value.charCodeAt(index), index * 2);
    }
    return out;
  };
  const records = options.nameRecords ?? [
    { nameId: 1, languageId: 0x409, value: options.family },
  ];
  const strings: Buffer[] = [];
  const nameRecordBytes = Buffer.alloc(records.length * 12);
  let stringOffset = 0;
  records.forEach((record, index) => {
    const encoded = encodeName(record.value);
    const at = index * 12;
    nameRecordBytes.writeUInt16BE(3, at); // platformId = Windows
    nameRecordBytes.writeUInt16BE(record.languageId, at + 4);
    nameRecordBytes.writeUInt16BE(record.nameId, at + 6);
    nameRecordBytes.writeUInt16BE(encoded.length, at + 8);
    nameRecordBytes.writeUInt16BE(stringOffset, at + 10);
    strings.push(encoded);
    stringOffset += encoded.length;
  });
  const nameHeader = Buffer.alloc(6 + nameRecordBytes.length);
  nameHeader.writeUInt16BE(records.length, 2);
  nameHeader.writeUInt16BE(6 + nameRecordBytes.length, 4);
  nameRecordBytes.copy(nameHeader, 6);
  const name = Buffer.concat([nameHeader, ...strings]);

  const head = Buffer.alloc(54);
  head.writeUInt16BE(2048, 18); // unitsPerEm
  const os2 = Buffer.alloc(86);
  os2.writeUInt16BE(options.os2Version ?? 1, 0);
  os2.writeUInt16BE(options.weightClass ?? 400, 4);
  os2.writeUInt16BE(5, 6); // usWidthClass
  os2.writeUInt16BE(options.fsSelection ?? 0x40, 62);
  os2.writeUInt32BE(options.codePageBits ?? 0, 78); // ulCodePageRange1
  const maxp = Buffer.alloc(6);
  maxp.writeUInt16BE(1234, 4);

  // cmap：format 12，每个码位一个 group（按规范排序、去重）。
  const codePoints = [...new Set(options.codePoints)].sort((left, right) => left - right);
  const groups = Buffer.alloc(codePoints.length * 12);
  codePoints.forEach((codePoint, index) => {
    groups.writeUInt32BE(codePoint, index * 12);
    groups.writeUInt32BE(codePoint, index * 12 + 4);
    groups.writeUInt32BE(0, index * 12 + 8);
  });
  const subtable = Buffer.alloc(16 + groups.length);
  subtable.writeUInt16BE(12, 0); // format
  subtable.writeUInt32BE(subtable.length, 4); // length
  subtable.writeUInt32BE(0, 8); // language
  subtable.writeUInt32BE(codePoints.length, 12); // nGroups
  groups.copy(subtable, 16);
  const cmapHeader = Buffer.alloc(12);
  cmapHeader.writeUInt16BE(1, 2); // numTables
  cmapHeader.writeUInt16BE(3, 4); // platformId
  cmapHeader.writeUInt16BE(10, 6); // encodingId = UCS-4
  cmapHeader.writeUInt32BE(12, 8); // subtable offset
  const cmap = Buffer.concat([cmapHeader, subtable]);

  const tables: Array<[string, Buffer]> = [
    ['OS/2', os2],
    ['cmap', cmap],
    ['head', head],
    ['maxp', maxp],
    ['name', name],
  ];
  if (options.variableWeights && options.variableWeights.length > 0) {
    const weights = [...options.variableWeights];
    const axesArrayOffset = 16;
    const axisSize = 20;
    const instanceSize = 4 + 4; // subfamilyNameID + flags + one coordinate
    const fvar = Buffer.alloc(
      axesArrayOffset + axisSize + weights.length * instanceSize,
    );
    fvar.writeUInt16BE(1, 0); // majorVersion
    fvar.writeUInt16BE(0, 2); // minorVersion
    fvar.writeUInt16BE(axesArrayOffset, 4);
    fvar.writeUInt16BE(2, 6); // reserved
    fvar.writeUInt16BE(1, 8); // axisCount
    fvar.writeUInt16BE(axisSize, 10);
    fvar.writeUInt16BE(weights.length, 12); // instanceCount
    fvar.writeUInt16BE(instanceSize, 14);
    fvar.write('wght', axesArrayOffset, 'latin1');
    const min = options.weightAxisRange?.min ?? Math.min(...weights);
    const max = options.weightAxisRange?.max ?? Math.max(...weights);
    const writeFixed = (value: number, offset: number) =>
      fvar.writeInt32BE(Math.round(value * 65536), offset);
    writeFixed(min, axesArrayOffset + 4);
    writeFixed(400, axesArrayOffset + 8);
    writeFixed(max, axesArrayOffset + 12);
    weights.forEach((weight, index) => {
      const record = axesArrayOffset + axisSize + index * instanceSize;
      fvar.writeUInt16BE(2, record); // subfamilyNameID
      fvar.writeUInt16BE(0, record + 2); // flags
      writeFixed(weight, record + 4);
    });
    tables.push(['fvar', fvar]);
    tables.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  }
  const headerSize = 12 + tables.length * 16;
  let offset = headerSize;
  const directory = Buffer.alloc(tables.length * 16);
  const bodies: Buffer[] = [];
  tables.forEach(([tag, body], index) => {
    const at = index * 16;
    directory.write(tag, at, 'latin1');
    directory.writeUInt32BE(offset + (options.tableOffsetBase ?? 0), at + 8);
    directory.writeUInt32BE(body.length, at + 12);
    bodies.push(body);
    offset += body.length;
    while (offset % 4 !== 0) {
      bodies.push(Buffer.alloc(1));
      offset += 1;
    }
  });
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(tables.length, 4);
  return new Uint8Array(Buffer.concat([header, directory, ...bodies]));
}
