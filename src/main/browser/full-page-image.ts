import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

const busy = new WeakSet<WebContents>();
/** Chromium captures the complete document in the existing authenticated tab.
 * No viewport resize, second browser, cookie export or main-process image decode. */
export async function fullPageImage(contents: WebContents, isCurrent = () => true): Promise<Buffer> {
  if (busy.has(contents)) throw Error('此网页正在生成长图，请稍候。');
  if (contents.isDestroyed() || contents.debugger.isAttached()) throw Error('网页已关闭或调试器正在使用，请稍后重试。');
  busy.add(contents);
  const key = '__worldlinebox_capture_' + randomUUID().replaceAll('-', ''), timeout = AbortSignal.timeout(30000);
  let attached = false, navigated = false;
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) navigated = true; };
  const check = () => { timeout.throwIfAborted(); if (contents.isDestroyed() || navigated || !isCurrent()) throw Error('网页已跳转或关闭，请在加载完成后重新生成长图。'); };
  const cancel = () => { if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { cancel(); rejectAbort(new Error('网页长图生成超时，请在页面加载完成后重试。')); };
  const wait = <T>(pending: Promise<T>) => Promise.race([pending, aborted]);
  contents.on('did-start-navigation', navigation); timeout.addEventListener('abort', abort, { once: true });
  try {
    check(); contents.debugger.attach('1.3'); attached = true;
    const prepared = await wait(contents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(async()=>{
      const images=[...document.images].filter(image=>image.getAttribute('loading')==='lazy').slice(0,500);
      globalThis[${JSON.stringify(key)}]=images.map(image=>({image,loading:image.getAttribute('loading')}));
      for(const image of images)image.loading='eager';
      await Promise.race([Promise.allSettled([document.fonts.ready,...images.map(image=>image.decode())]),new Promise(resolve=>setTimeout(resolve,2500))]);
      return {pixelRatio:devicePixelRatio};
    })()` }])) as { pixelRatio?: number } | undefined;
    check();
    const metrics = await wait(contents.debugger.sendCommand('Page.getLayoutMetrics')) as { cssContentSize?: { x: number; y: number; width: number; height: number } };
    const size = metrics.cssContentSize;
    if (!size || ![size.x, size.y, size.width, size.height].every(Number.isFinite) || size.width < 1 || size.height < 1) throw Error('当前网页没有可用的页面内容。');
    const width = Math.ceil(size.width), height = Math.ceil(size.height);
    const ratio = prepared?.pixelRatio ?? 1;
    if (!Number.isFinite(ratio) || ratio <= 0 || width * ratio > 16384 || height * ratio > 65500 || width * height * ratio * ratio > 64000000) throw Error('网页尺寸过大，无法生成单张长图；请缩小页面缩放比例后重试。');
    check();
    const result = await wait(contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: size.x, y: size.y, width, height, scale: 1 } })) as { data?: unknown };
    check();
    if (typeof result.data !== 'string' || result.data.length > 90 * 1024 * 1024) throw Error('网页长图数据无效或过大。');
    const bytes = Buffer.from(result.data, 'base64');
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) throw Error('网页未生成有效的 PNG 长图。');
    return bytes;
  } finally {
    timeout.removeEventListener('abort', abort); contents.removeListener('did-start-navigation', navigation);
    if (!contents.isDestroyed()) {
      let restoreTimer: ReturnType<typeof setTimeout> | undefined;
      if (!navigated) try {
        await Promise.race([contents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(()=>{for(const item of globalThis[${JSON.stringify(key)}]??[])if(item.image.isConnected)item.image.setAttribute('loading',item.loading);delete globalThis[${JSON.stringify(key)}];})()` }]).catch(() => undefined), new Promise<void>(resolve => { restoreTimer = setTimeout(resolve, 1000); })]);
      } finally { if (restoreTimer) clearTimeout(restoreTimer); }
      cancel();
    }
    busy.delete(contents);
  }
}
