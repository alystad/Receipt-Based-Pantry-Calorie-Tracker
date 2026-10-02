'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { foodIcon } from '@/lib/food-icons';
import { aisleMapFor } from '@/lib/aisle-map';

export type ListItem = {
  id: string;
  name: string;
  category: string | null;
  quantity: string;
  display_unit: string;
  suggested_package: string | null;
  estimated_price_cents: number | null;
  needed_for: string[];
  checked: boolean;
  /** Null for perimeter items and for anything the classifier couldn't place. */
  aisle_number: number | null;
  /** The specific matched category (numbered aisle) or section name (perimeter). */
  aisle_category: string | null;
};

type Group = { key: string; header: string; sortOrder: number; items: ListItem[] };

/**
 * aisle_map.ts has no server-only imports, so it's safe to pull the
 * perimeter's real walking order (Produce, Deli, Bakery, ...) into this
 * client component directly — the alternative would be threading it through
 * as a prop for no real benefit, since Publix is the only store with data
 * today regardless of which store this list happens to be for.
 */
const PERIMETER_ORDER = aisleMapFor(null).perimeter.map((p) => p.name);

/**
 * Groups items the way the request laid it out: numbered aisles first, in
 * ascending order, each with an "Aisle N" header; then perimeter sections,
 * each under its own real department name, in the store's walking order —
 * never merged into a single catch-all. Anything the classifier couldn't
 * place (a failed call, or a genuinely new item) falls into one final
 * "Uncategorized" group rather than silently vanishing from the list.
 */
function groupByAisle(items: ListItem[]): Group[] {
  const groups = new Map<string, Group>();

  for (const item of items) {
    let key: string;
    let header: string;
    let sortOrder: number;

    if (item.aisle_number != null) {
      key = `aisle-${item.aisle_number}`;
      header = `Aisle ${item.aisle_number}`;
      sortOrder = item.aisle_number;
    } else if (item.aisle_category) {
      const perimeterIndex = PERIMETER_ORDER.indexOf(item.aisle_category);
      key = `section-${item.aisle_category}`;
      header = item.aisle_category;
      // Perimeter sections sort after every numbered aisle (offset 1000+),
      // in the map's defined order; an unrecognized section name (a second
      // store's department this map doesn't know) still gets its own group,
      // just after the known ones.
      sortOrder = 1000 + (perimeterIndex === -1 ? PERIMETER_ORDER.length : perimeterIndex);
    } else {
      key = 'uncategorized';
      header = 'Uncategorized';
      sortOrder = 9999;
    }

    const group = groups.get(key) ?? { key, header, sortOrder, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.items.sort((a, b) => Number(a.checked) - Number(b.checked));
  }

  return Array.from(groups.values()).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The grocery list: the gap between the meal plan and the pantry.
 *
 * Items are grouped by real store aisle/section (src/lib/aisle-map.ts) so the
 * list reads in the order you actually walk the store, and checked items sink
 * to the bottom of their group rather than vanishing — you still want to see
 * what you already put in the cart.
 */
export default function GroceryList({
  items: initial,
  storeName,
  hasPlan,
}: {
  items: ListItem[];
  storeName: string | null;
  hasPlan: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(item: ListItem) {
    const checked = !item.checked;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked } : i)));
    await fetch(`/api/grocery-list/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checked }),
    }).catch(() => undefined);
  }

  async function regenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 7 }),
      });
      const data = (await res.json()) as { listItems?: ListItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Could not build a list');
      setItems(data.listItems ?? []);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build a list');
    } finally {
      setGenerating(false);
    }
  }

  // Re-grouping/sorting/summing on every render — including a single
  // checkbox toggle, which only changes one item's `checked` flag — was pure
  // wasted work the previous render had already done. Cheap in absolute
  // terms for a typical list size, but free to fix and the right pattern
  // regardless of how large "typical" turns out to be.
  const { remaining, estimated, groups } = useMemo(() => {
    const remaining = items.filter((i) => !i.checked);
    const estimated = remaining.reduce((sum, i) => sum + (i.estimated_price_cents ?? 0), 0);
    return { remaining, estimated, groups: groupByAisle(items) };
  }, [items]);

  return (
    <>
      <div className="row" style={{ marginBottom: 'var(--space-2)' }}>
        <div>
          <p className="small muted" style={{ margin: 0 }}>
            {storeName ? `For ${storeName}` : 'Your usual store'} ·{' '}
            {remaining.length} item{remaining.length === 1 ? '' : 's'} to buy
            {estimated > 0 ? ` · about $${(estimated / 100).toFixed(2)}` : ''}
          </p>
        </div>
        <button className="btn btn-sm" onClick={regenerate} disabled={generating}>
          {generating ? <span className="spinner" /> : '↻'}
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      {!items.length ? (
        <div className="empty">
          {hasPlan
            ? 'Nothing to buy — your pantry already covers this week’s plan.'
            : 'No meal plan yet, so there is nothing to shop for.'}
          <br />
          <button
            className="btn"
            style={{ marginTop: 'var(--space-2)' }}
            onClick={regenerate}
            disabled={generating}
          >
            {generating ? 'Building…' : hasPlan ? 'Rebuild list' : 'Plan a week and build a list'}
          </button>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.key}>
            <h2>{group.header}</h2>
            <div className="card">
              {group.items.map((item) => {
                const icon = foodIcon(item.name, item.category);
                return (
                  <label
                    key={item.id}
                    className="item"
                    style={{ cursor: 'pointer', opacity: item.checked ? 0.45 : 1 }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        gap: 'var(--space-1)',
                        alignItems: 'center',
                        minWidth: 0,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={item.checked}
                        onChange={() => toggle(item)}
                        style={{ width: 24, height: 24, flexShrink: 0 }}
                      />
                      <span
                        className="food-tile"
                        data-tone={icon.tone}
                        style={{ width: 40, height: 40, fontSize: 20 }}
                        aria-hidden
                      >
                        {icon.glyph}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            textTransform: 'capitalize',
                            textDecoration: item.checked ? 'line-through' : 'none',
                          }}
                        >
                          {item.suggested_package ?? item.name}
                        </div>
                        <div className="tiny muted">
                          need {Number(item.quantity)} {item.display_unit}
                          {item.needed_for.length ? ` · for ${item.needed_for.join(', ')}` : ''}
                        </div>
                      </div>
                    </div>

                    {item.estimated_price_cents != null && (
                      <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                        ${(item.estimated_price_cents / 100).toFixed(2)}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </section>
        ))
      )}
    </>
  );
}

