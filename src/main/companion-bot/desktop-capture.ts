import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { app, desktopCapturer, dialog, screen, type BrowserWindow, type Display } from 'electron';
import sharp from 'sharp';
import { BOT_DESKTOP_AGENT_EVENT, BOT_DESKTOP_AUDIO_SECONDS, type BotDesktopAgentCommand, type BotDesktopCaptureScope, type BotDesktopCaptureToolArguments, type BotMediaRequest, type BotMediaResponse, type BotPresenceEnergy } from '../../shared/companion-bot-media';
import { validateSpeechWave } from '../../shared/local-speech';
import type { LocalSpeechService } from '../local-speech-service';
import { callPetFor } from './call-pet-window';
import { assertBotMediaPhysicalPath, type BotMediaService } from './media-service';
import { startDesktopVideo } from './desktop-video';
import { DesktopPresence, type PresenceSample, type PresenceTarget } from './desktop-presence';
import { composePresenceFrames, recognizePresenceAudio, samplePresenceFrames } from './presence-video';
import { PresenceArchive, type PresenceRecording } from './presence-archive';
import { abortable } from './abortable';

type CaptureRequest = Extract<BotMediaRequest, { requestId: string }>;
type CaptureScope = BotDesktopCaptureScope;
type Recording = { scope: CaptureScope; target: BrowserWindow; granted: boolean; expires: number; seconds: number; kind: 'listen' | 'watch';
  timer?: ReturnType<typeof setTimeout>; video?: Promise<Awaited<ReturnType<typeof startDesktopVideo>>>; finishing?: boolean; bytes: number };
