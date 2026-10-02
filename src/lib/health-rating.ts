/**
 * Health rating: a Yuka-style 0-100 score.
 *
 * Deliberately deterministic and computed in code rather than asked of the
 * model. The model supplies *facts* about a dish (macros, fiber, added sugar,
 * saturated fat, sodium, serving weight, processing level); the score is
 * derived from those facts here. Asking a model to rate healthiness directly
 * produces ratings that drift between calls and can't be explained to a user.
 *
 * Three weighted buckets sum to the final 0-100 score:
 *
 *   MACRO BALANCE      (0-40)  protein density, fiber density, added sugar
 *                               share, saturated fat share
 *   WHOLE VS PROCESSED (0-35)  NOVA-style 1-4 classification, sodium density
 *   CALORIE DENSITY    (0-25)  kcal per 100g as served, calibrated against
 *                               what's normal for that meal slot — a dinner
 *                               entree is expected to be denser than a snack
 *
 * Every sub-metric is returned as a signed, labelled reason (positive =
 * pulling the score up, negative = pulling it down), so the UI can show a
 * user exactly why a dish scored what it did.
 */

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type NutritionFacts = {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number | null;
  sugar_added_g?: number | null;
  sat_fat_g?: number | null;
  sodium_mg?: number | null;
  /** Total edible weight of one serving, used for calorie density. */
  serving_grams?: number | null;
  /** NOVA-style: 1 whole/minimally processed … 4 ultra-processed. */
  processing_level?: number | null;
  /** Calibrates what counts as calorie-dense — a dinner reads differently than a snack. */
  slot?: MealSlot | null;
};

export type HealthReason = {
  axis: string;
  label: string;
  points: number;
};

export type HealthBand = 'excellent' | 'good' | 'poor' | 'bad';

export type HealthRating = {
  score: number;
  band: HealthBand;
  label: string;
  reasons: HealthReason[];
};

type Tier = { upTo: number; earned: number; label: string };

/**
 * Scores one sub-metric on a 0..max scale by picking the first tier whose
 * threshold the value satisfies, and derives a signed reason centered on the
 * bucket's midpoint — so "earned the full 15 of 15" reads as a clearly
 * positive contributor and "earned 0 of 15" reads as a clearly negative one,
 * without maintaining two separate hand-written scales.
 */
function score(
  axis: string,
  value: number,
  max: number,
  tiers: Tier[],
  fallback: { earned: number; label: string }
): { earned: number; reason: HealthReason } {
  const hit = tiers.find((t) => value <= t.upTo) ?? fallback;
  const signed = Math.round(hit.earned - max / 2);
  return {
    earned: Math.max(0, Math.min(max, hit.earned)),
    reason: { axis, label: hit.label, points: signed },
  };
}

/** Per-100-kcal calorie density that's normal for a meal in this slot. */
const DENSITY_BY_SLOT: Record<MealSlot, { idealMax: number; hardMax: number }> = {
  breakfast: { idealMax: 150, hardMax: 300 },
  lunch: { idealMax: 180, hardMax: 320 },
  dinner: { idealMax: 200, hardMax: 350 },
  snack: { idealMax: 110, hardMax: 220 },
};
const DEFAULT_DENSITY = { idealMax: 180, hardMax: 320 };

