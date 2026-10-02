import { completeJson, objectSchema, s } from './client';
import { env } from '../env';

/**
 * Meal suggestion generation.
 *
 * The model is asked for *facts* about each dish — macros, fiber, added sugar,
 * saturated fat, sodium, serving weight, processing level — and never for a
 * health rating. The grade is computed from those facts by
 * src/lib/health-rating.ts so the rubric is identical across every meal and
 * can be explained to the user.
 */

export type SuggestedIngredient = {
  name: string;
  quantity: number;
  unit: string;
  from_pantry: boolean;
};

export type SuggestedMeal = {
  title: string;
  description: string;
  cuisine: string;
  slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  prep_minutes: number;
  servings: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_added_g: number;
  sat_fat_g: number;
  sodium_mg: number;
  serving_grams: number;
  processing_level: number;
  instructions: string[];
  ingredients: SuggestedIngredient[];
  /** Short phrase describing the plated dish, used for image generation. */
  plating: string;
  /**
   * What the pantry can't fully cover, in the model's own words (e.g. "no
   * seasoning logged — season to taste"). Null when the pantry (plus
   * staples) covers the dish with nothing to flag.
   */
  missing_note: string | null;
};

const ingredientSchema = objectSchema({
  name: s.string,
  quantity: s.number,
  unit: s.string,
  from_pantry: s.boolean,
});

const mealSchema = objectSchema({
  title: s.string,
  description: s.string,
  cuisine: s.string,
  slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
  prep_minutes: s.number,
  servings: s.number,
  calories: s.number,
  protein_g: s.number,
  carbs_g: s.number,
  fat_g: s.number,
  fiber_g: s.number,
  sugar_added_g: s.number,
  sat_fat_g: s.number,
  sodium_mg: s.number,
  serving_grams: s.number,
  processing_level: s.number,
  instructions: { type: 'array', items: s.string },
  ingredients: { type: 'array', items: ingredientSchema },
  plating: s.string,
  missing_note: s.nullableString,
});

const responseSchema = objectSchema({
  meals: { type: 'array', items: mealSchema },
});

/**
 * The only ingredients ever assumed to be on hand without appearing in the
 * pantry list. Nothing else — no pre-existing staple assumption existed in
 * this codebase before this constant; it is deliberately small so "I have
 * chicken and rice" doesn't quietly become "I have a fully stocked spice
 * rack."
 */
export const STAPLES = ['salt', 'black pepper', 'cooking oil', 'water'];

const STAPLES_LINE = `Basic staples assumed to be on hand even if not listed: ${STAPLES.join(', ')}. Nothing else may be assumed — if a dish genuinely needs something else, either leave it out or say so in missing_note.`;

const PANTRY_ONLY_RULES = `HARD CONSTRAINT — PANTRY ONLY: every ingredient must be either in the
pantry list below or one of the staples. Do not invent ingredients the
pantry doesn't have.

${STAPLES_LINE}

HARD CONSTRAINT — QUANTITIES: never use more of a pantry ingredient than the
listed quantity. If the pantry only has 0.5 lb of chicken, no ingredient
line may call for more than 0.5 lb of chicken (across all uses in the dish).
Scale the recipe down, or pick a different dish, rather than exceeding stock.

If the pantry (plus staples) cannot fully cover a genuinely expected part of
the dish, do not silently assume it — either work within the limitation as
written, or set missing_note to a short phrase naming what's missing (e.g.
"no seasoning beyond salt/pepper logged — add what you have to taste").
Leave missing_note null when there is nothing to flag.`;

const FACTS_RULES = `For every dish report honest nutrition FACTS per serving:
- calories, protein_g, carbs_g, fat_g: macros for one serving.
- fiber_g, sugar_added_g, sat_fat_g, sodium_mg: needed to grade the dish.
  sugar_added_g means added sugar only, not sugar naturally in fruit or milk.
- serving_grams: total edible weight of one serving, used for calorie density.
- processing_level: 1 = whole/minimally processed ingredients cooked from
  scratch, 2 = mostly whole plus culinary staples (oil, flour, sugar),
  3 = noticeable processed components (canned sauce, deli meat, bread),
  4 = largely ultra-processed (instant noodles, frozen nuggets, packaged
  desserts). Judge the dish as a whole and be honest — do not flatter it.
- Do NOT rate healthiness. That is computed from these numbers elsewhere.
- instructions: 3-8 short imperative steps.
- plating: a short visual phrase describing how the finished dish looks on the
  plate, e.g. "golden seared salmon with charred broccoli on a white plate".
- Mark from_pantry true ONLY for ingredients that appear in the pantry list,
  using that pantry item's name verbatim.`;

export type PantryLine = { name: string; brand: string | null; quantity: number; unit: string };

function pantryBlock(pantry: PantryLine[]): string {
  if (!pantry.length) return '(pantry is empty — only the staples listed above are available)';
  return pantry
    .map((p) => `- ${p.name}${p.brand ? ` (${p.brand})` : ''}: ${p.quantity} ${p.unit}`)
    .join('\n');
}

