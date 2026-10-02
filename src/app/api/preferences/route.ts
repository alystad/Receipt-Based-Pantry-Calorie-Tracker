import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { query, queryOne } from '@/lib/db';
import { getPreferences } from '@/lib/plans';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userId = await requireUserId();
    const [preferences, stores] = await Promise.all([
      getPreferences(userId),
      query(`SELECT id, slug, name FROM stores ORDER BY name`),
    ]);
    return NextResponse.json({ preferences, stores });
  } catch (err) {
    return errorResponse(err);
  }
}

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

export async function PUT(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = (await request.json()) as Record<string, unknown>;
    const existing = await getPreferences(userId);

    /**
     * A goal field is only changed when the client actually sends the key.
     * Sending it as null clears the goal (falling back to the derived split),
     * while omitting it leaves the stored value alone — so the goals form can
     * blank a field without a separate "clear" action.
     */
    const goal = (key: string, min: number, max: number, current: number | null) => {
      if (!(key in body)) return current;
      const raw = body[key];
      if (raw == null || raw === '') return null;
      return clamp(raw, min, max, current ?? min);
    };

    const updated = await queryOne(
      `INSERT INTO user_preferences
         (user_id, cuisines, equipment, dietary_notes, meals_per_day,
          servings_per_meal, max_cook_minutes, daily_calorie_target,
          daily_protein_target_g, daily_carbs_target_g, daily_fat_target_g,
          preferred_store_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (user_id) DO UPDATE SET
         cuisines               = EXCLUDED.cuisines,
         equipment              = EXCLUDED.equipment,
         dietary_notes          = EXCLUDED.dietary_notes,
         meals_per_day          = EXCLUDED.meals_per_day,
         servings_per_meal      = EXCLUDED.servings_per_meal,
         max_cook_minutes       = EXCLUDED.max_cook_minutes,
         daily_calorie_target   = EXCLUDED.daily_calorie_target,
         daily_protein_target_g = EXCLUDED.daily_protein_target_g,
         daily_carbs_target_g   = EXCLUDED.daily_carbs_target_g,
         daily_fat_target_g     = EXCLUDED.daily_fat_target_g,
         preferred_store_id     = EXCLUDED.preferred_store_id,
         updated_at             = now()
       RETURNING *`,
      [
        userId,
        body.cuisines ? asArray(body.cuisines) : existing.cuisines,
        body.equipment ? asArray(body.equipment) : existing.equipment,
        body.dietary_notes ? asArray(body.dietary_notes) : existing.dietary_notes,
        clamp(body.meals_per_day, 1, 6, existing.meals_per_day),
        clamp(body.servings_per_meal, 1, 12, existing.servings_per_meal),
        clamp(body.max_cook_minutes, 5, 240, existing.max_cook_minutes),
        goal('daily_calorie_target', 800, 6000, existing.daily_calorie_target),
        goal('daily_protein_target_g', 20, 400, existing.daily_protein_target_g),
        goal('daily_carbs_target_g', 0, 800, existing.daily_carbs_target_g),
        goal('daily_fat_target_g', 0, 300, existing.daily_fat_target_g),
        'preferred_store_id' in body
          ? ((body.preferred_store_id as string | null) ?? null)
          : existing.preferred_store_id,
      ]
    );

    return NextResponse.json({ preferences: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
