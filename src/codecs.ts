/**
 * The codec table on its own, with no player attached.
 *
 * genrewatch and tipoffwatch each carry a copy of this file. It is the most
 * expensive 150 lines in either repo -- every rule in it was written in
 * response to a channel that failed in production, and two of them were got
 * wrong twice -- and three copies of it is exactly the thing this package
 * exists to stop.
 *
 * A subpath rather than the root export, because those two bundle their client
 * by hand and are careful about its weight: importing from the root would pull
 * the player and its dynamic engine imports into a bundle that wants a lookup
 * table and nothing else.
 */

export { codecName, mseCandidates, unplayableReason, type MediaInfoLike } from './engines/codecs';
