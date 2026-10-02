import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { loadPhoto } from '@/lib/photos';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Serves a stored photo. Scoped to the owner — no public photo URLs. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const photo = await loadPhoto(userId, id);

    if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return new NextResponse(new Uint8Array(photo.bytes), {
      headers: {
        'Content-Type': photo.mime_type,
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
