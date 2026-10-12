/**
 * WorldlineBox-485aeb：字体文件元信息解析（纯函数，不碰 fs）。
 *
 * 支持 sfnt（TTF/OTF）、TTC 集合（取第一个字体）、WOFF1（按需 inflate 表）、
 * WOFF2（brotli 解压后按目录顺序重建 sfnt）。
 *
 * 解析五张必要的表：
 * - `name`：家族名 / 子家族 / 全名 / 版本 / 厂商 / 版权 + 本地化名字与语言 ID；
 * - `head` + `OS/2` + `maxp`：unitsPerEm、usWeightClass、斜体/粗体标志、字形数、
 *   `ulCodePageRange` / `ulUnicodeRange`；
 * - `cmap`：确认候选样例字符真的存在（只用于确认，不用来猜语言）。
 *
 * **语言判定（2026-09-19 按验收反馈重做，方案见开发日志 §6）**：
 * 不能用「cmap 里有假名 → 日文」这种覆盖度推断——假名是 CJK 字体的公共字形集，
 * 实测本机 1171 个字体里有 194 个含假名但其实是中文/韩文（微软雅黑、宋体、等线、
 * 微軟正黑體、Batang…）。正确做法与 Blender 的字体预览一致（`blf_thumbs.cc`、
 * 提交 "BLF: Improved CJK Font Preview Differentiation"，依据 OpenType OS/2 的
 * `ulCodePageRange`）：先看码位声明，且 **JIS 与 GB2312 必须互斥** 才能判日文/简体；
 * 声明混合时用 name 表语言 ID 与字体名关键词消歧；仍不能确定就**不猜**（中性样张）。
 *
 * 解析失败一律返回 null（调用方回退到通用文案），绝不抛出、绝不编造字段。
 */

import { brotliDecompressSync, inflateSync } from 'node:zlib';

/** CJK 语言（来自 OS/2 code page 位）。 */
export type FontCjkLanguage = 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko';
export type FontLanguage = FontCjkLanguage | 'latin';
/** 样例文字用哪种文字（CJK + 几种有独立码位的常见文字）。 */
export type FontSampleScript =
  | FontLanguage
  | 'cyrillic'
  | 'greek'
  | 'hebrew'
  | 'arabic'
  | 'thai';
/** 单一语言结论的来源，便于测试与排查。 */
export type FontLanguageSource =
  | 'code-page'
  | 'name-locale'
  | 'family-name'
  | 'coverage'
  | 'none';

export interface FontLanguageInfo {
  /** 字体在 OS/2 code page 位里声明的 CJK 语言（按确定性优先级排序）。 */
  readonly declared: readonly FontCjkLanguage[];
  /** 我们敢断言的单一语言；`null` 表示文件证据不足以判定（样张走中性文案）。 */
  readonly resolved: FontLanguage | null;
  readonly source: FontLanguageSource;
  /** 样张文字应该用哪种文字（CJK 之外的字体也能选对样例字）。 */
  readonly sampleScript: FontSampleScript;
  readonly coversLatin: boolean;
}

const CJK_LANGUAGES: readonly FontCjkLanguage[] = ['ja', 'zh-Hans', 'zh-Hant', 'ko'];
const LABEL_LANGUAGES: readonly FontLanguage[] = [...CJK_LANGUAGES, 'latin'];

/** Parse the `lang` query token used by the font sample sheet route. */
export function parseFontLanguage(raw: string | null): FontLanguage | null {
  return (LABEL_LANGUAGES as readonly string[]).includes(raw ?? '')
    ? (raw as FontLanguage)
    : null;
}

export function isFontCjkLanguage(value: string): value is FontCjkLanguage {
  return (CJK_LANGUAGES as readonly string[]).includes(value);
}


export interface FontMetadata {
  readonly family: string | null;
  readonly subfamily: string | null;
  readonly fullName: string | null;
  readonly version: string | null;
  readonly manufacturer: string | null;
  readonly copyright: string | null;
  readonly weightClass: number | null;
  readonly widthClass: number | null;
  readonly isBold: boolean;
  readonly isItalic: boolean;
  readonly unitsPerEm: number | null;
  readonly glyphCount: number | null;
  readonly language: FontLanguageInfo;
  /**
   * 可变字体 `fvar` 里 `wght` 轴实际提供的字重（命名实例优先，去重升序）。
   * 单一字重的静态字体为 null —— 查看器据此决定是否显示字重控件
   * （静态字体没有别的字重，B 按钮走浏览器合成加粗就够了）。
   */
  readonly variableWeights: readonly number[] | null;
}

