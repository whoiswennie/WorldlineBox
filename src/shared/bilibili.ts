import { z } from 'zod';

export type BilibiliLoginState = 'signed-in' | 'guest' | 'unknown';
export const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login?gourl=https%3A%2F%2Fwww.bilibili.com%2F';
export const BROWSER_PARTITION = 'persist:worldlinebox-browser';
const keyword = z.string().trim().min(1).max(160);
const page = z.number().int().min(1).max(50).default(1);
const section = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const videoToolSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('search'), keyword, order: z.enum(['totalrank', 'click', 'pubdate', 'stow']).default('totalrank'), page }),
  z.strictObject({ action: z.literal('creators'), keyword, page }),
  z.strictObject({ action: z.literal('uploads'), creatorName: keyword.optional(), mid: z.string().regex(/^[1-9]\d{0,18}$/), keyword: keyword.optional(), order: z.enum(['click', 'pubdate', 'stow']).default('click'), page }),
  z.strictObject({ action: z.literal('sections') }),
  z.strictObject({ action: z.literal('section'), section }),
  z.strictObject({ action: z.literal('ranking'), section: section.default('all') }),
  z.strictObject({ action: z.literal('play'), video: z.string().trim().min(1).max(2048), autoPlay: z.boolean().default(true) }),
]);
export type VideoToolInput = z.infer<typeof videoToolSchema>;
export interface VideoShare { id: string; videoId: string; page: number; title: string; author?: string; mid?: string; cover?: string }
export const isVideoId = (id: string) => /^(?:BV[A-Za-z0-9]{10}|(?:av|ep|ss)[1-9]\d{0,16})$/.test(id);
export function parseVideo(value: string) {
  if (isVideoId(value)) return { videoId: value, page: 1 };
  const url = new URL(value);
  const match = /^\/(?:video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,16})|bangumi\/play\/((?:ep|ss)[1-9]\d{0,16}))\/?$/.exec(url.pathname);
  if (!['https:', 'http:'].includes(url.protocol) || !['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(url.host) || url.username || url.password || !match) throw Error('请提供 B 站视频原页链接、BV、av、ep 或 ss 号。');
  const p = Number(url.searchParams.get('p') ?? '1');
  if (!Number.isSafeInteger(p) || p < 1 || p > 10000) throw Error('分 P 编号无效。');
  return { videoId: (match[1] ?? match[2])!, page: p };
}
export function videoPageUrl({ videoId, page }: Pick<VideoShare,'videoId'|'page'>) {
  return 'https://www.bilibili.com/' + (/^(ep|ss)/.test(videoId) ? 'bangumi/play/' : 'video/') + videoId + (page > 1 ? '?p=' + page : '');
}
export function videoPlayerUrl({ videoId, page }: Pick<VideoShare,'videoId'|'page'>) {
  if (!isVideoId(videoId) || videoId.startsWith('ss')) throw Error('无效的视频集数。');
  const key = videoId.startsWith('ep') ? 'episodeId' : videoId.startsWith('av') ? 'aid' : 'bvid';
  return 'https://player.bilibili.com/player.html?' + new URLSearchParams({ [key]: key === 'bvid' ? videoId : videoId.slice(2), p: String(page), autoplay: '1' });
}
export function isVideoPlayerUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://player.bilibili.com' || url.pathname !== '/player.html' || url.username || url.password) return false;
    const id = url.searchParams.get('bvid') ?? (url.searchParams.has('aid') ? 'av' + url.searchParams.get('aid') : 'ep' + url.searchParams.get('episodeId'));
    return isVideoId(id) && videoPlayerUrl({ videoId: id, page: Number(url.searchParams.get('p')) }) === value && /^[1-9]\d{0,4}$/.test(url.searchParams.get('p') ?? '');
  } catch { return false; }
}
