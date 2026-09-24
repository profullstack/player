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
    attachAds(root, media, { next, everySeconds: 300, fadeSeconds: 0 }, now);
    media.dispatchEvent(new Event('play'));
    watch(299_000);
    expect(next).not.toHaveBeenCalled();
  });

  it('interrupts once the interval is up', async () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    const onBreakStart = vi.fn();
    const ads = attachAds(root, media, { next, everySeconds: 300, onBreakStart, fadeSeconds: 0 }, now);
    adElement(root).play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(301_000);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => expect(ads.playing).toBe(true));
    expect(media.pause).toHaveBeenCalled();
    expect(onBreakStart).toHaveBeenCalledWith({ url: 'https://ads.example/one.mp4', index: 0 });
  });

  it('counts watched time only, so a paused tab owes nothing', () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    attachAds(root, media, { next, everySeconds: 300, fadeSeconds: 0 }, now);
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
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, onBreakEnd, fadeSeconds: 0 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    // Wait for the advert to actually be running: `playing` flips at the start
    // of the break, before run() has attached its listeners, so an event fired
    // on that signal alone lands before anything is listening for it.
    await vi.waitFor(() => expect(ad.play).toHaveBeenCalled());

    ad.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(ads.playing).toBe(false));
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
      { next: () => 'https://ads.example/broken.mp4', everySeconds: 10, onError, fadeSeconds: 0 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ad.play).toHaveBeenCalled());

    ad.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(ads.playing).toBe(false));
    expect(onError).toHaveBeenCalled();
    expect(media.play).toHaveBeenCalled();
  });

  it('a host that returns no advert simply does not interrupt', async () => {
    const ads = attachAds(root, media, { next: () => null, everySeconds: 10, fadeSeconds: 0 }, now);
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(false));
    expect(root.classList.contains('pux-player--ad')).toBe(false);
  });

  it('is unskippable unless the host says otherwise', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, fadeSeconds: 0 },
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
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, skipAfter: 5, fadeSeconds: 0 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    const skip = root.querySelector('.pux-ad__skip') as HTMLButtonElement;
    await vi.waitFor(() => expect(skip.hidden).toBe(false));
    expect(skip.disabled).toBe(true);
    expect(skip.textContent).toMatch(/Skip in/);
  });

  it('takes the volume the viewer chose for the programme', async () => {
    media.volume = 0.3;
    media.muted = false;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, fadeSeconds: 0 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    // The complaint that started this was a silent advert.
    await vi.waitFor(() => expect(ad.volume).toBeCloseTo(0.3, 1));
    expect(ad.muted).toBe(false);
  });

  it('destroy leaves nothing behind', () => {
    const ads = attachAds(root, media, { next: () => 'x.mp4', everySeconds: 10, fadeSeconds: 0 }, now);
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
      { next: () => 'https://ads.example/spot.mp3', everySeconds: 10, fadeSeconds: 0 },
      now,
    );
    const audio = root.querySelector('.pux-ad__audio') as HTMLAudioElement;
    audio.play = vi.fn(() => Promise.resolve());

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(ads.playing).toBe(true));

    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
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
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
  });

  it('an unrecognised URL is treated as video, which still plays either way', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://cdn.example/creative', everySeconds: 10, fadeSeconds: 0 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
  });
});

describe('works without the stylesheet', () => {
  it('positions itself, since a host driving engines directly never loads player.css', () => {
    attachAds(root, media, { next: () => 'x.mp4', everySeconds: 10, fadeSeconds: 0 }, now);
    const layer = root.querySelector('.pux-ad') as HTMLElement;
    // The first deployment shipped an advert that played correctly and was
    // invisible, because these lived only in a stylesheet nobody imported.
    expect(layer.style.position).toBe('absolute');
    expect(layer.style.inset).toBe('0');
    expect(layer.style.zIndex).toBe('3');
  });

  it('makes the stage a containing block, or the advert covers the page', () => {
    root.style.position = '';
    attachAds(root, media, { next: () => 'x.mp4', everySeconds: 10, fadeSeconds: 0 }, now);
    expect(root.style.position).toBe('relative');
  });

  it('leaves a stage that is already positioned alone', () => {
    root.style.position = 'fixed';
    attachAds(root, media, { next: () => 'x.mp4', everySeconds: 10, fadeSeconds: 0 }, now);
    expect(root.style.position).toBe('fixed');
  });

  it('an audio advert does not paint over the artwork', async () => {
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/spot.mp3', everySeconds: 10, fadeSeconds: 0 },
      now,
    );
    const audio = root.querySelector('.pux-ad__audio') as HTMLAudioElement;
    audio.play = vi.fn(() => Promise.resolve());
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    // `playing` flips at the start of the break, before the creative has been
    // chosen, so wait for the element that actually carries this one.
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());

    const layer = root.querySelector('.pux-ad') as HTMLElement;
    const video = root.querySelector('.pux-ad__video') as HTMLElement;
    expect(video.style.display).toBe('none');
    expect(layer.style.background).not.toBe('#000');
  });
});

describe('playing a break on demand', () => {
  it('runs one without waiting for the timer', async () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    const ads = attachAds(root, media, { next, everySeconds: 3600, fadeSeconds: 0 }, now);
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());

    await ads.play();
    expect(next).toHaveBeenCalledTimes(1);
    expect(ads.playing).toBe(true);
    expect((root.querySelector(".pux-ad") as HTMLElement).hidden).toBe(false);
  });

  it('does nothing when one is already on screen', async () => {
    const next = vi.fn(() => 'https://ads.example/one.mp4');
    const ads = attachAds(root, media, { next, everySeconds: 3600, fadeSeconds: 0 }, now);
    (root.querySelector('.pux-ad__video') as HTMLVideoElement).play = vi.fn(() => Promise.resolve());
    await ads.play();
    await ads.play();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('fading in and out', () => {
  it('takes the programme down rather than cutting it', async () => {
    media.volume = 0.8;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 3600, fadeSeconds: 0.05 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());

    await ads.play();
    // Paused for the break, and quiet rather than abruptly silenced.
    expect(media.pause).toHaveBeenCalled();
    expect(media.volume).toBeLessThan(0.8);
  });

  it('gives the programme its level back when the advert ends', async () => {
    media.volume = 0.6;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 3600, fadeSeconds: 0.05 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());
    await ads.play();

    video.dispatchEvent(new Event('ended'));
    // Losing this would leave someone's music quieter than they set it.
    await vi.waitFor(() => expect(media.volume).toBeCloseTo(0.6, 1));
  });

  it('an advert that will not play does not leave the programme silent', async () => {
    media.volume = 0.7;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/broken.mp4', everySeconds: 3600, fadeSeconds: 0.05 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));

    await ads.play();
    await vi.waitFor(() => expect(media.volume).toBeCloseTo(0.7, 1));
  });

  it('fadeSeconds 0 cuts straight, as it used to', async () => {
    media.volume = 0.5;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 3600, fadeSeconds: 0 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());
    await ads.play();
    const layer = root.querySelector('.pux-ad') as HTMLElement;
    expect(layer.style.opacity).toBe('1');
  });
});