interface TableRecord {
  readonly offset: number;
  readonly length: number;
  /** WOFF1 未压缩长度；长度不同表示该表被 zlib 单独压缩过。 */
  readonly origLength?: number;
}

const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ',
  'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp',
  'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF',
  'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc',
  'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx',
  'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
] as const;

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
  );
}

function readUintBase128(bytes: Uint8Array, cursor: { offset: number }): number | null {
  let result = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = bytes[cursor.offset];
    if (byte === undefined) return null;
    cursor.offset += 1;
    if (index === 0 && byte === 0x80) return null;
    if (result > 0x0fffffff) return null;
    result = (result << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return result;
  }
  return null;
}

/** sfnt / TTC：直接读表目录（TTC 取第一个字体）。 */
function sfntTables(bytes: Uint8Array, base: number): Map<string, TableRecord> | null {
  const numTables = readUint16(bytes, base + 4);
  if (numTables <= 0 || numTables > 512) return null;
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < numTables; index += 1) {
    const record = base + 12 + index * 16;
    if (record + 16 > bytes.length) return null;
    tables.set(readTag(bytes, record), {
      offset: readUint32(bytes, record + 8),
      length: readUint32(bytes, record + 12),
    });
  }
  return tables;
}

function woff1Tables(bytes: Uint8Array): Map<string, TableRecord> | null {
  const numTables = readUint16(bytes, 12);
  if (numTables <= 0 || numTables > 512) return null;
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < numTables; index += 1) {
    const record = 44 + index * 20;
    if (record + 20 > bytes.length) return null;
    tables.set(readTag(bytes, record), {
      offset: readUint32(bytes, record + 4),
      length: readUint32(bytes, record + 8),
      origLength: readUint32(bytes, record + 12),
    });
  }
  return tables;
}

/**
 * WOFF2：目录用 UIntBase128 变长整数编码，且整份字体被 brotli 压缩。
 * 解压后按目录顺序累加各表长度即可得到重建 sfnt 里的偏移
 * （只有 glyf/loca/hmtx 会被 transform，name/head/OS-2/maxp/cmap 原样搬运）。
 */
function parseWoff2(
  bytes: Uint8Array,
): { tables: Map<string, TableRecord>; data: Uint8Array } | null {
  const cursor = { offset: 48 };
  const numTables = readUint16(bytes, 12);
  if (numTables <= 0 || numTables > 512) return null;
  const entries: Array<{ tag: string; origLength: number; transformLength: number | null }> = [];
  for (let index = 0; index < numTables; index += 1) {
    const flags = bytes[cursor.offset];
    if (flags === undefined) return null;
    cursor.offset += 1;
    const tagIndex = flags & 0x3f;
    const transformVersion = (flags >> 6) & 0x03;
    let tag: string;
    if (tagIndex === 0x3f) {
      if (cursor.offset + 4 > bytes.length) return null;
      tag = readTag(bytes, cursor.offset);
      cursor.offset += 4;
    } else {
      const known = WOFF2_KNOWN_TAGS[tagIndex];
      if (!known) return null;
      tag = known;
    }
    const origLength = readUintBase128(bytes, cursor);
    if (origLength === null) return null;
    let transformLength: number | null = null;
    if (tag === 'glyf' || tag === 'loca' || (tag === 'hmtx' && transformVersion !== 0)) {
      transformLength = readUintBase128(bytes, cursor);
      if (transformLength === null) return null;
    } else if (transformVersion !== 0) {
      return null;
    }
    entries.push({ tag, origLength, transformLength });
  }
  const compressedLength = readUint32(bytes, 24);
  const compressed = bytes.subarray(cursor.offset, cursor.offset + compressedLength);
  let data: Uint8Array;
  try {
    data = new Uint8Array(brotliDecompressSync(Buffer.from(compressed)));
  } catch {
    return null;
  }
  const tables = new Map<string, TableRecord>();
  let streamOffset = 0;
  for (const entry of entries) {
    const storedLength = entry.transformLength ?? entry.origLength;
    tables.set(entry.tag, { offset: streamOffset, length: storedLength });
    streamOffset += storedLength;
  }
  return { tables, data };
}

