import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { filesFromForm } from '@/lib/photos';
import { dailyTotals, logMealFromPhoto, todaysMeals } from '@/lib/meals';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Meal photo in, macros + pantry deductions out. */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const form = await request.formData();
    const [bytes] = await filesFromForm(form, 'photo', 1);

    const note = form.get('note');
    const meal = await logMealFromPhoto({
      userId,
      bytes,
      note: typeof note === 'string' && note.trim() ? note.trim() : null,
    });

    return NextResponse.json({ meal });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET() {
  try {
    const userId = await requireUserId();
    const [meals, totals] = await Promise.all([todaysMeals(userId), dailyTotals(userId)]);
    return NextResponse.json({ meals, totals });
  } catch (err) {
    return errorResponse(err);
  }
}
