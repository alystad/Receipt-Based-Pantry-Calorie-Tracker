import Link from 'next/link';
import { getCurrentUser } from '@/lib/session';
import { currentPlan } from '@/lib/plans';
import PlanView from '@/components/PlanView';

export const dynamic = 'force-dynamic';

/**
 * The week's meal plan, reached from the Meals and List tabs.
 *
 * Not a tab of its own: the plan is the machinery that produces the grocery
 * list, and most days a user wants either "what should I eat now" (Meals) or
 * "what do I buy" (List) rather than the seven-day grid.
 */
export default async function PlanPage() {
  const user = (await getCurrentUser())!;
  const plan = await currentPlan(user.id);

  return (
    <main className="shell">
      <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
        <h1 style={{ margin: 0 }}>This week</h1>
        <Link href="/list" className="pill pill-accent">
          grocery list →
        </Link>
      </div>
      <p className="sub">
        Built from what is in your pantry, within the equipment you have.
      </p>

      <PlanView
        initial={
          plan
            ? JSON.parse(JSON.stringify(plan))
            : { plan: null, recipes: [], list: null, listItems: [] }
        }
      />
    </main>
  );
}

