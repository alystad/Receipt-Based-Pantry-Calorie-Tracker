import { NextResponse, type NextRequest } from 'next/server';

/**
 * CORS for the API. The only client is the Expo app, which authenticates
 * with a bearer token (see src/lib/session.ts) rather than cookies — so
 * there's no credentialed-cookie complication that would otherwise force
 * echoing a specific origin. A native app's own fetch calls don't send an
 * `Origin` header at all and aren't subject to CORS in the first place; this
 * exists for Expo's web preview / browser-based testing tools, which do.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function proxy(request: NextRequest) {
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
