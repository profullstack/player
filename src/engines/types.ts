/**
 * What an engine is.
 *
 * An engine's only job is to get bytes into a media element. It knows nothing
 * about controls, and the controls know nothing about it — which is what lets
 * the same bar sit over a progressive MP4, an HLS ladder and a transport stream
 * off somebody's IPTV line.
 *
 * Every engine is loaded with a dynamic `import()`, so a page that plays an MP4
 * never downloads the HLS library and a page that plays HLS never downloads the
 * transport stream demuxer. Between them those two are over half a megabyte;
 * paying that on every page view to serve the minority that need it is exactly
 * the trade this package exists to avoid.
 */

export interface QualityLevel {
  /** Index to pass back to `setLevel`. */
  index: number;
  height: number | null;
  bitrate: number | null;
  label: string;
}

export interface EngineContext {
  media: HTMLMediaElement;
  src: string;
  /**
   * True on a television. The HLS engine still tunes on it; the transport
   * stream engine no longer does -- it buffers the same way everywhere, since
   * the desktop profile it used to keep separate was the one that stuttered.
   */
  isTv: boolean;
  /**
   * Caller's claim about whether this is a live stream. Engines that can tell
   * for themselves (HLS reads it from the playlist) override it.
   */
  live: boolean;
  /** Terminal: playback has stopped and the reader is being told why. */
  onError: (message: string) => void;
  /** Not terminal. Null clears whatever was showing. */
  onNotice: (message: string | null) => void;
  /** Called once the engine knows something the UI could not assume. */
  onReady?: (info: EngineInfo) => void;
}

export interface EngineInfo {
  live: boolean;
  levels: QualityLevel[];
}

export interface EngineHandle {
  /** Tears the engine down AND releases the connection. */
  destroy: () => void;
  /** Quality ladder, where the engine has one. */
  levels: () => QualityLevel[];
  /** -1 means automatic. */
  setLevel?: (index: number) => void;
  currentLevel?: () => number;
}

export type EngineFactory = (context: EngineContext) => Promise<EngineHandle>;
