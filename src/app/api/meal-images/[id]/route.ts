import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { queryOne } from '@/lib/db';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * Serves a cached AI-generated dish photo.
 *
 * Deliberately NOT owner-scoped like /api/photos/[id] — these are the
 * meal-image *cache*'s whole point: one render, reused across every
 * suggestion and every user who gets the same dish, not tied to whoever
 * happened to trigger the original generation. Still requires a signed-in
 * app session (no public URLs), and is hard-scoped to kind = 'dish_render' so
 * this relaxed route can never serve a user's private meal-log or
 * pantry-scan photo, only the shared dish renders it was built for.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { id } = await params;

    const photo = await queryOne<{ bytes: Buffer; mime_type: string }>(
      `SELECT bytes, mime_type FROM photos WHERE id = $1 AND kind = 'dish_render'`,
      [id]
    );
    if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return new NextResponse(new Uint8Array(photo.bytes), {
      headers: {
        'Content-Type': photo.mime_type,
        // Public-cacheable: unlike a private photo this same URL is valid
        // for every viewer, so a CDN/browser can cache it once, not per-user.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
