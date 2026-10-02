import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { query, transaction } from '@/lib/db';
import { applyDelta } from '@/lib/pantry';
import { round, scaleNutrition, type CanonicalUnit, type NutritionPer100 } from '@/lib/units';
import { slotForHour } from '@/lib/suggestions';

export const runtime = 'nodejs';

type Selection = { pantry_item_id: string; amount: number };

/**
 * Logs a meal assembled by hand from pantry items.
 *
 * Shares the photo path's contract exactly: macros come from each product's
 * real per-100 nutrition where known, and the amounts are deducted from the
 * pantry ledger — so a hand-built meal keeps inventory as honest as a
 * photographed one.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = (await request.json()) as { items?: Selection[]; title?: string };

    const selections = (body.items ?? []).filter(
      (i) => i && typeof i.pantry_item_id === 'string' && Number(i.amount) > 0
    );
    if (!selections.length) {
      return NextResponse.json({ error: 'Add at least one item' }, { status: 400 });
    }

    const items = await query<{
      id: string;
      name: string;
      unit: CanonicalUnit;
      display_unit: string | null;
      nutrition: NutritionPer100 | null;
    }>(
      `SELECT id, name, unit, display_unit, nutrition
         FROM pantry_items
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND depleted_at IS NULL`,
      [userId, selections.map((s) => s.pantry_item_id)]
    );

    const byId = new Map(items.map((i) => [i.id, i]));
    const resolved = selections
      .map((sel) => ({ sel, item: byId.get(sel.pantry_item_id) }))
      .filter((r): r is { sel: Selection; item: (typeof items)[number] } => Boolean(r.item));

    if (!resolved.length) {
      return NextResponse.json({ error: 'None of those items are in your pantry' }, { status: 400 });
    }

    const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    let unknownMacros = 0;

    const lines = resolved.map(({ sel, item }) => {
      // Per-100 nutrition only applies to weight/volume amounts; a "1 can"
      // style count has no basis to scale against.
      const scalable = item.nutrition && (item.unit === 'g' || item.unit === 'ml');
      const macros = scalable
        ? scaleNutrition(item.nutrition as NutritionPer100, sel.amount)
        : null;

      if (!macros) unknownMacros += 1;
      else {
        totals.calories += macros.calories;
        totals.protein_g += macros.protein_g;
        totals.carbs_g += macros.carbs_g;
        totals.fat_g += macros.fat_g;
      }

      return { sel, item, macros };
    });

    const title = body.title?.trim() || 'Custom meal';

    const mealId = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO meal_logs
           (user_id, eaten_at, slot, title, description, calories, protein_g,
            carbs_g, fat_g, confidence, model, deducted_at)
         VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, 1.0, 'manual', now())
         RETURNING id`,
        [
          userId,
          slotForHour(new Date().getHours()),
          title,
          `Assembled from ${resolved.length} pantry item${resolved.length === 1 ? '' : 's'}`,
          round(totals.calories, 1),
          round(totals.protein_g, 1),
          round(totals.carbs_g, 1),
          round(totals.fat_g, 1),
        ]
      );
      const mealLogId = rows[0].id;

      for (const { sel, item, macros } of lines) {
        await client.query(
          `INSERT INTO meal_log_items
             (meal_log_id, name, quantity, display_unit, canonical_amount,
              canonical_unit, calories, protein_g, carbs_g, fat_g,
              matched_pantry_item_id, match_confidence, nutrition_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1.0,$12)`,
          [
            mealLogId,
            item.name,
            sel.amount,
            item.display_unit ?? item.unit,
            sel.amount,
            item.unit,
            macros?.calories ?? null,
            macros?.protein_g ?? null,
            macros?.carbs_g ?? null,
            macros?.fat_g ?? null,
            item.id,
            // The user picked this item explicitly, so it is a pantry product
            // even when we lack label data to scale macros from.
            'pantry_product',
          ]
        );

        await applyDelta({
          client,
          userId,
          pantryItemId: item.id,
          delta: -Math.abs(sel.amount),
          unit: item.unit,
          reason: 'consumption',
          sourceType: 'meal_log',
          sourceId: mealLogId,
          note: `${item.name} (manually assembled)`,
        });
      }

      return mealLogId;
    });

    return NextResponse.json({
      id: mealId,
      title,
      calories: round(totals.calories, 1),
      protein_g: round(totals.protein_g, 1),
      carbs_g: round(totals.carbs_g, 1),
      fat_g: round(totals.fat_g, 1),
      unknownMacros,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
