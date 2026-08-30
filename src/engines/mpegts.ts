/**
 * MPEG-2 transport streams, the thing no browser decodes.
 *
 * Ported from tipoffwatch.com / genrewatch.com's `player-entry.js`. The
 * reconnect and stall logic is theirs and is kept intact, because each rule in
 * it was written in response to a real stream that failed in a way the obvious
 * implementation could not survive:
 *
 * - **Rebuild rather than give up.** mpegts.js opens ONE source buffer per track
 *   and configures it from the first init segment. A live transport stream is
 *   under no obligation to stay the same shape: an ad break, a regional opt-out
 *   or a programme junction can change the audio configuration mid-stream, and
 *   mpegts.js then emits an init segment whose codec no longer matches the
 *   buffer it has. It logs "mimeType changed" and appends anyway — there is no
 *   `changeType()` call in the library — MSE throws, and that arrives as
 *   MediaMSEError with the stream still perfectly playable. Nothing can be done
 *   to that source buffer from out here; what can be done is throw the player
 *   away and build a new one from the stream's current shape.
 * - **A stream that stops sending never errors.** The picture freezes, the
 *   connection stays open, and the library has nothing to report because nothing
 *   failed. So the media clock is watched instead.
 * - **The codec check happens on MEDIA_INFO**, not before play, because nothing
 *   about a channel says what is inside it until the demuxer has read it.
 */

import type { EngineContext, EngineHandle } from './types';
import { unplayableReason } from './codecs';

/**
 * How many times a stream is rebuilt before the reader is told it failed.
 *
 * Five, doubling from two seconds, which is media-streamer's live TV player --
 * the one that survives an evening on the same provider lines this engine was
 * dying on. Three from 1.5s came over with the port. The number matters less
 * than when the budget refills, though; see the `playing` handler below.
 */
export const MAX_RESTARTS = 5;
const RESTART_BASE_MS = 2000;

/** How a stall is noticed: the clock is read this often, this many times. */
const STALL_CHECK_MS = 5000;
const STALL_LIMIT = 3;

export interface MpegtsOptions {
  /** Sent with the request; IPTV proxies authenticate by session cookie. */
  withCredentials?: boolean;
  /** Appended to a codec failure, e.g. "VLC can — the button is beside Play." */
  unplayableAdvice?: string;
  /**
   * Demux on a worker thread. Only set this on a **webpack** host.
   *
   * mpegts.js assembles its worker out of `__webpack_modules__`, so anywhere
   * else the worker is broken — and broken asynchronously, which means no
   * error, no fallback, and no playback at all. Defaults to false. See the
   * note in `configFor`.
   */
  enableWorker?: boolean;
}

/**
 * mpegts.js settings.
 *
 * One profile, not one per screen, and that is the change rather than an
 * oversight. These are media-streamer's live TV numbers, adopted wholesale
 * because that player survives an evening on the same provider lines where the
 * split profile was dying after a minute or two.
 *
 * What the split got wrong was the desktop half. It ran with no stash at all
 * (`stashInitialSize: 128` -- bytes) and `liveBufferLatencyChasing: true`, on
 * the reasoning that a laptop has bandwidth to spare and should therefore sit
 * as close to the live edge as it can. But chasing does not wait politely:
 * mpegts.js implements it by assigning to `currentTime`, which is a hard seek,
 * and MSE tears down and rebuilds the decode pipeline on every one. It is
 * evaluated on every appended fragment and it leaves only `MinRemain` seconds
 * of buffer behind -- one second, as it was set. One second is a single jitter
 * spike from an underrun; the underrun refills past the ceiling; it seeks
 * again. Every cycle of that sawtooth is a visible hitch, and enough of them in
 * a row exhaust the restart budget and end the stream for good.
 *
 * So: read ahead on every device, never chase, and demux off the main thread.
 * A television was already getting all three, which is why only the desktop
 * ever complained.
 */
