/**
 * The player.
 *
 * Plain DOM and no framework, because this has to run inside a React app
 * (pairux.com), a Hono JSX app with a vanilla client bundle (genrewatch.com,
 * tipoffwatch.com) and whatever comes next. The React wrapper in `../react` is
 * a ref and a mount effect around exactly this.
 *
 * It is a control bar and a set of behaviours; the bytes are somebody else's
 * job. `../engines` decides how a source reaches the media element — natively,
 * through hls.js, or through the transport stream demuxer — and this file never
 * learns which. That separation is the whole design: the same bar sits over a
 * recorded MP4, a live HLS ladder, a podcast MP3 and an IPTV channel, and each
 * of those used to need its own player.
 *
 * Three shapes come out of it, decided by the source rather than by the caller:
 *
 * - **VOD** — everything: scrub, skip, speed, resume, chapters, timestamps.
 * - **Live** — none of those, because they are all lies about a stream with no
 *   end: no scrub bar to drag, no position worth remembering, no speed that
 *   means anything. A LIVE badge instead.
 * - **Audio** — a compact bar with no stage, no fullscreen and no
 *   picture-in-picture, because there is no picture.
 */

import { activeChapter, normalizeChapters, type Chapter, type NormalizedChapter } from './chapters';
import {
  DEFAULT_PREFS,
  clearPosition,
  loadPosition,
  loadPrefs,
  savePosition,
  savePrefs,
  shouldResume,
  type PlayerPrefs,
} from './storage';
import { formatTime } from './time';
import { isTvBrowser, uiProfile } from './tv';
import {
  capabilitiesOf,
  chooseEngine,
  isAudioKind,
  type Capabilities,
  type EngineName,
  type SourceKind,
} from './source';
import type { EngineFactory, EngineHandle, QualityLevel } from '../engines/types';

export interface PlayerOptions {
  src: string;
  /** Skips source sniffing when the caller already knows. */
  kind?: SourceKind;
  /** A server-declared Content-Type, if one was seen. */
  mimeType?: string;
  /**
   * Stable key for this recording; what a resume position is filed under. Omit
   * and nothing is remembered — which is right for a live stream and for
   * anything a reader would rather not have recorded in their browser.
   */
  mediaId?: string;
  /**
   * Force live. Usually unnecessary: HLS reads it from the playlist and a
   * transport stream is live by nature.
   */
  live?: boolean;
  chapters?: readonly Chapter[];
  /** Where the reader arrived pointing, in seconds. Beats a saved position. */
  startAt?: number | null;
  /** Builds the "copy link at this time" URL. Omit to drop the button. */
  shareUrl?: ((seconds: number) => string) | null;
  poster?: string;
  autoplay?: boolean;
  /** An existing element to drive, instead of one built here. */
  media?: HTMLMediaElement;
  /** Appended to a codec failure, e.g. "VLC can — the button is beside Play." */
  unplayableAdvice?: string;
  /** Send cookies with stream requests; IPTV proxies authenticate that way. */
  withCredentials?: boolean;
  /** Replace or inject an engine. Mostly for tests. */
  engines?: Partial<Record<EngineName, EngineFactory>>;
  /**
   * Override what this browser is believed capable of. Detected when omitted,
   * which is almost always right — supply it only when the host knows better
   * than the feature test, or to pin behaviour in a test.
   */
  capabilities?: Capabilities;
  userAgent?: string;
  storage?: Storage | null;
  now?: () => number;
}

export interface PlayerHandle {
  destroy: () => void;
  setChapters: (chapters: readonly Chapter[]) => void;
  /** The element being driven, for a caller that needs it. */
  readonly media: HTMLMediaElement;
}

/** The speeds the button cycles. 1x first so a press away from it always returns. */
const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75] as const;

