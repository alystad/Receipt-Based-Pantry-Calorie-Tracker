import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { buildGroceryList, createMealPlan, currentPlan } from '@/lib/plans';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json((await currentPlan(userId)) ?? { plan: null });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Generates the week's plan and immediately derives the grocery list. */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json().catch(() => ({}) as { days?: number });
    const days = Math.max(1, Math.min(7, Number(body?.days) || 7));

    const planId = await createMealPlan(userId, { days });
    await buildGroceryList(userId, planId);

    return NextResponse.json(await currentPlan(userId));
  } catch (err) {
    return errorResponse(err);
  }
}