export function rateMeal(facts: NutritionFacts): HealthRating {
  const reasons: HealthReason[] = [];
  const calories = Math.max(1, facts.calories || 0);
  const per100kcal = (grams: number) => (grams / calories) * 100;

  // --- Macro balance (0-40): protein + fiber density, sugar + sat fat share.
  const protein = score(
    'protein',
    per100kcal(facts.protein_g || 0),
    15,
    [
      { upTo: 1.99, earned: 0, label: 'Very little protein' },
      { upTo: 3.99, earned: 4, label: 'Low protein' },
      { upTo: 6.99, earned: 9, label: 'Some protein' },
      { upTo: 9.99, earned: 12, label: 'Good protein for its calories' },
    ],
    { earned: 15, label: 'Excellent protein for its calories' }
  );

  const fiber =
    facts.fiber_g != null
      ? score(
          'fiber',
          per100kcal(facts.fiber_g),
          10,
          [
            { upTo: 0.79, earned: 1, label: 'Low in fiber' },
            { upTo: 1.49, earned: 4, label: 'Some fiber' },
            { upTo: 2.49, earned: 7, label: 'Good fiber content' },
          ],
          { earned: 10, label: 'Excellent fiber content' }
        )
      : { earned: 5, reason: null };

  const sugar =
    facts.sugar_added_g != null
      ? score(
          'added_sugar',
          ((facts.sugar_added_g * 4) / calories) * 100,
          10,
          [
            { upTo: 5, earned: 10, label: 'Little or no added sugar' },
            { upTo: 10, earned: 6, label: 'Some added sugar' },
            { upTo: 20, earned: 2, label: 'High in added sugar' },
          ],
          { earned: 0, label: 'Very high in added sugar' }
        )
      : { earned: 5, reason: null };

  const satFat =
    facts.sat_fat_g != null
      ? score(
          'saturated_fat',
          ((facts.sat_fat_g * 9) / calories) * 100,
          5,
          [
            { upTo: 5, earned: 5, label: 'Low in saturated fat' },
            { upTo: 10, earned: 3, label: 'Moderate saturated fat' },
            { upTo: 15, earned: 1, label: 'High in saturated fat' },
          ],
          { earned: 0, label: 'Very high in saturated fat' }
        )
      : { earned: 2.5, reason: null };

  const macroBalance = protein.earned + fiber.earned + sugar.earned + satFat.earned;

  // --- Whole vs. processed (0-35): NOVA level + sodium density.
  const processing =
    facts.processing_level != null
      ? score(
          'processing',
          facts.processing_level,
          30,
          [
            { upTo: 1, earned: 30, label: 'Whole or minimally processed ingredients' },
            { upTo: 2, earned: 20, label: 'Mostly whole ingredients' },
            { upTo: 3, earned: 8, label: 'Contains processed ingredients' },
          ],
          { earned: 0, label: 'Largely ultra-processed' }
        )
      : { earned: 15, reason: null };

  const sodium =
    facts.sodium_mg != null
      ? score(
          'sodium',
          per100kcal(facts.sodium_mg),
          5,
          [
            { upTo: 100, earned: 5, label: 'Low sodium' },
            { upTo: 250, earned: 3, label: 'Moderate sodium' },
            { upTo: 500, earned: 1, label: 'High sodium' },
          ],
          { earned: 0, label: 'Very high sodium' }
        )
      : { earned: 2.5, reason: null };

  const wholeVsProcessed = processing.earned + sodium.earned;

  // --- Calorie density (0-25), calibrated to what's normal for this slot.
  let density: { earned: number; reason: HealthReason | null };
  if (facts.serving_grams && facts.serving_grams > 0) {
    const { idealMax, hardMax } = facts.slot ? DENSITY_BY_SLOT[facts.slot] : DEFAULT_DENSITY;
    const kcalPer100g = (calories / facts.serving_grams) * 100;

    const earned =
      kcalPer100g <= idealMax
        ? 25
        : kcalPer100g >= hardMax
          ? 0
          : 25 * (1 - (kcalPer100g - idealMax) / (hardMax - idealMax));

    const label =
      earned >= 20
        ? `Light for a ${facts.slot ?? 'meal'} — filling for its calories`
        : earned >= 10
          ? 'Moderate calorie density'
          : earned >= 3
            ? `Calorie dense for a ${facts.slot ?? 'meal'}`
            : `Very calorie dense for a ${facts.slot ?? 'meal'}`;

    density = { earned, reason: { axis: 'calorie_density', label, points: Math.round(earned - 12.5) } };
  } else {
    density = { earned: 12.5, reason: null };
  }

  for (const part of [protein, fiber, sugar, satFat, processing, sodium, density]) {
    if (part.reason) reasons.push(part.reason);
  }

  const total = macroBalance + wholeVsProcessed + density.earned;
  const clamped = Math.max(0, Math.min(100, Math.round(total)));

  return {
    score: clamped,
    band: bandFor(clamped),
    label: labelFor(clamped),
    // Biggest movers first — that's what a user wants to see on a card.
    reasons: reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
  };
}

export function bandFor(score: number): HealthBand {
  if (score >= 75) return 'excellent';
  if (score >= 50) return 'good';
  if (score >= 25) return 'poor';
  return 'bad';
}

export function labelFor(score: number): string {
  return { excellent: 'Excellent', good: 'Good', poor: 'Poor', bad: 'Bad' }[bandFor(score)];
}

/** Token colours for the score chip; keys map to CSS custom properties. */
export function scoreColor(band: HealthBand): { bg: string; fg: string } {
  switch (band) {
    case 'excellent':
      return { bg: 'var(--score-excellent-soft)', fg: 'var(--score-excellent)' };
    case 'good':
      return { bg: 'var(--score-good-soft)', fg: 'var(--score-good)' };
    case 'poor':
      return { bg: 'var(--score-poor-soft)', fg: 'var(--score-poor)' };
    default:
      return { bg: 'var(--score-bad-soft)', fg: 'var(--score-bad)' };
  }
}

/** One-line explanation of the rubric, shown in the detail view. */
export const RUBRIC_SUMMARY =
  'Scored 0-100 from macro balance (protein, fiber, saturated fat, added sugar), ' +
  'how processed the ingredients are, and calorie density for a meal like this one. ' +
  '75+ Excellent, 50+ Good, 25+ Poor, below 25 Bad.';
