import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BrowserWindow, desktopCapturer, session } from 'electron';
import { COMPANION_WATCH_MAX_CLIP_BYTES, type CompanionObservationWatchDriver } from './observation-watch';

export interface CompanionObservationNativeWatchOptions {
  getFfmpeg?(): string | undefined | Promise<string | undefined>;
  temporaryRoot?: string;
}
const page = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; media-src blob:; img-src blob: data:; connect-src \'none\'"><title>Companion observation</title></head><body></body></html>';
/** Trusted renderer code receives neither Node, preload IPC, provider keys nor
 * a source picker. Its private Session grants exactly the host-selected source. */
const begin = `async function(seconds) {
  const original = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{max:12}},audio:false});
  const video = document.createElement('video'); video.muted=true; video.srcObject=original; await video.play();
  if (!video.videoWidth || !video.videoHeight) throw new Error('Native source has no actual video frames.');
  const ratio=Math.min(1,1280/video.videoWidth,720/video.videoHeight), canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));
  const context=canvas.getContext('2d',{alpha:false}); if(!context)throw new Error('Video sampling canvas unavailable.');
  const draw=()=>context.drawImage(video,0,0,canvas.width,canvas.height);draw();
  const rendered=canvas.captureStream(12), chunks=[];let bytes=0,failure,ended=false;
  const mime=['video/webm;codecs=vp8','video/webm'].find(value=>MediaRecorder.isTypeSupported(value));
  if(!mime)throw new Error('Native WebM recorder unavailable.');
  const recorder=new MediaRecorder(rendered,{mimeType:mime,videoBitsPerSecond:2000000});
  const started=performance.now(),startedAt=new Date().toISOString();
  const cleanup=()=>{clearInterval(paint);original.getTracks().forEach(track=>track.stop());rendered.getTracks().forEach(track=>track.stop());video.srcObject=null;};
  original.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(!ended)failure='Selected capture source ended.';}));
  recorder.ondataavailable=event=>{bytes+=event.data.size;if(bytes>${COMPANION_WATCH_MAX_CLIP_BYTES}){failure='Recorded clip exceeded the bounded native buffer.';if(recorder.state!=='inactive')recorder.stop();}else if(event.data.size)chunks.push(event.data);};
  recorder.onerror=()=>{failure='Native video recorder failed.';};
  const paint=setInterval(()=>{try{draw();}catch{failure='Selected video source could not be sampled.';}},83);
  window.companionWatch={
    frame(){if(failure||recorder.state==='inactive')throw new Error(failure||'Recorder is not active.');draw();return{data:canvas.toDataURL('image/png'),offsetMs:performance.now()-started};},
    finish(){return new Promise((resolve,reject)=>{if(failure){ended=true;cleanup();reject(new Error(failure));return;}
      recorder.onstop=async()=>{ended=true;const durationMs=performance.now()-started,endedAt=new Date().toISOString();cleanup();
        try{if(failure)throw new Error(failure);const data=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());
          let text='';for(let n=0;n<data.length;n+=32768)text+=String.fromCharCode(...data.subarray(n,n+32768));
          resolve({base64:btoa(text),startedAt,endedAt,durationMs,width:canvas.width,height:canvas.height});}catch(error){reject(error);}};
      recorder.stop();});}
  };recorder.start(200);return{startedAt,width:canvas.width,height:canvas.height};
}`;

function waitForFrame(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new Error('连续观察已停止。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function companionObservationRemuxArguments(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', input,
    '-map', '0:v:0', '-an', '-c', 'copy', '-f', 'webm', output];
}
async function finalize(bytes: Uint8Array, options: CompanionObservationNativeWatchOptions, signal: AbortSignal, verify: () => Promise<void>) {
  const binary = await options.getFfmpeg?.(); await verify(); signal.throwIfAborted();
  if (!binary) return bytes;
  const parent = path.resolve(options.temporaryRoot ?? path.join(tmpdir(), 'worldlinebox-companion-watch'));
  await mkdir(parent, { recursive: true }); const root = await realpath(parent), directory = await mkdtemp(path.join(root, 'clip-'));
  const cleanupPath = path.resolve(directory);
  if (path.dirname(cleanupPath) !== root || !path.basename(cleanupPath).startsWith('clip-')) throw new Error('Invalid observation scratch directory.');
  try {
    const source = path.join(directory, 'source.webm'), output = path.join(directory, 'indexed.webm');
    await writeFile(source, bytes, { flag: 'wx', mode: 0o600 }); await verify(); signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, companionObservationRemuxArguments(source, output), { windowsHide: true, stdio: 'ignore', signal });
      const deadline = setTimeout(() => { child.kill(); reject(new Error('连续观察视频封装超时，未交付不完整文件。')); }, 5000); deadline.unref();
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', code => { clearTimeout(deadline); if (code === 0) resolve(); else reject(new Error('连续观察的视频封装失败。')); });
    });
    await verify(); signal.throwIfAborted(); const finished = await readFile(output);
    if (!finished.byteLength || finished.byteLength > COMPANION_WATCH_MAX_CLIP_BYTES) throw new Error('连续观察的视频封装大小无效。');
    return finished;
  } finally {
    await rm(cleanupPath, { recursive: true, force: true });
  }
}

