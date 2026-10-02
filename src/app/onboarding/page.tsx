import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';
import OnboardingFlow from '@/components/OnboardingFlow';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/');

  return (
    <main className="shell">
      <OnboardingFlow gmailConnected={user.gmail_connected} />
    </main>
  );
}

