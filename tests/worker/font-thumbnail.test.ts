import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';
import { FONT_THUMBNAIL_GENERATOR_VERSION, FONT_THUMBNAIL_HEIGHT } from '../../src/shared/document-thumbnail-protocol';
import {
  CODE_PAGE_BIT,
  CJK_LIKE_CODE_POINTS,
  buildSyntheticSfnt,
} from '../helpers/synthetic-font';
import { importNoConflict as sharedImportNoConflict } from './import-no-conflict';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-font-thumb-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

function importNoConflict(
  service: LibraryService,
  libraryId: string,
  filePath: string,
): void {
  sharedImportNoConflict(service, libraryId, filePath);
}

// WorldlineBox-485aeb：字体卡片走 offscreen 样张页（sample=font），产物单独打版本标签。
describe('font thumbnail generation', () => {
  it('captures the offscreen font sample page and stores it as a thumbnail artifact', async () => {
    const root = temporaryRoot();
    const capturedUrls: string[] = [];
    const service = new LibraryService({
      documentThumbnailRenderer: async ({ url, signal }) => {
        capturedUrls.push(url);
        expect(signal?.aborted ?? false).toBe(false);
        return { png: new Uint8Array(VALID_1X1_PNG), width: 1024, height: 512 };
      },
    });
    const created = service.createLibrary({ displayName: 'Fonts', selectedParentPath: root });
    const fontPath = path.join(root, 'Sample.ttf');
    // 内容不需要是真字体：这里只验证 Worker 侧的取源与产物落库；
    // 真实字形解码由 E2E（真实 DejaVuSans.ttf）与字体样张页单测覆盖。
    writeFileSync(fontPath, Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01]));
    importNoConflict(service, created.libraryId, fontPath);

    const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;
    expect(asset.mediaType).toBe('font');

    const result = await service.generateThumbnail({
      libraryId: created.libraryId,
      assetId: asset.assetId,
    });
    expect(result?.artifactId).toBeTruthy();
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('worldlinebox://source/');
    expect(capturedUrls[0]).toContain('sample=font');
    expect(capturedUrls[0]).toContain('revision=');

    const listed = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;
    expect(listed.thumbnailStatus).toBe('ready');
    expect(listed.thumbnailArtifactId).toBeTruthy();
    service.closeAll();
  });

  it('keeps font artifacts valid under the font generator version only', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const created = service.createLibrary({ displayName: 'FontsVersion', selectedParentPath: root });
    const fontPath = path.join(root, 'Sample.woff2');
    writeFileSync(fontPath, Buffer.from('wOF2'));
    importNoConflict(service, created.libraryId, fontPath);
    const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;
    expect(asset.mediaType).toBe('font');
    // 版本标签常量存在且与文档渲染区分开（避免字体样张被判 stale）。
    expect(FONT_THUMBNAIL_GENERATOR_VERSION).not.toBe('offscreen-web-1');
    service.closeAll();
  });

  it('enqueues a font thumbnail job through the extension gate', () => {
    const root = temporaryRoot();
    const service = new LibraryService({
      documentThumbnailRenderer: async () => ({
        png: new Uint8Array(VALID_1X1_PNG),
        width: 1024,
        height: 512,
      }),
    });
    const created = service.createLibrary({ displayName: 'FontQueue', selectedParentPath: root });
    const fontPath = path.join(root, 'Queued.ttf');
    writeFileSync(fontPath, Buffer.from([0x00, 0x01, 0x00, 0x00]));
    importNoConflict(service, created.libraryId, fontPath);
    const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;
    const enqueued = service.enqueueThumbnailJobs(created.libraryId, {
      assetIds: [asset.assetId],
    });
    expect(enqueued).toBeGreaterThan(0);
    service.closeAll();
  });

  // WorldlineBox-485aeb：样张页要带上真实字体解析出的家族名与语言标签。
  it('passes the parsed family and language to the sample page', async () => {
    const root = temporaryRoot();
    const capturedUrls: string[] = [];
    const capturedHeights: Array<number | undefined> = [];
    const service = new LibraryService({
      documentThumbnailRenderer: async ({ url, height }) => {
        capturedUrls.push(url);
        capturedHeights.push(height);
        return { png: new Uint8Array(VALID_1X1_PNG), width: 1024, height: 512 };
      },
    });
    const created = service.createLibrary({ displayName: 'FontFacts', selectedParentPath: root });
    const fontPath = path.join(root, 'DejaVuSans.ttf');
    copyFileSync(
      path.resolve(__dirname, '..', '..', 'resources', 'fonts', 'DejaVuSans.ttf'),
      fontPath,
    );
    importNoConflict(service, created.libraryId, fontPath);
    const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;

    await service.generateThumbnail({
      libraryId: created.libraryId,
      assetId: asset.assetId,
    });
    const url = new URL(capturedUrls[0]!);
    expect(url.searchParams.get('family')).toBe('DejaVu Sans');
    expect(url.searchParams.get('lang')).toBe('latin');
    // 封面样例字符固定是 AaBbCc 0123：样张 URL 不再需要 script 参数。
    expect(url.searchParams.get('script')).toBeNull();
    // 16:9 采集（用户反馈：卡片封面不要 4:3）。
    expect(capturedHeights[0]).toBe(FONT_THUMBNAIL_HEIGHT);

    // Inspector 直接读字体文件，不依赖 extracted_metadata 产物。
    const metadata = service.getExtractedMetadata({
      libraryId: created.libraryId,
      assetId: asset.assetId,
    });
    expect(metadata.status).toBe('ready');
    expect(metadata.metadata?.fontFamily).toBe('DejaVu Sans');
    expect(metadata.metadata?.fontLanguage).toBe('latin');
    expect(metadata.metadata?.fontLanguages).toEqual([]);
    expect(metadata.metadata?.fontCoversLatin).toBe(true);
    // 静态字体只有一套字形：不提供字重选项。
    expect(metadata.metadata?.fontVariableWeights ?? null).toBeNull();
    expect(metadata.metadata?.fontGlyphCount).toBeGreaterThan(1000);
    service.closeAll();
  });

  // WorldlineBox-485aeb 回归：含假名的中文字体必须判成简体中文，而不是日文；
  // 判定不出来的字体不能写语言标签（封面走中性文案）。
  it('labels CJK fonts from their code page bits and omits an unknown language', async () => {
    const root = temporaryRoot();
    const capturedUrls: string[] = [];
    const service = new LibraryService({
      documentThumbnailRenderer: async ({ url }) => {
        capturedUrls.push(url);
        return { png: new Uint8Array(VALID_1X1_PNG), width: 1024, height: 512 };
      },
    });
    const created = service.createLibrary({ displayName: 'FontCjk', selectedParentPath: root });

    const chinesePath = path.join(root, 'YaHeiLike.ttf');
    writeFileSync(
      chinesePath,
      buildSyntheticSfnt({
        family: 'YaHeiLike',
        codePoints: CJK_LIKE_CODE_POINTS,
        codePageBits: 1 << CODE_PAGE_BIT.chineseSimplified,
      }),
    );
    const japanesePath = path.join(root, 'MeiryoLike.ttf');
    writeFileSync(
      japanesePath,
      buildSyntheticSfnt({
        family: 'MeiryoLike',
        codePoints: CJK_LIKE_CODE_POINTS,
        codePageBits: 1 << CODE_PAGE_BIT.japanese,
      }),
    );
    // JIS + GB2312 同时声明且没有任何可消歧的名字 → 不写 lang。
    const ambiguousPath = path.join(root, 'Ambiguous.ttf');
    writeFileSync(
      ambiguousPath,
      buildSyntheticSfnt({
        family: 'Ambiguous',
        codePoints: CJK_LIKE_CODE_POINTS,
        codePageBits:
          (1 << CODE_PAGE_BIT.japanese) | (1 << CODE_PAGE_BIT.chineseSimplified),
      }),
    );
    importNoConflict(service, created.libraryId, chinesePath);
    importNoConflict(service, created.libraryId, japanesePath);
    importNoConflict(service, created.libraryId, ambiguousPath);

    for (const asset of service.listAssets({
      libraryId: created.libraryId,
      recursive: true,
    })) {
      await service.generateThumbnail({
        libraryId: created.libraryId,
        assetId: asset.assetId,
      });
    }
    const paramsByName = new Map(
      capturedUrls.map((raw) => {
        const url = new URL(raw);
        return [url.searchParams.get('family'), url.searchParams];
      }),
    );
    expect(paramsByName.get('YaHeiLike')?.get('lang')).toBe('zh-Hans');
    expect(paramsByName.get('MeiryoLike')?.get('lang')).toBe('ja');
    expect(paramsByName.get('Ambiguous')?.get('lang')).toBeNull();
    // 任何字体都不带 script：封面永远画 AaBbCc 0123。
    for (const params of paramsByName.values()) {
      expect(params?.get('script')).toBeNull();
    }
    service.closeAll();
  });

  it('reports unreadable font data without inventing fields', async () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const created = service.createLibrary({ displayName: 'FontBroken', selectedParentPath: root });
    const fontPath = path.join(root, 'Broken.ttf');
    writeFileSync(fontPath, Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x01]));
    importNoConflict(service, created.libraryId, fontPath);
    const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;
    const metadata = service.getExtractedMetadata({
      libraryId: created.libraryId,
      assetId: asset.assetId,
    });
    expect(metadata.status).toBe('failed');
    expect(metadata.metadata).toBeNull();
    expect(metadata.errorCode).toBe('FONT_METADATA_UNREADABLE');
    service.closeAll();
  });
});
