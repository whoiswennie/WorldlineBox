import type { PluginLocaleId } from './plugin-localized-copy';
import { toOpenableExternalUrl } from '../shared/external-url';

export const PLUGIN_README_MAX_BYTES = 256 * 1024;

export const PLUGIN_README_FILE_NAMES = [
  'README.zh-CN.md',
  'README.zh.md',
  'README.en.md',
  'README.md',
] as const;

export type PluginReadmeFileName = (typeof PLUGIN_README_FILE_NAMES)[number];

export type PluginReadmeInline =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'strong'; readonly children: readonly PluginReadmeInline[] }
  | { readonly type: 'em'; readonly children: readonly PluginReadmeInline[] }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly PluginReadmeInline[] }
  | { readonly type: 'image'; readonly href: string; readonly alt: string };

export type PluginReadmeTableAlign = 'left' | 'center' | 'right';

export type PluginReadmeBlock =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly PluginReadmeInline[] }
  | { readonly type: 'paragraph'; readonly children: readonly PluginReadmeInline[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly (readonly PluginReadmeInline[])[] }
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'blockquote'; readonly children: readonly PluginReadmeInline[] }
  | { readonly type: 'table'; readonly align: readonly PluginReadmeTableAlign[]; readonly header: readonly (readonly PluginReadmeInline[])[]; readonly rows: readonly (readonly (readonly PluginReadmeInline[])[])[] }
  | { readonly type: 'hr' };

