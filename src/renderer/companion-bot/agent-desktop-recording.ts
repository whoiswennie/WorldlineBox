import { BOT_DESKTOP_AUDIO_SECONDS, BOT_DESKTOP_HOST_EVENT, type BotDesktopAgentCommand, type BotDesktopCaptureScope, type BotMediaRequest, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { recordDesktopVideo } from './desktop-video-recorder';
import { speechBase64, VoiceRecorder } from './voice-recorder';

export type DesktopRecordingJob = { scope: BotDesktopCaptureScope; release?: () => void; display?: MediaStream };
type RecordingPhase = 'listen' | 'watch' | 'video-processing' | 'audio-to-text';

export async function recordForAgent(api: WorldlineBoxBotMediaApi, job: DesktopRecordingJob, operation: 'watch' | 'listen',
  duration: number, devices: MediaDevices | undefined, isCurrent: () => boolean, phase: (value: RecordingPhase) => void, zh: boolean): Promise<BotMediaRequest | undefined> {
  const { scope } = job;
  let input: BotMediaRequest;
  if (!devices?.getDisplayMedia) throw Error(zh ? '当前窗口无法录制桌面。' : 'Desktop recording is unavailable in this window.');
  const ready = await api.request({ type: operation === 'watch' ? 'desktop.video.begin' : 'desktop.audio.begin', seconds: duration, ...scope });
  if (!ready.ok) throw Error(ready.error);
  if (!isCurrent()) return;
  if (ready.cancelled) return;
  const video = operation === 'watch'
    ? { frameRate: { ideal: 12, max: 15 }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } }
    : { frameRate: { max: 1 }, width: { ideal: 32 }, height: { ideal: 32 } };
  job.display = await devices.getDisplayMedia({ video, audio: true });
  if (!isCurrent()) return;
  const tracks = job.display.getAudioTracks();
  if (!tracks.length) throw Error(zh ? '未取得系统音轨。' : 'No system audio track was returned.');
  if (operation === 'watch') {
    if (!job.display.getVideoTracks().length) throw Error(zh ? '未取得屏幕画面。' : 'No screen track was returned.');
    const videoRecording = recordDesktopVideo(job.display, duration, async (sequence, bytes) => {
      const response = await api.request({ type: 'desktop.video.chunk', ...scope, sequence, bytes });
      if (!response.ok) throw Error(response.error);
    }, active => {
      if (!isCurrent()) return;
      phase(active ? 'watch' : 'video-processing');
      void api.request({ type: 'desktop.video.activity', ...scope, active }).catch(() => undefined);
    });
    job.release = videoRecording.cancel;
    if (!await videoRecording.finished || !isCurrent()) return;
    phase('video-processing');
    input = { type: 'desktop.video.finish', ...scope };
  } else {
    job.display.getVideoTracks().forEach(track => track.stop());
    const recorder = new VoiceRecorder();
    job.release = () => recorder.cancel();
    const audioRecording = await recorder.start(() => undefined, { stream: new MediaStream(tracks), maxSeconds: duration });
    if (!audioRecording || !isCurrent()) return;
    phase('listen');
    void api.request({ type: 'desktop.audio.activity', ...scope, active: true }).catch(() => undefined);
    const sound = await audioRecording.finished;
    void api.request({ type: 'desktop.audio.activity', ...scope, active: false }).catch(() => undefined);
    if (!sound || !isCurrent()) return;
    job.display.getTracks().forEach(track => track.stop());
    phase('audio-to-text');
    input = { type: 'desktop.audio.finish', audio: speechBase64(sound.wave), ...scope };
  }
  return input;
}

// The application window owns the system audio stream even when its chat UI is unmounted.
export function installAgentDesktopRecorder(api: WorldlineBoxBotMediaApi) {
  let current: DesktopRecordingJob | undefined;
  const release = (job: DesktopRecordingJob) => {
    if (current === job) current = undefined;
    job.release?.();
    job.display?.getTracks().forEach(track => track.stop());
  };
  const receive = async (event: Event) => {
    const command = (event as CustomEvent<BotDesktopAgentCommand>).detail;
    if (command.operation === 'cancel') {
      if (current?.scope.requestId === command.requestId) release(current);
      return;
    }
    if (current || command.operation === 'screen') return;
    const { conversationId, surface, requestId } = command;
    const job = current = { scope: { conversationId, surface, requestId } };
    try {
      const input = await recordForAgent(api, job, command.operation, command.seconds ?? BOT_DESKTOP_AUDIO_SECONDS,
        navigator.mediaDevices, () => current === job, () => {}, true);
      if (input && current === job) {
        const result = await api.request(input);
        if (!result.ok) throw Error(result.error);
      }
    } catch (error) {
      await api.request({ type: 'desktop.failed', ...job.scope, error: (error instanceof Error && error.message || '桌面采集失败。').slice(0, 500) }).catch(() => undefined);
    } finally {
      release(job);
      await api.request({ type: 'desktop.cancel', ...job.scope }).catch(() => undefined);
    }
  };
  window.addEventListener(BOT_DESKTOP_HOST_EVENT, receive);
  return () => {
    window.removeEventListener(BOT_DESKTOP_HOST_EVENT, receive);
    if (current) release(current);
  };
}
