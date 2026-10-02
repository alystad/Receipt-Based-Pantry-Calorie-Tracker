import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { readSuggestedMeals, slotForHour } from '@/lib/suggestions';

export const runtime = 'nodejs';

/**
 * Pure read of the precomputed "Suggested for you" set — never generates.
 * Regeneration happens only in the background, triggered by an actual
 * pantry change (see triggerSuggestedMealsRegen). Both verbs do the same
 * read; POST exists only because the client already calls it as a manual
 * "check again" after a background regen may have just finished.
 */
async function readCurrent() {
  const userId = await requireUserId();
  const slot = slotForHour(new Date().getHours());
  const suggestions = await readSuggestedMeals(userId, slot);
  return NextResponse.json({ slot, suggestions });
}

export async function GET() {
  try {
    return await readCurrent();
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST() {
  try {
    return await readCurrent();
  } catch (err) {
    return errorResponse(err);
  }
}
