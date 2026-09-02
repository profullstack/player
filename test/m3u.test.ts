import { describe, it, expect } from 'vitest';
import { MAX_CHANNELS, createM3uParser, entryKind, parseM3u, parseM3uStream } from '../src/m3u';

/**
 * The parsing cases are ported knowledge, not invented coverage: each one is a
 * provider list that was read wrongly in production on one of the two sites.
 * The streaming cases below them are new, and they are all about the seams --
 * a chunk boundary is free to land in the middle of a line, a CRLF or a
 * multi-byte character, and each of those has its own way of losing an entry.
 */

/** Feed a string as bytes, in fixed-size pieces, as a network body would arrive. */
async function* inChunks(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

const LIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="bbc1" group-title="UK | Entertainment",BBC One HD',
  'http://example.test/live/u/p/1.ts',
].join('\n');

describe('parseM3u', () => {
  it('reads the title, the group and the URL', () => {
    expect(parseM3u(LIST)).toEqual([
      {
        title: 'BBC One HD',
        group: 'UK | Entertainment',
        url: 'http://example.test/live/u/p/1.ts',
        kind: 'live',
      },
    ]);
  });

  it('does not let a comma inside an attribute eat the title', () => {
    // Splitting on the FIRST comma produced a title of ` Action",Die Hard` for
    // every channel whose group contained one, and provider groups routinely do.
    const [ch] = parseM3u(
      ['#EXTINF:-1 group-title="Movies, Action",Die Hard', 'https://example.test/vod/1.mp4'].join(
        '\n'
      )
    );
    expect(ch?.title).toBe('Die Hard');
    expect(ch?.group).toBe('Movies, Action');
  });

  it('applies #EXTGRP until it is changed', () => {
    const list = [
      '#EXTGRP:Documentary',
      '#EXTINF:-1,Planet Earth',
      'https://example.test/1.ts',
      '#EXTINF:-1,Blue Planet',
      'https://example.test/2.ts',
      '#EXTGRP:Kids',
      '#EXTINF:-1,Bluey',
      'https://example.test/3.ts',
    ].join('\n');
    expect(parseM3u(list).map((c) => [c.title, c.group])).toEqual([
      ['Planet Earth', 'Documentary'],
      ['Blue Planet', 'Documentary'],
      ['Bluey', 'Kids'],
    ]);
  });

  it('lets an explicit group-title beat an inherited #EXTGRP', () => {
    const list = [
      '#EXTGRP:Kids',
      '#EXTINF:-1 group-title="Horror",The Thing',
      'https://x.test/1.ts',
    ].join('\n');
    expect(parseM3u(list)[0]?.group).toBe('Horror');
  });

  it('skips an entry with no usable URL rather than guessing', () => {
    const list = [
      '#EXTINF:-1,Broken',
      'rtmp://example.test/nope',
      '#EXTINF:-1,Fine',
      'https://ok.test/x.ts',
    ].join('\n');
    expect(parseM3u(list).map((c) => c.title)).toEqual(['Fine']);
  });

  it('steps over the directives providers put between an entry and its URL', () => {
    const list = [
      '#EXTINF:-1,With options',
      '#EXTVLCOPT:network-caching=1000',
      '',
      'https://ok.test/x.ts',
    ].join('\n');
    expect(parseM3u(list).map((c) => c.title)).toEqual(['With options']);
  });

  it('falls back to tvg-name when the display title is empty', () => {
    const list = ['#EXTINF:-1 tvg-name="Named",', 'https://ok.test/x.ts'].join('\n');
    expect(parseM3u(list)[0]?.title).toBe('Named');
  });

  it('keeps the first of two #EXTINF lines sharing one URL', () => {
    // The whole-file parser skipped the second as a directive while looking ahead
    // for the URL, so the first one claimed it. Preserved deliberately.
    const list = ['#EXTINF:-1,First', '#EXTINF:-1,Second', 'https://ok.test/x.ts'].join('\n');
    expect(parseM3u(list).map((c) => c.title)).toEqual(['First']);
  });

  it('reads an entry with no trailing newline', () => {
    expect(parseM3u('#EXTINF:-1,Last\nhttps://ok.test/x.ts')).toHaveLength(1);
  });

  it('stops at max', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      [`#EXTINF:-1,Ch ${i}`, `https://ok.test/${i}.ts`].join('\n')
    ).join('\n');
    expect(parseM3u(many)).toHaveLength(50);
    expect(parseM3u(many, { max: 10 })).toHaveLength(10);
  });

  it('defaults to a ceiling that does not silently truncate a real catalogue', () => {
    expect(MAX_CHANNELS).toBe(300_000);
  });
});

describe('entryKind', () => {
  it('reads the URL before the group, because paths are the consistent half', () => {
    expect(entryKind({ url: 'https://x.test/series/1.mkv' })).toBe('series');
    expect(entryKind({ url: 'https://x.test/movie/1.mkv' })).toBe('vod');
    expect(entryKind({ url: 'https://x.test/live/1.ts' })).toBe('live');
    expect(entryKind({ url: 'https://x.test/x.mp4' })).toBe('vod');
  });

  it('falls back to the group when the URL says nothing', () => {
    expect(entryKind({ url: 'https://x.test/a/b', group: 'VOD | Films' })).toBe('vod');
    expect(entryKind({ url: 'https://x.test/a/b', group: 'TV Shows' })).toBe('series');
    expect(entryKind({ url: 'https://x.test/a/b', group: 'News' })).toBe('live');
  });
});

