import { parseMarkdownDocument, type PluginReadmeBlock } from '../../plugins/plugin-community-readme';
import { terminalExternalLink } from './terminal-stream';

/** GitHub release bodies mix Markdown with HTML headings that carry language anchors. */
export function parseReleaseNotes(source: string, releaseUrl: string, idPrefix: string): readonly PluginReadmeBlock[] {
  const anchors = new Map<number, string>();
  let headingIndex = 0;
  let fence: string | undefined;
  const normalized = source.slice(0, 30000).replace(/\r\n?/g, '\n').split('\n').map(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return line.replace(marker, '```');
    }
    if (fence) return line;
    const htmlHeading = /^\s*<h([1-6])\b([^>]*)>(.*?)<\/h\1>\s*$/i.exec(line);
    if (htmlHeading) {
      const anchor = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(htmlHeading[2]!);
      const id = anchor?.[1] ?? anchor?.[2];
      if (id && /^[\w.:-]+$/.test(id)) anchors.set(headingIndex, id);
      headingIndex += 1;
      return `${'#'.repeat(Number(htmlHeading[1]))} ${htmlHeading[3]}`;
    }
    if (/^#{1,6}\s+/.test(line)) headingIndex += 1;
    return line;
  }).join('\n');
  const knownAnchors = new Set(anchors.values());
  const base = terminalExternalLink(releaseUrl);
  const blocks = parseMarkdownDocument(normalized, href => {
    if (href.startsWith('#')) return knownAnchors.has(href.slice(1)) ? href : undefined;
    // The external URL guard rejects credentials, local files and application schemes.
    try { return terminalExternalLink(base ? new URL(href, base).href : href); }
    catch { return undefined; }
  });
  headingIndex = 0;
  return blocks.map(block => {
    if (block.type !== 'heading') return block;
    const anchor = anchors.get(headingIndex++);
    return anchor ? { ...block, id: `${idPrefix}-${anchor}` } : block;
  });
}
