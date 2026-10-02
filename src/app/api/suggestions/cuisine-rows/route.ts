import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { errorResponse } from '@/lib/http';
import { getPreferences } from '@/lib/plans';
import { suggestionsByCuisine, type SuggestionRow } from '@/lib/suggestions';

export const runtime = 'nodejs';
export const maxDuration = 120;

export type CuisineRow = { cuisine: string; suggestions: SuggestionRow[] };

/**
 * One horizontally-scrollable row per cuisine the user actually likes
 * (user_preferences.cuisines, set at onboarding or in Profile), built from
 * their pantry. A cuisine is only included if the pantry actually supports
 * at least one of its generated options — see the pantry_coverage filter
 * below — so "Italian" doesn't show up as an empty promise when the pantry
 * has nothing Italian-shaped in it.
 *
 * Cuisines are generated in parallel: each is an independent model call
 * (suggestionsByCuisine has its own per-cuisine cache/TTL), so there is no
 * reason to pay for them serially.
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    const prefs = await getPreferences(userId);

    if (!prefs.cuisines.length) {
      return NextResponse.json({ rows: [] satisfies CuisineRow[] });
    }

    const results = await Promise.all(
      prefs.cuisines.map(async (cuisine) => {
        try {
          const suggestions = await suggestionsByCuisine(userId, cuisine);
          return { cuisine, suggestions };
        } catch (err) {
          // One cuisine failing (e.g. a single bad model response) should
          // not take down the other rows.
          console.error(`[cuisine-rows] ${cuisine} failed`, err);
          return { cuisine, suggestions: [] as SuggestionRow[] };
        }
      })
    );

    // "Nothing makeable in that style from current pantry items": every
    // option came back with zero pantry coverage — buy-everything results
    // don't count as "makeable", so the row is dropped rather than shown as
    // an empty-feeling wall of shopping lists.
    const rows: CuisineRow[] = results.filter((row) =>
      row.suggestions.some((s) => (s.pantry_coverage ?? 0) > 0)
    );

    return NextResponse.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
