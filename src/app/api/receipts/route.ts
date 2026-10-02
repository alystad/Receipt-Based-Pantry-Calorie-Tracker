import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

/** Receipt history, newest first, with the line-item count. */
export async function GET() {
  try {
    const userId = await requireUserId();
    const receipts = await query(
      `SELECT r.id, r.email_subject, r.email_received_at, r.purchased_at,
              r.total_cents, r.status, r.parse_error, s.name AS store_name,
              COUNT(i.id)::int AS item_count
         FROM receipts r
         LEFT JOIN stores s ON s.id = r.store_id
         LEFT JOIN receipt_items i ON i.receipt_id = r.id
        WHERE r.user_id = $1
        GROUP BY r.id, s.name
        ORDER BY COALESCE(r.purchased_at, r.email_received_at) DESC NULLS LAST
        LIMIT 50`,
      [userId]
    );
    return NextResponse.json({ receipts });
  } catch (err) {
    return errorResponse(err);
  }
}
