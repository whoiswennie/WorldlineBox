import { app, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import workerSource from './page-image-worker.cjs?raw';

const busy = new WeakSet<WebContents>();
export interface PageImageResult { width: number; height: number; bandHeight: number; bands: number; bytes: number }
interface Options { directory: string; signal: AbortSignal; isCurrent?(): boolean; progress(phase: 'preparing' | 'capturing' | 'encoding', completed: number, total: number, size?: Omit<PageImageResult, 'bytes'>): void }

/** Capture small tiles in the authenticated tab and encode bands on a worker.
 * No full-bitmap allocation, document-pixel cap or fixed total-job timeout. */
export async function fullPageImage(contents: WebContents, options: Options): Promise<PageImageResult> {
  if (busy.has(contents)) throw Error('此网页正在生成长图，请稍候。');
  if (contents.isDestroyed() || contents.debugger.isAttached()) throw Error('网页已关闭或调试器正在使用，请稍后重试。');
  busy.add(contents);
  const { signal } = options, key = '__worldlinebox_capture_' + randomUUID().replaceAll('-', '');
  const throttling = contents.getBackgroundThrottling?.() ?? true;
  let attached = false, navigated = false, worker: Worker | undefined, sequence = 0;
  const pending = new Map<number, { resolve(value: { bytes?: number }): void; reject(error: Error): void }>();
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) navigated = true; };
  const check = () => { signal.throwIfAborted(); if (contents.isDestroyed() || navigated || options.isCurrent?.() === false) throw Error('网页已跳转或关闭，请在加载完成后重新生成长图。'); };
  const cancel = () => { if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) { attached = false; contents.debugger.detach(); } };
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => undefined);
  const abort = () => { cancel(); rejectAbort(new Error('已取消网页长图。')); };
  const wait = async <T>(promise: Promise<T>, operation = '网页截图'): Promise<T> => {
    // Bound stalled individual commands, not the duration of a large job.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, aborted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(operation + '长时间没有响应，请重试。')), 90000); })]); }
    finally { clearTimeout(timer); }
  };
  const callWorker = (message: Record<string, unknown>) => wait(new Promise<{ bytes?: number }>((resolve, reject) => { const seq = ++sequence; pending.set(seq, { resolve, reject }); worker!.postMessage({ ...message, seq }); }), '后台长图编码');
  contents.on('did-start-navigation', navigation); signal.addEventListener('abort', abort, { once: true });
  try {
    check(); contents.setBackgroundThrottling?.(false); options.progress('preparing', 0, 0); contents.debugger.attach('1.3'); attached = true;
    const prepared = await wait(contents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(async()=>{
      const images=[...document.images].filter(image=>image.getAttribute('loading')==='lazy');
      globalThis[${JSON.stringify(key)}]={images:images.map(image=>({image,loading:image.getAttribute('loading')})),x:scrollX,y:scrollY,hidden:[],scrollStyle:document.documentElement.style.scrollBehavior};
      document.documentElement.style.scrollBehavior='auto';
      for(const image of images)image.loading='eager';
      await Promise.race([Promise.allSettled([document.fonts.ready,...images.map(image=>image.decode())]),new Promise(resolve=>setTimeout(resolve,5000))]);
      return {pixelRatio:devicePixelRatio,viewportWidth:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight};
    })()` }])) as { pixelRatio?: number; viewportWidth?: number; viewportHeight?: number } | undefined;
    check();
    const metrics = await wait(contents.debugger.sendCommand('Page.getLayoutMetrics')) as { cssContentSize?: { x: number; y: number; width: number; height: number } };
    const size = metrics.cssContentSize, ratio = prepared?.pixelRatio ?? 1;
    if (!size || ![size.x, size.y, size.width, size.height, ratio].every(Number.isFinite) || size.width < 1 || size.height < 1 || ratio <= 0) throw Error('当前网页没有可用的页面内容。');
    const width = Math.ceil(size.width * ratio), height = Math.ceil(size.height * ratio);
    if (width > 0x7fffffff || height > 0x7fffffff) throw Error('网页尺寸超过 PNG 格式支持的范围。');
    const tileSize = Math.max(1, Math.min(2048, Math.floor((prepared?.viewportWidth ?? 2048) * ratio)));
    const bandHeight = Math.max(1, Math.min(1024, Math.floor((prepared?.viewportHeight ?? 1024) * ratio), Math.floor(4_000_000 / width))), bands = Math.ceil(height / bandHeight);
    const dimensions = { width, height, bandHeight, bands }, columns = Math.ceil(width / tileSize), total = columns * bands;
    options.progress('capturing', 0, total, dimensions);
    worker = new Worker(workerSource, { eval: true, name: 'WorldlineBox page image encoder', workerData: { directory: options.directory,
      sharpModule: createRequire(path.join(app.getAppPath(), 'package.json')).resolve('sharp') } });
    worker.on('message', (message: { seq?: number; bytes?: number; error?: string }) => {
      if (message.error) { const error = Error(message.error); for (const task of pending.values()) task.reject(error); pending.clear(); rejectAbort(error); }
      else if (message.seq) { pending.get(message.seq)?.resolve(message); pending.delete(message.seq); }
    });
    const failed = (error: Error) => { for (const task of pending.values()) task.reject(error); pending.clear(); rejectAbort(error); };
    worker.on('error', failed); worker.on('exit', code => { if (code) failed(Error(`长图后台编码进程已退出 (${code})。`)); });
    await callWorker({ type: 'start', ...dimensions });
    if (contents.capturePage) await wait(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }));
    let completed = 0;
    for (let y = 0; y < height; y += bandHeight) for (let x = 0; x < width; x += tileSize) {
      check(); const tileWidth = Math.min(tileSize, width - x), tileHeight = Math.min(bandHeight, height - y);
      const scroll = await wait(contents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(async()=>{
        const state=globalThis[${JSON.stringify(key)}];
        if(${y}>0&&state&&!state.suppressed){state.suppressed=true;for(const element of document.querySelectorAll('*')){const position=getComputedStyle(element).position;if(position==='fixed'||position==='sticky'){state.hidden.push([element,element.style.visibility,element.style.getPropertyPriority('visibility')]);element.style.setProperty('visibility','hidden','important');}}}
        window.scrollTo({left:${size.x + x / ratio},top:${size.y + y / ratio},behavior:'instant'});
        await Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,250))]);
        return {x:scrollX,y:scrollY};
      })()` }])) as { x: number; y: number } | undefined;
      // Capturing the viewport avoids Chromium rasterizing an enormous full-page
      // surface for every tile. Original scroll/styles are restored in finally.
      let bytes: Buffer, bitmap: { width: number; height: number } | undefined;
      if (contents.capturePage) {
        const zoom = contents.getZoomFactor(), image = await wait(contents.capturePage({ x: Math.max(0, Math.round((size.x + x / ratio - (scroll?.x ?? 0)) * zoom)), y: Math.max(0, Math.round((size.y + y / ratio - (scroll?.y ?? 0)) * zoom)),
          width: Math.max(1, Math.round(tileWidth / ratio * zoom)), height: Math.max(1, Math.round(tileHeight / ratio * zoom)) }, { stayHidden: true, stayAwake: true }));
        check(); if (image.isEmpty()) throw Error('网页尚未生成可用画面，请稍后重试。');
        // Windows NativeImage exposes BGRA pixels. Copy bounded pixels here;
        // colour conversion, scaling and all image compression stay on worker.
        if (process.platform === 'win32') {
          const size = image.getSize(); bytes = image.toBitmap();
          if (bytes.length === size.width * size.height * 4) bitmap = size;
          else bytes = image.toPNG();
        } else bytes = image.toPNG();
      } else {
        const result = await wait(contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
          clip: { x: size.x + x / ratio, y: size.y + y / ratio, width: tileWidth / ratio, height: tileHeight / ratio, scale: 1 } })) as { data?: unknown };
        check(); if (typeof result.data !== 'string') throw Error('网页没有返回有效的截图数据。'); bytes = Buffer.from(result.data, 'base64');
      }
      await callWorker({ type: 'tile', x, y, tileWidth, tileHeight, bytes, bitmap });
      options.progress('capturing', ++completed, total, dimensions);
    }
    options.progress('encoding', completed, total, dimensions);
    const result = await callWorker({ type: 'finish' }); check();
    return { ...dimensions, bytes: result.bytes! };
  } finally {
    signal.removeEventListener('abort', abort); contents.removeListener('did-start-navigation', navigation);
    if (!contents.isDestroyed() && !navigated) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([contents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(()=>{const state=globalThis[${JSON.stringify(key)}];if(!state)return;for(const item of state.images)if(item.image.isConnected)item.image.setAttribute('loading',item.loading);for(const [element,value,priority] of state.hidden)if(element.isConnected)element.style.setProperty('visibility',value,priority);window.scrollTo({left:state.x,top:state.y,behavior:'instant'});document.documentElement.style.scrollBehavior=state.scrollStyle;delete globalThis[${JSON.stringify(key)}];})()` }]).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(timer); }
    }
    cancel(); if (!contents.isDestroyed()) contents.setBackgroundThrottling?.(throttling); await worker?.terminate(); busy.delete(contents);
  }
}
