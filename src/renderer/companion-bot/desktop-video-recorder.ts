import { BOT_DESKTOP_VIDEO_CHUNK_BYTES } from '../../shared/companion-bot-media';

export function recordDesktopVideo(stream: MediaStream, seconds: number, append: (sequence: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>, onRecording?: (active: boolean) => void) {
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw Error('当前环境无法录制带声音的视频。');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 });
  let writing = Promise.resolve(), sequence = 0, pendingBytes = 0;
  let cancelled = false, settled = false;
  let resolve!: (value: boolean) => void, reject!: (error: unknown) => void;
  const finished = new Promise<boolean>((done, failed) => { resolve = done; reject = failed; });
  void finished.catch(() => undefined);
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  recorder.onstart = () => { if (recorder.state === 'recording') onRecording?.(true); };
  const release = () => { clearTimeout(timer); stream.getTracks().forEach(track => track.stop()); };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true; reject(error); stop(); release();
  };
  recorder.ondataavailable = ({ data }) => {
    if (!data.size || cancelled || settled) return;
    if (data.size > BOT_DESKTOP_VIDEO_CHUNK_BYTES || pendingBytes + data.size > 8 * 1024 * 1024) {
      fail(Error('录屏数据写入过慢，请缩短录制时间后重试。')); return;
    }
    pendingBytes += data.size;
    const index = sequence++;
    writing = writing.then(async () => {
      if (!cancelled && !settled) await append(index, new Uint8Array(await data.arrayBuffer()));
    }).finally(() => { pendingBytes -= data.size; });
    void writing.catch(fail);
  };
  recorder.onerror = () => fail(Error('录屏中断。'));
  recorder.onstop = () => {
    onRecording?.(false);
    release();
    void writing.then(() => {
      if (!settled) { settled = true; resolve(!cancelled && sequence > 0); }
    }, fail);
  };
  // A disconnected monitor or lost system-audio stream invalidates synchronized capture.
  for (const track of stream.getTracks()) track.addEventListener('ended', () => fail(Error('屏幕或电脑音轨已断开。')), { once: true });
  recorder.start(1000);
  const timer = setTimeout(stop, seconds * 1000);
  return { finished, stop, cancel() { cancelled = true; stop(); release(); } };
}
