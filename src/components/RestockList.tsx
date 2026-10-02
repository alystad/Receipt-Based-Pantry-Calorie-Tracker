'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type RestockRow = {
  id: string;
  name: string;
  category: string | null;
  is_empty: boolean;
};

/**
 * Compact "running low / need to restock" list for the Pantry home screen.
 * A quick "restock" tap bumps the item back to 1 unit — a fast acknowledgment
 * for "I bought more," not a full quantity editor (that lives in the full
 * inventory list below, via PantryList).
 */
export default function RestockList({ items }: { items: RestockRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function restock(item: RestockRow) {
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
      <div className="card rise-in">
        <h3 style={{ margin: 0 }}>Running low</h3>
        <p className="small muted" style={{ margin: 'var(--space-1) 0 0' }}>
          Nothing needs restocking right now.
        </p>
      </div>
    );
  }

  return (
    <div className="card rise-in">
      <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
        <h3 style={{ margin: 0 }}>Running low</h3>
        <span className="pill pill-warn">{items.length}</span>
      </div>

      {items.map((item) => (
        <div className="item" key={item.id}>
          <div style={{ minWidth: 0 }}>
            <div style={{ textTransform: 'capitalize' }}>{item.name}</div>
            <div className="tiny muted">{item.is_empty ? 'out of stock' : 'almost out'}</div>
          </div>
          <button
            className="btn btn-sm"
            onClick={() => restock(item)}
            disabled={busy === item.id}
          >
            Restocked
          </button>
        </div>
      ))}
    </div>
  );
}

