'use client';

import { useState } from 'react';

export type Preferences = {
  cuisines: string[];
  equipment: string[];
  meals_per_day: number;
  servings_per_meal: number;
  max_cook_minutes: number;
  preferred_store_id: string | null;
};

type Store = { id: string; slug: string; name: string };

const CUISINES = ['italian', 'french', 'mexican', 'japanese', 'indian', 'thai', 'american', 'mediterranean'];
const EQUIPMENT = [
  { id: 'microwave', label: 'Microwave' },
  { id: 'air_fryer', label: 'Air fryer' },
  { id: 'stovetop', label: 'Stovetop' },
  { id: 'oven', label: 'Oven' },
  { id: 'instant_pot', label: 'Instant Pot' },
  { id: 'blender', label: 'Blender' },
  { id: 'no_cook', label: 'No cooking' },
];

/** Weekly preferences. Collapsed by default — this is a set-and-forget panel. */
export default function PreferencesEditor({
  initial,
  stores,
  inferredStore,
}: {
  initial: Preferences;
  stores: Store[];
  inferredStore: string;
}) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(initial);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(next: Preferences) {
    setPrefs(next);
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const toggle = (key: 'cuisines' | 'equipment', value: string) =>
    save({
      ...prefs,
      [key]: prefs[key].includes(value)
        ? prefs[key].filter((v) => v !== value)
        : [...prefs[key], value],
    });

  const summary = [
    prefs.equipment.length ? prefs.equipment.map((e) => e.replace(/_/g, ' ')).join(', ') : 'any equipment',
    prefs.cuisines.length ? prefs.cuisines.join(', ') : 'any cuisine',
  ].join(' · ');

  return (
    <div className="card">
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ marginBottom: 0 }}>This week&rsquo;s preferences</h3>
            <div className="tiny muted" style={{ textTransform: 'capitalize' }}>
              {summary}
            </div>
          </div>
          <span className="muted">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          <label>Equipment (hard constraint on every recipe)</label>
          <div className="chips" style={{ marginBottom: 16 }}>
            {EQUIPMENT.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={prefs.equipment.includes(item.id)}
                onClick={() => toggle('equipment', item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <label>Cuisines</label>
          <div className="chips" style={{ marginBottom: 16 }}>
            {CUISINES.map((cuisine) => (
              <button
                key={cuisine}
                type="button"
                className="chip"
                aria-pressed={prefs.cuisines.includes(cuisine)}
                onClick={() => toggle('cuisines', cuisine)}
                style={{ textTransform: 'capitalize' }}
              >
                {cuisine}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="meals">Meals / day</label>
              <input
                id="meals"
                type="number"
                min="1"
                max="6"
                value={prefs.meals_per_day}
                onChange={(e) => save({ ...prefs, meals_per_day: Number(e.target.value) })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="servings">Servings</label>
              <input
                id="servings"
                type="number"
                min="1"
                max="12"
                value={prefs.servings_per_meal}
                onChange={(e) => save({ ...prefs, servings_per_meal: Number(e.target.value) })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="minutes">Max min</label>
              <input
                id="minutes"
                type="number"
                min="5"
                max="240"
                step="5"
                value={prefs.max_cook_minutes}
                onChange={(e) => save({ ...prefs, max_cook_minutes: Number(e.target.value) })}
              />
            </div>
          </div>

          <label htmlFor="store">Grocery store</label>
          <select
            id="store"
            value={prefs.preferred_store_id ?? ''}
            onChange={(e) =>
              save({ ...prefs, preferred_store_id: e.target.value || null })
            }
          >
            <option value="">Infer from my receipts ({inferredStore})</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>

          <p className="tiny muted" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            {saving ? 'Saving…' : saved ? 'Saved. Regenerate the plan to apply.' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

