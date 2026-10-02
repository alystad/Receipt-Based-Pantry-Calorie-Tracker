import Link from 'next/link';
import { getCurrentUser } from '@/lib/session';
import { currentPlan } from '@/lib/plans';
import GroceryList, { type ListItem } from '@/components/GroceryList';

export const dynamic = 'force-dynamic';

/**
 * List tab — the grocery list, which is the meal plan's ingredient demand
 * minus what the pantry already covers (computed in lib/plans.ts against live
 * pantry quantities, not the planner's original guess).
 */
export default async function ListPage() {
  const user = (await getCurrentUser())!;
  const plan = await currentPlan(user.id);

  return (
    <main className="shell">
      {/* Tab bar already reads "List"; no caption either — a checklist of
          items with quantities doesn't need to be explained. */}
      <h1 className="sr-only">List</h1>
      <div className="row" style={{ marginBottom: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Link href="/plan" className="pill pill-accent">
          meal plan →
        </Link>
      </div>

      <GroceryList
        items={(plan?.listItems ?? []) as unknown as ListItem[]}
        storeName={plan?.list?.store_name ?? null}
        hasPlan={Boolean(plan?.plan)}
      />
    </main>
  );
}

