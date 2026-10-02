import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { query, queryOne, transaction } from '@/lib/db';
import { applyDelta } from '@/lib/pantry';
import type { CanonicalUnit } from '@/lib/units';
import { triggerSuggestedMealsRegen } from '@/lib/suggestions';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * Quantity correction. Written as a balancing ledger entry rather than a
 * direct overwrite, so the history of what the automation got wrong survives.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = (await request.json()) as { quantity?: number };

    if (typeof body.quantity !== 'number' || body.quantity < 0) {
      return NextResponse.json({ error: 'quantity must be >= 0' }, { status: 400 });
    }

    const item = await queryOne<{ quantity: string; unit: CanonicalUnit }>(
      `SELECT quantity, unit FROM pantry_items WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const delta = body.quantity - Number(item.quantity);
    if (delta !== 0) {
      await transaction(async (client) => {
        await applyDelta({
          client,
          userId,
          pantryItemId: id,
          delta,
          unit: item.unit,
          reason: 'correction',
          sourceType: 'user',
          note: 'manual correction',
        });
      });
      triggerSuggestedMealsRegen(userId);
    }

    return NextResponse.json({ ok: true, quantity: body.quantity });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Soft delete: the item leaves the pantry view but its history stays. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const rows = await query(
      `UPDATE pantry_items SET depleted_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    triggerSuggestedMealsRegen(userId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
