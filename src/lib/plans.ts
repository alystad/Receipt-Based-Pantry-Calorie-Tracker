import { query, queryOne, transaction } from './db';
import { generateMealPlan, phraseForStore, type PlanRequest } from './ai/planner';
import { classifyAisles } from './ai/aisle-classify';
import { aisleMapFor, resolveAisle } from './aisle-map';
import { matchKey, round, toCanonical, type CanonicalUnit } from './units';
import { convertToItemUnit } from './pantry';

/** Monday of the week containing `date`, as a YYYY-MM-DD string. */
export function weekStart(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((dayOfWeek + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export type Preferences = {
  cuisines: string[];
  equipment: string[];
  dietary_notes: string[];
  meals_per_day: number;
  servings_per_meal: number;
  max_cook_minutes: number;
  daily_calorie_target: number | null;
  daily_protein_target_g: number | null;
  daily_carbs_target_g: number | null;
  daily_fat_target_g: number | null;
  preferred_store_id: string | null;
};

export async function getPreferences(userId: string): Promise<Preferences> {
  const row = await queryOne<Preferences>(
    `SELECT cuisines, equipment, dietary_notes, meals_per_day, servings_per_meal,
            max_cook_minutes, daily_calorie_target, daily_protein_target_g,
            daily_carbs_target_g, daily_fat_target_g, preferred_store_id
       FROM user_preferences WHERE user_id = $1`,
    [userId]
  );

  return (
    row ?? {
      cuisines: [], equipment: [], dietary_notes: [],
      meals_per_day: 3, servings_per_meal: 1, max_cook_minutes: 30,
      daily_calorie_target: null, daily_protein_target_g: null,
      daily_carbs_target_g: null, daily_fat_target_g: null,
      preferred_store_id: null,
    }
  );
}

/**
 * The store the list should be written for: an explicit preference, otherwise
 * whichever store the user's receipts came from most often. Naming and package
 * sizes are store-specific, so this is not cosmetic.
 */
export async function resolveStore(
  userId: string,
  preferredStoreId: string | null
): Promise<{ id: string | null; name: string; slug: string | null }> {
  if (preferredStoreId) {
    const row = await queryOne<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM stores WHERE id = $1`,
      [preferredStoreId]
    );
    if (row) return row;
  }

  const inferred = await queryOne<{ id: string; name: string; slug: string }>(
    `SELECT s.id, s.name, s.slug
       FROM receipts r
       JOIN stores s ON s.id = r.store_id
      WHERE r.user_id = $1 AND r.status = 'parsed'
      GROUP BY s.id, s.name, s.slug
      ORDER BY COUNT(*) DESC
      LIMIT 1`,
    [userId]
  );

  return inferred ?? { id: null, name: 'your usual grocery store', slug: null };
}

export async function createMealPlan(
  userId: string,
  options: { days?: number } = {}
): Promise<string> {
  const days = options.days ?? 7;
  const prefs = await getPreferences(userId);

  const pantry = await query<{
    name: string;
    brand: string | null;
    quantity: string;
    unit: CanonicalUnit;
  }>(
    `SELECT name, brand, quantity, unit
       FROM pantry_items
      WHERE user_id = $1 AND depleted_at IS NULL AND quantity > 0
      ORDER BY category NULLS LAST, name
      LIMIT 150`,
    [userId]
  );

  const request: PlanRequest = {
    pantry: pantry.map((p) => ({
      name: p.name,
      brand: p.brand,
      quantity: round(Number(p.quantity), 1),
      unit: p.unit,
    })),
    cuisines: prefs.cuisines,
    equipment: prefs.equipment,
    mealsPerDay: prefs.meals_per_day,
    servingsPerMeal: prefs.servings_per_meal,
    maxCookMinutes: prefs.max_cook_minutes,
    dietaryNotes: prefs.dietary_notes,
    dailyCalorieTarget: prefs.daily_calorie_target,
    dailyProteinTarget: prefs.daily_protein_target_g,
    days,
  };

  const { plan, model } = await generateMealPlan(request);
  const week = weekStart();

  return transaction(async (client) => {
    // Regenerating replaces the week rather than stacking duplicates.
    await client.query(`DELETE FROM meal_plans WHERE user_id = $1 AND week_start_date = $2`, [
      userId,
      week,
    ]);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO meal_plans (user_id, week_start_date, cuisines, equipment, status, model)
       VALUES ($1,$2,$3,$4,'parsed',$5) RETURNING id`,
      [userId, week, prefs.cuisines, prefs.equipment, model]
    );
    const planId = rows[0].id;

    for (const recipe of plan.recipes) {
      const { rows: recipeRows } = await client.query<{ id: string }>(
        `INSERT INTO meal_plan_recipes
           (meal_plan_id, day_index, slot, title, cuisine, equipment, servings,
            total_minutes, instructions, nutrition, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         RETURNING id`,
        [
          planId,
          Math.max(0, Math.min(6, Math.round(recipe.day_index))),
          recipe.slot,
          recipe.title,
          recipe.cuisine,
          recipe.equipment,
          recipe.servings,
          recipe.total_minutes,
          recipe.instructions,
          JSON.stringify({
            calories: recipe.calories,
            protein_g: recipe.protein_g,
            carbs_g: recipe.carbs_g,
            fat_g: recipe.fat_g,
          }),
          recipe.notes,
        ]
      );
      const recipeId = recipeRows[0].id;

      for (const ingredient of recipe.ingredients) {
        const canonical = toCanonical(ingredient.quantity, ingredient.unit);
        await client.query(
          `INSERT INTO meal_plan_ingredients
             (recipe_id, name, match_key, quantity, display_unit,
              canonical_amount, canonical_unit, covered_by_pantry, matched_pantry_item_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                   (SELECT id FROM pantry_items
                     WHERE user_id = $9 AND match_key = $3 AND depleted_at IS NULL))`,
          [
            recipeId,
            ingredient.name,
            matchKey(ingredient.name),
            ingredient.quantity,
            ingredient.unit,
            canonical.amount,
            canonical.unit,
            ingredient.from_pantry,
            userId,
          ]
        );
      }
    }

    return planId;
  });
}

// --- Grocery list ----------------------------------------------------------

type Shortfall = {
  name: string;
  match_key: string;
  needed: number;
  unit: CanonicalUnit;
  recipes: string[];
};

/**
 * Compares the plan against live pantry quantities and writes the gap.
 *
 * Note this recomputes coverage from current stock rather than trusting the
 * planner's from_pantry flag — the user may have eaten something since the
 * plan was generated, and the ledger knows that.
 */
export async function buildGroceryList(userId: string, planId: string): Promise<string> {
  const ingredients = await query<{
    name: string;
    match_key: string;
    canonical_amount: string | null;
    canonical_unit: CanonicalUnit | null;
    recipe_title: string;
    pantry_quantity: string | null;
    pantry_unit: CanonicalUnit | null;
    pantry_package_size: string | null;
  }>(
    `SELECT i.name, i.match_key, i.canonical_amount, i.canonical_unit,
            r.title AS recipe_title,
            p.quantity AS pantry_quantity, p.unit AS pantry_unit,
            p.package_size AS pantry_package_size
       FROM meal_plan_ingredients i
       JOIN meal_plan_recipes r ON r.id = i.recipe_id
       LEFT JOIN pantry_items p
              ON p.user_id = $1 AND p.match_key = i.match_key AND p.depleted_at IS NULL
      WHERE r.meal_plan_id = $2`,
    [userId, planId]
  );

  // Aggregate demand per product across the whole week first, so buying one
  // onion covers three recipes.
  const needed = new Map<string, Shortfall>();

  for (const row of ingredients) {
    const amount = Number(row.canonical_amount ?? 0);
    const unit = row.canonical_unit ?? 'count';
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const existing = needed.get(row.match_key);
    if (existing) {
      // Different units for the same product: convert into the first one seen.
      const converted = convertToItemUnit(amount, unit, {
        unit: existing.unit,
        package_size: row.pantry_package_size ? Number(row.pantry_package_size) : null,
      });
      existing.needed += converted.amount;
      if (!existing.recipes.includes(row.recipe_title)) existing.recipes.push(row.recipe_title);
    } else {
      needed.set(row.match_key, {
        name: row.name,
        match_key: row.match_key,
        needed: amount,
        unit,
        recipes: [row.recipe_title],
      });
    }
  }

  // Subtract what is actually on the shelf right now.
  const stock = new Map(
    ingredients
      .filter((r) => r.pantry_quantity != null)
      .map((r) => [
        r.match_key,
        {
          quantity: Number(r.pantry_quantity),
          unit: r.pantry_unit ?? 'count',
          package_size: r.pantry_package_size ? Number(r.pantry_package_size) : null,
        },
      ])
  );

  const shortfalls: Shortfall[] = [];
  for (const item of needed.values()) {
    const have = stock.get(item.match_key);
    if (!have || have.quantity <= 0) {
      shortfalls.push(item);
      continue;
    }

    const available = convertToItemUnit(have.quantity, have.unit, {
      unit: item.unit,
      package_size: have.package_size,
    });

    const gap = item.needed - available.amount;
    // 5% tolerance: do not send someone to the store for a missing gram.
    if (gap > item.needed * 0.05) {
      shortfalls.push({ ...item, needed: round(gap, 2) });
    }
  }

  const store = await resolveStore(userId, (await getPreferences(userId)).preferred_store_id);
  const aisleMap = aisleMapFor(store.slug);

  // Turn amounts into buyable packages named the way this store names them,
  // and separately work out which real aisle/section each one lives in.
  // Two independent AI calls, run together — one failing should not sink the
  // other, so each gets its own try/catch rather than a shared one.
  let lines: Awaited<ReturnType<typeof phraseForStore>>['lines'] = [];
  let classifications: Awaited<ReturnType<typeof classifyAisles>>['classifications'] = [];

  if (shortfalls.length) {
    const [phraseResult, aisleResult] = await Promise.allSettled([
      phraseForStore({
        storeName: store.name,
        items: shortfalls.map((s) => ({
          name: s.name,
          quantity: round(s.needed, 2),
          unit: s.unit,
        })),
      }),
      classifyAisles(
        shortfalls.map((s) => ({ name: s.name })),
        aisleMap
      ),
    ]);

    if (phraseResult.status === 'fulfilled') {
      lines = phraseResult.value.lines;
    } else {
      // A failed phrasing call should still produce a usable list.
      console.error('[grocery-list] store phrasing failed', phraseResult.reason);
    }

    if (aisleResult.status === 'fulfilled') {
      classifications = aisleResult.value.classifications;
    } else {
      // Same: no aisle numbers is a degraded list, not a broken one — items
      // just fall into the unclassified group (see GroceryList.tsx).
      console.error('[grocery-list] aisle classification failed', aisleResult.reason);
    }
  }

  const byName = new Map(lines.map((l) => [l.input_name.toLowerCase(), l]));
  const aisleByName = new Map(classifications.map((c) => [c.name.toLowerCase(), c.category]));

  return transaction(async (client) => {
    await client.query(`DELETE FROM grocery_lists WHERE user_id = $1 AND meal_plan_id = $2`, [
      userId,
      planId,
    ]);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO grocery_lists (user_id, meal_plan_id, store_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [userId, planId, store.id]
    );
    const listId = rows[0].id;

    for (const item of shortfalls) {
      const line = byName.get(item.name.toLowerCase());
      const category = aisleByName.get(item.name.toLowerCase());
      const location = category ? resolveAisle(aisleMap, category) : null;

      await client.query(
        `INSERT INTO grocery_list_items
           (grocery_list_id, name, match_key, category, quantity, display_unit,
            suggested_package, estimated_price_cents, needed_for,
            aisle_number, aisle_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          listId,
          item.name,
          item.match_key,
          line?.aisle_category ?? null,
          round(item.needed, 2),
          item.unit,
          line?.suggested_package ?? null,
          line?.estimated_price_cents ?? null,
          item.recipes,
          location?.kind === 'aisle' ? location.number : null,
          location?.kind === 'aisle' ? location.category : (location?.kind === 'perimeter' ? location.section : null),
        ]
      );
    }

    return listId;
  });
}

// --- Reads -----------------------------------------------------------------

export async function currentPlan(userId: string) {
  const plan = await queryOne<{ id: string; week_start_date: string; created_at: Date }>(
    `SELECT id, week_start_date, created_at
       FROM meal_plans
      WHERE user_id = $1
      ORDER BY week_start_date DESC, created_at DESC
      LIMIT 1`,
    [userId]
  );
  if (!plan) return null;

  const recipes = await query(
    `SELECT r.id, r.day_index, r.slot, r.title, r.cuisine, r.equipment, r.servings,
            r.total_minutes, r.instructions, r.nutrition, r.notes,
            COALESCE(
              json_agg(
                json_build_object(
                  'name', i.name,
                  'quantity', i.quantity,
                  'unit', i.display_unit,
                  'covered_by_pantry', (i.matched_pantry_item_id IS NOT NULL)
                ) ORDER BY i.name
              ) FILTER (WHERE i.id IS NOT NULL), '[]'
            ) AS ingredients
       FROM meal_plan_recipes r
       LEFT JOIN meal_plan_ingredients i ON i.recipe_id = r.id
      WHERE r.meal_plan_id = $1
      GROUP BY r.id
      ORDER BY r.day_index, r.slot`,
    [plan.id]
  );

  const list = await queryOne<{ id: string; store_name: string | null }>(
    `SELECT g.id, s.name AS store_name
       FROM grocery_lists g
       LEFT JOIN stores s ON s.id = g.store_id
      WHERE g.user_id = $1 AND g.meal_plan_id = $2
      ORDER BY g.created_at DESC LIMIT 1`,
    [userId, plan.id]
  );

  const listItems = list
    ? await query(
        `SELECT id, name, category, quantity, display_unit, suggested_package,
                estimated_price_cents, needed_for, checked,
                aisle_number, aisle_category
           FROM grocery_list_items
          WHERE grocery_list_id = $1
          ORDER BY aisle_number NULLS LAST, aisle_category NULLS LAST, name`,
        [list.id]
      )
    : [];

  return { plan, recipes, list, listItems };
}
