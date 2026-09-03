# @profullstack/player

One web player for every source we serve — MP4, HLS, MPEG-2 transport streams and audio — with one control bar, on desktop, mobile, PWA and television.

It exists because we had two players and neither could play what the other did. PairUX handed every URL straight to the browser, so it played MP4 and nothing else. tipoffwatch and genrewatch always built an mpegts.js demuxer, so they played IPTV channels and nothing else — an HLS playlist was answered with `415, 'that channel is an HLS playlist'`. Both were right about their own content and wrong about everything else.

## Install

```sh
pnpm add @profullstack/player
```

## Use

```js
import { createPlayer } from '@profullstack/player';
import '@profullstack/player/player.css';

const player = createPlayer(document.getElementById('stage'), {
  src: 'https://example.com/talk.mp4',
  mediaId: 'talk-42', // what a resume position is filed under; omit to remember nothing
});

// later
player.destroy();
```

React:

```jsx
import { Player } from '@profullstack/player/react';
import '@profullstack/player/player.css';

<Player src={url} mediaId={`session:${code}`} className="aspect-video rounded-2xl" />;
```

The source decides the rest.

## What plays, and how

| Source                                  | Engine                   | Notes                                                                 |
| --------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `.mp4`, `.webm`, `.mov`                 | native                   | The browser decodes it; no library is loaded.                         |
| `.mp3`, `.m4a`, `.aac`, `.wav`, `.flac` | native                   | Compact audio bar, no stage.                                          |
| `.m3u8`                                 | hls.js, or native on iOS | Quality ladder, live-playlist detection.                              |
| `.ts`, `.m2ts`                          | mpegts.js                | Stall-restart, TV buffering profiles, codec diagnosis.                |
| anything else                           | native                   | An unmarked URL is assumed progressive, which is what one usually is. |

Detection reads a declared `mimeType` first, then the URL **path** — never the query string, because a signed URL routinely ends `?response-content-disposition=...mp4`. Pass `kind` to skip it entirely.

**Engines are loaded on demand.** A page that plays an MP4 never downloads hls.js or mpegts.js; between them they are over half a megabyte. Verified: an MP4 page fetches only the native chunk.

### The HLS ordering, which is not the obvious one

Media Source first, native second — the opposite of what you would write.

`canPlayType('application/vnd.apple.mpegurl')` **lies**. Chrome answers `"maybe"` on builds that cannot play a playlist at all; it is a claim about a MIME type, not about a decoder. Trusting it sends every Chrome user down a path that silently plays nothing. This was caught here exactly that way — a headless Chrome claimed native HLS, was handed the stream, and the quality ladder came back empty because no hls.js had ever loaded.

So hls.js runs wherever Media Source exists (Chrome, Firefox, Edge, Android, desktop Safari). Native is the fallback for iOS, which has no MediaSource at all and is the one browser that genuinely does HLS properly.

## Three shapes, decided by the source

- **VOD** — scrub with buffered range, ±10s, speed, resume, chapters, `?t=` timestamps, quality.
- **Live** — none of those, because each is a lie about a stream with no end: nothing to scrub towards, no position worth remembering, no speed but 1. A LIVE badge instead. HLS flips into this from the playlist, after the bar has already been drawn.
- **Audio** — a compact bar in normal flow: no stage, no fullscreen, no picture-in-picture. Still a full transport. Inferred from an `.mp3`-shaped URL or from an `<audio>` element passed as `media`; pass `audio: true` when the host knows better — a radio station is an `.m3u8` with no picture in it, and would otherwise get a black stage and a LIVE badge.

## Everything else it does

- **Keyboard**: space/k, ← →, j/l, ↑ ↓, m, f, p, 0–9, Home/End, `<` `>`.
- **Televisions**: Fire TV, Android TV, Tizen, webOS, Roku and the rest are detected from one list, kept identical to the one genrewatch and tipoffwatch already use so a device is a TV in all of them or none. Controls grow, the auto-hide slows, the seek step doubles, and what a D-pad cannot use is dropped.
- **Remembers** volume, mute and speed across sources, and a position per `mediaId` (60 of them, least-recently-touched evicted). Every storage access is guarded — some browsers throw on merely touching `localStorage`.
- **Explains failures.** A blocked media load is a console-only event; the element's error code is the only in-page evidence. A CSP-refused load, a dropped connection and an undecodable codec each get their own sentence.

## Already have a player?

Three of our apps do — p0dcasters and rssamplifier each run a queue-aware dock, and media-streamer has a modal per source. Replacing those with this bar would delete working features to gain a nicer-looking one. What they still need is the delivery half: which engine plays this source.

```js
import { attachSource } from '@profullstack/player';

const attached = await attachSource(audioEl, { src: episode.enclosureUrl });
// attached.engine -> 'native' | 'hls' | 'mpegts'
// attached.unplayable -> a sentence, when nothing here can play it
attached.destroy();
```

No DOM is created, nothing is styled, and your UI is untouched. `createPlayer` uses exactly this internally, so there is one engine ladder rather than two that drift.

## Options

| Option                    | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `src`                     | Required.                                                                  |
| `kind`, `mimeType`        | Skip or steer source detection.                                            |
| `mediaId`                 | Resume key. Omit and nothing is stored.                                    |
| `live`                    | Force live. Usually unnecessary.                                           |
| `chapters`                | `{ start, title }[]`; marks on the bar and the current one named.          |
| `startAt`                 | Seconds to begin at. Beats a saved position.                               |
| `shareUrl`                | `(seconds) => string`. Omit to drop the copy-link button.                  |
| `poster`, `autoplay`      | As you would expect.                                                       |
| `media`                   | Drive an existing element instead of building one.                         |
| `unplayableAdvice`        | Appended to a codec failure, e.g. `"VLC can — the button is beside Play."` |
| `withCredentials`         | Send cookies with stream requests; IPTV proxies authenticate that way.     |
| `capabilities`, `engines` | Override detection or inject an engine. Mostly for tests.                  |

Every control carries a `data-control` name (`play`, `back`, `rate`, `quality`, …) — style or hide them without depending on the order buttons sit in.

## Development

```sh
pnpm install
pnpm test        # 71 unit tests, jsdom
pnpm typecheck
pnpm build
```

The unit tests inject a fake engine, which is the design under test: the bar is meant to work identically whatever put the bytes there. Real formats are verified in a headless browser against real streams — see `harness/`.

## Licence

MIT
