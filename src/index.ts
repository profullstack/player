/**
 * @profullstack/player
 *
 * One player for every source these sites serve.
 *
 * ```js
 * import { createPlayer } from '@profullstack/player';
 * import '@profullstack/player/player.css';
 *
 * const player = createPlayer(document.getElementById('stage'), {
 *   src: 'https://example.com/talk.mp4',
 *   mediaId: 'talk-42',
 * });
 * ```
 *
 * The source decides the rest: an `.mp4` plays natively, an `.m3u8` takes the
 * browser's own HLS on Safari and hls.js everywhere else, a `.ts` gets the
 * transport stream demuxer, and an `.mp3` gets a compact audio bar with no
 * stage. Libraries are loaded only when a source needs them.
 */

export { createPlayer, type PlayerHandle, type PlayerOptions } from './core/player';
export { formatTime, formatTimeParam, parseTimeParam } from './core/time';
export {
  activeChapter,
  normalizeChapters,
  type Chapter,
  type NormalizedChapter,
} from './core/chapters';
export { isTvBrowser, tvBrowserType, uiProfile, type UiProfile } from './core/tv';
export {
  capabilitiesOf,
  chooseEngine,
  detectKind,
  isAudioKind,
  type Capabilities,
  type EngineChoice,
  type EngineName,
  type SourceInput,
  type SourceKind,
} from './core/source';
export {
  clearPosition,
  loadPosition,
  loadPrefs,
  savePosition,
  savePrefs,
  shouldResume,
  type PlayerPrefs,
  type SavedPosition,
} from './core/storage';
export { codecName, mseCandidates, unplayableReason } from './engines/codecs';
export type {
  EngineContext,
  EngineFactory,
  EngineHandle,
  EngineInfo,
  QualityLevel,
} from './engines/types';