/** Exported for the test that pins these values; not part of the public API. */
export function configFor(_isTv: boolean, options: MpegtsOptions = {}): Record<string, unknown> {
  return {
    /*
     * Off unless the host says otherwise, and the reason is not performance.
     *
     * Demuxing a broadcast-bitrate transport stream on the main thread competes
     * with rendering the page it is playing on, so a worker looks like free
     * performance. It is free only under webpack.
     *
     * mpegts.js builds its worker by STRINGIFYING `__webpack_modules__` --
     * webpack's internal module registry -- in `utils/webworkify-webpack.js`.
     * A Next.js host has that global and the worker works. A host bundling with
     * Bun, esbuild, Vite or Rollup does not, and the worker it assembles is
     * broken.
     *
     * It then fails in the worst available way. `Transmuxer` wraps the setup in
     * a try/catch and falls back to inline transmuxing, but only a SYNCHRONOUS
     * throw reaches that catch. A Worker that constructs from a blob whose body
     * then fails is asynchronous: nothing throws, nothing falls back, no init
     * segment ever arrives, and the player sits there having reported no error.
     * Every stream simply does not play. That is what turning this on by
     * default did to tipoffwatch, whose bundle Bun builds.
     *
     * So it is opt-in, and only a host that knows it is webpack should opt in.
     */
    enableWorker: options.enableWorker ?? false,

    /*
     * Read ahead, on every screen.
     *
     * The stash sits in front of the demuxer. A transport stream arrives in
     * bursts -- the provider's pacing, not the viewer's bandwidth -- so with
     * nothing buffered each gap between bursts is an underrun however fast the
     * connection is. 384KB is mpegts.js's own default, roughly a second.
     */
    enableStashBuffer: true,
    stashInitialSize: 384 * 1024,

    /*
     * Never close drift by seeking. See the note above: this is the line that
     * made the picture stutter and then killed the stream outright. The two
     * bounds are inert while chasing is off, and are kept as the bound anyone
     * re-enabling it would want rather than left to a library default.
     */
    liveBufferLatencyChasing: false,
    liveBufferLatencyMaxLatency: 5,
    liveBufferLatencyMinRemain: 1,

    /*
     * Drop what has already been watched. Without this the source buffer keeps
     * every second of a three-hour broadcast in memory and the tab is killed --
     * on a Fire TV, considerably sooner than that.
     */
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 30,
    autoCleanupMinBackwardDuration: 10,

    /*
     * lazyLoad pauses the download once enough is buffered, which on a live
     * stream means dropping the provider connection mid-broadcast and then
     * reconnecting -- on a line that counts concurrent connections, the worst
     * available way to idle. Off, with both durations stated anyway so there is
     * no library default to inherit if it is ever turned on.
     */
    lazyLoad: false,
    lazyLoadMaxDuration: 60,
    lazyLoadRecoverDuration: 30,

    seekType: 'range',
  };
}

interface MpegtsPlayer {
  attachMediaElement: (media: HTMLMediaElement) => void;
  load: () => void;
  destroy: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}

