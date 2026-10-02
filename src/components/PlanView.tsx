'use client';

import { useState } from 'react';

type Ingredient = { name: string; quantity: number; unit: string; covered_by_pantry: boolean };

type Recipe = {
  id: string;
  day_index: number;
  slot: string;
  title: string;
  cuisine: string | null;
  equipment: string[];
  servings: number;
  total_minutes: number | null;
  instructions: string[];
  nutrition: { calories: number; protein_g: number; carbs_g: number; fat_g: number } | null;
  notes: string | null;
  ingredients: Ingredient[];
};

type PlanData = {
  plan: { id: string; week_start_date: string } | null;
  recipes?: Recipe[];
};

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function PlanView({ initial }: { initial: PlanData }) {
  const [data, setData] = useState<PlanData>(initial);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 7 }),
      });
      const next = (await res.json()) as PlanData & { error?: string };
      if (!res.ok) throw new Error(next.error ?? 'Could not generate a plan');

      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a plan');
    } finally {
      setGenerating(false);
    }
  }

  const recipes = data.recipes ?? [];
  const byDay = recipes.reduce<Record<number, Recipe[]>>((acc, recipe) => {
    (acc[recipe.day_index] ??= []).push(recipe);
    return acc;
  }, {});

  if (!data.plan) {
    return (
      <>
        <div className="empty">
          No meal plan yet. We will build one around what is already in your
          pantry and the equipment you told us about.
        </div>
        {error && <div className="banner">{error}</div>}
        <button className="btn btn-primary btn-block" onClick={generate} disabled={generating}>
          {generating ? <span className="spinner" /> : null}
          {generating ? 'Planning your week…' : 'Generate this week’s plan'}
        </button>
      </>
    );
  }

  return (
    <>
      {error && <div className="banner">{error}</div>}

      <>
          {Object.entries(byDay).map(([day, dayRecipes]) => (
            <section key={day}>
              <h2>{DAYS[Number(day)] ?? `Day ${Number(day) + 1}`}</h2>
              <div className="card">
                {dayRecipes.map((recipe) => (
                  <div key={recipe.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <button
                      onClick={() => setExpanded(expanded === recipe.id ? null : recipe.id)}
                      style={{
                        width: '100%',
                        background: 'none',
                        border: 'none',
                        padding: 'var(--space-2) 0',
                        textAlign: 'left',
                        cursor: 'pointer',
                        color: 'inherit',
                        font: 'inherit',
                      }}
                    >
                      <div className="row">
                        <div style={{ minWidth: 0 }}>
                          <div className="tiny muted" style={{ textTransform: 'uppercase' }}>
                            {recipe.slot}
                          </div>
                          <div>{recipe.title}</div>
                          <div className="tiny muted">
                            {recipe.total_minutes ? `${recipe.total_minutes} min · ` : ''}
                            {recipe.nutrition
                              ? `${Math.round(recipe.nutrition.calories)} kcal · ${Math.round(recipe.nutrition.protein_g)}g P`
                              : ''}
                          </div>
                        </div>
                        <span className="muted">{expanded === recipe.id ? '▾' : '▸'}</span>
                      </div>
                    </button>

                    {expanded === recipe.id && (
                      <div style={{ paddingBottom: 'var(--space-2)' }}>
                        {recipe.equipment.length > 0 && (
                          <div className="chips" style={{ marginBottom: 'var(--space-1)' }}>
                            {recipe.equipment.map((item) => (
                              <span className="pill" key={item}>
                                {item.replace(/_/g, ' ')}
                              </span>
                            ))}
                          </div>
                        )}

                        <h3 className="small">Ingredients</h3>
                        <ul className="small" style={{ paddingLeft: 'var(--space-2)', margin: '0 0 var(--space-2)' }}>
                          {recipe.ingredients.map((ingredient, i) => (
                            <li key={`${ingredient.name}-${i}`}>
                              {ingredient.quantity} {ingredient.unit} {ingredient.name}
                              {ingredient.covered_by_pantry && (
                                <span className="pill pill-accent" style={{ marginLeft: 'var(--space-1)' }}>
                                  have it
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>

                        <h3 className="small">Steps</h3>
                        <ol className="small" style={{ paddingLeft: 'var(--space-2)', margin: '0 0 var(--space-1)' }}>
                          {recipe.instructions.map((step, i) => (
                            <li key={i} style={{ marginBottom: 'var(--space-1)' }}>
                              {step}
                            </li>
                          ))}
                        </ol>

                        {recipe.notes && <p className="tiny muted">{recipe.notes}</p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>

      <button
        className="btn btn-block"
        onClick={generate}
        disabled={generating}
        style={{ marginTop: 'var(--space-2)' }}
      >
        {generating ? <span className="spinner" /> : null}
        {generating ? 'Planning your week…' : 'Regenerate plan'}
      </button>
    </>
  );
}

