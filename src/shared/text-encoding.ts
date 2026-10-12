/**
 * Detect and decode text-file bytes for preview/viewer.
 *
 * Flow matches VS Code's `encoding.ts`: BOM, UTF-16 / binary from NUL
 * pattern, then a statistical detector. VS Code uses LGPL `jschardet`;
 * this module uses MIT `chardet` (ICU / Mozilla universalchardet).
 *
 * Homemade GBK-vs-EUC-KR scoring is not used: those encodings overlap
 * in lead/trail bytes, and CJK Unified Ideographs also appear in Big5
 * mojibake, so a glyph-count score picks the wrong language.
 */

import { analyse } from "chardet";

export type DetectedTextEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "gb18030"
  | "big5"
  | "shift_jis"
  | "euc-jp"
  | "euc-kr"
  | "windows-1252";

export type DecodedTextBytes = {
  encoding: DetectedTextEncoding;
  text: string;
  binary: boolean;
};

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

/** Same cap as VS Code `AUTO_ENCODING_GUESS_MAX_BYTES`. */
const AUTO_ENCODING_GUESS_MAX_BYTES = 512 * 128;

const IGNORE_CHARDET_NAMES = new Set([
  "ASCII",
  "UTF-8",
  "UTF-16",
  "UTF-16BE",
  "UTF-16LE",
  "UTF-32",
  "UTF-32BE",
  "UTF-32LE",
]);

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function utf8SequenceLength(lead: number): number {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 0;
}

/** Drop a trailing incomplete UTF-8 sequence so truncation is not fatal. */
export function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return bytes;
  let index = bytes.length - 1;
  while (index >= 0 && (bytes[index]! & 0xc0) === 0x80) index -= 1;
  if (index < 0) return bytes.subarray(0, 0);
  const expected = utf8SequenceLength(bytes[index]!);
  if (expected === 0 || expected > bytes.length - index) {
    return bytes.subarray(0, index);
  }
  return bytes;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  const trimmed = trimIncompleteUtf8(bytes);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(trimmed);
    return true;
  } catch {
    return false;
  }
}

function nulRatioByParity(bytes: Uint8Array): { even: number; odd: number; pairs: number } {
  const limit = Math.min(bytes.length, 4096);
  const pairs = Math.floor(limit / 2);
  let even = 0;
  let odd = 0;
  for (let index = 0; index + 1 < limit; index += 2) {
    if (bytes[index] === 0) even += 1;
    if (bytes[index + 1] === 0) odd += 1;
  }
  return { even, odd, pairs };
}

function looksLikeUtf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const { even, odd, pairs } = nulRatioByParity(bytes);
  if (pairs < 4) return null;
  const evenRatio = even / pairs;
  const oddRatio = odd / pairs;
  if (oddRatio >= 0.3 && evenRatio <= 0.1) return "utf-16le";
  if (evenRatio >= 0.3 && oddRatio <= 0.1) return "utf-16be";
  return null;
}

function decodeLabel(label: string, bytes: Uint8Array): string {
  return new TextDecoder(label).decode(bytes);
}

function mapChardetName(name: string): DetectedTextEncoding | null {
  switch (name) {
    case "GB18030":
      return "gb18030";
    case "Big5":
      return "big5";
    case "Shift_JIS":
      return "shift_jis";
    case "EUC-JP":
      return "euc-jp";
    case "EUC-KR":
      return "euc-kr";
    case "windows-1252":
    case "ISO-8859-1":
      return "windows-1252";
    default:
      return null;
  }
}

type MappedMatch = { encoding: DetectedTextEncoding; confidence: number };

/**
 * ICU MBCS recognizers all return confidence 10 when there are few
 * double-byte characters. `chardet` then sorts Shift_JIS first because
 * that recognizer is registered first — short GBK samples become Japanese
 * or Korean. Prefer GB18030 only among a tied top score.
 */
function orderLegacyCandidates(mapped: MappedMatch[]): DetectedTextEncoding[] {
  const top = mapped[0]!.confidence;
  const tied = mapped.filter((item) => item.confidence === top).map((item) => item.encoding);
  const rest = mapped.filter((item) => item.confidence < top).map((item) => item.encoding);
  const preferred = tied.includes("gb18030")
    ? ["gb18030" as const, ...tied.filter((encoding) => encoding !== "gb18030")]
    : tied;
  const seen = new Set<DetectedTextEncoding>();
  const ordered: DetectedTextEncoding[] = [];
  for (const encoding of [...preferred, ...rest]) {
    if (seen.has(encoding)) continue;
    seen.add(encoding);
    ordered.push(encoding);
  }
  return ordered;
}

function pickLegacyEncoding(bytes: Uint8Array): DetectedTextEncoding {
  const sample =
    bytes.length > AUTO_ENCODING_GUESS_MAX_BYTES
      ? bytes.subarray(0, AUTO_ENCODING_GUESS_MAX_BYTES)
      : bytes;
  let mapped: MappedMatch[];
  try {
    mapped = analyse(sample).flatMap((match) => {
      if (IGNORE_CHARDET_NAMES.has(match.name)) return [];
      const encoding = mapChardetName(match.name);
      if (!encoding || encoding === "utf-8") return [];
      return [{ encoding, confidence: match.confidence }];
    });
  } catch {
    return "windows-1252";
  }
  if (mapped.length === 0) return "windows-1252";
  return orderLegacyCandidates(mapped)[0] ?? "windows-1252";
}

export function decodeTextBytes(bytes: Uint8Array): DecodedTextBytes {
  if (bytes.length === 0) {
    return { encoding: "utf-8", text: "", binary: false };
  }

  if (startsWith(bytes, UTF8_BOM)) {
    const body = bytes.subarray(3);
    return {
      encoding: "utf-8",
      text: decodeLabel("utf-8", trimIncompleteUtf8(body)),
      binary: false,
    };
  }
  if (startsWith(bytes, UTF16LE_BOM) && !startsWith(bytes, [0xff, 0xfe, 0x00, 0x00])) {
    return {
      encoding: "utf-16le",
      text: decodeLabel("utf-16le", bytes.subarray(2)),
      binary: false,
    };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return {
      encoding: "utf-16be",
      text: decodeLabel("utf-16be", bytes.subarray(2)),
      binary: false,
    };
  }

  const utf16 = looksLikeUtf16(bytes);
  if (utf16) {
    return { encoding: utf16, text: decodeLabel(utf16, bytes), binary: false };
  }

  let nulCount = 0;
  const sample = Math.min(bytes.length, 4096);
  for (let index = 0; index < sample; index += 1) {
    if (bytes[index] === 0) nulCount += 1;
  }
  if (nulCount > sample * 0.02) {
    return { encoding: "utf-8", text: "", binary: true };
  }

  if (isValidUtf8(bytes)) {
    return {
      encoding: "utf-8",
      text: decodeLabel("utf-8", trimIncompleteUtf8(bytes)),
      binary: false,
    };
  }

  const encoding = pickLegacyEncoding(bytes);
  return {
    encoding,
    text: decodeLabel(encoding, bytes),
    binary: false,
  };
}
