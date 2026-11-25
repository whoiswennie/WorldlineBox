import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { app, desktopCapturer, dialog, screen, type BrowserWindow, type Display } from 'electron';
import sharp from 'sharp';
import { BOT_DESKTOP_HOST_EVENT, BOT_DESKTOP_AGENT_EVENT, BOT_DESKTOP_AUDIO_SECONDS, BOT_PRESENCE_ACTIVITY_CHANNEL, BOT_PRESENCE_CAPTURE_EDGE, type BotDesktopAgentCommand, type BotDesktopCaptureScope, type BotDesktopCaptureToolArguments, type BotMediaRequest, type BotMediaResponse, type BotPresenceActivity, type BotPresenceEnergy } from '../../shared/companion-bot-media';
import { validateSpeechWave } from '../../shared/local-speech';
import type { LocalSpeechService } from '../local-speech-service';
import { callPetFor } from './call-pet-window';
import { assertBotMediaPhysicalPath, type BotMediaService } from './media-service';
import { startDesktopVideo } from './desktop-video';
import { DesktopPresence, type PresenceSample, type PresenceTarget } from './desktop-presence';
import { composePresenceFrames, recognizePresenceAudio, samplePresenceFrames } from './presence-video';
import { PresenceArchive, type PresenceRecording } from './presence-archive';
import { abortable } from './abortable';
import type { BotDesktopActivity, BotPresenceStatus } from '../../shared/companion-bot-media';

type CaptureRequest = Extract<BotMediaRequest, { requestId: string }>;
type CaptureScope = BotDesktopCaptureScope;
type Recording = { scope: CaptureScope; target: BrowserWindow; granted: boolean; active?: boolean; expires: number; seconds: number; kind: 'listen' | 'watch';
  timer?: ReturnType<typeof setTimeout>; video?: Promise<Awaited<ReturnType<typeof startDesktopVideo>>>; finishing?: boolean; bytes: number };
export type BotDesktopAgentResult = Pick<BotMediaResponse, 'ok' | 'error' | 'cancelled' | 'durationSeconds' | 'transcript'> & { image?: Uint8Array };
type AgentJob = { standalone: boolean; command: CaptureScope & BotDesktopCaptureToolArguments; complete(result: BotDesktopAgentResult): void;
  reject(error: unknown): void; handshake: ReturnType<typeof setTimeout> };
const formats = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma', 'amr', 'ape',
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpeg', 'mpg', 'ts', 'm2ts', 'wmv', 'flv'];

function sameCapture(a: CaptureScope, b: CaptureScope) {
  return a.requestId === b.requestId && a.conversationId === b.conversationId && a.surface === b.surface;
}

async function displaySource(display: Display, thumbnailSize: { width: number; height: number }) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
  const source = sources.find(item => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
  if (!source) throw Error('找不到当前显示器，请在目标屏幕上重新打开聊天。');
  return source;
}

