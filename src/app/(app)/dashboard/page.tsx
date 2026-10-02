import Link from 'next/link';
import { getCurrentUser } from '@/lib/session';
import { getPreferences } from '@/lib/plans';
import { currentStreak, recentActivity, weekTotals, localDayKey } from '@/lib/dashboard';
import { dailyTargets } from '@/lib/nutrition-targets';
import ProgressRing from '@/components/ProgressRing';
import WeekStrip from '@/components/WeekStrip';
import RecentUploads from '@/components/RecentUploads';
import Greeting from '@/components/Greeting';

export const dynamic = 'force-dynamic';

/**
 * Home — the Cal AI-style dashboard.
 *
 * Every number here comes from Postgres: totals are summed from meal_logs,
 * targets from user_preferences (with a documented fallback split), the streak
 * from logged days, and the feed from meal_logs + parsed receipts.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  // The layout already guards auth; this is for the typed user fields.
  const user = (await getCurrentUser())!;
  const { day } = await searchParams;

  // A tapped day from the week strip, falling back to today. Parsed as local
  // calendar parts so it lines up with how dashboard.ts buckets meals.
  const focus = parseDayKey(day) ?? new Date();

  const [week, streak, activity, prefs] = await Promise.all([
    weekTotals(user.id, focus),
    currentStreak(user.id),
    recentActivity(user.id, 6),
    getPreferences(user.id),
  ]);

  const targets = dailyTargets(prefs);
  const totals = week.focused;

  const isToday = localDayKey(focus) === localDayKey(new Date());
  const caloriePct = targets.calories > 0 ? totals.calories / targets.calories : 0;

  const macros = [
    {
      key: 'protein',
      name: 'Protein',
      glyph: '🍗',
      eaten: totals.protein_g,
      target: targets.protein,
      color: 'var(--macro-protein)',
    },
    {
      key: 'carbs',
      name: 'Carbs',
      glyph: '🌾',
      eaten: totals.carbs_g,
      target: targets.carbs,
      color: 'var(--warn)',
    },
    {
      key: 'fat',
      name: 'Fat',
      glyph: '🥑',
      eaten: totals.fat_g,
      target: targets.fat,
      color: 'var(--accent)',
    },
  ];

  return (
    <main className="shell">
      <header className="app-header">
        <h1 className="greeting">
          <Greeting name={user.name} />
        </h1>

        <span
          className="streak"
          data-empty={streak === 0}
          title={
            streak === 0
              ? 'Log a meal to start a streak'
              : `${streak} day${streak === 1 ? '' : 's'} in a row with a logged meal`
          }
        >
          <span aria-hidden>🔥</span>
          {streak}
        </span>
      </header>

      <WeekStrip days={week.days} selectedKey={week.focusKey} />

      {/* --- calories ------------------------------------------------------ */}
      <div className="card rise-in">
        <div className="row" style={{ marginBottom: 'var(--space-2)' }}>
          <h3 style={{ margin: 0 }}>{isToday ? 'Today' : formatDay(focus)}</h3>
          <span className="tiny muted">
            {totals.meals} meal{totals.meals === 1 ? '' : 's'}
          </span>
        </div>

        <div className="calorie-hero">
          <div>
            <div className="calorie-value">
              {Math.round(totals.calories).toLocaleString()}
              <span className="muted" style={{ fontSize: 20, fontWeight: 500 }}>
                /{targets.calories.toLocaleString()}
              </span>
            </div>
            <div className="small muted">
              {totals.calories >= targets.calories
                ? `${Math.round(totals.calories - targets.calories).toLocaleString()} over goal`
                : `${Math.round(targets.calories - totals.calories).toLocaleString()} kcal left`}
              {!targets.caloriesExplicit && ' · default goal'}
            </div>
          </div>

          <ProgressRing
            value={caloriePct}
            size={88}
            strokeWidth={9}
            label={`${Math.round(caloriePct * 100)} percent of calorie goal`}
          >
            <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.022em' }}>
              {Math.round(caloriePct * 100)}%
            </span>
          </ProgressRing>
        </div>
      </div>

      {/* --- macros -------------------------------------------------------- */}
      <div className="macro-row rise-in" style={{ animationDelay: '60ms' }}>
        {macros.map((macro) => {
          const pct = macro.target.grams > 0 ? macro.eaten / macro.target.grams : 0;
          return (
            <div className="macro-card" key={macro.key}>
              <ProgressRing
                value={pct}
                size={60}
                strokeWidth={7}
                color={macro.color}
                label={`${macro.name}: ${Math.round(macro.eaten)} of ${macro.target.grams} grams`}
              >
                <span style={{ fontSize: 18 }} aria-hidden>
                  {macro.glyph}
                </span>
              </ProgressRing>
              <span className="macro-card-name">{macro.name}</span>
              <span className="macro-card-detail">
                {Math.round(macro.eaten)} / {macro.target.grams}g
              </span>
            </div>
          );
        })}
      </div>

      {!targets.protein.explicit && (
        <p className="tiny muted" style={{ margin: '0 0 var(--space-2)' }}>
          Macro goals are a 30/40/30 split of your calorie goal. Set your own in{' '}
          <Link href="/profile" style={{ textDecoration: 'underline' }}>
            Profile
          </Link>
          .
        </p>
      )}

      {/* --- recently uploaded --------------------------------------------- */}
      <div className="row" style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
        <h2 style={{ margin: 0 }}>Recently uploaded</h2>
      </div>
      <RecentUploads entries={activity.map((e) => ({ ...e, at: e.at.toISOString() }))} />
    </main>
  );
}

/** "2026-08-19" from the week strip, as a local-midnight Date. */
function parseDayKey(key?: string): Date | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

