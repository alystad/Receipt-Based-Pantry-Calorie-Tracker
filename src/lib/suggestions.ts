import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { query, queryOne, transaction } from './db';
import { getPreferences } from './plans';
import { matchKey, toCanonical, type CanonicalUnit } from './units';
import { dishKey } from './dish-key';
import { rateMeal, type HealthReason } from './health-rating';
import {
  generateCustomMeals,
  suggestMealsForNow,
  type CustomMealConstraints,
  type PantryLine,
  type SuggestedIngredient,
  type SuggestedMeal,
} from './ai/suggestions';

/** Meal window for the current hour — drives "Suggested for you now". */
export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export function slotForHour(hour: number): Slot {
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

export function slotLabel(slot: Slot): string {
  return { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }[slot];
}

export type SuggestionRow = {
  id: string;
  source: string;
  slot: Slot | null;
  title: string;
  description: string | null;
  cuisine: string | null;
  prep_minutes: number | null;
  servings: number;
  calories: string | null;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
  fiber_g: string | null;
  sodium_mg: string | null;
  health_score: number | null;
  health_grade: string | null;
  health_reasons: HealthReason[] | null;
  instructions: string[];
  pantry_coverage: number | null;
  photo_id: string | null;
  image_url: string | null;
  image_status: string;
  created_at: Date;
};

export type SuggestionWithIngredients = SuggestionRow & {
  ingredients: {
    name: string;
    quantity: string | null;
    display_unit: string | null;
    from_pantry: boolean;
  }[];
};

async function pantryLines(userId: string, limit = 120): Promise<PantryLine[]> {
  const rows = await query<{
    name: string;
    brand: string | null;
    quantity: string;
    unit: CanonicalUnit;
  }>(
    `SELECT name, brand, quantity, unit
       FROM pantry_items
      WHERE user_id = $1 AND depleted_at IS NULL AND quantity > 0
      ORDER BY last_seen_at DESC
      LIMIT $2`,
    [userId, limit]
  );

  return rows.map((r) => ({
    name: r.name,
    brand: r.brand,
    quantity: Math.round(Number(r.quantity) * 10) / 10,
    unit: r.unit,
  }));
}

/**
 * The dishes a user actually eats most, from their own logged meal photos —
 * not what they've been suggested, what they've genuinely repeated. Grouped
 * by dishKey() rather than raw title so "grilled chicken and rice" and
 * "Grilled Chicken with Rice" count as the same habit instead of splitting
 * a real pattern across two near-duplicate rows.
 *
 * Feeds "Suggested for you" as a personalization signal, not a hard filter —
 * the model is nudged toward familiar territory, not restricted to it.
 */
export async function frequentlyLoggedTitles(userId: string, limit = 6): Promise<string[]> {
  const rows = await query<{ title: string; times_logged: string }>(
    `SELECT title, COUNT(*) AS times_logged
       FROM meal_logs
      WHERE user_id = $1 AND title IS NOT NULL AND title <> ''
        AND eaten_at > now() - interval '90 days'
      GROUP BY title
      ORDER BY COUNT(*) DESC, MAX(eaten_at) DESC
      LIMIT 40`,
    [userId]
  );

  // Collapse near-duplicate titles the same way the image cache does, so a
  // dish logged under slightly different phrasing still counts as one habit
  // and doesn't crowd out everything else with N near-identical entries.
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const row of rows) {
    const key = dishKey(row.title);
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(row.title);
    if (titles.length >= limit) break;
  }
  return titles;
}

type ResolvedIngredient = {
  name: string;
  quantity: number;
  unit: string;
  matchKey: string;
  canonicalAmount: number;
  canonicalUnit: CanonicalUnit;
  fromPantry: boolean;
  matchedPantryItemId: string | null;
};

/**
 * Resolves each ingredient against the real pantry: trusts the shelf, not the
 * model's own from_pantry flag, and downgrades from_pantry to false when the
 * dish calls for more of something than is actually in stock (existence
 * alone isn't enough — 2 lb of chicken shouldn't read as "have it" against
 * 0.5 lb on the shelf). Cross-unit stock (e.g. a `ml` pantry row against a
 * `g` ingredient line) is treated as a match on existence only, the same
 * "close enough at this precision" call already made elsewhere for g/ml.
 */