function timestamp(seconds: number) {
  const time = Math.floor(seconds);
  return [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export function createBotDesktopCapture(speech: () => LocalSpeechService, ffmpeg: () => string | undefined, onActivity?: (activity?: BotDesktopActivity) => void) {
  const archive = new PresenceArchive(path.join(app.getPath('userData'), 'presence-recordings'));

  async function prepareRecord(record: PresenceRecording, signal: AbortSignal, audioBudget: AbortSignal) {
    signal.throwIfAborted();
    const originalPath = await archive.original(record, signal);
    const duration = (record.at - record.startedAt) / 1000;
    if (record.kind === 'screen') {
      const jpeg = await sharp(record.bytes).resize(480, 270, { fit: 'contain', background: '#141b29' }).jpeg({ quality: 85 }).toBuffer();
      return { originalPath, duration, frames: [{ seconds: 0, jpeg, detail: async () => Buffer.from(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength) }], audio: undefined };
    }
    const binary = ffmpeg();
    if (!binary) throw Error('陪伴模式的录像解码组件尚未准备好。');
    const audioSignal = AbortSignal.any([audioBudget, AbortSignal.timeout(35_000)]);
    const [frames, audio] = await Promise.all([
      samplePresenceFrames(binary, record.bytes, duration, 7, signal).catch(() => []),
      audioSignal.aborted ? undefined : abortable(recognizePresenceAudio(binary, record.bytes, speech(), 'presence-' + record.id, audioSignal), audioSignal).catch(() => undefined),
    ]);
    signal.throwIfAborted();
    return { originalPath, duration, frames, audio };
  }

  async function prepare(records: readonly PresenceRecording[], signal: AbortSignal): Promise<PresenceSample> {
    const origin = records[0]!.startedAt;
    const sources: PresenceSample['sources'] = [], subtitles: PresenceSample['subtitles'] = [];
    const frames = [];
    const audioBudget = AbortSignal.any([signal, AbortSignal.timeout(55_000)]);
    let duration = 0;
    for (const record of records) {
      const item = await abortable(prepareRecord(record, signal, audioBudget), signal);
      const from = (record.startedAt - origin) / 1000, to = from + item.duration;
      duration = Math.max(duration, to);
      sources.push({ kind: record.kind, from, to, originalPath: item.originalPath, visual: item.frames.length ? 'available' : 'unavailable',
        audio: record.kind === 'video' ? item.audio ? 'recognized' : 'unavailable' : undefined });
      frames.push(...item.frames.map(frame => ({ ...frame, seconds: from + frame.seconds })));
      if (item.audio) subtitles.push(...item.audio.segments.map(segment => ({ ...segment, startSeconds: from + segment.startSeconds, endSeconds: from + segment.endSeconds })));
    }
    frames.sort((left, right) => left.seconds - right.seconds);
    subtitles.sort((left, right) => left.startSeconds - right.startSeconds);
    const screenshots = records.every(record => record.kind === 'screen');
    return { records, sources, subtitles, frames: await composePresenceFrames(frames, duration, signal, screenshots) };
  }
  let recording: Recording | undefined;
  let presence: { scope: CaptureScope; target: BrowserWindow; energy: BotPresenceEnergy; granted: boolean; expires: number; session: DesktopPresence;
    recording?: boolean; deadline: ReturnType<typeof setTimeout>; unbind(): void } | undefined;
  let file: { scope: CaptureScope; cancelled: boolean; started: boolean } | undefined;
  let processing: CaptureScope | undefined;
  let agent: AgentJob | undefined;
  const surfacesReady = new Map<CaptureScope['surface'], { scope: CaptureScope; target: BrowserWindow; frame: Electron.WebFrameMain }>();
  const bound = new WeakSet<Electron.Session>();
  const targetFor = (owner: BrowserWindow, scope: CaptureScope) => scope.surface === 'pet' ? callPetFor(owner) : owner;
  const isActive = (owner: BrowserWindow, target: BrowserWindow, scope: CaptureScope) =>
    !owner.isDestroyed() && !target.isDestroyed() && targetFor(owner, scope) === target;
  let manualScreen: (CaptureScope & { activity: 'screenshot' | 'captured' }) | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity: BotDesktopActivity | undefined;
  function publishActivity(status = presence?.session.status()) {
    let activity: BotDesktopActivity | undefined = manualScreen?.activity;
    if (recording?.active) activity = recording.kind === 'watch' ? 'recording' : 'listening';
    if (!activity && status) {
      if (status.screenshot === 'capturing') activity = 'screenshot';
      else if (presence?.recording) activity = 'recording';
      else if (status.phase === 'observing') activity = 'observing';
      else if (status.screenshot === 'just-captured') activity = 'captured';
    }
    if (lastActivity !== activity) { lastActivity = activity; onActivity?.(activity); }
  }

  function bind(owner: BrowserWindow) {
    const session = owner.webContents.session;
    if (bound.has(session)) return;
    bound.add(session);
    // The regular screenshot/recording window has its own Electron session.
    session.setDisplayMediaRequestHandler((request, callback) => {
      const grant = recording && !recording.granted ? recording : presence;
      if (!grant || grant.granted || Date.now() >= grant.expires || grant.target.isDestroyed() ||
          request.frame !== grant.target.webContents.mainFrame || !request.userGesture || !request.videoRequested || !request.audioRequested) {
        callback({}); return;
      }
      grant.granted = true;
      const display = recording === grant && agent?.standalone ? screen.getPrimaryDisplay() : screen.getDisplayMatching(grant.target.getBounds());
      void displaySource(display, { width: 0, height: 0 }).then(source => {
        if (recording !== grant && presence !== grant || grant.target.isDestroyed() || Date.now() >= grant.expires) { callback({}); return; }
        callback({ video: source, audio: 'loopback' });
        publishActivity();
      }, () => callback({}));
    });
  }

  function release(grant: Recording) {
    if (recording === grant) recording = undefined;
    publishActivity();
    clearTimeout(grant.timer);
    if (!grant.finishing) void grant.video?.then(video => video.dispose()).catch(() => undefined);
  }

  function cancel(scope: CaptureScope) {
    if (manualScreen?.activity === 'screenshot' && sameCapture(manualScreen, scope)) manualScreen = undefined;
    if (presence && sameCapture(presence.scope, scope)) {
      const current = presence; presence = undefined;
      clearTimeout(current.deadline);
      current.unbind();
      current.session.close();
    }
    if (recording && sameCapture(recording.scope, scope)) release(recording);
    if (processing && sameCapture(processing, scope)) speech().cancel(scope.requestId);
    if (agent && sameCapture(agent.command, scope)) agent.complete({ ok: true, cancelled: true });
    if (file && sameCapture(file.scope, scope)) {
      file.cancelled = true;
      if (file.started) speech().cancel(scope.requestId);
    }
    publishActivity();
  }

  async function screenshot(display: Display, request: CaptureScope, active: () => boolean): Promise<BotDesktopAgentResult> {
    const width = Math.round(display.size.width * display.scaleFactor);
    const height = Math.round(display.size.height * display.scaleFactor);
    const scale = Math.min(1, 2560 / Math.max(width, height));
    clearTimeout(receiptTimer);
    manualScreen = { ...request, activity: 'screenshot' };
    publishActivity();
    try {
      const source = await displaySource(display, { width: Math.round(width * scale), height: Math.round(height * scale) });
      if (!active() || !manualScreen || !sameCapture(manualScreen, request)) return { ok: true, cancelled: true };
      if (source.thumbnail.isEmpty()) throw Error('未取得屏幕画面，请检查系统的屏幕共享权限。');
      const image = source.thumbnail.toPNG();
      manualScreen.activity = 'captured';
      receiptTimer = setTimeout(() => { manualScreen = undefined; publishActivity(); }, 3000);
      receiptTimer.unref();
      return { ok: true, image };
    } finally {
      if (manualScreen?.activity === 'screenshot' && sameCapture(manualScreen, request)) manualScreen = undefined;
      publishActivity();
    }
  }

  function dispatch(target: BrowserWindow, command: BotDesktopAgentCommand, standalone: boolean) {
    return target.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(standalone ? BOT_DESKTOP_HOST_EVENT : BOT_DESKTOP_AGENT_EVENT)}, { detail: ${JSON.stringify(command)} }));`, command.operation !== 'cancel');
  }

  return {
    cancel,
    endMeeting(room: string) { if (presence?.scope.conversationId === room) cancel(presence.scope); },
    stopPresence() { clearTimeout(receiptTimer); manualScreen = undefined; if (presence) cancel(presence.scope); archive.close(); publishActivity(); },
    async runForAgent(owner: BrowserWindow | undefined, conversationId: string, preferPet: boolean, input: BotDesktopCaptureToolArguments, signal: AbortSignal) {
      const surfaces = preferPet ? ['pet', 'chat'] as const : ['chat', 'pet'] as const;
      const allowed = surfaces.find(surface => {
        if (!owner || owner.isDestroyed()) return false;
        const target = surface === 'pet' ? callPetFor(owner) : owner;
        const grant = surfacesReady.get(surface);
        return grant?.scope.conversationId === conversationId && target === grant.target && !target.isDestroyed()
          && target.webContents.mainFrame === grant.frame && target.isVisible() && !target.isMinimized();
      });
      if (agent || recording || processing || file || manualScreen?.activity === 'screenshot') return { ok: false, error: '已有桌面采集任务正在运行。' } satisfies BotMediaResponse;
      signal.throwIfAborted();
      const command = { ...input, conversationId, surface: allowed ?? 'chat' as const, requestId: randomUUID() };
      if (!allowed && input.operation === 'screen') {
        return screenshot(screen.getPrimaryDisplay(), command, () => !signal.aborted);
      }
      if (!owner || owner.isDestroyed()) return { ok: false, error: '应用的音视频采集组件尚未就绪。' };
      const target = targetFor(owner, command)!;
      const result = new Promise<BotDesktopAgentResult>((complete, reject) => {
        const handshake = setTimeout(() => complete({ ok: false, error: '桌面采集组件没有响应，请重试。' }), 10_000);
        agent = { standalone: !allowed, command, complete, reject, handshake };
      });
      const job = agent!;
      const timeout = setTimeout(() => job.complete({ ok: false, error: '伙伴桌面采集超时。' }), 210_000);
      const abort = () => job.reject(signal.reason ?? Error('伙伴已停止采集。'));
      const close = () => job.complete({ ok: true, cancelled: true });
      signal.addEventListener('abort', abort, { once: true });
      target.once('closed', close);
      void dispatch(target, command, job.standalone).catch(job.reject);
      let completed = false;
      try {
        const response = await result;
        completed = response.ok && !response.cancelled;
        return response;
      }
      finally {
        if (agent === job) agent = undefined;
        clearTimeout(job.handshake); clearTimeout(timeout);
        signal.removeEventListener('abort', abort); target.removeListener('closed', close);
        cancel(command);
        if (!completed && !target.isDestroyed()) void dispatch(target, { ...command, operation: 'cancel' }, job.standalone).catch(() => undefined);
      }
    },
    async capture(owner: BrowserWindow, request: Exclude<CaptureRequest, { type: 'desktop.cancel' }>, media: BotMediaService, presenceTarget: () => PresenceTarget): Promise<BotMediaResponse> {
      if (request.type === 'desktop.presence.archive.list') {
        if (request.show) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); }
        return { ok: true, ...archive.timeline(request.conversationId, request.before) };
      }
      if (request.type === 'desktop.presence.archive.read') return { ok: true, recordingBytes: archive.read(request.conversationId, request.id) };
      if (request.type === 'desktop.presence.archive.clear') {
        await archive.clear(request.conversationId);
        return { ok: true, ...archive.timeline(request.conversationId) };
      }
      const target = targetFor(owner, request);
      if (request.type === 'desktop.surface.ready' || request.type === 'desktop.surface.closed') {
        const current = surfacesReady.get(request.surface);
        if (request.type === 'desktop.surface.ready') {
          if (!target || target.isDestroyed()) return { ok: true, cancelled: true };
          surfacesReady.set(request.surface, { scope: request, target, frame: target.webContents.mainFrame });
        } else if (current && sameCapture(current.scope, request)) {
          surfacesReady.delete(request.surface);
          if (agent && !agent.standalone && agent.command.surface === request.surface && agent.command.conversationId === request.conversationId) cancel(agent.command);
        }
        return { ok: true };
      }
      if (process.platform !== 'win32' || !target || target.isDestroyed()) throw Error('当前窗口无法使用桌面采集。');
      const tool = agent && sameCapture(agent.command, request) ? agent : undefined;
      if (request.type === 'desktop.failed') {
        tool?.complete({ ok: false, error: request.error });
        return { ok: !!tool };
      }
      if (!tool && (request.type === 'desktop.screen' || request.type.startsWith('desktop.audio.') || request.type.startsWith('desktop.video.')))
        throw Error('桌面截图、录屏和录音由当前伙伴按需采集。');
      if (tool) {
        const expected = tool.command.operation === 'watch' ? 'desktop.video.' : tool.command.operation === 'listen' ? 'desktop.audio.' : 'desktop.screen';
        if (!request.type.startsWith(expected) || 'seconds' in request && request.seconds !== (tool.command.seconds ?? BOT_DESKTOP_AUDIO_SECONDS)) {
          throw Error('采集操作与本轮伙伴请求不一致。');
        }
        clearTimeout(tool.handshake);
      }
      const complete = (result: BotDesktopAgentResult) => {
        tool?.complete(result);
        return { ok: true, cancelled: result.cancelled };
      };
      const active = () => isActive(owner, target, request);
      const { conversationId, requestId } = request;
      try { switch (request.type) {
        case 'desktop.presence.start': {
          if (presence || recording && !recording.granted) throw Error('已有陪伴模式或录制正在连接，请先结束它。');
          if (request.energy !== 'low' && !ffmpeg()) throw Error('陪伴模式的录像解码组件尚未准备好。');
          const display = screen.getDisplayMatching(target.getBounds());
          let screenshot: ReturnType<typeof displaySource> | undefined;
          const session = new DesktopPresence(request.energy, presenceTarget(), {
            beginRound: (at, waitMs) => archive.beginRound(conversationId, at, waitMs),
            updateRound: (id, state, records, error) => archive.updateRound(id, state, records, error),
            notify: (status: BotPresenceStatus) => {
              if (!presence || !sameCapture(presence.scope, request) || owner.isDestroyed() || owner.webContents.isDestroyed()) return;
              publishActivity(status);
              owner.webContents.send(BOT_PRESENCE_ACTIVITY_CHANNEL, { conversationId, requestId, surface: request.surface, status } satisfies BotPresenceActivity);
            },
            screen: async signal => {
              const width = display.size.width * display.scaleFactor, height = display.size.height * display.scaleFactor;
              const scale = Math.min(1, BOT_PRESENCE_CAPTURE_EDGE / Math.max(width, height));
              screenshot ??= displaySource(display, { width: Math.round(width * scale), height: Math.round(height * scale) })
                .finally(() => { screenshot = undefined; });
              const source = await abortable(screenshot, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
              signal.throwIfAborted();
              if (source.thumbnail.isEmpty()) throw Error('陪伴模式没有取得屏幕画面。');
              return source.thumbnail.toJPEG(92);
            },
            prepare,
            canCapture: () => archive.canCapture(),
            add: (kind, bytes, startedAt, at) => archive.add(conversationId, kind, bytes, startedAt, at),
            claim: () => archive.claim(conversationId),
            discardPending: () => archive.discardPending(conversationId),
            finish: (records, success, obsolete) => archive.finish(records, success, obsolete),
          });
          const closed = () => cancel(request);
          const deadline = setTimeout(closed, 30_000);
          const contents = target.webContents;
          const navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
            if (event.isMainFrame && !event.isSameDocument) closed();
          };
          presence = { scope: request, target, session, energy: request.energy, granted: request.energy === 'low', expires: Date.now() + 12_000, deadline, unbind() {
            target.off('closed', closed);
            if (!contents.isDestroyed()) { contents.off('render-process-gone', closed); contents.off('did-start-navigation', navigating); }
          } };
          target.once('closed', closed);
          target.webContents.once('render-process-gone', closed);
          contents.on('did-start-navigation', navigating);
          bind(owner);
          session.syncActivity(!!request.interacting);
          return { ok: true, presence: session.status() };
        }
        case 'desktop.presence.recording': case 'desktop.presence.clip': case 'desktop.presence.status': case 'desktop.presence.energy': case 'desktop.presence.flushed': case 'desktop.presence.interrupt': {
          const current = presence;
          if (!current || current.target !== target || !sameCapture(current.scope, request)) return { ok: true, cancelled: true };
          current.deadline.refresh();
          if (request.type === 'desktop.presence.recording' && request.cycle === current.session.status().cycle) {
            current.recording = current.granted && request.recording;
            if (current.recording) current.session.recordingStarted(request.cycle);
          }
          if (request.type === 'desktop.presence.status') {
            current.recording = current.granted && !!request.recording && request.recordingCycle === current.session.status().cycle;
            current.session.syncActivity(!!request.interacting);
            if (request.recordingCycle !== undefined) current.session.recordingStarted(request.recordingCycle);
          }
          if (request.type === 'desktop.presence.energy' && request.energy !== current.energy) {
            if (request.energy !== 'low' && !ffmpeg()) throw Error('陪伴模式的录像解码组件尚未准备好。');
            if (request.energy === 'low') current.granted = true;
            else if (current.energy === 'low') { current.granted = false; current.expires = Date.now() + 12_000; }
            current.energy = request.energy;
            current.session.setEnergy(request.energy);
          }
          if (request.type === 'desktop.presence.flushed') current.session.flushed(request.cycle);
          if (request.type === 'desktop.presence.interrupt') current.session.interrupt();
          if (request.type === 'desktop.presence.clip') {
            if (!current.granted) throw Error('屏幕和系统音轨还未连接。');
            current.session.putClip(request.bytes, request.startedAt, request.endedAt, request.cycle);
          }
          const status = current.session.status();
          publishActivity(status);
          return { ok: true, presence: status };
        }
        case 'desktop.screen': {
          const display = screen.getDisplayMatching(target.getBounds());
          return complete(await screenshot(display, request, () => active() && agent === tool));
        }
        case 'desktop.audio.activity': case 'desktop.video.activity': {
          if (recording?.granted && recording.target === target && sameCapture(recording.scope, request)) {
            recording.active = request.active; publishActivity();
          }
          return { ok: true };
        }
        case 'desktop.audio.begin': case 'desktop.video.begin': {
          if (recording || processing || presence && !presence.granted) throw Error('已有录制正在进行。');
          const kind = request.type === 'desktop.video.begin' ? 'watch' : 'listen';
          const grant: Recording = { scope: request, target, expires: Date.now() + (request.seconds + 25) * 1000, granted: false, seconds: request.seconds, kind, bytes: 0 };
          bind(owner);
          const binary = kind === 'watch' ? ffmpeg() : undefined;
          if (kind === 'watch' && !binary) throw Error('录像处理组件尚未准备好。');
          recording = grant;
          grant.timer = setTimeout(() => cancel(grant.scope), (request.seconds + 25) * 1000);
          try {
            if (binary) { grant.video = startDesktopVideo(app.getPath('temp'), binary); await grant.video; }
            if (recording !== grant) return complete({ ok: true, cancelled: true });
            return { ok: true };
          } catch (error) { release(grant); throw error; }
        }
        case 'desktop.video.chunk': case 'desktop.video.finish': {
          const grant = recording;
          if (!grant?.video || !grant.granted || grant.finishing || grant.target !== target || !sameCapture(grant.scope, request)) throw Error('录屏已结束，请重试。');
          if (request.type === 'desktop.video.chunk') {
            grant.bytes += request.bytes.byteLength;
            if (grant.bytes > 32 * 1024 * 1024) throw Error('录屏超过了 32 MiB 上限。');
            await (await grant.video).append(request.sequence, request.bytes);
            return { ok: true };
          }
          grant.finishing = true;
          processing = request;
          release(grant);
          const video = await grant.video;
          try {
            return await speech().run(requestId, async signal => {
              const evidence = await video.finish(speech(), grant.seconds, signal);
              signal.throwIfAborted();
              if (!active()) return complete({ ok: true, cancelled: true });
              const image = await readFile(evidence.paths[1]!);
              signal.throwIfAborted();
              return complete({ ok: true, image, transcript: evidence.text, durationSeconds: evidence.seconds });
            });
          } finally { processing = undefined; await video.dispose(); }
        }
        case 'desktop.audio.finish': {
          const grant = recording;
          if (grant?.kind !== 'listen' || !grant.granted || Date.now() >= grant.expires || !sameCapture(grant.scope, request) || grant.target !== target) throw Error('电脑声音录制已结束，请重试。');
          release(grant);
          const bytes = Buffer.from(request.audio, 'base64');
          const duration = validateSpeechWave(bytes);
          if (duration > grant.seconds) throw Error('这次录音超过了设定时长。');
          processing = request;
          try {
            const transcript = await speech().run(requestId, async signal => {
              const transcript = await speech().transcribeWave(bytes, signal);
              signal.throwIfAborted();
              return active() ? transcript : undefined;
            });
            return complete(transcript ? { ok: true, transcript: transcript.text, durationSeconds: duration } : { ok: true, cancelled: true });
          } finally { processing = undefined; }
        }
        case 'desktop.transcribe': {
          if (file) throw Error('已有音视频文件正在转写。');
          const job = { scope: request, cancelled: false, started: false };
          file = job;
          try {
            const selection = await dialog.showOpenDialog(target, { title: '选择要转写音轨的音视频文件', properties: ['openFile'],
              filters: [{ name: '音视频文件', extensions: formats }] });
            const selected = selection.filePaths[0];
            if (selection.canceled || !selected || !active() || job.cancelled) return { ok: true, cancelled: true };
            if (!formats.includes(path.extname(selected).slice(1).toLowerCase())) throw Error('请选择受支持的音视频文件。');
            await assertBotMediaPhysicalPath(selected);
            if (job.cancelled || !active()) return { ok: true, cancelled: true };
            job.started = true;
            return await speech().run(requestId, async signal => {
              const directory = await mkdtemp(path.join(app.getPath('temp'), 'wlb-bot-transcript-'));
              const output = path.join(directory, '音频转写.txt');
              try {
                const handle = await open(output, 'wx', 0o600);
                let voiced = false;
                try {
                  await handle.writeFile('本地语音识别转写\n来源文件 ' + path.basename(selected).replace(/[\r\n]/g, ' ') + '\n\n');
                  const transcript = await speech().transcribeFile(selected, signal, async segment => {
                    voiced = true;
                    await handle.writeFile(`[${timestamp(segment.startSeconds)} – ${timestamp(segment.endSeconds)}]\n${segment.text}\n\n`);
                  });
                  if (!voiced) await handle.writeFile('没有识别到可转写的语音。\n');
                  await handle.writeFile('音轨总时长 ' + timestamp(transcript.audioSeconds) + '\n');
                } finally { await handle.close(); }
                signal.throwIfAborted();
                if (!active()) return { ok: true, cancelled: true };
                return { ok: true, media: await media.importFiles({ conversationId, paths: [output] }) };
              } finally {
                await rm(output, { force: true });
                await rmdir(directory);
              }
            }, true);
          } finally { file = undefined; }
        }
      } } catch (error) {
        if (tool) tool.complete({ ok: false, error: error instanceof Error ? error.message : '伙伴桌面采集失败。' });
        throw error;
      }
    },
  };
}
