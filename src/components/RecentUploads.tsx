import { foodIcon } from '@/lib/food-icons';

export type ActivityView = {
  kind: 'meal' | 'receipt';
  id: string;
  title: string;
  at: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  photo_id: string | null;
  item_count: number | null;
};

/**
 * "Recently uploaded" feed: the two things a user actually uploads — meal
 * photos and grocery receipts.
 *
 * Meals show their real photo. Receipts have no image (they arrive as email),
 * so they get a receipt mark rather than a fake thumbnail.
 */
export default function RecentUploads({ entries }: { entries: ActivityView[] }) {
  if (!entries.length) {
    return (
      <div className="empty">
        Nothing uploaded yet. Tap the <strong>+</strong> button to photograph a meal.
      </div>
    );
  }

  return (
    <div className="card">
      {entries.map((entry) => {
        const icon = foodIcon(entry.title, null);
        return (
          <div className="item" key={`${entry.kind}-${entry.id}`}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minWidth: 0 }}>
              {entry.kind === 'meal' && entry.photo_id ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="activity-thumb"
                  src={`/api/photos/${entry.photo_id}`}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span
                  className="activity-thumb food-tile"
                  data-tone={entry.kind === 'receipt' ? 'neutral' : icon.tone}
                  style={{ fontSize: 24 }}
                  aria-hidden
                >
                  {entry.kind === 'receipt' ? '🧾' : icon.glyph}
                </span>
              )}

              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{entry.title}</div>
                <div className="tiny muted">
                  {formatTime(entry.at)}
                  {entry.kind === 'receipt' && entry.item_count != null
                    ? ` · ${entry.item_count} item${entry.item_count === 1 ? '' : 's'} added`
                    : ''}
                </div>
              </div>
            </div>

            {entry.kind === 'meal' ? (
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontWeight: 600 }}>{Math.round(entry.calories ?? 0)} kcal</div>
                <div className="tiny muted">
                  {Math.round(entry.protein_g ?? 0)}P · {Math.round(entry.carbs_g ?? 0)}C ·{' '}
                  {Math.round(entry.fat_g ?? 0)}F
                </div>
              </div>
            ) : (
              <span className="pill" style={{ flexShrink: 0 }}>
                receipt
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const days = Math.round((now.getTime() - date.getTime()) / 86_400_000);
  if (days <= 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

