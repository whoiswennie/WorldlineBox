import type { CaptureRecordingQuality } from '../../shared/capture-tools';

export type CaptureRegion = { x: number; y: number; width: number; height: number };
export type DesktopRecordingMedia = {
  stream: MediaStream; display: MediaStream; cleanup(): void;
  missingSystemAudio: boolean; hasSystemAudio: boolean; hasMicrophone: boolean;
  setSystemAudioEnabled?(enabled: boolean): void; setMicrophoneEnabled?(enabled: boolean): void;
};

export function normalizeCaptureRegion(region: CaptureRegion): CaptureRegion {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const minimum = .000001;
  const x = Math.max(0, Math.min(1 - minimum, finite(region.x, 0)));
  const y = Math.max(0, Math.min(1 - minimum, finite(region.y, 0)));
  return { x, y, width: Math.max(minimum, Math.min(1 - x, finite(region.width, 1))), height: Math.max(minimum, Math.min(1 - y, finite(region.height, 1))) };
}

/** Preserve aspect ratio and source detail; quality tiers never upscale pixels. */
export function recordingOutputSize(width: number, height: number, quality: CaptureRecordingQuality = 'original') {
  const landscape = width >= height;
  const [long, short] = quality === '720p' ? [1280, 720] : quality === '1080p' ? [1920, 1080] : [8192, 8192];
  const scale = Math.min(1, (landscape ? long : short) / width, (landscape ? short : long) / height);
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}

export function recordingBitrate(width: number, height: number) {
  return Math.round(Math.max(4_000_000, Math.min(16_000_000, width * height * 3)));
}
export function recordingMimeType(supported: (value: string) => boolean, audio: boolean) {
  return (audio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']).find(supported) ?? '';
}
export function recordingClock(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export async function desktopRecordingMedia({ systemAudio, microphone, region, quality = 'original', sourceSize }: { systemAudio: boolean; microphone: boolean; region?: CaptureRegion; quality?: CaptureRecordingQuality; sourceSize?: { width: number; height: number } }): Promise<DesktopRecordingMedia> {
  const owned: MediaStream[] = [];
  let audio: AudioContext | undefined;
  let video: HTMLVideoElement | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (interval) clearInterval(interval);
    video?.pause();
    if (video) video.srcObject = null;
    for (const stream of owned) for (const track of stream.getTracks()) track.stop();
    if (audio) void audio.close().catch(() => undefined);
  };
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, ...(sourceSize ? { width: { ideal: sourceSize.width }, height: { ideal: sourceSize.height } } : {}) }, audio: systemAudio });
    owned.push(display);
    let mic: MediaStream | undefined;
    if (microphone) {
      try { mic = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); owned.push(mic); }
      catch (error) { throw new Error('microphone', { cause: error }); }
    }
    let videoTrack = display.getVideoTracks()[0];
    if (!videoTrack) throw Error('display');
    if (region || quality !== 'original') {
      video = document.createElement('video'); video.muted = true; video.srcObject = display;
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw Error('display');
      const crop = normalizeCaptureRegion(region ?? { x: 0, y: 0, width: 1, height: 1 });
      const cropWidth = video.videoWidth * crop.width, cropHeight = video.videoHeight * crop.height;
      const canvas = document.createElement('canvas');
      const output = recordingOutputSize(cropWidth, cropHeight, quality);
      canvas.width = output.width;
      canvas.height = output.height;
      const context = canvas.getContext('2d');
      if (!context) throw Error('display');
      const paint = () => {
        if (!video || video.readyState < 2) return;
        context.drawImage(video, video.videoWidth * crop.x, video.videoHeight * crop.y, video.videoWidth * crop.width, video.videoHeight * crop.height, 0, 0, canvas.width, canvas.height);
      };
      paint(); interval = setInterval(paint, 1000 / 30);
      const cropped = canvas.captureStream(30); owned.push(cropped);
      videoTrack = cropped.getVideoTracks()[0]!;
    }
    const audioTracks = [systemAudio ? display : undefined, mic].flatMap(stream => stream?.getAudioTracks() ?? []);
    const result = new MediaStream([videoTrack]);
    if (audioTracks.length > 1) {
      audio = new AudioContext();
      const output = audio.createMediaStreamDestination();
      for (const stream of [systemAudio ? display : undefined, mic]) {
        if (stream?.getAudioTracks().length) audio.createMediaStreamSource(stream).connect(output);
      }
      await audio.resume();
      owned.push(output.stream);
      for (const track of output.stream.getAudioTracks()) result.addTrack(track);
    } else if (audioTracks[0]) result.addTrack(audioTracks[0]);
    return { stream: result, display, cleanup, missingSystemAudio: systemAudio && !display.getAudioTracks().length,
      hasSystemAudio: systemAudio && display.getAudioTracks().length > 0, hasMicrophone: Boolean(mic?.getAudioTracks().length),
      setSystemAudioEnabled: enabled => { for (const track of display.getAudioTracks()) track.enabled = enabled; },
      setMicrophoneEnabled: enabled => { for (const track of mic?.getAudioTracks() ?? []) track.enabled = enabled; } };
  } catch (error) { cleanup(); throw error; }
}
