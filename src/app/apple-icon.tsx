import { ImageResponse } from 'next/og';

/**
 * Apple's home-screen icon. Same placeholder mark as icon.tsx, sized to
 * Apple's documented 180x180 apple-touch-icon spec (iPhone with @3x
 * display) rather than reused from a single generic size — iOS does not
 * scale up a too-small source cleanly.
 *
 * The App Router auto-injects <link rel="apple-touch-icon"> for this file;
 * see icon.tsx for why this is drawn rather than an emoji, and why it's a
 * placeholder to replace before shipping.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0e8a9e',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            style={{
              display: 'flex',
              width: 54,
              height: 27,
              border: '7px solid #ffffff',
              borderBottom: 'none',
              borderTopLeftRadius: 27,
              borderTopRightRadius: 27,
            }}
          />
          <div
            style={{
              display: 'flex',
              marginTop: -7,
              width: 88,
              height: 60,
              background: '#ffffff',
              borderRadius: 10,
            }}
          />
        </div>
      </div>
    ),
    { ...size }
  );
}

