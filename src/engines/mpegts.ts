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

/** How many times a stream is rebuilt before the reader is told it failed. */
const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 1500;

/** How a stall is noticed: the clock is read this often, this many times. */
const STALL_CHECK_MS = 5000;
const STALL_LIMIT = 3;

/**
 * Playback this long since the last restart means the trouble is over, and the
 * budget goes back to full. Without it a channel that breaks once an hour spends
 * its three restarts over an afternoon and then fails for good.
 */
const RECOVERED_AFTER_MS = 30_000;

export interface MpegtsOptions {
  /** Sent with the request; IPTV proxies authenticate by session cookie. */
  withCredentials?: boolean;
  /** Appended to a codec failure, e.g. "VLC can — the button is beside Play." */
  unplayableAdvice?: string;
}

/**
 * mpegts.js settings for one screen or the other.
 *
 * A television is a slow decoder on a household connection: read ahead and do
 * not chase the live edge, because latency chasing answers a stall by seeking
 * forward, which is a stall the reader can see. A desktop wants the opposite.
 */
function configFor(isTv: boolean): Record<string, unknown> {
  const shared = {
    // lazyLoad pauses the download once enough is buffered, which for a live
    // stream means dropping the connection mid-broadcast and reconnecting.
    lazyLoad: false,
    // Without this the source buffer keeps every second of a three-hour stream
    // in memory and the tab is killed — on a Fire TV, considerably sooner.
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 30,
    autoCleanupMinBackwardDuration: 10,
  };

  return isTv
    ? {
        ...shared,
        enableStashBuffer: true,
        stashInitialSize: 384 * 1024,
        liveBufferLatencyChasing: false,
        liveBufferLatencyMaxLatency: 12,
        liveBufferLatencyMinRemain: 2,
      }
    : {
        ...shared,
        enableStashBuffer: false,
        stashInitialSize: 128,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 6,
        liveBufferLatencyMinRemain: 1,
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

  const config = configFor(isTv);
  let player: MpegtsPlayer | null = null;
  let stopped = false;
  let restarts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
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
      // It is moving. If it has been moving for a while, the earlier trouble is
      // over and this counts as a healthy stream again.
      lastTime = media.currentTime;
      stalls = 0;
      if (restarts > 0 && Date.now() - startedAt > RECOVERED_AFTER_MS) {
        restarts = 0;
        context.onNotice(null);
      }
    }, STALL_CHECK_MS);
  };

  function start(): void {
    startedAt = Date.now();
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

  start();

  return {
    destroy(): void {
      stopped = true;
      clearTimers();
      destroyPlayer();
    },
    levels: () => [],
  };
}
