
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
/**
 * One advert.
 *
 * A music player wants an MP3, not a video laid over a record sleeve, so the
 * kind travels with the creative. Left off, it is inferred from the extension,
 * and anything unrecognised is treated as video, which is the safe guess: an
 * audio file in a video element still plays, a video in an audio element loses
 * its picture.
 */
export interface AdCreative {
  url: string;
  kind?: 'audio' | 'video';
}

export interface AdBreakOptions {
  /**
   * The next advert to play, or null to skip this break. Called once per break,
   * so a host can rotate creatives, respect a frequency cap, or check a
   * subscription that changed since the page loaded.
   */
  next: () => Promise<string | AdCreative | null> | string | AdCreative | null;
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
  /**
   * How long the programme takes to go and the advert to arrive, in seconds.
   * Zero cuts straight, which is what this used to do.
   */
  fadeSeconds?: number;
  /**
   * Bring the stage into view when a break starts, if it is not already there.
   *
   * On by default, and not fussiness: a player that sits below the fold plays
   * the advert perfectly where nobody can see it, which is indistinguishable
   * from the advert never running. Pass false when the host places the player
   * itself, such as full screen.
   */
  revealStage?: boolean;
}

export interface AdController {
  destroy: () => void;
  /**
   * Run a break now, without waiting for the timer.
   *
   * What a host needs to show somebody the thing working, and what a pre-roll
   * is underneath. Does nothing if one is already on screen.
   */
  play: () => Promise<void>;
  /** True while an advert holds the screen; the controls consult this. */
  readonly playing: boolean;
}

const DEFAULT_EVERY = 300;
const DEFAULT_MAX = 120;
const DEFAULT_FADE = 0.4;

/**
 * Ramp a value and resolve when it lands.
 *
 * Volume and opacity both, because a break that only dips the picture still
 * slams the sound, and one that only fades the sound still cuts the picture.
 */
function ramp(
  from: number,
  to: number,
  seconds: number,
  apply: (value: number) => void,
): Promise<void> {
  if (seconds <= 0 || from === to) {
    apply(to);
    return Promise.resolve();
  }
  // A timer rather than requestAnimationFrame. rAF does not tick in a
  // headless DOM, so a ramp awaiting it never resolves and the whole break
  // stops half done; at these lengths the difference is not visible anyway.
  return new Promise((resolve) => {
    const start = Date.now();
    const ms = seconds * 1000;
    const step = (): void => {
      const p = Math.min(1, (Date.now() - start) / ms);
      apply(from + (to - from) * p);
      if (p < 1) setTimeout(step, 16);
      else resolve();
    };
    step();
  });
}

/** Volume must stay in range, and a browser throws on anything outside it. */
const safeVolume = (v: number): number => Math.min(1, Math.max(0, v));

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i;

function creativeOf(value: string | AdCreative): AdCreative {
  const creative = typeof value === 'string' ? { url: value } : value;
  return { url: creative.url, kind: creative.kind ?? (AUDIO_EXTENSIONS.test(creative.url) ? 'audio' : 'video') };
}