function tableBytes(
  bytes: Uint8Array,
  tables: Map<string, TableRecord>,
  tag: string,
): Uint8Array | null {
  const record = tables.get(tag);
  if (!record) return null;
  const end = record.offset + record.length;
  if (record.offset < 0 || end > bytes.length) return null;
  const slice = bytes.subarray(record.offset, end);
  if (record.origLength !== undefined && record.origLength > record.length) {
    try {
        return new Uint8Array(inflateSync(Buffer.from(slice)));
    } catch {
      return null;
    }
  }
  return slice;
}

function decodeNameString(bytes: Uint8Array, platformId: number): string | null {
  try {
    if (platformId === 0 || platformId === 3) {
      // UTF-16BE; NUL padding is dropped rather than matched by a regex.
      let out = '';
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        const code = readUint16(bytes, index);
        if (code !== 0) out += String.fromCharCode(code);
      }
      return out.trim() || null;
    }
    const latin = Buffer.from(bytes).toString('latin1').trim();
    return latin || null;
  } catch {
    return null;
  }
}

interface NameRecord {
  readonly nameId: number;
  readonly value: string;
  readonly platformId: number;
  readonly languageId: number;
}

function parseNameTable(bytes: Uint8Array): NameRecord[] {
  const records: NameRecord[] = [];
  if (bytes.length < 6) return records;
  const count = readUint16(bytes, 2);
  const stringOffset = readUint16(bytes, 4);
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    if (record + 12 > bytes.length) break;
    const platformId = readUint16(bytes, record);
    const languageId = readUint16(bytes, record + 4);
    const nameId = readUint16(bytes, record + 6);
    const length = readUint16(bytes, record + 8);
    const offset = readUint16(bytes, record + 10);
    const start = stringOffset + offset;
    if (start + length > bytes.length) continue;
    const value = decodeNameString(
      bytes.subarray(start, start + length),
      platformId,
    );
    if (value) records.push({ nameId, value, platformId, languageId });
  }
  return records;
}

/** 优先 Windows 英文（3/0x409），其次任意 Windows，最后 Mac。 */
function pickName(records: readonly NameRecord[], nameId: number): string | null {
  const candidates = records.filter((record) => record.nameId === nameId);
  if (candidates.length === 0) return null;
  const best =
    candidates.find(
      (record) => record.platformId === 3 && record.languageId === 0x409,
    ) ??
    candidates.find((record) => record.platformId === 3) ??
    candidates[0];
  return best?.value ?? null;
}

function cmapLookup(
  bytes: Uint8Array,
  subtable: number,
  format: number,
  codePoint: number,
): boolean {
  if (format === 4) {
    const segCountX2 = readUint16(bytes, subtable + 6);
    const segCount = segCountX2 / 2;
    const endCodes = subtable + 14;
    const startCodes = endCodes + segCountX2 + 2;
    for (let segment = 0; segment < segCount; segment += 1) {
      const end = readUint16(bytes, endCodes + segment * 2);
      if (codePoint > end) continue;
      const start = readUint16(bytes, startCodes + segment * 2);
      return codePoint >= start;
    }
    return false;
  }
  if (format === 12) {
    const groups = readUint32(bytes, subtable + 12);
    for (let index = 0; index < groups; index += 1) {
      const group = subtable + 16 + index * 12;
      const start = readUint32(bytes, group);
      const end = readUint32(bytes, group + 4);
      // 不假设 group 已排序：规范要求有序，但畸形字体不该让我们少报覆盖。
      if (codePoint >= start && codePoint <= end) return true;
    }
    return false;
  }
  if (format === 6) {
    const first = readUint16(bytes, subtable + 6);
    const count = readUint16(bytes, subtable + 8);
    return codePoint >= first && codePoint < first + count;
  }
  return false;
}

function cmapCovers(bytes: Uint8Array | null, codePoint: number): boolean {
  if (!bytes || bytes.length < 4) return false;
  const tableCount = readUint16(bytes, 2);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 4 + index * 8;
    if (record + 8 > bytes.length) break;
    const platformId = readUint16(bytes, record);
    // 只为 Unicode 子表编码（0 = Unicode，3 = Windows）。
    if (platformId !== 0 && platformId !== 3) continue;
    const subtable = readUint32(bytes, record + 4);
    if (subtable + 4 > bytes.length) continue;
    const format = readUint16(bytes, subtable);
    if (format !== 4 && format !== 6 && format !== 12) continue;
    if (cmapLookup(bytes, subtable, format, codePoint)) return true;
  }
  return false;
}

