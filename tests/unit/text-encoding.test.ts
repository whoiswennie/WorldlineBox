import { describe, expect, it } from "vitest";

import { decodeTextBytes } from "../../src/shared/text-encoding";
import {
  BIG5_ZH_README_HEX,
  bytesFromHex,
  EUC_KR_KO_README_HEX,
  GBK_ZH_README_HEX,
  GBK_ZH_TITLE_HEX,
  SHIFT_JIS_JA_README_HEX,
} from "../fixtures/text-encoding/legacy-text-samples";

describe("decodeTextBytes", () => {
  it("keeps UTF-8 Chinese intact", () => {
    const bytes = Buffer.from("玻璃破碎说明\n", "utf8");
    const decoded = decodeTextBytes(bytes);
    expect(decoded.binary).toBe(false);
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.text).toContain("玻璃破碎");
  });

  it("strips a UTF-8 BOM", () => {
    const decoded = decodeTextBytes(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("ok", "utf8")]),
    );
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.text).toBe("ok");
  });

  it("decodes a GBK Chinese paragraph as gb18030, not Korean", () => {
    const bytes = bytesFromHex(GBK_ZH_README_HEX);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
    const decoded = decodeTextBytes(bytes);
    expect(decoded.binary).toBe(false);
    expect(decoded.encoding).toBe("gb18030");
    expect(decoded.text).toContain("简体中文");
    expect(decoded.text).not.toMatch(/[\uac00-\ud7af]/);
  });

  it("decodes a short GBK title as Chinese", () => {
    const bytes = bytesFromHex(GBK_ZH_TITLE_HEX);
    const decoded = decodeTextBytes(bytes);
    expect(decoded.encoding).toBe("gb18030");
    expect(decoded.text).toContain("【严正声明】");
  });

  it("decodes a Hangul paragraph as euc-kr", () => {
    const decoded = decodeTextBytes(bytesFromHex(EUC_KR_KO_README_HEX));
    expect(decoded.encoding).toBe("euc-kr");
    expect(decoded.text).toContain("한글");
  });

  it("decodes a Big5 paragraph as big5", () => {
    const decoded = decodeTextBytes(bytesFromHex(BIG5_ZH_README_HEX));
    expect(decoded.encoding).toBe("big5");
    expect(decoded.text).toContain("繁體中文");
  });

  it("decodes a Shift_JIS paragraph as shift_jis", () => {
    const decoded = decodeTextBytes(bytesFromHex(SHIFT_JIS_JA_README_HEX));
    expect(decoded.encoding).toBe("shift_jis");
    expect(decoded.text).toContain("日本語");
  });

  it("decodes UTF-16LE with a BOM", () => {
    const decoded = decodeTextBytes(Buffer.from("\uFEFF文本", "utf16le"));
    expect(decoded.encoding).toBe("utf-16le");
    expect(decoded.text).toContain("文本");
  });

  it("rejects a NUL-heavy buffer that is not UTF-16 as binary", () => {
    const bytes = Buffer.alloc(80, 0x41);
    bytes[11] = 0;
    bytes[17] = 0;
    bytes[29] = 0;
    bytes[53] = 0;
    const decoded = decodeTextBytes(bytes);
    expect(decoded.binary).toBe(true);
  });
});
