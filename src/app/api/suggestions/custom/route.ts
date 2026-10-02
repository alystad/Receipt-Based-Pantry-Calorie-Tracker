import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { generateCustom } from '@/lib/suggestions';
import type { CustomMealConstraints } from '@/lib/ai/suggestions';

export const runtime = 'nodejs';
export const maxDuration = 120;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const asNumber = (value: unknown, min: number, max: number): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
};

/** "Build your own" — AI meals generated against user constraints. */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = (await request.json()) as Record<string, unknown>;

    const freeText = typeof body.freeText === 'string' ? body.freeText.trim().slice(0, 600) : null;

    const constraints: CustomMealConstraints = {
      freeText: freeText || null,
      dietary: asStringArray(body.dietary),
      calorieTarget: body.calorieTarget == null ? null : asNumber(body.calorieTarget, 100, 3000),
      proteinTarget: body.proteinTarget == null ? null : asNumber(body.proteinTarget, 0, 300),
      carbsTarget: body.carbsTarget == null ? null : asNumber(body.carbsTarget, 0, 500),
      fatTarget: body.fatTarget == null ? null : asNumber(body.fatTarget, 0, 200),
      cuisine: typeof body.cuisine === 'string' && body.cuisine ? body.cuisine : null,
      maxMinutes: body.maxMinutes == null ? null : asNumber(body.maxMinutes, 5, 240),
      usePantryOnly: Boolean(body.usePantryOnly),
    };

    const hasAnyConstraint =
      constraints.freeText ||
      constraints.dietary?.length ||
      constraints.calorieTarget ||
      constraints.proteinTarget ||
      constraints.cuisine;

    if (!hasAnyConstraint) {
      return NextResponse.json(
        { error: 'Describe what you want, or set at least one target.' },
        { status: 400 }
      );
    }

    const suggestions = await generateCustom(userId, constraints, 3);
    return NextResponse.json({ suggestions });
  } catch (err) {
    return errorResponse(err);
  }
}
