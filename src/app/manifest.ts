import type { MetadataRoute } from 'next';

/**
 * Served at /manifest.webmanifest. Next auto-injects the <link rel="manifest">
 * tag from this file's existence — see the comment in layout.tsx.
 *
 * The icon is a placeholder generated at build/request time by app/icon.tsx
 * (see that file for why). Swap the `icons` entry here for real design
 * assets before shipping; a single 512px source is the documented minimum
 * for PWA installability, but production apps should also ship a maskable
 * variant with safe-zone padding for Android's adaptive-icon mask.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Pantry — pantry and meal tracking',
    short_name: 'Pantry',
    description:
      'Your pantry, tracked by itself. Photograph the meal; everything else is automatic.',
    // Signed-in users land straight on their pantry, not the marketing page —
    // /dashboard itself redirects to "/" if the session cookie is missing,
    // so this is safe for logged-out launches too.
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f2f2f7',
    theme_color: '#f2f2f7',
    icons: [
      {
        src: '/icon',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}

