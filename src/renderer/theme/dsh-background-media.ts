import unreachedVideo from '../../../assets/backgrounds/whale-fantasy-loop.mp4?url';
import unreachedPoster from '../../../assets/backgrounds/whale-fantasy-poster.jpg?url';
import inkVideo from '../../../assets/backgrounds/shuimo-danqing-loop.mp4?url';
import inkPoster from '../../../assets/backgrounds/shuimo-danqing-poster.jpg?url';
import kaguyaPoster from '../../../assets/backgrounds/cosmic-princess-kaguya/poster.webp?url';
import remember from '../../../assets/backgrounds/cosmic-princess-kaguya/01-remember.mp4?url';
import hoshifuruUmi from '../../../assets/backgrounds/cosmic-princess-kaguya/02-hoshifuru-umi.mp4?url';
import happySynthesizer from '../../../assets/backgrounds/cosmic-princess-kaguya/03-happy-synthesizer.mp4?url';
import watashiGaSuki from '../../../assets/backgrounds/cosmic-princess-kaguya/04-watashi-ga-suki.mp4?url';
import worldIsMine from '../../../assets/backgrounds/cosmic-princess-kaguya/05-world-is-mine.mp4?url';
import exOtogibanashi from '../../../assets/backgrounds/cosmic-princess-kaguya/06-ex-otogibanashi.mp4?url';
import shunkanSymphony from '../../../assets/backgrounds/cosmic-princess-kaguya/07-shunkan-symphony.mp4?url';
import reply from '../../../assets/backgrounds/cosmic-princess-kaguya/08-reply.mp4?url';
import ray from '../../../assets/backgrounds/cosmic-princess-kaguya/09-ray.mp4?url';

export interface WallpaperClip {
  readonly src: string;
  /** Original theme's playback gain. Omit for silent wallpapers. */
  readonly volume?: number;
}

/** Bundled local media, in playback order. */
export const DSH_BACKGROUND_MEDIA = {
  'whale-fantasy': { clips: [{ src: unreachedVideo }], poster: unreachedPoster },
  'shuimo-danqing': { clips: [{ src: inkVideo }], poster: inkPoster },
  'cosmic-princess-kaguya': {
    clips: [
      { src: remember, volume: 0.32 },
      { src: hoshifuruUmi, volume: 0.692 },
      { src: happySynthesizer, volume: 0.339 },
      { src: watashiGaSuki, volume: 0.302 },
      { src: worldIsMine, volume: 0.692 },
      { src: exOtogibanashi, volume: 0.26 },
      { src: shunkanSymphony, volume: 0.891 },
      { src: reply, volume: 0.861 },
      { src: ray, volume: 0.359 },
    ],
    poster: kaguyaPoster,
  },
} as const;

export function isAnimatedTheme(id: string): id is keyof typeof DSH_BACKGROUND_MEDIA {
  return Object.hasOwn(DSH_BACKGROUND_MEDIA, id);
}
