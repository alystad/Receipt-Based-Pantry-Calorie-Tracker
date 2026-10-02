/**
 * Dish-name normalization for the meal image cache.
 *
 * Deliberately separate from units.ts's matchKey(): that one is tuned for
 * grocery product names (strips package sizes, brand tokens, "organic"/"bag"
 * noise). Dish names are a different domain — "Grilled Chicken with Rice"
 * and "grilled chicken and rice" need to collapse to the same key, which
 * calls for stripping connective words ("with", "and") instead.
 *
 * The approach is the same shape as matchKey() though: lowercase, strip
 * punctuation, drop stopwords, light plural stemming, sort the remaining
 * tokens so word order stops mattering, join. A sorted bag-of-words key is
 * "basic fuzzy matching" that costs nothing at lookup time (still an exact
 * index match in Postgres) — the *fallback* tier, for names too different
 * even for this to collapse, is trigram similarity(), applied where this key
 * is used (src/lib/ai/meal-images.ts), not here.
 */

const STOPWORDS = new Set([
  'with', 'and', 'the', 'a', 'an', 'of', 'in', 'on', 'style', 'recipe',
  'dish', 'style', 'classic', 'homemade', 'easy', 'quick', 'simple',
  'fresh', 'traditional', 'authentic', 'served', 'topped', 'over',
]);

/** Cheap plural stemming: safe for a food-name vocabulary, not general English. */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function dishKey(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);

  const deduped = Array.from(new Set(tokens)).sort();
  return deduped.join('-') || name.toLowerCase().trim().replace(/\s+/g, '-');
}
