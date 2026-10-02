import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';
import { getSuggestedMeal, getSuggestion } from '@/lib/suggestions';
import { scoreColor, bandFor, labelFor, RUBRIC_SUMMARY, type HealthReason } from '@/lib/health-rating';
import { foodIcon } from '@/lib/food-icons';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Full recipe: ingredients, steps, macros, and why it scored what it scored. */
export default async function MealDetailPage({ params }: Params) {
  const user = (await getCurrentUser())!;
  const { id } = await params;

  // suggested_meals (precomputed "Suggested for you") has no UUID overlap
  // with meal_suggestions (cuisine rows, build-your-own), so checking both
  // in order is unambiguous.
  const meal = (await getSuggestedMeal(user.id, id)) ?? (await getSuggestion(user.id, id));
  if (!meal) notFound();

  const score = meal.health_score ?? 50;
  const colors = scoreColor(bandFor(score));
  const icon = foodIcon(meal.title, null);
  const reasons: HealthReason[] = Array.isArray(meal.health_reasons) ? meal.health_reasons : [];

  const fromPantry = meal.ingredients.filter((i) => i.from_pantry);
  const toBuy = meal.ingredients.filter((i) => !i.from_pantry);

  return (
    <main className="shell">
      <Link href="/meals" className="tiny muted" style={{ display: 'inline-block', marginBottom: 'var(--space-2)' }}>
        ‹ Meals
      </Link>

      <div
        className="meal-card-media food-tile"
        data-tone={icon.tone}
        style={{ borderRadius: 'var(--radius-card)', marginBottom: 'var(--space-2)' }}
      >
        {meal.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meal.image_url} alt="" />
        ) : (
          <span aria-hidden>{icon.glyph}</span>
        )}
        <span className="score-chip" style={{ background: colors.bg, color: colors.fg }}>
          {score}%
        </span>
      </div>

      <h1>{meal.title}</h1>
      {meal.description && <p className="sub">{meal.description}</p>}

      <div className="chips" style={{ marginBottom: 'var(--space-2)' }}>
        {meal.cuisine && <span className="pill" style={{ textTransform: 'capitalize' }}>{meal.cuisine}</span>}
        {meal.prep_minutes ? <span className="pill">{meal.prep_minutes} min</span> : null}
        <span className="pill">
          {meal.servings} serving{meal.servings === 1 ? '' : 's'}
        </span>
        {meal.pantry_coverage != null && meal.pantry_coverage > 0 && (
          <span className="pill pill-accent">
            {Math.round(meal.pantry_coverage * 100)}% from pantry
          </span>
        )}
      </div>

      <div className="card">
        <div className="macros">
          <Macro value={Math.round(Number(meal.calories ?? 0))} label="kcal" />
          <Macro value={`${Math.round(Number(meal.protein_g ?? 0))}g`} label="protein" />
          <Macro value={`${Math.round(Number(meal.carbs_g ?? 0))}g`} label="carbs" />
          <Macro value={`${Math.round(Number(meal.fat_g ?? 0))}g`} label="fat" />
        </div>
        <p className="tiny muted" style={{ margin: 'var(--space-2) 0 0', textAlign: 'center' }}>
          per serving
        </p>
      </div>

      {/* --- why this rating -------------------------------------------- */}
      <div className="card">
        <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
          <h3 style={{ margin: 0 }}>Health rating</h3>
          <span
            className="pill"
            style={{ background: colors.bg, color: colors.fg, fontWeight: 700 }}
          >
            {score}% · {labelFor(score)}
          </span>
        </div>

        {reasons.length > 0 ? (
          reasons.map((reason, i) => (
            <div className="item" key={`${reason.axis}-${i}`}>
              <span className="small">{reason.label}</span>
              <span
                className="small"
                style={{
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  color: reason.points >= 0 ? 'var(--accent-ink)' : 'var(--score-bad)',
                }}
              >
                {reason.points > 0 ? '+' : ''}
                {reason.points}
              </span>
            </div>
          ))
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            No scoring detail was recorded for this meal.
          </p>
        )}

        <p className="tiny muted" style={{ margin: 'var(--space-2) 0 0' }}>
          {RUBRIC_SUMMARY}
        </p>
      </div>

      {/* --- ingredients ------------------------------------------------- */}
      <h2>Ingredients</h2>
      <div className="card">
        {fromPantry.map((ingredient, i) => (
          <div className="item" key={`have-${i}`}>
            <span style={{ textTransform: 'capitalize' }}>
              {formatQty(ingredient.quantity, ingredient.display_unit)} {ingredient.name}
            </span>
            <span className="pill pill-accent">have it</span>
          </div>
        ))}
        {toBuy.map((ingredient, i) => (
          <div className="item" key={`buy-${i}`}>
            <span style={{ textTransform: 'capitalize' }}>
              {formatQty(ingredient.quantity, ingredient.display_unit)} {ingredient.name}
            </span>
            <span className="pill">need</span>
          </div>
        ))}
        {!meal.ingredients.length && (
          <p className="small muted" style={{ margin: 0 }}>
            No ingredients were recorded for this meal.
          </p>
        )}
      </div>

      {/* --- steps ------------------------------------------------------- */}
      <h2>Instructions</h2>
      <div className="card">
        <ol className="small" style={{ paddingLeft: 'var(--space-2)', margin: 0 }}>
          {meal.instructions.map((step, i) => (
            <li key={i} style={{ marginBottom: 'var(--space-1)' }}>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

function formatQty(quantity: string | null, unit: string | null): string {
  if (quantity == null) return '';
  const n = Number(quantity);
  const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
  return `${rounded}${unit ? ` ${unit}` : ''}`;
}

function Macro({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <div className="macro-value">{value}</div>
      <div className="macro-label">{label}</div>
    </div>
  );
}

