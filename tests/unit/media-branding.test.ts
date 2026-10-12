import { describe, expect, it } from 'vitest';
import { brandWindowsDiagnosticPaths } from '../../scripts/media-branding.mjs';

function fixture(executablePath = false): Buffer {
  const bytes = Buffer.alloc(2048);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(2, 134);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x20b, 152);
  const headers = 392;
  bytes.writeUInt32LE(256, headers + 16);
  bytes.writeUInt32LE(512, headers + 20);
  bytes.writeUInt32LE(0x20000000, headers + 36);
  bytes.writeUInt32LE(1024, headers + 40 + 16);
  bytes.writeUInt32LE(768, headers + 40 + 20);
  bytes.fill(0xab, 512, 768);
  bytes.write('C:\\Users\\Builder\\AppData\\Local\\PreviousMediaBuild\\win32-x64\\vcpkg\\buildtrees\\openimageio\\previous-x64-windows-static-rel\\bin\\oiiotool.pdb', executablePath ? 512 : 768);
  return bytes;
}

describe('media diagnostic branding', () => {
  it('preserves offsets and executable bytes while changing only the diagnostic path', () => {
    const original = fixture();
    const branded = brandWindowsDiagnosticPaths(original);
    expect(branded.length).toBe(original.length);
    expect(branded.subarray(512, 768)).toEqual(original.subarray(512, 768));
    expect(branded.toString('latin1', 768, branded.indexOf(0, 768))).toBe('C:\\Build\\WorldlineBoxMediaBuild\\win32-x64\\vcpkg\\buildtrees\\openimageio\\worldlinebox-x64-windows-static-rel\\bin\\oiiotool.pdb');
    expect(original.includes(Buffer.from('PreviousMediaBuild'))).toBe(true);
  });
  it('rejects rewriting executable sections', () => {
    expect(() => brandWindowsDiagnosticPaths(fixture(true))).toThrow('non-executable');
  });
  it('rejects rewriting signed tools', () => {
    const signed = fixture();
    signed.writeUInt32LE(1536, 152 + 112 + 4 * 8);
    expect(() => brandWindowsDiagnosticPaths(signed)).toThrow('signed');
  });
});
