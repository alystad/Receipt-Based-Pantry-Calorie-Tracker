'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type PantryRow = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  quantity: string;
  unit: string;
  display_unit: string | null;
  source: string;
  confidence: number;
  is_empty: boolean;
  days_since_seen: number | null;
  has_nutrition: boolean;
};

const SOURCE_LABEL: Record<string, string> = {
  receipt: 'receipt',
  photo_scan: 'scanned',
  manual: 'added',
  meal_inference: 'inferred',
};

function formatQuantity(row: PantryRow): string {
  const value = Number(row.quantity);
  if (row.unit === 'g' && value >= 1000) return `${(value / 1000).toFixed(1)} kg`;
  if (row.unit === 'ml' && value >= 1000) return `${(value / 1000).toFixed(1)} L`;
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${row.unit === 'count' ? (row.display_unit ?? 'ct') : row.unit}`;
}

export default function PantryList({ items }: { items: PantryRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', quantity: '1', unit: 'each' });

  const grouped = items.reduce<Record<string, PantryRow[]>>((acc, item) => {
    const key = item.category ?? 'other';
    (acc[key] ??= []).push(item);
    return acc;
  }, {});

  async function adjust(item: PantryRow, delta: number) {
    const next = Math.max(0, Number(item.quantity) + delta);
    setBusy(item.id);
    try {
      await fetch(`/api/pantry/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: next }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: PantryRow) {
    setBusy(item.id);
    try {
      await fetch(`/api/pantry/${item.id}`, { method: 'DELETE' });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function addItem() {
    if (!newItem.name.trim()) return;
    setBusy('new');
    try {
      await fetch('/api/pantry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newItem.name,
          quantity: Number(newItem.quantity) || 1,
          unit: newItem.unit,
        }),
      });
      setNewItem({ name: '', quantity: '1', unit: 'each' });
      setAdding(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!items.length) {
    return (
      <div className="empty">
        Your pantry is empty. Scan your shelves during onboarding, or sync your
        Gmail receipts to fill it.
      </div>
    );
  }

  return (
    <>
      {Object.entries(grouped).map(([category, rows]) => (
        <section key={category}>
          <h2 style={{ textTransform: 'capitalize' }}>{category}</h2>
          <div className="card">
            {rows.map((item) => (
              <div key={item.id} className={`item${item.is_empty ? ' item-empty' : ''}`}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ textTransform: 'capitalize' }}>{item.name}</div>
                  <div className="tiny muted">
                    {item.brand ? `${item.brand} · ` : ''}
                    {SOURCE_LABEL[item.source] ?? item.source}
                    {item.confidence < 0.6 ? ' · low confidence' : ''}
                    {!item.has_nutrition ? ' · estimated macros' : ''}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => adjust(item, -1)}
                    disabled={busy === item.id || Number(item.quantity) <= 0}
                    aria-label={`Decrease ${item.name}`}
                  >
                    −
                  </button>
                  <span
                    className="small"
                    style={{ minWidth: 56, textAlign: 'center', whiteSpace: 'nowrap' }}
                  >
                    {item.is_empty ? 'out' : formatQuantity(item)}
                  </span>
                  <button
                    className="btn btn-sm"
                    onClick={() => adjust(item, 1)}
                    disabled={busy === item.id}
                    aria-label={`Increase ${item.name}`}
                  >
                    +
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => remove(item)}
                    disabled={busy === item.id}
                    aria-label={`Remove ${item.name}`}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {adding ? (
        <div className="card">
          <label htmlFor="item-name">Item name</label>
          <input
            id="item-name"
            type="text"
            value={newItem.name}
            placeholder="black beans"
            onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
          />
          <div style={{ display: 'flex', gap: 'var(--space-1)', margin: 'var(--space-2) 0' }}>
            <input
              type="number"
              min="0"
              step="0.1"
              value={newItem.quantity}
              onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })}
            />
            <select
              value={newItem.unit}
              onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })}
            >
              {['each', 'can', 'box', 'bag', 'bottle', 'oz', 'lb', 'g', 'ml'].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={addItem} disabled={busy === 'new'}>
              Add
            </button>
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-block" onClick={() => setAdding(true)}>
          + Add an item manually
        </button>
      )}
    </>
  );
}

