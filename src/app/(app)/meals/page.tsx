import { getCurrentUser } from '@/lib/session';
import { query } from '@/lib/db';
import { cachedCuisineRowsForUser, readSuggestedMeals, slotForHour, slotLabel } from '@/lib/suggestions';
import MealsView from '@/components/MealsView';
import type { BuilderItem } from '@/components/MealBuilder';
import type { SuggestionView } from '@/components/MealCard';

export const dynamic = 'force-dynamic';

/**
 * Meals tab.
 *
 * "Suggested for you" is a plain read of suggested_meals — precomputed by
 * regenerateSuggestedMeals() whenever the pantry actually changes (receipt
 * parsed, camera capture, manual edit), never generated here. A brand-new
 * user with no pantry-change event fired yet just sees an empty state, not a
 * generation trigger — see src/lib/suggestions.ts.
 *
 * Cuisine rows are the one thing here still generated client-side on a cache
 * miss (see MealsView) — generating them server-side would make a cold cache
 * block the page for 60+ seconds before anything painted.
 */
export default async function MealsPage() {
  const user = (await getCurrentUser())!;
  const slot = slotForHour(new Date().getHours());

  const [suggestions, cuisineRows, pantry] = await Promise.all([
    readSuggestedMeals(user.id, slot),
    cachedCuisineRowsForUser(user.id),
    query<BuilderItem>(
      `SELECT id, name, brand, category, quantity, unit, display_unit, nutrition
         FROM pantry_items
        WHERE user_id = $1 AND depleted_at IS NULL AND quantity > 0
        ORDER BY last_seen_at DESC
        LIMIT 200`,
      [user.id]
    ),
  ]);

  return (
    <main className="shell">
      {/* Tab bar already reads "Meals"; no subtitle either — the suggested
          rail and the build-your-own toggle explain themselves. */}
      <h1 className="sr-only">Meals</h1>

      <MealsView
        initialSuggestions={suggestions as unknown as SuggestionView[]}
        initialCuisineRows={cuisineRows as unknown as { cuisine: string; suggestions: SuggestionView[] }[]}
        slotLabel={slotLabel(slot)}
        pantryItems={pantry}
      />
    </main>
  );
}

