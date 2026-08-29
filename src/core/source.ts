/**
 * Which engine plays this?
 *
 * The one decision no player in this org made before, because each was built
 * for exactly one kind of source and could assume it. tipoffwatch always builds
 * an mpegts demuxer; PairUX always hands the URL to the browser. Both are right
 * about their own content and wrong about everything else, which is why an HLS
 * playlist on tipoffwatch is answered with `415, 'that channel is an HLS
 * playlist'` rather than played.
 *
 * The rule here is: name the KIND from the source, then pick the engine from
 * the kind *and the browser*, because the same kind is native on one device and
 * needs a library on the next. HLS is the case that matters, and the browser
 * cannot be asked directly — see chooseEngine for why `canPlayType` is not
 * evidence.
 */

export type SourceKind = 'mp4' | 'hls' | 'mpegts' | 'audio' | 'unknown';
export type EngineName = 'native' | 'hls' | 'mpegts';

export interface SourceInput {
  src: string;
  /** Skips sniffing when the caller already knows. */
  kind?: SourceKind;
  /** A server-declared MIME type, if one was seen. */
  mimeType?: string;
}

/** What a browser will admit to playing without help. */
export interface Capabilities {
  /** `MediaSource` exists — hls.js and mpegts.js both require it. */
  mediaSource: boolean;
  /**
   * The browser CLAIMS it plays HLS itself. Treated as a fallback signal only:
   * Chrome says `"maybe"` and means nothing by it. See chooseEngine.
   */
  nativeHls: boolean;
}

const EXTENSIONS: readonly (readonly [RegExp, SourceKind])[] = [
  [/\.m3u8$/i, 'hls'],
  [/\.(ts|mts|m2ts|mpegts)$/i, 'mpegts'],
  [/\.(mp3|m4a|aac|oga|ogg|opus|wav|flac)$/i, 'audio'],
  [/\.(mp4|m4v|webm|mov|ogv)$/i, 'mp4'],
];

const MIME_TYPES: readonly (readonly [RegExp, SourceKind])[] = [
  [/mpegurl/i, 'hls'],
  [/mp2t|mpeg-?ts/i, 'mpegts'],
  [/^audio\//i, 'audio'],
  [/^video\//i, 'mp4'],
];

/**
 * Name the kind of a source.
 *
 * A declared MIME type outranks the URL: an extension is a hint somebody typed,
 * a Content-Type is what the server says it is about to send. Neither is
 * required — a URL with no extension and no type is `unknown`, which plays
 * natively, which is the right guess because that is what a plain progressive
 * file behind a redirect looks like.
 */
export function detectKind(input: SourceInput): SourceKind {
  if (input.kind) return input.kind;

  if (input.mimeType) {
    for (const [pattern, kind] of MIME_TYPES) {
      if (pattern.test(input.mimeType)) return kind;
    }
  }

  // Only the path is consulted. Query strings carry extensions that are not the
  // file's: a signed URL often ends `?response-content-disposition=...mp4`.
  const path = pathOf(input.src);
  for (const [pattern, kind] of EXTENSIONS) {
    if (pattern.test(path)) return kind;
  }
  return 'unknown';
}

function pathOf(src: string): string {
  try {
    return new URL(src, 'https://placeholder.invalid').pathname;
  } catch {
    return src.split(/[?#]/)[0] ?? src;
  }
}

export function capabilitiesOf(
  win: { MediaSource?: unknown } = globalThis as { MediaSource?: unknown },
  probe: HTMLMediaElement | null = null
): Capabilities {
  const mediaSource = typeof win.MediaSource !== 'undefined';
  let nativeHls = false;
  try {
    const element =
      probe ?? (typeof document === 'undefined' ? null : document.createElement('video'));
    nativeHls = element
      ? element.canPlayType('application/vnd.apple.mpegurl') !== '' ||
        element.canPlayType('application/x-mpegURL') !== ''
      : false;
  } catch {
    nativeHls = false;
  }
  return { mediaSource, nativeHls };
}

export interface EngineChoice {
  engine: EngineName;
  kind: SourceKind;
  /** Set when the source cannot be played here at all, in words for a reader. */
  unplayable?: string;
}

/**
 * Pick the engine.
 *
 * The order of the HLS branch is the whole point, and it is the opposite of the
 * obvious one. The obvious order — native first, since the browser's own
 * implementation gets AirPlay and the lock screen right — is wrong, because
 * **`canPlayType` lies about HLS**. Chrome answers `"maybe"` to
 * `application/vnd.apple.mpegurl` on builds that cannot play a playlist at all;
 * it is a claim about the MIME type, not about a decoder. Trusting it sends
 * every Chrome user down a path that silently plays nothing, and this was
 * caught here exactly that way: a headless Chrome reported native HLS, was
 * handed the stream, and the quality ladder came back empty because no hls.js
 * had ever loaded.
 *
 * So: Media Source first. Wherever hls.js can run, it runs — Chrome, Firefox,
 * Edge, Android, and Safari on the desktop, all of which have MSE. Native is
 * the fallback for the one browser that genuinely needs it and genuinely does
 * it properly: iOS, which has no MediaSource at all and where the native path
 * is the only path. That is the same ordering hls.js's own documentation
 * recommends, for the same reason.
 */
export function chooseEngine(input: SourceInput, caps: Capabilities): EngineChoice {
  const kind = detectKind(input);

  switch (kind) {
    case 'hls':
      if (caps.mediaSource) return { engine: 'hls', kind };
      if (caps.nativeHls) return { engine: 'native', kind };
      return { engine: 'native', kind, unplayable: 'This browser cannot play HLS streams.' };

    case 'mpegts':
      // No browser decodes a transport stream, and none is going to start.
      if (!caps.mediaSource) {
        return {
          engine: 'mpegts',
          kind,
          unplayable: 'This browser cannot play transport streams.',
        };
      }
      return { engine: 'mpegts', kind };

    default:
      return { engine: 'native', kind };
  }
}

/** Whether this source wants the compact audio UI rather than a 16:9 stage. */
export function isAudioKind(kind: SourceKind): boolean {
  return kind === 'audio';
}
