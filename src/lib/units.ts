/**
 * Unit normalization.
 *
 * Receipts, vision output and recipes all speak different dialects ("12 OZ",
 * "1 bag", "2 tbsp"). Everything is converted to one of three canonical units
 * so a purchase and a consumption can be subtracted from each other.
 */

export type CanonicalUnit = 'g' | 'ml' | 'count';

const MASS_TO_GRAMS: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  tsp: 4.929,
  teaspoon: 4.929,
  teaspoons: 4.929,
  tbsp: 14.787,
  tablespoon: 14.787,
  tablespoons: 14.787,
  cup: 236.588,
  cups: 236.588,
  pint: 473.176,
  pints: 473.176,
  quart: 946.353,
  quarts: 946.353,
  gal: 3785.41,
  gallon: 3785.41,
  gallons: 3785.41,
  'fl oz': 29.5735,
  floz: 29.5735,
};

// Units that describe a package or a whole item rather than an amount.
const COUNT_UNITS = new Set([
  'count', 'ct', 'each', 'ea', 'item', 'items', 'unit', 'units',
  'pack', 'pk', 'package', 'bag', 'box', 'bottle', 'can', 'jar', 'carton',
  'bunch', 'head', 'loaf', 'dozen', 'piece', 'pieces', 'slice', 'slices',
  'serving', 'servings', 'clove', 'cloves', 'stick', 'sticks', 'breast',
]);

const MULTIPLIERS: Record<string, number> = { dozen: 12 };

export type CanonicalAmount = { amount: number; unit: CanonicalUnit };

/**
 * Converts `quantity unit` into a canonical amount. Unknown units fall back to
 * `count`, which is the honest answer for "1 bag of salad".
 */
export function toCanonical(quantity: number, unit?: string | null): CanonicalAmount {
  const qty = Number.isFinite(quantity) ? quantity : 1;
  const key = (unit ?? '').trim().toLowerCase().replace(/\./g, '');

  if (!key) return { amount: qty, unit: 'count' };
  if (key in MASS_TO_GRAMS) return { amount: qty * MASS_TO_GRAMS[key], unit: 'g' };
  if (key in VOLUME_TO_ML) return { amount: qty * VOLUME_TO_ML[key], unit: 'ml' };
  if (COUNT_UNITS.has(key)) return { amount: qty * (MULTIPLIERS[key] ?? 1), unit: 'count' };

  return { amount: qty, unit: 'count' };
}

/** Human-facing rendering of a canonical amount, e.g. "1.2 kg", "3 ct". */
export function formatAmount(amount: number, unit: CanonicalUnit): string {
  if (unit === 'count') {
    return `${round(amount, 2)} ${amount === 1 ? 'ct' : 'ct'}`;
  }
  if (unit === 'g' && amount >= 1000) return `${round(amount / 1000, 2)} kg`;
  if (unit === 'ml' && amount >= 1000) return `${round(amount / 1000, 2)} L`;
  return `${round(amount, 1)} ${unit}`;
}

export function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Words that carry no identity: dropping them lets "PUB GRN BNS 12OZ" and
// "Publix Green Beans" collapse onto the same pantry row.
//
// Brand names are stripped too, even though they are real information — brand
// lives in its own column, and leaving it in the key would split the receipt
// line ("publix green beans") from the vision model's label ("green beans"),
// which is exactly the join this app depends on.
const NOISE_WORDS = new Set([
  // Marketing filler
  'organic', 'fresh', 'frozen', 'natural', 'premium', 'brand', 'value',
  'great', 'select', 'classic', 'original', 'large', 'small', 'medium',
  'family', 'size', 'pack', 'pk', 'ct', 'count', 'bag', 'box', 'bottle',
  'jar', 'can', 'the', 'and', 'with', 'of',
  // Preparation state that does not change what the product is
  'boneless', 'skinless', 'sliced', 'shredded', 'chopped', 'diced', 'whole',
  'raw', 'cooked', 'unsalted', 'salted',
  // Store and common house brands
  'publix', 'kroger', 'walmart', 'target', 'costco', 'aldi', 'safeway',
  'wegmans', 'trader', 'joes', 'heb', 'meijer', 'winn', 'dixie',
  'greatvalue', 'kirkland', 'signature', 'simple', 'truth', 'goodgather',
]);

const ABBREVIATIONS: Record<string, string> = {
  pub: 'publix',
  kro: 'kroger',
  gv: 'greatvalue',
  grn: 'green',
  bns: 'beans',
  chz: 'cheese',
  chkn: 'chicken',
  bnls: 'boneless',
  sknls: 'skinless',
  brst: 'breast',
  yog: 'yogurt',
  gr: 'ground',
  bf: 'beef',
  wht: 'wheat',
  brd: 'bread',
  mlk: 'milk',
  tom: 'tomato',
  ptato: 'potato',
  swt: 'sweet',
  vgtbl: 'vegetable',
  shrd: 'shredded',
};

/**
 * Builds the stable key used to merge the same product across receipts, photo
 * scans and meal matches. Deliberately lossy: strips sizes, noise words, brand
 * tokens, and expands common receipt abbreviations.
 *
 * This is a heuristic, not a resolver. The stronger match path is the vision
 * model, which is handed the user's real match_keys and asked to echo one back;
 * this function is the deterministic write-side key and the fallback.
 */
export function matchKey(name: string, brand?: string | null): string {
  // The static list can only cover store brands. Every other brand
  // ("Chobani Greek Yogurt" vs "greek yogurt") has to be removed using the
  // brand field the parser already extracted, or one product becomes two rows.
  const brandTokens = new Set(
    (brand ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );

  const expanded = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    // Drop embedded sizes like "12oz" or "2 lb".
    .replace(/\b\d+(\.\d+)?\s?(oz|lb|lbs|g|kg|ml|l|ct|pk|count)\b/g, ' ')
    .replace(/\b\d+(\.\d+)?\b/g, ' ')
    .split(/\s+/)
    .map((word) => ABBREVIATIONS[word] ?? word)
    .filter(
      (word) => word.length > 1 && !NOISE_WORDS.has(word) && !brandTokens.has(word)
    );

  const deduped = Array.from(new Set(expanded)).sort();
  return deduped.join('-') || name.toLowerCase().trim().replace(/\s+/g, '-');
}

/** Per-100-canonical-unit nutrition block stored on pantry_items. */
export type NutritionPer100 = {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
  sodium_mg?: number;
};

/** Scales a per-100 nutrition block to an actual consumed amount. */
export function scaleNutrition(per100: NutritionPer100, amount: number) {
  const factor = amount / 100;
  return {
    calories: round(per100.calories * factor, 1),
    protein_g: round(per100.protein_g * factor, 1),
    carbs_g: round(per100.carbs_g * factor, 1),
    fat_g: round(per100.fat_g * factor, 1),
    fiber_g: per100.fiber_g == null ? null : round(per100.fiber_g * factor, 1),
    sodium_mg: per100.sodium_mg == null ? null : round(per100.sodium_mg * factor, 1),
  };
}
