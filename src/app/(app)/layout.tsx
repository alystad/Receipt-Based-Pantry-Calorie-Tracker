import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';
import TabBar from '@/components/TabBar';
import CaptureFab from '@/components/CaptureFab';
import ScrollRestoration from '@/components/ScrollRestoration';

/**
 * Shell for the four tabbed screens.
 *
 * The route group "(app)" does not appear in URLs — /dashboard, /meals, /list
 * and /profile keep their paths. Putting the auth check here means every tab
 * is guarded in one place instead of repeating the redirect per page.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/');

  return (
    <>
      <ScrollRestoration />
      {children}
      <CaptureFab />
      <TabBar />
    </>
  );
}

