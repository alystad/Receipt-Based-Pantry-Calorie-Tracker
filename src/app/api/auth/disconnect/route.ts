import { NextResponse } from 'next/server';
import { requireUserId, UnauthorizedError } from '@/lib/session';
import { revokeAccess } from '@/lib/google';

export const runtime = 'nodejs';

/** Revokes the Gmail grant and forgets the tokens; the account itself stays. */
export async function POST() {
  try {
    const userId = await requireUserId();
    await revokeAccess(userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }
    console.error('[auth/disconnect]', err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
