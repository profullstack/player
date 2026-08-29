import { describe, it, expect, vi } from 'vitest';
import { attachSource } from '../src/core/attach';
import type { EngineContext, EngineHandle } from '../src/engines/types';

/**
 * `attachSource` is the delivery layer for apps that already have a player —
 * p0dcasters' dock, rssamplifier's playlist, media-streamer's modals. What it
 * must guarantee is narrow and exact: pick the same engine `createPlayer`
 * would, attach it to the caller's element, touch nothing else, and hand back
 * something that really lets go.
 */
describe('attachSource', () => {
  const CHROME = { mediaSource: true, nativeHls: false };
  const IOS = { mediaSource: false, nativeHls: true };
  const ANCIENT = { mediaSource: false, nativeHls: false };

  function spyEngine() {
    const destroy = vi.fn();
    let context: EngineContext | null = null;
    const factory = async (ctx: EngineContext): Promise<EngineHandle> => {
      context = ctx;
      return Promise.resolve({
        destroy,
        levels: () => [{ index: 0, height: 720, bitrate: 1, label: '720p' }],
        setLevel: vi.fn(),
        currentLevel: () => -1,
      });
    };
    return { factory, destroy, seen: () => context };
  }

  it('picks the native engine for a progressive file', async () => {
    const media = document.createElement('audio');
    const engine = spyEngine();
    const attached = await attachSource(media, {
      src: 'https://x.test/ep.mp3',
      capabilities: CHROME,
      engines: { native: engine.factory },
    });
    expect(attached.engine).toBe('native');
    expect(attached.kind).toBe('audio');
    expect(engine.seen()?.media).toBe(media);
  });

  it('picks hls.js for a playlist wherever Media Source exists', async () => {
    const engine = spyEngine();
    const attached = await attachSource(document.createElement('video'), {
      src: 'https://x.test/live.m3u8',
      capabilities: CHROME,
      engines: { hls: engine.factory },
    });
    expect(attached.engine).toBe('hls');
    expect(attached.levels()).toHaveLength(1);
  });

  it('falls back to native HLS on iOS', async () => {
    const engine = spyEngine();
    const attached = await attachSource(document.createElement('video'), {
      src: 'https://x.test/live.m3u8',
      capabilities: IOS,
      engines: { native: engine.factory },
    });
    expect(attached.engine).toBe('native');
  });

  it('creates no DOM and leaves the caller’s element alone', async () => {
    const media = document.createElement('audio');
    const parent = document.createElement('div');
    parent.append(media);
    await attachSource(media, {
      src: 'https://x.test/ep.mp3',
      capabilities: CHROME,
      engines: { native: spyEngine().factory },
    });
    // No control bar, no wrapper, no classes: the host owns its own UI.
    expect(parent.children).toHaveLength(1);
    expect(parent.querySelector('.pux-player__bar')).toBeNull();
    expect(media.className).toBe('');
  });

  it('really lets go', async () => {
    const engine = spyEngine();
    const attached = await attachSource(document.createElement('video'), {
      src: 'https://x.test/a.mp4',
      capabilities: CHROME,
      engines: { native: engine.factory },
    });
    attached.destroy();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports an unplayable source instead of attaching one', async () => {
    const onError = vi.fn();
    const engine = spyEngine();
    const attached = await attachSource(document.createElement('video'), {
      src: 'https://x.test/live.m3u8',
      capabilities: ANCIENT,
      engines: { native: engine.factory, hls: engine.factory },
      onError,
    });
    expect(attached.unplayable).toMatch(/cannot play HLS/i);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/cannot play HLS/i));
    expect(engine.seen()).toBeNull();
    // And destroy stays safe to call on something that never attached.
    expect(() => {
      attached.destroy();
    }).not.toThrow();
  });

  it('marks a transport stream live without being told', async () => {
    const engine = spyEngine();
    await attachSource(document.createElement('video'), {
      src: 'https://x.test/ch.ts',
      capabilities: CHROME,
      engines: { mpegts: engine.factory },
    });
    expect(engine.seen()?.live).toBe(true);
  });

  it('passes the television profile through', async () => {
    const engine = spyEngine();
    await attachSource(document.createElement('video'), {
      src: 'https://x.test/ch.ts',
      isTv: true,
      capabilities: CHROME,
      engines: { mpegts: engine.factory },
    });
    expect(engine.seen()?.isTv).toBe(true);
  });
});
