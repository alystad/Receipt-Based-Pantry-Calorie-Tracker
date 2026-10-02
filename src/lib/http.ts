import { NextResponse } from 'next/server';
import { UnauthorizedError } from './session';
import { NotFoodError } from './meals';
import { NotAReceiptError } from './capture';

/** Maps thrown errors onto consistent API responses. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  if (err instanceof NotFoodError || err instanceof NotAReceiptError) {
    return NextResponse.json({ error: err.message }, { status: 422 });
  }

  const message = err instanceof Error ? err.message : 'Unexpected error';
  console.error('[api]', err);

  // Surface the "reconnect Gmail" case; it is actionable by the user.
  if (/Gmail is not connected|refresh token/i.test(message)) {
    return NextResponse.json({ error: message, reconnect: true }, { status: 409 });
  }

  return NextResponse.json({ error: message }, { status: 500 });
}
