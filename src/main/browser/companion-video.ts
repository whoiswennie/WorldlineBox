import type { WebContents } from 'electron';
import type { CompanionBrowserArguments } from '../../shared/companion-browser';

/** Fixed host script, never arbitrary model JavaScript. Reads loaded HTML tracks only. */
export async function companionVideo(contents: WebContents, input: Extract<CompanionBrowserArguments, { action: 'video' }>): Promise<unknown> {
  if (input.operation === 'seek' && input.time === undefined) throw Error('跳转视频须提供time（秒）。');
  return contents.executeJavaScriptInIsolatedWorld(903, [{ code: `(async () => {
    const input = ${JSON.stringify(input)}, videos = [...document.querySelectorAll('video')].slice(0,20), video = videos[input.index];
    if (!video) throw Error('当前主页面没有该HTML视频，请先等待播放器加载；跨域嵌入播放器需打开其页面。');
    if (input.operation === 'seek') {
      if (!Number.isFinite(video.duration) || input.time > video.duration) throw Error('视频时长尚未加载或跳转超出时长。');
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); video.removeEventListener('seeked', ready); video.removeEventListener('error', fail); };
        const ready = () => { done(); resolve(); }, fail = () => { done(); reject(Error('视频跳转失败。')); };
        const timer = setTimeout(() => { done(); reject(Error('等待视频跳转超时。')); }, 8000);
        video.addEventListener('seeked', ready); video.addEventListener('error', fail);
        video.currentTime = input.time;
        if (!video.seeking && video.readyState >= 2) ready();
      });
    }
    if (input.operation === 'play') await video.play();
    if (input.operation === 'pause') video.pause();
    return { url: location.href, count: videos.length, index: input.index, currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : null, paused: video.paused,
      width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
      tracks: [...video.textTracks].slice(0,20).map(track => ({language: track.language, label: track.label, mode: track.mode,
        loaded: track.cues !== null, total: track.cues?.length ?? 0,
        cues: [...(track.cues || [])].filter(cue => cue.endTime >= video.currentTime - 15 && cue.startTime <= video.currentTime + 15).slice(0,80)
          .map(cue => ({start: cue.startTime, end: cue.endTime, text: String(cue.text || '').slice(0,2000)}))})),
      notice: '仅返回当前HTML播放器及已加载文字轨道；网站自绘字幕可能不在textTracks中，未做语音识别。跳转后请截图核对画面。' };
  })()` }]);
}
