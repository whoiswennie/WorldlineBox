import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseFontMetadata,
  parseFontLanguage,
} from '../../src/shared/font-metadata';

// WorldlineBox-485aeb：字体元信息解析（TTC/TTF/OTF/WOFF/WOFF2）+ 语言判定。
//
// fixture 用仓库内已提交的真实字体与 node_modules 里的 Web 字体，不引入新的二进制；
// CJK 语言判定用合成字体（真实 CJK 字体有授权与体积问题），覆盖实测得到的判据：
// OS/2 ulCodePageRange 位 + name 表语言 ID/字体名，且**绝不用 cmap 覆盖度猜语言**
// （实测 1171 个系统字体里 194 个含假名却是中文/韩文）。
const DEJAVU = readFileSync(
  path.join(process.cwd(), 'resources', 'fonts', 'DejaVuSans.ttf'),
);
const WOFF2 = readFileSync(
  path.join(
    process.cwd(),
    'node_modules',
    '@fontsource',
    'ibm-plex-mono',
    'files',
    'ibm-plex-mono-latin-400-normal.woff2',
  ),
);
const WOFF = readFileSync(
  path.join(
    process.cwd(),
    'node_modules',
    '@fontsource',
    'ibm-plex-mono',
    'files',
    'ibm-plex-mono-latin-400-normal.woff',
  ),
);

import {
  CODE_PAGE_BIT as CP,
  CJK_LIKE_CODE_POINTS as CJK_LIKE,
  LATIN_ONLY_CODE_POINTS as LATIN_ONLY,
  buildSyntheticSfnt as buildSfnt,
} from '../helpers/synthetic-font';

describe('parseFontMetadata', () => {
  it('reads the family, metrics and language of a real TTF', () => {
    const metadata = parseFontMetadata(DEJAVU);
    expect(metadata).not.toBeNull();
    expect(metadata?.family).toBe('DejaVu Sans');
    expect(metadata?.subfamily).toBe('Book');
    expect(metadata?.unitsPerEm).toBe(2048);
    expect(metadata?.glyphCount).toBeGreaterThan(1000);
    expect(metadata?.isBold).toBe(false);
    expect(metadata?.isItalic).toBe(false);
    expect(metadata?.language.resolved).toBe('latin');
    expect(metadata?.language.declared).toEqual([]);
    expect(metadata?.language.coversLatin).toBe(true);
  });

  it('reads WOFF and WOFF2 containers', () => {
    const woff2 = parseFontMetadata(WOFF2);
    const woff = parseFontMetadata(WOFF);
    expect(woff2?.family).toBe('IBM Plex Mono');
    expect(woff?.family).toBe('IBM Plex Mono');
    expect(woff2?.weightClass).toBe(400);
    expect(woff2?.language.resolved).toBe('latin');
    expect(woff2?.glyphCount).toBeGreaterThan(0);
  });

  it('reads the first font of a TTC collection', () => {
    const single = buildSfnt({
      family: 'Fixture Family',
      codePoints: LATIN_ONLY,
      tableOffsetBase: 16,
    });
    const header = Buffer.alloc(16);
    header.write('ttcf', 0, 'latin1');
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt32BE(1, 8); // numFonts
    header.writeUInt32BE(16, 12); // offset of the first font
    const metadata = parseFontMetadata(
      new Uint8Array(Buffer.concat([header, Buffer.from(single)])),
    );
    expect(metadata?.family).toBe('Fixture Family');
  });

  it('carries weight and style flags from OS/2', () => {
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'Fixture Bold',
        codePoints: LATIN_ONLY,
        fsSelection: 0x21, // ITALIC | BOLD
        weightClass: 700,
      }),
    );
    expect(metadata?.weightClass).toBe(700);
    expect(metadata?.isBold).toBe(true);
    expect(metadata?.isItalic).toBe(true);
  });

  it('returns null instead of throwing on non-font input', () => {
    expect(parseFontMetadata(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseFontMetadata(new Uint8Array(0))).toBeNull();
    expect(parseFontMetadata(new Uint8Array(4096))).toBeNull();
    // 截断的真实字体：表目录指向文件外，必须安全失败而不是抛异常。
    expect(parseFontMetadata(DEJAVU.subarray(0, 200))).toBeNull();
    expect(parseFontMetadata(DEJAVU.subarray(0, 4))).toBeNull();
  });
});

