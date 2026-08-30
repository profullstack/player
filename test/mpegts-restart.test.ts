import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EngineContext } from '../src/engines/types';

/**
 * When the restart budget comes back, which is the whole difference between a
 * stream that recovers all evening and one that dies after a minute or two.
 *
 * The engine rebuilds the player rather than giving up, because a live
 * transport stream changes shape mid-broadcast and MSE throws when it does. The
 * question these tests pin down is not how many rebuilds are allowed but when
 * the allowance is restored: it used to take thirty unbroken seconds, so three
 * hiccups inside half a minute ended the stream permanently even though every
 * rebuild had worked. It now refills on `playing`, so the budget is spent by
 * failures to *recover*, never by failures alone.
 */

const created = vi.hoisted(
  () =>
    [] as {
      handlers: Record<string, (...args: unknown[]) => void>;
      destroy: () => void;
    }[]
);

vi.mock('mpegts.js', () => ({
  default: {
    getFeatureList: (): { mseLivePlayback: boolean } => ({ mseLivePlayback: true }),
    createPlayer: (): unknown => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const destroy = vi.fn();
      created.push({ handlers, destroy });
      return {
        attachMediaElement: vi.fn(),
        load: vi.fn(),
        destroy,
        on: (event: string, fn: (...args: unknown[]) => void): void => {
          handlers[event] = fn;
        },
      };
    },
    Events: { MEDIA_INFO: 'media_info', ERROR: 'error' },
  },
}));

const { createMpegtsEngine } = await import('../src/engines/mpegts');

describe('the restart budget', () => {
  let media: HTMLVideoElement;
  let onError: ReturnType<typeof vi.fn>;
  let context: EngineContext;

  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    media = document.createElement('video');
    onError = vi.fn();
    context = {
      media,
      src: 'https://example.test/stream.ts',
      isTv: false,
      live: true,
      onError,
      onNotice: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Break the newest player, then let its scheduled rebuild happen. */
  const breakIt = async (): Promise<void> => {
    const current = created.at(-1);
    current?.handlers.error?.('NetworkError', 'detail');
    await vi.runOnlyPendingTimersAsync();
  };

  it('gives up once the rebuilds themselves stop working', async () => {
    await createMpegtsEngine(context, {});

    // Five failures with no picture in between spends the whole allowance; the
    // sixth is the one the reader is told about.
    for (let i = 0; i < 5; i += 1) await breakIt();
    expect(onError).not.toHaveBeenCalled();

    await breakIt();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('refills the moment the picture comes back', async () => {
    await createMpegtsEngine(context, {});

    // Four failures, then the stream genuinely resumes.
    for (let i = 0; i < 4; i += 1) await breakIt();
    media.dispatchEvent(new Event('playing'));

    // Under the old thirty-second rule this next failure was the fifth of five
    // and the stream was over. It is now the first of a fresh allowance, so the
    // reader keeps watching.
    for (let i = 0; i < 5; i += 1) await breakIt();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not need thirty seconds of playback to count as recovered', async () => {
    await createMpegtsEngine(context, {});

    for (let i = 0; i < 5; i += 1) {
      await breakIt();
      // A second of picture between two failures used to be worth nothing at
      // all. It is a recovery, and five of them in a row are five recoveries.
      media.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(onError).not.toHaveBeenCalled();
  });

  it('stops listening once it is torn down', async () => {
    const handle = await createMpegtsEngine(context, {});
    handle.destroy();

    // A detached engine that still answered `playing` would resurrect a budget
    // for a player nobody is watching.
    media.dispatchEvent(new Event('playing'));
    expect(context.onNotice).toHaveBeenCalledTimes(0);
  });
});