const PROBE_HIRAGANA = 0x3042; // あ
const PROBE_KATAKANA = 0x30a2; // ア
const PROBE_HANGUL = 0xd55c; // 한 (Hangul syllable)
const PROBE_CJK = 0x4e00; // 一
const PROBE_LATIN = 0x0041; // A

/** OS/2 ulCodePageRange1 CJK bits (OpenType spec / Win32 code page bitfields). */
const CP_JAPANESE = 17; // 932 JIS/Japan
const CP_CHINESE_SIMPLIFIED = 18; // 936 GB2312
const CP_KOREAN_WANSUNG = 19; // 949
const CP_CHINESE_TRADITIONAL = 20; // 950 Big5
const CP_KOREAN_JOHAB = 21; // 1361

/** Windows LCIDs that identify the locale a font was localized for. */
const LCID_TO_LANGUAGE: Readonly<Record<number, FontCjkLanguage>> = {
  0x0411: 'ja',
  0x0804: 'zh-Hans',
  0x1004: 'zh-Hans',
  0x0404: 'zh-Hant',
  0x0c04: 'zh-Hant',
  0x1404: 'zh-Hant',
  0x0412: 'ko',
};

/**
 * Family/typographic-name keywords. Only used to break a tie between CJK
 * languages the file declares at once (e.g. Noto Sans JP and Source Han Sans CN
 * both set the JIS *and* GB2312 bits). Kept deliberately narrow: a false
 * positive here would put the wrong language on a card.
 */
const FAMILY_KEYWORDS: ReadonlyArray<readonly [FontCjkLanguage, RegExp]> = [
  ['ko', /korean|(^|[^a-z])kr([^a-z]|$)|malgun|batang|gulim|dotum|nanum|gungsuh|돋움|바탕|굴림|궁서|맑은/i],
  ['ja', /japanese|(^|[^a-z])(jp|jpn)([^a-z]|$)|meiryo|hiragino|mincho|gothic.*jp|ゴシック|明朝|丸ゴ|メイリオ|ヒラギノ|游ゴ|角ゴ/i],
  ['zh-Hant', /traditional|(^|[^a-z])(tc|tw|hk)([^a-z]|$)|jhenghei|mingliu|正黑|細明|新細明|標楷|儷宋|繁體|繁体/i],
  ['zh-Hans', /simplified|(^|[^a-z])(sc|cn|gb)([^a-z]|$)|yahei|simsun|dengxian|source han sans cn|思源黑体|思源宋体|雅黑|宋体|黑体|楷体|仿宋|简体|简/i],
];

function hasKana(value: string): boolean {
  return /[\u3040-\u30ff]/u.test(value);
}

function hasHangul(value: string): boolean {
  return /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(value);
}

interface LanguageEvidence {
  readonly codePageBits: number;
  /** ulCodePageRange1 存在（OS/2 v0 没有这两个字段）。 */
  readonly hasCodePageRange: boolean;
  readonly nameLocales: readonly number[];
  /** name 表里的家族/全名/排版家族名（用于关键词消歧）。 */
  readonly familyNames: readonly string[];
  /** name 表里的本地化名字（非英文语言 ID 的记录）。 */
  readonly localizedNames: readonly string[];
  readonly coversLatin: boolean;
  readonly coversKana: boolean;
  readonly coversHangul: boolean;
  readonly coversCjk: boolean;
}

/**
 * 判定字体语言。返回「字体声明了什么」+「我们敢断言哪一个」。
 *
 * 依据 OpenType OS/2 `ulCodePageRange` 的 CJK 码位位（Win32 code page
 * bitfields：17 JIS / 18 GB2312 / 19 Wansung / 20 Big5 / 21 Johab），判定顺序
 * 参考 Blender 的字体预览实现（`blf_thumbs.cc`，提交 "BLF: Improved CJK Font
 * Preview Differentiation"），并在其基础上更谨慎：
 * 1. 只声明一种 CJK 语言 → 直接用；没有声明 → 拉丁文（样张文字按覆盖度选）；
 * 2. 声明多种（实测 35/1171 个字体）→ 先用 **name 表语言 ID**、再用**字体名关键词**
 *    消歧（Blender 在这里直接按「韩文优先」，会把日文 SetoFont / 繁体 文泉驛
 *    判成韩文）；
 * 3. 仍然消不出来 → 退回码位优先级（韩文/繁体无条件优先，日文/简体要求互斥）；
 * 4. 最后仍不确定 → `resolved: null`（中性样张，绝不猜）。
 *
 * **绝不从 cmap 覆盖度推断语言**：假名是 CJK 字体的公共字形集，实测 1171 个
 * 系统字体里 194 个含假名却是中文/韩文。
 */