describe('font language detection', () => {
  it('classifies a Chinese font that contains kana as Simplified Chinese', () => {
    // 回归：cmap 里有假名**不代表**是日文。微软雅黑/宋体/等线都含假名，但只声明
    // GB2312 —— 第一版按「有假名 → 日文」把它们全判错了（实测 194 个字体）。
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'Fixture YaHei',
        codePoints: CJK_LIKE,
        codePageBits: 1 << CP.chineseSimplified,
      }),
    );
    expect(metadata?.language.declared).toEqual(['zh-Hans']);
    expect(metadata?.language.resolved).toBe('zh-Hans');
    expect(metadata?.language.source).toBe('code-page');
    expect(metadata?.language.sampleScript).toBe('zh-Hans');
  });

  it('never claims Japanese from kana coverage alone', () => {
    // 覆盖度高但没有任何 CJK 码位声明：只敢说拉丁文（很多拉丁字体内含 CJK 字形）。
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'Fixture Broad',
        codePoints: CJK_LIKE,
        codePageBits: 1 << CP.latin1,
      }),
    );
    expect(metadata?.language.declared).toEqual([]);
    expect(metadata?.language.resolved).toBe('latin');
    expect(metadata?.language.source).toBe('coverage');
  });

  it('uses the declared code page bits for each CJK language', () => {
    const cases: Array<[number, string]> = [
      [CP.japanese, 'ja'],
      [CP.chineseSimplified, 'zh-Hans'],
      [CP.chineseTraditional, 'zh-Hant'],
      [CP.koreanWansung, 'ko'],
      [CP.koreanJohab, 'ko'],
    ];
    for (const [bit, expected] of cases) {
      const metadata = parseFontMetadata(
        buildSfnt({
          family: `Fixture ${expected}`,
          codePoints: CJK_LIKE,
          codePageBits: 1 << bit,
        }),
      );
      expect(metadata?.language.resolved).toBe(expected);
      expect(metadata?.language.source).toBe('code-page');
    }
  });

  it('keeps Blender priority order when several CJK bits are set', () => {
    // 韩文优先于中文（五个位全占的字体实测就是韩文，如 Malgun Semilight）。
    const all = [17, 18, 19, 20, 21].reduce((bits, bit) => bits | (1 << bit), 0);
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'Fixture AllCjk',
        codePoints: CJK_LIKE,
        codePageBits: all,
      }),
    );
    expect(metadata?.language.declared).toEqual(['ko', 'zh-Hant', 'ja', 'zh-Hans']);
    expect(metadata?.language.resolved).toBe('ko');
  });

  it('breaks a JIS+GB2312 tie with the font name', () => {
    // Noto Sans JP 与思源黑体 CN 的码位声明完全相同（JIS+GB2312），只能靠字体名。
    const both = (1 << CP.japanese) | (1 << CP.chineseSimplified);
    const japanese = parseFontMetadata(
      buildSfnt({
        family: 'Noto Sans JP',
        codePoints: CJK_LIKE,
        codePageBits: both,
      }),
    );
    expect(japanese?.language.resolved).toBe('ja');
    expect(japanese?.language.source).toBe('family-name');

    const simplified = parseFontMetadata(
      buildSfnt({
        family: 'Source Han Sans CN',
        codePoints: CJK_LIKE,
        codePageBits: both,
      }),
    );
    expect(simplified?.language.resolved).toBe('zh-Hans');
    expect(simplified?.language.source).toBe('family-name');
  });

  it('prefers name-table locales over family keywords', () => {
    const both = (1 << CP.japanese) | (1 << CP.chineseSimplified);
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'Ambiguous Fixture',
        codePoints: CJK_LIKE,
        codePageBits: both,
        nameRecords: [
          { nameId: 1, languageId: 0x409, value: 'Ambiguous Fixture' },
          { nameId: 1, languageId: 0x804, value: '示例字体' },
        ],
      }),
    );
    expect(metadata?.language.resolved).toBe('zh-Hans');
    expect(metadata?.language.source).toBe('name-locale');
  });

  it('reports declared languages without guessing when nothing disambiguates', () => {
    const both = (1 << CP.japanese) | (1 << CP.chineseSimplified);
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'H-Unknown',
        codePoints: CJK_LIKE,
        codePageBits: both,
      }),
    );
    expect(metadata?.language.declared).toEqual(['ja', 'zh-Hans']);
    // 不猜：resolved 为 null，卡片走中性封面。
    expect(metadata?.language.resolved).toBeNull();
    expect(metadata?.language.source).toBe('none');
  });

  it('falls back to the font name when OS/2 is version 0', () => {
    const v0 = parseFontMetadata(
      buildSfnt({
        family: 'Meiryo UI',
        codePoints: CJK_LIKE,
        os2Version: 0,
        // v0 没有 code page 字段：即使写上 GB2312 位也必须忽略。
        codePageBits: 1 << CP.chineseSimplified,
      }),
    );
    expect(v0?.language.declared).toEqual([]);
    expect(v0?.language.resolved).toBe('ja');
    expect(v0?.language.source).toBe('family-name');

    const plainV0 = parseFontMetadata(
      buildSfnt({
        family: 'Mystery Face',
        codePoints: CJK_LIKE,
        os2Version: 0,
      }),
    );
    expect(plainV0?.language.resolved).toBe('latin');
    expect(plainV0?.language.source).toBe('coverage');
  });

  it('treats CJK-only fonts (no Latin) as their declared script', () => {
    const metadata = parseFontMetadata(
      buildSfnt({
        family: 'Fixture NoLatin',
        codePoints: [0x3042, 0x30a2, 0x4e00],
        codePageBits: 1 << CP.chineseTraditional,
      }),
    );
    expect(metadata?.language.resolved).toBe('zh-Hant');
    expect(metadata?.language.sampleScript).toBe('zh-Hant');
    expect(metadata?.language.coversLatin).toBe(false);
  });
});

