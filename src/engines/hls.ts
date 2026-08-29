/**
 * HLS, for the browsers that do not do it themselves.
 *
 * Reached only when `chooseEngine` has already established that this browser
 * has no native HLS but does have Media Source — Chrome, Firefox, Edge, and
 * Android. Safari and iOS never get here; they take the native path, which is
 * both better and, for iOS, the only one that exists.
 *
 * The error handling is the substance. hls.js reports a great many non-fatal
 * errors that recover on their own and must not reach the reader, and three
 * fatal classes of which two are recoverable if you ask correctly. Treating
 * them all the same is how a stream that stuttered once shows an error page.
 */

import type { EngineContext, EngineHandle, QualityLevel } from './types';

/** Fatal network or media errors this many times before giving up. */
const MAX_RECOVERIES = 3;

export async function createHlsEngine(context: EngineContext): Promise<EngineHandle> {
  const { media, src, isTv } = context;
  const { default: Hls } = await import('hls.js');

  if (!Hls.isSupported()) {
    context.onError('This browser cannot play HLS streams.');
    return {
      destroy: () => undefined,
      levels: () => [],
    };
  }

  const hls = new Hls({
    // A television is a slow decoder on a household connection: read further
    // ahead and accept latency, exactly as the transport stream engine does.
    // A desktop gets the library's own defaults, which are tuned for it.
    ...(isTv
      ? {
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          backBufferLength: 30,
          liveSyncDurationCount: 4,
        }
      : {
          backBufferLength: 90,
        }),
    enableWorker: true,
  });

  let recoveries = 0;
  let destroyed = false;

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (destroyed) return;

    if (!data.fatal) {
      // Ordinary turbulence: a segment that 404'd, a gap jumped. The library
      // handles these itself and the reader should never hear about them.
      return;
    }

    if (recoveries >= MAX_RECOVERIES) {
      context.onError('This stream kept failing and has been stopped.');
      hls.destroy();
      return;
    }
    recoveries += 1;

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        context.onNotice('Reconnecting…');
        hls.startLoad();
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        context.onNotice('Recovering…');
        hls.recoverMediaError();
        break;
      default:
        context.onError('This stream could not be played.');
        hls.destroy();
    }
  });

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (destroyed) return;
    context.onNotice(null);
    context.onReady?.({
      live: hls.levels.length > 0 && !Number.isFinite(media.duration),
      levels: levels(),
    });
  });

  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    if (destroyed) return;
    // The playlist is the authority on live, not the duration: a live playlist
    // says so explicitly, and a DVR window has a finite duration but is still
    // live and must not be offered a resume position.
    context.onReady?.({ live: data.details.live, levels: levels() });
  });

  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    if (!destroyed) context.onNotice(null);
  });

  function levels(): QualityLevel[] {
    return hls.levels.map((level, index) => ({
      index,
      height: level.height || null,
      bitrate: level.bitrate || null,
      label: level.height
        ? `${String(level.height)}p`
        : `${String(Math.round((level.bitrate || 0) / 1000))}k`,
    }));
  }

  hls.loadSource(src);
  hls.attachMedia(media as HTMLVideoElement);

  return {
    destroy(): void {
      destroyed = true;
      hls.destroy();
    },
    levels,
    setLevel(index: number): void {
      // -1 is hls.js's own "automatic", and passing it back is how the reader
      // returns to it after pinning a quality.
      hls.currentLevel = index;
    },
    /**
     * -1 for automatic.
     *
     * Not `hls.currentLevel`, which reports the rung the ladder happens to be
     * standing on and is a real index even when nothing has been pinned — so
     * the button read "720p" while the reader was still on Auto, and cycling
     * started from wherever the bitrate estimate had landed. `autoLevelEnabled`
     * is the question actually being asked: has anybody chosen?
     */
    currentLevel: () => (hls.autoLevelEnabled ? -1 : hls.currentLevel),
  };
}
