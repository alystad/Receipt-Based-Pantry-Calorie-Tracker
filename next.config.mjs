/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Meal + pantry photos are posted as multipart bodies to route handlers.
    serverActions: { bodySizeLimit: '12mb' },
    // Every tab (dashboard/meals/list/profile) reads cookies via
    // getCurrentUser(), which makes Next treat the route as fully dynamic.
    // Next's default stale time for dynamic routes' client-side navigation
    // cache is 0 seconds — literally every revisit, even to a tab you were
    // on a second ago, is treated as stale and re-rendered server-side from
    // scratch (fresh auth check + every DB query on the page). That reload
    // is what "tab switching feels like a full page load" actually was.
    //
    // Raising this to 45s means a tab switch within that window is served
    // instantly from Next's client-side cache with zero network request; the
    // 9 components that already call router.refresh() after a mutation
    // (logging a meal, receipt sync, restocking, etc.) explicitly invalidate
    // this same cache for the current route, so an action-driven update is
    // never masked by the window — see refreshReducer in Next's router
    // internals, which calls invalidateSegmentCacheEntries() precisely for
    // the route router.refresh() was called on.
    staleTimes: {
      dynamic: 45,
    },
  },
  // Next's dev server blocks cross-origin requests to /_next/* by default
  // (see block-cross-site-dev.js). Testing on a phone means the browser's
  // origin is the tunnel/LAN host, not localhost, so it has to be allowlisted.
  //
  // Wildcards cover ngrok and Cloudflare quick-tunnel domains so a fresh
  // tunnel (new random subdomain every restart) never needs this file
  // touched. The LAN IP covers "phone on same Wi-Fi, no tunnel" too.
  allowedDevOrigins: [
    '**.ngrok-free.app',
    '**.ngrok.io',
    '**.ngrok.app',
    '**.trycloudflare.com',
    '100.110.144.132',
  ],
};

export default nextConfig;
