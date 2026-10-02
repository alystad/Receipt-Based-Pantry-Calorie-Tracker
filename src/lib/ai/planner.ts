import { completeJson, objectSchema, s } from './client';
import { env } from '../env';

/**
 * Meal planning + grocery list generation.
 *
 * The equipment constraint is a hard filter, not a preference: "microwave
 * only" has to mean every recipe is genuinely cookable in a microwave. That is
 * stated three times in the prompt because models otherwise drift back to
 * "sear in a skillet" by day four.
 */

export type PlannedIngredient = {
  name: string;
  quantity: number;
  unit: string;
  from_pantry: boolean;
};

export type PlannedRecipe = {
  day_index: number;
  slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  title: string;
  cuisine: string;
  equipment: string[];
  servings: number;
  total_minutes: number;
  instructions: string[];
  ingredients: PlannedIngredient[];
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  notes: string;
};

export type MealPlanResult = { recipes: PlannedRecipe[]; summary: string };

const ingredientSchema = objectSchema({
  name: s.string,
  quantity: s.number,
  unit: s.string,
  from_pantry: s.boolean,
});

const recipeSchema = objectSchema({
  day_index: s.number,
  slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
  title: s.string,
  cuisine: s.string,
  equipment: { type: 'array', items: s.string },
  servings: s.number,
  total_minutes: s.number,
  instructions: { type: 'array', items: s.string },
  ingredients: { type: 'array', items: ingredientSchema },
  calories: s.number,
  protein_g: s.number,
  carbs_g: s.number,
  fat_g: s.number,
  notes: s.string,
});

const planSchema = objectSchema({
  recipes: { type: 'array', items: recipeSchema },
  summary: s.string,
});

export type PlanRequest = {
  pantry: { name: string; brand: string | null; quantity: number; unit: string }[];
  cuisines: string[];
  equipment: string[];
  mealsPerDay: number;
  servingsPerMeal: number;
  maxCookMinutes: number;
  dietaryNotes: string[];
  dailyCalorieTarget: number | null;
  dailyProteinTarget: number | null;
  days: number;
};

export async function generateMealPlan(
  req: PlanRequest
): Promise<{ plan: MealPlanResult; model: string }> {
  const equipmentLine = req.equipment.length
    ? req.equipment.join(', ')
    : 'a full kitchen (stove, oven, microwave)';

  const system = `You are a meal planner that works from a real inventory.

HARD CONSTRAINT — EQUIPMENT: the user can cook using ONLY: ${equipmentLine}.
Every single recipe must be fully cookable with that equipment alone. Do not
use any other appliance at any step. If a dish normally needs a stove or oven
and the user does not have one available, either adapt it honestly or choose a
different dish. Re-check every instruction against the equipment list before
returning. No-cook assembly is always acceptable.

PANTRY FIRST: prefer ingredients the user already has. Mark those ingredients
from_pantry true, using the pantry item name verbatim. Ingredients they must
buy get from_pantry false. Aim for at least half of ingredients coming from the
pantry, but never at the cost of a dish that makes sense.

- day_index is 0-based from the start of the week; produce exactly
  ${req.mealsPerDay} meal(s) for each of ${req.days} days.
- Every recipe serves ${req.servingsPerMeal}.
- total_minutes must be <= ${req.maxCookMinutes}.
- instructions: 3-8 short imperative steps.
- Macros are per serving.
- notes: one short line, e.g. leftovers advice or a swap. Never empty.`;

  const user = [
    `Cuisine preferences: ${req.cuisines.length ? req.cuisines.join(', ') : 'no preference'}`,
    `Dietary notes: ${req.dietaryNotes.length ? req.dietaryNotes.join(', ') : 'none'}`,
    req.dailyCalorieTarget ? `Daily calorie target: ${req.dailyCalorieTarget}` : '',
    req.dailyProteinTarget ? `Daily protein target: ${req.dailyProteinTarget} g` : '',
    '',
    'Current pantry:',
    req.pantry.length
      ? req.pantry
          .map(
            (p) =>
              `- ${p.name}${p.brand ? ` (${p.brand})` : ''}: ${p.quantity} ${p.unit}`
          )
          .join('\n')
      : '(empty — plan from scratch and put everything on the grocery list)',
  ]
    .filter(Boolean)
    .join('\n');

  const { data, model } = await completeJson<MealPlanResult>({
    model: env.textModel,
    system,
    schemaName: 'meal_plan',
    schema: planSchema,
    maxTokens: 8000,
    temperature: 0.6,
    user,
  });

  return { plan: data, model };
}

// --- Grocery list phrasing -------------------------------------------------

export type StoreLine = {
  input_name: string;
  suggested_package: string;
  aisle_category: string;
  estimated_price_cents: number;
};

const storeLineSchema = objectSchema({
  items: {
    type: 'array',
    items: objectSchema({
      input_name: s.string,
      suggested_package: s.string,
      aisle_category: s.string,
      estimated_price_cents: s.number,
    }),
  },
});

/**
 * Rewrites generic shortfall names into how the item is actually sold at the
 * user's store. "200 g green beans" is not a thing you can buy; "Publix Green
 * Beans, 12 oz bag" is.
 */
export async function phraseForStore(params: {
  storeName: string;
  items: { name: string; quantity: number; unit: string }[];
}): Promise<{ lines: StoreLine[]; model: string }> {
  const { data, model } = await completeJson<{ items: StoreLine[] }>({
    model: env.textModel,
    system: `You convert needed ingredient amounts into concrete products a shopper
can put in a cart at ${params.storeName}.

- suggested_package: the smallest real package that covers the needed amount,
  named the way ${params.storeName} names it, including size.
  Example: "Publix Green Beans, 12 oz bag".
- aisle_category: produce, meat, seafood, dairy, bakery, frozen, pantry,
  beverage, snacks, household, or other.
- estimated_price_cents: typical US price in integer cents.
- Echo input_name back exactly as given.`,
    schemaName: 'store_lines',
    schema: storeLineSchema,
    maxTokens: 3000,
    user: params.items.map((i) => `${i.name} — need ${i.quantity} ${i.unit}`).join('\n'),
  });

  return { lines: data.items, model };
}
