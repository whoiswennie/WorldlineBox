import { WebContentsView, type Session } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseVideo, videoPageUrl, type BilibiliLoginState, type VideoShare, type VideoToolInput } from '../../shared/bilibili';

const site = 'https://www.bilibili.com';
const catalog = ['anime','movie','guochuang','tv','variety','documentary'];
const rankCategories = ['all','anime','guochuang','documentary','movie','tv','variety','douga','game','kichiku','music','dance','cinephile','ent','knowledge','tech','food','car','fashion','sports','animal'];
const rankSlugs: Record<string,string> = { bangumi: 'anime', guochan: 'guochuang' };
const allowedCover = (value?: string) => {
  try { const url = new URL(value ?? '', site); return /\.(hdslb|biliimg)\.com$/.test(url.hostname) ? 'https://' + url.hostname + url.pathname : undefined; } catch { return undefined; }
};

async function api(scope: Session, path: string, params: Record<string,string>, signal: AbortSignal, allowGuest = false) {
  const url = new URL(path, 'https://api.bilibili.com');
  url.search = new URLSearchParams(params).toString();
  const res = await scope.fetch(url.href, { credentials: 'include', referrer: site + '/', signal });
  if (!res.ok) throw Error('哔哩哔哩接口暂不可用（HTTP ' + res.status + '）。');
  const { code, data } = z.object({ code: z.number(), data: z.unknown() }).parse(await res.json());
  if (code !== 0 && !(allowGuest && code === -101)) throw Error('哔哩哔哩返回 ' + code + '，请在内置浏览器打开原页确认登录和访问权限。');
  return data;
}

export async function bilibiliLogin(scope: Session): Promise<BilibiliLoginState> {
  try {
    const response = await scope.fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials:'include', cache:'no-store', signal:AbortSignal.timeout(6000),
    });
    if (!response.ok) return 'unknown';
    const status = z.object({code:z.number(), data:z.object({isLogin:z.boolean()}).optional()}).parse(await response.json());
    if (status.code === -101) return 'guest';
    if (status.code === 0 && status.data) return status.data.isLogin ? 'signed-in' : 'guest';
  } catch { /* Account verification can be unavailable while offline. */ }
  return 'unknown';
}

