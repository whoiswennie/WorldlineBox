import { DOMParser } from '@xmldom/xmldom';

export type SegmentedPart = {
  url: string;
  role: 'init' | 'media';
  durationMs?: number;
  range?: string;
  discontinuityBefore?: true;
};
type Track = { kind: 'video' | 'audio'; parts: SegmentedPart[] };
export type SegmentedManifest = {
  protocol: 'hls-ts' | 'hls-fmp4' | 'dash-fmp4';
  tracks: Track[];
};
type ReadManifest = (url: string) => Promise<{ url: string; text: string }>;
const MAX_PARTS = 10_000;

export function segmentedManifestKind(url: string, contentType = ''): 'hls' | 'dash' | undefined {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.m3u8') || /mpegurl/i.test(contentType)) return 'hls';
  if (pathname.endsWith('.mpd') || /dash\+xml/i.test(contentType)) return 'dash';
  return undefined;
}

function mediaUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('视频清单包含无效地址。');
  }
  return url.href;
}

function hlsAttributes(line: string): Record<string, string> {
  return Object.fromEntries(Array.from(line.matchAll(/([\w-]+)=("[^"]*"|[^,]*)/g),
    ([, key, value]) => [key!, (value ?? '').replace(/^"|"$/g, '')]));
}

function hlsRange(value: string, previousEnd: number | undefined): { range: string; end: number } {
  const [lengthText, startText] = value.split('@');
  const length = Number(lengthText);
  const start = startText === undefined ? previousEnd : Number(startText);
  if (start === undefined || !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start + length)) {
    throw new Error('视频清单包含无效的字节范围。');
  }
  return { range: `bytes=${start}-${start + length - 1}`, end: start + length };
}

function hlsParts(lines: string[], base: string): SegmentedPart[] {
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('仅支持已结束的 HLS 视频。');
  const parts: SegmentedPart[] = [];
  let durationMs = 0;
  let rangeValue: string | undefined;
  let previousEnd: number | undefined;
  let previousUrl: string | undefined;
  let discontinuity = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:') && hlsAttributes(line).METHOD !== 'NONE') {
      throw new Error('该 HLS 视频使用了加密。');
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = hlsAttributes(line);
      if (!attributes.URI) throw new Error('HLS 清单缺少初始化地址。');
      const url = mediaUrl(attributes.URI, base);
      const range = attributes.BYTERANGE ? hlsRange(attributes.BYTERANGE, undefined).range : undefined;
      const init = parts[0];
      if (init && (init.role !== 'init' || init.url !== url || init.range !== range)) {
        throw new Error('该 HLS 视频的初始化分段发生变化。');
      }
      if (!init) parts.push({ url, role: 'init', range });
    } else if (line.startsWith('#EXTINF:')) {
      durationMs = Number(line.slice(8).split(',')[0]) * 1000;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      rangeValue = line.slice('#EXT-X-BYTERANGE:'.length);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line && !line.startsWith('#')) {
      if (!Number.isFinite(durationMs) || durationMs <= 0 || parts.length >= MAX_PARTS) {
        throw new Error('视频分段数量或时长超出支持范围。');
      }
      const url = mediaUrl(line, base);
      const range = rangeValue ? hlsRange(rangeValue, previousUrl === url ? previousEnd : undefined) : undefined;
      parts.push({ url, role: 'media', durationMs, range: range?.range,
        ...(discontinuity ? { discontinuityBefore: true } : {}) });
      previousUrl = url;
      previousEnd = range?.end;
      durationMs = 0;
      rangeValue = undefined;
      discontinuity = false;
    }
  }
  if (!parts.some(part => part.role === 'media')) throw new Error('视频清单中没有可保存的分段。');
  return parts;
}

function hlsLines(text: string): string[] {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('无法读取 HLS 清单。');
  return lines;
}

async function parseHls(initial: { url: string; text: string }, read: ReadManifest): Promise<SegmentedManifest> {
  const lines = hlsLines(initial.text);
  const variants = lines.flatMap((line, index) => {
    const next = lines[index + 1];
    return line.startsWith('#EXT-X-STREAM-INF:') && next && !next.startsWith('#')
      ? [{ attributes: hlsAttributes(line), url: mediaUrl(next, initial.url) }]
      : [];
  }).sort((a, b) => Number(b.attributes.BANDWIDTH ?? 0) - Number(a.attributes.BANDWIDTH ?? 0));
  const variant = variants[0];
  const video = variant ? await read(variant.url) : initial;
  const parts = hlsParts(hlsLines(video.text), video.url);
  const tracks: Track[] = [{ kind: 'video', parts }];
  const protocol = parts[0]?.role === 'init' ? 'hls-fmp4' : 'hls-ts';
  const group = variant?.attributes.AUDIO;
  if (group) {
    const renditions = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(hlsAttributes)
      .filter(item => item.TYPE === 'AUDIO' && item['GROUP-ID'] === group);
    const audioUrl = (renditions.find(item => item.DEFAULT === 'YES') ?? renditions[0])?.URI;
    if (audioUrl) {
      const audio = await read(mediaUrl(audioUrl, initial.url));
      tracks.push({ kind: 'audio', parts: hlsParts(hlsLines(audio.text), audio.url) });
    }
  }
  return { protocol, tracks };
}

function elements(node: Element, name: string): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element =>
    child.nodeType === 1 && (child as Element).localName === name);
}

