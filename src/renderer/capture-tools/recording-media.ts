export type CaptureRegion = { x: number; y: number; width: number; height: number };

export function normalizeCaptureRegion(region: CaptureRegion): CaptureRegion {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const x = Math.max(0, Math.min(.99, finite(region.x, 0)));
  const y = Math.max(0, Math.min(.99, finite(region.y, 0)));
  return { x, y, width: Math.max(.01, Math.min(1 - x, finite(region.width, 1))), height: Math.max(.01, Math.min(1 - y, finite(region.height, 1))) };
}
export function recordingMimeType(supported: (value: string) => boolean, audio: boolean) {
  return (audio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']).find(supported) ?? '';
}
export function recordingClock(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export async function desktopRecordingMedia({ systemAudio, microphone, region }: { systemAudio: boolean; microphone: boolean; region?: CaptureRegion }) {
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
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: systemAudio });
    owned.push(display);
    let mic: MediaStream | undefined;
    if (microphone) {
      try { mic = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); owned.push(mic); }
      catch (error) { throw new Error('microphone', { cause: error }); }
    }
    let videoTrack = display.getVideoTracks()[0];
    if (!videoTrack) throw Error('display');
    if (region) {
      video = document.createElement('video'); video.muted = true; video.srcObject = display;
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw Error('display');
      const crop = normalizeCaptureRegion(region);
      const cropWidth = video.videoWidth * crop.width, cropHeight = video.videoHeight * crop.height;
      const scale = Math.min(1, 4096 / cropWidth, 4096 / cropHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.floor(cropWidth * scale / 2) * 2);
      canvas.height = Math.max(2, Math.floor(cropHeight * scale / 2) * 2);
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
      hasSystemAudio: systemAudio && display.getAudioTracks().length > 0, hasMicrophone: Boolean(mic?.getAudioTracks().length) };
  } catch (error) { cleanup(); throw error; }
}
