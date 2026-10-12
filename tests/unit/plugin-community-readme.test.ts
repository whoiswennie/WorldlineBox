import { describe, expect, it } from 'vitest';

import {
  communityPluginAuthor,
  parseAssetMarkdown,
  parsePluginReadmeMarkdown,
  pluginReadmeCandidates,
  pluginReadmeRawUrl,
  resolveReadmeHref,
} from '../../src/plugins/plugin-community-readme';

const context = {
  repositoryUrl: 'https://github.com/example/worldlinebox-palette-tools',
  releaseTag: 'v1.2.0',
};

describe('plugin community readme', () => {
  it('picks locale-specific README candidates before the generic file', () => {
    expect(pluginReadmeCandidates('zh-CN')).toEqual([
      'README.zh-CN.md',
      'README.zh.md',
      'README.md',
    ]);
    expect(pluginReadmeCandidates('en')).toEqual(['README.en.md', 'README.md']);
  });

  it('builds a raw.githubusercontent.com URL for the pinned release tag', () => {
    expect(pluginReadmeRawUrl(context.repositoryUrl, context.releaseTag, 'README.zh-CN.md')).toBe(
      'https://raw.githubusercontent.com/example/worldlinebox-palette-tools/v1.2.0/README.zh-CN.md',
    );
  });

  it('uses catalog author when present and otherwise the GitHub owner', () => {
    expect(communityPluginAuthor({ author: 'Ada', repo: 'example/worldlinebox-palette-tools' })).toBe('Ada');
    expect(communityPluginAuthor({ repo: 'example/worldlinebox-palette-tools' })).toBe('example');
  });

  it('resolves relative markdown to blob URLs and images to raw URLs', () => {
    expect(resolveReadmeHref('docs/guide.md', context)).toBe(
      'https://github.com/example/worldlinebox-palette-tools/blob/v1.2.0/docs/guide.md',
    );
    expect(resolveReadmeHref('./preview.png', context)).toBe(
      'https://raw.githubusercontent.com/example/worldlinebox-palette-tools/v1.2.0/preview.png',
    );
  });

  it('drops javascript: links, traversal, and raw HTML', () => {
    expect(resolveReadmeHref('javascript:alert(1)', context)).toBeUndefined();
    expect(resolveReadmeHref('../secret.md', context)).toBeUndefined();
    const blocks = parsePluginReadmeMarkdown(
      [
        '# Title <script>alert(1)</script>',
        '',
        'See [docs](javascript:evil) and [safe](https://example.test/a).',
        '',
        '<img src=x onerror=alert(1)> leftover',
      ].join('\n'),
      context,
    );
    expect(blocks).toEqual([
      {
        type: 'heading',
        level: 1,
        children: [{ type: 'text', value: 'Title alert(1)' }],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'See ' },
          { type: 'text', value: 'docs and ' },
          {
            type: 'link',
            href: 'https://example.test/a',
            children: [{ type: 'text', value: 'safe' }],
          },
          { type: 'text', value: '.' },
        ],
      },
      {
        type: 'paragraph',
        children: [{ type: 'text', value: ' leftover' }],
      },
    ]);
  });

  it('parses markdown tables, including alignment and inline marks', () => {
    expect(parseAssetMarkdown([
      '| Name | Score |',
      '| :--- | ---: |',
      '| **hp** | 12 |',
      '',
      'After the table.',
    ].join('\n'))).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        header: [
          [{ type: 'text', value: 'Name' }],
          [{ type: 'text', value: 'Score' }],
        ],
        rows: [[
          [{ type: 'strong', children: [{ type: 'text', value: 'hp' }] }],
          [{ type: 'text', value: '12' }],
        ]],
      },
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'After the table.' }],
      },
    ]);
  });

  it('finishes when a preview prefix ends on a bare list marker', () => {
    const started = performance.now();
    const blocks = parseAssetMarkdown('section\n- \n# next\n* \n1. \n+ ');
    expect(performance.now() - started).toBeLessThan(50);
    expect(blocks.some((block) => block.type === 'heading' && block.level === 1)).toBe(true);
    expect(parseAssetMarkdown('- item\n- other')).toEqual([{
      type: 'list',
      ordered: false,
      items: [
        [{ type: 'text', value: 'item' }],
        [{ type: 'text', value: 'other' }],
      ],
    }]);
  });

  it('finishes a long table and a long run of unclosed markers', () => {
    const table = [
      '| Item | Value |',
      '| :--- | ---: |',
      ...Array.from({ length: 400 }, (_, index) => `| row ${index} | **${index}** |`),
    ].join('\n');
    const hostile = `[${'['.repeat(20_000)}`;
    const started = performance.now();
    const blocks = parseAssetMarkdown(`${table}\n\n${hostile}`);
    const elapsed = performance.now() - started;
    expect(blocks[0]).toMatchObject({ type: 'table' });
    if (blocks[0]?.type === 'table') expect(blocks[0].rows).toHaveLength(400);
    expect(elapsed).toBeLessThan(500);
  });

  it('renders asset markdown links that are http(s) and drops relative paths', () => {
    expect(parseAssetMarkdown('# Title\n\nSee [docs](https://example.test/docs) and [local](./note.md).')).toEqual([
      {
        type: 'heading',
        level: 1,
        children: [{ type: 'text', value: 'Title' }],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'See ' },
          {
            type: 'link',
            href: 'https://example.test/docs',
            children: [{ type: 'text', value: 'docs' }],
          },
          { type: 'text', value: ' and ' },
          { type: 'text', value: 'local.' },
        ],
      },
    ]);
  });
});
