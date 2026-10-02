import type { Metadata, Viewport } from 'next';
import './globals.css';
import './components.css';

// The manifest <link> is auto-injected by the app/manifest.ts file
// convention below — no need to also set metadata.manifest here.
export const metadata: Metadata = {
  title: 'Pantry',
  description: 'Your pantry, tracked by itself. Photograph the meal; everything else is automatic.',
  appleWebApp: {
    // Next's typed API only emits the modern, unprefixed
    // "mobile-web-app-capable" tag from this field (Chrome/Android read
    // that one) — iOS Safari does NOT honor it and still requires the
    // legacy "apple-mobile-web-app-capable" tag below to launch full-screen.
    // Keeping `capable: true` here too since Chrome-based installs benefit
    // from the standards-track tag it emits.
    capable: true,
    // 'default' keeps the status bar text dark, matching the light-only
    // design system — 'black-translucent' would let content run under a
    // transparent bar, which this app's layout doesn't account for.
    statusBarStyle: 'default',
    title: 'Pantry',
  },
  other: {
    // The tag iOS actually checks before dropping browser chrome on
    // "Add to Home Screen" — see the comment on appleWebApp above.
    'apple-mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Lets the page draw into the notch/home-indicator area so the CSS
  // env(safe-area-inset-*) below has real insets to read instead of 0.
  viewportFit: 'cover',
  themeColor: '#f2f2f7',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