/** One invocation owns one hidden capture surface and one permission binding.
 * Independent companions never contend for CaptureTools' interactive session. */
export function createNativeCompanionObservationWatch(options: CompanionObservationNativeWatchOptions = {}): CompanionObservationWatchDriver {
  return async input => {
    const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
    signal.throwIfAborted(); await input.verify();
    const invocation = randomUUID(), captureUrl = 'https://companion-observation.invalid/' + invocation;
    const scope = session.fromPartition('worldlinebox-companion-watch-' + invocation);
    // getDisplayMedia needs a secure, non-opaque origin. A private HTTPS
    // protocol handler serves this fixed local page without any network I/O.
    scope.protocol.handle('https', request => request.url === captureUrl ? new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('', { status: 403 }));
    const window = new BrowserWindow({ show: false, width: 32, height: 32, frame: false, skipTaskbar: true, focusable: false,
      webPreferences: { session: scope, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    scope.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: details.url !== captureUrl }));
    let videoUsed = false, preflightUsed = false, checking = false;
    const owns = (contents: Electron.WebContents | null, main: boolean) => !signal.aborted && !window.isDestroyed() && contents === window.webContents && main;
    scope.setPermissionCheckHandler((contents, permission, _origin, details) => owns(contents, details.isMainFrame) && !videoUsed && permission === 'media' && details.mediaType === 'unknown');
    scope.setPermissionRequestHandler((contents, permission, callback, details) => {
      const request = details as Electron.MediaAccessPermissionRequest;
      const desktop = permission === 'display-capture' || permission === 'media' && Array.isArray(request.mediaTypes) && request.mediaTypes.length === 0;
      const allowed = owns(contents, details.isMainFrame) && desktop && !preflightUsed && !videoUsed;
      if (allowed) preflightUsed = true; callback(allowed);
    });
    scope.setDisplayMediaRequestHandler((request, callback) => {
      if (window.isDestroyed() || signal.aborted || videoUsed || request.frame !== window.webContents.mainFrame || request.frame.url !== captureUrl || !request.videoRequested || request.audioRequested) { callback({}); return; }
      videoUsed = true;
      void (async () => {
        await input.verify(); signal.throwIfAborted();
        const sources = await desktopCapturer.getSources({ types: [input.source.id.startsWith('window:') ? 'window' : 'screen'], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find(source => source.id === input.source.id && source.name === input.source.title && (source.display_id || undefined) === (input.source.displayId || undefined));
        if (!source) throw new Error('获准视频来源已经变化。');
        await input.verify(); signal.throwIfAborted(); callback({ video: source });
      })().catch(error => { controller.abort(error); callback({}); });
    });
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => { if (!window.isDestroyed()) window.destroy(); rejectAbort(signal.reason ?? new Error('连续观察已停止。')); };
    signal.addEventListener('abort', abort, { once: true });
    const bounded = <T>(operation: Promise<T>) => Promise.race([operation, aborted]);
    const deadline = setTimeout(() => controller.abort(new Error('连续观察本次录制未及时完成。')), (input.seconds + 12) * 1000); deadline.unref();
    const guard = setInterval(() => {
      if (checking || signal.aborted) return; checking = true;
      void input.verify().catch(error => controller.abort(error)).finally(() => { checking = false; });
    }, 250); guard.unref();
    try {
      await bounded(window.loadURL(captureUrl)); await input.verify();
      await bounded(window.webContents.executeJavaScript('(' + begin + ')(' + input.seconds + ')', true));
      const started = performance.now(), frames = [];
      for (let index = 0; index < input.frameCount; index++) {
        const wait = Math.max(0, input.seconds * 1000 * index / (input.frameCount - 1) - (performance.now() - started));
        if (wait) await bounded(waitForFrame(wait, signal));
        await input.verify(); signal.throwIfAborted();
        const frame = await bounded(window.webContents.executeJavaScript('window.companionWatch.frame()')) as { data: string; offsetMs: number };
        if (!frame.data.startsWith('data:image/png;base64,')) throw new Error('实际录制没有提供PNG序列帧。');
        frames.push({ bytes: Buffer.from(frame.data.slice('data:image/png;base64,'.length), 'base64'), offsetMs: frame.offsetMs });
      }
      await input.verify();
      const clip = await bounded(window.webContents.executeJavaScript('window.companionWatch.finish()')) as { base64: string; startedAt: string; endedAt: string; durationMs: number; width: number; height: number };
      await input.verify(); signal.throwIfAborted();
      const bytes = await bounded(finalize(Buffer.from(clip.base64, 'base64'), options, signal, input.verify));
      await input.verify(); signal.throwIfAborted();
      return { bytes, mime: 'video/webm', frames, startedAt: clip.startedAt, endedAt: clip.endedAt, durationMs: clip.durationMs, width: clip.width, height: clip.height };
    } finally {
      clearInterval(guard); clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (!window.isDestroyed()) window.destroy();
      scope.setDisplayMediaRequestHandler(null); scope.setPermissionRequestHandler(null); scope.setPermissionCheckHandler(null);
      scope.webRequest.onBeforeRequest(null); scope.protocol.unhandle('https'); await scope.clearStorageData().catch(() => undefined);
    }
  };
}
