/**
 * Store aisle maps.
 *
 * Plain data, not logic — editing this file (re-numbering an aisle, adding a
 * category, adding a second store) never touches the classification or
 * display code in src/lib/ai/aisle-classify.ts or GroceryList.tsx. Keyed by
 * store slug (matches the `slug` column on the `stores` table) so a second
 * store is just a new top-level entry, not a rewrite.
 *
 * Two kinds of location, matching how a real store is laid out:
 *   - Numbered aisles: specific, curated category lists per aisle.
 *   - Perimeter sections: named departments (Produce, Meat, ...) that don't
 *     have a single aisle number — the fresh stuff around the edge of the
 *     store.
 */

export type AisleDefinition = { number: number; categories: string[] };
export type PerimeterSection = { name: string };

export type StoreAisleMap = {
  /** Numbered aisles, in walking order — also the sort order for the list. */
  aisles: AisleDefinition[];
  /** Perimeter departments, in a sensible walking order (not alphabetical). */
  perimeter: PerimeterSection[];
};

export const AISLE_MAPS: Record<string, StoreAisleMap> = {
  publix: {
    aisles: [
      { number: 1, categories: ['Bread', 'Cereal', 'Coffee/Tea', 'Sports drinks', 'Peanut butter and jelly'] },
      { number: 2, categories: ['Candy', 'Canned meat', 'Cookies', 'Crackers', 'Soup and broth'] },
      { number: 3, categories: ['Cakes', 'Condiments', 'Rice and dry beans', 'Pasta and pasta sauce', 'Spices and extracts'] },
      { number: 4, categories: ['Bathroom tissue', 'Batteries', 'Charcoal', 'Cleaners', 'Dish detergent'] },
      { number: 5, categories: ['Frozen breakfasts', 'Frozen pizza', 'Popcorn', 'Potato chips'] },
      { number: 6, categories: ['Frozen dinners', 'Frozen entrees', 'Frozen novelties', 'Frozen veggies', 'Ice cream'] },
      { number: 7, categories: ['Protein powders'] },
    ],
    // A few standard departments beyond the five named explicitly, so the
    // classifier has a real option for e.g. fish or flowers instead of being
    // forced into a numbered aisle that doesn't fit.
    perimeter: [
      { name: 'Produce' },
      { name: 'Deli' },
      { name: 'Bakery' },
      { name: 'Meat' },
      { name: 'Seafood' },
      { name: 'Dairy' },
      { name: 'Floral' },
    ],
  },
};

/** Falls back to Publix's map — the only store with real aisle data today. */
export function aisleMapFor(storeSlug: string | null): StoreAisleMap {
  return (storeSlug && AISLE_MAPS[storeSlug]) || AISLE_MAPS.publix;
}

export type AisleLocation =
  | { kind: 'aisle'; number: number; category: string }
  | { kind: 'perimeter'; section: string };

/**
 * Every valid category name for a store, in display order — numbered-aisle
 * categories first (in aisle order), then perimeter section names. This is
 * the closed set handed to the model as a JSON-schema enum in
 * aisle-classify.ts, so a classification can never come back as a category
 * this map doesn't actually have a location for.
 */
export function categoryList(map: StoreAisleMap): string[] {
  return [
    ...map.aisles.flatMap((a) => a.categories),
    ...map.perimeter.map((p) => p.name),
  ];
}

/** Resolves a category name (as returned by the classifier) to where it lives. */
export function resolveAisle(map: StoreAisleMap, category: string): AisleLocation | null {
  const needle = category.trim().toLowerCase();

  for (const aisle of map.aisles) {
    const hit = aisle.categories.find((c) => c.toLowerCase() === needle);
    if (hit) return { kind: 'aisle', number: aisle.number, category: hit };
  }
  const section = map.perimeter.find((p) => p.name.toLowerCase() === needle);
  if (section) return { kind: 'perimeter', section: section.name };

  return null;
}
