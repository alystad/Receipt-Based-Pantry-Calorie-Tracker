import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { syncReceiptsForUser } from '@/lib/receipt-sync';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Manual "check my email now" trigger from the dashboard. */
export async function POST() {
  try {
    const userId = await requireUserId();
    const result = await syncReceiptsForUser(userId, { maxMessages: 15 });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
