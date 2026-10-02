import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

type Params = { params: Promise<{ itemId: string }> };

/** Tick an item off while shopping. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { itemId } = await params;
    const body = (await request.json()) as { checked?: boolean };

    const rows = await query(
      `UPDATE grocery_list_items i
          SET checked = $3
         FROM grocery_lists g
        WHERE i.id = $1 AND i.grocery_list_id = g.id AND g.user_id = $2
        RETURNING i.id, i.checked`,
      [itemId, userId, Boolean(body.checked)]
    );
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json(rows[0]);
  } catch (err) {
    return errorResponse(err);
  }
}
