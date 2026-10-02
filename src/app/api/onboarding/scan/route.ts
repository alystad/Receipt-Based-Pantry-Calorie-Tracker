import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { filesFromForm, savePhoto, toDataUrl } from '@/lib/photos';
import { scanPantryPhotos } from '@/lib/ai/vision';
import { applyDelta, backfillNutrition, ensurePantryItem } from '@/lib/pantry';
import { toCanonical } from '@/lib/units';
import { query, transaction } from '@/lib/db';
import { triggerSuggestedMealsRegen } from '@/lib/suggestions';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_PHOTOS = 6;

/**
 * Cold-start bootstrap: a handful of wide shots of the pantry, fridge and
 * cabinets become a rough inventory. Accuracy is explicitly best-effort —
 * receipts and meal photos correct it from here on, so scanned items are
 * written at low confidence and can be overwritten by any receipt sighting.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const form = await request.formData();
    const buffers = await filesFromForm(form, 'photos', MAX_PHOTOS);

    const photoIds: string[] = [];
    for (const bytes of buffers) {
      photoIds.push(await savePhoto({ userId, kind: 'pantry_scan', bytes }));
    }

    const { result, model } = await scanPantryPhotos(buffers.map((b) => toDataUrl(b)));

    const added = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pantry_scans (user_id, photo_id, status, model, items_found, raw_response)
         VALUES ($1,$2,'parsed',$3,$4,$5::jsonb) RETURNING id`,
        [userId, photoIds[0] ?? null, model, result.items.length, JSON.stringify(result)]
      );
      const scanId = rows[0].id;

      let count = 0;
      for (const item of result.items) {
        if (!item.name?.trim()) continue;

        const canonical = item.package_size && item.package_unit
          ? toCanonical(item.package_size, item.package_unit)
          : toCanonical(1, item.unit);

        const pantryItem = await ensurePantryItem(client, {
          userId,
          name: item.name,
          brand: item.brand,
          category: item.category,
          // A photo tells you how many packages are on the shelf, not their
          // contents, so scans track in `count` unless a size was legible.
          unit: 'count',
          displayUnit: item.unit,
          packageSize: item.package_size && item.package_unit ? canonical.amount : null,
          source: 'photo_scan',
          // Capped below receipt confidence so a receipt always wins.
          confidence: Math.min(item.confidence, 0.7),
        });

        await applyDelta({
          client,
          userId,
          pantryItemId: pantryItem.id,
          delta: Math.max(1, item.quantity || 1),
          unit: pantryItem.unit,
          reason: 'onboarding_scan',
          sourceType: 'pantry_scan',
          sourceId: scanId,
          note: item.brand ? `${item.name} (${item.brand})` : item.name,
        });

        count += 1;
      }
      return count;
    });

    await query(
      `UPDATE users SET onboarded_at = COALESCE(onboarded_at, now()), updated_at = now()
        WHERE id = $1`,
      [userId]
    );

    if (added > 0) triggerSuggestedMealsRegen(userId);

    // Nutrition for the new items, so the first meal photo can already use
    // real per-product data. Failure here is not fatal to onboarding.
    let nutritionFilled = 0;
    try {
      nutritionFilled = await backfillNutrition(userId, 30);
    } catch (err) {
      console.error('[onboarding/scan] nutrition backfill failed', err);
    }

    return NextResponse.json({
      itemsAdded: added,
      photos: photoIds.length,
      nutritionFilled,
      notes: result.notes,
      items: result.items,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
