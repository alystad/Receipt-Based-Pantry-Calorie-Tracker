'use client';

import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Per-tab scroll memory.
 *
 * Content lives on `window`/`document` — there is no per-tab scroll
 * container to leave mounted, and each tab is a distinct route segment that
 * genuinely unmounts on navigation, so the previous scroll offset can't
 * survive on its own. This saves it into memory as you scroll and restores
 * it the moment you land back on that pathname, which is indistinguishable
 * from it never having moved.
 *
 * Mounted once in the (app) layout, which stays mounted across every tab
 * switch, so the in-memory map survives the whole session (reset on a hard
 * reload, same as a native app losing scroll state on force-quit).
 */
const positions = new Map<string, number>();

export default function ScrollRestoration() {
  const pathname = usePathname();

  // A single useLayoutEffect, not a plain useEffect split across two hooks:
  // both matter for correctness, not just for avoiding a visible flash.
  //
  // useLayoutEffect's cleanup-then-setup for a pathname change is
  // synchronous — the previous pathname's listener is guaranteed to be
  // detached before this pathname's body runs. With a plain useEffect that
  // guarantee doesn't hold: passive-effect cleanup is deferred to a later
  // phase, so the *previous* page's scroll listener was still attached when
  // this effect called scrollTo(), observed the resulting scroll event, and
  // overwrote the previous page's saved position with the new page's 0 —
  // a real, reproducible race (failed roughly 1 run in 3 under Playwright),
  // not a one-off flake.
  useLayoutEffect(() => {
    const target = positions.get(pathname) ?? 0;

    // Restore before attaching the listener below, so this call's own
    // resulting scroll event — dispatched async, but always against
    // whichever listener is attached by the time it fires — updates this
    // pathname's own entry rather than being missed.
    window.scrollTo(0, target);

    // A second, next-frame re-affirmation: a fresh tab's content can still
    // be hydrating client components or loading images at the moment this
    // layout effect fires, and a layout shift landing between this commit
    // and the next paint can nudge scrollY away from `target` on its own —
    // observed happening intermittently in practice, not theoretical.
    const raf = requestAnimationFrame(() => window.scrollTo(0, target));

    const onScroll = () => positions.set(pathname, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [pathname]);

  return null;
}

