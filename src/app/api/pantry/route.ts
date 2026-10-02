import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { query, transaction } from '@/lib/db';
import { applyDelta, ensurePantryItem } from '@/lib/pantry';
import { toCanonical } from '@/lib/units';
import { triggerSuggestedMealsRegen } from '@/lib/suggestions';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userId = await requireUserId();
    const items = await query(
      `SELECT id, name, brand, category, quantity, unit, display_unit, source,
              confidence, is_empty, days_since_seen, store_name,
              (nutrition IS NOT NULL) AS has_nutrition
         FROM pantry_overview
        WHERE user_id = $1
        ORDER BY is_empty, category NULLS LAST, name`,
      [userId]
    );
    return NextResponse.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Manual add — the escape hatch when the automation misses something. */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = (await request.json()) as {
      name?: string;
      quantity?: number;
      unit?: string;
      brand?: string;
      category?: string;
    };

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const canonical = toCanonical(body.quantity ?? 1, body.unit);

    const id = await transaction(async (client) => {
      const item = await ensurePantryItem(client, {
        userId,
        name,
        brand: body.brand ?? null,
        category: body.category ?? null,
        unit: canonical.unit,
        displayUnit: body.unit ?? null,
        source: 'manual',
        // The user typed it, so it outranks any model guess.
        confidence: 0.95,
      });

      await applyDelta({
        client,
        userId,
        pantryItemId: item.id,
        delta: canonical.amount,
        unit: item.unit,
        reason: 'restock',
        sourceType: 'user',
        note: 'manual add',
      });

      return item.id;
    });

    triggerSuggestedMealsRegen(userId);

    return NextResponse.json({ id });
  } catch (err) {
    return errorResponse(err);
  }
}
