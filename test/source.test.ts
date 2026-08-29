import { describe, it, expect } from 'vitest';
import { capabilitiesOf, chooseEngine, detectKind, isAudioKind } from '../src/core/source';
import type { Capabilities } from '../src/core/source';

const CHROME: Capabilities = { mediaSource: true, nativeHls: false };
const SAFARI: Capabilities = { mediaSource: true, nativeHls: true };
/** An old or locked-down browser: no MSE, no native HLS. */
const NEITHER: Capabilities = { mediaSource: false, nativeHls: false };
/** iOS: native HLS, and no MediaSource for any library to attach to. */
const IOS: Capabilities = { mediaSource: false, nativeHls: true };
/** Chrome, which claims native HLS via canPlayType and cannot deliver it. */
const LYING_CHROME: Capabilities = { mediaSource: true, nativeHls: true };

describe('detectKind', () => {
  it('reads the ordinary extensions', () => {
    expect(detectKind({ src: 'https://x.test/a.mp4' })).toBe('mp4');
    expect(detectKind({ src: 'https://x.test/a.webm' })).toBe('mp4');
    expect(detectKind({ src: 'https://x.test/a.m3u8' })).toBe('hls');
    expect(detectKind({ src: 'https://x.test/a.ts' })).toBe('mpegts');
    expect(detectKind({ src: 'https://x.test/a.mp3' })).toBe('audio');
    expect(detectKind({ src: 'https://x.test/a.m4a' })).toBe('audio');
  });

  it('does not read the query string as the file name', () => {
    // A signed URL routinely ends in something that looks like a filename.
    expect(
      detectKind({ src: 'https://x.test/stream.m3u8?response-content-disposition=x.mp4' })
    ).toBe('hls');
    expect(detectKind({ src: 'https://x.test/a.mp4?token=abc#t=10' })).toBe('mp4');
  });

  it('believes a declared type over the URL', () => {
    expect(detectKind({ src: 'https://x.test/channel', mimeType: 'video/mp2t' })).toBe('mpegts');
    expect(detectKind({ src: 'https://x.test/a.mp4', mimeType: 'application/x-mpegURL' })).toBe(
      'hls'
    );
    expect(detectKind({ src: 'https://x.test/x', mimeType: 'audio/mpeg' })).toBe('audio');
  });

  it('takes the caller at their word when told', () => {
    expect(detectKind({ src: 'https://x.test/whatever', kind: 'hls' })).toBe('hls');
  });

  it('calls an unmarked URL unknown, which plays natively', () => {
    expect(detectKind({ src: 'https://x.test/watch/123' })).toBe('unknown');
    expect(chooseEngine({ src: 'https://x.test/watch/123' }, CHROME).engine).toBe('native');
  });

  it('survives a src that is not a URL at all', () => {
    expect(detectKind({ src: 'blob:nonsense' })).toBe('unknown');
    expect(detectKind({ src: '' })).toBe('unknown');
  });
});

describe('chooseEngine', () => {
  it('plays MP4 and audio natively everywhere', () => {
    for (const caps of [CHROME, SAFARI, IOS, NEITHER]) {
      expect(chooseEngine({ src: 'a.mp4' }, caps).engine).toBe('native');
      expect(chooseEngine({ src: 'a.mp3' }, caps).engine).toBe('native');
    }
  });

  // Regression, caught in a real headless Chrome: it answers "maybe" to
  // canPlayType('application/vnd.apple.mpegurl') and then plays nothing. So
  // Media Source wins wherever it exists, and a native claim is only ever a
  // fallback -- never a reason to skip hls.js.
  it('uses hls.js wherever Media Source exists, whatever the browser claims', () => {
    expect(chooseEngine({ src: 'a.m3u8' }, CHROME).engine).toBe('hls');
    expect(chooseEngine({ src: 'a.m3u8' }, SAFARI).engine).toBe('hls');
    expect(chooseEngine({ src: 'a.m3u8' }, LYING_CHROME).engine).toBe('hls');
  });

  it('falls back to native HLS only where there is no Media Source, which is iOS', () => {
    expect(chooseEngine({ src: 'a.m3u8' }, IOS).engine).toBe('native');
  });

  it('says so plainly when HLS is impossible here', () => {
    const choice = chooseEngine({ src: 'a.m3u8' }, NEITHER);
    expect(choice.unplayable).toMatch(/cannot play HLS/i);
  });

  it('gives transport streams to the demuxer, and admits when there is none', () => {
    expect(chooseEngine({ src: 'a.ts' }, CHROME).engine).toBe('mpegts');
    // iOS has native HLS but no MediaSource, so a raw .ts is genuinely hopeless.
    expect(chooseEngine({ src: 'a.ts' }, IOS).unplayable).toMatch(/transport streams/i);
  });

  it('reports the kind alongside the engine', () => {
    expect(chooseEngine({ src: 'a.mp3' }, CHROME).kind).toBe('audio');
    expect(isAudioKind('audio')).toBe(true);
    expect(isAudioKind('mp4')).toBe(false);
  });
});

describe('capabilitiesOf', () => {
  it('reports what this environment can do without throwing', () => {
    const caps = capabilitiesOf();
    expect(typeof caps.mediaSource).toBe('boolean');
    expect(typeof caps.nativeHls).toBe('boolean');
  });

  it('treats a probe that throws as a no', () => {
    const hostile = {
      canPlayType: () => {
        throw new Error('nope');
      },
    } as unknown as HTMLMediaElement;
    expect(capabilitiesOf({}, hostile).nativeHls).toBe(false);
  });

  it('sees native HLS when the element admits to it', () => {
    const safari = { canPlayType: () => 'maybe' } as unknown as HTMLMediaElement;
    expect(capabilitiesOf({ MediaSource: {} }, safari)).toEqual({
      mediaSource: true,
      nativeHls: true,
    });
  });
});
