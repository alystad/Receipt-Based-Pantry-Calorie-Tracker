import { completeJson, objectSchema, s, type ImageInput } from './client';
import { env } from '../env';

/**
 * Vision calls: meal photos and bulk pantry scans.
 *
 * The meal call does double duty — it produces the macro log AND the pantry
 * deduction — so it is asked to match against a shortlist of the user's actual
 * pantry items. Matching at generation time is far more accurate than
 * string-matching a generic label like "chicken" afterwards.
 */

export type MealComponent = {
  name: string;
  pantry_match_key: string | null;
  match_confidence: number;
  estimated_quantity: number;
  estimated_unit: string;
  grams: number | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type MealAnalysis = {
  is_food: boolean;
  title: string;
  description: string;
  slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  confidence: number;
  components: MealComponent[];
};

const componentSchema = objectSchema({
  name: s.string,
  pantry_match_key: s.nullableString,
  match_confidence: s.number,
  estimated_quantity: s.number,
  estimated_unit: s.string,
  grams: s.nullableNumber,
  calories: s.number,
  protein_g: s.number,
  carbs_g: s.number,
  fat_g: s.number,
});

const mealSchema = objectSchema({
  is_food: s.boolean,
  title: s.string,
  description: s.string,
  slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
  confidence: s.number,
  components: { type: 'array', items: componentSchema },
});

const MEAL_SYSTEM = `You analyze a photo of a meal a person is about to eat.

Return one entry in "components" per distinguishable food, not per ingredient of
a sauce. Estimate the portion actually on the plate using visual cues (plate
diameter ~27cm, fork ~19cm, standard mug ~350ml).

Pantry matching: you are given the user's current pantry as a list of
"match_key | name | brand". If a component is plausibly one of those exact
products, set pantry_match_key to that key verbatim and set match_confidence
0-1. If it is clearly not from the pantry (restaurant food, something not
listed), set pantry_match_key to null and match_confidence 0.

- grams: the edible weight of that component in grams; null only for liquids
  you would rather express in ml via estimated_unit.
- estimated_quantity + estimated_unit: the portion in natural terms,
  e.g. 1.5 + "cup", 6 + "oz", 1 + "each".
- Macros are for the portion shown, not per 100g.
- confidence: overall confidence in the whole analysis.
- If the photo contains no food, set is_food false and return no components.`;

export async function analyzeMealPhoto(params: {
  dataUrl: string;
  pantryCandidates: { match_key: string; name: string; brand: string | null }[];
  note?: string | null;
}): Promise<{ analysis: MealAnalysis; model: string }> {
  const pantryList = params.pantryCandidates.length
    ? params.pantryCandidates
        .map((p) => `${p.match_key} | ${p.name}${p.brand ? ` | ${p.brand}` : ''}`)
        .join('\n')
    : '(pantry is empty — set every pantry_match_key to null)';

  const { data, model } = await completeJson<MealAnalysis>({
    model: env.visionModel,
    system: MEAL_SYSTEM,
    schemaName: 'meal_analysis',
    schema: mealSchema,
    maxTokens: 2500,
    images: [{ dataUrl: params.dataUrl, detail: 'high' }],
    user: [
      'Current pantry:',
      pantryList,
      params.note ? `\nUser note about this meal: ${params.note}` : '',
    ].join('\n'),
  });

  return { analysis: data, model };
}

// --- Bulk pantry scan (onboarding cold start) ------------------------------

export type ScannedItem = {
  name: string;
  brand: string | null;
  category: string | null;
  quantity: number;
  unit: string;
  package_size: number | null;
  package_unit: string | null;
  confidence: number;
};

export type PantryScanResult = { items: ScannedItem[]; notes: string };

const scanItemSchema = objectSchema({
  name: s.string,
  brand: s.nullableString,
  category: s.nullableString,
  quantity: s.number,
  unit: s.string,
  package_size: s.nullableNumber,
  package_unit: s.nullableString,
  confidence: s.number,
});

const scanSchema = objectSchema({
  items: { type: 'array', items: scanItemSchema },
  notes: s.string,
});

const SCAN_SYSTEM = `You are bootstrapping a user's digital pantry from wide-angle
photos of their pantry shelves, fridge, and cabinets.

Goal is broad coverage, not perfection — roughly 70-80% of visible items is a
success. Later grocery receipts and meal photos will correct the rest.

- List every distinct food or drink product you can identify, including ones
  where you can only read part of the label.
- name: plain lowercase product name, no brand, no size ("black beans",
  "olive oil", "greek yogurt").
- quantity: how many of that product you can see. If several photos show what
  is obviously the same shelf, do not double count.
- unit: how it is packaged ("can", "box", "bottle", "bag", "each").
- package_size + package_unit: only if a size is legible on the label.
- confidence: 0-1. Below 0.5 for items you are inferring from shape or a
  partially hidden label.
- Skip non-food items, cookware, and appliances.
- notes: one sentence on what was hard to see, shown to the user as a hint for
  a better photo.`;

export async function scanPantryPhotos(
  dataUrls: string[]
): Promise<{ result: PantryScanResult; model: string }> {
  const images: ImageInput[] = dataUrls.map((dataUrl) => ({ dataUrl, detail: 'high' }));

  const { data, model } = await completeJson<PantryScanResult>({
    model: env.visionModel,
    system: SCAN_SYSTEM,
    schemaName: 'pantry_scan',
    schema: scanSchema,
    maxTokens: 4000,
    images,
    user: `Identify the food items across these ${dataUrls.length} photo(s) of my kitchen storage.`,
  });

  return { result: data, model };
}

// --- Nutrition backfill ----------------------------------------------------

export type NutritionEstimate = {
  match_key: string;
  basis_unit: 'g' | 'ml';
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sodium_mg: number;
  confidence: number;
};

const nutritionSchema = objectSchema({
  items: {
    type: 'array',
    items: objectSchema({
      match_key: s.string,
      basis_unit: { type: 'string', enum: ['g', 'ml'] },
      calories: s.number,
      protein_g: s.number,
      carbs_g: s.number,
      fat_g: s.number,
      fiber_g: s.number,
      sodium_mg: s.number,
      confidence: s.number,
    }),
  },
});

/**
 * Fills in per-100g/ml nutrition for pantry products. Run once per new product
 * so meal logging can use real label data instead of a generic estimate.
 */
export async function estimateNutrition(
  products: { match_key: string; name: string; brand: string | null }[]
): Promise<{ items: NutritionEstimate[]; model: string }> {
  const { data, model } = await completeJson<{ items: NutritionEstimate[] }>({
    model: env.textModel,
    system: `You provide nutrition facts per 100 g (solids) or per 100 ml (liquids)
for packaged and fresh grocery products. Use the actual product label when you
know the brand; otherwise use USDA reference values for the generic food.
Echo back the exact match_key you were given for every item.`,
    schemaName: 'nutrition_table',
    schema: nutritionSchema,
    maxTokens: 3000,
    user: products
      .map((p) => `${p.match_key} | ${p.name}${p.brand ? ` | brand: ${p.brand}` : ''}`)
      .join('\n'),
  });

  return { items: data.items, model };
}
