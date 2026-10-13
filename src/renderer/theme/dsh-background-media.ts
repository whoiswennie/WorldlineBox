import unreachedVideo from '../../../assets/backgrounds/whale-fantasy-loop.mp4?url';
import unreachedPoster from '../../../assets/backgrounds/whale-fantasy-poster.jpg?url';
import inkVideo from '../../../assets/backgrounds/shuimo-danqing-loop.mp4?url';
import inkPoster from '../../../assets/backgrounds/shuimo-danqing-poster.jpg?url';

/** Only the two backgrounds selected by the user; no upstream plugin code. */
export const DSH_BACKGROUND_MEDIA = {
  'whale-fantasy': { video: unreachedVideo, poster: unreachedPoster },
  'shuimo-danqing': { video: inkVideo, poster: inkPoster },
} as const;

export function isAnimatedTheme(id: string): id is keyof typeof DSH_BACKGROUND_MEDIA {
  return Object.hasOwn(DSH_BACKGROUND_MEDIA, id);
}
