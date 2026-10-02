'use client';

import { useEffect, useState } from 'react';

/**
 * Noon and 5pm — the two boundaries most people actually mean by these words.
 * No existing convention to align with instead: lib/suggestions.ts's
 * slotForHour() covers similar ground but for meal windows, not greetings
 * (its "dinner" starts at 15:00, far too early to say "good evening").
 */
function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstNameOf(name: string | null): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] || null;
}

/**
 * Personalized time-of-day greeting for the Home header ("Good morning,
 * Alex"), computed entirely client-side for the time-of-day half.
 *
 * Reading the clock anywhere in the Server Component tree — or via cookies(),
 * headers(), searchParams, `{ cache: 'no-store' }` — would force Home out of
 * static rendering for every single visitor, permanently, just to show one
 * word. This component owns that word instead: it renders on mount, in the
 * browser, using the visitor's own clock (also the only place that knows
 * their real timezone — a server guess would often be wrong anyway).
 *
 * The name is different: it's a plain prop from the already-fetched user
 * record, known exactly on the server, no clock involved — so it's safe to
 * render immediately, server-side, with no hydration-mismatch risk. Only
 * "Good morning" vs "Hello" swaps in after mount; the name itself never pops.
 */
export default function Greeting({ name }: { name: string | null }) {
  const first = firstNameOf(name);
  const [word, setWord] = useState<string | null>(null);

  useEffect(() => {
    setWord(greetingForHour(new Date().getHours()));
  }, []);

  const text = word ?? 'Hello';
  return <>{first ? `${text}, ${first}` : text}</>;
}

