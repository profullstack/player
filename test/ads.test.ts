import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachAds } from '../src/core/ads';

/**
 * A fake media element. jsdom has no playback, so time is driven by hand, which
 * is the only way to assert "after five minutes of watching" without waiting.
 */
function fakeMedia(): HTMLMediaElement {
  const el = document.createElement('video');
  Object.defineProperty(el, 'paused', { value: false, writable: true });
  el.play = vi.fn(() => Promise.resolve());
  el.pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, writable: true });
  });
  return el;
}

function adElement(root: HTMLElement): HTMLVideoElement {
  return root.querySelector('.pux-ad__video') as HTMLVideoElement;
}

let root: HTMLElement;
let media: HTMLMediaElement;
let clock: number;
const now = () => clock;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  media = fakeMedia();
  root.append(media);
  clock = 0;
});

/** Pretend `ms` of wall time passed while the programme played. */
function watch(ms: number, step = 1000): void {
  for (let spent = 0; spent < ms; spent += step) {
    clock += step;
    media.dispatchEvent(new Event('timeupdate'));
  }
}

describe('ad breaks', () => {
  it('does not interrupt before the interval is up', async () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    attachAds(root, media, { next, everySeconds: 300 }, now);
    media.dispatchEvent(new Event('play'));
    watch(299_000);
    expect(next).not.toHaveBeenCalled();
  });

  it('interrupts once the interval is up', async () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    const onBreakStart = vi.fn();
    const ads = attachAds(root, media, { next, everySeconds: 300, onBreakStart }, now);
    adElement(root).play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(301_000);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    expect(media.pause).toHaveBeenCalled();
    await vi.waitFor(() => expect(ads.playing).toBe(true));
    expect(onBreakStart).toHaveBeenCalledWith({ url: 'https://ads.example/one.mp4', index: 0 });
  });

  it('counts watched time only, so a paused tab owes nothing', () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    attachAds(root, media, { next, everySeconds: 300 }, now);
    media.dispatchEvent(new Event('play'));
    watch(200_000);

    // Away for an hour with the programme paused.
    media.pause();
    media.dispatchEvent(new Event('pause'));
    clock += 3_600_000;
    media.dispatchEvent(new Event('timeupdate'));

    expect(next).not.toHaveBeenCalled();
  });

  it('gives the programme back when the advert ends, and resumes it', async () => {
    const onBreakEnd = vi.fn();
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, onBreakEnd },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    ad.dispatchEvent(new Event('ended'));
    expect(ads.playing).toBe(false);
    expect(onBreakEnd).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, skipped: false }),
    );
    expect(media.play).toHaveBeenCalled();
  });

  it('an advert that will not load never costs the viewer their programme', async () => {
    const onError = vi.fn();
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/broken.mp4', everySeconds: 10, onError },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    ad.dispatchEvent(new Event('error'));
    expect(ads.playing).toBe(false);
    expect(onError).toHaveBeenCalled();
    expect(media.play).toHaveBeenCalled();
  });

  it('a host that returns no advert simply does not interrupt', async () => {
    const ads = attachAds(root, media, { next: () => null, everySeconds: 10 }, now);
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(false));
    expect(root.classList.contains('pux-player--ad')).toBe(false);
  });

  it('is unskippable unless the host says otherwise', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    expect((root.querySelector('.pux-ad__skip') as HTMLElement).hidden).toBe(true);
  });

  it('offers Skip only after the countdown the host set', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, skipAfter: 5 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    const skip = root.querySelector('.pux-ad__skip') as HTMLButtonElement;
    expect(skip.hidden).toBe(false);
    expect(skip.disabled).toBe(true);
    expect(skip.textContent).toMatch(/Skip in/);
  });

  it('takes the volume the viewer chose for the programme', async () => {
    media.volume = 0.3;
    media.muted = false;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    // The complaint that started this was a silent advert.
    expect(ad.muted).toBe(false);
    expect(ad.volume).toBeCloseTo(0.3);
  });

  it('destroy leaves nothing behind', () => {
    const ads = attachAds(root, media, { next: () => 'x.mp4', everySeconds: 10 }, now);
    expect(root.querySelector('.pux-ad')).not.toBeNull();
    ads.destroy();
    expect(root.querySelector('.pux-ad')).toBeNull();
  });
});

describe('audio adverts', () => {
  it('an mp3 plays without covering the artwork', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/spot.mp3', everySeconds: 10 },
      now,
    );
    const audio = root.querySelector('.pux-ad__audio') as HTMLAudioElement;
    audio.play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    expect(audio.play).toHaveBeenCalled();
    expect(root.querySelector('.pux-ad')!.classList.contains('pux-ad--audio')).toBe(true);
  });

  it('the host can say which kind it is when the URL does not', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => ({ url: 'https://cdn.example/stream?id=9', kind: 'audio' as const }), everySeconds: 10 },
      now,
    );
    const audio = root.querySelector('.pux-ad__audio') as HTMLAudioElement;
    audio.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));
    expect(audio.play).toHaveBeenCalled();
  });

  it('an unrecognised URL is treated as video, which still plays either way', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://cdn.example/creative', everySeconds: 10 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));
    expect(video.play).toHaveBeenCalled();
  });
});