async function resolveIngredientsAgainstPantry(
  client: PoolClient,
  userId: string,
  ingredients: SuggestedIngredient[]
): Promise<{ resolved: ResolvedIngredient[]; coverage: number }> {
  const keys = ingredients.map((i) => matchKey(i.name));
  const owned = keys.length
    ? new Map(
        (
          await client.query<{ id: string; match_key: string; quantity: string; unit: CanonicalUnit }>(
            `SELECT id, match_key, quantity, unit FROM pantry_items
              WHERE user_id = $1 AND match_key = ANY($2::text[])
                AND depleted_at IS NULL AND quantity > 0`,
            [userId, keys]
          )
        ).rows.map((r) => [r.match_key, r])
      )
    : new Map<string, { id: string; match_key: string; quantity: string; unit: CanonicalUnit }>();

  const resolved: ResolvedIngredient[] = ingredients.map((ingredient, i) => {
    const key = keys[i];
    const canonical = toCanonical(ingredient.quantity, ingredient.unit);
    const stock = owned.get(key);
    const fromPantry = Boolean(
      stock && (stock.unit !== canonical.unit || Number(stock.quantity) >= canonical.amount)
    );

    return {
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      matchKey: key,
      canonicalAmount: canonical.amount,
      canonicalUnit: canonical.unit,
      fromPantry,
      matchedPantryItemId: fromPantry ? (stock?.id ?? null) : null,
    };
  });

  const coverage = resolved.length
    ? resolved.filter((r) => r.fromPantry).length / resolved.length
    : 0;

  return { resolved, coverage };
}

/**
 * Persists generated meals: grades them with the shared rubric, resolves each
 * ingredient against the real pantry, and records how much of the dish the
 * shelf already covers.
 */
async function persistMeals(params: {
  userId: string;
  meals: SuggestedMeal[];
  model: string;
  source: 'time_of_day' | 'custom' | 'cuisine_row';
  constraints?: CustomMealConstraints | null;
}): Promise<string[]> {
  const { userId, meals, model, source } = params;

  return transaction(async (client) => {
    const ids: string[] = [];

    for (const meal of meals) {
      const rating = rateMeal({
        calories: meal.calories,
        protein_g: meal.protein_g,
        carbs_g: meal.carbs_g,
        fat_g: meal.fat_g,
        fiber_g: meal.fiber_g,
        sugar_added_g: meal.sugar_added_g,
        sat_fat_g: meal.sat_fat_g,
        sodium_mg: meal.sodium_mg,
        serving_grams: meal.serving_grams,
        processing_level: meal.processing_level,
        // Calibrates calorie density: a dinner is expected to be denser than
        // a snack, so the same kcal/100g reads differently per slot.
        slot: meal.slot,
      });

      const { resolved, coverage } = await resolveIngredientsAgainstPantry(
        client,
        userId,
        meal.ingredients ?? []
      );

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO meal_suggestions
           (user_id, source, slot, title, description, cuisine, prep_minutes,
            servings, calories, protein_g, carbs_g, fat_g, fiber_g,
            sugar_added_g, sat_fat_g, sodium_mg, serving_grams,
            processing_level, health_score, health_grade, health_reasons,
            instructions, pantry_coverage, constraints, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21::jsonb,$22,$23,$24::jsonb,$25)
         RETURNING id`,
        [
          userId,
          source,
          meal.slot,
          meal.title,
          meal.description,
          meal.cuisine,
          Math.round(meal.prep_minutes ?? 0),
          Math.max(1, Math.round(meal.servings ?? 1)),
          meal.calories,
          meal.protein_g,
          meal.carbs_g,
          meal.fat_g,
          meal.fiber_g,
          meal.sugar_added_g,
          meal.sat_fat_g,
          meal.sodium_mg,
          meal.serving_grams,
          Math.max(1, Math.min(4, Math.round(meal.processing_level ?? 2))),
          rating.score,
          rating.band,
          JSON.stringify(rating.reasons),
          meal.instructions ?? [],
          coverage,
          params.constraints ? JSON.stringify(params.constraints) : null,
          model,
        ]
      );

      const suggestionId = rows[0].id;
      ids.push(suggestionId);

      for (const ingredient of resolved) {
        await client.query(
          `INSERT INTO meal_suggestion_ingredients
             (suggestion_id, name, match_key, quantity, display_unit,
              canonical_amount, canonical_unit, from_pantry, matched_pantry_item_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            suggestionId,
            ingredient.name,
            ingredient.matchKey,
            ingredient.quantity,
            ingredient.unit,
            ingredient.canonicalAmount,
            ingredient.canonicalUnit,
            ingredient.fromPantry,
            ingredient.matchedPantryItemId,
          ]
        );
      }
    }

    return ids;
  });
}

