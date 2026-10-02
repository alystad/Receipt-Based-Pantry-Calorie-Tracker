import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  state_mismatch: 'That sign-in link expired. Please try again.',
  oauth_failed: 'Google sign-in failed. Please try again.',
  missing_code: 'Google did not return an authorization code.',
  access_denied: 'You declined the Gmail permission, so receipts cannot be read.',
};

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(user.onboarded_at ? '/dashboard' : '/onboarding');

  const { error } = await searchParams;

  return (
    <main className="shell" style={{ paddingBottom: 'var(--space-5)' }}>
      <div style={{ marginTop: 'var(--space-6)' }}>
        <div style={{ fontSize: 44, marginBottom: 'var(--space-2)' }} aria-hidden>
          🧺
        </div>
        <h1>Your pantry, tracked by itself.</h1>
        <p className="sub">
          Photograph your meal. That is the only thing you ever have to do.
        </p>
      </div>

      {error && <div className="banner">{ERRORS[error] ?? 'Something went wrong.'}</div>}

      <div className="card">
        <div className="stack">
          <Step
            n="1"
            title="Connect Gmail"
            body="We read grocery e-receipts only, and only to build your pantry. Read-only access."
          />
          <Step
            n="2"
            title="Snap your shelves once"
            body="A few wide photos of the pantry and fridge get you most of the way to a full inventory."
          />
          <Step
            n="3"
            title="Photograph what you eat"
            body="One photo logs your macros and quietly subtracts what you used."
          />
        </div>
      </div>

      <a className="btn btn-primary btn-block" href="/api/auth/google">
        Continue with Google
      </a>

      <p className="tiny muted" style={{ marginTop: 'var(--space-2)', textAlign: 'center' }}>
        We request the Gmail read-only scope. We never send mail, and receipt
        emails are parsed for grocery items only.
      </p>
    </main>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
      <span
        className="pill pill-accent"
        style={{ minWidth: 24, textAlign: 'center', marginTop: 0 }}
      >
        {n}
      </span>
      <div>
        <h3>{title}</h3>
        <p className="small muted" style={{ margin: 0 }}>
          {body}
        </p>
      </div>
    </div>
  );
}