export function attachAds(
  root: HTMLElement,
  media: HTMLMediaElement,
  options: AdBreakOptions,
  now: () => number = () => Date.now(),
): AdController {
  const everyMs = Math.max(5, options.everySeconds ?? DEFAULT_EVERY) * 1000;
  const maxMs = Math.max(5, options.maxSeconds ?? DEFAULT_MAX) * 1000;
  const fade = Math.max(0, options.fadeSeconds ?? DEFAULT_FADE);
  const reveal = options.revealStage !== false;

  /** Scroll the stage in only when most of it is actually off screen. */
  function revealIfHidden(): void {
    if (!reveal || typeof window === 'undefined') return;
    const box = root.getBoundingClientRect();
    const visible = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
    if (visible >= box.height * 0.6) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    root.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }

  let watchedMs = 0;
  let lastTick: number | null = null;
  let breaks = 0;
  let playing = false;
  let destroyed = false;
  let armed = !options.preroll;

  const layer = document.createElement('div');
  layer.className = 'pux-ad';
  layer.hidden = true;
  // Structure inline, not in the stylesheet.
  //
  // A host that drives the engines directly through attachSource has its own
  // controls and never loads player.css, which is exactly how the first
  // deployment shipped an advert that played correctly and was invisible: an
  // unpositioned div behind the page. Only the geometry is set here; colour and
  // type stay in the stylesheet for anyone who does load it.
  Object.assign(layer.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '3',
    display: 'grid',
    placeItems: 'center',
    background: '#000',
  } satisfies Partial<CSSStyleDeclaration>);

  // The stage has to be a containing block, or `inset: 0` resolves against the
  // page and the advert covers the whole document.
  const stagePosition = getComputedStyle(root).position;
  if (!stagePosition || stagePosition === 'static') root.style.position = 'relative';

  const video = document.createElement('video');
  video.className = 'pux-ad__video';
  video.playsInline = true;
  video.preload = 'auto';
  Object.assign(video.style, {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    background: '#000',
  } satisfies Partial<CSSStyleDeclaration>);

  // An audio advert gets no picture, only the badge and the countdown. Laying a
  // black rectangle over a music player to play an MP3 would hide the artwork
  // for no reason.
  const audio = document.createElement('audio');
  audio.className = 'pux-ad__audio';
  audio.preload = 'auto';

  let ad: HTMLMediaElement = video;
  // An advert that arrives muted is an advert nobody hears, which is the whole
  // complaint. It plays at the volume the viewer chose for the programme.
  for (const el of [video, audio]) {
    // An advert that arrives muted is an advert nobody hears, which is the
    // whole complaint. It plays at the volume chosen for the programme.
    el.muted = media.muted;
    el.volume = media.volume;
  }

  const badge = document.createElement('span');
  badge.className = 'pux-ad__badge';
  badge.textContent = 'Ad';
  Object.assign(badge.style, {
    position: 'absolute',
    top: '0.75rem',
    left: '0.75rem',
    padding: '0.15rem 0.5rem',
    borderRadius: '0.25rem',
    background: 'rgb(0 0 0 / 0.65)',
    color: '#fff',
    font: '600 0.75rem/1.4 system-ui, sans-serif',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  } satisfies Partial<CSSStyleDeclaration>);

  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'pux-ad__skip';
  skip.hidden = true;
  Object.assign(skip.style, {
    position: 'absolute',
    right: '1rem',
    bottom: '1rem',
    padding: '0.5rem 0.9rem',
    border: '1px solid rgb(255 255 255 / 0.4)',
    borderRadius: '0.3rem',
    background: 'rgb(0 0 0 / 0.6)',
    color: '#fff',
    font: '500 0.85rem/1 system-ui, sans-serif',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);

  layer.append(video, audio, badge, skip);
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

    let picked: string | AdCreative | null = null;
    try {
      picked = await options.next();
    } catch (error) {
      options.onError?.(error);
    }
    if (!picked || destroyed) {
      playing = false;
      return;
    }
    const creative = creativeOf(picked);
    const url = creative.url;
    // Point the shared handlers at whichever element will carry this one.
    ad = creative.kind === 'audio' ? audio : video;

    const index = breaks++;
    const wasPlaying = !media.paused;

    // The programme's own level, restored whatever happens next. Losing it
    // would leave someone's music quieter than they set it.
    const level = media.volume;

    // Take the programme down before pausing it, rather than cutting.
    await ramp(level, 0, fade, (v) => {
      media.volume = safeVolume(v);
    });
    media.pause();

    ad.src = url;
    ad.currentTime = 0;
    ad.muted = media.muted;
    ad.volume = 0;
    layer.style.opacity = '0';
    revealIfHidden();
    layer.hidden = false;
    layer.classList.toggle('pux-ad--audio', creative.kind === 'audio');
    const isAudio = creative.kind === 'audio';
    layer.style.background = isAudio ? 'rgb(0 0 0 / 0.35)' : '#000';
    video.style.display = isAudio ? 'none' : '';
    root.classList.add('pux-player--ad');
    options.onBreakStart?.({ url, index });

    let skipped = false;
    const finish = (viaSkip: boolean): void => {
      if (!playing) return;
      skipped = viaSkip;
      // Leave the same way it arrived: the advert goes, then the programme
      // comes back up rather than snapping on at full level.
      void ramp(1, 0, fade, (v) => {
        layer.style.opacity = String(v);
        ad.volume = safeVolume(level * v);
      }).then(() => {
        cleanup();
        options.onBreakEnd?.({ url, index, skipped });
        if (destroyed) return;
        media.volume = 0;
        if (wasPlaying) void media.play().catch(() => {});
        void ramp(0, level, fade, (v) => {
          media.volume = safeVolume(v);
        });
      });
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
      layer.classList.remove('pux-ad--audio');
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
      // Only once it is actually running, or the picture fades up on a frame
      // that has not arrived.
      await ramp(0, 1, fade, (v) => {
        layer.style.opacity = String(v);
        ad.volume = safeVolume(level * v);
      });
    } catch (error) {
      options.onError?.(error);
      // The programme must not be left silent because an advert failed.
      media.volume = safeVolume(level);
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
    for (const el of [video, audio]) {
      el.muted = media.muted;
      el.volume = media.volume;
    }
  };

  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('play', onPlay);
  media.addEventListener('pause', onPause);
  media.addEventListener('volumechange', syncVolume);

  return {
    play(): Promise<void> {
      return run();
    },
    destroy(): void {
      destroyed = true;
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('volumechange', syncVolume);
      video.pause();
      audio.pause();
      layer.remove();
    },
    get playing(): boolean {
      return playing;
    },
  };
}
