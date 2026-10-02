'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { foodIcon } from '@/lib/food-icons';

export type BuilderItem = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  quantity: string;
  unit: 'g' | 'ml' | 'count';
  display_unit: string | null;
  nutrition: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  } | null;
};

/** Default amount to add per tap, per canonical unit. */
const STEP: Record<BuilderItem['unit'], number> = { g: 50, ml: 50, count: 1 };

/**
 * Manual meal assembly from pantry items, with live totals.
 *
 * Totals are computed client-side from each product's stored per-100g/ml
 * nutrition — the same numbers the photo path uses — so what you see while
 * building matches what gets logged. Count-tracked items (a "can", a "bag")
 * have no per-100 basis to scale against, so they are shown as
 * macro-unknown rather than silently contributing zero.
 */
export default function MealBuilder({ items }: { items: BuilderItem[] }) {
  const router = useRouter();
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const totals = useMemo(() => {
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;
    let unknown = 0;

    for (const [id, amount] of Object.entries(amounts)) {
      const item = byId.get(id);
      if (!item || amount <= 0) continue;

      const scalable = item.nutrition && (item.unit === 'g' || item.unit === 'ml');
      if (!scalable) {
        unknown += 1;
        continue;
      }
      const factor = amount / 100;
      calories += item.nutrition!.calories * factor;
      protein += item.nutrition!.protein_g * factor;
      carbs += item.nutrition!.carbs_g * factor;
      fat += item.nutrition!.fat_g * factor;
    }

    return { calories, protein, carbs, fat, unknown };
  }, [amounts, byId]);

  const selected = Object.entries(amounts).filter(([, a]) => a > 0);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
  }, [items, search]);

  function adjust(item: BuilderItem, direction: 1 | -1) {
    setSaved(null);
    setAmounts((prev) => {
      const step = STEP[item.unit];
      const next = Math.max(0, (prev[item.id] ?? 0) + step * direction);
      // Never let someone build a meal from more than they actually have.
      const capped = Math.min(next, Number(item.quantity));
      return { ...prev, [item.id]: capped };
    });
  }

  async function logMeal() {
    if (!selected.length) return;
    setSaving(true);
    try {
      const res = await fetch('/api/meals/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selected.map(([pantry_item_id, amount]) => ({ pantry_item_id, amount })),
        }),
      });
      const data = (await res.json()) as { error?: string; calories?: number };
      if (!res.ok) throw new Error(data.error ?? 'Could not log that meal');

      setSaved(`Logged ${Math.round(data.calories ?? 0)} kcal and updated your pantry.`);
      setAmounts({});
      router.refresh();
    } catch (err) {
      setSaved(err instanceof Error ? err.message : 'Could not log that meal');
    } finally {
      setSaving(false);
    }
  }

  if (!items.length) {
    return (
      <div className="empty">
        Nothing in your pantry to build with yet. Sync a receipt or scan your
        shelves first.
      </div>
    );
  }

  return (
    <>
      {/* Live totals stay pinned at the top so the numbers move as you build. */}
      <div className="card">
        <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
          <h3 style={{ margin: 0 }}>Your meal</h3>
          <span className="tiny muted">
            {selected.length} item{selected.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="macros">
          <Macro value={Math.round(totals.calories)} label="kcal" />
          <Macro value={`${Math.round(totals.protein)}g`} label="protein" />
          <Macro value={`${Math.round(totals.carbs)}g`} label="carbs" />
          <Macro value={`${Math.round(totals.fat)}g`} label="fat" />
        </div>

        {totals.unknown > 0 && (
          <p className="tiny muted" style={{ margin: 'var(--space-1) 0 0' }}>
            {totals.unknown} selected item{totals.unknown === 1 ? ' has' : 's have'} no label
            data, so {totals.unknown === 1 ? 'it is' : 'they are'} not counted in these totals.
          </p>
        )}

        {saved && (
          <div className="banner banner-ok" style={{ margin: 'var(--space-2) 0 0' }}>
            {saved}
          </div>
        )}

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 'var(--space-2)' }}
          disabled={!selected.length || saving}
          onClick={logMeal}
        >
          {saving ? <span className="spinner" /> : null}
          {saving ? 'Logging…' : 'Log this meal'}
        </button>
      </div>

      <input
        type="text"
        value={search}
        placeholder="Search your pantry"
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 'var(--space-2)' }}
      />

      <div className="card">
        {visible.map((item) => {
          const icon = foodIcon(item.name, item.category);
          const amount = amounts[item.id] ?? 0;
          const unitLabel = item.unit === 'count' ? (item.display_unit ?? 'ct') : item.unit;

          return (
            <div className="item" key={item.id}>
              <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', minWidth: 0 }}>
                <span
                  className="food-tile"
                  data-tone={icon.tone}
                  style={{ width: 40, height: 40, fontSize: 20 }}
                  aria-hidden
                >
                  {icon.glyph}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ textTransform: 'capitalize' }}>{item.name}</div>
                  <div className="tiny muted">
                    {Math.round(Number(item.quantity))} {unitLabel} on hand
                    {!item.nutrition && ' · no label data'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => adjust(item, -1)}
                  disabled={amount <= 0}
                  aria-label={`Less ${item.name}`}
                >
                  −
                </button>
                <span className="small" style={{ minWidth: 56, textAlign: 'center' }}>
                  {amount > 0 ? `${Math.round(amount)} ${unitLabel}` : '—'}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => adjust(item, 1)}
                  disabled={amount >= Number(item.quantity)}
                  aria-label={`More ${item.name}`}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>
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

