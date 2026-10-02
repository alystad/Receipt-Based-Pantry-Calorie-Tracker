'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import MealCard, { type SuggestionView } from './MealCard';
import MealBuilder, { type BuilderItem } from './MealBuilder';

type Mode = 'suggested' | 'build';
type BuildPath = 'pantry' | 'describe';
type CuisineRow = { cuisine: string; suggestions: SuggestionView[] };

const CUISINES = ['italian', 'french', 'mexican', 'japanese', 'indian', 'thai', 'american', 'mediterranean'];
const DIETARY = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'low-carb', 'halal', 'kosher'];

export default function MealsView({
  initialSuggestions,
  initialCuisineRows,
  slotLabel,
  pantryItems,
}: {
  initialSuggestions: SuggestionView[];
  initialCuisineRows: CuisineRow[];
  slotLabel: string;
  pantryItems: BuilderItem[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('suggested');
  const [buildPath, setBuildPath] = useState<BuildPath>('pantry');

  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cuisine rows now arrive as real server data (meals/page.tsx reads the
  // cache directly — see cachedCuisineRowsForUser), the same way the
  // suggestions rail above already worked. This used to fetch
  // unconditionally on every mount, which meant every single revisit to this
  // tab re-paid for it: ~2s on a warm per-cuisine cache, 60+ SECONDS on a
  // cold one, because a client component genuinely remounts on tab-away-
  // and-back navigation even when the server's own RSC payload was served
  // from cache — that server-side cache was never able to protect a
  // client-triggered fetch living inside it. Only fetching when the server
  // truly had nothing cached (empty array, not just "haven't checked yet")
  // fixes that at the source instead of layering another cache on top.
  const [cuisineRows, setCuisineRows] = useState<CuisineRow[]>(initialCuisineRows);
  const [cuisineRowsLoading, setCuisineRowsLoading] = useState(initialCuisineRows.length === 0);
  const cuisineRowsTriggered = useRef(false);

  // A plain re-read of the precomputed set — never generates. Suggested for
  // you only changes when the pantry does, via a background job kicked off
  // from the write path; this just checks whether that job has landed yet.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/suggestions', { method: 'POST' });
      const data = (await res.json()) as { suggestions?: SuggestionView[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Could not load suggestions');
      setSuggestions(data.suggestions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load suggestions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The empty-array check is what actually matters here — it means the
    // server looked and genuinely found nothing cached, not merely "this
    // particular mount hasn't asked yet" (that was the bug: a ref-based
    // guard resets on every remount, so it never prevented anything across
    // tab switches, only within one already-mounted instance).
    if (initialCuisineRows.length || cuisineRowsTriggered.current) return;
    cuisineRowsTriggered.current = true;

    fetch('/api/suggestions/cuisine-rows')
      .then((r) => r.json())
      .then((data: { rows?: CuisineRow[] }) => setCuisineRows(data.rows ?? []))
      .catch(() => setCuisineRows([]))
      .finally(() => setCuisineRowsLoading(false));
  }, [initialCuisineRows.length]);

  const open = (id: string) => router.push(`/meals/${id}`);

  return (
    <>
      <div className="segmented" role="group" aria-label="Meal mode">
        <button aria-pressed={mode === 'suggested'} onClick={() => setMode('suggested')}>
          Suggested
        </button>
        <button aria-pressed={mode === 'build'} onClick={() => setMode('build')}>
          Build your own
        </button>
      </div>

      {mode === 'suggested' ? (
        <>
          {/* --- personalized row, biased toward what they actually log --- */}
          <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
            <div>
              <h2 style={{ margin: 0 }}>Suggested for you</h2>
              <p className="tiny muted" style={{ margin: 0 }}>
                {slotLabel} · built around what is in your pantry
              </p>
            </div>
            <button className="btn btn-sm" onClick={refresh} disabled={loading}>
              {loading ? <span className="spinner" /> : '↻'}
            </button>
          </div>

          {error && <div className="banner">{error}</div>}

          {loading && !suggestions.length ? (
            <div className="empty">
              <span className="spinner" style={{ marginRight: 8 }} />
              Checking for suggestions…
            </div>
          ) : suggestions.length ? (
            <div className="rail">
              {suggestions.map((s) => (
                <MealCard key={s.id} suggestion={s} onOpen={open} imageEndpoint="/api/suggested-meals" />
              ))}
            </div>
          ) : (
            <div className="empty">
              No suggestions yet — they’ll appear here once your pantry has something in it.
              <br />
              <button className="btn" style={{ marginTop: 'var(--space-2)' }} onClick={refresh}>
                Check again
              </button>
            </div>
          )}

          {/* --- cuisine rows: only the styles the pantry can actually make --- */}
          {cuisineRowsLoading ? (
            <div className="empty" style={{ marginTop: 'var(--space-3)' }}>
              <span className="spinner" style={{ marginRight: 8 }} />
              Looking for cuisines your pantry can make…
            </div>
          ) : (
            cuisineRows.map((row) => (
              <section key={row.cuisine} style={{ marginTop: 'var(--space-4)' }}>
                {/* h2's own top margin is meant for prose flow; the section
                    above already sets the gap before each row. */}
                <h2 style={{ margin: '0 0 var(--space-1)', textTransform: 'capitalize' }}>
                  {row.cuisine}
                </h2>
                <div className="rail">
                  {row.suggestions.map((s) => (
                    <MealCard key={s.id} suggestion={s} onOpen={open} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      ) : (
        <>
          <div className="segmented" role="group" aria-label="How to build">
            <button aria-pressed={buildPath === 'pantry'} onClick={() => setBuildPath('pantry')}>
              Pick from pantry
            </button>
            <button aria-pressed={buildPath === 'describe'} onClick={() => setBuildPath('describe')}>
              Describe it
            </button>
          </div>

          {buildPath === 'pantry' ? (
            <MealBuilder items={pantryItems} />
          ) : (
            <ConstraintForm onOpen={open} />
          )}
        </>
      )}
    </>
  );
}

/** Path (b): describe constraints, let the model propose meals. */
function ConstraintForm({ onOpen }: { onOpen: (id: string) => void }) {
  const [freeText, setFreeText] = useState('');
  const [dietary, setDietary] = useState<string[]>([]);
  const [cuisine, setCuisine] = useState('');
  const [calorieTarget, setCalorieTarget] = useState('');
  const [proteinTarget, setProteinTarget] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [pantryOnly, setPantryOnly] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SuggestionView[]>([]);

  const toggle = (value: string) =>
    setDietary((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/suggestions/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          freeText,
          dietary,
          cuisine: cuisine || null,
          calorieTarget: calorieTarget ? Number(calorieTarget) : null,
          proteinTarget: proteinTarget ? Number(proteinTarget) : null,
          maxMinutes: maxMinutes ? Number(maxMinutes) : null,
          usePantryOnly: pantryOnly,
        }),
      });
      const data = (await res.json()) as { suggestions?: SuggestionView[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Could not generate meals');
      setResults(data.suggestions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate meals');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <label htmlFor="free-text">What are you after?</label>
        <textarea
          id="free-text"
          rows={3}
          value={freeText}
          placeholder="Something high protein I can eat cold at my desk"
          onChange={(e) => setFreeText(e.target.value)}
          style={{ height: 'auto', padding: 'var(--space-1) var(--space-2)', resize: 'vertical' }}
        />

        <label style={{ marginTop: 'var(--space-2)' }}>Dietary restrictions</label>
        <div className="chips">
          {DIETARY.map((d) => (
            <button
              key={d}
              type="button"
              className="chip"
              aria-pressed={dietary.includes(d)}
              onClick={() => toggle(d)}
            >
              {d}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-1)', marginTop: 'var(--space-2)' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="kcal">Calories</label>
            <input
              id="kcal"
              type="number"
              inputMode="numeric"
              placeholder="600"
              value={calorieTarget}
              onChange={(e) => setCalorieTarget(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="protein">Protein (g)</label>
            <input
              id="protein"
              type="number"
              inputMode="numeric"
              placeholder="40"
              value={proteinTarget}
              onChange={(e) => setProteinTarget(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="mins">Max min</label>
            <input
              id="mins"
              type="number"
              inputMode="numeric"
              placeholder="20"
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
            />
          </div>
        </div>

        <label htmlFor="cuisine" style={{ marginTop: 'var(--space-2)' }}>
          Cuisine
        </label>
        <select id="cuisine" value={cuisine} onChange={(e) => setCuisine(e.target.value)}>
          <option value="">Any</option>
          {CUISINES.map((c) => (
            <option key={c} value={c} style={{ textTransform: 'capitalize' }}>
              {c}
            </option>
          ))}
        </select>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            marginTop: 'var(--space-2)',
            color: 'var(--text)',
            fontSize: 15,
          }}
        >
          <input
            type="checkbox"
            checked={pantryOnly}
            onChange={(e) => setPantryOnly(e.target.checked)}
            style={{ width: 24, height: 24, flexShrink: 0 }}
          />
          Only use what I already have
        </label>

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 'var(--space-2)' }}
          onClick={generate}
          disabled={busy}
        >
          {busy ? <span className="spinner" /> : null}
          {busy ? 'Thinking…' : 'Generate meals'}
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      {results.length > 0 && (
        <>
          <h2>Your options</h2>
          <div className="rail">
            {results.map((s) => (
              <MealCard key={s.id} suggestion={s} onOpen={onOpen} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

