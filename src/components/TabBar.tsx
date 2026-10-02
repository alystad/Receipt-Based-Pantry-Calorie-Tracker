'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Four-tab bar: Home, Meals, List, Profile.
 *
 * Capture lives in a separate floating "+" button (CaptureFab), not in the
 * bar — photographing a meal is an action, not a destination, and keeping it
 * out of the bar leaves four evenly-weighted places to navigate to.
 */

const STROKE = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 9.8 12 4l8 5.8V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.8Z"
        stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
      <path d="M9.5 20v-5.5h5V20" stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
    </svg>
  );
}

function MealsIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 3v8a2.5 2.5 0 0 0 5 0V3" stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
      <path d="M9.5 13v8M17 3c-1.5 1.6-2 3.4-2 5.5S15.5 12 17 12.5V21"
        stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
      <path d="m4 6 1.2 1.2L7.5 5M4 12l1.2 1.2L7.5 11M4 18l1.2 1.2L7.5 17"
        stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
    </svg>
  );
}

function ProfileIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8.5" r="3.6" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
      <path d="M5 20c.9-3.4 3.6-5.2 7-5.2s6.1 1.8 7 5.2"
        stroke="currentColor" strokeWidth={active ? 2 : 1.6} {...STROKE} />
    </svg>
  );
}

const TABS = [
  { href: '/dashboard', label: 'Home', Icon: HomeIcon },
  { href: '/meals', label: 'Meals', Icon: MealsIcon },
  { href: '/list', label: 'List', Icon: ListIcon },
  { href: '/profile', label: 'Profile', Icon: ProfileIcon },
] as const;

/**
 * How far you have to scroll, in either direction, before the bar reacts.
 * Below this, tiny rubber-band/momentum jitter at rest would otherwise
 * flicker the bar between states.
 */
const SCROLL_THRESHOLD = 6;
/** Always fully expanded this close to the top, regardless of direction. */
const TOP_ZONE = 24;

export default function TabBar() {
  const pathname = usePathname();
  const [compact, setCompact] = useState(false);
  const lastY = useRef(0);

  // Mirrored onto <html> (not just this component's own state) so the FAB —
  // a sibling component, not a child — can follow the bar's collapsed state
  // in CSS alone, with no cross-component prop plumbing.
  useEffect(() => {
    document.documentElement.dataset.tabbarCompact = compact ? 'true' : 'false';
  }, [compact]);

  // A tab switch always lands fully expanded — collapsing on arrival (before
  // the user has scrolled anything themselves) would read as broken, not
  // responsive. Re-baselining lastY here also stops ScrollRestoration's own
  // scrollTo() on this same navigation from being misread as a user scroll.
  useEffect(() => {
    setCompact(false);
    lastY.current = window.scrollY;
  }, [pathname]);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        const delta = y - lastY.current;

        if (y < TOP_ZONE) setCompact(false);
        else if (delta > SCROLL_THRESHOLD) setCompact(true);
        else if (delta < -SCROLL_THRESHOLD) setCompact(false);

        lastY.current = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <nav className="tabbar" data-compact={compact} aria-label="Primary">
      <div className="tabbar-surface">
        {TABS.map(({ href, label, Icon }) => {
          // Sub-routes keep their parent tab lit (e.g. /meals/[id]).
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className="tabbar-link"
              data-active={active}
              // Next's default scroll-to-top-on-navigate would fight with
              // ScrollRestoration (both try to own window.scrollY on the
              // same navigation) — scroll is handled entirely by that one
              // component instead, mounted once in the (app) layout.
              scroll={false}
            >
              <Icon active={active} />
              <span className="tabbar-label">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