function resolveLanguage(evidence: LanguageEvidence): FontLanguageInfo {
  const declared = declaredCjkLanguages(evidence);
  const decision = decideLanguage(evidence, declared);
  // 样张文字跟着结论走：混合声明的字体（如思源黑体 CN 也含假名）不能出现
  // 「简体中文标签 + 假名样例」这种自相矛盾的封面。
  const scriptOrder: FontCjkLanguage[] =
    decision.language && isCjkLanguage(decision.language)
      ? [decision.language, ...declared.filter((item) => item !== decision.language)]
      : declared;
  return {
    declared,
    resolved: decision.language,
    source: decision.source,
    sampleScript: sampleScriptFor(scriptOrder, evidence),
    coversLatin: evidence.coversLatin,
  };
}

function isCjkLanguage(value: FontLanguage): value is FontCjkLanguage {
  return (CJK_LANGUAGES as readonly string[]).includes(value);
}

function decideLanguage(
  evidence: LanguageEvidence,
  declared: readonly FontCjkLanguage[],
): { readonly language: FontLanguage | null; readonly source: FontLanguageSource } {
  // OS/2 v0 没有 code page 字段：只能靠名字，绝不从 cmap 覆盖度猜 CJK 语言。
  if (!evidence.hasCodePageRange) {
    const winner = familyNameWinner(declared, evidence);
    if (winner) return { language: winner, source: 'family-name' };
    return {
      language: evidence.coversLatin ? 'latin' : null,
      source: 'coverage',
    };
  }
  if (declared.length === 0) {
    // 没有 CJK 声明：语言标签只敢说「拉丁文」（其它文字用拉丁标签也成立）。
    return { language: 'latin', source: 'coverage' };
  }
  if (declared.length === 1) {
    return { language: declared[0]!, source: 'code-page' };
  }

  const localeVotes = new Map<FontCjkLanguage, number>();
  for (const locale of evidence.nameLocales) {
    const language = LCID_TO_LANGUAGE[locale];
    if (language && declared.includes(language)) {
      localeVotes.set(language, (localeVotes.get(language) ?? 0) + 1);
    }
  }
  const localeWinner = uniqueWinner(localeVotes);
  if (localeWinner) return { language: localeWinner, source: 'name-locale' };
  const keywordWinner = familyNameWinner(declared, evidence);
  if (keywordWinner) return { language: keywordWinner, source: 'family-name' };

  // Blender 的码位优先级：韩文与繁体无条件优先，日文/简体要求彼此互斥。
  if (declared.includes('ko')) return { language: 'ko', source: 'code-page' };
  if (declared.includes('zh-Hant')) return { language: 'zh-Hant', source: 'code-page' };
  if (declared.includes('ja') && !declared.includes('zh-Hans')) {
    return { language: 'ja', source: 'code-page' };
  }
  if (declared.includes('zh-Hans') && !declared.includes('ja')) {
    return { language: 'zh-Hans', source: 'code-page' };
  }
  return { language: null, source: 'none' };
}

/** CJK 语言声明（按确定性优先级：韩文 → 繁体 → 日文 → 简体）。 */
function declaredCjkLanguages(evidence: LanguageEvidence): FontCjkLanguage[] {
  const bits = evidence.codePageBits;
  const declared: FontCjkLanguage[] = [];
  if ((bits >> CP_KOREAN_WANSUNG) & 1 || (bits >> CP_KOREAN_JOHAB) & 1) declared.push('ko');
  if ((bits >> CP_CHINESE_TRADITIONAL) & 1) declared.push('zh-Hant');
  if ((bits >> CP_JAPANESE) & 1) declared.push('ja');
  if ((bits >> CP_CHINESE_SIMPLIFIED) & 1) declared.push('zh-Hans');
  return declared;
}

