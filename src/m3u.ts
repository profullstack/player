/**
 * The m3u parser, with no player attached.
 *
 * genrewatch and tipoffwatch each carry a copy of this, for the same reason they
 * each carried a copy of the codec table: the two sites are ports of one another
 * and the playlist a reader hands over is read identically by both. Every rule
 * below was written against a real provider list.
 *
 * A subpath rather than the root export, and deliberately runtime-neutral: no
 * DOM, no `node:` imports, no `Buffer`. This runs on a Bun server ingesting a
 * reader's catalogue into Postgres, which is the opposite end of the stack from
 * the rest of this package -- so it must not drag a player, an engine or a
 * dynamic import in behind it.
 *
 * ## Why the streaming form exists
 *
 * `parseM3u(text)` needs the whole file as one string, and the caller needed it
 * as one string anyway to hash it. On a 300,000-entry catalogue that is a
 * several-hundred-megabyte string, a second copy to hash it, and an array with
 * one string per line on top -- which pushed the site that did it into a garbage
 * collection spiral that pegged three cores and stopped it accepting TCP
 * connections at all, every five minutes, for as long as it was left running.
 *
 * {@link parseM3uStream} never holds the file. It consumes chunks, hands each one
 * straight back to the caller for hashing, and keeps only the entries it has
 * decided to keep.
 */

/**
 * Hard ceiling on entries taken from one list.
 *
 * Was 20,000 and silently truncating: a reader importing a 300,000-entry
 * catalogue got 20,000 rows, no error, and no way to tell which were missing.
 */
export const MAX_CHANNELS = 300_000;

/** What an entry is, which decides how the page offers it and how it is played. */
export type EntryKind = 'live' | 'vod' | 'series';

export interface M3uEntry {
  title: string;
  group: string | null;
  url: string;
  kind: EntryKind;
}

export interface ParseOptions {
  /** Stop after this many entries. */
  max?: number;
}

/**
 * Pull `key="value"` pairs out of the attribute block of an #EXTINF line.
 *
 * Only the block BEFORE the last comma is scanned. Attribute values routinely
 * contain commas (`group-title="Movies, Drama"`), so splitting the line on the
 * first comma and calling the rest the title -- the obvious implementation --
 * truncates the title of every channel whose group contains one.
 */
