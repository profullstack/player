/**
 * The delivery layer on its own, with no control bar attached.
 *
 * `createPlayer` is the whole player: it builds a bar, owns the keyboard, and
 * decides what a source may be asked to do. That is right for a page whose job
 * is to show one recording, and wrong for an app that already has a player.
 *
 * Three of ours do. p0dcasters and rssamplifier each run a queue-aware dock —
 * next, previous, a persisted playlist, a bar that outlives the page you are
 * on — and media-streamer has a modal per source with its own retry and
 * favourites. Replacing those with this package's bar would delete working
 * features to gain a nicer-looking one. But every one of them still has to
 * answer "how do these bytes reach the element", and every one answers it
 * separately — which is how a podcast that ships an HLS enclosure plays on one
 * of our sites and not another.
 *
 * So this is the half worth sharing with them: pick the engine, attach it, hand
 * back something that tears down. No DOM is created, nothing is styled, and the
 * caller's own UI is untouched.
 *
 * ```js
 * const attached = await attachSource(audioEl, { src: episode.url });
 * // ...later
 * attached.destroy();
 * ```
 */

import {
  capabilitiesOf,
  chooseEngine,
  type Capabilities,
  type EngineName,
  type SourceKind,
} from './source';
import type { EngineFactory, EngineHandle, EngineInfo, QualityLevel } from '../engines/types';

export interface AttachOptions {
  src: string;
  kind?: SourceKind;
  mimeType?: string;
  /** Force live; HLS otherwise reads it from the playlist. */
  live?: boolean;
  /** True on a television, which wants a very different buffering profile. */
  isTv?: boolean;
  withCredentials?: boolean;
  /** Appended to a codec failure, e.g. "VLC can — the button is beside Play." */
  unplayableAdvice?: string;
  /** Terminal: playback has stopped, and this is what to tell the reader. */
  onError?: (message: string) => void;
  /** Not terminal. Null clears whatever was showing. */
  onNotice?: (message: string | null) => void;
  /** Fires once the engine knows what the caller could not assume. */
  onReady?: (info: EngineInfo) => void;
  capabilities?: Capabilities;
  engines?: Partial<Record<EngineName, EngineFactory>>;
}

export interface AttachedSource {
  /** Drops the engine and releases the connection. */
  destroy: () => void;
  /** Which engine was chosen, for a caller that wants to say so. */
  engine: EngineName;
  kind: SourceKind;
  levels: () => QualityLevel[];
  setLevel?: (index: number) => void;
  currentLevel?: () => number;
  /**
   * Set when nothing here can play this source. No engine is attached and
   * `destroy` is a no-op; this string is the reason, in words for a reader.
   */
  unplayable?: string;
}

export async function attachSource(
  media: HTMLMediaElement,
  options: AttachOptions
): Promise<AttachedSource> {
  const caps = options.capabilities ?? capabilitiesOf();
  const choice = chooseEngine(
    {
      src: options.src,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    },
    caps
  );

  const noop = (): void => undefined;
  const context = {
    media,
    src: options.src,
    isTv: options.isTv ?? false,
    live: options.live ?? choice.kind === 'mpegts',
    onError: options.onError ?? noop,
    onNotice: options.onNotice ?? noop,
    ...(options.onReady ? { onReady: options.onReady } : {}),
  };

  if (choice.unplayable) {
    options.onError?.(choice.unplayable);
    return {
      destroy: noop,
      engine: choice.engine,
      kind: choice.kind,
      levels: () => [],
      unplayable: choice.unplayable,
    };
  }

  let handle: EngineHandle;
  const override = options.engines?.[choice.engine];
  if (override) {
    handle = await override(context);
  } else if (choice.engine === 'hls') {
    const { createHlsEngine } = await import('../engines/hls');
    handle = await createHlsEngine(context);
  } else if (choice.engine === 'mpegts') {
    const { createMpegtsEngine } = await import('../engines/mpegts');
    handle = await createMpegtsEngine(context, {
      withCredentials: options.withCredentials ?? false,
      unplayableAdvice: options.unplayableAdvice ?? '',
    });
  } else {
    const { createNativeEngine } = await import('../engines/native');
    handle = await createNativeEngine(context);
  }

  return {
    destroy: () => {
      handle.destroy();
    },
    engine: choice.engine,
    kind: choice.kind,
    levels: handle.levels,
    ...(handle.setLevel ? { setLevel: handle.setLevel } : {}),
    ...(handle.currentLevel ? { currentLevel: handle.currentLevel } : {}),
  };
}