/** 字体名关键词消歧（只在多个 CJK 语言同时被声明时使用）。 */
function familyNameWinner(
  declared: readonly FontCjkLanguage[],
  evidence: LanguageEvidence,
): FontCjkLanguage | null {
  const votes = new Map<FontCjkLanguage, number>();
  const family = evidence.familyNames.join(' ');
  for (const [language, pattern] of FAMILY_KEYWORDS) {
    if (pattern.test(family)) {
      // 关键词命中即便该语言没有被码位声明也算一票（用于 OS/2 v0 的字体）。
      votes.set(language, (votes.get(language) ?? 0) + 1);
    }
  }
  // 本地化名字里出现假名/谚文是很强的语言信号（中文名字里不会有假名）。
  if (hasKana(evidence.localizedNames.join(' '))) {
    votes.set('ja', (votes.get('ja') ?? 0) + 1);
  }
  if (hasHangul(evidence.localizedNames.join(' '))) {
    votes.set('ko', (votes.get('ko') ?? 0) + 1);
  }
  const winner = uniqueWinner(votes);
  if (!winner) return null;
  return declared.length === 0 || declared.includes(winner) ? winner : null;
}

function uniqueWinner(
  votes: ReadonlyMap<FontCjkLanguage, number>,
): FontCjkLanguage | null {
  let best: FontCjkLanguage | null = null;
  let bestScore = 0;
  let tied = false;
  for (const [language, score] of votes) {
    if (score > bestScore) {
      best = language;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return best && !tied ? best : null;
}

/**
 * 样张文字用哪种文字：按 `preferred` 顺序挑第一个**真的有字形**（cmap 覆盖）的
 * 语言。覆盖度只决定样例文字，不决定语言标签。
 */
function sampleScriptFor(
  preferred: readonly FontCjkLanguage[],
  evidence: LanguageEvidence,
): FontSampleScript {
  for (const language of preferred) {
    if (language === 'ko' && evidence.coversHangul) return 'ko';
    if (language === 'ja' && evidence.coversKana) return 'ja';
    if (language === 'zh-Hans' && evidence.coversCjk) return 'zh-Hans';
    if (language === 'zh-Hant' && evidence.coversCjk) return 'zh-Hant';
  }
  if (evidence.coversLatin) return 'latin';
  if (evidence.coversHangul) return 'ko';
  if (evidence.coversKana) return 'ja';
  if (evidence.coversCjk) return 'zh-Hans';
  return 'latin';
}

/**
 * Read the available weights of a variable font from `fvar` (16.16 Fixed
 * coordinates). Named instances are the designer's own weight list; a font with
 * only an axis range falls back to min/default/max. Static fonts → null.
 */
function parseVariableWeights(fvar: Uint8Array | null): readonly number[] | null {
  if (!fvar || fvar.length < 16) return null;
  const axesArrayOffset = readUint16(fvar, 4);
  const axisCount = readUint16(fvar, 8);
  const axisSize = readUint16(fvar, 10);
  const instanceCount = readUint16(fvar, 12);
  const instanceSize = readUint16(fvar, 14);
  if (axisCount <= 0 || axisSize < 20) return null;

  let weightAxis = -1;
  let axisMin = 0;
  let axisDefault = 0;
  let axisMax = 0;
  for (let index = 0; index < axisCount; index += 1) {
    const record = axesArrayOffset + index * axisSize;
    if (record + 20 > fvar.length) return null;
    if (readTag(fvar, record) !== 'wght') continue;
    weightAxis = index;
    axisMin = readFixed(fvar, record + 4);
    axisDefault = readFixed(fvar, record + 8);
    axisMax = readFixed(fvar, record + 12);
    break;
  }
  if (weightAxis < 0) return null;

  const instancesStart = axesArrayOffset + axisCount * axisSize;
  const weights = new Set<number>();
  for (let index = 0; index < instanceCount; index += 1) {
    const record = instancesStart + index * instanceSize;
    const coordinate = record + 4 + weightAxis * 4;
    if (instanceSize < 4 + axisCount * 4 || coordinate + 4 > fvar.length) break;
    const value = readFixed(fvar, coordinate);
    if (value > 0) weights.add(Math.round(value));
  }
  if (weights.size < 2) {
    for (const value of [axisMin, axisDefault, axisMax]) {
      if (value > 0) weights.add(Math.round(value));
    }
  }
  const sorted = [...weights].sort((left, right) => left - right);
  // 只有一个值的“可变”字体对用户没有选择意义。
  return sorted.length >= 2 ? sorted : null;
}

/** 16.16 Fixed → number. */
function readFixed(bytes: Uint8Array, offset: number): number {
  const raw = readUint32(bytes, offset);
  const signed = raw >= 0x80000000 ? raw - 0x100000000 : raw;
  return signed / 65536;
}

/** Resolve the table directory + data for any supported container. */
function resolveFontTables(
  bytes: Uint8Array,
): { tables: Map<string, TableRecord>; data: Uint8Array } | null {
  const signature = readTag(bytes, 0);
  if (signature === 'ttcf') {
    const numFonts = readUint32(bytes, 8);
    if (numFonts < 1) return null;
    const tables = sfntTables(bytes, readUint32(bytes, 12));
    return tables ? { tables, data: bytes } : null;
  }
  if (signature === 'wOFF') {
    const tables = woff1Tables(bytes);
    return tables ? { tables, data: bytes } : null;
  }
  if (signature === 'wOF2') return parseWoff2(bytes);
  const tables = sfntTables(bytes, 0);
  return tables ? { tables, data: bytes } : null;
}

/** 解析字体元信息；不是可识别的字体或关键表缺失时返回 null。 */
export function parseFontMetadata(input: Uint8Array): FontMetadata | null {
  const bytes = input;
  if (bytes.length < 16) return null;
  const resolved = resolveFontTables(bytes);
  if (!resolved) return null;
  const { tables, data } = resolved;
  if (tables.size === 0) return null;

  const nameTable = tableBytes(data, tables, 'name');
  const head = tableBytes(data, tables, 'head');
  const os2 = tableBytes(data, tables, 'OS/2');
  const maxp = tableBytes(data, tables, 'maxp');
  const cmap = tableBytes(data, tables, 'cmap');
  const fvar = tableBytes(data, tables, 'fvar');
  if (!nameTable && !head && !os2) return null;

  const names = nameTable ? parseNameTable(nameTable) : [];
  const fsSelection = os2 && os2.length >= 64 ? readUint16(os2, 62) : 0;
  // ulCodePageRange1/2 是 OS/2 v1 才有的字段：v0 的字体读到的字节不是位标志。
  const hasCodePageRange =
    os2 !== null && os2.length >= 82 && readUint16(os2, 0) > 0;
  const codePageBits = hasCodePageRange && os2 ? readUint32(os2, 78) : 0;
  const namesById = (ids: readonly number[]): NameRecord[] =>
    names.filter((record) => ids.includes(record.nameId));
  const familyRecords = namesById([1, 4, 16]);
  const language = resolveLanguage({
    codePageBits,
    hasCodePageRange,
    nameLocales: [...new Set(names.map((record) => record.languageId))],
    familyNames: familyRecords.map((record) => record.value),
    // 非英文名字（本地化家族名）里出现假名/谚文是强语言信号。
    localizedNames: familyRecords
      .filter((record) => record.languageId !== 0x409 && record.languageId !== 0)
      .map((record) => record.value),
    coversLatin: cmapCovers(cmap, PROBE_LATIN),
    coversKana:
      cmapCovers(cmap, PROBE_HIRAGANA) || cmapCovers(cmap, PROBE_KATAKANA),
    coversHangul: cmapCovers(cmap, PROBE_HANGUL),
    coversCjk: cmapCovers(cmap, PROBE_CJK),
  });
  return {
    family: pickName(names, 1),
    subfamily: pickName(names, 2),
    fullName: pickName(names, 4),
    version: pickName(names, 5),
    manufacturer: pickName(names, 8),
    copyright: pickName(names, 0),
    weightClass: os2 && os2.length >= 6 ? readUint16(os2, 4) : null,
    widthClass: os2 && os2.length >= 8 ? readUint16(os2, 6) : null,
    isBold: (fsSelection & 0x20) !== 0,
    isItalic: (fsSelection & 0x01) !== 0,
    unitsPerEm: head && head.length >= 20 ? readUint16(head, 18) : null,
    glyphCount: maxp && maxp.length >= 6 ? readUint16(maxp, 4) : null,
    language,
    variableWeights: parseVariableWeights(fvar),
  };
}
