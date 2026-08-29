import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlayer, type PlayerOptions } from '../src/core/player';
import { loadPosition, loadPrefs, savePosition, savePrefs } from '../src/core/storage';
import type { EngineContext, EngineHandle, QualityLevel } from '../src/engines/types';

/**
 * The mounted player.
 *
 * jsdom implements no media pipeline: `duration` is NaN, `play()` is missing and
 * nothing ever fires on its own. So the element is given the handful of
 * properties the player reads, and events are dispatched by hand.
 *
 * Every test injects a fake engine. That is not a shortcut — it is the design
 * under test: the control bar is supposed to work identically whatever put the
 * bytes there, so the engine is exactly the thing that should be swappable in a
 * test. The real engines are covered by their own units and, for the ones that
 * need a browser, by the harness run against real media.
 */
describe('createPlayer', () => {
  let lastContext: EngineContext | null = null;

  function fakeEngine(levels: QualityLevel[] = []) {
    let current = -1;
    return async (context: EngineContext): Promise<EngineHandle> => {
      lastContext = context;
      return Promise.resolve({
        destroy: () => undefined,
        levels: () => levels,
        setLevel: (index: number) => {
          current = index;
        },
        currentLevel: () => current,
      });
    };
  }

  function mount(options: Partial<PlayerOptions> = {}) {
    const root = document.createElement('div');
    document.body.append(root);

    const handle = createPlayer(root, {
      src: 'https://example.test/a.mp4',
      mediaId: 'test',
      engines: { native: fakeEngine(), hls: fakeEngine(), mpegts: fakeEngine() },
      ...options,
    });

    const media = handle.media;
    Object.defineProperty(media, 'duration', { value: 600, writable: true, configurable: true });
    Object.defineProperty(media, 'paused', { value: true, writable: true, configurable: true });
    Object.defineProperty(media, 'buffered', {
      value: { length: 0, start: () => 0, end: () => 0 },
      writable: true,
      configurable: true,
    });
    media.play = vi.fn().mockResolvedValue(undefined);
    media.pause = vi.fn(() => {
      Object.defineProperty(media, 'paused', { value: true, configurable: true });
      media.dispatchEvent(new Event('pause'));
    });

    return { root, media, handle };
  }

  const press = (root: HTMLElement, key: string): void => {
    root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };
  const control = (root: HTMLElement, name: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-control="${name}"]`);

  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    lastContext = null;
  });

  describe('the element it drives', () => {
    it('builds a video for a video source and takes the controls off it', () => {
      const { root, media } = mount();
      expect(media.tagName).toBe('VIDEO');
      expect(media.controls).toBe(false);
      expect(root.querySelector('.pux-player__bar')).not.toBeNull();
    });

    it('builds an audio element for an audio source', () => {
      const { root, media } = mount({ src: 'https://example.test/show.mp3' });
      expect(media.tagName).toBe('AUDIO');
      expect(root.classList.contains('pux-player--audio')).toBe(true);
    });

    it('drives an element it was handed instead of making one', () => {
      const root = document.createElement('div');
      const existing = document.createElement('video');
      root.append(existing);
      document.body.append(root);
      const handle = createPlayer(root, {
        src: 'a.mp4',
        media: existing,
        engines: { native: fakeEngine() },
      });
      expect(handle.media).toBe(existing);
      handle.destroy();
      // An element the player did not create is not the player's to remove.
      expect(root.contains(existing)).toBe(true);
    });
  });

  describe('VOD', () => {
    it('shows the full set of controls', () => {
      const { root } = mount();
      for (const name of ['play', 'back', 'forward', 'mute', 'rate', 'fullscreen']) {
        expect(control(root, name)?.hasAttribute('hidden'), name).toBe(false);
      }
      expect(control(root, 'live')?.hasAttribute('hidden')).toBe(true);
    });

    it('renders the clock and seeks with the keyboard', () => {
      const { root, media } = mount();
      media.currentTime = 50;
      media.dispatchEvent(new Event('loadedmetadata'));
      press(root, 'ArrowRight');
      expect(media.currentTime).toBe(55);
      expect(root.querySelector('.pux-player__time')?.textContent).toBe('0:55 / 10:00');
    });

    it('resumes where the reader left off and offers to start over', () => {
      savePosition('test', { t: 300, d: 600 });
      const { root, media } = mount();
      media.dispatchEvent(new Event('loadedmetadata'));
      expect(media.currentTime).toBe(300);
      root.querySelector<HTMLButtonElement>('.pux-player__notice-action')?.click();
      expect(media.currentTime).toBe(0);
      expect(loadPosition('test')).toBeNull();
    });

    it('remembers nothing when given no mediaId', () => {
      const root = document.createElement('div');
      document.body.append(root);
      const { media } = {
        media: createPlayer(root, { src: 'a.mp4', engines: { native: fakeEngine() } }).media,
      };
      media.currentTime = 200;
      media.dispatchEvent(new Event('pause'));
      expect(localStorage.getItem('profullstack.player.positions')).toBeNull();
    });

    it('carries volume and speed between recordings', () => {
      savePrefs({ volume: 0.25, muted: true, rate: 1.5 });
      const { media } = mount();
      expect(media.volume).toBe(0.25);
      expect(media.playbackRate).toBe(1.5);
    });

    it('cycles the speed and stores it', () => {
      const { root, media } = mount();
      control(root, 'rate')?.click();
      media.dispatchEvent(new Event('ratechange'));
      expect(media.playbackRate).toBe(1.25);
      expect(loadPrefs().rate).toBe(1.25);
    });
  });

  describe('live', () => {
    // A transport stream is live by nature, and none of the VOD controls mean
    // anything on one: there is no end to scrub towards, no position worth
    // remembering, and no speed but 1.
    it('hides everything that would be a lie about a live stream', () => {
      const { root } = mount({ src: 'https://example.test/ch.ts' });
      expect(root.classList.contains('pux-player--live')).toBe(true);
      expect(control(root, 'live')?.hasAttribute('hidden')).toBe(false);
      for (const name of ['back', 'forward', 'rate', 'share']) {
        expect(control(root, name)?.hasAttribute('hidden'), name).toBe(true);
      }
      expect(root.querySelector<HTMLElement>('.pux-player__scrub')?.hidden).toBe(true);
    });

    it('refuses to seek', () => {
      const { root, media } = mount({ src: 'https://example.test/ch.ts' });
      media.currentTime = 100;
      press(root, 'ArrowRight');
      press(root, '5');
      expect(media.currentTime).toBe(100);
    });

    it('saves no position', () => {
      const { media } = mount({ src: 'https://example.test/ch.ts', mediaId: 'chan' });
      media.currentTime = 100;
      media.dispatchEvent(new Event('pause'));
      expect(loadPosition('chan')).toBeNull();
    });

    // An HLS URL looks identical live or not; only the playlist knows, and it
    // arrives after the bar has already been drawn.
    it('switches to live mode when the engine reports a live playlist', async () => {
      const { root } = mount({
        src: 'https://example.test/s.m3u8',
        kind: 'hls',
        capabilities: { mediaSource: true, nativeHls: false },
      });
      expect(root.classList.contains('pux-player--live')).toBe(false);

      await vi.waitFor(() => expect(lastContext).not.toBeNull());
      lastContext?.onReady?.({ live: true, levels: [] });

      expect(root.classList.contains('pux-player--live')).toBe(true);
      expect(control(root, 'live')?.hasAttribute('hidden')).toBe(false);
    });
  });

  describe('audio', () => {
    it('drops the controls that need a picture', () => {
      const { root } = mount({ src: 'https://example.test/show.mp3' });
      expect(control(root, 'fullscreen')?.hasAttribute('hidden')).toBe(true);
      expect(control(root, 'pip')?.hasAttribute('hidden')).toBe(true);
      // But it is still a full transport: play, skip, speed, scrub.
      expect(control(root, 'play')?.hasAttribute('hidden')).toBe(false);
      expect(control(root, 'rate')?.hasAttribute('hidden')).toBe(false);
    });
  });

  describe('quality', () => {
    it('stays hidden when there is no choice to make', async () => {
      const { root } = mount({
        src: 'a.m3u8',
        kind: 'hls',
        capabilities: { mediaSource: true, nativeHls: false },
      });
      await vi.waitFor(() => expect(lastContext).not.toBeNull());
      lastContext?.onReady?.({
        live: false,
        levels: [{ index: 0, height: 720, bitrate: 1, label: '720p' }],
      });
      expect(control(root, 'quality')?.hasAttribute('hidden')).toBe(true);
    });

    it('cycles auto and back through the ladder', async () => {
      const levels: QualityLevel[] = [
        { index: 0, height: 480, bitrate: 1, label: '480p' },
        { index: 1, height: 1080, bitrate: 2, label: '1080p' },
      ];
      const root = document.createElement('div');
      document.body.append(root);
      createPlayer(root, {
        src: 'a.m3u8',
        // jsdom has no MediaSource, so without this an .m3u8 is judged
        // unplayable and never reaches the HLS engine at all.
        capabilities: { mediaSource: true, nativeHls: false },
        engines: { hls: fakeEngine(levels) },
      });
      await vi.waitFor(() => expect(lastContext).not.toBeNull());
      lastContext?.onReady?.({ live: false, levels });

      const button = control(root, 'quality');
      // The engine handle is assigned a microtask after onReady fires, and the
      // button needs both the levels and the handle before it can appear.
      await vi.waitFor(() => {
        expect(button?.hasAttribute('hidden')).toBe(false);
      });
      expect(button?.textContent).toBe('Auto');
      button?.click();
      expect(button?.textContent).toBe('480p');
      button?.click();
      expect(button?.textContent).toBe('1080p');
      button?.click();
      expect(button?.textContent).toBe('Auto');
    });
  });

  describe('failure', () => {
    it('explains a blocked load rather than showing a black rectangle', () => {
      const { root, media } = mount();
      Object.defineProperty(media, 'error', {
        value: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check' },
        configurable: true,
      });
      media.dispatchEvent(new Event('error'));
      expect(root.querySelector('.pux-player__notice')?.textContent).toContain('blocked');
      expect(root.classList.contains('pux-player--failed')).toBe(true);
    });

    it('says up front when the browser cannot play this kind at all', () => {
      // No MediaSource in jsdom, so an .m3u8 here is genuinely unplayable.
      const root = document.createElement('div');
      document.body.append(root);
      createPlayer(root, { src: 'https://example.test/s.m3u8' });
      expect(root.querySelector('.pux-player__notice')?.textContent).toMatch(/cannot play HLS/i);
    });
  });

  describe('teardown', () => {
    it('removes its UI and stops listening', () => {
      const { root, media, handle } = mount();
      media.currentTime = 250;
      handle.destroy();
      expect(loadPosition('test')?.t).toBe(250);
      expect(root.querySelector('.pux-player__bar')).toBeNull();
      expect(root.classList.contains('pux-player')).toBe(false);
      press(root, 'ArrowRight');
      expect(media.currentTime).toBe(250);
    });
  });
});
