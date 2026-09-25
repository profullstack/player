import { describe, it, expect, vi } from 'vitest';
import { entitled, adsUnlessEntitled, GOOD_STANDING } from '../src/core/entitlements';

const ads = { next: () => 'x.mp4' };
const at = new Date('2026-06-01T00:00:00Z');
const ent = (over: Record<string, unknown> = {}) => ({
  product: 'nixamp.pro',
  status: 'active',
  period: { start: '2026-01-01T00:00:00Z', end: '2026-12-31T00:00:00Z' },
  ...over,
});

describe('who counts as paid', () => {
  it('matches OpenAccess: active and trialing, nothing else', () => {
    expect([...GOOD_STANDING]).toEqual(['active', 'trialing']);
  });

  it('a card that failed is not a lapsed subscriber', () => {
    // past_due is a recoverable billing problem. Interrupting them with
    // adverts is how it becomes a cancellation.
    expect(entitled([ent({ status: 'past_due' })], 'nixamp.pro', at)).toBe(false);
  });

  it('honours a trial', () => {
    expect(entitled([ent({ status: 'trialing' })], 'nixamp.pro', at)).toBe(true);
  });

  it('an entitlement for another product does not carry over', () => {
    expect(entitled([ent({ product: 'bittorrented.iptv' })], 'nixamp.pro', at)).toBe(false);
  });

  it('an active row past its period is not honoured', () => {
    // A webhook that never arrived leaves a row at active forever, and
    // honouring it is giving the product away.
    expect(entitled([ent({ period: { end: '2026-03-01T00:00:00Z' } })], 'nixamp.pro', at)).toBe(
      false
    );
  });

  it('one that has not started yet is not honoured either', () => {
    expect(entitled([ent({ period: { start: '2026-09-01T00:00:00Z' } })], 'nixamp.pro', at)).toBe(
      false
    );
  });

  it('an open-ended period counts', () => {
    expect(entitled([ent({ period: null })], 'nixamp.pro', at)).toBe(true);
  });

  it('nothing at all is not paid', () => {
    expect(entitled([], 'nixamp.pro', at)).toBe(false);
    expect(entitled(null, 'nixamp.pro', at)).toBe(false);
  });
});

describe('deciding whether to run adverts', () => {
  it('a paying viewer gets none', async () => {
    const got = await adsUnlessEntitled({
      product: 'nixamp.pro',
      entitlements: () => [ent()],
      ads,
      now: () => at,
    });
    expect(got).toBeNull();
  });

  it('everyone else gets them', async () => {
    const got = await adsUnlessEntitled({
      product: 'nixamp.pro',
      entitlements: () => [],
      ads,
      now: () => at,
    });
    expect(got).toBe(ads);
  });

  it('an unreachable entitlement source means adverts, not silence', async () => {
    // The alternative is an outage in the auth hub quietly switching off every
    // advert across the fleet. A paying viewer seeing one break has lost less
    // than a business that stopped earning without noticing.
    const got = await adsUnlessEntitled({
      product: 'nixamp.pro',
      entitlements: () => {
        throw new Error('hub down');
      },
      ads,
      now: () => at,
    });
    expect(got).toBe(ads);
  });

  it('asks for entitlements once per decision, not per break', async () => {
    const fetcher = vi.fn(() => [ent()]);
    await adsUnlessEntitled({ product: 'nixamp.pro', entitlements: fetcher, ads, now: () => at });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