const SAVE_EVERY_MS = 5000;
const SKIP_SECONDS = 10;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  replay:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  back10:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="17" font-size="8" text-anchor="middle" fill="currentColor">10</text></svg>',
  fwd10:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="17" font-size="8" text-anchor="middle" fill="currentColor">10</text></svg>',
  volume:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  muted:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M15 9l6 6m0-6l-6 6" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  pip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v14H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12h7v5h-7z"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16a4 4 0 0 1 0-5.7l2-2a4 4 0 0 1 5.7 5.7l-1 1-1.4-1.4 1-1a2 2 0 0 0-2.9-2.9l-2 2A2 2 0 0 0 9.4 14.6L8 16z"/><path d="M16 8a4 4 0 0 1 0 5.7l-2 2A4 4 0 0 1 8.3 10l1-1 1.4 1.4-1 1a2 2 0 0 0 2.9 2.9l2-2A2 2 0 0 0 14.6 9.4L16 8z"/></svg>',
  enterFullscreen:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm14 0h2v5h-5v-2h3v-3z"/></svg>',
  exitFullscreen:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v3H6v2H4V4h5zm6 0h5v5h-2V7h-3V4zM4 15h2v3h3v2H4v-5zm14 3v-3h2v5h-5v-2h3z"/></svg>',
} as const;

interface FullscreenVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * Every control carries a `data-control` name — what tests select on and what a
 * host site can style or hide without depending on the order buttons sit in.
 */
function iconButton(
  className: string,
  label: string,
  icon: string,
  control: string
): HTMLButtonElement {
  const button = el('button', className, {
    type: 'button',
    'aria-label': label,
    title: label,
    'data-control': control,
  });
  button.innerHTML = icon;
  return button;
}

/**
 * Turn a media error into something a reader can act on.
 *
 * The default is a black rectangle and nothing else, which is how a policy
 * problem spends a week being reported as "the player is broken" — a blocked
 * media load is a console-only event, and the code the element carries is the
 * only in-page evidence there is.
 */
function errorMessage(media: HTMLMediaElement): string {
  const error = media.error;
  const detail = error?.message ?? '';
  // Chrome's wording when a Content-Security-Policy media-src refused the load.
  if (/URL safety check/i.test(detail)) {
    return 'This was blocked before it could load. That is a configuration problem on our side, not on yours — please report it.';
  }
  switch (error?.code) {
    case 1:
      return 'Playback was stopped before it started.';
    case 2:
      return 'The connection dropped while loading. Check your network and try again.';
    case 3:
      return 'This could not be decoded by your browser.';
    case 4:
      return 'This is missing, or in a format your browser cannot play.';
    default:
      return 'This could not be played.';
  }
}

