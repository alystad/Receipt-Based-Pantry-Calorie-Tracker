import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { filesFromForm } from '@/lib/photos';
import { processCapturedPhoto } from '@/lib/capture';
import type { PhotoKind } from '@/lib/ai/classify';

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * The floating "+" button's single entry point: one photo in, classified and
 * routed to the receipt or meal pipeline automatically — see lib/capture.ts.
 *
 * `forceKind` lets the client resubmit the same photo after the user
 * corrects a wrong auto-classification ("Not a receipt? Log as meal
 * instead"), without asking them to retake it.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const form = await request.formData();
    const [bytes] = await filesFromForm(form, 'photo', 1);

    const note = form.get('note');
    const forceKindRaw = form.get('forceKind');
    const forceKind =
      forceKindRaw === 'receipt' || forceKindRaw === 'meal' ? (forceKindRaw as PhotoKind) : undefined;

    const result = await processCapturedPhoto({
      userId,
      bytes,
      note: typeof note === 'string' && note.trim() ? note.trim() : null,
      forceKind,
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
