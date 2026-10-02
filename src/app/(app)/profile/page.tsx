import { getCurrentUser } from '@/lib/session';
import { query } from '@/lib/db';
import { getPreferences, resolveStore } from '@/lib/plans';
import PreferencesEditor from '@/components/PreferencesEditor';
import NutritionGoals from '@/components/NutritionGoals';
import PantryGrid, { type PantryCell } from '@/components/PantryGrid';
import SyncButton from '@/components/SyncButton';

export const dynamic = 'force-dynamic';

/** Profile — every setting, plus the pantry itself. */
export default async function ProfilePage() {
  const user = (await getCurrentUser())!;

  const [preferences, stores, items] = await Promise.all([
    getPreferences(user.id),
    query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM stores ORDER BY name`
    ),
    query<PantryCell>(
      `SELECT id, name, brand, category, quantity, unit, display_unit,
              last_seen_at, expires_at, is_empty
         FROM pantry_overview
        WHERE user_id = $1
        ORDER BY is_empty, category NULLS LAST, name`,
      [user.id]
    ),
  ]);

  const store = await resolveStore(user.id, preferences.preferred_store_id);
  const stocked = items.filter((i) => !i.is_empty).length;

  return (
    <main className="shell">
      {/* The tab bar already labels this screen "Profile" — the heading node
          stays for the a11y document outline but carries no visible text. */}
      <h1 className="sr-only">Profile</h1>
      <p className="sub">{user.email}</p>

      {/* --- account ------------------------------------------------------ */}
      <div className="card">
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ marginBottom: 0 }}>{user.name ?? 'Signed in'}</h3>
            <span className="tiny muted">
              {user.gmail_connected ? 'Gmail connected' : 'Gmail not connected'}
              {user.last_synced_at
                ? ` · synced ${formatRelative(new Date(user.last_synced_at))}`
                : ''}
            </span>
          </div>
          <form action="/api/auth/logout" method="post">
            <button className="btn btn-sm" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>

      <SyncButton connected={user.gmail_connected} />

      {/* --- goals + cooking preferences ---------------------------------- */}
      <h2>Goals</h2>
      <NutritionGoals initial={preferences} />

      <h2>Cooking</h2>
      <PreferencesEditor initial={preferences} stores={stores} inferredStore={store.name} />

      {/* --- the pantry -----------------------------------------------------
          No "Pantry" heading here — a grid of food tiles right after the
          Cooking section is self-evidently the pantry, and the tab bar's
          section context makes a label redundant. The stocked count is real
          information, so it stays. */}
      <h2 className="sr-only">Pantry</h2>
      <p
        className="tiny muted"
        style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-1)', textAlign: 'right' }}
      >
        {stocked} in stock
      </p>

      <PantryGrid
        items={items.map((i) => ({
          ...i,
          last_seen_at: new Date(i.last_seen_at).toISOString(),
          expires_at: i.expires_at ? new Date(i.expires_at).toISOString() : null,
        }))}
      />
    </main>
  );
}

function formatRelative(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