export function createPlayer(root: HTMLElement, options: PlayerOptions): PlayerHandle {
  const {
    src,
    mediaId,
    startAt = null,
    shareUrl = null,
    storage,
    now = Date.now,
    userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  } = options;

  const isTv = isTvBrowser(userAgent);
  const profile = uiProfile(isTv);

  const caps = options.capabilities ?? capabilitiesOf();
  const choice = chooseEngine(
    {
      src,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    },
    caps
  );
  const audioOnly = isAudioKind(choice.kind);
  // A transport stream has no end and no seekable range; HLS tells us later,
  // from the playlist, and flips this if it turns out to be a live edge.
  let live = options.live ?? choice.kind === 'mpegts';

  const media: HTMLMediaElement =
    options.media ?? document.createElement(audioOnly ? 'audio' : 'video');
  if (!options.media) root.append(media);
  if (!audioOnly && options.poster && media instanceof HTMLVideoElement) {
    media.poster = options.poster;
  }
  // playsInline is a video-only attribute; an <audio> element has no such
  // property and assigning to it would be a silent no-op at best.
  if (media instanceof HTMLVideoElement) media.playsInline = true;
  // The browser's own controls would be a second, differently shaped set of the
  // same buttons sitting on top of these.
  media.controls = false;

  root.classList.add('pux-player');
  if (isTv) root.classList.add('pux-player--tv');
  if (audioOnly) root.classList.add('pux-player--audio');
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '0');

  // ---------------------------------------------------------------- markup --

  const overlay = iconButton('pux-player__overlay', 'Play', ICONS.play, 'overlay');
  const spinner = el('div', 'pux-player__spinner', { 'aria-hidden': 'true' });
  const notice = el('div', 'pux-player__notice', { role: 'status', 'aria-live': 'polite' });
  notice.hidden = true;
  const noticeText = el('span', 'pux-player__notice-text');
  const noticeAction = el('button', 'pux-player__notice-action', { type: 'button' });
  noticeAction.hidden = true;
  notice.append(noticeText, noticeAction);

  const bar = el('div', 'pux-player__bar');

  const scrub = el('div', 'pux-player__scrub', {
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Seek',
    'aria-valuemin': '0',
    'aria-valuenow': '0',
  });
  const track = el('div', 'pux-player__track');
  const buffered = el('div', 'pux-player__buffered');
  const played = el('div', 'pux-player__played');
  const marks = el('div', 'pux-player__marks', { 'aria-hidden': 'true' });
  const handle = el('div', 'pux-player__handle', { 'aria-hidden': 'true' });
  const tooltip = el('div', 'pux-player__tooltip', { 'aria-hidden': 'true' });
  track.append(buffered, played, marks, handle);
  scrub.append(track, tooltip);

  const row = el('div', 'pux-player__row');
  const playButton = iconButton('pux-player__btn', 'Play', ICONS.play, 'play');
  const backButton = iconButton(
    'pux-player__btn',
    `Back ${String(SKIP_SECONDS)} seconds`,
    ICONS.back10,
    'back'
  );
  const forwardButton = iconButton(
    'pux-player__btn',
    `Forward ${String(SKIP_SECONDS)} seconds`,
    ICONS.fwd10,
    'forward'
  );

  const volumeWrap = el('div', 'pux-player__volume');
  const muteButton = iconButton('pux-player__btn', 'Mute', ICONS.volume, 'mute');
  const volumeInput = el('input', 'pux-player__volume-input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    'aria-label': 'Volume',
    'data-control': 'volume',
  });
  volumeWrap.append(muteButton, volumeInput);

  const liveBadge = el('div', 'pux-player__live', { 'data-control': 'live' });
  liveBadge.textContent = 'LIVE';
  const timeLabel = el('div', 'pux-player__time');
  const chapterLabel = el('div', 'pux-player__chapter');
  const spacer = el('div', 'pux-player__spacer');

  const rateButton = el('button', 'pux-player__btn pux-player__btn--text', {
    type: 'button',
    'aria-label': 'Playback speed',
    title: 'Playback speed',
    'data-control': 'rate',
  });
  const qualityButton = el('button', 'pux-player__btn pux-player__btn--text', {
    type: 'button',
    'aria-label': 'Quality',
    title: 'Quality',
    'data-control': 'quality',
  });
  qualityButton.hidden = true;
  const shareButton = iconButton('pux-player__btn', 'Copy link at this time', ICONS.link, 'share');
  const pipButton = iconButton('pux-player__btn', 'Picture in picture', ICONS.pip, 'pip');
  const fullscreenButton = iconButton(
    'pux-player__btn',
    'Fullscreen',
    ICONS.enterFullscreen,
    'fullscreen'
  );

  row.append(
    playButton,
    backButton,
    forwardButton,
    volumeWrap,
    liveBadge,
    timeLabel,
    chapterLabel,
    spacer,
    rateButton,
    qualityButton,
    shareButton,
    pipButton,
    fullscreenButton
  );
  bar.append(scrub, row);
  root.append(overlay, spinner, notice, bar);

  // What this device and this source cannot use.
  if (isTv) {
    volumeInput.hidden = true;
    pipButton.hidden = true;
  }
  if (audioOnly) {
    // No picture: nothing to make full screen, nothing to float in a corner.
    fullscreenButton.hidden = true;
    pipButton.hidden = true;
    overlay.hidden = true;
  }
  if (!shareUrl) shareButton.hidden = true;
  if (typeof document === 'undefined' || !document.pictureInPictureEnabled) pipButton.hidden = true;

  // ----------------------------------------------------------------- state --

  let chapters: NormalizedChapter[] = [];
  let chapterSource: readonly Chapter[] = options.chapters ?? [];
  const cleanups: (() => void)[] = [];
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSaved = 0;
  let scrubbing = false;
  let destroyed = false;
  let engine: EngineHandle | null = null;
  let levels: QualityLevel[] = [];

  function on(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    opts?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  }

  function showNotice(message: string, action?: { label: string; run: () => void }): void {
    noticeText.textContent = message;
    notice.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    if (action) {
      noticeAction.hidden = false;
      noticeAction.textContent = action.label;
      noticeAction.onclick = () => {
        action.run();
        hideNotice();
      };
    } else {
      noticeAction.hidden = true;
      noticeAction.onclick = null;
    }
    noticeTimer = setTimeout(hideNotice, action ? 9000 : 4000);
  }

  function hideNotice(): void {
    notice.hidden = true;
    noticeAction.onclick = null;
  }

  /**
   * Show only what this source can honour.
   *
   * Called again whenever an engine reports back, because "is this live" is not
   * knowable until the playlist has been read — an HLS URL looks identical
   * either way, and guessing wrong means offering a scrub bar on a live stream
   * or hiding one on a recording.
   */
  function applyMode(): void {
    root.classList.toggle('pux-player--live', live);
    scrub.hidden = live;
    backButton.hidden = live;
    forwardButton.hidden = live;
    rateButton.hidden = live;
    shareButton.hidden = live || !shareUrl;
    liveBadge.hidden = !live;
    timeLabel.hidden = live;
    chapterLabel.hidden = live;
  }

  // ---------------------------------------------------------------- render --

  function renderMarks(): void {
    marks.replaceChildren();
    for (const chapter of chapters) {
      const mark = el('button', 'pux-player__mark', {
        type: 'button',
        'aria-label': `${chapter.title}, ${formatTime(chapter.start)}`,
        title: chapter.title,
      });
      mark.style.left = `${String(chapter.position * 100)}%`;
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        media.currentTime = chapter.start;
      });
      marks.append(mark);
    }
  }

  function rebuildChapters(): void {
    chapters = live ? [] : normalizeChapters(chapterSource, media.duration);
    renderMarks();
    renderProgress();
  }

  function renderProgress(): void {
    if (live) return;
    const duration = media.duration;
    const current = media.currentTime;
    const known = Number.isFinite(duration) && duration > 0;
    const fraction = known ? Math.min(1, Math.max(0, current / duration)) : 0;

    played.style.width = `${String(fraction * 100)}%`;
    handle.style.left = `${String(fraction * 100)}%`;

    if (media.buffered.length > 0 && known) {
      let end = 0;
      for (let i = 0; i < media.buffered.length; i += 1) {
        if (media.buffered.start(i) <= current && media.buffered.end(i) >= current) {
          end = media.buffered.end(i);
          break;
        }
      }
      buffered.style.width = `${String(Math.min(1, end / duration) * 100)}%`;
    }

    timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    scrub.setAttribute('aria-valuenow', String(Math.floor(current)));
    if (known) scrub.setAttribute('aria-valuemax', String(Math.floor(duration)));
    scrub.setAttribute(
      'aria-valuetext',
      known ? `${formatTime(current)} of ${formatTime(duration)}` : formatTime(current)
    );

    const chapter = activeChapter(chapters, current);
    chapterLabel.textContent = chapter ? chapter.title : '';
  }

  function renderPlayState(): void {
    const isPlaying = !media.paused && !media.ended;
    const ended = media.ended;
    const icon = ended ? ICONS.replay : isPlaying ? ICONS.pause : ICONS.play;
    const label = ended ? 'Play again' : isPlaying ? 'Pause' : 'Play';
    playButton.innerHTML = icon;
    playButton.setAttribute('aria-label', label);
    playButton.title = label;
    overlay.innerHTML = icon;
    overlay.setAttribute('aria-label', label);
    root.classList.toggle('pux-player--playing', isPlaying);
    root.classList.toggle('pux-player--ended', ended);
    if (!isPlaying) showControls(false);
  }

  function renderVolume(): void {
    const off = media.muted || media.volume === 0;
    muteButton.innerHTML = off ? ICONS.muted : ICONS.volume;
    muteButton.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
    muteButton.setAttribute('aria-pressed', off ? 'true' : 'false');
    volumeInput.value = String(off ? 0 : media.volume);
  }

  function renderRate(): void {
    rateButton.textContent = `${String(media.playbackRate)}×`;
    rateButton.setAttribute('aria-label', `Playback speed, ${String(media.playbackRate)} times`);
  }

  function renderQuality(): void {
    // One level is not a choice, and a ladder nobody can climb is clutter.
    qualityButton.hidden = levels.length < 2 || !engine?.setLevel;
    if (qualityButton.hidden) return;
    const current = engine?.currentLevel?.() ?? -1;
    const level = levels.find((l) => l.index === current);
    qualityButton.textContent = current === -1 ? 'Auto' : (level?.label ?? 'Auto');
  }

  // --------------------------------------------------------------- controls --

  function showControls(autoHide = true): void {
    root.classList.add('pux-player--controls');
    if (hideTimer) clearTimeout(hideTimer);
    if (!autoHide) return;
    hideTimer = setTimeout(() => {
      if (!media.paused) root.classList.remove('pux-player--controls');
    }, profile.hideAfterMs);
  }

  function togglePlay(): void {
    if (media.paused || media.ended) void media.play().catch(() => undefined);
    else media.pause();
  }

  function seekBy(delta: number): void {
    if (live) return;
    const duration = Number.isFinite(media.duration) ? media.duration : Infinity;
    media.currentTime = Math.min(duration, Math.max(0, media.currentTime + delta));
    // Redrawn here and not left to `timeupdate`, which a PAUSED element never
    // fires: without this, arrowing along a paused recording moves the playhead
    // while the bar and the clock sit exactly where they were.
    renderProgress();
    showControls();
  }

  function seekToFraction(fraction: number): void {
    if (live) return;
    if (!Number.isFinite(media.duration) || media.duration <= 0) return;
    media.currentTime = Math.min(1, Math.max(0, fraction)) * media.duration;
    renderProgress();
  }

  function fractionFromPointer(clientX: number): number {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return (clientX - rect.left) / rect.width;
  }

  function cycleRate(step: number): void {
    const index = RATES.indexOf(media.playbackRate as (typeof RATES)[number]);
    const next = RATES[(index + step + RATES.length) % RATES.length] ?? 1;
    media.playbackRate = next;
  }

  function cycleQuality(): void {
    if (!engine?.setLevel) return;
    // Auto, then each rung, then back to auto.
    const order = [-1, ...levels.map((l) => l.index)];
    const current = engine.currentLevel?.() ?? -1;
    const at = order.indexOf(current);
    const next = order[(at + 1) % order.length] ?? -1;
    engine.setLevel(next);
    renderQuality();
    showControls();
  }

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await root.requestFullscreen();
    } catch {
      // iPhone Safari has no element fullscreen -- `requestFullscreen` is not
      // there to call -- but the video element has one of its own. Every other
      // browser's refusal lands here too, and none is worth an error message.
      (media as FullscreenVideo).webkitEnterFullscreen?.();
    }
  }

  async function togglePip(): Promise<void> {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (media instanceof HTMLVideoElement) await media.requestPictureInPicture();
    } catch {
      showNotice('Picture in picture is not available here.');
    }
  }

  async function copyLink(): Promise<void> {
    if (!shareUrl) return;
    const at = Math.floor(media.currentTime);
    const url = shareUrl(at);
    try {
      await navigator.clipboard.writeText(url);
      showNotice(`Link copied, starting at ${formatTime(at)}.`);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. Showing
      // the URL is still an answer.
      showNotice(url);
    }
  }

  // ----------------------------------------------------------------- events --

  on(media, 'loadedmetadata', () => {
    rebuildChapters();
    renderProgress();
    if (live) return;

    const wanted = typeof startAt === 'number' && startAt > 0 ? startAt : null;
    if (wanted !== null && Number.isFinite(media.duration) && wanted < media.duration) {
      media.currentTime = wanted;
      return;
    }
    if (!mediaId) return;
    const saved = loadPosition(mediaId, storage);
    if (shouldResume(saved, media.duration) && saved) {
      media.currentTime = saved.t;
      showNotice(`Resumed at ${formatTime(saved.t)}.`, {
        label: 'Start over',
        run: () => {
          media.currentTime = 0;
          clearPosition(mediaId, storage);
        },
      });
    }
  });

  function persist(): void {
    if (live || !mediaId) return;
    if (Number.isFinite(media.duration) && media.duration > 0 && !media.ended) {
      savePosition(mediaId, { t: media.currentTime, d: media.duration }, storage, now);
    }
  }

  on(media, 'timeupdate', () => {
    if (!scrubbing) renderProgress();
    if (now() - lastSaved < SAVE_EVERY_MS) return;
    lastSaved = now();
    persist();
  });

  on(media, 'progress', renderProgress);
  // Catches the seeks this player did not make: a chapter mark, the media keys,
  // another script, and the browser's own snap to the nearest keyframe.
  on(media, 'seeked', renderProgress);
  on(media, 'seeking', renderProgress);
  on(media, 'durationchange', rebuildChapters);
  on(media, 'play', renderPlayState);
  on(media, 'pause', () => {
    renderPlayState();
    persist();
  });
  on(media, 'ended', () => {
    renderPlayState();
    // A finished recording has no position worth keeping; leaving one means
    // every future visit resumes 3 seconds from the end.
    if (mediaId) clearPosition(mediaId, storage);
  });
  on(media, 'volumechange', () => {
    renderVolume();
    savePrefs({ volume: media.volume, muted: media.muted, rate: media.playbackRate }, storage);
  });
  on(media, 'ratechange', () => {
    renderRate();
    savePrefs({ volume: media.volume, muted: media.muted, rate: media.playbackRate }, storage);
  });
  on(media, 'waiting', () => root.classList.add('pux-player--buffering'));
  on(media, 'playing', () => root.classList.remove('pux-player--buffering'));
  on(media, 'canplay', () => root.classList.remove('pux-player--buffering'));
  on(media, 'error', () => {
    root.classList.remove('pux-player--buffering');
    root.classList.add('pux-player--failed');
    showNotice(errorMessage(media));
  });

  on(overlay, 'click', togglePlay);
  on(playButton, 'click', togglePlay);
  on(backButton, 'click', () => {
    seekBy(-SKIP_SECONDS);
  });
  on(forwardButton, 'click', () => {
    seekBy(SKIP_SECONDS);
  });
  on(muteButton, 'click', () => {
    media.muted = !media.muted;
  });
  on(volumeInput, 'input', () => {
    media.volume = Number(volumeInput.value);
    media.muted = Number(volumeInput.value) === 0;
  });
  on(rateButton, 'click', () => {
    cycleRate(1);
  });
  on(qualityButton, 'click', cycleQuality);
  on(shareButton, 'click', () => void copyLink());
  on(pipButton, 'click', () => void togglePip());
  on(fullscreenButton, 'click', () => void toggleFullscreen());

  on(document, 'fullscreenchange', () => {
    const isFull = document.fullscreenElement === root;
    root.classList.toggle('pux-player--fullscreen', isFull);
    fullscreenButton.innerHTML = isFull ? ICONS.exitFullscreen : ICONS.enterFullscreen;
    fullscreenButton.setAttribute('aria-label', isFull ? 'Exit fullscreen' : 'Fullscreen');
  });

  on(scrub, 'pointerdown', (event) => {
    const pointer = event as PointerEvent;
    scrubbing = true;
    scrub.setPointerCapture(pointer.pointerId);
    seekToFraction(fractionFromPointer(pointer.clientX));
  });
  on(scrub, 'pointermove', (event) => {
    const pointer = event as PointerEvent;
    const fraction = fractionFromPointer(pointer.clientX);
    if (Number.isFinite(media.duration) && media.duration > 0) {
      tooltip.textContent = formatTime(Math.max(0, Math.min(1, fraction)) * media.duration);
      tooltip.style.left = `${String(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }
    if (!scrubbing) return;
    seekToFraction(fraction);
  });
  const endScrub = (event: Event): void => {
    if (!scrubbing) return;
    scrubbing = false;
    const pointer = event as PointerEvent;
    if (scrub.hasPointerCapture(pointer.pointerId)) scrub.releasePointerCapture(pointer.pointerId);
  };
  on(scrub, 'pointerup', endScrub);
  on(scrub, 'pointercancel', endScrub);

  on(root, 'pointermove', () => {
    showControls();
  });
  on(root, 'pointerleave', () => {
    if (!media.paused) root.classList.remove('pux-player--controls');
  });
  on(root, 'focusin', () => {
    showControls();
  });

  /**
   * Keys.
   *
   * The arrow keys are the awkward ones: they are the seek and volume controls
   * for somebody watching, and they are how a D-pad reader moves between the
   * buttons in the bar. So arrows are only ours when focus is on the picture or
   * the scrubber — once focus is in the control row the browser's own focus
   * movement wins, which is what makes the bar usable from a sofa.
   */
  on(root, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    const target = event.target as HTMLElement | null;
    const inRow = target ? row.contains(target) : false;
    const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (inRow && arrows.includes(key)) return;

    switch (key) {
      case ' ':
      case 'k':
      case 'Enter':
        if (key === 'Enter' && target?.closest('button')) return;
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        seekBy(-profile.seekStep);
        break;
      case 'ArrowRight':
        event.preventDefault();
        seekBy(profile.seekStep);
        break;
      case 'j':
        seekBy(-SKIP_SECONDS);
        break;
      case 'l':
        seekBy(SKIP_SECONDS);
        break;
      case 'ArrowUp':
        event.preventDefault();
        media.volume = Math.min(1, media.volume + 0.1);
        media.muted = false;
        showControls();
        break;
      case 'ArrowDown':
        event.preventDefault();
        media.volume = Math.max(0, media.volume - 0.1);
        showControls();
        break;
      case 'm':
        media.muted = !media.muted;
        showControls();
        break;
      case 'f':
        if (!fullscreenButton.hidden) void toggleFullscreen();
        break;
      case 'p':
        if (!pipButton.hidden) void togglePip();
        break;
      case 'Home':
        event.preventDefault();
        if (!live) media.currentTime = 0;
        break;
      case 'End':
        event.preventDefault();
        if (!live && Number.isFinite(media.duration)) media.currentTime = media.duration;
        break;
      case '<':
      case ',':
        if (!live) {
          cycleRate(-1);
          showControls();
        }
        break;
      case '>':
      case '.':
        if (!live) {
          cycleRate(1);
          showControls();
        }
        break;
      default:
        if (/^[0-9]$/.test(key) && !inRow && !live) {
          event.preventDefault();
          seekToFraction(Number(key) / 10);
        }
    }
  });

  // Leaving the page is the most common way a reader stops watching, and it
  // fires no pause. pagehide rather than unload: it is the one that fires on
  // iOS and on a back/forward navigation.
  on(window, 'pagehide', persist);

  // ------------------------------------------------------------------ init --

  const prefs: PlayerPrefs = loadPrefs(storage);
  media.volume = prefs.volume;
  media.muted = options.autoplay ? true : prefs.muted;
  media.playbackRate = prefs.rate === 0 ? DEFAULT_PREFS.rate : prefs.rate;

  applyMode();
  renderPlayState();
  renderVolume();
  renderRate();
  renderProgress();
  rebuildChapters();
  showControls(false);

  if (choice.unplayable) {
    root.classList.add('pux-player--failed');
    showNotice(choice.unplayable);
  }

  // Attaching is asynchronous because every engine but the native one is loaded
  // on demand. Nothing above depends on it having happened.
  const attaching = attachEngine();
  async function attachEngine(): Promise<void> {
    if (choice.unplayable && choice.engine !== 'native') return;
    const context = {
      media,
      src,
      isTv,
      live,
      onError: (message: string) => {
        root.classList.add('pux-player--failed');
        showNotice(message);
      },
      onNotice: (message: string | null) => {
        if (message === null) hideNotice();
        else showNotice(message);
      },
      onReady: (info: { live: boolean; levels: QualityLevel[] }) => {
        if (destroyed) return;
        if (info.live !== live) {
          live = info.live;
          applyMode();
          rebuildChapters();
        }
        levels = info.levels;
        renderQuality();
      },
    };

    try {
      const override = options.engines?.[choice.engine];
      if (override) {
        engine = await override(context);
      } else if (choice.engine === 'hls') {
        const { createHlsEngine } = await import('../engines/hls');
        engine = await createHlsEngine(context);
      } else if (choice.engine === 'mpegts') {
        const { createMpegtsEngine } = await import('../engines/mpegts');
        engine = await createMpegtsEngine(context, {
          withCredentials: options.withCredentials ?? false,
          unplayableAdvice: options.unplayableAdvice ?? '',
        });
      } else {
        const { createNativeEngine } = await import('../engines/native');
        engine = await createNativeEngine(context);
      }
      if (destroyed) {
        engine.destroy();
        engine = null;
        return;
      }
      renderQuality();
      if (options.autoplay) void media.play().catch(() => undefined);
    } catch {
      root.classList.add('pux-player--failed');
      showNotice('The player could not be loaded. Please reload the page.');
    }
  }

  return {
    media,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      persist();
      if (hideTimer) clearTimeout(hideTimer);
      if (noticeTimer) clearTimeout(noticeTimer);
      for (const cleanup of cleanups) cleanup();
      void attaching.then(() => {
        engine?.destroy();
        engine = null;
      });
      overlay.remove();
      spinner.remove();
      notice.remove();
      bar.remove();
      if (!options.media) media.remove();
      root.classList.remove(
        'pux-player',
        'pux-player--tv',
        'pux-player--audio',
        'pux-player--live',
        'pux-player--controls',
        'pux-player--playing',
        'pux-player--ended',
        'pux-player--buffering',
        'pux-player--failed',
        'pux-player--fullscreen'
      );
    },
    setChapters(next: readonly Chapter[]): void {
      chapterSource = next;
      rebuildChapters();
    },
  };
}