export type SuggestedMealRow = {
  id: string;
  slot: Slot;
  title: string;
  description: string | null;
  cuisine: string | null;
  prep_minutes: number | null;
  servings: number;
  calories: string | null;
  protein_g: string | null;
  carbs_g: string | null;
  fat_g: string | null;
  fiber_g: string | null;
  sodium_mg: string | null;
  health_score: number | null;
  health_grade: string | null;
  health_reasons: HealthReason[] | null;
  instructions: string[];
  pantry_coverage: number | null;
  missing_note: string | null;
  image_url: string | null;
  image_status: string;
  created_at: Date;
};

const SUGGESTED_MEALS_SELECT = `
  SELECT s.id, s.slot, s.title, s.description, s.cuisine, s.prep_minutes,
         s.servings, s.calories, s.protein_g, s.carbs_g, s.fat_g, s.fiber_g,
         s.sodium_mg, s.health_score, s.health_grade, s.health_reasons,
         s.instructions, s.pantry_coverage, s.missing_note, s.image_url,
         s.image_status, s.created_at
    FROM suggested_meals s`;

const ALL_SLOTS: Slot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * Pure read for the Meals tab — never generates. "Suggested for you" is
 * precomputed by regenerateSuggestedMeals() whenever the pantry actually
 * changes (see triggerSuggestedMealsRegen), so opening the tab is always
 * just this SELECT.
 */
export async function readSuggestedMeals(userId: string, slot: Slot): Promise<SuggestedMealRow[]> {
  return query<SuggestedMealRow>(
    `${SUGGESTED_MEALS_SELECT}
      WHERE s.user_id = $1 AND s.slot = $2
      ORDER BY s.pantry_coverage DESC NULLS LAST, s.health_score DESC NULLS LAST
      LIMIT 12`,
    [userId, slot]
  );
}

export async function getSuggestedMeal(
  userId: string,
  id: string
): Promise<(SuggestedMealRow & { ingredients: SuggestionWithIngredients['ingredients'] }) | null> {
  const row = await queryOne<SuggestedMealRow>(
    `${SUGGESTED_MEALS_SELECT} WHERE s.user_id = $1 AND s.id = $2`,
    [userId, id]
  );
  if (!row) return null;

  const ingredients = await query<{
    name: string;
    quantity: string | null;
    display_unit: string | null;
    from_pantry: boolean;
  }>(
    `SELECT name, quantity, display_unit, from_pantry
       FROM suggested_meal_ingredients
      WHERE suggestion_id = $1
      ORDER BY from_pantry DESC, name`,
    [id]
  );

  return { ...row, ingredients };
}

/**
 * Regenerates the full "Suggested for you" set — all four slots at once, so
 * opening the tab at any time of day is a plain read — and replaces the
 * prior set in one transaction. Self-claiming: a burst of pantry-changing
 * events (several receipts syncing back to back) collapses to one run
 * rather than N concurrent ones. Call via triggerSuggestedMealsRegen from a
 * write path, not directly.
 */
