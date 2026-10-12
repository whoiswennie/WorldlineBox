/**
 * Synthetic legacy-encoded bytes. Generated with Windows code pages
 * 936 / 949 / 950 / 932; not taken from any user library.
 */

/** GBK (cp936): Simplified Chinese paragraph, invalid as UTF-8. */
export const GBK_ZH_README_HEX =
  "b1becbb5c3f7bdf6d3c3d3dab2e2cad4b1e0c2ebcab6b1f0a1a3c7ebcab9d3c3bcf2cce5d6d0cec4d4c4b6c1a1a3d7cad4b4b0fcc4dab3a3bcfbceb4b4f8424f4db5c447424bcbb5c3f7cec4bcfea1a3b2bbd2aab0d1d5e2b6cecab6b1f0b3c9baabcec4bbf2c8d5cec4a1a3";

/** GBK title only: 【严正声明】 + CRLF. */
export const GBK_ZH_TITLE_HEX = "a1bed1cfd5fdc9f9c3f7a1bf0d0a";

/** Windows code page 949 Hangul paragraph. */
export const EUC_KR_KO_README_HEX =
  "c0cc20b9aebcadb4c220c0cec4dab5f920c5d7bdbac6aebfebc0d4b4cfb4d92e20c7d1b1dbb8b820c6f7c7d4c7d5b4cfb4d92e20c1dfb1b9beeeb3aa20c0cfbabbbeeeb7ce20bfc0c0cec7cfb8e920bec8b5cbb4cfb4d92e";

/** Big5 Traditional Chinese paragraph. */
export const BIG5_ZH_README_HEX =
  "b36fac4fc163c5e9a4a4a4e5bba1a9fac0c9a141a5cea8d3b4fab8d542696735bfebc3d1a143bdd0a4c5bb7ea750acb0c2b2c5e9a9cec1faa4e5a143";

/** Shift_JIS Japanese paragraph. */
export const SHIFT_JIS_JA_README_HEX =
  "82b182ea82cd834783938352815b836683428393834f82cc83658358836782c582b7814293fa967b8cea82cc95b68fcd82f092868d918cea82e28ad88d918cea82c68ceb944682b582c882a282c582ad82be82b382a28142";

export function bytesFromHex(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
