import { describe, it, expect, beforeEach } from 'vitest';
import { formatTime, formatTimeParam, parseTimeParam } from '../src/core/time';
import { activeChapter, normalizeChapters } from '../src/core/chapters';
import { isTvBrowser, tvBrowserType, uiProfile } from '../src/core/tv';
import {
  clearPosition,
  loadPosition,
  loadPrefs,
  savePosition,
  savePrefs,
  shouldResume,
} from '../src/core/storage';

describe('time', () => {
  it('formats under and over an hour differently', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(83)).toBe('1:23');
    expect(formatTime(3723)).toBe('1:02:03');
  });

  it('never renders NaN at a reader', () => {
    expect(formatTime(NaN)).toBe('--:--');
    expect(formatTime(Infinity)).toBe('--:--');
    expect(formatTime(-5)).toBe('--:--');
  });

  it('parses every spelling of a share link people actually write', () => {
    expect(parseTimeParam('372')).toBe(372);
    expect(parseTimeParam('372s')).toBe(372);
    expect(parseTimeParam('6m12s')).toBe(372);
    expect(parseTimeParam('1h2m3s')).toBe(3723);
    expect(parseTimeParam('6:12')).toBe(372);
    expect(parseTimeParam('1:02:03')).toBe(3723);
    expect(parseTimeParam('1h')).toBe(3600);
  });

  it('rejects what is not a time rather than guessing', () => {
    expect(parseTimeParam('')).toBeNull();
    expect(parseTimeParam(null)).toBeNull();
    expect(parseTimeParam('abc')).toBeNull();
    expect(parseTimeParam('1:2:3:4')).toBeNull();
    expect(parseTimeParam('3s2m')).toBeNull();
    expect(parseTimeParam('-5')).toBeNull();
  });

  it('round-trips a share parameter', () => {
    expect(parseTimeParam(formatTimeParam(372.418))).toBe(372);
    expect(formatTimeParam(-1)).toBe('0');
  });
});

describe('chapters', () => {
  const chapters = [
    { start: 120, title: 'Setup' },
    { start: 0, title: 'Intro' },
    { start: 600, title: 'Deploy' },
  ];

  it('sorts, closes ranges and places marks', () => {
    const result = normalizeChapters(chapters, 900);
    expect(result.map((c) => c.title)).toEqual(['Intro', 'Setup', 'Deploy']);
    expect(result[0]?.end).toBe(120);
    expect(result[2]?.end).toBe(900);
    expect(result[1]?.position).toBeCloseTo(120 / 900);
  });

  it('drops what cannot be drawn', () => {
    const result = normalizeChapters(
      [
        { start: 10, title: 'Kept' },
        { start: 10, title: 'Duplicate second' },
        { start: 5000, title: 'Past the end' },
        { start: -3, title: 'Before the start' },
        { start: 40, title: '   ' },
        { start: NaN, title: 'Not a number' },
      ],
      900
    );
    expect(result.map((c) => c.title)).toEqual(['Kept']);
  });

  it('returns nothing until the duration is known', () => {
    expect(normalizeChapters(chapters, NaN)).toEqual([]);
    expect(normalizeChapters(chapters, 0)).toEqual([]);
  });

  it('has no chapter before the first mark', () => {
    const result = normalizeChapters([{ start: 120, title: 'Setup' }], 900);
    expect(activeChapter(result, 60)).toBeNull();
    expect(activeChapter(result, 130)?.title).toBe('Setup');
    expect(activeChapter([], 130)).toBeNull();
  });
});

describe('tv detection', () => {
  it('knows the living room', () => {
    expect(tvBrowserType('Mozilla/5.0 (Linux; Android 9; AFTKA) AppleWebKit')).toBe('firetv');
    expect(tvBrowserType('Mozilla/5.0 (Linux; Android 9; Android TV) Chrome')).toBe('androidtv');
    expect(tvBrowserType('Mozilla/5.0 (Web0S; Linux/SmartTV)')).toBe('webos');
    expect(isTvBrowser('Roku/DVP-9.10')).toBe(true);
  });

  it('leaves a desktop and a phone alone', () => {
    expect(tvBrowserType('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')).toBeNull();
    expect(isTvBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari')).toBe(false);
    expect(isTvBrowser('')).toBe(false);
    expect(isTvBrowser(null)).toBe(false);
  });

  it('gives a television longer to reach a control, and a bigger step', () => {
    expect(uiProfile(true).hideAfterMs).toBeGreaterThan(uiProfile(false).hideAfterMs);
    expect(uiProfile(true).seekStep).toBeGreaterThan(uiProfile(false).seekStep);
  });
});

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('remembers preferences across recordings', () => {
    savePrefs({ volume: 0.4, muted: true, rate: 1.5 });
    expect(loadPrefs()).toEqual({ volume: 0.4, muted: true, rate: 1.5 });
  });

  it('falls back to defaults on junk rather than throwing', () => {
    localStorage.setItem('profullstack.player.prefs', 'not json');
    expect(loadPrefs()).toEqual({ volume: 1, muted: false, rate: 1 });
    localStorage.setItem('profullstack.player.prefs', JSON.stringify({ volume: 99, rate: 'fast' }));
    expect(loadPrefs()).toEqual({ volume: 1, muted: false, rate: 1 });
  });

  it('survives storage being unavailable entirely', () => {
    expect(() => savePrefs({ volume: 1, muted: false, rate: 1 }, null)).not.toThrow();
    expect(loadPrefs(null)).toEqual({ volume: 1, muted: false, rate: 1 });
    expect(loadPosition('x', null)).toBeNull();
    expect(() => savePosition('x', { t: 5, d: 10 }, null)).not.toThrow();
    expect(() => clearPosition('x', null)).not.toThrow();
  });

  it('keeps positions per recording and can clear one', () => {
    savePosition('a', { t: 30, d: 600 });
    savePosition('b', { t: 90, d: 600 });
    expect(loadPosition('a')?.t).toBe(30);
    clearPosition('a');
    expect(loadPosition('a')).toBeNull();
    expect(loadPosition('b')?.t).toBe(90);
  });

  it('evicts the least recently touched once it is full', () => {
    let clock = 1000;
    for (let i = 0; i < 70; i += 1) {
      clock += 1000;
      savePosition(`id-${String(i)}`, { t: 10, d: 600 }, undefined, () => clock);
    }
    // The 10 oldest are gone; the newest are not.
    expect(loadPosition('id-0')).toBeNull();
    expect(loadPosition('id-9')).toBeNull();
    expect(loadPosition('id-10')?.t).toBe(10);
    expect(loadPosition('id-69')?.t).toBe(10);
  });

  describe('shouldResume', () => {
    it('resumes somewhere worth resuming', () => {
      expect(shouldResume({ t: 300, d: 600, at: 0 }, 600)).toBe(true);
    });

    it('does not resume a few seconds in, or a few seconds from the end', () => {
      expect(shouldResume({ t: 4, d: 600, at: 0 }, 600)).toBe(false);
      expect(shouldResume({ t: 595, d: 600, at: 0 }, 600)).toBe(false);
    });

    it('refuses an offset saved against a different cut of the file', () => {
      expect(shouldResume({ t: 300, d: 600, at: 0 }, 900)).toBe(false);
    });

    it('has nothing to say without a position or a duration', () => {
      expect(shouldResume(null, 600)).toBe(false);
      expect(shouldResume({ t: 300, d: 600, at: 0 }, NaN)).toBe(false);
    });
  });
});
