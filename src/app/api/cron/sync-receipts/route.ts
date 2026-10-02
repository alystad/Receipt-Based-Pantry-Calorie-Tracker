import { NextResponse, type NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { env } from '@/lib/env';
import { syncReceiptsForUser } from '@/lib/receipt-sync';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Scheduled receipt ingestion (see vercel.json).
 *
 * This is the "zero friction" half of the product: the user never opens the
 * app for their pantry to stay current.
 */
export async function GET(request: NextRequest) {
  const authorization = request.headers.get('authorization');
  if (!env.cronSecret || authorization !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const users = await query<{ user_id: string }>(
    `SELECT user_id FROM google_accounts
      WHERE refresh_token IS NOT NULL
      ORDER BY last_synced_at ASC NULLS FIRST
      LIMIT 50`
  );

  const summary: Record<string, unknown>[] = [];

  for (const { user_id } of users) {
    try {
      // The stored cursor bounds the window; the cron only caps how many
      // messages one run will look at.
      const result = await syncReceiptsForUser(user_id, { maxMessages: 10 });
      summary.push({ user_id, ...result });
    } catch (err) {
      summary.push({ user_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ users: users.length, summary });
}
