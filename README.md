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

## Ad breaks

Interrupt the programme on a timer for viewers who are not on a paid plan.

```js
createPlayer(root, {
  src: channel.url,
  ads:
    user.plan === 'free'
      ? {
          next: () =>
            fetch('/api/ads/next')
              .then((r) => r.json())
              .then((a) => a.url),
          everySeconds: 300,
          preroll: true,
          skipAfter: 5, // omit for unskippable
        }
      : undefined, // paid: no adverts, no code path
});
```

Nothing in the player decides who sees an advert. The host knows who is paying,
and says so by not passing `ads` at all.

Worth knowing:

- **The programme is never re-sourced.** The advert plays in its own element over
  the stage and the content element is only paused. Swapping `src` would tear
  down the HLS or MPEG-TS engine and, on a live channel, hand the viewer back a
  different moment than the one they left.
- **Only watched time counts.** A paused tab accrues nothing, so someone who
  leaves for an hour does not come back owing three adverts.
- **The advert takes the viewer's volume**, not a muted default.
- **An advert that fails is not the viewer's problem.** A load error, or one that
  stalls past `maxSeconds`, ends the break and resumes the programme.
- `next` returning `null` skips that break, which is where a frequency cap or a
  subscription that changed since page load belongs.
- The programme's controls are inert while an advert is up.
- **Breaks fade, both ways.** The programme is taken down before it is paused
  and brought back up after, and the advert fades in and out with it, rather
  than the sound slamming shut and a picture appearing. `fadeSeconds` sets the
  length; `0` cuts straight. The listener's own level is always restored, even
  when an advert fails.

### Who sees them

The decision is the same everywhere, so it lives here rather than being made
differently in each player. It follows OpenAccess, which already models it:

```js
import { adsUnlessEntitled } from '@profullstack/player';

const ads = await adsUnlessEntitled({
  product: 'nixamp.pro',
  entitlements: () => openaccess.entitlements(), // your transport, not ours
  ads: { next: getAd, everySeconds: 300 },
});

createPlayer(root, { src, ads }); // null when they have paid
```

`active` and `trialing` count as paid; `past_due` does not, because that is a
card that failed rather than somebody who stopped paying, and interrupting them
is how a recoverable billing problem becomes a cancellation. The period is
checked as well as the status: a row can sit at `active` past what was paid for
when a webhook never arrived.

**An unreachable entitlement source means adverts, not silence.** The
alternative is an outage in the auth hub quietly switching off every advert
across the fleet, and a paying viewer who sees one break has lost less than a
business that stopped earning without noticing.

Transport-free on purpose: the host fetches its own entitlements and this only
decides what they mean, so embedding the player never drags in an auth
dependency.

### Audio adverts

A music player wants an MP3, not a video laid over the artwork. Return one and
it plays without a picture, leaving the sleeve visible behind the badge:

```js
ads: {
  next: () => 'https://ads.example/spot.mp3';
}
ads: {
  next: () => ({ url: '/ad?id=9', kind: 'audio' });
} // when the URL does not say
```

The kind is inferred from the extension (mp3, m4a, aac, ogg, opus, wav, flac)
and anything unrecognised is treated as video, which is the safe guess: an audio
file in a video element still plays, a video in an audio element loses its
picture.