async function resolveVideo(scope: Session, value: string, signal: AbortSignal): Promise<Omit<VideoShare,'id'>> {
  if (/^https?:\/\/b23\.tv\/[A-Za-z0-9]+(?:[/?#]|$)/.test(value)) {
    const url = new URL(value);
    const response = await scope.fetch('https://b23.tv' + url.pathname, { redirect: 'manual', signal });
    value = response.headers.get('location') ?? '';
  }
  const { videoId, page } = parseVideo(value);
  if (/^(ep|ss)/.test(videoId)) {
    const data = await scope.fetch('https://api.bilibili.com/pgc/view/web/season?' + new URLSearchParams({
      [videoId.startsWith('ep') ? 'ep_id' : 'season_id']: videoId.slice(2),
    }), { credentials: 'include', signal });
    const parsed = z.object({ code: z.literal(0), result: z.object({ title: z.string(), cover: z.string().optional(),
      episodes: z.array(z.object({ id: z.number(), share_copy: z.string().optional(), long_title: z.string().optional(), title: z.string() })) }) }).safeParse(await data.json());
    const season = parsed.data?.result;
    const episode = videoId.startsWith('ss') ? season?.episodes[0] : season?.episodes.find(ep => String(ep.id) === videoId.slice(2));
    if (!episode) {
      if (videoId.startsWith('ep')) return { videoId, page: 1, title: videoId };
      throw Error('无法获取剧集列表，请在原页选择具体的一集（ep 链接）。');
    }
    return { videoId: 'ep' + episode.id, page: 1, title: episode.share_copy || [season?.title, episode.title, episode.long_title].filter(Boolean).join(' · '), cover: allowedCover(season?.cover) };
  }
  const detail = z.object({ bvid: z.string().regex(/^BV[A-Za-z0-9]{10}$/), title: z.string(), pic: z.string(), owner: z.object({name:z.string(),mid:z.number()}),
    pages: z.array(z.object({ page: z.number(), part: z.string() })) }).parse(await api(scope, '/x/web-interface/view', {
    [videoId.startsWith('BV') ? 'bvid' : 'aid']: videoId.startsWith('BV') ? videoId : videoId.slice(2),
  }, signal));
  const part = detail.pages.find(it => it.page === page);
  if (!part) throw Error('这个视频没有第 ' + page + ' P。');
  return { videoId: detail.bvid, page, title: detail.title + (detail.pages.length > 1 ? ' · P' + page + ' ' + part.part : ''),
    author: detail.owner.name, mid: String(detail.owner.mid), cover: allowedCover(detail.pic) };
}

// The website signs its upload-list query with the two public WBI image filenames from nav.
const mixinOrder = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
async function uploads(scope: Session, input: Extract<VideoToolInput,{action:'uploads'}>, signal: AbortSignal) {
  const url = 'https://space.bilibili.com/' + input.mid + '/upload/video';
  const { wbi_img } = z.object({ wbi_img: z.object({ img_url:z.string(), sub_url:z.string() }) }).parse(await api(scope, '/x/web-interface/nav', {}, signal, true));
  const key = [wbi_img.img_url, wbi_img.sub_url].map(value => new URL(value).pathname.split('/').pop()!.split('.')[0]).join('');
  const mixin = mixinOrder.map(index => key[index]).join('');
  const params: Record<string,string> = {mid: input.mid, keyword: input.keyword ?? '', order: input.order, pn: String(input.page), ps:'30', platform:'web', order_avoided:'true', wts:String(Math.floor(Date.now()/1000))};
  for (const field of Object.keys(params)) params[field] = params[field]!.replace(/[!'()*]/g, '');
  const signed = Object.keys(params).sort().map(k => k + '=' + encodeURIComponent(params[k]!)).join('&');
  params.w_rid = createHash('md5').update(signed + mixin).digest('hex');
  const data = await api(scope, '/x/space/wbi/arc/search', params, signal);
  const parsed = z.object({ list:z.object({ vlist:z.array(z.object({ bvid:z.string(),title:z.string(),play:z.union([z.number(),z.string()]),author:z.string() })) }) }).safeParse(data);
  if (!parsed.success) throw Error('UP 主投稿需要在内置浏览器登录或完成站方验证。' + url);
  return { url, source: 'uploads', page: input.page, items: parsed.data.list.vlist };
}

function discoveryUrl(input: Exclude<VideoToolInput,{action:'play'|'uploads'}>) {
  if (input.action === 'sections') return site + '/';
  if (input.action === 'section') return site + (catalog.includes(input.section) ? '/' : '/c/') + input.section + '/';
  if (input.action === 'ranking') {
    const slug = rankSlugs[input.section] ?? input.section;
    if (!rankCategories.includes(slug)) throw Error('此分区没有独立排行榜，可用 section 浏览分区。');
    return site + '/v/popular/rank/' + slug;
  }
  const params = new URLSearchParams({ keyword:input.keyword, page:String(input.page) });
  if (input.action === 'search') params.set('order',input.order);
  return 'https://search.bilibili.com/' + (input.action === 'creators' ? 'upuser' : 'video') + '?' + params;
}

// Run a fixed read-only projection inside Chromium. The site's own client loads its
// authenticated results. Only bounded labels and canonical site links cross the boundary.
const readLinks = `(action => {
  const selector = action === 'creators' ? '.b-user-info-card h2 a[href]' :
    action === 'sections' ? 'a:has(.channel-link__text)' :
    action === 'ranking' ? '.rank-list .info a.title,.rank-list .info a[class*="title"],.rank-item a.title' :
    'a[href*="/video/"],a[href*="/bangumi/play/"]';
  const links = new Map();
  for (const a of document.querySelectorAll(selector)) {
    const u = new URL(a.href,location.href);
    const title = (a.title || a.querySelector('[title]')?.title || a.querySelector('img')?.alt || a.innerText || '').trim().slice(0,240);
    if (!title || links.has(u.origin + u.pathname) || !['www.bilibili.com','space.bilibili.com'].includes(u.hostname)) continue;
    const owner = a.closest('.bili-video-card,.video-list-item')?.querySelector('a[href*="space.bilibili.com/"]');
    const mid = owner && /^https:\\/\\/space\\.bilibili\\.com\\/(\\d+)(?:[/?#]|$)/.exec(owner.href)?.[1];
    links.set(u.origin + u.pathname,{url:u.origin+u.pathname,title,...(mid ? {mid}: {})});
    if (links.size === 100) break;
  }
  const body = document.body?.innerText ?? '';
  return {links:[...links.values()],empty:/没有找到相关|没有相关搜索结果|未搜索到相关/.test(body),login:/扫码登录或扫码下载APP|请完成安全验证/.test(body)};
})`;
const projection = z.object({ links:z.array(z.object({url:z.string().max(2048),title:z.string().max(240),mid:z.string().regex(/^\d{1,19}$/).optional()})).max(100), empty:z.boolean(),login:z.boolean() });

async function browse(scope: Session, input: Exclude<VideoToolInput,{action:'play'|'uploads'}>, signal: AbortSignal) {
  const url = discoveryUrl(input);
  const view = new WebContentsView({ webPreferences:{ session:scope,sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false,backgroundThrottling:false } });
  view.setBounds({x:0,y:0,width:1200,height:850});
  const contents = view.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({action:'deny'}));
  const close = () => { if (!contents.isDestroyed()) contents.close(); };
  signal.addEventListener('abort',close,{once:true});
  try {
    signal.throwIfAborted();
    await contents.loadURL(url);
    while (true) {
      signal.throwIfAborted();
      const snapshot = projection.parse(await contents.executeJavaScriptInIsolatedWorld(1001, [{code: readLinks + '(' + JSON.stringify(input.action) + ')'}]));
      if (input.action === 'ranking' && new URL(contents.getURL()).pathname !== new URL(url).pathname) throw Error('哔哩哔哩暂未提供所选榜单。' + url);
      const items = snapshot.links.flatMap((link): Record<string,string>[] => {
        const address = new URL(link.url);
        if (input.action === 'sections') {
          const match = /^\/(?:c\/([a-z_]+)|([a-z]+))\/?$/.exec(address.pathname);
          const section = match?.[1] ?? match?.[2];
          return address.origin === site && section && (match?.[1] || catalog.includes(section)) ? [{...link,section}] : [];
        }
        if (input.action === 'creators') {
          const mid = /^\/(\d+)\/?$/.exec(address.pathname)?.[1];
          return address.origin === 'https://space.bilibili.com' && mid ? [{...link,mid}] : [];
        }
        try { const video = parseVideo(link.url); return [{title:link.title, video:video.videoId, url:videoPageUrl(video), ...(link.mid && {mid:link.mid})}]; } catch { return []; }
      });
      if (items.length || snapshot.empty) return {url,items};
      if (snapshot.login) throw Error('请在内置浏览器登录或完成站方验证。' + url);
      await delay(300,undefined,{signal});
    }
  } finally { signal.removeEventListener('abort',close); close(); }
}

export async function bilibiliTool(scope: Session, input: VideoToolInput, abort: AbortSignal): Promise<{card?:Omit<VideoShare,'id'>; result?:unknown}> {
  const timeout = AbortSignal.timeout(25_000), signal = AbortSignal.any([abort, timeout]);
  try {
    if (input.action === 'play') return {card: await resolveVideo(scope,input.video,signal)};
    if (input.action === 'uploads') {
      try { return {result: await uploads(scope, input, signal)}; }
      catch (error) {
        signal.throwIfAborted();
        const profile = 'https://space.bilibili.com/' + input.mid + '/upload/video';
        if (!input.creatorName) throw Error(String(error) + ' 投稿页：' + profile + '。可用 creators 找到 UP 主名称后传入 creatorName 查询公开搜索结果。', {cause:error});
        const found = await browse(scope, {action:'search',keyword:[input.creatorName,input.keyword].filter(Boolean).join(' '),order:input.order,page:input.page}, signal);
        return {result:{source:'public-search',profile,url:found.url,page:input.page,items:found.items.filter(item => item.mid === input.mid),
          note:'投稿列表暂不可用。此处仅包含本站搜索中与指定 UID 相符的公开结果。'}};
      }
    }
    return {result: await browse(scope,input,signal)};
  } catch (error) {
    abort.throwIfAborted();
    if (timeout.aborted) throw Error('B 站网页加载超时，请在内置浏览器确认页面可用。' + (input.action !== 'play' && input.action !== 'uploads' ? discoveryUrl(input) : ''), {cause:error});
    throw error;
  }
}