export async function regenerateSuggestedMeals(userId: string): Promise<void> {
  const claimed = await queryOne<{ user_id: string }>(
    `INSERT INTO suggested_meals_regen (user_id, status, claimed_at)
     VALUES ($1, 'running', now())
     ON CONFLICT (user_id) DO UPDATE
       SET status = 'running', claimed_at = now()
       WHERE suggested_meals_regen.status <> 'running'
          OR suggested_meals_regen.claimed_at < now() - interval '10 minutes'
     RETURNING user_id`,
    [userId]
  );
  // Another run already claimed the lock recently — nothing to do.
  if (!claimed) return;

  try {
    const [prefs, pantry, familiarDishes] = await Promise.all([
      getPreferences(userId),
      pantryLines(userId),
      frequentlyLoggedTitles(userId),
    ]);

    const perSlot = await Promise.all(
      ALL_SLOTS.map((slot) =>
        suggestMealsForNow({
          slot,
          pantry,
          cuisines: prefs.cuisines,
          equipment: prefs.equipment,
          dietaryNotes: prefs.dietary_notes,
          maxCookMinutes: prefs.max_cook_minutes,
          count: 5,
          familiarDishes,
        })
      )
    );

    await transaction(async (client) => {
      await client.query(`DELETE FROM suggested_meals WHERE user_id = $1`, [userId]);

      for (const { meals, model } of perSlot) {
        for (const meal of meals) {
          const rating = rateMeal({
            calories: meal.calories,
            protein_g: meal.protein_g,
            carbs_g: meal.carbs_g,
            fat_g: meal.fat_g,
            fiber_g: meal.fiber_g,
            sugar_added_g: meal.sugar_added_g,
            sat_fat_g: meal.sat_fat_g,
            sodium_mg: meal.sodium_mg,
            serving_grams: meal.serving_grams,
            processing_level: meal.processing_level,
            slot: meal.slot,
          });

          const { resolved, coverage } = await resolveIngredientsAgainstPantry(
            client,
            userId,
            meal.ingredients ?? []
          );

          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO suggested_meals
               (user_id, slot, title, description, cuisine, prep_minutes,
                servings, calories, protein_g, carbs_g, fat_g, fiber_g,
                sugar_added_g, sat_fat_g, sodium_mg, serving_grams,
                processing_level, health_score, health_grade, health_reasons,
                instructions, pantry_coverage, missing_note, model)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                     $17,$18,$19,$20::jsonb,$21,$22,$23,$24)
             RETURNING id`,
            [
              userId,
              meal.slot,
              meal.title,
              meal.description,
              meal.cuisine,
              Math.round(meal.prep_minutes ?? 0),
              Math.max(1, Math.round(meal.servings ?? 1)),
              meal.calories,
              meal.protein_g,
              meal.carbs_g,
              meal.fat_g,
              meal.fiber_g,
              meal.sugar_added_g,
              meal.sat_fat_g,
              meal.sodium_mg,
              meal.serving_grams,
              Math.max(1, Math.min(4, Math.round(meal.processing_level ?? 2))),
              rating.score,
              rating.band,
              JSON.stringify(rating.reasons),
              meal.instructions ?? [],
              coverage,
              meal.missing_note ?? null,
              model,
            ]
          );

          const suggestionId = rows[0].id;

          for (const ingredient of resolved) {
            await client.query(
              `INSERT INTO suggested_meal_ingredients
                 (suggestion_id, name, match_key, quantity, display_unit,
                  canonical_amount, canonical_unit, from_pantry, matched_pantry_item_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                suggestionId,
                ingredient.name,
                ingredient.matchKey,
                ingredient.quantity,
                ingredient.unit,
                ingredient.canonicalAmount,
                ingredient.canonicalUnit,
                ingredient.fromPantry,
                ingredient.matchedPantryItemId,
              ]
            );
          }
        }
      }
    });
  } finally {
    await query(
      `UPDATE suggested_meals_regen SET status = 'idle', updated_at = now() WHERE user_id = $1`,
      [userId]
    ).catch(() => undefined);
  }
}

/**
 * Fires regeneration in the background after the current request finishes
 * responding (next/server's after()), so a pantry-changing write path stays
 * fast and the caller never waits on a model call. Call this from every
 * write path that actually changes what's on the shelf — never on a timer,
 * never when the Meals tab opens.
 */
export function triggerSuggestedMealsRegen(userId: string): void {
  after(() => {
    regenerateSuggestedMeals(userId).catch((err) => {
      console.error('[suggestions] background regeneration failed', err);
      return query(
        `UPDATE suggested_meals_regen SET status = 'idle', updated_at = now() WHERE user_id = $1`,
        [userId]
      ).catch(() => undefined);
    });
  });
}

/**
 * Input-keyed cache key for "Build your own" — a hash of the normalized
 * pantry snapshot, equipment, and constraints. Identical requests against an
 * unchanged pantry produce the same key and hit cache instead of paying for
 * another model call; any change to either input produces a different key,
 * so stale entries simply become unreachable rather than needing explicit
 * invalidation.
 */
