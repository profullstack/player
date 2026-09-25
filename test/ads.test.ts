import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('showing the viewer the advert', () => {
  function stubBox(el: HTMLElement, top: number, height: number) {
    el.getBoundingClientRect = () =>
      ({ top, bottom: top + height, height, left: 0, right: 0, width: 800, x: 0, y: top, toJSON: () => {} }) as DOMRect;
  }

  it('scrolls the stage in when it is below the fold', async () => {
    // The bug this exists for: the player sat one pixel under a 513px viewport,
    // so every break played perfectly where nobody could see it.
    Object.defineProperty(window, 'innerHeight', { value: 513, configurable: true });
    stubBox(root, 512, 611);
    const scrolled = vi.fn();
    root.scrollIntoView = scrolled;

    const ads = attachAds(root, media, { next: () => 'x.mp4', everySeconds: 3600 }, now);
    (root.querySelector('.pux-ad__video') as HTMLVideoElement).play = vi.fn(() => Promise.resolve());
    await ads.play();

    expect(scrolled).toHaveBeenCalled();
  });

  it('leaves the page alone when the stage is already in view', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    stubBox(root, 40, 500);
    const scrolled = vi.fn();
    root.scrollIntoView = scrolled;

    const ads = attachAds(root, media, { next: () => 'x.mp4', everySeconds: 3600 }, now);
    (root.querySelector('.pux-ad__video') as HTMLVideoElement).play = vi.fn(() => Promise.resolve());
    await ads.play();

    expect(scrolled).not.toHaveBeenCalled();
  });

  it('a host that places the player itself can turn it off', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 513, configurable: true });
    stubBox(root, 512, 611);
    const scrolled = vi.fn();
    root.scrollIntoView = scrolled;

    const ads = attachAds(
      root,
      media,
      { next: () => 'x.mp4', everySeconds: 3600, revealStage: false },
      now,
    );
    (root.querySelector('.pux-ad__video') as HTMLVideoElement).play = vi.fn(() => Promise.resolve());
    await ads.play();

    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('an advert nobody can hear', () => {
  it('does not inherit a zero level from a WebAudio host', async () => {
    // A host that routes through an analyser and a gain node leaves the
    // element's own volume alone and governs loudness downstream, where an
    // advert in a separate element cannot see it. Inheriting the 0 produced an
    // advert that played perfectly and was silent.
    media.volume = 0;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 3600, fadeSeconds: 0 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());

    await ads.play();
    await vi.waitFor(() => expect(video.volume).toBeGreaterThan(0));
  });

  it('still honours a level the host actually set', async () => {
    media.volume = 0.35;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 3600, fadeSeconds: 0 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());
    await ads.play();
    await vi.waitFor(() => expect(video.volume).toBeCloseTo(0.35, 1));
  });

  it('a host that genuinely wants silence still gets it, through muted', async () => {
    media.volume = 0;
    media.muted = true;
    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 3600, fadeSeconds: 0 },
      now,
    );
    const video = root.querySelector('.pux-ad__video') as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve());
    await ads.play();
    expect(video.muted).toBe(true);
  });
});

/**
 * The advert plays in its own element, which the picture-in-picture window does
 * not know about: it renders one element's frames and nothing else on the page.
 * Left alone, a viewer watching a match in the corner of their screen gets a
 * frozen frame with advert sound over it, which is what was reported.
 */
