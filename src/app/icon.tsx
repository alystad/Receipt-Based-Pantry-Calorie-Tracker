import { ImageResponse } from 'next/og';

/**
 * Placeholder app icon, generated at request time rather than a binary file
 * checked into the repo — there is no design asset yet, and a generated
 * source is easier to swap out than a file to remember to replace. This
 * feeds both the browser favicon and manifest.ts's PWA icon entry.
 *
 * Draws an abstract basket mark (matches the Pantry tab's icon motif) on the
 * app's accent green, rather than an emoji glyph: ImageResponse's renderer
 * (Satori) has no bundled emoji font, so an emoji character here would
 * render as a blank box instead of 🧺.
 *
 * Replace this file with a real designed icon before shipping.
 */
export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
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
              width: 152,
              height: 76,
              border: '20px solid #ffffff',
              borderBottom: 'none',
              borderTopLeftRadius: 76,
              borderTopRightRadius: 76,
            }}
          />
          <div
            style={{
              display: 'flex',
              marginTop: -20,
              width: 248,
              height: 168,
              background: '#ffffff',
              borderRadius: 28,
            }}
          />
        </div>
      </div>
    ),
    { ...size }
  );
}

