import { describe, it, expect } from 'vitest';
import { codecName, mseCandidates, unplayableReason } from '../src/engines/codecs';

/**
 * These cases are the ported knowledge, not invented coverage: each one is a
 * channel that failed in production on tipoffwatch because the check asked
 * about the wrong thing.
 */
describe('mseCandidates', () => {
  it('collapses any AAC object type to LC, which is what the remuxer emits', () => {
    // A provider announcing mp4a.40.1 (Main) over ordinary LC payload is the
    // single most common mis-signalling there is; asking about .1 tore down
    // streams that played.
    expect(mseCandidates('audio', 'mp4a.40.1')).toEqual(['audio/mp4; codecs="mp4a.40.2"']);
    expect(mseCandidates('audio', 'mp4a.40.5')).toEqual(['audio/mp4; codecs="mp4a.40.2"']);
  });

  it('asks about MP3 as a container, not a codec', () => {
    // mpegts.js emits bare audio/mpeg on everything but Firefox; Chrome says yes
    // to that and no to the codec-shaped question.
    expect(mseCandidates('audio', 'mp3')).toEqual(['audio/mpeg', 'audio/mp4; codecs="mp3"']);
  });

  it('offers both spellings of Opus, because Safari is fussy', () => {
    expect(mseCandidates('audio', 'opus')).toEqual([
      'audio/mp4; codecs="opus"',
      'audio/mp4; codecs="Opus"',
    ]);
  });

  it('passes everything else through untouched', () => {
    expect(mseCandidates('video', 'hvc1.1.6.L93.B0')).toEqual([
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
    ]);
    expect(mseCandidates('audio', 'ac-3')).toEqual(['audio/mp4; codecs="ac-3"']);
  });

  it('has nothing to ask when there is no codec', () => {
    expect(mseCandidates('audio', undefined)).toEqual([]);
  });
});

describe('codecName', () => {
  it('names codecs the way a reader would', () => {
    expect(codecName('hvc1.1.6.L93.B0')).toBe('H.265');
    expect(codecName('ec-3')).toBe('Dolby Digital Plus audio');
    expect(codecName('mp4a.40.2')).toBe('AAC audio');
    expect(codecName('mp3')).toBe('MP3 audio');
  });

  it('matches MPEG-2 layer II before the AAC rule catches it', () => {
    expect(codecName('mp4a.69')).toBe('MP2 audio');
    expect(codecName('mp4a.6b')).toBe('MP2 audio');
  });

  it('falls back to the raw string rather than inventing a name', () => {
    expect(codecName('something.new')).toBe('something.new');
    expect(codecName(null)).toBeNull();
  });
});

describe('unplayableReason', () => {
  const supports = (list: string[]) => (type: string) => list.includes(type);

  it('says nothing when the browser can decode both tracks', () => {
    const yes = supports(['video/mp4; codecs="avc1.42E01E"', 'audio/mp4; codecs="mp4a.40.2"']);
    expect(
      unplayableReason({ videoCodec: 'avc1.42E01E', audioCodec: 'mp4a.40.2' }, yes)
    ).toBeNull();
  });

  it('names the video codec a browser cannot decode', () => {
    const reason = unplayableReason(
      { videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'mp4a.40.2' },
      supports(['audio/mp4; codecs="mp4a.40.2"'])
    );
    expect(reason).toContain('H.265');
  });

  it('joins two failures into one sentence', () => {
    const reason = unplayableReason({ videoCodec: 'hvc1.1', audioCodec: 'ec-3' }, supports([]));
    expect(reason).toBe(
      'This stream is H.265 and Dolby Digital Plus audio, which this browser cannot decode.'
    );
  });

  it('lets the host name the thing its reader clicked', () => {
    // genrewatch and tipoffwatch say "channel"; a recording is a "stream".
    expect(unplayableReason({ videoCodec: 'hvc1.1' }, supports([]), '', 'channel')).toBe(
      'This channel is H.265, which this browser cannot decode.'
    );
  });

  it('appends the host site’s advice when given some', () => {
    const reason = unplayableReason({ videoCodec: 'hvc1.1' }, supports([]), 'Try VLC.');
    expect(reason).toBe('This stream is H.265, which this browser cannot decode. Try VLC.');
  });

  it('passes an AAC Main stream that would be handed over as LC', () => {
    // The regression that mattered: declared .1, delivered .2.
    expect(
      unplayableReason({ audioCodec: 'mp4a.40.1' }, supports(['audio/mp4; codecs="mp4a.40.2"']))
    ).toBeNull();
  });

  it('passes an MP3 stream a browser takes as audio/mpeg', () => {
    expect(unplayableReason({ audioCodec: 'mp3' }, supports(['audio/mpeg']))).toBeNull();
  });

  it('treats a browser that throws on a codec string as a no', () => {
    const reason = unplayableReason({ videoCodec: 'hvc1.1' }, () => {
      throw new Error('bad string');
    });
    expect(reason).toContain('H.265');
  });

  it('has nothing to say without media info', () => {
    expect(unplayableReason(null, supports([]))).toBeNull();
  });
});