describe('parseM3uStream', () => {
  const big = Array.from({ length: 200 }, (_, i) =>
    [
      `#EXTINF:-1 group-title="Grp ${i % 7}",Channel ${i}`,
      `https://example.test/live/${i}.ts`,
    ].join('\n')
  ).join('\n');

  it('agrees with the whole-file parser, at every chunk size', async () => {
    // The point of the exercise: streaming must not change a single entry. Sizes
    // chosen to land boundaries inside lines, attributes and URLs alike.
    const expected = parseM3u(big);
    for (const size of [1, 2, 3, 7, 13, 64, 1024, 1_000_000]) {
      const got = await parseM3uStream(inChunks(big, size));
      expect(got.entries, `chunk size ${size}`).toEqual(expected);
    }
  });

  it('survives a CRLF split across a chunk boundary', async () => {
    const crlf = LIST.replace(/\n/g, '\r\n');
    // Cut the stream precisely between the \r and the \n.
    const at = crlf.indexOf('\r\n', crlf.indexOf('#EXTINF')) + 1;
    const bytes = new TextEncoder().encode(crlf);
    async function* split() {
      yield bytes.slice(0, at);
      yield bytes.slice(at);
    }
    expect((await parseM3uStream(split())).entries).toEqual(parseM3u(crlf));
  });

  it('survives a multi-byte character split across a chunk boundary', async () => {
    const list = ['#EXTINF:-1,Ürdü Kanalı — 4K', 'https://ok.test/x.ts'].join('\n');
    const bytes = new TextEncoder().encode(list);
    // Every possible cut point, so no split of the two- and three-byte sequences
    // is left untried.
    for (let at = 1; at < bytes.length; at++) {
      async function* split() {
        yield bytes.slice(0, at);
        yield bytes.slice(at);
      }
      const got = await parseM3uStream(split());
      expect(
        got.entries.map((c) => c.title),
        `cut at ${at}`
      ).toEqual(['Ürdü Kanalı — 4K']);
    }
  });

  it('hands every chunk to onChunk, in order and unaltered', async () => {
    // This is the file's hash. A digest over most of a file is worth nothing, so
    // "every chunk" is the whole property.
    const seen: number[] = [];
    await parseM3uStream(inChunks(big, 64), {
      onChunk: (c) => {
        seen.push(...(c as Uint8Array));
      },
    });
    // Decoded rather than compared byte for byte: identical content is the claim,
    // and a decoded string says so where two typed arrays only agree.
    expect(new TextDecoder().decode(new Uint8Array(seen))).toBe(big);
  });

  it('keeps hashing past max, so a truncated list still gets a whole digest', async () => {
    const seen: number[] = [];
    const got = await parseM3uStream(inChunks(big, 64), {
      max: 5,
      onChunk: (c) => {
        seen.push(...(c as Uint8Array));
      },
    });
    expect(got.entries).toHaveLength(5);
    expect(got.truncated).toBe(true);
    // Read to the end regardless.
    expect(seen.length).toBe(new TextEncoder().encode(big).byteLength);
    expect(got.bytes).toBe(seen.length);
  });

  it('reports bytes, which is what a caller schedules the next poll from', async () => {
    const got = await parseM3uStream(inChunks(big, 999));
    expect(got.bytes).toBe(new TextEncoder().encode(big).byteLength);
    expect(got.truncated).toBe(false);
  });

  it('accepts string chunks as well as bytes', async () => {
    async function* strings() {
      yield '#EXTINF:-1,A\nhttps://ok.test/';
      yield 'a.ts\n#EXTINF:-1,B\nhttps://ok.test/b.ts';
    }
    const got = await parseM3uStream(strings());
    expect(got.entries.map((c) => c.title)).toEqual(['A', 'B']);
  });

  it('lets the caller abort mid-stream by throwing from onChunk', async () => {
    // Where a size ceiling belongs: the policy and the wording are the caller's.
    let read = 0;
    await expect(
      parseM3uStream(inChunks(big, 32), {
        onChunk: () => {
          read += 1;
          if (read > 3) throw new Error('that list is larger than we store');
        },
      })
    ).rejects.toThrow(/larger than we store/);
    expect(read).toBe(4);
  });

  it('handles an empty body', async () => {
    async function* nothing(): AsyncGenerator<Uint8Array> {}
    const got = await parseM3uStream(nothing());
    expect(got.entries).toEqual([]);
    expect(got.bytes).toBe(0);
  });
});

describe('createM3uParser', () => {
  it('says when it is full, so a caller can stop paying to decode', () => {
    const p = createM3uParser({ max: 1 });
    expect(p.push('#EXTINF:-1,One')).toBe(true);
    expect(p.push('https://ok.test/1.ts')).toBe(true);
    expect(p.full).toBe(true);
    expect(p.push('#EXTINF:-1,Two')).toBe(false);
    expect(p.entries).toHaveLength(1);
  });
});