function parseAttrs(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of head.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    const [, key, value] = m;
    // Both groups are mandatory in the pattern, so this is only ever appeasing
    // noUncheckedIndexedAccess -- but it costs nothing and the alternative is a
    // non-null assertion in the one function every entry passes through.
    if (key === undefined || value === undefined) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Live channel, film, or episode of something.
 *
 * Read from the URL first because providers are consistent about their path
 * shapes and wildly inconsistent about their group names. The group is the
 * fallback, not the other way round.
 *
 * This has to be worked out at parse time and stored: both sites seal the URL at
 * rest, so asking later would mean inspecting an encrypted blob -- which is
 * exactly what happened once, found no "/movie/" in a base64 string, and
 * answered 'live' for every entry on every list.
 */
export function entryKind({
  url,
  group,
}: { url?: string | null; group?: string | null } = {}): EntryKind {
  const u = String(url ?? '').toLowerCase();
  if (/\/series\//.test(u)) return 'series';
  if (/\/(movie|movies|vod)\//.test(u)) return 'vod';
  if (/\.(mkv|mp4|avi|m4v)(\?|$)/.test(u)) return 'vod';
  if (/\/live\//.test(u) || /\.(ts|m3u8)(\?|$)/.test(u)) return 'live';

  // Nothing in the URL says. Fall back to the group, which usually does.
  const g = String(group ?? '').toLowerCase();
  if (/\b(vod|on ?demand|movies?|films?)\b/.test(g)) return 'vod';
  if (/\b(series|shows?|tv ?shows?)\b/.test(g)) return 'series';
  return 'live';
}

export interface M3uParser {
  /**
   * Feed one line. Returns false once the parser is full, which is the caller's
   * signal that further lines are wasted work -- not that it may stop reading,
   * because the bytes behind them usually still have to be hashed.
   */
  push(line: string): boolean;
  /** Everything kept so far. The same array throughout; not copied per push. */
  readonly entries: M3uEntry[];
  /** True once `max` entries have been kept. */
  readonly full: boolean;
}

/**
 * A line-at-a-time m3u parser.
 *
 * The whole-file version used to look ahead from each `#EXTINF` for its URL,
 * which is why it needed an array of every line. The lookahead is really a
 * two-state machine -- "waiting for an #EXTINF" and "holding one, waiting for its
 * URL" -- and written that way it needs no more than the line in front of it.
 *
 * Only `#EXTINF` followed by a URL counts. Everything else (`#EXTM3U`,
 * `#EXT-X-SESSION-DATA`, comments, blank lines) is skipped rather than guessed
 * at, because a playlist that half-parses is worse than one that does not.
 */
export function createM3uParser({ max = MAX_CHANNELS }: ParseOptions = {}): M3uParser {
  const entries: M3uEntry[] = [];

  /** `#EXTGRP:` is the other way providers state a group; it applies until changed. */
  let currentGroup: string | null = null;
  /** The #EXTINF we are holding while we look for the URL that belongs to it. */
  let pending: { name: string; attrGroup: string | null } | null = null;

  const parser: M3uParser = {
    get entries() {
      return entries;
    },
    get full() {
      return entries.length >= max;
    },
    push(raw: string): boolean {
      if (entries.length >= max) return false;
      const line = raw.trim();

      if (line.startsWith('#EXTGRP:')) {
        const g = line.slice('#EXTGRP:'.length).trim() || null;
        /*
         * An empty #EXTGRP clears the group, EXCEPT while an #EXTINF is waiting
         * for its URL -- there it leaves the previous one standing. That is not a
         * nicety; it is what the whole-file version did, because its inner
         * lookahead loop used `|| currentGroup` where the outer loop did not, and
         * a reader's genre index is built from these.
         */
        currentGroup = pending ? (g ?? currentGroup) : g;
        return true;
      }

      if (pending) {
        // Blank lines and any other directive sit between an #EXTINF and its URL
        // on real lists -- #EXTVLCOPT especially. A second #EXTINF lands here too
        // and is skipped as a directive, so of two in a row the first one wins.
        if (!line || line.startsWith('#')) return true;

        const url = line;
        const { name, attrGroup } = pending;
        pending = null;
        // A relative or non-http URL is not something either site can seal, proxy
        // or hand to a player, so it is dropped along with its #EXTINF.
        if (!/^https?:\/\//i.test(url)) return true;
        if (!name) return true;

        const group = attrGroup || currentGroup || null;
        entries.push({ title: name, group, url, kind: entryKind({ url, group }) });
        return true;
      }

      if (!line.startsWith('#EXTINF')) return true;

      /*
       * The title is everything after the LAST comma, not the first: the
       * attribute block before it usually contains commas of its own.
       */
      const comma = line.lastIndexOf(',');
      if (comma < 0) return true;
      const attrs = parseAttrs(line.slice(0, comma));
      // `tvg-name` is the fallback because a handful of providers ship an empty
      // display title and put the real one in the attributes.
      const name = line.slice(comma + 1).trim() || attrs['tvg-name'] || '';
      // Held even when the name is empty, so the URL line that follows is
      // consumed as this entry's rather than mistaken for the next one's.
      pending = { name, attrGroup: attrs['group-title'] || null };
      return true;
    },
  };

  return parser;
}

/**
 * Split an M3U held in memory into entries.
 *
 * Kept for callers that genuinely have the whole thing already -- a paste into a
 * form, a fixture in a test. Anything reading from a network response wants
 * {@link parseM3uStream} instead: this signature cannot avoid holding the file,
 * and on a real catalogue that is the problem rather than the parsing.
 */
export function parseM3u(text: string, opts: ParseOptions = {}): M3uEntry[] {
  const parser = createM3uParser(opts);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!parser.push(line)) break;
  }
  return parser.entries;
}

export interface StreamOptions extends ParseOptions {
  /**
   * Called with every chunk, in order, before it is decoded.
   *
   * This is how the file gets hashed without anyone holding it: the caller feeds
   * its own digest and never sees a whole-file string. Throwing from here aborts
   * the parse and cancels the underlying stream, which is where a size ceiling
   * belongs -- the policy and its error message are the caller's, not ours.
   */
  onChunk?: (chunk: Uint8Array | string) => void;
}

export interface StreamResult {
  entries: M3uEntry[];
  /** Bytes seen. String chunks are counted by length, having no encoding here. */
  bytes: number;
  /** True if `max` was reached and later entries were dropped. */
  truncated: boolean;
}

/**
 * Parse an m3u as it arrives, holding neither the file nor its lines.
 *
 * Pass a fetch body directly: `parseM3uStream(res.body, { onChunk })`. Chunks may
 * be bytes or strings; bytes are decoded with a streaming TextDecoder so a
 * multi-byte character split across a chunk boundary survives, and a `\r\n` split
 * the same way is handled by carrying the tail of each chunk into the next.
 *
 * The stream is always read to the end, even once `max` entries have been kept,
 * because `onChunk` is usually a hash and a hash of most of a file is worth
 * nothing. Past that point the decoding and splitting stop, so the tail of an
 * oversized list costs only the read.
 */
export async function parseM3uStream(
  chunks: AsyncIterable<Uint8Array | string>,
  { max = MAX_CHANNELS, onChunk }: StreamOptions = {}
): Promise<StreamResult> {
  const parser = createM3uParser({ max });
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let bytes = 0;
  let truncated = false;

  for await (const chunk of chunks) {
    bytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    onChunk?.(chunk);

    // Full already: keep reading so the caller's digest stays whole, but stop
    // paying for decode and split.
    if (truncated) continue;

    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (!text) continue;

    const parts = (carry + text).split(/\r?\n/);
    // The last piece may be half a line; it is only complete at end of stream.
    carry = parts.pop() ?? '';
    for (const line of parts) {
      if (!parser.push(line)) {
        truncated = true;
        carry = '';
        break;
      }
    }
  }

  if (!truncated) {
    // Flush whatever the decoder was holding, then the final unterminated line --
    // a file whose last entry has no trailing newline is ordinary.
    const tail = carry + decoder.decode();
    if (tail) parser.push(tail);
  }

  return { entries: parser.entries, bytes, truncated: truncated || parser.full };
}