describe('variable font weights (fvar)', () => {
  it('lists the named instances of a variable font', () => {
    // 只有一个字重的静态字体不能提供字重选项（用户反馈第 1 条）。
    expect(
      parseFontMetadata(buildSfnt({ family: 'Static', codePoints: LATIN_ONLY }))
        ?.variableWeights,
    ).toBeNull();
    const variable = parseFontMetadata(
      buildSfnt({
        family: 'Variable',
        codePoints: LATIN_ONLY,
        variableWeights: [100, 400, 700],
      }),
    );
    expect(variable?.variableWeights).toEqual([100, 400, 700]);
  });

  it('falls back to the axis range when there are no usable instances', () => {
    const variable = parseFontMetadata(
      buildSfnt({
        family: 'AxisOnly',
        codePoints: LATIN_ONLY,
        variableWeights: [400],
        weightAxisRange: { min: 200, max: 900 },
      }),
    );
    // 命名实例只有一个 400：用轴范围 min/default/max 补出可选字重。
    expect(variable?.variableWeights).toEqual([200, 400, 900]);
  });

  it('reads the real variable font shipped with the app', () => {
    const variableSubset = readFileSync(
      path.join(
        process.cwd(),
        'node_modules',
        '@fontsource-variable',
        'noto-sans-sc',
        'files',
        'noto-sans-sc-100-wght-normal.woff2',
      ),
    );
    const metadata = parseFontMetadata(variableSubset);
    expect(metadata?.family).toContain('Noto Sans SC');
    // 真实可变字体：wght 轴给出多个可选字重；语言仍是简体中文。
    expect(metadata?.variableWeights?.length ?? 0).toBeGreaterThan(1);
    expect(metadata?.language.resolved).toBe('zh-Hans');
  });
});

describe('sample sheet language tokens', () => {
  it('accepts only known label languages', () => {
    expect(parseFontLanguage('ja')).toBe('ja');
    expect(parseFontLanguage('zh-Hans')).toBe('zh-Hans');
    expect(parseFontLanguage('zh-Hant')).toBe('zh-Hant');
    expect(parseFontLanguage('ko')).toBe('ko');
    expect(parseFontLanguage('latin')).toBe('latin');
    expect(parseFontLanguage('zh')).toBeNull();
    expect(parseFontLanguage('cyrillic')).toBeNull();
    expect(parseFontLanguage(null)).toBeNull();
  });
});
