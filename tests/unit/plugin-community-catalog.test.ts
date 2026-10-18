import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PLUGIN_COMMUNITY_CATALOG_URL,
  parseCatalogSha256File,
  pluginCommunityCatalogSchema,
} from '../../src/plugins/plugin-community-catalog';
import { resolvePluginDisplayCopy } from '../../src/plugins/plugin-localized-copy';
import { PluginCommunityCatalogStore } from '../../src/main/plugin-community-catalog-store';

// Captured from the real upstream feed on 2026-10-18; its published SHA-256
// was verified before recording this offline regression fixture.
// https://raw.githubusercontent.com/dolag233/Serpent-Plugin-Pool/main/catalog.v1.json
const upstreamCatalogSha256 = '035b59e3e3142b9843445fc6b93edcdd80c5133b133fc1bb9dfd846196f028ff';
const upstreamCatalogJson = `{
  "schemaVersion": 1,
  "generatedAt": "2026-09-19T16:26:16.359Z",
  "plugins": [
    {
      "id": "com.dolag.serpent.image-upscaler",
      "tier": "first-party",
      "repo": "dolag233/Serpent-Plugin-ImageUpscaler",
      "releaseTag": "v0.1.0",
      "version": "0.1.0",
      "runtimeMode": "unrestricted",
      "minSerpent": ">=0.1.0 <1.0.0",
      "name": {
        "zh-CN": "图像超分辨率",
        "en": "Image Upscaler"
      },
      "description": {
        "zh-CN": "使用 Upscayl NCNN 模型放大图片资产。",
        "en": "Upscale image assets with Upscayl NCNN models."
      },
      "assets": [
        {
          "platform": "darwin-arm64",
          "fileName": "com.dolag.serpent.image-upscaler-0.1.0-darwin-arm64.zip",
          "sha256": "dd0306389214318c1c5665373442584ef7ea2d31c22ffb37f3aef0e24917a011"
        },
        {
          "platform": "win32-x64",
          "fileName": "com.dolag.serpent.image-upscaler-0.1.0-win32-x64.zip",
          "sha256": "cc21904d5d897b8f0df6557db39f8f5c0c6e5be1e140bcfb14df2389d2afaf23"
        }
      ]
    },
    {
      "id": "com.dolag.serpent.media-converter",
      "tier": "first-party",
      "repo": "dolag233/Serpent-Plugin-MediaConverter",
      "releaseTag": "v0.1.1",
      "version": "0.1.1",
      "runtimeMode": "unrestricted",
      "minSerpent": ">=0.1.0 <1.0.0",
      "name": {
        "zh-CN": "媒体转换器",
        "en": "Media Converter"
      },
      "description": {
        "zh-CN": "批量对多媒体资产进行压缩、转码",
        "en": "Batch compress and transcode media assets."
      },
      "assets": [
        {
          "platform": "any",
          "fileName": "com.dolag.serpent.media-converter-0.1.1-any.zip",
          "sha256": "41e8ff5fbf837494fdfdb933cfd001e3c36c6d378f1504f3d5be5f1e38da3bb3"
        }
      ]
    },
    {
      "id": "com.dolag.serpent.renamer",
      "tier": "first-party",
      "repo": "dolag233/Serpent-Plugin-Renamer",
      "releaseTag": "v0.1.1",
      "version": "0.1.1",
      "runtimeMode": "unrestricted",
      "minSerpent": ">=0.2.0 <1.0.0",
      "name": {
        "zh-CN": "批量重命名",
        "en": "Batch Renamer"
      },
      "description": {
        "zh-CN": "预览并批量重命名选中的资产",
        "en": "Preview and batch-rename selected assets."
      },
      "assets": [
        {
          "platform": "any",
          "fileName": "com.dolag.serpent.renamer-0.1.1-any.zip",
          "sha256": "e48067bb0cc3d8dabb88bf970f461be4bdf55f49b6b092035464b52aa4a33da0"
        }
      ]
    }
  ],
  "removed": []
}
`;

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const catalog = {
  schemaVersion: 1 as const,
  generatedAt: '2026-09-06T00:00:00.000Z',
  plugins: [{
    id: 'com.example.palette-tools',
    tier: 'certified' as const,
    repo: 'example/worldlinebox-palette-tools',
    releaseTag: 'v1.2.0',
    version: '1.2.0',
    runtimeMode: 'restricted' as const,
    name: { 'zh-CN': '色板工具', en: 'Palette Tools' },
    description: { 'zh-CN': '提取色板。', en: 'Extract palettes.' },
    assets: [{
      platform: 'any' as const,
      fileName: 'com.example.palette-tools-1.2.0-any.zip',
      sha256: 'a'.repeat(64),
    }],
  }],
  removed: [],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plugin community catalog', () => {
  it('loads the verified upstream feed through the default URL and normalizes its external compatibility field', async () => {
    expect(createHash('sha256').update(upstreamCatalogJson).digest('hex')).toBe(upstreamCatalogSha256);
    const requested: string[] = [];
    const store = new PluginCommunityCatalogStore({
      userDataDirectory: temporaryRoot('worldlinebox-upstream-catalog-'),
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        return new Response(url.endsWith('.sha256') ? `${upstreamCatalogSha256}\n` : upstreamCatalogJson);
      },
    });
    const result = await store.load({ refresh: true });
    expect(DEFAULT_PLUGIN_COMMUNITY_CATALOG_URL)
      .toBe('https://raw.githubusercontent.com/dolag233/Serpent-Plugin-Pool/main/catalog.v1.json');
    expect(requested.sort()).toEqual([
      DEFAULT_PLUGIN_COMMUNITY_CATALOG_URL,
      `${DEFAULT_PLUGIN_COMMUNITY_CATALOG_URL}.sha256`,
    ].sort());
    expect(result.catalog.plugins).toHaveLength(3);
    expect(result.catalog.plugins[0]).toMatchObject({
      id: 'com.dolag.serpent.image-upscaler',
      repo: 'dolag233/Serpent-Plugin-ImageUpscaler',
      minWorldlineBox: '>=0.1.0 <1.0.0',
    });
    expect(result.catalog.plugins[0]).not.toHaveProperty('minSerpent');
  });

  it('keeps a custom catalog URL and WorldlineBox-specific compatibility constraints', async () => {
    const customUrl = 'https://example.test/personal-plugin-catalog.json';
    const json = JSON.stringify({
      ...catalog,
      plugins: [{ ...catalog.plugins[0], minWorldlineBox: '>=0.1.0', minSerpent: '>=0.3.0' }],
    });
    const digest = createHash('sha256').update(json).digest('hex');
    const requested: string[] = [];
    const store = new PluginCommunityCatalogStore({
      userDataDirectory: temporaryRoot('worldlinebox-custom-catalog-'),
      catalogUrl: customUrl,
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        return new Response(url.endsWith('.sha256') ? digest : json);
      },
    });
    const result = await store.load({ refresh: true });
    expect(result.sourceUrl).toBe(customUrl);
    expect(requested.sort()).toEqual([customUrl, `${customUrl}.sha256`].sort());
    expect(result.catalog.plugins[0]?.minWorldlineBox).toBe('>=0.1.0');
    expect(pluginCommunityCatalogSchema.safeParse({
      ...catalog,
      plugins: [{ ...catalog.plugins[0], minSerpent: 1 }],
    }).success).toBe(false);
  });

  it('parses a catalog document and a bare or GNU digest file', () => {
    expect(pluginCommunityCatalogSchema.parse(catalog).plugins[0]?.id).toBe('com.example.palette-tools');
    expect(parseCatalogSha256File(`${'b'.repeat(64)}\n`)).toBe('b'.repeat(64));
    expect(parseCatalogSha256File(`${'C'.repeat(64)}  catalog.v1.json\n`)).toBe('c'.repeat(64));
  });

  it('prefers catalog copy so installed English-only packages follow the app locale', () => {
    const copy = resolvePluginDisplayCopy({
      locale: 'zh-CN',
      fallbackName: 'Palette Tools',
      fallbackDescription: 'Extract palettes.',
      catalog: catalog.plugins[0],
    });
    expect(copy).toEqual({ name: '色板工具', description: '提取色板。' });
  });

  it('serves a cached catalog when the remote digest or fetch fails', async () => {
    const userData = temporaryRoot('worldlinebox-catalog-');
    const json = `${JSON.stringify(catalog)}\n`;
    const digest = createHash('sha256').update(json).digest('hex');
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (calls <= 2) {
        if (url.endsWith('.sha256')) return new Response(`${digest}\n`, { status: 200 });
        return new Response(json, { status: 200 });
      }
      return new Response('unavailable', { status: 503 });
    };
    const store = new PluginCommunityCatalogStore({
      userDataDirectory: userData,
      catalogUrl: 'https://example.test/catalog.v1.json',
      fetchImpl,
    });
    const fresh = await store.load({ refresh: true });
    expect(fresh.stale).toBe(false);
    expect(fresh.catalog.plugins).toHaveLength(1);
    const stale = await store.load({ refresh: true });
    expect(stale.stale).toBe(true);
    expect(stale.catalog.plugins[0]?.id).toBe('com.example.palette-tools');
    expect(stale.errorCode).toBe('PLUGIN_CATALOG_UNAVAILABLE');
  });

  it('rejects a catalog whose bytes do not match the published digest', async () => {
    const userData = temporaryRoot('worldlinebox-catalog-bad-');
    mkdirSync(userData, { recursive: true });
    writeFileSync(path.join(userData, 'keep.txt'), 'x');
    const json = `${JSON.stringify(catalog)}\n`;
    const store = new PluginCommunityCatalogStore({
      userDataDirectory: userData,
      catalogUrl: 'https://example.test/catalog.v1.json',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('.sha256')) return new Response(`${'0'.repeat(64)}\n`, { status: 200 });
        return new Response(json, { status: 200 });
      },
    });
    await expect(store.load({ refresh: true })).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_HASH_MISMATCH',
    });
  });

  it('fetches the locale README from the pinned tag and skips 404 then HTML', async () => {
    const userData = temporaryRoot('worldlinebox-catalog-readme-');
    const json = `${JSON.stringify(catalog)}\n`;
    const digest = createHash('sha256').update(json).digest('hex');
    const requested: string[] = [];
    const store = new PluginCommunityCatalogStore({
      userDataDirectory: userData,
      catalogUrl: 'https://example.test/catalog.v1.json',
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes('zipball')) throw new Error('community channel must not use zipball');
        if (url.endsWith('.sha256')) return new Response(`${digest}\n`, { status: 200 });
        if (url.endsWith('catalog.v1.json')) return new Response(json, { status: 200 });
        if (url.endsWith('README.zh-CN.md')) return new Response('missing', { status: 404 });
        if (url.endsWith('README.zh.md')) {
          return new Response('<!DOCTYPE html><html>not found</html>', { status: 200 });
        }
        if (url.endsWith('README.md')) return new Response('# Palette Tools\n\nExtract palettes.\n', { status: 200 });
        return new Response('no', { status: 404 });
      },
    });
    await store.load({ refresh: true });
    const readme = await store.loadReadme({ pluginId: 'com.example.palette-tools', locale: 'zh-CN' });
    expect(readme).toMatchObject({
      pluginId: 'com.example.palette-tools',
      fileName: 'README.md',
      locale: 'zh-CN',
      requestedLocale: 'zh-CN',
      markdown: '# Palette Tools\n\nExtract palettes.\n',
    });
    const cached = await store.loadReadme({ pluginId: 'com.example.palette-tools', locale: 'zh-CN' });
    expect(cached?.fileName).toBe('README.md');
    expect(requested.filter((url) => url.includes('README.md'))).toHaveLength(1);
  });
});
