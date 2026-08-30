import { describe, it, expect } from 'vitest';
import { configFor, MAX_RESTARTS } from '../src/engines/mpegts';

/**
 * These numbers are media-streamer's live TV player, adopted wholesale.
 *
 * They are worth pinning because the engine shipped with the opposite of most
 * of them on a desktop, and the symptom was not "a slightly worse picture" but
 * a stream that stuttered and then died after a minute or two on a provider
 * line media-streamer plays all evening.
 *
 * The tests state rules rather than restating the object, so that a future
 * retune has to break a claim about behaviour to break a test.
 */
describe('the mpegts buffering profile', () => {
  const desktop = configFor(false);
  const tv = configFor(true);

  it('is the same on every screen', () => {
    // The split was the bug. A television was already getting settings that
    // worked; the desktop was given their opposite on the theory that a laptop
    // has bandwidth to spare, and bandwidth was never what was wrong.
    expect(desktop).toEqual(tv);
  });

  it('never closes drift by seeking', () => {
    /*
     * The one that mattered. `liveBufferLatencyChasing` assigns to
     * `currentTime`; that is a hard seek, MSE rebuilds the decode pipeline on
     * each one, and it is evaluated on every appended fragment while leaving
     * only `MinRemain` seconds of buffer behind. One second of buffer is a
     * single jitter spike from an underrun, and the underrun refills past the
     * ceiling and seeks again -- a sawtooth of visible hitches.
     */
    expect(desktop.liveBufferLatencyChasing).toBe(false);
  });

  it('reads ahead rather than demuxing whatever just landed', () => {
    // A transport stream arrives in bursts regardless of the viewer's
    // bandwidth, so with nothing in front of the demuxer every gap between
    // bursts is an underrun. This was 128 *bytes* on a desktop.
    expect(desktop.enableStashBuffer).toBe(true);
    expect(desktop.stashInitialSize).toBe(384 * 1024);
  });

  it('does NOT demux off the main thread unless the host opts in', () => {
    /*
     * A regression test with a real outage behind it.
     *
     * A worker reads like free performance, and it is -- under webpack only.
     * mpegts.js assembles its worker by stringifying `__webpack_modules__`,
     * webpack's internal module registry. A Next.js host has that global; a
     * host bundling with Bun, esbuild, Vite or Rollup does not, and the worker
     * it builds is broken.
     *
     * It fails silently, which is what makes it dangerous. `Transmuxer`'s
     * try/catch only sees a SYNCHRONOUS throw, and a Worker that constructs
     * from a bad blob fails asynchronously: nothing throws, nothing falls back
     * to inline transmuxing, no init segment arrives, and the player reports no
     * error. Every stream simply does not play. Turning this on by default did
     * exactly that to tipoffwatch, whose bundle Bun builds.
     */
    expect(desktop.enableWorker).toBe(false);
  });

  it('lets a webpack host ask for the worker anyway', () => {
    // The capability is real where the bundler supports it, so it stays
    // reachable -- just never by default.
    expect(configFor(false, { enableWorker: true }).enableWorker).toBe(true);
  });

  it('never pauses the download to idle', () => {
    // lazyLoad drops the provider connection mid-broadcast and reconnects,
    // which on a line that counts concurrent connections is the worst
    // available way to wait.
    expect(desktop.lazyLoad).toBe(false);
  });

  it('still drops what has already been watched', () => {
    // Otherwise a three-hour broadcast fills the source buffer and the tab is
    // killed -- soonest on exactly the device this is all for.
    expect(desktop.autoCleanupSourceBuffer).toBe(true);
  });

  it('allows more rebuilds than the three it came over with', () => {
    expect(MAX_RESTARTS).toBe(5);
  });
});