/** Time-of-day suggestions built primarily from what is already on the shelf. */
export async function suggestMealsForNow(params: {
  slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  pantry: PantryLine[];
  cuisines: string[];
  equipment: string[];
  dietaryNotes: string[];
  maxCookMinutes: number;
  count: number;
  /** Dishes this user actually logs most often — a personalization nudge, not a filter. */
  familiarDishes?: string[];
}): Promise<{ meals: SuggestedMeal[]; model: string }> {
  const equipmentLine = params.equipment.length
    ? params.equipment.join(', ')
    : 'a full kitchen (stove, oven, microwave)';

  const system = `You suggest meals someone can make right now from their own pantry.

HARD CONSTRAINT — EQUIPMENT: only these are available: ${equipmentLine}. Every
dish must be fully cookable with that equipment alone. Re-check each step
before returning. No-cook assembly is always acceptable.

${PANTRY_ONLY_RULES}

Suggest ${params.count} DIFFERENT ${params.slot} options, all makeable from the
pantry as constrained above, and deliberately vary how healthy they are —
include at least one genuinely nutritious option and do not make every dish
look equally good. Keep prep at or under ${params.maxCookMinutes} minutes.
${
  params.familiarDishes?.length
    ? `\nThis person actually eats ${params.familiarDishes.join(', ')} most often — lean toward
similar flavors, formats, or ingredients where it fits, without just repeating
the exact same dishes every time.`
    : ''
}

${FACTS_RULES}`;

  const user = [
    `Meal: ${params.slot}`,
    `Cuisine preferences: ${params.cuisines.length ? params.cuisines.join(', ') : 'no preference'}`,
    `Dietary notes: ${params.dietaryNotes.length ? params.dietaryNotes.join(', ') : 'none'}`,
    '',
    'Pantry:',
    pantryBlock(params.pantry),
  ].join('\n');

  const { data, model } = await completeJson<{ meals: SuggestedMeal[] }>({
    model: env.textModel,
    system,
    user,
    schemaName: 'meal_suggestions',
    schema: responseSchema,
    maxTokens: 8000,
    temperature: 0.7,
  });

  return { meals: data.meals, model };
}

export type CustomMealConstraints = {
  freeText?: string | null;
  dietary?: string[];
  calorieTarget?: number | null;
  proteinTarget?: number | null;
  carbsTarget?: number | null;
  fatTarget?: number | null;
  cuisine?: string | null;
  maxMinutes?: number | null;
  usePantryOnly?: boolean;
};

/** "Build your own" — meals generated against user-supplied constraints. */
export async function generateCustomMeals(params: {
  constraints: CustomMealConstraints;
  pantry: PantryLine[];
  equipment: string[];
  count: number;
}): Promise<{ meals: SuggestedMeal[]; model: string }> {
  const c = params.constraints;
  const equipmentLine = params.equipment.length
    ? params.equipment.join(', ')
    : 'a full kitchen (stove, oven, microwave)';

  const targets = [
    c.calorieTarget ? `about ${c.calorieTarget} kcal per serving` : '',
    c.proteinTarget ? `at least ${c.proteinTarget}g protein per serving` : '',
    c.carbsTarget ? `around ${c.carbsTarget}g carbs per serving` : '',
    c.fatTarget ? `around ${c.fatTarget}g fat per serving` : '',
  ].filter(Boolean);

  const system = `You generate meal options that satisfy a user's stated constraints.

HARD CONSTRAINT — EQUIPMENT: only these are available: ${equipmentLine}. Every
dish must be fully cookable with that equipment alone.

${
  c.usePantryOnly
    ? `${PANTRY_ONLY_RULES}\n\nIf the pantry genuinely cannot support a dish even within these rules, return fewer meals rather than inventing ingredients.`
    : 'Prefer pantry ingredients, but a few bought items are acceptable. Leave missing_note null unless something is unusual to source.'
}

${
  targets.length
    ? `NUTRITION TARGETS (treat as firm, get within ~10%): ${targets.join('; ')}.`
    : ''
}
${c.dietary?.length ? `DIETARY RESTRICTIONS (absolute): ${c.dietary.join(', ')}.` : ''}
${c.cuisine ? `Cuisine: ${c.cuisine}.` : ''}
${c.maxMinutes ? `Maximum total time: ${c.maxMinutes} minutes.` : ''}

Generate ${params.count} distinct options.

${FACTS_RULES}`;

  const user = [
    c.freeText ? `What the user asked for: ${c.freeText}` : 'No extra notes.',
    '',
    'Pantry:',
    pantryBlock(params.pantry),
  ].join('\n');

  const { data, model } = await completeJson<{ meals: SuggestedMeal[] }>({
    model: env.textModel,
    system,
    user,
    schemaName: 'custom_meals',
    schema: responseSchema,
    maxTokens: 8000,
    temperature: 0.7,
  });

  return { meals: data.meals, model };
}