describe('picture-in-picture', () => {
  type Pip = { requestPictureInPicture?: (() => Promise<unknown>) | undefined };
  let holder: Element | null;

  beforeEach(() => {
    holder = null;
    Object.defineProperty(document, 'pictureInPictureElement', {
      configurable: true,
      get: () => holder,
    });
    (HTMLVideoElement.prototype as Pip).requestPictureInPicture = vi.fn(function (
      this: HTMLVideoElement,
    ) {
      holder = this;
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    (HTMLVideoElement.prototype as Pip).requestPictureInPicture = undefined;
  });

  /** Run one break and wait until the advert is actually playing. */
  async function breakNow(options: Parameters<typeof attachAds>[2]): Promise<{
    ads: ReturnType<typeof attachAds>;
    ad: HTMLVideoElement;
  }> {
    const ads = attachAds(root, media, options, now);
    const ad = adElement(root);
    // Either element may carry the break, so both are stubbed: jsdom does not
    // play anything, and an unstubbed play() rejects rather than starting.
    const sound = root.querySelector('.pux-ad__audio') as HTMLAudioElement;
    let started = 0;
    const start = (): Promise<void> => {
      started += 1;
      return Promise.resolve();
    };
    ad.play = vi.fn(start);
    sound.play = vi.fn(start);
    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(started).toBeGreaterThan(0));
    return { ads, ad };
  }

  it('hands the window to the advert, so the break is seen and not just heard', async () => {
    holder = media; // the viewer popped the programme out
    const { ad } = await breakNow({
      next: () => 'https://ads.example/one.mp4',
      everySeconds: 10,
      fadeSeconds: 0,
    });
    await vi.waitFor(() => expect(document.pictureInPictureElement).toBe(ad));
  });

  it('gives the window back, while the advert still has a source to give it from', async () => {
    holder = media;
    let sourceAtHandback: string | null = 'never asked';
    const { ads, ad } = await breakNow({
      next: () => 'https://ads.example/one.mp4',
      everySeconds: 10,
      fadeSeconds: 0,
    });
    await vi.waitFor(() => expect(document.pictureInPictureElement).toBe(ad));
    (media as unknown as Pip).requestPictureInPicture = vi.fn(() => {
      // Dropping the advert's source closes its window first, and a closed
      // window cannot be handed anywhere.
      sourceAtHandback = ad.getAttribute('src');
      holder = media;
      return Promise.resolve({});
    });

    ad.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(ads.playing).toBe(false));
    expect(document.pictureInPictureElement).toBe(media);
    expect(sourceAtHandback).toBe('https://ads.example/one.mp4');
    expect(media.play).toHaveBeenCalled();
  });

  it('leaves the window alone for a viewer who is not using one', async () => {
    await breakNow({ next: () => 'https://ads.example/one.mp4', everySeconds: 10, fadeSeconds: 0 });
    expect(HTMLVideoElement.prototype.requestPictureInPicture).not.toHaveBeenCalled();
    expect(document.pictureInPictureElement).toBeNull();
  });

  it('an audio advert has no picture to show, so the window stays put', async () => {
    holder = media;
    await breakNow({ next: () => 'https://ads.example/one.mp3', everySeconds: 10, fadeSeconds: 0 });
    expect(HTMLVideoElement.prototype.requestPictureInPicture).not.toHaveBeenCalled();
    expect(document.pictureInPictureElement).toBe(media);
  });

  it('a browser that refuses the swap still gets its break, and its programme back', async () => {
    holder = media;
    const onError = vi.fn();
    (HTMLVideoElement.prototype as Pip).requestPictureInPicture = vi.fn(() =>
      Promise.reject(new Error('no picture in picture here')),
    );
    const { ads, ad } = await breakNow({
      next: () => 'https://ads.example/one.mp4',
      everySeconds: 10,
      fadeSeconds: 0,
      onError,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());

    ad.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(ads.playing).toBe(false));
    expect(media.play).toHaveBeenCalled();
  });

  it('uses presentation modes where that is the only spelling, as on Safari', async () => {
    type Webkit = {
      webkitPresentationMode?: string;
      webkitSetPresentationMode?: (mode: string) => void;
    };
    (HTMLVideoElement.prototype as Pip).requestPictureInPicture = undefined;
    (media as unknown as Webkit).webkitPresentationMode = 'picture-in-picture';
    const setMode = vi.fn();

    const ads = attachAds(
      root,
      media,
      { next: () => 'https://ads.example/one.mp4', everySeconds: 10, fadeSeconds: 0 },
      now,
    );
    const ad = adElement(root);
    ad.play = vi.fn(() => Promise.resolve());
    (ad as unknown as Webkit).webkitSetPresentationMode = setMode;

    media.dispatchEvent(new Event('play'));
    watch(11_000);
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledWith('picture-in-picture'));
    ads.destroy();
  });
});
