import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { ensureDishImage, dishImagesEnabled } from '@/lib/ai/dish-image';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** Same lazy resolve-on-scroll flow as /api/suggestions/[id]/image, for the precomputed suggested_meals table. */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    if (!dishImagesEnabled()) {
      return NextResponse.json({ image_url: null, disabled: true });
    }

    const imageUrl = await ensureDishImage({ suggestionId: id, userId, table: 'suggested_meals' });
    return NextResponse.json({ image_url: imageUrl });
  } catch (err) {
    return errorResponse(err);
  }
}
