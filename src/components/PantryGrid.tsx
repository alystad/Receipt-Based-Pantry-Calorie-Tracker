'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { foodIcon } from '@/lib/food-icons';
import { freshnessFor } from '@/lib/freshness';

export type PantryCell = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  quantity: string;
  unit: string;
  display_unit: string | null;
  last_seen_at: string;
  expires_at: string | null;
  is_empty: boolean;
};

/**
 * The pantry, laid out like shelves rather than a spreadsheet.
 *
 * On imagery: we never have a real photograph of an individual item. Receipts
 * are text; onboarding scans are wide shots of a whole shelf with no per-item
 * crops, so cropping one would be a guess presented as a fact. Every tile
 * therefore shows a glyph matched to the specific food (see lib/food-icons),
 * which is honest and always food-specific rather than a grey placeholder.
 */
export default function PantryGrid({ items }: { items: PantryCell[] }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? items.filter(
          (i) =>
            i.name.toLowerCase().includes(q) ||
            (i.brand ?? '').toLowerCase().includes(q) ||
            (i.category ?? '').toLowerCase().includes(q)
        )
      : items;
  }, [items, search]);

  const grouped = useMemo(() => {
    return visible.reduce<Record<string, PantryCell[]>>((acc, item) => {
      const key = item.category ?? 'other';
      (acc[key] ??= []).push(item);
      return acc;
    }, {});
  }, [visible]);

  async function restock(item: PantryCell) {
    setBusy(item.id);
    try {
      await fetch(`/api/pantry/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: 1 }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!items.length) {
    return (
      <div className="empty">
        Your pantry is empty. Sync a grocery receipt or scan your shelves to
        fill it.
      </div>
    );
  }

  return (
    <>
      <input
        type="text"
        value={search}
        placeholder="Search your pantry"
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 'var(--space-2)' }}
      />

      {Object.entries(grouped).map(([category, rows]) => (
        <section key={category}>
          <h3 style={{ textTransform: 'capitalize', margin: 'var(--space-2) 0 var(--space-1)' }}>
            {category}{' '}
            <span className="tiny muted" style={{ fontWeight: 400 }}>
              {rows.length}
            </span>
          </h3>

          <div className="pantry-grid">
            {rows.map((item) => {
              const icon = foodIcon(item.name, item.category);
              const fresh = freshnessFor(item);
              const unitLabel =
                item.unit === 'count' ? (item.display_unit ?? 'ct') : item.unit;
              const amount = Number(item.quantity);

              return (
                <div className="pantry-cell" key={item.id} data-empty={item.is_empty}>
                  <div className="pantry-cell-media food-tile" data-tone={icon.tone}>
                    <span aria-hidden>{icon.glyph}</span>
                  </div>

                  <span className="pantry-cell-name">{item.name}</span>

                  <span className="tiny muted">
                    {item.is_empty
                      ? 'out'
                      : `${amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10} ${unitLabel}`}
                  </span>

                  {item.is_empty ? (
                    <button
                      className="btn btn-sm"
                      onClick={() => restock(item)}
                      disabled={busy === item.id}
                    >
                      Restock
                    </button>
                  ) : (
                    fresh.state !== 'unknown' && (
                      <span
                        className="freshness"
                        data-state={fresh.state}
                        title={
                          fresh.estimated
                            ? 'Estimated from a typical shelf life for this category, not a printed date'
                            : 'From the expiry date on record'
                        }
                      >
                        {fresh.label}
                        {fresh.estimated ? ' ~' : ''}
                      </span>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <p className="tiny muted" style={{ marginTop: 'var(--space-2)' }}>
        A “~” marks an estimated freshness from typical shelf life, not a printed
        date.
      </p>
    </>
  );
}

