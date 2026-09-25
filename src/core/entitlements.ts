import type { AdBreakOptions } from './ads.js';

/**
 * Whether the viewer has paid, in OpenAccess terms.
 *
 * The decision "should this person see adverts" is the same everywhere and was
 * being made differently in each player: a boolean here, a credit balance
 * there, nothing at all in a third. OpenAccess already models it, so this is
 * that model applied rather than a fourth answer.
 *
 * Deliberately transport-free. The host fetches its own entitlements — through
 * the OpenAccess client, its own API, a cookie it already has — and this only
 * decides what they mean. A player that reached for the hub itself would drag
 * an auth dependency into every page that embeds it.
 */

/**
 * The statuses an app treats as paid, from OpenAccess.
 *
 * Note what is NOT here: `past_due` is somebody whose card failed, not somebody
 * who stopped paying, and interrupting them with adverts is how a recoverable
 * billing problem becomes a cancellation.
 */
export const GOOD_STANDING = ['active', 'trialing'] as const;

export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';

/** The shape this needs. An OpenAccess Entitlement satisfies it as it stands. */
export interface EntitlementLike {
  product: string;
  status: EntitlementStatus | string;
  period?: { start?: string | null; end?: string | null } | null;
}

/**
 * Is one of these entitlements good for this product, right now?
 *
 * The period is checked as well as the status. An entitlement can sit at
 * `active` past the end of what was paid for — a webhook that never arrived, a
 * cancellation recorded late — and honouring that is giving the product away.
 */
export function entitled(
  entitlements: readonly EntitlementLike[] | null | undefined,
  product: string,
  now: Date = new Date()
): boolean {
  if (!entitlements?.length) return false;
  const good = new Set<string>(GOOD_STANDING);
  return entitlements.some((e) => {
    if (e.product !== product) return false;
    if (!good.has(e.status)) return false;
    const end = e.period?.end ? Date.parse(e.period.end) : NaN;
    if (Number.isFinite(end) && end < now.getTime()) return false;
    const start = e.period?.start ? Date.parse(e.period.start) : NaN;
    if (Number.isFinite(start) && start > now.getTime()) return false;
    return true;
  });
}

export interface AdsUnlessEntitledOptions {
  /** The product an entitlement has to name to count. */
  product: string;
  /** How the host gets the viewer's entitlements. */
  entitlements: () =>
    Promise<readonly EntitlementLike[] | null> | readonly EntitlementLike[] | null;
  /** What to run when they have not paid. */
  ads: AdBreakOptions;
  now?: () => Date;
}

/**
 * Adverts, unless this viewer has paid for the product.
 *
 * A failure to reach the entitlement source returns adverts rather than
 * suppressing them. That is the deliberate direction: the alternative is an
 * outage in the auth hub silently turning off every advert across the fleet,
 * and a paying viewer who sees one break because a request timed out has lost
 * less than a business that stopped earning without noticing.
 */
export async function adsUnlessEntitled(
  options: AdsUnlessEntitledOptions
): Promise<AdBreakOptions | null> {
  let held: readonly EntitlementLike[] | null = null;
  try {
    held = (await options.entitlements()) ?? null;
  } catch {
    return options.ads;
  }
  const at = options.now?.() ?? new Date();
  return entitled(held, options.product, at) ? null : options.ads;
}