function cacheKeyForCustomMeals(
  pantry: PantryLine[],
  equipment: string[],
  constraints: CustomMealConstraints
): string {
  const payload = JSON.stringify({
    pantry: pantry
      .map((p) => `${p.name.toLowerCase()}|${p.brand?.toLowerCase() ?? ''}|${p.quantity}|${p.unit}`)
      .sort(),
    equipment: [...equipment].map((e) => e.toLowerCase()).sort(),
    constraints: {
      freeText: constraints.freeText?.trim().toLowerCase() || null,
      dietary: [...(constraints.dietary ?? [])].map((d) => d.toLowerCase()).sort(),
      calorieTarget: constraints.calorieTarget ?? null,
      proteinTarget: constraints.proteinTarget ?? null,
      carbsTarget: constraints.carbsTarget ?? null,
      fatTarget: constraints.fatTarget ?? null,
      cuisine: constraints.cuisine?.toLowerCase() ?? null,
      maxMinutes: constraints.maxMinutes ?? null,
      usePantryOnly: constraints.usePantryOnly ?? true,
    },
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function generateCustom(
  userId: string,
  constraints: CustomMealConstraints,
  count = 3
): Promise<SuggestionRow[]> {
  const prefs = await getPreferences(userId);
  const pantry = await pantryLines(userId);
  const cacheKey = cacheKeyForCustomMeals(pantry, prefs.equipment, constraints);

  const cached = await queryOne<{ suggestion_ids: string[] }>(
    `SELECT suggestion_ids FROM custom_meal_cache WHERE user_id = $1 AND cache_key = $2`,
    [userId, cacheKey]
  );
  if (cached?.suggestion_ids.length) {
    const rows = await query<SuggestionRow>(
      `${SUGGESTION_SELECT} WHERE s.user_id = $1 AND s.id = ANY($2::uuid[])
        ORDER BY s.health_score DESC NULLS LAST`,
      [userId, cached.suggestion_ids]
    );
    // Guards against a cache row surviving after its suggestions were
    // somehow removed — falls through to a fresh generation instead of
    // returning an empty result for what looked like a cache hit.
    if (rows.length) return rows;
  }

  const { meals, model } = await generateCustomMeals({
    constraints,
    pantry,
    equipment: prefs.equipment,
    count,
  });

  const ids = await persistMeals({
    userId,
    meals,
    model,
    source: 'custom',
    constraints,
  });

  if (!ids.length) return [];

  await query(
    `INSERT INTO custom_meal_cache (user_id, cache_key, suggestion_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, cache_key) DO UPDATE SET suggestion_ids = $3, created_at = now()`,
    [userId, cacheKey, ids]
  );

  return query<SuggestionRow>(
    `${SUGGESTION_SELECT} WHERE s.user_id = $1 AND s.id = ANY($2::uuid[])
      ORDER BY s.health_score DESC NULLS LAST`,
    [userId, ids]
  );
}

/** Cuisine rows change less often than time-of-day suggestions — nothing here is slot-specific. */
const CUISINE_ROW_TTL_HOURS = 24;

/**
 * Meal options in one cuisine, built from the pantry — the source for each
 * "Italian" / "Mexican" / etc. row on the Meals tab. Cached per user+cuisine
 * like suggestionsForNow(), so browsing the tab repeatedly in one day doesn't
 * re-spend a model call per row per visit.
 */
/** Cache-only read — never generates. Used where paying for a model call would be wrong. */
async function cachedCuisineRow(
  userId: string,
  cuisine: string,
  count: number
): Promise<SuggestionRow[]> {
  return query<SuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE s.user_id = $1 AND s.source = 'cuisine_row' AND s.cuisine = $2
        AND s.created_at > now() - ($3 || ' hours')::interval
      ORDER BY s.pantry_coverage DESC NULLS LAST, s.created_at DESC
      LIMIT $4`,
    [userId, cuisine, CUISINE_ROW_TTL_HOURS, count]
  );
}

/**
 * Cache-only cuisine rows for every cuisine in the user's preferences, with
 * the same "nothing makeable from the pantry" filter the live API route
 * applies — for meals/page.tsx's server render, which must never pay for a
 * cuisine-row generation itself (that can take 60+ seconds cold; the whole
 * point of rendering the page server-side is to paint instantly). Passed
 * down as MealsView's initial data so the client only fetches
 * /api/suggestions/cuisine-rows (which *is* allowed to generate) on the
 * genuinely-empty first use, not on every remount — see MealsView.tsx.
 */
export async function cachedCuisineRowsForUser(
  userId: string,
  count = 6
): Promise<{ cuisine: string; suggestions: SuggestionRow[] }[]> {
  const prefs = await getPreferences(userId);
  if (!prefs.cuisines.length) return [];

  const rows = await Promise.all(
    prefs.cuisines.map(async (cuisine) => ({
      cuisine,
      suggestions: await cachedCuisineRow(userId, cuisine, count),
    }))
  );

  return rows.filter((row) => row.suggestions.some((s) => (s.pantry_coverage ?? 0) > 0));
}

export async function suggestionsByCuisine(
  userId: string,
  cuisine: string,
  options: { force?: boolean; count?: number } = {}
): Promise<SuggestionRow[]> {
  const count = options.count ?? 6;

  if (!options.force) {
    const cached = await cachedCuisineRow(userId, cuisine, count);
    if (cached.length) return cached;
  }

  const [prefs, pantry] = await Promise.all([getPreferences(userId), pantryLines(userId)]);

  const { meals, model } = await generateCustomMeals({
    // Not pantry-only: a cuisine row should still show what's makeable-ish
    // in that style even if one or two ingredients need buying — the
    // "nothing makeable" cutoff is a pantry_coverage check the caller (the
    // cuisine-rows API route) applies afterward, not a hard generation rule.
    constraints: { cuisine, usePantryOnly: false },
    pantry,
    equipment: prefs.equipment,
    count,
  });

  // Clear the previous batch for this cuisine so the row does not accumulate.
  await query(
    `DELETE FROM meal_suggestions
      WHERE user_id = $1 AND source = 'cuisine_row' AND cuisine = $2`,
    [userId, cuisine]
  );

  await persistMeals({ userId, meals, model, source: 'cuisine_row', constraints: { cuisine } });

  return query<SuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE s.user_id = $1 AND s.source = 'cuisine_row' AND s.cuisine = $2
      ORDER BY s.pantry_coverage DESC NULLS LAST, s.created_at DESC
      LIMIT $3`,
    [userId, cuisine, count]
  );
}

const SUGGESTION_SELECT = `
  SELECT s.id, s.source, s.slot, s.title, s.description, s.cuisine,
         s.prep_minutes, s.servings, s.calories, s.protein_g, s.carbs_g,
         s.fat_g, s.fiber_g, s.sodium_mg, s.health_score, s.health_grade,
         s.health_reasons, s.instructions, s.pantry_coverage, s.photo_id,
         s.image_url, s.image_status, s.created_at
    FROM meal_suggestions s`;

export async function listSuggestions(
  userId: string,
  options: { source?: string; slot?: Slot; sinceHours?: number; limit?: number } = {}
): Promise<SuggestionRow[]> {
  const conditions = ['s.user_id = $1'];
  const params: unknown[] = [userId];

  if (options.source) {
    params.push(options.source);
    conditions.push(`s.source = $${params.length}`);
  }
  if (options.slot) {
    params.push(options.slot);
    conditions.push(`s.slot = $${params.length}`);
  }
  if (options.sinceHours) {
    params.push(options.sinceHours);
    conditions.push(`s.created_at > now() - ($${params.length} || ' hours')::interval`);
  }
  params.push(options.limit ?? 12);

  return query<SuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.pantry_coverage DESC NULLS LAST, s.created_at DESC
      LIMIT $${params.length}`,
    params
  );
}

export async function getSuggestion(
  userId: string,
  id: string
): Promise<SuggestionWithIngredients | null> {
  const row = await queryOne<SuggestionRow>(
    `${SUGGESTION_SELECT} WHERE s.user_id = $1 AND s.id = $2`,
    [userId, id]
  );
  if (!row) return null;

  const ingredients = await query<{
    name: string;
    quantity: string | null;
    display_unit: string | null;
    from_pantry: boolean;
  }>(
    `SELECT name, quantity, display_unit, from_pantry
       FROM meal_suggestion_ingredients
      WHERE suggestion_id = $1
      ORDER BY from_pantry DESC, name`,
    [id]
  );

  return { ...row, ingredients };
}
