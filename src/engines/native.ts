/**
 * The engine for everything a browser already plays.
 *
 * MP4, WebM, MP3, AAC — and HLS on Safari and iOS, where the browser's own
 * implementation is not merely adequate but mandatory: those browsers have no
 * Media Source for hls.js to attach to, and the native path is also the one
 * that gets AirPlay, the lock screen and background audio right.
 *
 * It is barely an engine at all, which is the point: the default path should
 * cost one assignment and no library.
 */

import type { EngineContext, EngineHandle } from './types';

export async function createNativeEngine(context: EngineContext): Promise<EngineHandle> {
  const { media, src } = context;

  media.src = src;
  // Progressive files want their metadata; a live HLS URL on Safari ignores this
  // and starts its own scheduling.
  if (!media.preload) media.preload = 'metadata';
  media.load();

  const announce = (): void => {
    context.onReady?.({
      // A stream with no finite duration is live, which for the native path is
      // the only signal there is — Safari reports Infinity for a live playlist.
      live: context.live || !Number.isFinite(media.duration),
      levels: [],
    });
  };
  media.addEventListener('loadedmetadata', announce, { once: true });

  return Promise.resolve({
    destroy(): void {
      media.removeEventListener('loadedmetadata', announce);
      // Emptying the src is what actually drops the connection. Removing the
      // attribute alone leaves the browser fetching a file nobody is watching.
      media.removeAttribute('src');
      media.load();
    },
    levels: () => [],
  });
}
