import { query, queryOne, transaction } from './db';
import { analyzeMealPhoto, type MealComponent } from './ai/vision';
import { savePhoto, toDataUrl } from './photos';
import { applyDelta, convertToItemUnit, pantryCandidates } from './pantry';
import { round, scaleNutrition, toCanonical, type CanonicalUnit, type NutritionPer100 } from './units';
import { triggerSuggestedMealsRegen } from './suggestions';

/**
 * Meal logging: one photo, three outcomes.
 *
 *   1. macros for the day
 *   2. a per-component breakdown that says where each number came from
 *   3. pantry deductions, so inventory stays true without manual upkeep
 *
 * Where a component matched a pantry product confidently, its macros are
 * recomputed from that product's real per-100g label data rather than the
 * model's eyeball estimate. That is the precision claim of the app, so the
 * source of every number is recorded on the row.
 */

type PantryMatch = {
  id: string;
  match_key: string;
  name: string;
  unit: CanonicalUnit;
  package_size: string | null;
  nutrition: NutritionPer100 | null;
};

const MATCH_THRESHOLD = 0.6;

export type LoggedMeal = {
  id: string;
  title: string;
  description: string;
  slot: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  confidence: number;
  photo_id: string;
  components: {
    name: string;
    quantity: number;
    unit: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    matched_item: string | null;
    nutrition_source: 'pantry_product' | 'model_estimate';
  }[];
  deductions: { item: string; amount: number; unit: string; approximate: boolean }[];
};

export async function logMealFromPhoto(params: {
  userId: string;
  bytes: Buffer;
  mimeType?: string;
  note?: string | null;
  eatenAt?: Date;
}): Promise<LoggedMeal> {
  const { userId, bytes } = params;

  const candidates = await pantryCandidates(userId);
  const { analysis, model } = await analyzeMealPhoto({
    dataUrl: toDataUrl(bytes, params.mimeType),
    pantryCandidates: candidates,
    note: params.note ?? null,
  });

  if (!analysis.is_food) {
    throw new NotFoodError();
  }

  // Only stored once we know it is actually a meal.
  const photoId = await savePhoto({ userId, kind: 'meal', bytes, mimeType: params.mimeType });

  // Resolve the keys the model claimed against rows that really exist.
  const claimedKeys = analysis.components
    .map((c) => c.pantry_match_key)
    .filter((k): k is string => Boolean(k));

  const matches = claimedKeys.length
    ? await query<PantryMatch>(
        `SELECT id, match_key, name, unit, package_size, nutrition
           FROM pantry_items
          WHERE user_id = $1 AND match_key = ANY($2::text[]) AND depleted_at IS NULL`,
        [userId, claimedKeys]
      )
    : [];

  const byKey = new Map(matches.map((m) => [m.match_key, m]));

  const resolved = analysis.components.map((component) =>
    resolveComponent(component, byKey)
  );

  const totals = resolved.reduce(
    (acc, r) => ({
      calories: acc.calories + r.macros.calories,
      protein_g: acc.protein_g + r.macros.protein_g,
      carbs_g: acc.carbs_g + r.macros.carbs_g,
      fat_g: acc.fat_g + r.macros.fat_g,
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  );

  const deductions: LoggedMeal['deductions'] = [];

  const mealId = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO meal_logs
         (user_id, photo_id, eaten_at, slot, title, description, calories,
          protein_g, carbs_g, fat_g, confidence, model, analysis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       RETURNING id`,
      [
        userId,
        photoId,
        params.eatenAt ?? new Date(),
        analysis.slot,
        analysis.title,
        analysis.description,
        round(totals.calories, 1),
        round(totals.protein_g, 1),
        round(totals.carbs_g, 1),
        round(totals.fat_g, 1),
        Math.max(0, Math.min(1, analysis.confidence)),
        model,
        JSON.stringify(analysis),
      ]
    );
    const mealLogId = rows[0].id;

    for (const item of resolved) {
      await client.query(
        `INSERT INTO meal_log_items
           (meal_log_id, name, quantity, display_unit, canonical_amount, canonical_unit,
            calories, protein_g, carbs_g, fat_g, matched_pantry_item_id,
            match_confidence, nutrition_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          mealLogId,
          item.component.name,
          item.component.estimated_quantity,
          item.component.estimated_unit,
          item.canonical.amount,
          item.canonical.unit,
          round(item.macros.calories, 1),
          round(item.macros.protein_g, 1),
          round(item.macros.carbs_g, 1),
          round(item.macros.fat_g, 1),
          item.match?.id ?? null,
          item.component.match_confidence,
          item.nutritionSource,
        ]
      );

      // The passive-deduction step: consumption leaves the shelf here.
      if (item.match) {
        const converted = convertToItemUnit(item.canonical.amount, item.canonical.unit, {
          unit: item.match.unit,
          package_size: item.match.package_size == null ? null : Number(item.match.package_size),
        });

        await applyDelta({
          client,
          userId,
          pantryItemId: item.match.id,
          delta: -Math.abs(converted.amount),
          unit: item.match.unit,
          reason: 'consumption',
          sourceType: 'meal_log',
          sourceId: mealLogId,
          note: converted.approximate
            ? `${item.component.name} (approximate conversion)`
            : item.component.name,
        });

        deductions.push({
          item: item.match.name,
          amount: round(converted.amount, 2),
          unit: item.match.unit,
          approximate: converted.approximate,
        });
      }
    }

    await client.query(`UPDATE meal_logs SET deducted_at = now() WHERE id = $1`, [mealLogId]);
    return mealLogId;
  });

  // Only meal logs that actually deducted from the shelf change what the
  // pantry can make — no deductions means nothing for a regen to reflect.
  if (deductions.length > 0) triggerSuggestedMealsRegen(userId);

  return {
    id: mealId,
    title: analysis.title,
    description: analysis.description,
    slot: analysis.slot,
    calories: round(totals.calories, 1),
    protein_g: round(totals.protein_g, 1),
    carbs_g: round(totals.carbs_g, 1),
    fat_g: round(totals.fat_g, 1),
    confidence: analysis.confidence,
    photo_id: photoId,
    components: resolved.map((r) => ({
      name: r.component.name,
      quantity: r.component.estimated_quantity,
      unit: r.component.estimated_unit,
      calories: round(r.macros.calories, 1),
      protein_g: round(r.macros.protein_g, 1),
      carbs_g: round(r.macros.carbs_g, 1),
      fat_g: round(r.macros.fat_g, 1),
      matched_item: r.match?.name ?? null,
      nutrition_source: r.nutritionSource,
    })),
    deductions,
  };
}