export async function createMpegtsEngine(
  context: EngineContext,
  options: MpegtsOptions = {}
): Promise<EngineHandle> {
  const { media, src, isTv } = context;
  const mpegtsModule = await import('mpegts.js');
  const mpegts = (mpegtsModule.default ?? mpegtsModule) as unknown as {
    createPlayer: (
      source: Record<string, unknown>,
      config: Record<string, unknown>
    ) => MpegtsPlayer;
    getFeatureList: () => { mseLivePlayback: boolean };
    Events: Record<string, string>;
  };

  if (!mpegts.getFeatureList().mseLivePlayback) {
    context.onError('This browser cannot play transport streams.');
    return { destroy: () => undefined, levels: () => [] };
  }

  const config = configFor(isTv, options);
  let player: MpegtsPlayer | null = null;
  let stopped = false;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let lastTime = -1;
  let stalls = 0;

  const clearTimers = (): void => {
    if (restartTimer) clearTimeout(restartTimer);
    if (stallTimer) clearInterval(stallTimer);
    restartTimer = null;
    stallTimer = null;
  };

  const destroyPlayer = (): void => {
    if (!player) return;
    const dying = player;
    player = null;
    try {
      dying.destroy();
    } catch {
      // A player that throws on the way out is already gone.
    }
  };

  /** The end of the road: nothing is playing and the reader is told why. */
  const giveUp = (message: string): void => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    destroyPlayer();
    context.onError(message);
  };

  const restart = (finalMessage: string): void => {
    if (stopped) return;
    if (restarts >= MAX_RESTARTS) {
      giveUp(finalMessage);
      return;
    }
    restarts += 1;
    clearTimers();
    destroyPlayer();
    context.onNotice(`Reconnecting… (${String(restarts)}/${String(MAX_RESTARTS)})`);
    restartTimer = setTimeout(
      () => {
        restartTimer = null;
        if (!stopped) start();
      },
      RESTART_BASE_MS * 2 ** (restarts - 1)
    );
  };

  const watchForStalls = (): void => {
    if (stallTimer) clearInterval(stallTimer);
    lastTime = media.currentTime;
    stalls = 0;
    stallTimer = setInterval(() => {
      if (stopped || !player) return;
      if (media.paused || media.ended || media.seeking) {
        stalls = 0;
        lastTime = media.currentTime;
        return;
      }
      if (media.currentTime === lastTime) {
        stalls += 1;
        if (stalls >= STALL_LIMIT) {
          stalls = 0;
          restart('The stream stopped sending.');
        }
        return;
      }
      // It is moving, so nothing is wrong right now. The restart budget is not
      // touched here -- that is the `playing` handler's job, and the difference
      // is explained there.
      lastTime = media.currentTime;
      stalls = 0;
    }, STALL_CHECK_MS);
  };

  function start(): void {
    player = mpegts.createPlayer(
      {
        type: 'mpegts',
        isLive: context.live,
        url: src,
        withCredentials: options.withCredentials ?? false,
      },
      config
    );

    player.on(mpegts.Events.MEDIA_INFO ?? 'media_info', (...args: unknown[]) => {
      const info = args[0] as { videoCodec?: string; audioCodec?: string } | undefined;
      const reason = unplayableReason(
        info,
        (type) => {
          const ms = (globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } })
            .MediaSource;
          return ms?.isTypeSupported?.(type) ?? false;
        },
        options.unplayableAdvice ?? ''
      );
      // Terminal, and deliberately: a browser with no HEVC decoder will not grow
      // one on the second attempt, so there is nothing to reconnect for.
      if (reason) giveUp(reason);
    });

    player.on(mpegts.Events.ERROR ?? 'error', (...args: unknown[]) => {
      const detail = String(args[1] ?? '');
      restart(`This stream could not be played (${detail}).`);
    });

    player.attachMediaElement(media);
    player.load();
    watchForStalls();
    context.onReady?.({ live: context.live, levels: [] });
  }

  /*
   * A picture is the only proof worth acting on, and it refills the budget.
   *
   * This is the difference between a stream that recovers all evening and one
   * that dies after a minute or two, and it is worth being exact about why.
   *
   * The budget used to come back only after RECOVERED_AFTER_MS -- thirty
   * seconds of unbroken playback, measured from the last restart and checked
   * only from inside the stall watcher. A channel that hiccups three times
   * inside half a minute therefore spent its whole allowance and was given up
   * on permanently, even though every one of those restarts had worked and the
   * stream was playing again seconds later. On a provider line that drops a
   * connection now and then -- which is all of them -- that is a hard ceiling
   * of three hiccups per stream, and reaching it takes about a minute.
   *
   * media-streamer's live TV player resets on every `playing` instead, and it
   * is right: `playing` fires when the media element genuinely resumed, so the
   * budget is spent by failures to *recover*, not by failures. A channel that
   * never plays still gives up after MAX_RESTARTS, because nothing ever fires
   * this. A channel that comes back gets its allowance back, which is the only
   * reading under which "three attempts" means what it sounds like.
   */
  const onPlaying = (): void => {
    restarts = 0;
    context.onNotice(null);
  };
  media.addEventListener('playing', onPlaying);

  start();

  return {
    destroy(): void {
      stopped = true;
      clearTimers();
      media.removeEventListener('playing', onPlaying);
      destroyPlayer();
    },
    levels: () => [],
  };
}