function dashDuration(value: string): number {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

function dashTemplateValue(template: string, values: Record<string, string | number | null>): string {
  return template.replace(/\$\$|\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g,
    (match, key: string, width: string | undefined) => {
      if (match === '$$') return '$';
      const value = values[key];
      if (value == null || Number(width ?? 0) > 20) throw new Error('DASH 清单模板无效。');
      return String(value).padStart(Number(width ?? 0), '0');
    });
}

function dashSegments(nodes: Element[], base: string, seconds: number): SegmentedPart[] {
  const templates = nodes.flatMap(node => elements(node, 'SegmentTemplate'));
  const attr = (key: string) => templates.findLast(node => node.hasAttribute(key))?.getAttribute(key);
  const initialization = attr('initialization');
  const media = attr('media');
  const scale = Number(attr('timescale') ?? 1);
  const startNumber = Number(attr('startNumber') ?? 1);
  const offset = Number(attr('presentationTimeOffset') ?? 0);
  if (!initialization || !media || !Number.isSafeInteger(scale) || scale <= 0 ||
      !Number.isSafeInteger(startNumber) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('该 DASH 清单缺少受支持的分段模板。');
  }
  const representation = nodes[nodes.length - 1]!;
  const identity = { RepresentationID: representation.getAttribute('id'), Bandwidth: representation.getAttribute('bandwidth') };
  const parts: SegmentedPart[] = [
    { url: mediaUrl(dashTemplateValue(initialization, identity), base), role: 'init' },
  ];
  let time = 0;
  const append = (duration: number, count: number) => {
    if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(count) ||
        count <= 0 || parts.length + count > MAX_PARTS) throw new Error('DASH 分段数量或时长无效。');
    for (let i = 0; i < count; i += 1) {
      if (!Number.isSafeInteger(time) || time < 0) throw new Error('DASH 时间轴无效。');
      const url = mediaUrl(dashTemplateValue(media, { ...identity, Time: time, Number: startNumber + parts.length - 1 }), base);
      parts.push({ url, role: 'media', durationMs: duration * 1000 / scale });
      time += duration;
    }
  };
  const timeline = templates.flatMap(node => elements(node, 'SegmentTimeline')).at(-1);
  if (timeline) {
    const rows = elements(timeline, 'S');
    rows.forEach((row, index) => {
      if (row.hasAttribute('t')) time = Number(row.getAttribute('t'));
      const duration = Number(row.getAttribute('d'));
      const repeat = Number(row.getAttribute('r') || 0);
      const next = rows[index + 1];
      const end = next?.hasAttribute('t') ? Number(next.getAttribute('t')) : offset + seconds * scale;
      append(duration, repeat === -1 ? Math.ceil((end - time) / duration) : repeat + 1);
    });
  } else {
    const duration = Number(attr('duration'));
    append(duration, Math.ceil(seconds * scale / duration));
  }
  if (parts.length === 1) throw new Error('DASH 清单中没有可保存的分段。');
  return parts;
}

function parseDash({ text, url }: { text: string; url: string }): SegmentedManifest {
  if (/<!DOCTYPE/i.test(text)) throw new Error('无法读取 DASH 清单。');
  const manifest = new DOMParser().parseFromString(text, 'application/xml').documentElement as unknown as Element;
  const periods = manifest ? elements(manifest, 'Period') : [];
  if (manifest?.localName !== 'MPD' || manifest.getAttribute('type') === 'dynamic' || periods.length !== 1) {
    throw new Error('仅支持单段、已结束的 DASH 视频。');
  }
  const period = periods[0]!;
  const seconds = dashDuration(period.getAttribute('duration') || manifest.getAttribute('mediaPresentationDuration') || '');
  const candidates = elements(period, 'AdaptationSet').flatMap(adaptation => {
    if (elements(adaptation, 'ContentProtection').length) return [];
    return elements(adaptation, 'Representation').flatMap(representation => {
      if (elements(representation, 'ContentProtection').length) return [];
      const kind = (representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') ||
        adaptation.getAttribute('contentType') || '').split('/')[0];
      return kind === 'video' || kind === 'audio'
        ? [{ kind, nodes: [manifest, period, adaptation, representation], bandwidth: Number(representation.getAttribute('bandwidth') || 0) }]
        : [];
    });
  }).sort((a, b) => b.bandwidth - a.bandwidth);
  const tracks: Track[] = [];
  for (const kind of ['video', 'audio'] as const) {
    const candidate = candidates.find(item => item.kind === kind);
    if (!candidate) continue;
    const base = candidate.nodes.reduce((previous, node) => {
      const value = elements(node, 'BaseURL')[0]?.textContent?.trim();
      return value ? mediaUrl(value, previous) : previous;
    }, url);
    tracks.push({ kind, parts: dashSegments(candidate.nodes, base, seconds) });
  }
  if (!tracks.some(track => track.kind === 'video')) throw new Error('DASH 清单中没有可保存的视频轨。');
  return { protocol: 'dash-fmp4', tracks };
}

export function parseSegmentedManifest(kind: 'hls' | 'dash', initial: { url: string; text: string }, read: ReadManifest): Promise<SegmentedManifest> {
  return kind === 'hls' ? parseHls(initial, read) : Promise.resolve().then(() => parseDash(initial));
}