function resolveComponent(component: MealComponent, byKey: Map<string, PantryMatch>) {
  const match =
    component.pantry_match_key && component.match_confidence >= MATCH_THRESHOLD
      ? (byKey.get(component.pantry_match_key) ?? null)
      : null;

  // Prefer an explicit gram weight; fall back to interpreting the natural
  // portion ("1.5 cup").
  const canonical =
    component.grams != null && component.grams > 0
      ? { amount: component.grams, unit: 'g' as CanonicalUnit }
      : toCanonical(component.estimated_quantity, component.estimated_unit);

  // Real label data beats an eyeball estimate — but only when the amount is in
  // a unit the per-100 basis actually applies to.
  const usePantryNutrition =
    match?.nutrition != null && (canonical.unit === 'g' || canonical.unit === 'ml');

  if (usePantryNutrition) {
    const scaled = scaleNutrition(match.nutrition as NutritionPer100, canonical.amount);
    return {
      component,
      match,
      canonical,
      nutritionSource: 'pantry_product' as const,
      macros: {
        calories: scaled.calories,
        protein_g: scaled.protein_g,
        carbs_g: scaled.carbs_g,
        fat_g: scaled.fat_g,
      },
    };
  }

  return {
    component,
    match,
    canonical,
    nutritionSource: 'model_estimate' as const,
    macros: {
      calories: component.calories,
      protein_g: component.protein_g,
      carbs_g: component.carbs_g,
      fat_g: component.fat_g,
    },
  };
}

export class NotFoodError extends Error {
  constructor() {
    super('No food detected in that photo');
    this.name = 'NotFoodError';
  }
}

// --- Reads -----------------------------------------------------------------

export async function todaysMeals(userId: string) {
  return query(
    `SELECT id, title, slot, eaten_at, calories, protein_g, carbs_g, fat_g,
            confidence, photo_id
       FROM meal_logs
      WHERE user_id = $1 AND eaten_at >= date_trunc('day', now())
      ORDER BY eaten_at DESC`,
    [userId]
  );
}

export async function dailyTotals(userId: string) {
  return queryOne<{
    calories: string | null;
    protein_g: string | null;
    carbs_g: string | null;
    fat_g: string | null;
    meals: string;
  }>(
    `SELECT COALESCE(SUM(calories),0) AS calories,
            COALESCE(SUM(protein_g),0) AS protein_g,
            COALESCE(SUM(carbs_g),0)   AS carbs_g,
            COALESCE(SUM(fat_g),0)     AS fat_g,
            COUNT(*)                   AS meals
       FROM meal_logs
      WHERE user_id = $1 AND eaten_at >= date_trunc('day', now())`,
    [userId]
  );
}