export type PluginReadmeResolveContext = {
  readonly repositoryUrl: string;
  readonly releaseTag: string;
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

export function pluginReadmeCandidates(locale: PluginLocaleId): readonly PluginReadmeFileName[] {
  return locale === 'zh-CN'
    ? ['README.zh-CN.md', 'README.zh.md', 'README.md']
    : ['README.en.md', 'README.md'];
}

export function pluginReadmeRawUrl(repositoryUrl: string, releaseTag: string, fileName: PluginReadmeFileName): string {
  const parsed = new URL(repositoryUrl);
  const [owner, name] = parsed.pathname.split('/').filter(Boolean);
  if (owner === undefined || name === undefined) {
    throw new Error('README fetch requires an HTTPS GitHub owner/repository URL.');
  }
  return `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(releaseTag)}/${fileName}`;
}

export function communityPluginAuthor(input: {
  readonly author?: string;
  readonly repo: string;
}): string {
  const named = input.author?.trim();
  if (named !== undefined && named !== '') return named;
  const owner = input.repo.split('/')[0];
  return owner !== undefined && owner !== '' ? owner : input.repo;
}

export function resolveReadmeHref(href: string, context: PluginReadmeResolveContext): string | undefined {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('mailto:')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return toOpenableExternalUrl(trimmed) ?? undefined;
  }
  const parsedRepo = new URL(context.repositoryUrl);
  const [owner, name] = parsedRepo.pathname.split('/').filter(Boolean);
  if (owner === undefined || name === undefined) return undefined;
  const relative = trimmed.replace(/^\.\//u, '').replace(/^\/+/u, '');
  if (relative.startsWith('../') || relative.includes('..')) return undefined;
  const extension = pathExtension(relative);
  const kind = IMAGE_EXTENSIONS.has(extension) ? 'raw' : 'blob';
  const host = kind === 'raw' ? 'https://raw.githubusercontent.com' : 'https://github.com';
  const middle = kind === 'raw' ? `${owner}/${name}/${encodeURIComponent(context.releaseTag)}` : `${owner}/${name}/blob/${encodeURIComponent(context.releaseTag)}`;
  return `${host}/${middle}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

export function parsePluginReadmeMarkdown(
  markdown: string,
  context: PluginReadmeResolveContext,
): readonly PluginReadmeBlock[] {
  return parseMarkdownDocument(markdown, (href) => resolveReadmeHref(href, context));
}

/** Asset preview: keep http(s) links, drop relative paths and raw HTML. */
export function parseAssetMarkdown(markdown: string): readonly PluginReadmeBlock[] {
  return parseMarkdownDocument(markdown, (href) => toOpenableExternalUrl(href.trim()) ?? undefined);
}

function splitTableCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && splitTableCells(line).length > 0;
}

function tableAlignment(cell: string): PluginReadmeTableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function tableStartsAt(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? '';
  const separator = lines[index + 1] ?? '';
  return isTableRow(header)
    && isTableSeparator(separator)
    && splitTableCells(header).length === splitTableCells(separator).length;
}

function parseMarkdownDocument(
  markdown: string,
  resolveHref: (href: string) => string | undefined,
): readonly PluginReadmeBlock[] {
  const source = markdown.replace(/\r\n/gu, '\n').replace(/\0/gu, '');
  const lines = source.split('\n');
  const blocks: PluginReadmeBlock[] = [];
  let index = 0;
  let previous = -1;
  while (index < lines.length) {
    // A card preview is a raw byte prefix. The cut can land on a line that
    // looks like a list marker and nothing else. Every branch has to move
    // forward; otherwise the renderer thread never returns.
    if (index === previous) index += 1;
    if (index >= lines.length) break;
    previous = index;
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (/^```/u.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/u.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', value: body.join('\n') });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line.trim())) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({
        type: 'heading',
        level,
        children: parseInlines(heading[2], resolveHref),
      });
      index += 1;
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/u, ''));
        index += 1;
      }
      blocks.push({
        type: 'blockquote',
        children: parseInlines(quoted.join(' '), resolveHref),
      });
      continue;
    }
    const unordered = /^[-*+]\s+/u.test(line);
    const ordered = /^\d+[.)]\s+/u.test(line);
    if (unordered || ordered) {
      const items: PluginReadmeInline[][] = [];
      while (index < lines.length) {
        const itemLine = lines[index] ?? '';
        const match = unordered
          ? /^[-*+]\s+(.+)$/u.exec(itemLine)
          : /^\d+[.)]\s+(.+)$/u.exec(itemLine);
        if (match?.[1] === undefined) break;
        items.push([...parseInlines(match[1], resolveHref)]);
        index += 1;
      }
      if (items.length === 0) {
        blocks.push({
          type: 'paragraph',
          children: parseInlines(line, resolveHref),
        });
        index += 1;
        continue;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (tableStartsAt(lines, index)) {
      const headerCells = splitTableCells(line);
      const align = splitTableCells(lines[index + 1] ?? '').map(tableAlignment);
      const rows: PluginReadmeInline[][][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? '') && !isTableSeparator(lines[index] ?? '')) {
        const cells = splitTableCells(lines[index] ?? '');
        rows.push(headerCells.map((_, cellIndex) => parseInlines(cells[cellIndex] ?? '', resolveHref)));
        index += 1;
      }
      blocks.push({
        type: 'table',
        align,
        header: headerCells.map((cell) => parseInlines(cell, resolveHref)),
        rows,
      });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (
        next.trim() === ''
        || /^```/u.test(next)
        || /^(#{1,6})\s+/u.test(next)
        || /^[-*+]\s+/u.test(next)
        || /^\d+[.)]\s+/u.test(next)
        || /^>\s?/u.test(next)
        || tableStartsAt(lines, index)
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      children: parseInlines(paragraph.join(' '), resolveHref),
    });
  }
  return blocks;
}

function pathExtension(relative: string): string {
  const base = relative.split('/').at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

function pushInlineText(nodes: PluginReadmeInline[], value: string): void {
  if (value === '') return;
  const last = nodes.at(-1);
  if (last?.type === 'text') {
    nodes[nodes.length - 1] = { type: 'text', value: `${last.value}${value}` };
    return;
  }
  nodes.push({ type: 'text', value });
}

/** First closer at least one character after the opener. Missing closer is cached. */
function readMarked(
  source: string,
  index: number,
  marker: string,
  closerAt: number,
): { readonly inner: string; readonly length: number; readonly closerAt: number } | null {
  if (!source.startsWith(marker, index)) return null;
  const from = index + marker.length + 1;
  const cached = closerAt >= from && source.startsWith(marker, closerAt);
  const end = cached ? closerAt : source.indexOf(marker, from);
  if (end < from) return null;
  return {
    inner: source.slice(index + marker.length, end),
    length: end + marker.length - index,
    closerAt: end,
  };
}

function parseInlines(input: string, resolveHref: (href: string) => string | undefined): PluginReadmeInline[] {
  const source = stripRawHtml(input);
  const nodes: PluginReadmeInline[] = [];
  let index = 0;
  let plainStart = 0;
  let bracketAt = source.indexOf(']', 0);
  let starAt = source.indexOf('*', 0);
  let underscoreAt = source.indexOf('_', 0);
  let backtickAt = source.indexOf('`', 0);
  const flushPlain = (end: number): void => {
    if (end <= plainStart) return;
    pushInlineText(nodes, source.slice(plainStart, end));
    plainStart = end;
  };
  const closerCache = (marker: string): number => {
    if (marker === '*') return starAt;
    if (marker === '_') return underscoreAt;
    return backtickAt;
  };
  const storeCloser = (marker: string, at: number): void => {
    if (marker.startsWith('*')) starAt = at;
    else if (marker.startsWith('_')) underscoreAt = at;
    else backtickAt = at;
  };

  while (index < source.length) {
    const current = source[index] ?? '';
    if ((current === '!' && source[index + 1] === '[') || current === '[') {
      const linkIndex = current === '!' ? index + 1 : index;
      if (bracketAt !== -1 && bracketAt < linkIndex + 1) {
        bracketAt = source.indexOf(']', linkIndex + 1);
      }
      const linked = bracketAt === -1 ? null : readLinkLike(source, linkIndex, bracketAt, current === '!');
      if (linked !== null) {
        flushPlain(index);
        const href = resolveHref(linked.href);
        if (current === '!') {
          if (href !== undefined) nodes.push({ type: 'image', href, alt: linked.label });
          else if (linked.label !== '') nodes.push({ type: 'text', value: linked.label });
          index += linked.length + 1;
        } else {
          const children = parseInlines(linked.label, resolveHref);
          if (href !== undefined) nodes.push({ type: 'link', href, children });
          else nodes.push(...children);
          index += linked.length;
        }
        plainStart = index;
        continue;
      }
    } else if (current === '`' || current === '*' || current === '_') {
      const marker = (current === '*' || current === '_') && source[index + 1] === current
        ? current + current
        : current;
      const marked = readMarked(source, index, marker, closerCache(marker));
      if (marked !== null) {
        storeCloser(marker, marked.closerAt);
        flushPlain(index);
        if (marker === '`') nodes.push({ type: 'code', value: marked.inner });
        else {
          const children = parseInlines(marked.inner, resolveHref);
          nodes.push(marker.length === 2
            ? { type: 'strong', children }
            : { type: 'em', children });
        }
        index += marked.length;
        plainStart = index;
        continue;
      }
      if (marker.length === 2) {
        const single = readMarked(source, index, current, closerCache(current));
        if (single !== null) {
          storeCloser(current, single.closerAt);
          flushPlain(index);
          nodes.push({ type: 'em', children: parseInlines(single.inner, resolveHref) });
          index += single.length;
          plainStart = index;
          continue;
        }
      }
    }
    index += 1;
  }
  flushPlain(source.length);
  return nodes;
}

function readLinkLike(
  source: string,
  index: number,
  labelEnd: number,
  allowEmptyLabel: boolean,
): { readonly label: string; readonly href: string; readonly length: number } | null {
  if (source[index] !== '[' || labelEnd < index + 1) return null;
  if (!allowEmptyLabel && labelEnd === index + 1) return null;
  if (source[labelEnd + 1] !== '(') return null;
  const hrefEnd = source.indexOf(')', labelEnd + 2);
  if (hrefEnd <= labelEnd + 2) return null;
  return {
    label: source.slice(index + 1, labelEnd),
    href: source.slice(labelEnd + 2, hrefEnd),
    length: hrefEnd + 1 - index,
  };
}

function stripRawHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, '');
}
