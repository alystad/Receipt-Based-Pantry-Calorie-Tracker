'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import CameraCapture from './CameraCapture';

type Component = {
  name: string;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  matched_item: string | null;
  nutrition_source: 'pantry_product' | 'model_estimate';
};

type Meal = {
  id: string;
  title: string;
  description: string;
  slot: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  confidence: number;
  components: Component[];
  deductions: { item: string; amount: number; unit: string; approximate: boolean }[];
};

export default function MealLogger() {
  const router = useRouter();
  const [preview, setPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [meal, setMeal] = useState<Meal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCapture(files: File[]) {
    const file = files[0];
    if (!file) return;

    setPreview(URL.createObjectURL(file));
    setMeal(null);
    setError(null);
    setAnalyzing(true);

    try {
      const form = new FormData();
      form.append('photo', file);

      const res = await fetch('/api/meals', { method: 'POST', body: form });
      const data = (await res.json()) as { meal?: Meal; error?: string };

      if (!res.ok || !data.meal) throw new Error(data.error ?? 'Could not analyze that photo');

      setMeal(data.meal);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not analyze that photo');
    } finally {
      setAnalyzing(false);
    }
  }

  function reset() {
    setPreview(null);
    setMeal(null);
    setError(null);
  }

  return (
    <>
      {preview && (
        <div style={{ marginBottom: 'var(--space-2)', position: 'relative' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="photo-preview" src={preview} alt="Your meal" />
          {analyzing && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-1)',
                background: 'rgba(28, 28, 30, 0.4)',
                WebkitBackdropFilter: 'saturate(180%) blur(20px)',
                backdropFilter: 'saturate(180%) blur(20px)',
                color: '#fff',
                borderRadius: 'var(--radius-card)',
                fontSize: 15,
                fontWeight: 500,
              }}
            >
              <span className="spinner" />
              Reading your plate…
            </div>
          )}
        </div>
      )}

      {error && <div className="banner">{error}</div>}

      {meal ? (
        <>
          <div className="card rise-in">
            <div className="row" style={{ marginBottom: 'var(--space-2)' }}>
              <div>
                <h3 style={{ marginBottom: 0 }}>{meal.title}</h3>
                <span className="tiny muted" style={{ textTransform: 'capitalize' }}>
                  {meal.slot}
                  {meal.confidence < 0.6 ? ' · low confidence' : ''}
                </span>
              </div>
            </div>

            <div className="macros">
              <Macro value={Math.round(meal.calories)} label="kcal" />
              <Macro value={`${Math.round(meal.protein_g)}g`} label="protein" />
              <Macro value={`${Math.round(meal.carbs_g)}g`} label="carbs" />
              <Macro value={`${Math.round(meal.fat_g)}g`} label="fat" />
            </div>
          </div>

          <div className="card rise-in" style={{ animationDelay: '60ms' }}>
            <h3 style={{ marginBottom: 'var(--space-1)' }}>What we saw</h3>
            {meal.components.map((component, i) => (
              <div className="item" key={`${component.name}-${i}`}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ textTransform: 'capitalize' }}>{component.name}</div>
                  <div className="tiny muted">
                    {component.quantity} {component.unit} · {Math.round(component.calories)} kcal
                  </div>
                </div>
                <span
                  className={`pill ${component.nutrition_source === 'pantry_product' ? 'pill-accent' : ''}`}
                >
                  {component.nutrition_source === 'pantry_product' ? 'from pantry' : 'estimated'}
                </span>
              </div>
            ))}
            <p className="tiny muted" style={{ margin: 'var(--space-1) 0 0' }}>
              &ldquo;From pantry&rdquo; means macros came from the actual product
              you bought, not a generic lookup.
            </p>
          </div>

          {meal.deductions.length > 0 && (
            <div className="card rise-in" style={{ animationDelay: '120ms' }}>
              <h3 style={{ marginBottom: 'var(--space-1)' }}>Removed from your pantry</h3>
              {meal.deductions.map((deduction, i) => (
                <div className="item" key={`${deduction.item}-${i}`}>
                  <span style={{ textTransform: 'capitalize' }}>{deduction.item}</span>
                  <span className="small muted">
                    −{deduction.amount} {deduction.unit}
                    {deduction.approximate ? ' (approx)' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="stack">
            <button className="btn btn-primary btn-block" onClick={reset}>
              Log another meal
            </button>
          </div>
        </>
      ) : (
        !analyzing && (
          <CameraCapture
            onCapture={handleCapture}
            label={preview ? 'Retake photo' : 'Photograph your meal'}
          />
        )
      )}
    </>
  );
}

function Macro({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <div className="macro-value">{value}</div>
      <div className="macro-label">{label}</div>
    </div>
  );
}