export type BotDesktopAgentResult = Pick<BotMediaResponse, 'ok' | 'error' | 'cancelled' | 'durationSeconds' | 'transcript'> & { image?: Uint8Array };
type AgentJob = { command: CaptureScope & BotDesktopCaptureToolArguments; complete(result: BotDesktopAgentResult): void;
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

export function createBotDesktopCapture(speech: () => LocalSpeechService, ffmpeg: () => string | undefined) {
  const archive = new PresenceArchive(path.join(app.getPath('userData'), 'presence-recordings'));
  const staged = new WeakMap<PresenceRecording, ReturnType<typeof prepareRecord>>();
  let preparing = Promise.resolve<unknown>(undefined);

  async function prepareRecord(record: PresenceRecording, signal: AbortSignal) {
    signal.throwIfAborted();
    const originalPath = await archive.original(record, signal);
    const duration = (record.at - record.startedAt) / 1000;
    if (record.kind === 'screen') {
      const jpeg = await sharp(record.bytes).resize(352, 198, { fit: 'contain', background: '#141b29' }).jpeg({ quality: 80 }).toBuffer();
      return { originalPath, duration, frames: [{ seconds: 0, jpeg }], audio: undefined };
    }
    const binary = ffmpeg();
    if (!binary) throw Error('陪伴模式的录像解码组件尚未准备好。');
    const audioSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
    const [frames, audio] = await Promise.all([
      samplePresenceFrames(binary, record.bytes, duration, 7, signal).catch(() => []),
      abortable(recognizePresenceAudio(binary, record.bytes, speech(), 'presence-' + record.id, audioSignal), audioSignal).catch(() => undefined),
    ]);
    signal.throwIfAborted();
    return { originalPath, duration, frames, audio };
  }

  function stage(record: PresenceRecording, signal: AbortSignal) {
    const existing = staged.get(record);
    if (existing) return existing;
    const job = preparing.then(() => prepareRecord(record, signal));
    staged.set(record, job);
    preparing = job.catch(() => { staged.delete(record); });
    return job;
  }

  async function prepare(records: readonly PresenceRecording[], signal: AbortSignal): Promise<PresenceSample> {
    const origin = records[0]!.startedAt;
    const sources: PresenceSample['sources'] = [], subtitles: PresenceSample['subtitles'] = [];
    const frames = [];
    let duration = 0;
    for (const record of records) {
      const item = await abortable(stage(record, signal), signal);
      const from = (record.startedAt - origin) / 1000, to = from + item.duration;
      duration = Math.max(duration, to);
      sources.push({ kind: record.kind, from, to, originalPath: item.originalPath,
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
    deadline: ReturnType<typeof setTimeout>; closed(): void } | undefined;
  let file: { scope: CaptureScope; cancelled: boolean; started: boolean } | undefined;
  let processing: CaptureScope | undefined;
  let agent: AgentJob | undefined;
  const surfacesReady = new Map<CaptureScope['surface'], { scope: CaptureScope; target: BrowserWindow; frame: Electron.WebFrameMain }>();
  const bound = new WeakSet<Electron.Session>();
  const targetFor = (owner: BrowserWindow, scope: CaptureScope) => scope.surface === 'pet' ? callPetFor(owner) : owner;
  const isActive = (owner: BrowserWindow, target: BrowserWindow, scope: CaptureScope) =>
    !owner.isDestroyed() && !target.isDestroyed() && targetFor(owner, scope) === target;

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
      const display = screen.getDisplayMatching(grant.target.getBounds());
      void displaySource(display, { width: 0, height: 0 }).then(source => {
        if (recording !== grant && presence !== grant || grant.target.isDestroyed() || Date.now() >= grant.expires) { callback({}); return; }
        callback({ video: source, audio: 'loopback' });
      }, () => callback({}));
    });
  }

  function release(grant: Recording) {
    if (recording === grant) recording = undefined;
    clearTimeout(grant.timer);
    if (!grant.finishing) void grant.video?.then(video => video.dispose()).catch(() => undefined);
  }

  function cancel(scope: CaptureScope) {
    if (presence && sameCapture(presence.scope, scope)) {
      const current = presence; presence = undefined;
      clearTimeout(current.deadline);
      current.target.removeListener('closed', current.closed);
      current.session.close();
    }
    if (recording && sameCapture(recording.scope, scope)) release(recording);
    if (processing && sameCapture(processing, scope)) speech().cancel(scope.requestId);
    if (agent && sameCapture(agent.command, scope)) agent.complete({ ok: true, cancelled: true });
    if (file && sameCapture(file.scope, scope)) {
      file.cancelled = true;
      if (file.started) speech().cancel(scope.requestId);
    }
  }

  function dispatch(target: BrowserWindow, command: BotDesktopAgentCommand) {
    return target.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(BOT_DESKTOP_AGENT_EVENT)}, { detail: ${JSON.stringify(command)} }));`, command.operation !== 'cancel');
  }

  return {
    cancel,
    stopPresence() { if (presence) cancel(presence.scope); archive.close(); },
    async runForAgent(owner: BrowserWindow, conversationId: string, preferPet: boolean, input: BotDesktopCaptureToolArguments, signal: AbortSignal) {
      const surfaces = preferPet ? ['pet', 'chat'] as const : ['chat', 'pet'] as const;
      const allowed = surfaces.find(surface => {
        const target = surface === 'pet' ? callPetFor(owner) : owner;
        const grant = surfacesReady.get(surface);
        return grant?.scope.conversationId === conversationId && target === grant.target && !target.isDestroyed()
          && target.webContents.mainFrame === grant.frame && target.isVisible() && !target.isMinimized();
      });
      if (!allowed) return { ok: false, error: '当前聊天或桌宠窗口暂时不可用，无法采集桌面。' } satisfies BotMediaResponse;
      if (agent || recording || processing || file) return { ok: false, error: '已有桌面采集任务正在运行。' } satisfies BotMediaResponse;
      signal.throwIfAborted();
      const command = { ...input, conversationId, surface: allowed, requestId: randomUUID() };
      const target = targetFor(owner, command)!;
      const result = new Promise<BotDesktopAgentResult>((complete, reject) => {
        const handshake = setTimeout(() => complete({ ok: false, error: '当前聊天窗口未接收采集请求，请确认桌面采集入口可用。' }), 10_000);
        agent = { command, complete, reject, handshake };
      });
      const job = agent!;
      const timeout = setTimeout(() => job.complete({ ok: false, error: '伙伴桌面采集超时。' }), 210_000);
      const abort = () => job.reject(signal.reason ?? Error('伙伴已停止采集。'));
      const close = () => job.complete({ ok: true, cancelled: true });
      signal.addEventListener('abort', abort, { once: true });
      target.once('closed', close);
      void dispatch(target, command).catch(job.reject);
      try { return await result; }
      finally {
        if (agent === job) agent = undefined;
        clearTimeout(job.handshake); clearTimeout(timeout);
        signal.removeEventListener('abort', abort); target.removeListener('closed', close);
        cancel(command);
        if (!target.isDestroyed()) void dispatch(target, { ...command, operation: 'cancel' }).catch(() => undefined);
      }
    },
    async capture(owner: BrowserWindow, request: Exclude<CaptureRequest, { type: 'desktop.cancel' }>, media: BotMediaService, presenceTarget: () => PresenceTarget): Promise<BotMediaResponse> {
      if (request.type === 'desktop.presence.archive.list') {
        if (request.show) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); }
        return { ok: true, recordings: archive.list(request.conversationId) };
      }
      if (request.type === 'desktop.presence.archive.read') return { ok: true, recordingBytes: archive.read(request.conversationId, request.id) };
      if (request.type === 'desktop.presence.archive.clear') {
        await archive.clear(request.conversationId);
        return { ok: true, recordings: archive.list(request.conversationId) };
      }
      const target = targetFor(owner, request);
      if (request.type === 'desktop.surface.ready' || request.type === 'desktop.surface.closed') {
        const current = surfacesReady.get(request.surface);
        if (request.type === 'desktop.surface.ready') {
          if (!target || target.isDestroyed()) return { ok: true, cancelled: true };
          surfacesReady.set(request.surface, { scope: request, target, frame: target.webContents.mainFrame });
        } else if (current && sameCapture(current.scope, request)) {
          surfacesReady.delete(request.surface);
          if (agent?.command.surface === request.surface && agent.command.conversationId === request.conversationId) cancel(agent.command);
        }
        return { ok: true };
      }
      if (process.platform !== 'win32' || !target || target.isDestroyed()) throw Error('当前窗口无法使用桌面采集。');
      const tool = agent && sameCapture(agent.command, request) ? agent : undefined;
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
        return { ok: true };
      };
      const active = () => isActive(owner, target, request);
      const display = screen.getDisplayMatching(target.getBounds());
      const { conversationId, requestId } = request;
      try { switch (request.type) {
        case 'desktop.presence.start': {
          if (presence || recording && !recording.granted) throw Error('已有陪伴模式或录制正在连接，请先结束它。');
          if (request.energy !== 'low' && !ffmpeg()) throw Error('陪伴模式的录像解码组件尚未准备好。');
          const session = new DesktopPresence(request.energy, presenceTarget(), {
            screen: async signal => {
              const width = display.size.width * display.scaleFactor, height = display.size.height * display.scaleFactor;
              const scale = Math.min(1, 960 / width, 540 / height);
              const source = await displaySource(display, { width: Math.round(width * scale), height: Math.round(height * scale) });
              signal.throwIfAborted();
              if (source.thumbnail.isEmpty()) throw Error('陪伴模式没有取得屏幕画面。');
              return source.thumbnail.toJPEG(76);
            },
            prepare,
            stage: (record, signal) => { void stage(record, signal).catch(() => undefined); },
            canCapture: () => archive.canCapture(),
            add: (kind, bytes, startedAt, at) => archive.add(conversationId, kind, bytes, startedAt, at),
            claim: () => archive.claim(conversationId),
            finish: (records, success) => archive.finish(records, success),
          });
          const closed = () => cancel(request);
          const deadline = setTimeout(() => { if (presence && sameCapture(presence.scope, request) && !presence.granted) cancel(request); }, 12_000);
          presence = { scope: request, target, session, energy: request.energy, granted: request.energy === 'low', expires: Date.now() + 12_000, deadline, closed };
          target.once('closed', closed);
          bind(owner);
          return { ok: true, presence: session.status() };
        }
        case 'desktop.presence.clip': case 'desktop.presence.status': case 'desktop.presence.energy': case 'desktop.presence.flushed': case 'desktop.presence.interrupt': {
          const current = presence;
          if (!current || current.target !== target || !sameCapture(current.scope, request)) return { ok: true, cancelled: true };
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
            current.session.putClip(request.bytes, request.startedAt, request.endedAt);
          }
          return { ok: true, presence: current.session.status() };
        }
        case 'desktop.screen': {
          const width = Math.round(display.size.width * display.scaleFactor);
          const height = Math.round(display.size.height * display.scaleFactor);
          const scale = Math.min(1, 2560 / Math.max(width, height));
          const source = await displaySource(display, { width: Math.round(width * scale), height: Math.round(height * scale) });
          if (!active() || tool && agent !== tool) return complete({ ok: true, cancelled: true });
          if (source.thumbnail.isEmpty()) throw Error('未取得屏幕画面，请检查系统的屏幕共享权限。');
          return complete({ ok: true, image: source.thumbnail.toPNG() });
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
