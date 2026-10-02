'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { dailyTargets } from '@/lib/nutrition-targets';

type Goals = {
  daily_calorie_target: number | null;
  daily_protein_target_g: number | null;
  daily_carbs_target_g?: number | null;
  daily_fat_target_g?: number | null;
};

/**
 * Daily calorie and macro goals — the denominators for the home rings.
 *
 * Fields left blank stay blank rather than being written with the derived
 * value, so the dashboard can keep labelling them as a default split instead
 * of pretending the user chose them.
 */
export default function NutritionGoals({ initial }: { initial: Goals }) {
  const router = useRouter();
  const [goals, setGoals] = useState<Goals>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const derived = dailyTargets(goals);

  function update(key: keyof Goals, raw: string) {
    setSaved(false);
    setGoals((prev) => ({ ...prev, [key]: raw === '' ? null : Number(raw) }));
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goals),
      });
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const fields: { key: keyof Goals; label: string; placeholder: number; suffix: string }[] = [
    { key: 'daily_calorie_target', label: 'Calories', placeholder: derived.calories, suffix: 'kcal' },
    { key: 'daily_protein_target_g', label: 'Protein', placeholder: derived.protein.grams, suffix: 'g' },
    { key: 'daily_carbs_target_g', label: 'Carbs', placeholder: derived.carbs.grams, suffix: 'g' },
    { key: 'daily_fat_target_g', label: 'Fat', placeholder: derived.fat.grams, suffix: 'g' },
  ];

  return (
    <div className="card">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-1)' }}>
        {fields.map((field) => (
          <div key={field.key}>
            <label htmlFor={field.key}>
              {field.label} ({field.suffix})
            </label>
            <input
              id={field.key}
              type="number"
              inputMode="numeric"
              value={goals[field.key] ?? ''}
              placeholder={String(field.placeholder)}
              onChange={(e) => update(field.key, e.target.value)}
            />
          </div>
        ))}
      </div>

      <p className="tiny muted" style={{ margin: 'var(--space-2) 0 0' }}>
        Leave a field blank to use the default 30/40/30 split of your calorie
        goal. Greyed numbers show what that works out to.
      </p>

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 'var(--space-2)' }}
        onClick={save}
        disabled={saving}
      >
        {saving ? <span className="spinner" /> : null}
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save goals'}
      </button>
    </div>
  );
}

