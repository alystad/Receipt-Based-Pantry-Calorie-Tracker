import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { ensureDishImage, dishImagesEnabled } from '@/lib/ai/dish-image';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/**
 * Lazily resolves a dish photo for one suggestion — cache hit, stock photo,
 * or AI generation, in that order (see lib/ai/dish-image.ts). Called per-card
 * as it becomes visible, so suggestions the user never scrolls to cost
 * nothing.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    if (!dishImagesEnabled()) {
      return NextResponse.json({ image_url: null, disabled: true });
    }

    const imageUrl = await ensureDishImage({ suggestionId: id, userId });
    return NextResponse.json({ image_url: imageUrl });
  } catch (err) {
    return errorResponse(err);
  }
}
