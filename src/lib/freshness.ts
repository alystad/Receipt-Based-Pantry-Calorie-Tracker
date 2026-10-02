/**
 * Freshness / expiry indicator for the pantry grid.
 *
 * Receipts and photo scans never carry a use-by date, so a real expiry is only
 * available when someone entered one (pantry_items.expires_at). Everything
 * else is a shelf-life *estimate* measured from when we last saw the item
 * purchased, and is labelled as an estimate in the UI — the app should not
 * imply it knows your milk expires Thursday when it is really just guessing
 * from a category average.
 */

export type FreshnessState = 'fresh' | 'use_soon' | 'expired' | 'unknown';

export type Freshness = {
  state: FreshnessState;
  label: string;
  /** True when derived from a category average rather than a real date. */
  estimated: boolean;
  daysLeft: number | null;
};

/** Typical days from purchase to end of usable life, by receipt category. */
const SHELF_LIFE_DAYS: Record<string, number> = {
  produce: 7,
  seafood: 3,
  meat: 5,
  dairy: 14,
  bakery: 7,
  frozen: 180,
  pantry: 365,
  beverage: 120,
  snacks: 120,
  household: 730,
};

function describe(daysLeft: number, estimated: boolean): Freshness {
  if (daysLeft < 0) {
    return {
      state: 'expired',
      label: estimated ? 'Likely past its best' : 'Expired',
      estimated,
      daysLeft,
    };
  }
  if (daysLeft <= 2) {
    return {
      state: 'use_soon',
      label: daysLeft === 0 ? 'Use today' : `Use within ${daysLeft}d`,
      estimated,
      daysLeft,
    };
  }
  return {
    state: 'fresh',
    label: daysLeft >= 30 ? 'Fresh' : `${daysLeft}d left`,
    estimated,
    daysLeft,
  };
}

export function freshnessFor(item: {
  category: string | null;
  last_seen_at: string | Date;
  expires_at?: string | Date | null;
}): Freshness {
  const dayMs = 86_400_000;
  const now = Date.now();

  // A real date beats any estimate.
  if (item.expires_at) {
    const expires = new Date(item.expires_at).getTime();
    return describe(Math.floor((expires - now) / dayMs), false);
  }

  const shelfLife = item.category ? SHELF_LIFE_DAYS[item.category.toLowerCase()] : undefined;
  if (shelfLife == null) {
    return { state: 'unknown', label: '', estimated: false, daysLeft: null };
  }

  const seen = new Date(item.last_seen_at).getTime();
  const elapsed = Math.floor((now - seen) / dayMs);
  return describe(shelfLife - elapsed, true);
}
