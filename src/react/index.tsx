'use client';

/**
 * The React wrapper.
 *
 * Deliberately thin, and optional — React is a peer dependency marked optional,
 * so a vanilla site importing the package never pulls it in. Everything that
 * decides how the player behaves lives in the core; this owns a ref, a mount
 * effect and a teardown, and nothing else.
 *
 * The `?t=` deep link is read from `window` inside the effect rather than
 * during render: reading it while rendering would make the server and client
 * markup disagree, and the player has nothing to do before mount anyway.
 */

import { useEffect, useRef } from 'react';
import { createPlayer, type PlayerOptions } from '../core/player';
import { parseTimeParam } from '../core/time';

export interface PlayerProps extends Omit<PlayerOptions, 'media' | 'startAt' | 'shareUrl'> {
  className?: string;
  /**
   * Read `?t=` from the address bar and start there. On by default, because a
   * link to a moment is worthless if the page ignores it.
   */
  useTimeParam?: boolean;
  /**
   * Offer "copy link at this time", built from the current address. Off inside
   * an embed, where the iframe's own URL is not something a reader can paste.
   */
  shareable?: boolean;
}

export function Player({
  className,
  useTimeParam = true,
  shareable = true,
  ...options
}: PlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Kept in a ref so a new object identity on every render does not tear the
  // player down and lose the reader's position.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const startAt = useTimeParam
      ? parseTimeParam(new URLSearchParams(window.location.search).get('t'))
      : null;

    const handle = createPlayer(root, {
      ...latest.current,
      startAt,
      shareUrl: shareable
        ? (seconds: number) => {
            const url = new URL(window.location.href);
            url.searchParams.set('t', String(seconds));
            url.hash = '';
            return url.toString();
          }
        : null,
    });

    return () => {
      handle.destroy();
    };
    // Rebuilt only when the source itself changes. Chapters and the rest are
    // read from the ref above, so a re-render does not restart playback.
  }, [options.src, options.mediaId, shareable, useTimeParam]);

  return <div ref={rootRef} className={className} />;
}

export type { PlayerOptions } from '../core/player';
export type { Chapter } from '../core/chapters';
