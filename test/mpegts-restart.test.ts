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

/**
 * The host's say over a failure.
 *
 * An IPTV proxy refuses in HTTP statuses, and some of them mean "stop": a
 * shared line somebody else is watching, a channel that is gone. Rebuilding on
 * those is three more connections on a line that counts them. The engine keeps
 * the ladder; the host names what each status means.
 */
describe('onStreamError', () => {
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

  it('is handed the category, the detail and the HTTP status', async () => {
    const seen: unknown[] = [];
    await createMpegtsEngine(context, {
      onStreamError: (failure) => {
        seen.push(failure);
        return undefined;
      },
    });
    created.at(-1)?.handlers.error?.('NetworkError', 'HttpStatusCodeInvalid', { code: 409 });
    created.at(-1)?.handlers.error?.('MediaError', 'MediaMSEError', undefined);
    expect(seen).toEqual([
      { type: 'NetworkError', detail: 'HttpStatusCodeInvalid', code: 409 },
      { type: 'MediaError', detail: 'MediaMSEError' },
    ]);
  });

  it('stop ends it at once, in the host’s words, with no rebuild', async () => {
    await createMpegtsEngine(context, {
      onStreamError: (f) =>
        f.code === 409 ? { action: 'stop', message: 'Somebody else is watching.' } : undefined,
    });
    created.at(-1)?.handlers.error?.('NetworkError', 'HttpStatusCodeInvalid', { code: 409 });
    await vi.runOnlyPendingTimersAsync();
    expect(onError).toHaveBeenCalledWith('Somebody else is watching.');
    expect(created).toHaveLength(1);
    expect(created[0]?.destroy).toHaveBeenCalled();
  });

  it('retry rebuilds, starting the ladder where the host says', async () => {
    await createMpegtsEngine(context, {
      onStreamError: () => ({ action: 'retry', message: 'The line stayed busy.', delayMs: 6000 }),
    });
    created.at(-1)?.handlers.error?.('NetworkError', 'HttpStatusCodeInvalid', { code: 503 });
    await vi.advanceTimersByTimeAsync(5999);
    expect(created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(created).toHaveLength(2);
  });

  it('a spent retry budget reports the host’s message', async () => {
    await createMpegtsEngine(context, {
      onStreamError: () => ({ action: 'retry', message: 'The line stayed busy.' }),
    });
    for (let i = 0; i < 6; i += 1) {
      created.at(-1)?.handlers.error?.('NetworkError', 'x', { code: 503 });
      await vi.runOnlyPendingTimersAsync();
    }
    expect(onError).toHaveBeenCalledWith('The line stayed busy.');
  });

  it('a frozen clock is offered to the host as a stall', async () => {
    const seen: string[] = [];
    Object.defineProperty(media, 'paused', { configurable: true, get: () => false });
    await createMpegtsEngine(context, {
      onStreamError: (f) => {
        seen.push(f.type);
        return { action: 'retry', message: 'It stopped. Press Play again.' };
      },
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(seen).toEqual(['stall']);
    expect(context.onNotice).toHaveBeenCalledWith('Reconnecting… (1/5)');
  });

  it('a rebuild resumes a stream that was playing', async () => {
    Object.defineProperty(media, 'paused', { configurable: true, get: () => false });
    const play = vi.fn(() => Promise.resolve());
    media.play = play;
    await createMpegtsEngine(context, {});
    expect(play).not.toHaveBeenCalled();
    created.at(-1)?.handlers.error?.('NetworkError', 'x');
    await vi.runOnlyPendingTimersAsync();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('a rebuild leaves a paused reader paused', async () => {
    const play = vi.fn(() => Promise.resolve());
    media.play = play;
    await createMpegtsEngine(context, {});
    created.at(-1)?.handlers.error?.('NetworkError', 'x');
    await vi.runOnlyPendingTimersAsync();
    expect(created).toHaveLength(2);
    expect(play).not.toHaveBeenCalled();
  });

  it('a host classifier that throws falls back to the default', async () => {
    await createMpegtsEngine(context, {
      onStreamError: () => {
        throw new Error('boom');
      },
    });
    created.at(-1)?.handlers.error?.('NetworkError', 'x');
    await vi.runOnlyPendingTimersAsync();
    expect(created).toHaveLength(2);
  });
});
