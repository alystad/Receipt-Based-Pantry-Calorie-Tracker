import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/session';

export const runtime = 'nodejs';

/**
 * Clears the cookie session, for a cookie-based client. A mobile client
 * authenticated with a bearer token has nothing server-side to revoke — it
 * logs out by discarding the token from SecureStore — but calling this is
 * harmless either way.
 */
export async function POST() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
