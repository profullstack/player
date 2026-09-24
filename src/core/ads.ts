
/**
 * Ad breaks.
 *
 * The advert plays in its own element, laid over the stage, and the content
 * element is only paused. Swapping the source on the content element would tear
 * down the HLS or MPEG-TS engine driving it and, on a live stream, give the
 * viewer back a different moment than the one they left, so the content is
 * never touched beyond pause and play.
 *
 * Nothing here decides who sees an advert. The host knows whether someone is on
 * a paid plan; it says so by not passing this at all.
 */
export interface AdBreakOptions {
  /**
   * The next advert to play, or null to skip this break. Called once per break,
   * so a host can rotate creatives, respect a frequency cap, or check a
   * subscription that changed since the page loaded.
   */
  next: () => Promise<string | null> | string | null;
  /** Content seconds between breaks. */
  everySeconds?: number;
  /** Play one before the content starts. */
  preroll?: boolean;
  /** Seconds until Skip appears. Omit or null for unskippable. */
  skipAfter?: number | null;
  /** Longest an advert may hold the screen, in case one stalls. */
  maxSeconds?: number;
  onBreakStart?: (info: { url: string; index: number }) => void;
  onBreakEnd?: (info: { url: string; index: number; skipped: boolean }) => void;
  /** An advert that will not load must never cost the viewer their programme. */
  onError?: (error: unknown) => void;
}

export interface AdController {
  destroy: () => void;
  /** True while an advert holds the screen; the controls consult this. */
  readonly playing: boolean;
}

const DEFAULT_EVERY = 300;
const DEFAULT_MAX = 120;

export function attachAds(
  root: HTMLElement,
  media: HTMLMediaElement,
  options: AdBreakOptions,
  now: () => number = () => Date.now(),
): AdController {
  const everyMs = Math.max(5, options.everySeconds ?? DEFAULT_EVERY) * 1000;
  const maxMs = Math.max(5, options.maxSeconds ?? DEFAULT_MAX) * 1000;

  let watchedMs = 0;
  let lastTick: number | null = null;
  let breaks = 0;
  let playing = false;
  let destroyed = false;
  let armed = !options.preroll;

  const layer = document.createElement('div');
  layer.className = 'pux-ad';
  layer.hidden = true;

  const ad = document.createElement('video');
  ad.className = 'pux-ad__video';
  ad.playsInline = true;
  ad.preload = 'auto';
  // An advert that arrives muted is an advert nobody hears, which is the whole
  // complaint. It plays at the volume the viewer chose for the programme.
  ad.muted = media.muted;
  ad.volume = media.volume;

  const badge = document.createElement('span');
  badge.className = 'pux-ad__badge';
  badge.textContent = 'Ad';

  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'pux-ad__skip';
  skip.hidden = true;

  layer.append(ad, badge, skip);
  root.append(layer);

  /** Count only time actually watched, so a paused tab does not owe an advert. */
  function tick(): void {
    if (destroyed || playing) return;
    const t = now();
    if (media.paused) {
      lastTick = null;
      return;
    }
    if (lastTick !== null) watchedMs += t - lastTick;
    lastTick = t;
    if (watchedMs >= everyMs) void run();
  }

  async function run(): Promise<void> {
    if (playing || destroyed) return;
    playing = true;
    watchedMs = 0;
    lastTick = null;

    let url: string | null = null;
    try {
      url = await options.next();
    } catch (error) {
      options.onError?.(error);
    }
    if (!url || destroyed) {
      playing = false;
      return;
    }

    const index = breaks++;
    const wasPlaying = !media.paused;
    media.pause();

    ad.src = url;
    ad.currentTime = 0;
    ad.muted = media.muted;
    ad.volume = media.volume;
    layer.hidden = false;
    root.classList.add('pux-player--ad');
    options.onBreakStart?.({ url, index });

    let skipped = false;
    const finish = (viaSkip: boolean): void => {
      if (!playing) return;
      skipped = viaSkip;
      cleanup();
      options.onBreakEnd?.({ url: url!, index, skipped });
      if (wasPlaying && !destroyed) void media.play().catch(() => {});
    };

    function cleanup(): void {
      clearTimeout(cap);
      clearInterval(countdown);
      ad.removeEventListener('ended', onEnded);
      ad.removeEventListener('error', onError);
      skip.removeEventListener('click', onSkip);
      ad.pause();
      ad.removeAttribute('src');
      ad.load();
      layer.hidden = true;
      skip.hidden = true;
      root.classList.remove('pux-player--ad');
      playing = false;
    }

    const onEnded = (): void => finish(false);
    const onError = (): void => {
      options.onError?.(new Error(`advert failed to play: ${url}`));
      finish(false);
    };
    const onSkip = (): void => finish(true);

    ad.addEventListener('ended', onEnded);
    ad.addEventListener('error', onError);
    skip.addEventListener('click', onSkip);

    // A stalled advert must not strand the viewer in front of a frozen frame.
    const cap = setTimeout(() => finish(false), maxMs);

    const skipAfter = options.skipAfter;
    let countdown = 0 as unknown as ReturnType<typeof setInterval>;
    if (typeof skipAfter === 'number' && skipAfter >= 0) {
      const showAt = skipAfter;
      skip.hidden = false;
      const render = (): void => {
        const left = Math.ceil(showAt - ad.currentTime);
        if (left > 0) {
          skip.disabled = true;
          skip.textContent = `Skip in ${left}`;
        } else {
          skip.disabled = false;
          skip.textContent = 'Skip ad';
        }
      };
      render();
      countdown = setInterval(render, 250);
    }

    try {
      await ad.play();
    } catch (error) {
      options.onError?.(error);
      finish(false);
    }
  }

  const onTimeUpdate = (): void => tick();
  const onPlay = (): void => {
    lastTick = now();
    // The pre-roll waits for the first real press, so autoplay policies and a
    // viewer who never starts the programme do not trigger one.
    if (!armed) {
      armed = true;
      void run();
    }
  };
  const onPause = (): void => {
    tick();
    lastTick = null;
  };
  const syncVolume = (): void => {
    ad.muted = media.muted;
    ad.volume = media.volume;
  };

  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('play', onPlay);
  media.addEventListener('pause', onPause);
  media.addEventListener('volumechange', syncVolume);

  return {
    destroy(): void {
      destroyed = true;
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('volumechange', syncVolume);
      ad.pause();
      layer.remove();
    },
    get playing(): boolean {
      return playing;
    },
  };
}
